/**
 * chat.js — Gemini API streaming via @google/genai SDK + multi-turn history
 *
 * Uses dynamic import() to lazy-load the SDK on first API call.
 */

const Chat = (() => {
  /* eslint-disable -- keeping original structure */
  const MODELS = [
    { id: 'gemini-3.0-flash', name: 'Gemini 3.0 Flash' },
    { id: 'gemini-2.5-flash-preview-05-20', name: 'Gemini 2.5 Flash (Preview)' },
    { id: 'gemini-2.5-pro-preview-05-06', name: 'Gemini 2.5 Pro (Preview)' },
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
    { id: 'gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite' },
    { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' },
    { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash' },
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

  // ─── SDK lazy-loader ───────────────────────────────────────────────

  let _GoogleGenAI = null;

  /**
   * Lazily import the SDK and return a new GoogleGenAI client for the given key.
   */
  async function getAI(apiKey) {
    if (!_GoogleGenAI) {
      try {
        const mod = await import('@google/genai');
        _GoogleGenAI = mod.GoogleGenAI;
      } catch (e) {
        throw new Error(
          'Failed to load Google GenAI SDK. Please check your internet connection and refresh the page.'
        );
      }
    }
    return new _GoogleGenAI({ apiKey });
  }

  // ─── Getters / Setters ────────────────────────────────────────────

  /**
   * Set system instruction (from SOUL + Skills)
   */
  function setSystemInstruction(instruction) {
    systemInstruction = instruction;
  }

  /**
   * Get current system instruction
   */
  function getSystemInstruction() {
    return systemInstruction;
  }

  /**
   * Get current history
   */
  function getHistory() {
    return [...history];
  }

  /**
   * Set history (for restoring sessions)
   */
  function setHistory(h) {
    history = h || [];
  }

  /**
   * Clear history
   */
  function clearHistory() {
    history = [];
  }

  /**
   * Get current token usage stats
   */
  function getTokenUsage() {
    return { ...tokenUsage };
  }

  /**
   * Reset token usage counters
   */
  function resetTokenUsage() {
    tokenUsage = {
      promptTokens: 0,
      candidatesTokens: 0,
      thoughtsTokens: 0,
      totalTokens: 0,
      requestCount: 0,
    };
  }

  // ─── Compact History ──────────────────────────────────────────────

  /**
   * Compact history — keep a summary + last few turns
   */
  async function compactHistory(apiKey, model) {
    if (history.length < 4) return 'History too short to compact.';

    const ai = await getAI(apiKey);
    const summaryContents = [
      ...history,
      {
        role: 'user',
        parts: [
          {
            text: 'Please provide a concise summary of our entire conversation so far. This will be used to replace the full history to save context space. Summarize all key points, decisions, and context.',
          },
        ],
      },
    ];

    const response = await ai.models.generateContent({
      model,
      contents: summaryContents,
      config: {
        ...(systemInstruction ? { systemInstruction } : {}),
      },
    });

    const summary = response.text || 'Summary unavailable.';

    // Replace history with compact version
    history = [
      {
        role: 'user',
        parts: [
          {
            text: '[Previous conversation summary]\n\n' + summary,
          },
        ],
      },
      {
        role: 'model',
        parts: [
          {
            text: 'Understood. I have the context from our previous conversation. How can I continue helping you?',
          },
        ],
      },
    ];

    return summary;
  }

  // ─── Abort ────────────────────────────────────────────────────────

  /**
   * Abort current streaming request.
   * Sets a flag that causes the streaming loop to break on the next chunk.
   */
  function abort() {
    _aborted = true;
  }

  // ─── Send Message (Streaming) ─────────────────────────────────────

  /**
   * Send a message and stream the response via the @google/genai SDK.
   * @param {Object} opts
   * @param {string} opts.apiKey
   * @param {string} opts.model
   * @param {string} opts.message - user message text
   * @param {boolean} opts.enableSearch - enable Google Search grounding
   * @param {Object} opts.thinkingConfig - thinking configuration
   * @param {string} opts.systemInstructionOverride - per-request system instruction
   * @param {function} opts.onStart - called after user message added to history
   * @param {function} opts.onChunk - called with (textDelta, fullTextSoFar)
   * @param {function} opts.onDone - called with (fullText, metadata)
   * @param {function} opts.onError - called with (Error)
   * @returns {Promise<string>} full response text
   */
  async function send({
    apiKey,
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

    // Notify caller that the user message is now in history (before the network call)
    if (onStart) onStart();

    _aborted = false;

    // Build SDK config
    const effectiveSystemInstruction =
      systemInstructionOverride ?? systemInstruction;

    const tools = [];
    if (enableSearch) {
      tools.push({ googleSearch: {} });
    }

    const config = {
      temperature: 1.0,
      topP: 0.95,
      maxOutputTokens: 8192,
      ...(effectiveSystemInstruction
        ? { systemInstruction: effectiveSystemInstruction }
        : {}),
      ...(tools.length > 0 ? { tools } : {}),
    };

    // Add thinking config if provided
    if (thinkingConfig && thinkingConfig.enabled) {
      config.thinkingConfig = {};
      if (thinkingConfig.thinkingBudget != null) {
        config.thinkingConfig.thinkingBudget = thinkingConfig.thinkingBudget;
      }
      if (thinkingConfig.includeThoughts) {
        config.thinkingConfig.includeThoughts = true;
      }
    }

    let fullText = '';
    let lastUsageMetadata = null;
    let groundingMeta = null;

    try {
      const ai = await getAI(apiKey);
      const response = await ai.models.generateContentStream({
        model,
        contents: history,
        config,
      });

      for await (const chunk of response) {
        if (_aborted) break;

        const t = chunk.text || '';
        if (t) {
          fullText += t;
          if (onChunk) onChunk(t, fullText);
        }

        // Accumulate token usage from usageMetadata (typically on last chunk)
        if (chunk.usageMetadata) {
          lastUsageMetadata = chunk.usageMetadata;
        }

        // Collect grounding metadata
        const gm = chunk.candidates?.[0]?.groundingMetadata;
        if (gm) {
          groundingMeta = gm;
        }
      }

      // Update token usage from final metadata
      if (lastUsageMetadata) {
        tokenUsage.promptTokens +=
          lastUsageMetadata.promptTokenCount || 0;
        tokenUsage.candidatesTokens +=
          lastUsageMetadata.candidatesTokenCount || 0;
        tokenUsage.thoughtsTokens +=
          lastUsageMetadata.thoughtsTokenCount || 0;
        tokenUsage.totalTokens +=
          lastUsageMetadata.totalTokenCount || 0;
        tokenUsage.requestCount++;
      }

      if (_aborted) {
        // Stream was cancelled by user
        if (fullText) {
          history.push({
            role: 'model',
            parts: [{ text: fullText + '\n\n[Response cancelled]' }],
          });
        } else {
          // Remove the user message since we got nothing back
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

      // Build metadata for the callback
      const metadata = {
        usage: lastUsageMetadata,
        grounding: groundingMeta,
      };

      if (onDone) onDone(fullText, metadata);
      return fullText;
    } catch (err) {
      if (_aborted) {
        // Don't treat abort-during-error as a real error
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

      // On error, remove the user message we just added
      history.pop();

      const friendlyError = new Error(buildErrorMessage(err, model));
      if (onError) onError(friendlyError);
      throw friendlyError;
    }
  }

  // ─── Error Helpers ────────────────────────────────────────────────

  /**
   * Map SDK / HTTP errors to user-friendly messages with actionable hints.
   */
  function buildErrorMessage(err, model) {
    const isPreview =
      model.includes('preview') || model.includes('exp');
    const status = err.status || err.httpStatusCode;
    const originalMsg = err.message || String(err);

    const hints = {
      400: 'Bad request — the prompt or config may be invalid.',
      401: 'Invalid API key — check your Gemini API key in Settings.',
      403: 'Access denied — your API key may not have permission for this model.',
      429: 'Rate limit exceeded — too many requests. Wait a moment and try again.',
      500: 'Gemini server error — try again in a few seconds.',
      503: `Gemini service unavailable (503) — the model is overloaded or temporarily down. Please try again in a moment.${
        isPreview
          ? ' Preview/experimental models are less stable — consider switching to a stable model (e.g. gemini-2.0-flash) in Settings.'
          : ' You can also try switching to a different model in Settings.'
      }`,
    };

    const hint = hints[status];
    return hint ? `${hint}\n(${originalMsg})` : originalMsg;
  }

  // ─── Test API Key ─────────────────────────────────────────────────

  /**
   * Test if an API key is valid by making a small request.
   */
  async function testApiKey(apiKey, model) {
    const ai = await getAI(apiKey);
    await ai.models.generateContent({
      model,
      contents: 'Hi',
      config: { maxOutputTokens: 5 },
    });
    return true;
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
