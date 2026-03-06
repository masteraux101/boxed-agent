/**
 * chat.js — Unified multi-provider AI chat interface
 *
 * Routes requests to Gemini, Qwen, or other OpenAI-compatible providers.
 */

import ProviderAPI from './provider-api.js';

const Chat = (() => {
  // Combined model list from all providers
  const MODELS = [
    ...ProviderAPI.Gemini.GEMINI_MODELS,
    ...ProviderAPI.Qwen.QWEN_MODELS,
  ];

  let history = [];
  let systemInstruction = '';
  let _aborted = false;

  // Token usage accumulator (per-session)
  let tokenUsage = {
    promptTokens: 0,
    candidatesTokens: 0,
    thoughtsTokens: 0,
    totalTokens: 0,
    requestCount: 0,
  };

  // ─── Getters / Setters ────────────────────────────────────────────

  function setSystemInstruction(instruction) {
    systemInstruction = instruction;
  }

  function getSystemInstruction() {
    return systemInstruction;
  }

  function getHistory() {
    return [...history];
  }

  function setHistory(h) {
    history = h || [];
  }

  function clearHistory() {
    history = [];
  }

  function getTokenUsage() {
    return { ...tokenUsage };
  }

  function resetTokenUsage() {
    tokenUsage = {
      promptTokens: 0,
      candidatesTokens: 0,
      thoughtsTokens: 0,
      totalTokens: 0,
      requestCount: 0,
    };
  }

  /**
   * Compact history by removing first user+model pair (older conversation).
   */
  function compactHistory() {
    // Find the first pair of (user message, model response)
    let compactedCount = 0;
    for (let i = 0; i < history.length - 1; i++) {
      if (history[i].role === 'user' && history[i + 1].role === 'model') {
        // Remove first two: user msg and response
        history.splice(0, 2);
        compactedCount += 2;
        console.log(
          `[Chat] Compacted history: removed 2 messages, ${history.length} remain`
        );
        break;
      }
    }

    if (!compactedCount) {
      // If we can't find a pair, just remove the first 2 messages
      history.splice(0, Math.min(2, history.length));
      console.log(
        `[Chat] Compacted history (fallback): ${history.length} messages remain`
      );
    }

    // Return a summary of what was removed
    const summary = {
      role: 'model',
      parts: [
        {
          text: 'Understood. I have the context from our previous conversation. How can I continue helping you?',
        },
      ],
    };

    return summary;
  }

  // ─── Abort ────────────────────────────────────────────────────────

  function abort() {
    _aborted = true;
  }

  // ─── Send Message (Multi-Provider) ────────────────────────────────

  /**
   * Send a message and stream the response via the appropriate provider.
   * @param {Object} opts
   * @param {string} opts.apiKey - the API key for the selected provider
   * @param {string} opts.qwenApiKey - optional Qwen API key if different from apiKey
  * @param {string} opts.provider - explicit provider (gemini|qwen)
   * @param {string} opts.model - model ID (determines provider: gemini-* or qwen-*)
   * @param {string} opts.message - user message text
   * @param {boolean} opts.enableSearch - enable search (Gemini only)
   * @param {Object} opts.thinkingConfig - thinking configuration (Gemini only)
   * @param {string} opts.systemInstructionOverride - per-request system instruction
   * @param {function} opts.onStart - called after user message added to history
   * @param {function} opts.onChunk - called with (textDelta, fullTextSoFar)
   * @param {function} opts.onDone - called with (fullText, metadata)
   * @param {function} opts.onError - called with (Error)
   * @returns {Promise<string>} full response text
   */
  async function send({
    apiKey,
    qwenApiKey,
    provider,
    model,
    message,
    enableSearch,
    thinkingConfig,
    systemInstructionOverride,
    onStart,
    onChunk,
    onDone,
    onError,
  }) {
    // Add user message to history
    history.push({
      role: 'user',
      parts: [{ text: message }],
    });

    if (onStart) onStart();

    _aborted = false;

    const effectiveSystemInstruction =
      systemInstructionOverride ?? systemInstruction;

    let fullText = '';
    let metadata = {};

    try {
      // Detect provider and route request (prefer explicit provider setting).
      const resolvedProvider = provider || (model.startsWith('qwen') ? 'qwen' : 'gemini');
      const providerApiKey = resolvedProvider === 'qwen' ? (qwenApiKey || apiKey) : apiKey;

      let result;

      if (resolvedProvider === 'qwen') {
        // Convert Gemini-style history to OpenAI format
        const messages = history.map(msg => ({
          role: msg.role === 'model' ? 'assistant' : 'user',
          content: msg.parts?.map(p => p.text).join('') || msg.content || '',
        }));

        result = await ProviderAPI.Qwen.generateContent({
          apiKey: providerApiKey,
          model,
          systemInstruction: effectiveSystemInstruction,
          messages,
          enableSearch,
          thinkingConfig,
          onChunk: (chunk) => {
            if (chunk.type === 'text') {
              fullText += chunk.text;
              if (onChunk) onChunk(chunk.text, fullText);
            }
          },
        });

        metadata.usage = result.usageInfo;
      } else {
        // Gemini provider
        result = await ProviderAPI.Gemini.generateContent({
          apiKey: providerApiKey,
          model,
          systemInstruction: effectiveSystemInstruction,
          messages: history,
          onChunk: (chunk) => {
            if (chunk.type === 'text') {
              fullText += chunk.text;
              if (onChunk) onChunk(chunk.text, fullText);
            }
          },
          enableSearch,
          thinkingConfig,
        });

        fullText = result.text;
        metadata.usage = result.usageInfo;
        metadata.grounding = result.grounding;
      }

      // Update token usage
      if (result.usageInfo) {
        const promptTokens = result.usageInfo.promptTokens || 0;
        const completionTokens = result.usageInfo.completionTokens || 0;
        const totalTokens = result.usageInfo.totalTokens || 0;

        tokenUsage.promptTokens += promptTokens;
        tokenUsage.candidatesTokens += completionTokens;
        if (resolvedProvider === 'gemini') {
          tokenUsage.thoughtsTokens += result.usageInfo.thoughtsTokens || 0;
        }
        tokenUsage.totalTokens += totalTokens;
        tokenUsage.requestCount++;
      }

      if (_aborted) {
        if (fullText) {
          history.push({
            role: 'model',
            parts: [{ text: fullText + '\n\n[Response cancelled]' }],
          });
        } else {
          history.pop();
        }
        if (onDone) onDone(fullText);
        return fullText;
      }

      // Add assistant response to history
      history.push({
        role: 'model',
        parts: [{ text: fullText }],
      });

      if (onDone) onDone(fullText, metadata);
      return fullText;
    } catch (err) {
      if (_aborted) {
        if (fullText) {
          history.push({
            role: 'model',
            parts: [{ text: fullText + '\n\n[Response cancelled]' }],
          });
        } else {
          history.pop();
        }
        if (onDone) onDone(fullText);
        return fullText;
      }

      history.pop();
      
      const resolvedProvider = provider || (model.startsWith('qwen') ? 'qwen' : 'gemini');
      const friendlyError = new Error(buildErrorMessage(err, model, resolvedProvider));
      if (onError) onError(friendlyError);
      throw friendlyError;
    }
  }

  // ─── Error Helpers ────────────────────────────────────────────────

  function buildErrorMessage(err, model, provider) {
    const status = err.status || err.httpStatusCode || err.statusCode;
    const originalMsg = err.message || String(err);
    const isPreview = model.includes('preview') || model.includes('exp');

    const hints = {
      400: `Bad request — the prompt or config may be invalid.`,
      401: `Invalid API key — check your ${provider === 'qwen' ? 'Qwen' : 'Gemini'} API key in Settings.`,
      403: `Access denied — your API key may not have permission for this model.`,
      429: 'Rate limit exceeded — too many requests. Wait a moment and try again.',
      500: `${provider === 'qwen' ? 'Qwen' : 'Gemini'} server error — try again in a few seconds.`,
      503: `${provider === 'qwen' ? 'Qwen' : 'Gemini'} service unavailable (503).${
        provider === 'gemini' && isPreview ? ' Preview models are less stable — consider switching to a stable model.' : ''
      }`,
    };

    const hint = hints[status];
    return hint ? `${hint}\n(${originalMsg})` : originalMsg;
  }

  // ─── Test API Key ─────────────────────────────────────────────────

  async function testApiKey(apiKey, model, qwenApiKey = null) {
    if (!model) return false;

    const provider = model.startsWith('qwen') ? 'qwen' : 'gemini';
    const providerApiKey = provider === 'qwen' ? (qwenApiKey || apiKey) : apiKey;

    try {
      if (provider === 'qwen') {
        return await ProviderAPI.Qwen.testApiKey(providerApiKey, model);
      } else {
        return await ProviderAPI.Gemini.testApiKey(providerApiKey, model);
      }
    } catch (e) {
      return false;
    }
  }

  // ─── Public API ───────────────────────────────────────────────────

  return {
    MODELS,
    send,
    abort,
    clearHistory,
    getHistory,
    setHistory,
    setSystemInstruction,
    getSystemInstruction,
    compactHistory,
    testApiKey,
    getTokenUsage,
    resetTokenUsage,
  };
})();

export default Chat;
