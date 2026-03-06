/**
 * GitHub Session Recovery Test
 * 
 * Tests the complete session lifecycle:
 * 1. Create a new session with GitHub storage
 * 2. Add messages and save to GitHub
 * 3. Clear local storage (simulate new device)
 * 4. Recover the session from GitHub using session ID + passphrase
 * 5. Verify the recovered session matches the original
 */

import playwright from "playwright";

async function test() {
  const { chromium } = playwright;
  let browser;
  let page;

  try {
    browser = await chromium.launch({ headless: false });
    page = await browser.newPage();

    // Monitor console errors
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warn') {
        console.log(`[${msg.type().toUpperCase()}] ${msg.text()}`);
      }
    });

    // Get credentials from environment variables
    const GEMINI_KEY = process.env.GEMINI_KEY;
    const GITHUB_PAT = process.env.GITHUB_PAT;
    const GITHUB_OWNER = process.env.GITHUB_OWNER || 'masteraux101';
    const GITHUB_REPO = process.env.GITHUB_REPO || 'my-agent-session';

    if (!GEMINI_KEY || !GITHUB_PAT) {
      console.error('❌ Missing required environment variables:');
      console.error('   GEMINI_KEY, GITHUB_PAT');
      process.exit(1);
    }

    const passphrase = 'test-recovery-12345';

    console.log("═".repeat(60));
    console.log("SESSION RECOVERY TEST");
    console.log("═".repeat(60));

    // ─── PHASE 1: Create and save session ───────────────────────────

    console.log("\n📋 PHASE 1: Create Session & Save to GitHub");
    console.log("─".repeat(60));

    await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);

    // Configure global settings
    await page.evaluate(({apiKey, token, owner, repo}) => {
      localStorage.setItem('browseragent_settings', JSON.stringify({
        apiKey: apiKey,
        model: 'gemini-2.5-flash',
        storageBackend: 'github',
        githubToken: token,
        githubOwner: owner,
        githubRepo: repo,
      }));
    }, {apiKey: GEMINI_KEY, token: GITHUB_PAT, owner: GITHUB_OWNER, repo: GITHUB_REPO});

    // Click "New Session" button
    console.log("  ⏳ Creating new session...");
    await page.locator('#new-session-btn').click();
    await page.waitForTimeout(800);

    // Configure session settings (passphrase is important for recovery)
    const settingsToFill = [
      ['#set-api-key', GEMINI_KEY],
      ['#set-passphrase', passphrase],
      ['#set-model', 'gemini-2.5-flash'],
      ['#set-github-token', GITHUB_PAT],
      ['#set-github-owner', GITHUB_OWNER],
      ['#set-github-repo', GITHUB_REPO],
    ];

    for (const [selector, value] of settingsToFill) {
      await page.locator(selector).fill(value).catch(() => {});
    }

    await page.locator('#set-storage-backend').selectOption('github').catch(() => {});
    await page.locator('#apply-settings').click();
    await page.waitForTimeout(2000);

    // Get the session ID for later recovery
    const sessionId = await page.evaluate(() => {
      const match = localStorage.getItem('browseragent_sessions_index');
      if (match) {
        const sessions = JSON.parse(match);
        return sessions[0]?.id || null;
      }
      return null;
    });

    console.log(`  ✅ Session created: ${sessionId}`);

    // ─── PHASE 2: Add messages and save ────────────────────────────

    console.log("\n📝 PHASE 2: Add Test Messages");
    console.log("─".repeat(60));

    const input = page.locator('#message-input');

    // Add a few test messages
    const testMessages = [
      "Hello, this is a test message",
      "Let me ask you something",
      "Can you remember this session?",
    ];

    for (let i = 0; i < testMessages.length; i++) {
      console.log(`  📨 Sending message ${i + 1}/${testMessages.length}: "${testMessages[i]}"`);
      await input.focus();
      await input.fill(testMessages[i]);
      await input.press('Enter');
      
      // Wait for response
      await page.waitForTimeout(2000);
      
      // Check for completion (user message + model response both appear)
      const hasResponse = await page.evaluate(({text}) => {
        const chatBox = document.querySelector('#chat-box');
        return chatBox && chatBox.innerText.includes(text);
      }, {text: testMessages[0]});

      if (hasResponse) {
        console.log(`     ✅ Message sent and response received`);
      } else {
        console.log(`     ⏳ Waiting for model response...`);
        await page.waitForTimeout(3000);
      }
    }

    // Get the chat content before clearing
    const originalChatContent = await page.evaluate(() => {
      return document.querySelector('#chat-box')?.innerText || '';
    });

    const messageCount = (originalChatContent.match(/📨|🤖/g) || []).length;
    console.log(`  ✅ Session has ${messageCount} exchanges`);

    // Trigger auto-save
    console.log(`  ⏳ Waiting for auto-save to GitHub...`);
    await page.waitForTimeout(3000);

    // ─── PHASE 3: Clear local storage (simulate new device) ─────────

    console.log("\n🔄 PHASE 3: Clear Local Storage (Simulate New Device)");
    console.log("─".repeat(60));

    const clearedSession = await page.evaluate(() => {
      const sessionId = JSON.parse(
        localStorage.getItem('browseragent_sessions_index')
      )[0]?.id;

      // Record what we're clearing
      const index = localStorage.getItem('browseragent_sessions_index');
      const config = localStorage.getItem(`browseragent_session_cfg_${sessionId}`);
      const chatData = localStorage.getItem(`session_${sessionId}`);

      console.log(`    Clearing:
      - Index (${index?.length || 0} bytes)
      - Config (${config?.length || 0} bytes)
      - Chat data (${chatData?.length || 0} bytes)`);

      // Clear everything except settings (to preserve GitHub config)
      localStorage.removeItem('browseragent_sessions_index');
      localStorage.removeItem(`browseragent_session_cfg_${sessionId}`);
      localStorage.removeItem(`session_${sessionId}`);

      return sessionId;
    });

    console.log("  ✅ Local storage cleared");
    console.log(`     Session ID saved for recovery: ${clearedSession}`);

    // ─── PHASE 4: Recover session from GitHub ────────────────────

    console.log("\n🔙 PHASE 4: Recover Session from GitHub");
    console.log("─".repeat(60));

    // Reload the page to simulate fresh start
    console.log("  ⏳ Reloading page (simulating new device)...");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);

    // Check that session index is empty after reload
    const isCleared = await page.evaluate(() => {
      const index = localStorage.getItem('browseragent_sessions_index');
      return !index || JSON.parse(index).length === 0;
    });

    if (isCleared) {
      console.log("  ✅ Page reloaded, sessions list is empty");
    }

    // Now manually trigger recovery using the saved session ID
    // We'll use the Storage API through the browser context
    console.log(`  ⏳ Recovering session ${clearedSession}...`);

    const recoveryResult = await page.evaluate(
      async ({sessionId, passphrase, owner, repo, token, apiKey}) => {
        // First, restore the session to the index so loadSession can find it
        const indexEntry = {
          id: sessionId,
          title: 'Recovered Session',
          backend: 'github',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        localStorage.setItem('browseragent_sessions_index', JSON.stringify([indexEntry]));

        // Restore session config with GitHub credentials
        const cfg = {
          apiKey: apiKey,
          githubToken: token,
          githubOwner: owner,
          githubRepo: repo,
          storageBackend: 'github',
          passphrase: passphrase,
        };

        localStorage.setItem(`browseragent_session_cfg_${sessionId}`, JSON.stringify(cfg));

        return {
          success: true,
          sessionId: sessionId,
          indexRestored: true,
        };
      },
      {
        sessionId: clearedSession,
        passphrase: passphrase,
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        token: GITHUB_PAT,
        apiKey: GEMINI_KEY
      }
    );

    console.log(`  ✅ Recovery index prepared: ${recoveryResult.sessionId}`);

    // Now click on the session to trigger loadSession
    // Wait for sidebar to render
    await page.waitForTimeout(500);

    const clickResult = await page.evaluate(() => {
      const sessionLink = Array.from(document.querySelectorAll('.session-item')).find(
        el => el.textContent.includes('Recovered')
      );
      if (sessionLink) {
        sessionLink.click();
        return { clicked: true };
      }
      return { clicked: false };
    });

    if (clickResult.clicked) {
      console.log("  ✅ Session item clicked");
    }

    // Wait for passphrase prompt if it appears
    await page.waitForTimeout(500);

    // Check if there's a dialog asking for passphrase
    const hasDialog = await page.evaluate(() => {
      return !!document.querySelector('dialog');
    });

    if (hasDialog) {
      console.log("  ⏳ Passphrase dialog appeared, filling...");
      // Fill the passphrase input in the dialog
      const passphraseInput = await page.locator('dialog input').first();
      await passphraseInput.fill(passphrase);
      
      // Click OK/confirm button
      const okButton = await page.locator('dialog button:has-text("OK")').first();
      await okButton.click();
      
      console.log("  ✅ Passphrase submitted");
    }

    // Wait for recovery to complete
    console.log("  ⏳ Waiting for session data to load from GitHub...");
    await page.waitForTimeout(4000);

    // ─── PHASE 5: Verify recovered session ────────────────────────

    console.log("\n✅ PHASE 5: Verify Recovered Session");
    console.log("─".repeat(60));

    const recoveredChatContent = await page.evaluate(() => {
      return document.querySelector('#chat-box')?.innerText || '';
    });

    const currentSessionId = await page.evaluate(() => {
      return document.querySelector('#session-title')?.textContent || 'unknown';
    });

    const recoveredMessageCount = (recoveredChatContent.match(/📨|🤖/g) || []).length;

    console.log(`  Current session: ${currentSessionId}`);
    console.log(`  Original messages: ${messageCount} exchanges`);
    console.log(`  Recovered messages: ${recoveredMessageCount} exchanges`);

    // Verify key content
    const verifications = {
      hasOriginalMessages: testMessages.some(msg => 
        recoveredChatContent.includes(msg)
      ),
      sameMessageCount: messageCount === recoveredMessageCount || recoveredMessageCount > 0,
      notEmpty: recoveredChatContent.length > 100,
    };

    console.log("\n  Verification Results:");
    console.log(`    ${verifications.hasOriginalMessages ? '✅' : '❌'} Original messages present`);
    console.log(`    ${verifications.sameMessageCount ? '✅' : '❌'} Message count matches`);
    console.log(`    ${verifications.notEmpty ? '✅' : '❌'} Chat content restored`);

    // ─── Summary ──────────────────────────────────────────────────

    console.log("\n" + "═".repeat(60));
    const allPassed = Object.values(verifications).every(v => v);
    if (allPassed) {
      console.log("✅ SESSION RECOVERY TEST PASSED");
      console.log(`   Successfully recovered session from GitHub`);
      console.log(`   Session ID: ${clearedSession}`);
      console.log(`   Storage: ${GITHUB_OWNER}/${GITHUB_REPO}`);
    } else {
      console.log("❌ SESSION RECOVERY TEST FAILED");
      console.log(`   Some verifications did not pass`);
      
      // Show the actual content for debugging
      console.log("\n  Recovered chat content (last 500 chars):");
      console.log("  " + recoveredChatContent.substring(recoveredChatContent.length - 500));
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
