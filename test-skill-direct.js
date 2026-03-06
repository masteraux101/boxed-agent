/**
 * SKILL URL Loading Test
 * Test: /skill <direct-github-url>
 * 
 * Prerequisites: See .test-prerequisites.md
 * - GEMINI_KEY environment variable must be set
 * - Model name must be configured in session
 */

import playwright from "playwright";

async function test() {
  const { chromium } = playwright;
  let browser;
  let page;

  const GEMINI_KEY = process.env.GEMINI_KEY;
  if (!GEMINI_KEY) {
    console.error('❌ GEMINI_KEY environment variable not set');
    console.error('See .test-prerequisites.md for setup instructions');
    process.exit(1);
  }

  try {
    browser = await chromium.launch({ headless: false });
    page = await browser.newPage();

    // Capture console logs
    const consoleLogs = [];
    page.on('console', (msg) => {
      consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
    });

    console.log("═".repeat(60));
    console.log("SKILL URL LOADING TEST");
    console.log("═".repeat(60));

    await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);

    // Create new session with actual API key
    console.log("\n1️⃣  Creating session with proper configuration...");
    await page.locator('#new-session-btn').click();
    await page.waitForTimeout(800);

    // Fill settings directly via DOM manipulation (more reliable)
    await page.evaluate(({key, model, pass}) => {
      document.querySelector('#set-api-key').value = key;
      document.querySelector('#set-model').value = model;
      document.querySelector('#set-passphrase').value = pass;
    }, {key: GEMINI_KEY, model: 'gemini-2.5-flash', pass: 'test-pass'});

    await page.locator('#apply-settings').click();
    await page.waitForTimeout(1500);

    console.log("✅ Session created\n");

    // Test 1: Load built-in skill by name
    console.log("2️⃣  TEST 1: Load built-in SKILL by name");
    console.log("─".repeat(60));

    const input = page.locator('#message-input');
    await input.focus();
    await input.type('/skill ai-prompt-scheduler', { delay: 5 });
    
    console.log('Sent command: /skill ai-prompt-scheduler');
    
    const sendBtn = page.locator('#send-btn');
    await sendBtn.click();
    
    console.log("⏳ Waiting 5 seconds for response...\n");
    await page.waitForTimeout(5000);

    let chatContent = await page.evaluate(() => {
      return document.querySelector('#chat-box')?.innerText || '';
    });

    console.log("Response (last 500 chars):");
    console.log("─".repeat(60));
    console.log(chatContent.substring(Math.max(0, chatContent.length - 500)));
    console.log("─".repeat(60));

    const test1Success = chatContent.includes('✅') || chatContent.includes('Loaded');
    const test1Failed = chatContent.includes('❌');

    console.log(`\nResult: ${test1Success ? '✅ SUCCESS' : test1Failed ? '❌ FAILED' : '⏳ UNCLEAR'}\n`);

    // Test 2: Load SKILL from direct GitHub raw URL
    console.log("3️⃣  TEST 2: Load SKILL from GitHub URL");
    console.log("─".repeat(60));

    const skillUrl = 'https://raw.githubusercontent.com/masteraux101/boxed-agent/refs/heads/main/examples/skills/ai-prompt-scheduler.md';
    
    await input.focus();
    await input.type(`/skill ${skillUrl}`, { delay: 5 });
    
    console.log(`Sent command: /skill ${skillUrl.substring(0, 60)}...`);
    
    await sendBtn.click();
    
    console.log("⏳ Waiting 5 seconds for response...\n");
    await page.waitForTimeout(5000);

    chatContent = await page.evaluate(() => {
      return document.querySelector('#chat-box')?.innerText || '';
    });

    console.log("Response (last 600 chars):");
    console.log("─".repeat(60));
    console.log(chatContent.substring(Math.max(0, chatContent.length - 600)));
    console.log("─".repeat(60));

    const test2Success = chatContent.includes('✅') || chatContent.includes('Loaded');
    const test2Failed = chatContent.includes('❌');

    console.log(`\nResult: ${test2Success ? '✅ SUCCESS' : test2Failed ? '❌ FAILED' : '⏳ UNCLEAR'}\n`);

    // Show browser console logs
    console.log("📋 BROWSER CONSOLE LOGS (last 15):");
    console.log("─".repeat(60));
    for (const log of consoleLogs.slice(-15)) {
      console.log(log);
    }
    console.log("─".repeat(60));

    // Summary
    console.log("\n" + "═".repeat(60));
    console.log("📊 SUMMARY");
    console.log("═".repeat(60));
    console.log(`1. Built-in SKILL loading: ${test1Success ? '✅ PASS' : test1Failed ? '❌ FAIL' : '⏳ UNCLEAR'}`);
    console.log(`2. GitHub URL SKILL loading: ${test2Success ? '✅ PASS' : test2Failed ? '❌ FAIL' : '⏳ UNCLEAR'}`);
    
    if (test1Success && test2Success) {
      console.log("\n✅ ALL TESTS PASSED - SKILL loading works with both built-in and external URLs");
    } else {
      console.log("\n⚠️  Some tests failed - see responses above for details");
    }
    console.log("═".repeat(60));

    await browser.close();

  } catch (err) {
    console.error("\n❌ Test error:", err.message);
    if (browser) await browser.close();
    process.exit(1);
  }
}

test();
