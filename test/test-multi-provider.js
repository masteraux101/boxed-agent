/**
 * Multi-provider browser test for Gemini + Qwen.
 */

import playwright from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

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

function promptUser(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function isSettingsOpen(page) {
  return page.evaluate(() => !document.querySelector('#settings-panel')?.classList.contains('hidden'));
}

async function openSettings(page) {
  if (!(await isSettingsOpen(page))) {
    await page.locator('#settings-btn').click();
    await page.waitForTimeout(300);
  }
}

async function createNewSession(page) {
  await page.locator('#new-session-btn').click();
  await page.waitForTimeout(300);
}

async function applyProviderSettings(page, { provider, model, geminiKey, qwenKey, passphrase }) {
  await openSettings(page);

  await page.evaluate(({ provider, model, geminiKey, qwenKey, passphrase }) => {
    const providerSelect = document.querySelector('#set-provider');
    if (providerSelect) {
      providerSelect.value = provider;
      providerSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const modelInput = document.querySelector('#set-model');
    if (modelInput) modelInput.value = model;

    const geminiInput = document.querySelector('#set-api-key');
    if (geminiInput && geminiKey) geminiInput.value = geminiKey;

    const qwenInput = document.querySelector('#set-qwen-api-key');
    if (qwenInput && qwenKey) qwenInput.value = qwenKey;

    const passInput = document.querySelector('#set-passphrase');
    if (passInput && passphrase) passInput.value = passphrase;
  }, { provider, model, geminiKey, qwenKey, passphrase });

  await page.locator('#apply-settings').click();
  await page.waitForTimeout(700);
}

async function sendAndWaitForResponse(page, prompt, timeoutMs = 35000) {
  const initialModelCount = await page.locator('.message-wrapper.model').count();
  const initialErrorCount = await page.locator('.error-bubble').count();

  await page.locator('#message-input').fill(prompt);
  await page.locator('#send-btn').click();

  await page.waitForFunction(
    ({ initialModelCount }) => {
      const modelMessages = document.querySelectorAll('.message-wrapper.model').length;
      const hasStreaming = !!document.querySelector('#streaming-bubble');
      return modelMessages > initialModelCount && !hasStreaming;
    },
    { initialModelCount },
    { timeout: timeoutMs }
  );

  const latestResponse = await page.evaluate(() => {
    const bubbles = document.querySelectorAll('.message-wrapper.model .message-bubble');
    const last = bubbles[bubbles.length - 1];
    return (last?.innerText || '').trim();
  });

  const finalErrorCount = await page.locator('.error-bubble').count();
  const hasNewError = finalErrorCount > initialErrorCount;

  return {
    ok: !hasNewError && latestResponse.length > 0,
    hasNewError,
    text: latestResponse,
  };
}

async function run() {
  loadEnv();

  const argv = process.argv.slice(2);
  const qwenOnly = process.argv.includes('--qwen-only') || process.env.TEST_PROVIDER === 'qwen';
  const allowPrompt = process.argv.includes('--prompt-missing-keys');
  const keepOpen = argv.includes('--keep-open');
  const slowArg = argv.find(a => a.startsWith('--slow-ms='));
  const slowFromArg = slowArg ? parseInt(slowArg.split('=')[1], 10) : NaN;
  const slowMo = Number.isFinite(slowFromArg) ? slowFromArg : parseInt(process.env.SLOW_MO || '0', 10) || 0;

  let geminiKey = process.env.GEMINI_KEY || '';
  let qwenKey = process.env.QWEN_KEY || '';
  const qwenModelFromEnv = process.env.QWEN_MODEL || '';
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && allowPrompt;

  if (qwenOnly) {
    geminiKey = '';
    console.log('[MODE] Qwen-only mode enabled. Gemini tests are skipped.');
  }

  if (slowMo > 0) {
    console.log(`[MODE] Slow motion enabled: ${slowMo}ms per Playwright action.`);
  }

  if (!qwenOnly && !geminiKey && interactive) {
    console.warn('[WARN] GEMINI_KEY not found in environment.');
    geminiKey = await promptUser('Enter Gemini key (or empty to skip Gemini): ');
  }
  if (!qwenKey && interactive) {
    console.warn('[WARN] QWEN_KEY not found in environment.');
    qwenKey = await promptUser('Enter Qwen key (or empty to skip Qwen): ');
  }

  if (!qwenOnly && !geminiKey && !qwenKey) {
    throw new Error('At least one API key is required.');
  }
  if (qwenOnly && !qwenKey) {
    throw new Error('Qwen-only mode requires QWEN_KEY.');
  }

  const { chromium } = playwright;
  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== 'false',
    slowMo,
  });
  const page = await browser.newPage();

  const testResults = {
    geminiResponse: false,
    qwenResponse: false,
    geminiFinal: false,
  };

  try {
    await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
    await createNewSession(page);

    if (geminiKey) {
      console.log('\n[TEST 1] Configure Gemini and send message');
      await applyProviderSettings(page, {
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        geminiKey,
        passphrase: 'test-provider-switch',
      });

      const res = await sendAndWaitForResponse(page, 'Answer in one line: what is 2+2?');
      testResults.geminiResponse = res.ok;
      console.log(`Gemini result: ${res.ok ? 'PASS' : 'FAIL'}`);
      console.log(`Gemini sample: ${res.text.slice(0, 180).replace(/\s+/g, ' ')}`);
    } else {
      console.log('\n[TEST 1] Skipped Gemini (no key)');
    }

    if (qwenKey) {
      console.log('\n[TEST 2] Switch to Qwen and send message');
      const qwenCandidates = [...new Set([
        qwenModelFromEnv,
        'qwen3-max-2026-01-23',
        'qwen-plus',
        'qwen-max',
        'qwen-turbo',
      ].filter(Boolean))];

      let qwenLast = { ok: false, text: '' };
      for (const model of qwenCandidates) {
        console.log(`Trying Qwen model: ${model}`);
        await applyProviderSettings(page, {
          provider: 'qwen',
          model,
          qwenKey,
          passphrase: 'test-provider-switch',
        });

        const res = await sendAndWaitForResponse(page, 'Answer in one line: what is 3+3?', 45000);
        qwenLast = res;
        if (res.ok) {
          testResults.qwenResponse = true;
          break;
        }

        const lower = (res.text || '').toLowerCase();
        if (!(lower.includes('free tier') || lower.includes('exhausted') || lower.includes('quota'))) {
          break;
        }
      }

      console.log(`Qwen result: ${testResults.qwenResponse ? 'PASS' : 'FAIL'}`);
      console.log(`Qwen sample: ${qwenLast.text.slice(0, 180).replace(/\s+/g, ' ')}`);
    } else {
      console.log('\n[TEST 2] Skipped Qwen (no key)');
    }

    if (geminiKey && qwenKey) {
      console.log('\n[TEST 3] Switch back to Gemini');
      await applyProviderSettings(page, {
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        geminiKey,
      });

      const res = await sendAndWaitForResponse(page, 'Reply with exactly: Gemini reconnected');
      testResults.geminiFinal = res.ok;
      console.log(`Gemini switch-back result: ${res.ok ? 'PASS' : 'FAIL'}`);
      console.log(`Gemini switch-back sample: ${res.text.slice(0, 180).replace(/\s+/g, ' ')}`);
    }

    console.log('\n==== Summary ====');
    if (geminiKey) console.log(`Gemini initial: ${testResults.geminiResponse ? 'PASS' : 'FAIL'}`);
    if (qwenKey) console.log(`Qwen: ${testResults.qwenResponse ? 'PASS' : 'FAIL'}`);
    if (geminiKey && qwenKey) console.log(`Gemini switch-back: ${testResults.geminiFinal ? 'PASS' : 'FAIL'}`);

    const passedAny = Object.values(testResults).some(Boolean);
    process.exitCode = passedAny ? 0 : 1;

    if (keepOpen) {
      console.log('\n[MODE] Browser kept open. Press Enter to close.');
      if (process.stdin.isTTY && process.stdout.isTTY) {
        await promptUser('');
      }
    }
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error('[ERROR]', err.message);
  process.exit(1);
});
