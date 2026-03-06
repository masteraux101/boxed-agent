/**
 * Test loading SOUL from GitHub URL
 */

import playwright from "playwright";

async function test() {
  const { chromium } = playwright;
  let browser;
  let page;

  try {
    browser = await chromium.launch({ headless: false });
    page = await browser.newPage();

    // Monitor console messages
    page.on('console', (msg) => {
      console.log(`[${msg.type()}] ${msg.text()}`);
    });

    console.log("═".repeat(60));
    console.log("SOUL LOADING FROM GitHub URL TEST");
    console.log("═".repeat(60));

    await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);

    const soulUrl = 'https://github.com/masteraux101/boxed-agent/raw/refs/heads/main/examples/souls/DEFAULT_SOUL.md';

    console.log(`\n📋 Test: Load SOUL from GitHub URL`);
    console.log("─".repeat(60));
    console.log(`URL: ${soulUrl}`);
    console.log("");

    // Test 1: Direct fetch test
    console.log("TEST 1: Direct fetch in Node.js");
    console.log("─".repeat(40));
    try {
      const resp = await fetch(soulUrl);
      console.log(`  Status: ${resp.status}`);
      const content = await resp.text();
      console.log(`  Content length: ${content.length} bytes`);
      console.log(`  First 200 chars:\n${content.substring(0, 200)}`);
      console.log("  ✅ Direct fetch works\n");
    } catch (e) {
      console.log(`  ❌ Error: ${e.message}\n`);
    }

    // Test 2: Fetch from browser context
    console.log("TEST 2: Fetch from browser context");
    console.log("─".repeat(40));

    const browserFetchResult = await page.evaluate(async (url) => {
      try {
        const resp = await fetch(url);
        console.log(`fetch status: ${resp.status}`);
        const content = await resp.text();
        console.log(`content length: ${content.length}`);
        return {
          success: true,
          status: resp.status,
          contentLength: content.length,
          preview: content.substring(0, 100)
        };
      } catch (e) {
        console.log(`fetch error: ${e.message}`);
        return {
          success: false,
          error: e.message
        };
      }
    }, soulUrl);

    console.log(`  Result: ${JSON.stringify(browserFetchResult, null, 2)}`);

    if (browserFetchResult.success) {
      console.log("  ✅ Browser fetch works\n");
    } else {
      console.log("  ❌ Browser fetch failed\n");
    }

    // Test 3: Load via SoulLoader
    console.log("TEST 3: Load via SoulLoader module");
    console.log("─".repeat(40));

    const loaderResult = await page.evaluate(async (url) => {
      try {
        // SoulLoader should be available from app.js which imports it
        if (!window.SoulLoader) {
          return {
            success: false,
            error: "SoulLoader not available in window"
          };
        }

        const result = await window.SoulLoader.load({
          soulUrl: url
        });

        console.log(`soulName: ${result.soulName}`);
        console.log(`systemInstruction length: ${result.systemInstruction.length}`);
        console.log(`soulContent length: ${result.soulContent.length}`);

        return {
          success: true,
          soulName: result.soulName,
          contentLength: result.systemInstruction.length,
          soulPreview: result.soulContent.substring(0, 150)
        };
      } catch (e) {
        console.log(`loader error: ${e.message}`);
        return {
          success: false,
          error: e.message
        };
      }
    }, soulUrl);

    console.log(`  Result: ${JSON.stringify(loaderResult, null, 2)}`);

    if (loaderResult.success) {
      console.log("  ✅ SoulLoader works\n");
    } else {
      console.log("  ❌ SoulLoader failed\n");
    }

    // Test 4: Use /soul command to load via UI
    console.log("TEST 4: Load SOUL via /soul command in UI");
    console.log("─".repeat(40));

    // First setup API key (required)
    await page.evaluate(() => {
      localStorage.setItem('browseragent_settings', JSON.stringify({
        apiKey: 'YOUR_GEMINI_API_KEY',
        model: 'gemini-2.5-flash',
      }));
    });

    // Create new session
    await page.locator('#new-session-btn').click();
    await page.waitForTimeout(800);

    // Fill API key
    await page.locator('#set-api-key').fill('test-key').catch(() => {});
    await page.locator('#apply-settings').click();
    await page.waitForTimeout(1000);

    // Send request to load soul via command
    const input = page.locator('#message-input');
    await input.focus();
    await input.type(`/soul ${soulUrl}`, { delay: 10 });
    await input.press('Enter');

    console.log("  ⏳ Waiting for response (3s)...");
    await page.waitForTimeout(3000);

    const chatContent = await page.evaluate(() => {
      return document.querySelector('#chat-box')?.innerText || '';
    });

    // Check if response contains success indicators
    const hasSuccess = chatContent.includes('✅') || 
                      chatContent.includes('Loaded') || 
                      chatContent.includes('Successfully');
    const hasError = chatContent.includes('❌') || 
                    chatContent.includes('Error') || 
                    chatContent.includes('Failed');

    if (hasSuccess) {
      console.log("  ✅ Command executed successfully");
      console.log(`     Response preview: ${chatContent.substring(0, 150)}...`);
    } else if (hasError) {
      console.log("  ❌ Command failed");
      console.log(`     Response: ${chatContent.substring(0, 300)}...`);
    } else {
      console.log("  ⏳ Command sent, waiting for response");
      console.log(`     Response: ${chatContent.substring(0, 200)}...`);
    }

    console.log("\n" + "═".repeat(60));
    console.log("TEST SUMMARY");
    console.log("═".repeat(60));
    console.log(`1. Direct fetch: ✅`);
    console.log(`2. Browser fetch: ${browserFetchResult.success ? '✅' : '❌'}`);
    console.log(`3. SoulLoader: ${loaderResult.success ? '✅' : '❌'}`);
    console.log(`4. UI /soul command: ${hasSuccess ? '✅' : hasError ? '❌' : '⏳'}`);
    console.log("═".repeat(60));

    await browser.close();

  } catch (err) {
    console.error("\n❌ Test error:", err.message);
    if (browser) await browser.close();
    process.exit(1);
  }
}

test();
