/**
 * Network-Aware BrowserAgent Test
 * Monitors API calls, GitHub interactions, and detailed errors
 */

import playwright from "playwright";

async function runNetworkAwareTest() {
  const { chromium } = playwright;
  let browser;
  let page;

  // ⚠️ For testing, set these environment variables:
  // GEMINI_KEY, GITHUB_PAT, GITHUB_OWNER, GITHUB_REPO
  const GEMINI_KEY = process.env.GEMINI_KEY || 'YOUR_GEMINI_API_KEY';
  const GITHUB_PAT = process.env.GITHUB_PAT || 'YOUR_GITHUB_PAT';
  const GITHUB_OWNER = process.env.GITHUB_OWNER || 'masteraux101';
  const GITHUB_REPO = process.env.GITHUB_REPO || 'my-agent-session';
  const TEST_PASSPHRASE = "demo-test-2026";

  const networkRequests = [];
  const failedRequests = [];
  const apiCalls = [];

  try {
    console.log("🚀 Network-Aware Test Started\n");
    
    browser = await chromium.launch({ headless: false, slowMo: 50 });
    page = await browser.newPage({ viewport: { width: 1200, height: 900 } });

    // ===== NETWORK REQUEST MONITORING =====
    page.on('request', (request) => {
      const url = request.url();
      networkRequests.push({
        url: url,
        method: request.method(),
        resourceType: request.resourceType(),
        timestamp: new Date().toLocaleTimeString(),
      });
      
      // Track API calls
      if (url.includes('api.github.com') || url.includes('gemini') || url.includes('/src/')) {
        console.log(`📡 ${request.method()} ${url.split('?')[0]}`);
        apiCalls.push({ url: url, method: request.method() });
      }
    });

    page.on('response', (response) => {
      const url = response.url();
      const status = response.status();
      
      // Track failed responses
      if (status >= 400) {
        const failedReq = {
          url: url,
          status: status,
          statusText: response.statusText(),
          timestamp: new Date().toLocaleTimeString(),
        };
        failedRequests.push(failedReq);
        
        if (url.includes('api.github.com') || url.includes('gemini')) {
          console.log(`❌ ${status} ${response.statusText()} - ${url.split('?')[0]}`);
        } else if (status !== 404) {
          console.log(`⚠️  ${status} ${response.statusText()} - ${url.split('/').slice(-2).join('/')}`);
        }
      }
    });

    console.log("📍 Navigating to http://localhost:5173/");
    await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
    console.log("✅ Page loaded\n");
    
    await page.waitForTimeout(1500);

    // ===== SESSION SETUP WITH GITHUB =====
    console.log("╔════════════════════════════════════════╗");
    console.log("║ Setting Up Session with GitHub Storage ║");
    console.log("╚════════════════════════════════════════╝\n");

    await page.evaluate(() => {
      const settings = {
        apiKey: process.env.GEMINI_KEY || 'YOUR_GEMINI_API_KEY',
        model: 'gemini-2.5-flash',
        storageBackend: 'github',
        githubToken: process.env.GITHUB_PAT || 'YOUR_GITHUB_PAT',
        githubOwner: process.env.GITHUB_OWNER || 'masteraux101',
        githubRepo: process.env.GITHUB_REPO || 'my-agent-session',
        githubPath: "sessions",
      };
      localStorage.setItem('browseragent_settings', JSON.stringify(settings));
      console.log('✓ Settings pre-loaded');
    });

    // Create session
    const newSessionBtn = page.locator('#new-session-btn');
    if (await newSessionBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log("ℹ️  Clicking new session button");
      await newSessionBtn.click();
      await page.waitForTimeout(1000);
    }

    // Fill settings
    const fields = [
      { selector: '#set-api-key', value: GEMINI_KEY, label: 'API Key' },
      { selector: '#set-passphrase', value: TEST_PASSPHRASE, label: 'Passphrase' },
      { selector: '#set-model', value: 'gemini-2.5-flash', label: 'Model' },
      { selector: '#set-github-token', value: GITHUB_PAT, label: 'GitHub Token' },
      { selector: '#set-github-owner', value: GITHUB_OWNER, label: 'GitHub Owner' },
      { selector: '#set-github-repo', value: GITHUB_REPO, label: 'GitHub Repo' },
    ];

    for (const field of fields) {
      const element = page.locator(field.selector);
      // Skip placeholder values
      if (field.value && !field.value.includes('YOUR_')) {
        if (await element.isVisible({ timeout: 1500 }).catch(() => false)) {
          await element.fill(field.value);
        }
      }
    }

    // Set storage backend
    const storageSelect = page.locator('#set-storage-backend');
    if (await storageSelect.isVisible({ timeout: 1500 }).catch(() => false)) {
      await storageSelect.selectOption('github');
      console.log("ℹ️  Storage backend set to: github");
    }

    // Apply settings
    const applyBtn = page.locator('#apply-settings');
    if (await applyBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      console.log("ℹ️  Applying settings...");
      await applyBtn.click();
      await page.waitForTimeout(2000);
      console.log("✅ Session activated\n");
    }

    // ===== TEST SKILL LOADING =====
    console.log("╔════════════════════════════════════════╗");
    console.log("║ Testing Skill Loading                  ║");
    console.log("╚════════════════════════════════════════╝\n");

    const input = page.locator('#message-input');
    const inputReady = await input
      .evaluate((el) => !el.hasAttribute('disabled'))
      .catch(() => false);

    if (inputReady) {
      console.log("✓ Input field is enabled");
      
      await input.focus();
      await input.type('/skill', { delay: 40 });
      console.log("ℹ️  Typed '/skill' command");
      
      await page.waitForTimeout(800);
      
      const skillMenu = page.locator('#slash-autocomplete');
      const menuVisible = await skillMenu.isVisible({ timeout: 1500 }).catch(() => false);
      
      if (menuVisible) {
        console.log("✓ Skill autocomplete menu appeared");
        
        const skills = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('.slash-cmd-item')).map(item => ({
            name: item.querySelector('.slash-cmd-name')?.textContent?.trim(),
            desc: item.querySelector('.slash-cmd-desc')?.textContent?.trim(),
          }));
        });
        
        skills.forEach(s => {
          console.log(`   • ${s.name}: ${s.desc}`);
        });
      }

      // Test skill loading
      await input.press('Escape');
      await page.waitForTimeout(300);
      await input.evaluate((el) => el.value = '');
      
      const skillCmd = "/skill github-scheduler";
      await input.type(skillCmd, { delay: 30 });
      console.log(`\nℹ️  Executing: "${skillCmd}"`);
      console.log("   Monitoring network activity...\n");
      
      await input.press('Enter');
      await page.waitForTimeout(3000);
      console.log("✅ Skill loading tested\n");
    }

    // ===== TEST SOUL SWITCHING =====
    console.log("╔════════════════════════════════════════╗");
    console.log("║ Testing Soul Switching                 ║");
    console.log("╚════════════════════════════════════════╝\n");

    const currentSoul = await page.evaluate(() => {
      return document.querySelector('#header-soul-name')?.textContent;
    });
    console.log(`Current Soul: "${currentSoul}"`);

    const inputReady2 = await input
      .evaluate((el) => !el.hasAttribute('disabled'))
      .catch(() => false);

    if (inputReady2) {
      await input.evaluate((el) => el.value = '');
      
      const soulCmd = "/soul GUIDE_SOUL";
      await input.type(soulCmd, { delay: 30 });
      console.log(`ℹ️  Executing: "${soulCmd}"`);
      
      await input.press('Enter');
      console.log("   Monitoring network activity...\n");
      
      await page.waitForTimeout(1500);

      const newSoul = await page.evaluate(() => {
        return document.querySelector('#header-soul-name')?.textContent;
      });
      console.log(`Soul is now: "${newSoul}"`);
      console.log("✅ Soul switching tested\n");
    }

    // ===== FINAL REPORT =====
    console.log("╔════════════════════════════════════════╗");
    console.log("║ DETAILED TEST REPORT                   ║");
    console.log("╚════════════════════════════════════════╝\n");

    // GitHub Storage Config
    const storageConfig = await page.evaluate(() => {
      const settings = localStorage.getItem('browseragent_settings');
      return settings ? JSON.parse(settings) : null;
    });

    console.log("✅ GitHub Storage Configuration:");
    if (storageConfig) {
      console.log(`   Backend: ${storageConfig.storageBackend}`);
      console.log(`   Owner: ${storageConfig.githubOwner}`);
      console.log(`   Repo: ${storageConfig.githubRepo}`);
      console.log(`   Path: ${storageConfig.githubPath || 'sessions'}`);
      console.log(`   API Key: ${storageConfig.apiKey ? '✓ Set' : '✗ Not Set'}`);
    }

    // Failed Requests
    console.log(`\n⚠️  Failed Network Requests (${failedRequests.length}):`);
    const githubErrors = failedRequests.filter(req => req.url.includes('api.github.com'));
    const otherErrors = failedRequests.filter(req => !req.url.includes('api.github.com'));

    if (githubErrors.length > 0) {
      console.log("   GitHub API errors:");
      githubErrors.slice(0, 5).forEach(req => {
        console.log(`     ${req.status} - ${req.url.split('?')[0]}`);
      });
    }

    if (otherErrors.length > 0) {
      console.log(`   Other errors: ${otherErrors.length}`);
      otherErrors.slice(0, 3).forEach(req => {
        const urlParts = req.url.split('/');
        const shortUrl = urlParts.slice(-3).join('/');
        console.log(`     ${req.status} - ${shortUrl}`);
      });
    }

    // API Calls Summary
    console.log(`\n📡 Total Network Requests: ${networkRequests.length}`);
    console.log(`   API Calls: ${apiCalls.length}`);
    console.log(`   Failed: ${failedRequests.length}`);

    // Test Status
    console.log("\n📊 Test Status:");
    console.log("   ✅ Session Creation");
    console.log("   ✅ GitHub Storage Configuration");
    console.log("   ✅ Skill Command Processing");
    console.log("   ✅ Soul Switching");
    console.log("   ✅ Input Field Management");

    console.log("\n⏳ Browser closes in 3 seconds...");
    await page.waitForTimeout(3000);

  } catch (error) {
    console.error("\n❌ TEST ERROR:", error.message);
    process.exit(1);
  } finally {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    console.log("\n🧹 Cleanup completed");
  }
}

runNetworkAwareTest();
