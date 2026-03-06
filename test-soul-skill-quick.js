/**
 * SOUL & SKILL Loading Status Test
 */

import playwright from "playwright";

async function test() {
  const { chromium } = playwright;
  let browser;
  let page;

  try {
    browser = await chromium.launch({ headless: false });
    page = await browser.newPage();

    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warn') {
        console.log(`[${msg.type().toUpperCase()}] ${msg.text()}`);
      }
    });

    console.log("Loading...");
    await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);

    // Setup
    await page.evaluate(() => {
      localStorage.setItem('browseragent_settings', JSON.stringify({
        apiKey: "YOUR_GEMINI_API_KEY",
        model: 'gemini-2.5-flash',
        storageBackend: 'github',
        githubToken: "YOUR_GITHUB_PAT",
        githubOwner: "masteraux101",
        githubRepo: "my-agent-session",
      }));
    });

    // Create session
    await page.locator('#new-session-btn').click();
    await page.waitForTimeout(800);

    const fields = [
      ['#set-api-key', 'AIzaSyB3HZkS6bBA23tLHTq1xbm1n25i-oqxsWE'],
      ['#set-passphrase', 'test123'],
      ['#set-model', 'gemini-2.5-flash'],
      ['#set-github-token', 'YOUR_GITHUB_PAT'],
      ['#set-github-owner', 'masteraux101'],
      ['#set-github-repo', 'my-agent-session'],
    ];

    for (const [sel, val] of fields) {
      await page.locator(sel).fill(val).catch(() => {});
    }

    await page.locator('#set-storage-backend').selectOption('github').catch(() => {});
    await page.locator('#apply-settings').click();
    await page.waitForTimeout(2000);

    const input = page.locator('#message-input');

    // Test 1: /skill github-scheduler
    console.log("\n┌─ Test 1: /skill github-scheduler");
    await input.focus();
    await input.type('/skill github-scheduler', { delay: 15 });
    await input.press('Enter');
    console.log("│ ⏳ Waiting 3s for response...");
    await page.waitForTimeout(3000);

    const chat1 = await page.evaluate(() => document.querySelector('#chat-box')?.innerText || '');
    if (chat1.includes('✅ Loaded') || chat1.includes('Loaded skill')) {
      console.log("│ ✅ SKILL LOADING WORKS");
    } else {
      console.log("│ ❌ SKILL NOT LOADED");
      console.log(`│ Chat: ${chat1.substring(chat1.length - 100)}`);
    }

    // Test 2: /soul Life Coach · 理性工程导师
    console.log("\n┌─ Test 2: /soul (full name)");
    await input.evaluate(el => el.value = '');
    await input.type('/soul Life Coach · 理性工程导师', { delay: 10 });
    await input.press('Enter');
    console.log("│ ⏳ Waiting 4s for response...");
    await page.waitForTimeout(4000);

    const chat2 = await page.evaluate(() => document.querySelector('#chat-box')?.innerText || '');
    const soul = await page.evaluate(() => document.querySelector('#header-soul-name')?.textContent);
    
    if (chat2.includes('✅ Switched') || chat2.includes('Switched to')) {
      console.log("│ ✅ SOUL SWITCHING COMMAND WORKS");
    } else {
      console.log("│ ⚠️  Soul command response:");
      console.log(`│ ${chat2.split('\n').slice(-3).join('\n│ ')}`);
    }
    
    console.log(`│ Current soul: ${soul}`);
    console.log("└─");

    console.log("\nClosing in 2 seconds...");
    await page.waitForTimeout(2000);

  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  } finally {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

test();
