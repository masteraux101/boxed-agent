/**
 * provider-api.js — Multi-provider AI API client
 *
 * Supports:
 * - Google Gemini (via @google/genai SDK)
 * - Qwen (via OpenAI-compatible DashScope API)
 * - Custom OpenAI-compatible endpoints
 */

// Provider implementations
const ProviderAPI = (() => {
  let _GoogleGenAI = null;

  // ─── Qwen via OpenAI-compatible API (using fetch) ──────────────────

  const Qwen = (() => {
    const QWEN_MODELS = [
      { id: 'qwen3-max-2026-01-23', name: 'Qwen3 Max (2026-01-23)', provider: 'qwen', dimensions: { search: true, thinking: true } },
      { id: 'qwen-max', name: 'Qwen Max (Latest)', provider: 'qwen', dimensions: { search: true, thinking: false } },
      { id: 'qwen-plus', name: 'Qwen Plus', provider: 'qwen', dimensions: { search: true, thinking: false } },
      { id: 'qwen-turbo', name: 'Qwen Turbo (Fast)', provider: 'qwen', dimensions: { search: true, thinking: false } },
      { id: 'qwen-long', name: 'Qwen Long', provider: 'qwen', dimensions: { search: false, thinking: false } },
      { id: 'qwen2-72b-instruct', name: 'Qwen2 72B', provider: 'qwen', dimensions: { search: false, thinking: false } },
      { id: 'qwen2-7b-instruct', name: 'Qwen2 7B', provider: 'qwen', dimensions: { search: false, thinking: false } },
    ];

    async function generateContent(config) {
      const {
        apiKey,
        model,
        systemInstruction = '',
        messages = [],
        onChunk = null,
        abortSignal = null,
        enableSearch = false,
        thinkingConfig = null,
        _disableTools = false,
      } = config;

      if (!apiKey) throw new Error('Qwen API key is required');
      if (!model) throw new Error('Model is required');
      if (!messages.length) throw new Error('At least one message is required');

      // Build chat messages for OpenAI API format
      const chatMessages = [];
      
      if (systemInstruction) {
        chatMessages.push({ role: 'system', content: systemInstruction });
      }

      for (const msg of messages) {
        chatMessages.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content || msg.parts?.map(p => p.text).join('') || '',
        });
      }

      const url = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

      const lowerModel = model.toLowerCase();
      const supportsThinking = lowerModel.startsWith('qwen3-') || lowerModel.startsWith('qwq-');
      const supportsBuiltinTools = lowerModel.startsWith('qwen3-') || lowerModel.startsWith('qwen-max') || lowerModel.startsWith('qwen-plus');
      
      let fullText = '';
      let usageInfo = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

      const requestBody = {
        model,
        messages: chatMessages,
        stream: true,
        stream_options: { include_usage: true },
        temperature: 1.0,
        top_p: 0.95,
        max_tokens: 8192,
      };

      const extraBody = {};
      if (enableSearch) {
        // DashScope/OpenAI-compatible Qwen expects this at top-level.
        requestBody.enable_search = true;
      }
      if (thinkingConfig?.enabled && supportsThinking) {
        extraBody.enable_thinking = true;
        if (thinkingConfig.thinkingBudget) {
          extraBody.thinking_budget = thinkingConfig.thinkingBudget;
        }
      }
      if (Object.keys(extraBody).length > 0) {
        requestBody.extra_body = extraBody;
      }

      // Align with tool-based invocation style where the model supports it.
      // Keep enable_search for compatibility with older behavior.
      if (enableSearch && supportsBuiltinTools && !_disableTools) {
        requestBody.tools = [
          { type: 'web_search' },
          { type: 'web_extractor' },
          { type: 'code_interpreter' },
        ];
        requestBody.tool_choice = 'auto';
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'X-DashScope-SSE': 'enable',
        },
        body: JSON.stringify(requestBody),
        signal: abortSignal,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Qwen API error: ${response.status} - ${error}`);
      }

      // Handle streaming response
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pendingBuffer = '';
      let sawToolCall = false;

      function processSseLine(line) {
        if (!line.trim() || line.startsWith(':')) return;
        if (!line.startsWith('data: ')) return;

        const data = line.slice(6);
        if (data === '[DONE]') return;

        try {
          const chunk = JSON.parse(data);
          if (chunk.choices?.[0]?.delta?.content) {
            const chunkText = chunk.choices[0].delta.content;
            fullText += chunkText;
            if (onChunk) {
              onChunk({ type: 'text', text: chunkText });
            }
          }
          if (chunk.choices?.[0]?.delta?.tool_calls?.length) {
            sawToolCall = true;
          }
          if (chunk.usage) {
            usageInfo = {
              promptTokens: chunk.usage.prompt_tokens || 0,
              completionTokens: chunk.usage.completion_tokens || 0,
              totalTokens: chunk.usage.total_tokens || 0,
            };
          }
        } catch {
          // Ignore JSON parse errors in stream chunks.
        }
      }
      
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          pendingBuffer += decoder.decode(value, { stream: true });
          const lines = pendingBuffer.split('\n');
          pendingBuffer = lines.pop() || '';
          for (const line of lines) {
            processSseLine(line);
          }
        }

        if (pendingBuffer.trim()) {
          processSseLine(pendingBuffer);
        }
      } finally {
        reader.releaseLock();
      }

      // Some models may emit tool-calls without final text in this endpoint.
      // Fallback once without tools to avoid blank responses.
      if (!fullText.trim() && sawToolCall && !_disableTools) {
        return generateContent({
          ...config,
          _disableTools: true,
        });
      }

      return { text: fullText, usageInfo };
    }

    async function testApiKey(apiKey, model = 'qwen-turbo') {
      try {
        const result = await generateContent({
          apiKey,
          model,
          messages: [{ role: 'user', content: 'Hi' }],
        });
        return result && result.text && result.text.length > 0;
      } catch (e) {
        return false;
      }
    }

    return { QWEN_MODELS, generateContent, testApiKey };
  })();

  // ─── Gemini via Google SDK ──────────────────────────────────────────

  const Gemini = (() => {
    const GEMINI_MODELS = [
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'gemini', dimensions: { search: true, thinking: true } },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'gemini', dimensions: { search: true, thinking: true } },
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', provider: 'gemini', dimensions: { search: true, thinking: false } },
      { id: 'gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite', provider: 'gemini', dimensions: { search: true, thinking: false } },
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', provider: 'gemini', dimensions: { search: true, thinking: false } },
      { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', provider: 'gemini', dimensions: { search: true, thinking: false } },
    ];

    async function getAI(apiKey) {
      if (!_GoogleGenAI) {
        try {
          const mod = await import('@google/genai');
          _GoogleGenAI = mod.GoogleGenAI;
        } catch (e) {
          throw new Error('Failed to load Google GenAI SDK. Check your internet connection and refresh.');
        }
      }
      return new _GoogleGenAI({ apiKey });
    }

    async function generateContent(config) {
      const {
        apiKey,
        model,
        systemInstruction = '',
        messages = [],
        onChunk = null,
        enableSearch = false,
        thinkingConfig = null,
      } = config;

      if (!apiKey) throw new Error('Gemini API key is required');
      if (!model) throw new Error('Model is required');
      if (!messages.length) throw new Error('At least one message is required');

      // Convert to Gemini format
      const geminiHistory = messages.map(msg => ({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: msg.parts || [{ text: msg.content || '' }],
      }));

      const tools = enableSearch ? [{ googleSearch: {} }] : [];
      const config_obj = {
        temperature: 1.0,
        topP: 0.95,
        maxOutputTokens: 8192,
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(tools.length > 0 ? { tools } : {}),
      };

      if (thinkingConfig?.enabled) {
        config_obj.thinkingConfig = {};
        if (thinkingConfig.thinkingBudget) {
          config_obj.thinkingConfig.thinkingBudget = thinkingConfig.thinkingBudget;
        }
        if (thinkingConfig.includeThoughts) {
          config_obj.thinkingConfig.includeThoughts = true;
        }
      }

      const ai = await getAI(apiKey);
      const response = await ai.models.generateContentStream({
        model,
        contents: geminiHistory,
        config: config_obj,
      });

      let fullText = '';
      let lastUsageMetadata = null;
      let groundingMeta = null;

      for await (const chunk of response) {
        const t = chunk.text || '';
        if (t) {
          fullText += t;
          if (onChunk) {
            onChunk({ type: 'text', text: t });
          }
        }
        if (chunk.usageMetadata) {
          lastUsageMetadata = chunk.usageMetadata;
        }
        if (chunk.candidates?.[0]?.groundingMetadata) {
          groundingMeta = chunk.candidates[0].groundingMetadata;
        }
      }

      const usageInfo = {
        promptTokens: lastUsageMetadata?.promptTokenCount || 0,
        completionTokens: lastUsageMetadata?.candidatesTokenCount || 0,
        thoughtsTokens: lastUsageMetadata?.thoughtsTokenCount || 0,
        totalTokens: lastUsageMetadata?.totalTokenCount || 0,
      };

      return { text: fullText, usageInfo, grounding: groundingMeta };
    }

    async function testApiKey(apiKey, model) {
      try {
        const ai = await getAI(apiKey);
        await ai.models.generateContent({
          model,
          contents: 'Hi',
          config: { maxOutputTokens: 5 },
        });
        return true;
      } catch (e) {
        return false;
      }
    }

    return { GEMINI_MODELS, generateContent, testApiKey };
  })();

  // ─── Public API ────────────────────────────────────────────────────

  return {
    Gemini,
    Qwen,
  };
})();

export default ProviderAPI;
