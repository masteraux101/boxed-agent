/**
 * Qwen Search Capability Test
 *
 * Validates:
 * 1) Request payload includes extra_body.enable_search when enabled.
 * 2) Live online response can return current info with source URLs.
 *
 * Usage:
 *   node test/test-qwen-search.js
 *   QWEN_MODEL=qwen3-max-2026-01-23 node test/test-qwen-search.js
 */

import * as fs from 'fs';
import * as path from 'path';
import ProviderAPI from '../src/provider-api.js';

function loadEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, 'utf-8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key && value && !process.env[key]) {
      process.env[key] = value;
    }
  }
}

function hasUrl(text) {
  return /https?:\/\//i.test(text || '');
}

async function probeWebSearchTool(apiKey, model) {
  const body = {
    model,
    stream: false,
    messages: [
      {
        role: 'user',
        content: 'Find one latest AI headline. Use web_search tool if available.',
      },
    ],
    tools: [{ type: 'web_search' }],
  };

  const resp = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const raw = await resp.text();
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // ignore parse failure
  }

  const toolCalls = parsed?.choices?.[0]?.message?.tool_calls || [];
  const hasWebSearchToolCall = toolCalls.some((t) => t?.function?.name === 'web_search');

  return {
    status: resp.status,
    hasWebSearchToolCall,
    preview: String(parsed?.choices?.[0]?.message?.content || raw)
      .slice(0, 400)
      .replace(/\s+/g, ' '),
  };
}

async function run() {
  loadEnv();

  const apiKey = process.env.QWEN_KEY || '';
  const model = process.env.QWEN_MODEL || 'qwen3-max-2026-01-23';

  if (!apiKey) {
    throw new Error('QWEN_KEY is required (from .env or environment variables).');
  }

  console.log('='.repeat(72));
  console.log('QWEN SEARCH TEST');
  console.log('='.repeat(72));
  console.log(`Model: ${model}`);

  // Phase 1: Verify payload contains enable_search=true
  console.log('\n[1/2] Verifying request payload includes search flag...');
  const originalFetch = globalThis.fetch;
  let capturedBody = null;

  globalThis.fetch = async (input, init) => {
    if (typeof init?.body === 'string' && !capturedBody) {
      try {
        capturedBody = JSON.parse(init.body);
      } catch {
        // ignore parse failures
      }
    }
    return originalFetch(input, init);
  };

  try {
    await ProviderAPI.Qwen.generateContent({
      apiKey,
      model,
      messages: [
        { role: 'user', content: 'Reply with exactly: SEARCH_PLUMBING_OK' },
      ],
      enableSearch: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const searchFlagSent = Boolean(capturedBody?.enable_search === true);
  console.log(`enable_search (top-level) sent: ${searchFlagSent ? 'YES' : 'NO'}`);
  if (!searchFlagSent) {
    throw new Error('Search flag was not sent in request payload.');
  }

  // Phase 2: Live online response test
  console.log('\n[2/2] Running live online query...');
  const prompt = [
    'Use online search and answer with latest information.',
    'Question: what are two recent AI news headlines this week?',
    'Requirements:',
    '- Return exactly 2 bullet points.',
    '- Each bullet must include a source URL.',
    '- If you cannot access web results, explicitly say NO_WEB_ACCESS.',
  ].join('\n');

  const result = await ProviderAPI.Qwen.generateContent({
    apiKey,
    model,
    messages: [{ role: 'user', content: prompt }],
    enableSearch: true,
    thinkingConfig: { enabled: true, thinkingBudget: 1024 },
  });

  const text = (result?.text || '').trim();
  const directSearchOk = text.length > 0 && hasUrl(text) && !text.includes('NO_WEB_ACCESS');

  let toolProbe = null;
  if (!directSearchOk) {
    console.log('[2/2] Direct search text did not include URL, probing web_search tool-call...');
    toolProbe = await probeWebSearchTool(apiKey, model);
    console.log(`tool probe status: ${toolProbe.status}`);
    console.log(`web_search tool call observed: ${toolProbe.hasWebSearchToolCall ? 'YES' : 'NO'}`);
  }

  const ok = directSearchOk || Boolean(toolProbe?.hasWebSearchToolCall);

  console.log('\n--- Response Preview ---');
  console.log(text.slice(0, 800));
  console.log('--- End Preview ---\n');

  console.log(`Search response includes URL: ${hasUrl(text) ? 'YES' : 'NO'}`);
  if (toolProbe) {
    console.log(`Fallback tool-call probe: ${toolProbe.hasWebSearchToolCall ? 'PASS' : 'FAIL'}`);
    if (toolProbe.preview) {
      console.log(`Tool probe preview: ${toolProbe.preview}`);
    }
  }
  console.log(`Final result: ${ok ? 'PASS' : 'FAIL'}`);

  if (!ok) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('\n[ERROR]', err.message);
  process.exit(1);
});
