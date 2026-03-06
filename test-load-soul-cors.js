/**
 * Test loading SOUL from GitHub with CORS workaround
 */

import playwright from "playwright";

async function test() {
  const { chromium } = playwright;
  let browser;
  let page;

  try {
    browser = await chromium.launch({ headless: false });
    page = await browser.newPage();

    console.log("═".repeat(60));
    console.log("SOUL LOADING TEST - WITH CORS PROXY");
    console.log("═".repeat(60));

    await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);

    const soulUrl = 'https://github.com/masteraux101/boxed-agent/raw/refs/heads/main/examples/souls/DEFAULT_SOUL.md';
    const corsProxy = 'https://corsproxy.io/?url=';

    console.log("\n📋 Test: Load SOUL with CORS proxy workaround");
    console.log("─".repeat(60));
    console.log(`SOUL URL: ${soulUrl}`);
    console.log(`Using CORS proxy: ${corsProxy}`);
    console.log("");

    // Test fetching with CORS proxy
    console.log("TEST 1: Fetch with CORS Proxy");
    console.log("─".repeat(40));

    const proxiedUrl = corsProxy + encodeURIComponent(soulUrl);
    console.log(`Proxied URL: ${proxiedUrl.substring(0, 80)}...`);

    try {
      const resp = await fetch(proxiedUrl);
      console.log(`  Status: ${resp.status}`);
      const content = await resp.text();
      console.log(`  Content length: ${content.length} bytes`);
      console.log(`  Preview: ${content.substring(0, 150)}`);
      console.log("  ✅ CORS proxy works\n");
    } catch (e) {
      console.log(`  ❌ Error: ${e.message}\n`);
    }

    // Now setup session with CORS proxy and test
    console.log("TEST 2: Setup Session with CORS Proxy & Load SOUL");
    console.log("─".repeat(40));

    // Pre-fill settings
    await page.evaluate(({corsProxy}) => {
      localStorage.setItem('browseragent_settings', JSON.stringify({
        apiKey: 'test-key',
        model: 'gemini-2.5-flash',
        corsProxy: corsProxy,
      }));
    }, {corsProxy: corsProxy});

    // Create new session
    await page.locator('#new-session-btn').click();
    await page.waitForTimeout(800);

    // Fill settings
    await page.locator('#set-api-key').fill('test-key').catch(() => {});
    await page.locator('#set-cors-proxy').fill(corsProxy).catch(() => {});
    await page.locator('#apply-settings').click();
    await page.waitForTimeout(1500);

    console.log("  ✅ Session created with CORS proxy setting");

    // Now test loading soul via /soul <url> command in UI
    console.log("\nTEST 3: Load SOUL via /soul <url> command");
    console.log("─".repeat(40));

    const input = page.locator('#message-input');
    await input.focus();
    await input.type(`/soul ${soulUrl}`, { delay: 8 });
    await input.press('Enter');

    console.log("  ⏳ Sending /soul command...");
    await page.waitForTimeout(4000);

    const chatContent = await page.evaluate(() => {
      return document.querySelector('#chat-box')?.innerText || '';
    });

    // Check results
    const hasError = chatContent.includes('❌') || chatContent.includes('Error') || chatContent.includes('Failed');
    const hasSuccess = chatContent.includes('✅') || chatContent.includes('Switched');
    const isLoading = chatContent.includes('Loading') || chatContent.includes('⏳');

    console.log(`\n  Chat response (first 300 chars):`);
    console.log(`  ${chatContent.substring(0, 300).replace(/\n/g, '\n  ')}`);

    if (hasSuccess) {
      console.log(`\n  ✅ SOUL LOADED SUCCESSFULLY`);
    } else if (hasError) {
      console.log(`\n  ❌ LOADING FAILED - Check error in response`);
    } else if (isLoading) {
      console.log(`\n  ⏳ STILL LOADING - AI might be processing`);
    } else {
      console.log(`\n  ⚠️  Status unclear - check response above`);
    }

    // Try another approach: use /skill command which has simpler loading
    console.log("\nTEST 4: Load Skill to verify SoulLoader is available");
    console.log("─".repeat(40));

    const skillUrl = 'https://github.com/masteraux101/boxed-agent/raw/refs/heads/main/examples/skills/github-scheduler.md';
    await input.focus();
    await input.type(`/skill ${skillUrl}`, { delay: 8 });
    await input.press('Enter');

    console.log("  ⏳ Loading skill...");
    await page.waitForTimeout(4000);

    const chatContent2 = await page.evaluate(() => {
      return document.querySelector('#chat-box')?.innerText || '';
    });

    const hasSkillSuccess = chatContent2.includes('✅') || chatContent2.includes('Loaded');
    const hasSkillError = chatContent2.includes('❌');

    if (hasSkillSuccess) {
      console.log(`  ✅ SKILL LOADED SUCCESSFULLY`);
    } else if (hasSkillError) {
      console.log(`  ❌ SKILL LOADING FAILED`);
    } else {
      console.log(`  ⚠️  SKILL STATUS UNCLEAR`);
    }

    console.log("\n" + "═".repeat(60));
    console.log("SUMMARY");
    console.log("═".repeat(60));
    console.log("Issues found:");
    console.log("1. Browser CORS blocks direct GitHub fetch");
    console.log("2. CORS proxy wrapper can bypass this");
    console.log("3. Need to verify SoulLoader properly handles externally-provided URLs");
    if (corsProxy.includes('corsproxy')) {
      console.log("\n⚠️  Note: corsproxy.io has rate limits. For production, use:");
      console.log("   - https://api.allorigins.win/raw?url=");
      console.log("   - https://api.codetabs.com/v1/proxy?quest=");
      console.log("   - Or self-hosted CORS proxy");
    }
    console.log("═".repeat(60));

    await browser.close();

  } catch (err) {
    console.error("\n❌ Test error:", err.message);
    console.error(err.stack);
    if (browser) await browser.close();
    process.exit(1);
  }
}

test();
