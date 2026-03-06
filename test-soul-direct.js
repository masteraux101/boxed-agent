/**
 * Simple SOUL URL Loading Test
 * Test: /soul <direct-github-url>
 */

import playwright from "playwright";

async function test() {
  const { chromium } = playwright;
  let browser;
  let page;

  const GEMINI_KEY = process.env.GEMINI_KEY;
  if (!GEMINI_KEY) {
    console.error('❌ GEMINI_KEY environment variable not set');
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
    console.log("SOUL URL LOADING TEST");
    console.log("═".repeat(60));

    await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);

    // Create new session with actual API key
    await page.locator('#new-session-btn').click();
    await page.waitForTimeout(800);

    // Fill settings directly via DOM manipulation to ensure they work
    await page.evaluate(({key, model, pass}) => {
      document.querySelector('#set-api-key').value = key;
      document.querySelector('#set-model').value = model;
      document.querySelector('#set-passphrase').value = pass;
    }, {key: GEMINI_KEY, model: 'gemini-2.5-flash', pass: 'test-pass'});

    await page.locator('#apply-settings').click();
    await page.waitForTimeout(1500);

    console.log("\n✅ Session created\n");

    // Test 1: Load SOUL from direct GitHub raw URL
    console.log("TEST 1: Load DEFAULT_SOUL");
    console.log("─".repeat(60));

    const soulUrl = 'https://github.com/masteraux101/boxed-agent/raw/refs/heads/main/examples/souls/DEFAULT_SOUL.md';
    
    const input = page.locator('#message-input');
    await input.focus();
    await input.type(`/soul ${soulUrl}`, { delay: 5 });
    
    console.log(`Sent command via keyboard: /soul ${soulUrl.substring(0, 60)}...`);
    
    // Send via button instead of Enter
    const sendBtn = page.locator('#send-btn');
    await sendBtn.click();
    
    console.log("⏳ Waiting 10 seconds for response...\n");

    await page.waitForTimeout(10000);

    const chatContent = await page.evaluate(() => {
      return document.querySelector('#chat-box')?.innerText || '';
    });

    console.log("COMPLETE Chat response:");
    console.log("─".repeat(60));
    console.log(chatContent);
    console.log("─".repeat(60));

    // Show console logs
    console.log("\n📋 BROWSER CONSOLE LOGS:");
    console.log("─".repeat(60));
    for (const log of consoleLogs.slice(-20)) {  // Show last 20
      console.log(log);
    }
    console.log("─".repeat(60));

    // Analyze response
    const lines = chatContent.split('\n');
    const hasSuccess = chatContent.includes('✅') || chatContent.includes('Switched');
    const hasError = chatContent.includes('❌') || chatContent.includes('Error');
    const hasCORS = chatContent.includes('CORS') || chatContent.includes('cors');
    const hasBlocked = chatContent.includes('blocked') || chatContent.includes('Failed to fetch');
    const hasLoading = chatContent.includes('Loading') || chatContent.includes('⏳');

    console.log("\n📊 ANALYSIS:");
    console.log(`  ✅ Success indicator: ${hasSuccess ? 'YES' : 'NO'}`);
    console.log(`  ❌ Error indicator: ${hasError ? 'YES' : 'NO'}`);
    console.log(`  ⏳ Loading indicator: ${hasLoading ? 'YES' : 'NO'}`);
    console.log(`  🔒 CORS issue: ${hasCORS ? 'YES' : 'NO'}`);
    console.log(`  ⚠️  Fetch blocked: ${hasBlocked ? 'YES' : 'NO'}`);

    if (hasCORS || hasBlocked) {
      console.log("\n💡 FINDING: Cannot load directly from GitHub due to CORS policy");
      console.log("   Solution: Implement CORS proxy in soul-loader.js when loading from external URLs");
    }

    if (hasSuccess) {
      console.log("\n✅ SOUL loaded successfully!");
    }

    console.log("\n" + "═".repeat(60));

    await browser.close();

  } catch (err) {
    console.error("\n❌ Test error:", err.message);
    if (browser) await browser.close();
    process.exit(1);
  }
}

test();
