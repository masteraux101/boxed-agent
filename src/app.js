/**
 * app.js — Main coordinator: UI interactions, settings, session lifecycle
 */

import { marked } from 'marked';
import hljs from 'highlight.js';
import 'highlight.js/styles/atom-one-dark.css';

import SoulLoader from './soul-loader.js';
import Chat from './chat.js';
import Storage from './storage.js';
import GitHubActions from './github-actions.js';

const App = (() => {
  /* eslint-disable -- keeping original structure */
  // ─── State ─────────────────────────────────────────────────────────
  let passphrase = null;
  let currentSessionId = null;
  let currentSoulName = '';
  let loadedSkillCount = 0;
  let loadedSkills = []; // { url, meta: {name, description}, content } for each loaded skill
  let isStreaming = false;
  let autoSaveTimer = null;
  let baseSoulInstruction = ''; // assembled system instruction (SOUL + Skills)
  let soulOnlyInstruction = ''; // SOUL-only text, used for dynamic skill recomposition

  // ─── Settings helpers ──────────────────────────────────────────────

  const SETTINGS_KEY = 'browseragent_settings';
  const SESSION_CFG_PREFIX = 'browseragent_session_cfg_';

  // Keys that are per-session (each session stores its own independent copy)
  const SESSION_KEYS = ['apiKey', 'model', 'enableSearch', 'enableThinking', 'thinkingBudget', 'includeThoughts', 'soulUrl', 'notionToken', 'corsProxy', 'storageBackend', 'githubToken', 'githubOwner', 'githubRepo', 'githubPath', 'notionStorageToken', 'notionParentPageId', 'actionUseStorage', 'actionBranch', 'actionWorkflow', 'actionArtifactDir', 'actionToken', 'actionOwner', 'actionRepo', 'resendApiKey', 'notifyEmail'];

  // Credential-type keys where empty string should be treated as "not set"
  // so the ?? / fallback logic can reach the next level (global settings).
  const CREDENTIAL_KEYS = new Set(['apiKey', 'githubToken', 'githubOwner', 'githubRepo', 'githubPath', 'notionStorageToken', 'notionParentPageId', 'actionToken', 'actionOwner', 'actionRepo', 'resendApiKey', 'notifyEmail', 'notionToken']);

  /**
   * Read a value from a config object with fallback, treating empty strings
   * as "not set" for credential-type keys.
   */
  function cfgGet(cfg, key, fallback) {
    const val = cfg[key];
    if (val == null) return fallback;
    if (val === '' && CREDENTIAL_KEYS.has(key)) return fallback;
    return val;
  }

  // Built-in SOUL files — loaded dynamically from examples/souls/index.json
  let BUILTIN_SOULS = [];
  let _soulsLoaded = false;

  async function loadBuiltinSouls() {
    if (_soulsLoaded) return;
    try {
      const resp = await fetch('./examples/souls/index.json?_=' + Date.now());
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const list = await resp.json();
      // Pre-fetch each soul file so we don't need a second round-trip later
      const entries = await Promise.all(list.map(async entry => {
        const url = `./examples/souls/${entry.file}`;
        try {
          const r = await fetch(url);
          const content = r.ok ? await r.text() : '';
          return { name: entry.name, url, content };
        } catch {
          return { name: entry.name, url, content: '' };
        }
      }));
      BUILTIN_SOULS = entries;
      _soulsLoaded = true;
    } catch (e) {
      console.warn('[Souls] Failed to load souls index:', e);
      BUILTIN_SOULS = [];
    }
  }

  // Built-in skills bundled with the project (not auto-loaded; managed via /skills)
  const BUILTIN_SKILLS = [
    { name: 'AI Prompt Scheduler', desc: 'Schedule AI prompts and deploy them to GitHub Actions', url: './examples/skills/ai-prompt-scheduler.md' },
    { name: 'Code Review',         desc: 'Systematic code review with actionable feedback',        url: './examples/skills/code-review.md' },
    { name: 'Email (Resend)',       desc: 'Send email notifications via the Resend API',            url: './examples/skills/email-resend.md' },
    { name: 'GitHub Scheduler',    desc: 'Set up scheduled GitHub Actions workflows',               url: './examples/skills/github-scheduler.md' },
    { name: 'Translator',          desc: 'Multi-language translation assistant',                    url: './examples/skills/translator.md' },
  ];

  function getSettings() {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
    } catch {
      return {};
    }
  }

  function saveSettings(s) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }

  function getSetting(key, fallback = '') {
    return getSettings()[key] ?? fallback;
  }

  function setSetting(key, value) {
    const s = getSettings();
    s[key] = value;
    saveSettings(s);
  }

  // ─── Per-Session Settings ──────────────────────────────────────────

  function getSessionConfig(sessionId) {
    try {
      return JSON.parse(localStorage.getItem(SESSION_CFG_PREFIX + sessionId)) || {};
    } catch {
      return {};
    }
  }

  function saveSessionConfig(sessionId, cfg) {
    localStorage.setItem(SESSION_CFG_PREFIX + sessionId, JSON.stringify(cfg));
  }

  function removeSessionConfig(sessionId) {
    localStorage.removeItem(SESSION_CFG_PREFIX + sessionId);
  }

  /**
   * Get a setting for the current session.
   * Falls back to global default if not set per-session.
   */
  function getSessionSetting(key, fallback = '') {
    if (!currentSessionId) return getSetting(key, fallback);
    const cfg = getSessionConfig(currentSessionId);
    const val = cfg[key];
    // For credential keys, treat empty string as "not set" so we fall through to global
    if (val == null || (val === '' && CREDENTIAL_KEYS.has(key))) {
      return getSetting(key, fallback);
    }
    return val;
  }

  function setSessionSetting(key, value) {
    if (!currentSessionId) return;
    const cfg = getSessionConfig(currentSessionId);
    cfg[key] = value;
    saveSessionConfig(currentSessionId, cfg);
  }

  /**
   * Initialize a new session's config by copying current global defaults
   */
  function initSessionConfig(sessionId) {
    const cfg = {};
    for (const key of SESSION_KEYS) {
      const val = getSetting(key);
      if (val !== '' && val != null) {
        cfg[key] = val;
      }
    }
    // Auto-load ai-prompt-scheduler skill for every new session
    cfg.skillUrls = ['./examples/skills/ai-prompt-scheduler.md'];
    saveSessionConfig(sessionId, cfg);
  }

  /**
   * Persist the current loadedSkills URL list into the session config.
   */
  function saveSessionSkills() {
    if (!currentSessionId) return;
    const cfg = getSessionConfig(currentSessionId);
    cfg.skillUrls = loadedSkills.map(s => s.url);
    saveSessionConfig(currentSessionId, cfg);
  }

  /**
   * Restore skills saved in the session config (without triggering another save).
   */
  async function restoreSessionSkills() {
    if (!currentSessionId) return;
    const cfg = getSessionConfig(currentSessionId);
    const urls = cfg.skillUrls || [];
    for (const url of urls) {
      if (loadedSkills.find(s => s.url === url)) continue; // already loaded
      try {
        const raw = await SoulLoader.fetchRawText(url);
        const parsed = SoulLoader.parseSkillFile(raw);
        parsed.url = url;
        loadedSkills.push(parsed);
      } catch (e) {
        console.warn(`[Skills] Failed to restore skill ${url}:`, e);
      }
    }
    applySkillsToInstruction();
  }

  // ─── Marked.js config ─────────────────────────────────────────────

  function configureMarked() {
    marked.setOptions({
      breaks: true,
      gfm: true,
      highlight: function (code, lang) {
        if (lang && hljs.getLanguage(lang)) {
          try {
            return hljs.highlight(code, { language: lang }).value;
          } catch {}
        }
        try {
          return hljs.highlightAuto(code).value;
        } catch {}
        return code;
      },
    });
  }

  // ─── UI Helpers ────────────────────────────────────────────────────

  function $(sel) {
    return document.querySelector(sel);
  }

  function $$(sel) {
    return document.querySelectorAll(sel);
  }

  function show(el) {
    if (typeof el === 'string') el = $(el);
    if (el) el.classList.remove('hidden');
  }

  function hide(el) {
    if (typeof el === 'string') el = $(el);
    if (el) el.classList.add('hidden');
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function renderMarkdown(text) {
    // Pre-process: extract <details> blocks, render their inner markdown separately,
    // then stitch back. This is needed because marked.js treats content inside
    // HTML block tags as raw HTML and skips markdown parsing.
    const detailsRegex = /(<details[\s\S]*?<\/summary>)([\s\S]*?)(<\/details>)/gi;
    const processed = text.replace(detailsRegex, (_, open, inner, close) => {
      const renderedInner = marked.parse(inner.trim());
      return `${open}\n${renderedInner}\n${close}`;
    });
    return marked.parse(processed);
  }

  function scrollToBottom() {
    const chatBox = $('#chat-box');
    if (chatBox) {
      chatBox.scrollTop = chatBox.scrollHeight;
    }
  }

  function showSaveIndicator() {
    let dot = $('#save-indicator');
    if (!dot) {
      dot = document.createElement('span');
      dot.id = 'save-indicator';
      dot.className = 'save-indicator';
      dot.textContent = 'saved';
      const header = $('.header');
      if (header) header.appendChild(dot);
    }
    dot.classList.remove('fade');
    void dot.offsetWidth; // reflow
    dot.classList.add('show');
    clearTimeout(dot._timer);
    dot._timer = setTimeout(() => {
      dot.classList.add('fade');
    }, 1200);
  }

  function showToast(message, type = 'info') {
    const container = $('#toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('toast-fade');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // ─── Message Rendering ────────────────────────────────────────────

  function addMessageBubble(role, content, isHtml = false) {
    const chatBox = $('#chat-box');
    const wrapper = document.createElement('div');
    wrapper.className = `message-wrapper ${role}`;

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = role === 'user' ? '👤' : '🤖';

    const bubble = document.createElement('div');
    bubble.className = `message-bubble ${role}`;
    if (isHtml) {
      bubble.innerHTML = content;
    } else {
      bubble.innerHTML = renderMarkdown(content);
    }

    wrapper.appendChild(avatar);
    wrapper.appendChild(bubble);
    chatBox.appendChild(wrapper);
    scrollToBottom();

    // Highlight code blocks
    bubble.querySelectorAll('pre code').forEach((block) => {
      hljs.highlightElement(block);
    });

    // Add artifact toolbars for model messages
    if (role === 'model' && !isHtml) {
      // Check for DEPLOY_BUNDLE format first — render compact card
      if (hasDeployBundle(content)) {
        renderDeployBundleCard(bubble, content);
      } else {
        addCodeBlockToolbars(bubble, content);
      }
    }

    return bubble;
  }

  function addErrorBubble(message) {
    const chatBox = $('#chat-box');
    const wrapper = document.createElement('div');
    wrapper.className = 'message-wrapper model';

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = '⚠️';

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble error-bubble';
    // Show each line of the error message (hint \n details)
    const lines = message.split('\n');
    bubble.innerHTML = lines.map((l, i) =>
      i === 0
        ? `<strong>${escapeHtml(l)}</strong>`
        : `<span class="error-detail">${escapeHtml(l)}</span>`
    ).join('<br>');

    wrapper.appendChild(avatar);
    wrapper.appendChild(bubble);
    chatBox.appendChild(wrapper);
    scrollToBottom();
  }

  function createStreamingBubble() {
    const chatBox = $('#chat-box');
    const wrapper = document.createElement('div');
    wrapper.className = 'message-wrapper model';
    wrapper.id = 'streaming-wrapper';

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = '🤖';

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble model streaming';
    bubble.id = 'streaming-bubble';
    bubble.innerHTML = '<span class="cursor-blink">▊</span>';

    wrapper.appendChild(avatar);
    wrapper.appendChild(bubble);
    chatBox.appendChild(wrapper);
    scrollToBottom();
    return bubble;
  }

  function finalizeStreamingBubble(fullText) {
    const bubble = $('#streaming-bubble');
    if (!bubble) return;

    bubble.classList.remove('streaming');
    bubble.removeAttribute('id');

    const wrapper = $('#streaming-wrapper');
    if (wrapper) wrapper.removeAttribute('id');

    // Check for DEPLOY_BUNDLE format — render compact card instead of verbose markdown
    if (hasDeployBundle(fullText)) {
      bubble.innerHTML = renderMarkdown(fullText);
      renderDeployBundleCard(bubble, fullText);
    } else {
      bubble.innerHTML = renderMarkdown(fullText);

      // Highlight code blocks
      bubble.querySelectorAll('pre code').forEach((block) => {
        hljs.highlightElement(block);
      });

      // Add artifact toolbars (Push / Run buttons)
      addCodeBlockToolbars(bubble, fullText);
    }

    scrollToBottom();
  }

  // ─── Session Management ────────────────────────────────────────────

  function generateTitle(message) {
    return message.slice(0, 40).replace(/\n/g, ' ') + (message.length > 40 ? '…' : '');
  }

  function getCurrentSessionData() {
    const messages = Chat.getHistory().map((h, i) => ({
      role: h.role,
      content: h.parts?.[0]?.text || '',
      ts: new Date().toISOString(),
    }));

    return {
      id: currentSessionId,
      title: messages[0]?.content
        ? generateTitle(messages[0].content)
        : 'Empty Session',
      soulName: currentSoulName,
      backend: getSessionSetting('storageBackend', 'local'),
      createdAt:
        Storage.getIndex().find((s) => s.id === currentSessionId)?.createdAt ||
        new Date().toISOString(),
      messages,
    };
  }

  async function saveCurrentSession() {
    if (!currentSessionId) return;
    const history = Chat.getHistory();
    if (history.length === 0) return;

    // Recover passphrase from session config if not in memory
    if (!passphrase) {
      const cfg = getSessionConfig(currentSessionId);
      if (cfg.passphrase) {
        passphrase = cfg.passphrase;
      } else {
        // Cannot save without passphrase — should not happen if setup was correct
        console.warn('No passphrase set, cannot save session');
        return;
      }
    }

    const data = getCurrentSessionData();
    const backend = getSessionSetting('storageBackend', 'local');

    try {
      if (backend === 'github') {
        const config = {
          token: getSessionSetting('githubToken'),
          owner: getSessionSetting('githubOwner'),
          repo: getSessionSetting('githubRepo'),
          path: getSessionSetting('githubPath', 'sessions'),
        };
        if (!config.token || !config.owner || !config.repo) {
          // Credentials incomplete — fall back to local save so data is not lost
          console.warn('[Save] GitHub credentials incomplete, falling back to local. session=', currentSessionId,
            'token?', !!config.token, 'owner?', !!config.owner, 'repo?', !!config.repo);
          await Storage.Local.save(data, passphrase);
          showToast('GitHub credentials missing — saved locally. Open session settings to fix.', 'warn');
          showSaveIndicator();
          return;
        }
        await Storage.GitHub.save(data, passphrase, config);
      } else if (backend === 'notion') {
        const config = {
          token: getSessionSetting('notionStorageToken'),
          parentPageId: getSessionSetting('notionParentPageId'),
          corsProxy: getSessionSetting('corsProxy'),
        };
        if (!config.token || !config.parentPageId) {
          console.warn('[Save] Notion credentials incomplete, falling back to local. session=', currentSessionId);
          await Storage.Local.save(data, passphrase);
          showToast('Notion credentials missing — saved locally. Open session settings to fix.', 'warn');
          showSaveIndicator();
          return;
        }
        await Storage.Notion.save(data, passphrase, config);
      } else {
        await Storage.Local.save(data, passphrase);
      }
      showSaveIndicator();
    } catch (err) {
      console.error('Auto-save failed:', err);
      // If encryption/save failed, clear passphrase so next save re-prompts
      const isDecryptError = /decrypt|cipher|tag|operation/i.test(err.message);
      if (isDecryptError) passphrase = null;
      showToast(`Save failed: ${err.message}`, 'error');
    }
  }

  async function loadSession(sessionId) {
    const entry = Storage.getIndex().find((s) => s.id === sessionId);
    const loadCfg = getSessionConfig(sessionId);
    const loadGet = (key, fb) => cfgGet(loadCfg, key, getSetting(key, fb));
    const backend = entry?.backend || loadGet('storageBackend', 'local');

    // Always prompt passphrase via dialog for loading
    const pass = await promptPassphrase('Enter the passphrase to decrypt this session:');
    if (!pass) return; // user cancelled

    try {
      let data;
      if (backend === 'github') {
        const config = {
          token: loadGet('githubToken', ''),
          owner: loadGet('githubOwner', ''),
          repo: loadGet('githubRepo', ''),
          path: loadGet('githubPath', 'sessions'),
        };
        data = await Storage.GitHub.load(sessionId, pass, config);
      } else if (backend === 'notion') {
        const config = {
          token: loadGet('notionStorageToken', ''),
          parentPageId: loadGet('notionParentPageId', ''),
          corsProxy: loadGet('corsProxy', ''),
        };
        data = await Storage.Notion.load(sessionId, pass, config);
      } else {
        data = await Storage.Local.load(sessionId, pass);
      }

      // Success — store passphrase in memory + config for future saves
      passphrase = pass;
      const cfg = getSessionConfig(sessionId);
      cfg.passphrase = pass;
      saveSessionConfig(sessionId, cfg);

      // Reset SOUL / skills in-memory state before restoring for this session
      loadedSkills = [];
      loadedSkillCount = 0;
      currentSoulName = '';
      soulOnlyInstruction = '';
      baseSoulInstruction = '';

      currentSessionId = data.id;
      currentSoulName = data.soulName || '';

      // Sync metadata back to index (restores title after GitHub restore)
      const indexEntry = Storage.getIndex().find(s => s.id === sessionId);
      if (indexEntry) {
        indexEntry.title = data.title || indexEntry.title;
        indexEntry.soulName = data.soulName || indexEntry.soulName || '';
        indexEntry.updatedAt = data.updatedAt || indexEntry.updatedAt;
        indexEntry.createdAt = data.createdAt || indexEntry.createdAt;
        const fullIndex = Storage.getIndex().map(s => s.id === sessionId ? indexEntry : s);
        Storage.saveIndex(fullIndex);
        renderSidebar();
      }

      const history = data.messages.map((m) => ({
        role: m.role,
        parts: [{ text: m.content }],
      }));
      Chat.setHistory(history);

      $('#chat-box').innerHTML = '';
      for (const msg of data.messages) {
        addMessageBubble(msg.role === 'model' ? 'model' : 'user', msg.content);
      }

      setInputEnabled(true);
      show('#token-display');
      updateSidebarActive(sessionId);

      // Restore SOUL + skills for this session
      await loadSoulAndSkills();
    } catch (err) {
      console.error('Load failed:', err);
      const isDecryptError = /decrypt|cipher|tag|operation/i.test(err.message);
      if (isDecryptError) {
        showToast('Decryption failed — wrong passphrase', 'error');
      } else {
        showToast(`Load failed: ${err.message}`, 'error');
      }
      passphrase = null;
    }
  }

  async function activateSession(sessionId, newPassphrase = null) {
    currentSessionId = sessionId;
    passphrase = newPassphrase;
    loadedSkills = [];
    loadedSkillCount = 0;
    currentSoulName = '';        // reset immediately so /soul shows correct state
    soulOnlyInstruction = '';
    baseSoulInstruction = '';
    Chat.clearHistory();
    Chat.resetTokenUsage();
    $('#chat-box').innerHTML = '';
    setInputEnabled(true);
    show('#token-display');
    showWelcome();
    updateSidebarActive(null);
    updateTokenDisplay();

    // Load SOUL and restore skills
    await loadSoulAndSkills();
  }

  function startNewSession() {
    const id = Storage.uuid();
    initSessionConfig(id);
    activateSession(id);
  }

  // ─── Sidebar ───────────────────────────────────────────────────────

  function renderSidebar() {
    const list = $('#session-list');
    const index = Storage.getIndex();
    list.innerHTML = '';

    if (index.length === 0) {
      list.innerHTML =
        '<div class="session-empty">No saved sessions</div>';
      return;
    }

    for (const entry of index) {
      const item = document.createElement('div');
      item.className = `session-item ${
        entry.id === currentSessionId ? 'active' : ''
      }`;
      item.dataset.id = entry.id;

      const title = document.createElement('div');
      title.className = 'session-title';
      title.textContent = entry.title || 'Untitled';

      const meta = document.createElement('div');
      meta.className = 'session-meta';
      const date = new Date(entry.updatedAt || entry.createdAt);
      const backendLabel = { github: '☁ GitHub', notion: '📓 Notion', local: '💾 Local' }[entry.backend || 'local'] || '💾 Local';
      meta.innerHTML = `<span class="session-backend-badge backend-${entry.backend || 'local'}">${backendLabel}</span> · ${entry.soulName ? entry.soulName + ' · ' : ''}${date.toLocaleDateString()}`;

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'session-delete';
      deleteBtn.textContent = '×';
      deleteBtn.title = 'Delete session';
      deleteBtn.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm('Delete this session?')) return;
        try {
          const backend = entry.backend || 'local';
          const delCfg = getSessionConfig(entry.id);
          const delGet = (key, fb) => cfgGet(delCfg, key, getSetting(key, fb));
          if (backend === 'github') {
            await Storage.GitHub.remove(entry.id, {
              token: delGet('githubToken', ''),
              owner: delGet('githubOwner', ''),
              repo: delGet('githubRepo', ''),
              path: delGet('githubPath', 'sessions'),
            });
          } else if (backend === 'notion') {
            await Storage.Notion.remove(entry.id, {
              token: delGet('notionStorageToken', ''),
              parentPageId: delGet('notionParentPageId', ''),
              corsProxy: delGet('corsProxy', ''),
            });
          } else {
            await Storage.Local.remove(entry.id);
          }
          removeSessionConfig(entry.id);
          renderSidebar();
          if (entry.id === currentSessionId) startNewSession();
          showToast('Session deleted', 'success');
        } catch (err) {
          showToast(`Delete failed: ${err.message}`, 'error');
        }
      };

      const settingsBtn = document.createElement('button');
      settingsBtn.className = 'session-settings-btn';
      settingsBtn.textContent = '⚙';
      settingsBtn.title = 'Session settings';
      settingsBtn.onclick = (e) => {
        e.stopPropagation();
        openSettings(entry.id);
      };

      const actions = document.createElement('div');
      actions.className = 'session-actions';
      actions.appendChild(settingsBtn);
      actions.appendChild(deleteBtn);

      item.appendChild(title);
      item.appendChild(meta);
      item.appendChild(actions);
      item.onclick = () => {
        if (entry.id === currentSessionId) return; // already active
        loadSession(entry.id);
      };
      list.appendChild(item);
    }
  }

  function updateSidebarActive(id) {
    $$('.session-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.id === id);
    });
  }

  // ─── Welcome Screen ───────────────────────────────────────────────

  function showLanding() {
    const chatBox = $('#chat-box');
    chatBox.innerHTML = `
      <div class="welcome-screen">
        <div class="welcome-logo">🧠</div>
        <h2>BrowserAgent</h2>
        <p>A fully browser-based AI workbench powered by the Gemini API.</p>
        <div class="landing-features">
          <div class="landing-feature">
            <strong>🔒 Private & Secure</strong>
            <span>Everything runs in your browser. No server, no tracking. Sessions are AES-256 encrypted.</span>
          </div>
          <div class="landing-feature">
            <strong>🧩 SOUL & Skills</strong>
            <span>Load personality files (SOUL.md) and modular skill prompts from GitHub or Notion.</span>
          </div>
          <div class="landing-feature">
            <strong>☁️ Flexible Storage</strong>
            <span>Save encrypted sessions to localStorage, GitHub, or Notion.</span>
          </div>
          <div class="landing-feature">
            <strong>🔍 Grounding & Thinking</strong>
            <span>Google Search grounding and thinking mode for deeper reasoning.</span>
          </div>
          <div class="landing-feature">
            <strong>⚡ GitHub Actions</strong>
            <span>Push AI-generated code to GitHub and execute it via Actions workflows.</span>
          </div>
        </div>
        <p class="landing-cta">Click <strong>+</strong> in the sidebar to start a new session.</p>
      </div>
    `;
  }

  function showWelcome() {
    const chatBox = $('#chat-box');
    chatBox.innerHTML = `
      <div class="welcome-screen">
        <div class="welcome-logo">🧠</div>
        <h2>BrowserAgent</h2>
        <p>Your personal AI assistant, fully in-browser.</p>
        <div class="welcome-status">
          <span id="soul-status" class="status-badge">No SOUL loaded</span>
          <span id="skill-status" class="status-badge">0 Skills</span>
        </div>
        <div class="welcome-hints">
          <p>Type a message below to start chatting.</p>
          <code>/clear</code> Clear history &nbsp;
          <code>/compact</code> Compress context &nbsp;
          <code>/soul</code> SOUL info &nbsp;
          <code>/skills</code> List skills &nbsp;
        </div>
      </div>
    `;
    updateSoulStatus();
  }

  function updateSoulStatus() {
    const soulBadge = $('#soul-status');
    const skillBadge = $('#skill-status');
    const headerSoul = $('#header-soul-name');

    if (soulBadge) {
      soulBadge.textContent = currentSoulName
        ? `SOUL: ${currentSoulName}`
        : 'No SOUL loaded';
      soulBadge.className = `status-badge ${currentSoulName ? 'active' : ''}`;
    }
    if (skillBadge) {
      skillBadge.textContent = `${loadedSkillCount} Skill${loadedSkillCount !== 1 ? 's' : ''}`;
      skillBadge.className = `status-badge ${loadedSkillCount > 0 ? 'active clickable' : ''}`;
      skillBadge.title = loadedSkillCount > 0
        ? loadedSkills.map(s => s.meta.name).join(', ')
        : '';
      // Wire click to show skills popover (idempotent)
      skillBadge.onclick = loadedSkillCount > 0 ? toggleSkillsPopover : null;
    }
    if (headerSoul) {
      headerSoul.textContent = currentSoulName || 'BrowserAgent';
    }
  }

  function toggleSkillsPopover() {
    let popover = $('#skills-popover');
    if (popover) { popover.remove(); return; }

    popover = document.createElement('div');
    popover.id = 'skills-popover';
    popover.className = 'skills-popover';
    popover.innerHTML = `
      <div class="skills-popover-header">
        <span>🧩 Loaded Skills</span>
        <button class="skills-popover-close" onclick="document.getElementById('skills-popover')?.remove()">✕</button>
      </div>
      ${
        loadedSkills.map(s => `
          <div class="skill-card">
            <div class="skill-card-name">${escapeHtml(s.meta.name || 'Unnamed')}</div>
            ${s.meta.description ? `<div class="skill-card-desc">${escapeHtml(s.meta.description)}</div>` : ''}
          </div>
        `).join('')
      }
    `;

    const badge = $('#skill-status');
    const parent = badge?.closest('.welcome-status') || badge?.parentElement || $('#chat-box');
    parent?.appendChild(popover);

    // Close on outside click
    setTimeout(() => {
      document.addEventListener('click', function handler(e) {
        if (!popover.contains(e.target) && e.target !== badge) {
          popover.remove();
          document.removeEventListener('click', handler);
        }
      });
    }, 10);
  }

  // ─── Slash Commands ────────────────────────────────────────────────

  const SLASH_COMMANDS = [
    { cmd: '/github status', desc: '列出仓库、所有 Workflow 及正在运行的任务' },
    { cmd: '/github run',    desc: '立刻触发（workflow_dispatch）指定的 Workflow' },
    { cmd: '/github delete', desc: '删除指定的 Workflow 文件' },
    { cmd: '/skills',        desc: '管理 Skills：加载、卸载内置或自定义 Skill' },
    { cmd: '/soul',          desc: '显示当前 SOUL 名称和 URL' },
    { cmd: '/compact',       desc: '压缩对话历史，生成摘要以释放上下文' },
    { cmd: '/clear',         desc: '清空当前会话的所有消息（含存储）' },
  ];

  let _slashSelectedIdx = -1;

  function slashAutocompleteShow(items) {
    const el = $('#slash-autocomplete');
    if (!el) return;
    el.innerHTML = items.map((item, i) =>
      `<div class="slash-cmd-item${i === _slashSelectedIdx ? ' active' : ''}" data-idx="${i}">
        <span class="slash-cmd-name">${item.cmd}</span>
        <span class="slash-cmd-desc">${item.desc}</span>
      </div>`
    ).join('');
    el.querySelectorAll('.slash-cmd-item').forEach(row => {
      row.addEventListener('mousedown', (e) => {
        e.preventDefault(); // don't blur textarea
        const idx = parseInt(row.dataset.idx);
        _slashSelectedIdx = idx;
        slashAutocompleteConfirm();
      });
    });
    el.classList.remove('hidden');
  }

  function slashAutocompleteHide() {
    const el = $('#slash-autocomplete');
    if (el) el.classList.add('hidden');
    _slashSelectedIdx = -1;
  }

  function slashAutocompleteActiveIndex() { return _slashSelectedIdx; }

  function slashAutocompleteMoveSelection(delta) {
    const el = $('#slash-autocomplete');
    if (!el) return;
    const items = el.querySelectorAll('.slash-cmd-item');
    if (!items.length) return;
    _slashSelectedIdx = (_slashSelectedIdx + delta + items.length) % items.length;
    items.forEach((row, i) => row.classList.toggle('active', i === _slashSelectedIdx));
    items[_slashSelectedIdx]?.scrollIntoView({ block: 'nearest' });
  }

  function slashAutocompleteConfirm() {
    const el = $('#slash-autocomplete');
    if (!el) return;
    const items = el.querySelectorAll('.slash-cmd-item');
    const idx = _slashSelectedIdx >= 0 ? _slashSelectedIdx : 0;
    const target = items[idx];
    if (!target) return;
    const cmdText = target.querySelector('.slash-cmd-name').textContent;
    const input = $('#message-input');
    input.value = cmdText;
    input.focus();
    // Place cursor at end
    input.setSelectionRange(cmdText.length, cmdText.length);
    slashAutocompleteHide();
    autoResizeInput();
  }

  function slashAutocompleteUpdate() {
    const input = $('#message-input');
    const val = input?.value || '';
    if (!val.startsWith('/')) { slashAutocompleteHide(); return; }
    const q = val.toLowerCase();
    const matches = SLASH_COMMANDS.filter(c => c.cmd.startsWith(q));
    if (!matches.length || (matches.length === 1 && matches[0].cmd === q)) {
      slashAutocompleteHide(); return;
    }
    _slashSelectedIdx = -1;
    slashAutocompleteShow(matches);
  }

  async function handleSlashCommand(text) {
    const cmd = text.trim().toLowerCase();

    if (cmd === '/clear') {
      if (!currentSessionId) { showToast('No active session', 'info'); return true; }
      if (!confirm('清空当前会话的所有消息？此操作不可撤销。')) return true;

      const clearSessionId = currentSessionId;
      const entry = Storage.getIndex().find(s => s.id === clearSessionId);

      // Read config BEFORE resetting currentSessionId
      const clearCfg = getSessionConfig(clearSessionId);
      const clearGet = (key, fb) => cfgGet(clearCfg, key, getSetting(key, fb));
      const clearBackend = entry?.backend || clearGet('storageBackend', 'local');

      // Reset to no-session state immediately
      Chat.clearHistory();
      Chat.resetTokenUsage();
      removeSessionConfig(clearSessionId);
      currentSessionId = null;
      setInputEnabled(false);
      hide('#token-display');
      showLanding();
      updateSidebarActive(null);

      // Delete from storage in the background
      if (entry) {
        const backend = clearBackend;
        (async () => {
          try {
            if (backend === 'github') {
              await Storage.GitHub.remove(clearSessionId, {
                token: clearGet('githubToken', ''),
                owner: clearGet('githubOwner', ''),
                repo: clearGet('githubRepo', ''),
                path: clearGet('githubPath', 'sessions'),
              });
            } else if (backend === 'notion') {
              await Storage.Notion.remove(clearSessionId, {
                token: clearGet('notionStorageToken', ''),
                parentPageId: clearGet('notionParentPageId', ''),
                corsProxy: clearGet('corsProxy', ''),
              });
            } else {
              await Storage.Local.remove(clearSessionId);
            }
            renderSidebar();
            showToast('会话已清空', 'success');
          } catch (err) {
            renderSidebar();
            showToast(`清空存储失败: ${err.message}`, 'error');
          }
        })();
      } else {
        renderSidebar();
        showToast('会话已清空', 'success');
      }
      return true;
    }

    if (cmd === '/compact') {
      const apiKey = getSessionSetting('apiKey');
      const model = getSessionSetting('model');
      if (!apiKey) {
        showToast('Set API key first', 'error');
        return true;
      }
      if (!model) {
        showToast('Please set a model in session settings', 'error');
        return true;
      }
      addMessageBubble('user', '/compact');
      try {
        const summary = await Chat.compactHistory(apiKey, model);
        addMessageBubble(
          'model',
          '**Context compacted.** Summary:\n\n' + summary
        );
        showToast('History compacted', 'success');
      } catch (err) {
        showToast(`Compact failed: ${err.message}`, 'error');
      }
      return true;
    }

    // Handle /soul <name> to switch SOUL
    if (text.trim().toLowerCase().startsWith('/soul ')) {
      const soulName = text.trim().slice(6).trim();
      addMessageBubble('user', text.trim());
      
      const soul = BUILTIN_SOULS.find(s => 
        s.name.toLowerCase() === soulName.toLowerCase()
      );
      
      if (!soul) {
        addMessageBubble('model', `❌ SOUL not found: "${soulName}". Available: ${BUILTIN_SOULS.map(s => s.name).join(', ')}`);
        return true;
      }
      
      (async () => {
        try {
          const bubble = addMessageBubble('model', `⏳ Loading SOUL: **${soulName}**…`);
          
          // Update session config with new soul URL
          const cfg = getSessionConfig(currentSessionId);
          cfg.soulUrl = soul.url;
          saveSessionConfig(currentSessionId, cfg);
          
          // Load the new soul
          await loadSoulAndSkills();
          bubble.innerHTML = renderMarkdown(`✅ Switched to SOUL: **${currentSoulName}** (${loadedSkillCount} skill(s) loaded)`);
        } catch (err) {
          addMessageBubble('model', `❌ Failed to load SOUL: ${err.message}`);
        }
      })();
      
      return true;
    }

    if (cmd === '/soul') {
      const soulUrl = getSessionSetting('soulUrl');
      addMessageBubble('user', '/soul');
      addMessageBubble(
        'model',
        `**Current SOUL:** ${currentSoulName || 'None'}\n**URL:** ${soulUrl || 'Not set'}\n**Skills loaded:** ${loadedSkillCount}`
      );
      return true;
    }

    // Handle /skill <name> to load a skill
    if (text.trim().toLowerCase().startsWith('/skill ')) {
      const skillName = text.trim().slice(7).trim();
      addMessageBubble('user', text.trim());
      
      const skill = BUILTIN_SKILLS.find(s => 
        s.name.toLowerCase() === skillName.toLowerCase() ||
        s.url.toLowerCase().includes(skillName.toLowerCase())
      );
      
      if (!skill) {
        const available = BUILTIN_SKILLS.map(s => s.name).join(', ');
        addMessageBubble('model', `❌ Skill not found: "${skillName}". Available: ${available}`);
        return true;
      }
      
      (async () => {
        try {
          const bubble = addMessageBubble('model', `⏳ Loading skill: **${skill.name}**…`);
          const parsed = await loadSkillFromUrl(skill.url);
          bubble.innerHTML = renderMarkdown(`✅ Loaded skill: **${parsed.meta?.name || skill.name}**\n\n${parsed.meta?.description || ''}`);
        } catch (err) {
          addMessageBubble('model', `❌ Failed to load skill: ${err.message}`);
        }
      })();
      
      return true;
    }

    if (cmd === '/skills') {
      addMessageBubble('user', '/skills');
      const bubble = addMessageBubble('model', '');

      const renderSkillPanel = () => {
        const builtinRows = BUILTIN_SKILLS.map(bs => {
          const isLoaded = !!loadedSkills.find(s => s.url === bs.url);
          return `<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);">
            <div style="flex:1;">
              <span style="font-weight:600;font-size:13px;">${escapeHtml(bs.name)}</span>
              <div style="font-size:12px;opacity:.7;">${escapeHtml(bs.desc)}</div>
            </div>
            <button class="gh-skill-toggle-btn" data-url="${escapeHtml(bs.url)}" data-loaded="${isLoaded ? '1' : '0'}"
              style="background:${isLoaded ? '#555' : 'var(--accent)'};color:#fff;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:12px;min-width:58px;">
              ${isLoaded ? '卸载' : '加载'}
            </button>
          </div>`;
        }).join('');

        const customLoaded = loadedSkills.filter(s => !BUILTIN_SKILLS.find(b => b.url === s.url));
        const customSection = customLoaded.length ? `
          <div style="font-weight:600;margin:12px 0 6px;font-size:13px;">🌐 自定义 Skills</div>
          ${customLoaded.map(s => `
            <div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);">
              <div style="flex:1;font-size:12px;">
                <span style="font-weight:600;">${escapeHtml(s.meta?.name || 'Unnamed')}</span>
                <div style="opacity:.6;word-break:break-all;">${escapeHtml(s.url)}</div>
              </div>
              <button class="gh-skill-unload-btn" data-url="${escapeHtml(s.url)}"
                style="background:#555;color:#fff;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:12px;">
                卸载
              </button>
            </div>
          `).join('')}
        ` : '';

        return `
          <div style="font-weight:600;margin-bottom:10px;font-size:14px;">🧩 Skills 管理</div>
          <div style="font-weight:600;margin-bottom:6px;font-size:12px;text-transform:uppercase;opacity:.6;letter-spacing:.05em;">📦 内置 Skills</div>
          ${builtinRows}
          ${customSection}
          <div style="margin-top:12px;display:flex;gap:6px;align-items:center;">
            <input id="skill-add-url" type="url" placeholder="添加自定义 Skill URL…"
              style="flex:1;padding:5px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg-input,#1e1e1e);color:inherit;font-size:12px;" />
            <button id="skill-add-btn"
              style="background:var(--accent);color:#fff;border:none;padding:5px 14px;border-radius:4px;cursor:pointer;font-size:12px;white-space:nowrap;">
              添加
            </button>
          </div>
        `;
      };

      bubble.innerHTML = renderSkillPanel();

      const wireButtons = () => {
        bubble.querySelectorAll('.gh-skill-toggle-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const url = btn.dataset.url;
            if (btn.dataset.loaded === '1') {
              unloadSkill(url);
              bubble.innerHTML = renderSkillPanel();
              wireButtons();
              showToast('Skill 已卸载', 'info');
            } else {
              btn.disabled = true;
              btn.textContent = '加载中…';
              try {
                const parsed = await loadSkillFromUrl(url);
                bubble.innerHTML = renderSkillPanel();
                wireButtons();
                showToast(`"${parsed.meta.name}" 已加载`, 'success');
              } catch (e) {
                btn.disabled = false;
                btn.textContent = '加载';
                showToast(`加载失败: ${e.message}`, 'error');
              }
            }
          });
        });

        bubble.querySelectorAll('.gh-skill-unload-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            unloadSkill(btn.dataset.url);
            bubble.innerHTML = renderSkillPanel();
            wireButtons();
            showToast('Skill 已卸载', 'info');
          });
        });

        const addBtn = bubble.querySelector('#skill-add-btn');
        const addInput = bubble.querySelector('#skill-add-url');
        if (addBtn && addInput) {
          addBtn.addEventListener('click', async () => {
            const url = addInput.value.trim();
            if (!url) return;
            addBtn.disabled = true;
            addBtn.textContent = '加载中…';
            try {
              const parsed = await loadSkillFromUrl(url);
              bubble.innerHTML = renderSkillPanel();
              wireButtons();
              showToast(`"${parsed.meta.name}" 已加载`, 'success');
            } catch (e) {
              addBtn.disabled = false;
              addBtn.textContent = '添加';
              showToast(`加载失败: ${e.message}`, 'error');
            }
          });
          addInput.addEventListener('keydown', e => { if (e.key === 'Enter') addBtn.click(); });
        }
      };
      wireButtons();
      return true;
    }

    if (cmd === '/github status' || cmd === '/github') {
      addMessageBubble('user', text.trim());
      let config;
      try {
        config = getActionConfig();
      } catch (e) {
        addMessageBubble('model', `⚠️ ${e.message}`);
        return true;
      }

      const loadingBubble = addMessageBubble('model', '_Fetching GitHub status…_');

      try {
        const [workflows, activeRuns, recentRuns] = await Promise.all([
          GitHubActions.listWorkflows(config),
          GitHubActions.listRecentRuns(config, 'in_progress', 20),
          GitHubActions.listRecentRuns(config, null, 15),
        ]);

        // Build status output
        const lines = [];
        lines.push(`## 📦 \`${config.owner}/${config.repo}\``);
        lines.push('');

        // Active runs
        const queued = await GitHubActions.listRecentRuns(config, 'queued', 10);
        const running = [...activeRuns, ...queued];
        if (running.length > 0) {
          lines.push('### ⚡ Active Runs');
          for (const run of running) {
            const trigger = run.event === 'schedule' ? '🕐 cron' : run.event === 'workflow_dispatch' ? '▶️ manual' : run.event;
            const elapsed = Math.round((Date.now() - new Date(run.run_started_at).getTime()) / 1000);
            lines.push(`- **${run.name}** — ${run.status} · ${trigger} · ${elapsed}s ago · [View](${run.html_url})`);
          }
          lines.push('');
        }

        // Workflows list
        if (workflows.length > 0) {
          lines.push('### 📋 Workflows');
          for (const wf of workflows) {
            const stateIcon = wf.state === 'active' ? '✅' : '⏸️';
            // Find most recent run for this workflow
            const lastRun = recentRuns.find(r => r.workflow_id === wf.id);
            let lastStatus = '';
            if (lastRun) {
              const icon = lastRun.conclusion === 'success' ? '✅' : lastRun.conclusion === 'failure' ? '❌' : lastRun.status === 'in_progress' ? '⏳' : '⚪';
              const age = Math.round((Date.now() - new Date(lastRun.created_at).getTime()) / 60000);
              lastStatus = ` · last: ${icon} ${age}m ago`;
            }
            lines.push(`- ${stateIcon} **${wf.name}** \`${wf.path.replace('.github/workflows/', '')}\`${lastStatus}`);
          }
        } else {
          lines.push('_No workflows found in this repo._');
        }

        lines.push('');
        lines.push(`_[Open Actions →](https://github.com/${config.owner}/${config.repo}/actions)_`);

        // Replace loading bubble
        if (loadingBubble) {
          loadingBubble.innerHTML = renderMarkdown(lines.join('\n'));
          loadingBubble.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
          scrollToBottom();
        }
      } catch (err) {
        if (loadingBubble) {
          loadingBubble.innerHTML = renderMarkdown(`❌ Failed to fetch GitHub status: ${err.message}`);
        }
      }
      return true;
    }

    if (cmd.startsWith('/github run')) {
      addMessageBubble('user', text.trim());
      let config;
      try { config = getActionConfig(); }
      catch (e) { addMessageBubble('model', `⚠️ ${e.message}`); return true; }

      const argPart = text.trim().slice('/github run'.length).trim();

      if (argPart) {
        // Direct dispatch: /github run some-workflow.yml
        const workflowFile = argPart.includes('/') ? argPart.split('/').pop() : argPart;
        const bubble = addMessageBubble('model', `_Dispatching \`${workflowFile}\`…_`);
        try {
          await GitHubActions.dispatchWorkflow(config, workflowFile, {});
          bubble.innerHTML = renderMarkdown(`✅ \`${workflowFile}\` 已触发，稍后可用 \`/github status\` 查看运行状态。`);
        } catch (e) {
          bubble.innerHTML = renderMarkdown(`❌ ${e.message}`);
        }
        return true;
      }

      // No arg: list workflows with ▶️ run buttons
      const runBubble = addMessageBubble('model', '_Loading workflows…_');
      try {
        const workflows = await GitHubActions.listWorkflows(config);
        if (!workflows.length) {
          runBubble.innerHTML = renderMarkdown('_No workflows found._');
          return true;
        }
        const header = `<div style="font-weight:600;margin-bottom:8px;">▶️ 选择要立刻执行的 Workflow：</div>`;
        const rows = workflows.map(wf => {
          const file = wf.path.replace('.github/workflows/', '');
          const stateIcon = wf.state === 'active' ? '✅' : '⏸️';
          return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);">
            <span style="flex:1;font-size:13px;">${stateIcon} <strong>${escapeHtml(wf.name)}</strong> <code style="font-size:11px;opacity:.7;">${escapeHtml(file)}</code></span>
            <button class="gh-run-wf-btn" data-file="${escapeHtml(file)}" data-name="${escapeHtml(wf.name)}"
              style="background:var(--accent);color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px;">
              执行
            </button>
          </div>`;
        }).join('');
        runBubble.innerHTML = header + rows;

        runBubble.querySelectorAll('.gh-run-wf-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const file = btn.dataset.file;
            const name = btn.dataset.name;
            btn.disabled = true;
            btn.textContent = '触发中…';
            try {
              await GitHubActions.dispatchWorkflow(config, file, {});
              btn.textContent = '✅ 已触发';
              btn.style.background = '#27ae60';
              showToast(`"${name}" 已触发`, 'success');
            } catch (e) {
              btn.disabled = false;
              btn.textContent = '执行';
              showToast(`触发失败: ${e.message}`, 'error');
            }
          });
        });
      } catch (e) {
        runBubble.innerHTML = renderMarkdown(`❌ ${e.message}`);
      }
      return true;
    }

    if (cmd.startsWith('/github delete')) {
      addMessageBubble('user', text.trim());
      let config;
      try { config = getActionConfig(); }
      catch (e) { addMessageBubble('model', `⚠️ ${e.message}`); return true; }

      const argPart = text.trim().slice('/github delete'.length).trim();

      if (argPart) {
        // Direct delete: /github delete some-workflow.yml
        const filePath = argPart.includes('/') ? argPart : `.github/workflows/${argPart}`;
        if (!confirm(`删除 ${filePath}？此操作不可撤销。`)) {
          addMessageBubble('model', '_已取消。_');
          return true;
        }
        const bubble = addMessageBubble('model', `_Deleting \`${filePath}\`…_`);
        try {
          await GitHubActions.deleteFile(config, filePath);
          bubble.innerHTML = renderMarkdown(`✅ \`${filePath}\` 已删除。`);
        } catch (e) {
          bubble.innerHTML = renderMarkdown(`❌ ${e.message}`);
        }
        return true;
      }

      // No arg: list workflows and render interactive picker
      const bubble = addMessageBubble('model', '_Loading workflows…_');
      try {
        const workflows = await GitHubActions.listWorkflows(config);
        if (!workflows.length) {
          bubble.innerHTML = renderMarkdown('_No workflows found._');
          return true;
        }
        const header = `<div style="font-weight:600;margin-bottom:8px;">🗑️ 选择要删除的 Workflow：</div>`;
        const rows = workflows.map(wf => {
          const file = wf.path.replace('.github/workflows/', '');
          const stateIcon = wf.state === 'active' ? '✅' : '⏸️';
          return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);">
            <span style="flex:1;font-size:13px;">${stateIcon} <strong>${wf.name}</strong> <code style="font-size:11px;opacity:.7;">${file}</code></span>
            <button class="gh-delete-wf-btn" data-path="${wf.path}" data-name="${escapeHtml(wf.name)}"
              style="background:#c0392b;color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px;">
              删除
            </button>
          </div>`;
        }).join('');
        bubble.innerHTML = header + rows;

        // Wire delete buttons
        bubble.querySelectorAll('.gh-delete-wf-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const path = btn.dataset.path;
            const name = btn.dataset.name;
            if (!confirm(`删除 "${name}"（${path}）？此操作不可撤销。`)) return;
            btn.disabled = true;
            btn.textContent = '删除中…';
            try {
              await GitHubActions.deleteFile(config, path);
              btn.closest('div[style]').innerHTML =
                `<span style="opacity:.5;font-size:12px;">✅ <del>${escapeHtml(name)}</del> 已删除</span>`;
            } catch (e) {
              btn.disabled = false;
              btn.textContent = '删除';
              showToast(`删除失败: ${e.message}`, 'error');
            }
          });
        });
      } catch (e) {
        bubble.innerHTML = renderMarkdown(`❌ ${e.message}`);
      }
      return true;
    }

    return false;
  }

  // ─── Send Message ──────────────────────────────────────────────────

  async function sendMessage() {
    const input = $('#message-input');
    const originalText = input.value;
    const text = originalText.trim();
    if (!text || isStreaming) return;

    // Must have an active session
    if (!currentSessionId) {
      showToast('Click + to start a new session first', 'info');
      return;
    }

    const apiKey = getSessionSetting('apiKey');
    if (!apiKey) {
      showToast('Please set your Gemini API key in settings', 'error');
      openSettings();
      return;
    }

    const model = getSessionSetting('model');
    if (!model) {
      showToast('Please set a model in session settings', 'error');
      openSettings();
      return;
    }

    // Check for slash commands
    if (text.startsWith('/')) {
      input.value = '';
      autoResizeInput();

      const handled = await handleSlashCommand(text);
      if (handled) {
        return;
      }

      // Not a recognized slash command: restore raw input and continue normal send flow.
      input.value = originalText;
      autoResizeInput();
    }

    // Clear welcome screen if present
    const welcome = $('.welcome-screen');
    if (welcome) welcome.remove();

    input.value = '';
    autoResizeInput();

    // Refresh session context in system instruction so AI sees latest settings
    if (baseSoulInstruction) {
      const ctx = buildSessionContext();
      Chat.setSystemInstruction(baseSoulInstruction + '\n\n' + ctx);
    }

    // Show user message
    addMessageBubble('user', text);

    // Create streaming bubble
    const streamBubble = createStreamingBubble();

    // Toggle UI state
    setStreamingState(true);

    const enableSearch = getSessionSetting('enableSearch', false);
    const enableThinking = getSessionSetting('enableThinking', false);

    // Build thinking config
    let thinkingConfig = null;
    if (enableThinking) {
      thinkingConfig = { enabled: true };
      const budget = getSessionSetting('thinkingBudget', '');
      if (budget !== '' && budget != null) {
        thinkingConfig.thinkingBudget = parseInt(budget, 10);
      }
      thinkingConfig.includeThoughts = getSessionSetting('includeThoughts', false);
    }

    // LAYER 2: preflight skill resolution (only if skills are loaded)
    let systemInstructionOverride = undefined;
    if (loadedSkills.length > 0) {
      streamBubble.innerHTML = '<span style="opacity:.5;font-size:12px;">🧩 Resolving skill…</span>';
      const result = await resolveSkillOverride(text, apiKey, model);
      if (result) {
        systemInstructionOverride = result.override;
        streamBubble.innerHTML = `<span style="opacity:.5;font-size:12px;">🧩 Activating <em>${escapeHtml(result.skillName)}</em>…</span>`;
      } else {
        streamBubble.innerHTML = '';
      }
    }

    let _firstSaveDone = false;

    try {
      await Chat.send({
        apiKey,
        model,
        message: text,
        enableSearch,
        thinkingConfig,
        systemInstructionOverride,
        onStart() {
          // New session: show in sidebar as soon as user message is in history
          if (!_firstSaveDone && !Storage.getIndex().find(s => s.id === currentSessionId)) {
            _firstSaveDone = true;
            saveCurrentSession().then(() => renderSidebar());
          }
        },
        onChunk(delta, fullText) {
          streamBubble.innerHTML =
            escapeHtml(fullText) + '<span class="cursor-blink">▊</span>';
          scrollToBottom();
        },
        onDone(fullText, metadata) {
          finalizeStreamingBubble(fullText);

          // Render grounding sources if available
          if (metadata?.grounding) {
            renderGroundingSources(metadata.grounding);
          }

          // Update token display
          updateTokenDisplay();

          setStreamingState(false);
          // Auto-save (await so passphrase dialog works)
          saveCurrentSession().then(() => renderSidebar());
        },
        onError(err) {
          setStreamingState(false);
          streamBubble.closest('.message-wrapper')?.remove();
          addErrorBubble(err.message);
          showToast('Request failed — see error above', 'error');
        },
      });
    } catch (err) {
      setStreamingState(false);
      streamBubble.closest('.message-wrapper')?.remove();
      addErrorBubble(err.message);
      showToast('Request failed — see error above', 'error');
    }
  }

  function setStreamingState(streaming) {
    isStreaming = streaming;
    const sendBtn = $('#send-btn');
    const stopBtn = $('#stop-btn');
    if (streaming) {
      hide(sendBtn);
      show(stopBtn);
      $('#message-input').disabled = true;
    } else {
      show(sendBtn);
      hide(stopBtn);
      $('#message-input').disabled = false;
      $('#message-input').focus();
    }
  }

  // ─── Settings Panel ────────────────────────────────────────────────

  let settingsTarget = null; // session ID being edited

  /**
   * Open settings panel for a session.
   * If no sessionId given, opens for the current session.
   */
  async function openSettings(sessionId) {
    const sid = sessionId || currentSessionId;
    if (!sid) return;
    settingsTarget = sid;

    const panel = $('#settings-panel');
    show(panel);

    // Show all sections
    show('#settings-section-ai');
    show('#settings-section-soul');
    show('#settings-section-storage');

    // Determine if this is a brand-new session (not yet in index)
    const entry = Storage.getIndex().find(s => s.id === sid);
    const isNew = !entry;
    const label = entry?.title || (isNew ? 'New Session' : sid.slice(0, 8));

    // Update header
    $('#settings-title').textContent = '⚙ Session Settings';
    $('#settings-subtitle').textContent = label;
    show('#settings-subtitle');

    // Populate from session config (fallback to global for values)
    const cfg = getSessionConfig(sid);
    const get = (key, fb) => cfgGet(cfg, key, getSetting(key, fb));

    // Passphrase field: only show for new sessions (first-time config)
    const ppField = $('#set-passphrase');
    const ppGroup = ppField?.closest('.settings-field');
    if (ppGroup) {
      if (isNew) {
        show(ppGroup);
        ppField.value = '';
        ppField.readOnly = false;
        ppField.classList.remove('field-locked');
      } else {
        hide(ppGroup);
      }
    }

    // All settings read from per-session config (with global fallback)
    $('#set-api-key').value = get('apiKey', '');
    $('#set-github-token').value = get('githubToken', '');
    $('#set-github-owner').value = get('githubOwner', '');
    $('#set-github-repo').value = get('githubRepo', '');
    $('#set-github-path').value = get('githubPath', 'sessions');
    $('#set-notion-storage-token').value = get('notionStorageToken', '');
    $('#set-notion-parent-page').value = get('notionParentPageId', '');
    $('#set-resend-api-key').value = get('resendApiKey', '');
    $('#set-notify-email').value = get('notifyEmail', '');
    $('#set-model').value = get('model', '');
    $('#set-enable-search').checked = get('enableSearch', false);
    $('#set-enable-thinking').checked = get('enableThinking', false);
    $('#set-thinking-budget').value = get('thinkingBudget', '');
    $('#set-include-thoughts').checked = get('includeThoughts', false);
    // Ensure built-in souls are loaded before populating the picker
    await loadBuiltinSouls();

    // Soul picker — populate built-ins then restore saved value
    populateSoulPicker();
    const savedSoulUrl = get('soulUrl', '');
    const isBuiltinSoul = BUILTIN_SOULS.some(s => s.url === savedSoulUrl);
    if (!savedSoulUrl) {
      $('#set-soul-preset').value = '';
      $('#set-soul-url').value = '';
    } else if (isBuiltinSoul) {
      $('#set-soul-preset').value = savedSoulUrl;
      $('#set-soul-url').value = '';
    } else {
      $('#set-soul-preset').value = '__custom__';
      $('#set-soul-url').value = savedSoulUrl;
    }
    toggleSoulUrlField();

    $('#set-notion-token').value = get('notionToken', '');
    $('#set-cors-proxy').value = get('corsProxy', 'https://corsproxy.io/?url=');
    $('#set-storage-backend').value = get('storageBackend', 'local');

    // Button label
    const applyBtn = $('#apply-settings');
    if (applyBtn) applyBtn.textContent = isNew ? '✓ Start Session' : 'Save & Apply';

    // Action settings
    $('#set-action-use-storage').checked = get('actionUseStorage', true);
    $('#set-action-token').value = get('actionToken', '');
    $('#set-action-owner').value = get('actionOwner', '');
    $('#set-action-repo').value = get('actionRepo', '');
    $('#set-action-branch').value = get('actionBranch', 'main');
    $('#set-action-workflow').value = get('actionWorkflow', 'execute.yml');
    $('#set-action-dir').value = get('actionArtifactDir', 'artifacts');

    toggleStorageFields();
    toggleThinkingFields();
    toggleActionFields();
  }

  function closeSettings() {
    hide('#settings-panel');
    // If user dismissed settings for a pending new session (never activated), clean up the lingering config
    if (settingsTarget && settingsTarget !== currentSessionId) {
      const inIndex = Storage.getIndex().find(s => s.id === settingsTarget);
      if (!inIndex) removeSessionConfig(settingsTarget);
    }
  }

  function applySettings() {
    const sessionId = settingsTarget;
    if (!sessionId) return;

    // ── All settings saved to per-session config ──
    const cfg = getSessionConfig(sessionId);

    // Credentials — only store non-empty values so getSessionSetting can
    // fall back to global settings when a session doesn't override a key.
    const credentialInputs = {
      apiKey:             $('#set-api-key').value.trim(),
      githubToken:        $('#set-github-token').value.trim(),
      githubOwner:        $('#set-github-owner').value.trim(),
      githubRepo:         $('#set-github-repo').value.trim(),
      githubPath:         $('#set-github-path').value.trim() || 'sessions',
      notionStorageToken: $('#set-notion-storage-token').value.trim(),
      notionParentPageId: $('#set-notion-parent-page').value.trim(),
      resendApiKey:       $('#set-resend-api-key').value.trim(),
      notifyEmail:        $('#set-notify-email').value.trim(),
    };

    for (const [key, val] of Object.entries(credentialInputs)) {
      if (val) {
        cfg[key] = val;
      } else {
        delete cfg[key]; // remove so getSessionSetting falls back to global
      }
    }

    // Propagate non-empty credentials to global as template for new sessions
    for (const [key, val] of Object.entries(credentialInputs)) {
      if (val) setSetting(key, val);
    }

    cfg.model = $('#set-model').value;
    cfg.enableSearch = $('#set-enable-search').checked;
    cfg.enableThinking = $('#set-enable-thinking').checked;
    cfg.thinkingBudget = $('#set-thinking-budget').value.trim();
    cfg.includeThoughts = $('#set-include-thoughts').checked;
    const soulPreset = $('#set-soul-preset').value;
    cfg.soulUrl = soulPreset === '__custom__' ? $('#set-soul-url').value.trim() : soulPreset;
    cfg.notionToken = $('#set-notion-token').value.trim();
    cfg.corsProxy = $('#set-cors-proxy').value.trim();
    cfg.storageBackend = $('#set-storage-backend').value;

    // Action execution settings (per-session)
    cfg.actionUseStorage = $('#set-action-use-storage').checked;
    cfg.actionBranch = $('#set-action-branch').value.trim() || 'main';
    cfg.actionWorkflow = $('#set-action-workflow').value.trim() || 'execute.yml';
    cfg.actionArtifactDir = $('#set-action-dir').value.trim() || 'artifacts';

    // Action repo credentials — same empty-string handling
    const actionCreds = {
      actionToken: $('#set-action-token').value.trim(),
      actionOwner: $('#set-action-owner').value.trim(),
      actionRepo:  $('#set-action-repo').value.trim(),
    };
    for (const [key, val] of Object.entries(actionCreds)) {
      if (val) { cfg[key] = val; } else { delete cfg[key]; }
    }

    if (!cfg.actionUseStorage) {
      for (const [key, val] of Object.entries(actionCreds)) {
        if (val) setSetting(key, val);
      }
    }

    // Validate: if GitHub backend selected, required credential fields must be filled
    if (cfg.storageBackend === 'github') {
      const missing = [];
      if (!cfg.githubToken)  missing.push('GitHub Token');
      if (!cfg.githubOwner)  missing.push('Repository Owner');
      if (!cfg.githubRepo)   missing.push('Repository Name');
      if (missing.length) {
        showToast(`GitHub storage requires: ${missing.join(', ')}`, 'error');
        const firstEmpty = !cfg.githubToken ? '#set-github-token'
          : !cfg.githubOwner ? '#set-github-owner' : '#set-github-repo';
        const el = $(firstEmpty);
        if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus(); }
        return;
      }
    }

    // Validate: if Notion backend selected, required fields must be filled
    if (cfg.storageBackend === 'notion') {
      const missing = [];
      if (!cfg.notionStorageToken)  missing.push('Notion Token');
      if (!cfg.notionParentPageId)  missing.push('Parent Page ID');
      if (missing.length) {
        showToast(`Notion storage requires: ${missing.join(', ')}`, 'error');
        return;
      }
    }

    // Passphrase: required for new sessions, skip for existing
    const ppVal = $('#set-passphrase')?.value.trim();
    const isNew = !Storage.getIndex().find(s => s.id === sessionId);
    if (isNew && !ppVal) {
      showToast('Please set an encryption passphrase', 'error');
      const el = $('#set-passphrase');
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus(); }
      return;
    }
    if (ppVal && !cfg.passphrase) {
      cfg.passphrase = ppVal;
    }

    saveSessionConfig(sessionId, cfg);

    // Set passphrase in memory for this session
    if (cfg.passphrase && sessionId === currentSessionId) {
      passphrase = cfg.passphrase;
    }

    // If storage backend changed for an existing session, update the index
    // and trigger an immediate re-save to the new backend
    if (!isNew) {
      const indexEntry = Storage.getIndex().find(s => s.id === sessionId);
      if (indexEntry && indexEntry.backend !== cfg.storageBackend) {
        const oldBackend = indexEntry.backend || 'local';
        indexEntry.backend = cfg.storageBackend;
        const fullIndex = Storage.getIndex().map(s => s.id === sessionId ? indexEntry : s);
        Storage.saveIndex(fullIndex);
        renderSidebar();

        // If this is the active session with messages, re-save to the new backend
        if (sessionId === currentSessionId && Chat.getHistory().length > 0) {
          // Use setTimeout so the settings panel closes first
          setTimeout(() => {
            saveCurrentSession().then(() => {
              showToast(`Session migrated from ${oldBackend} to ${cfg.storageBackend}`, 'success');
              renderSidebar();
            }).catch(err => {
              showToast(`Migration save failed: ${err.message}`, 'error');
            });
          }, 100);
        }
      }
    }

    // Clear settingsTarget before closing so closeSettings() won't
    // mistake this saved-and-about-to-activate session for an abandoned one.
    settingsTarget = null;
    closeSettings();
    showToast('Settings saved', 'success');

    if (isNew) {
      // Brand-new session confirmed — now activate it (enables input, shows welcome)
      activateSession(sessionId, cfg.passphrase);
    } else if (sessionId === currentSessionId) {
      loadSoulAndSkills();
    }
  }

  function populateSoulPicker() {
    const sel = $('#set-soul-preset');
    if (!sel) return;
    // Remove any previously injected built-in options (keep "None" and "Custom URL")
    for (const opt of Array.from(sel.options)) {
      if (opt.value !== '' && opt.value !== '__custom__') opt.remove();
    }
    // Insert built-in entries before the "Custom URL" option
    const customOpt = sel.querySelector('option[value="__custom__"]');
    for (const soul of BUILTIN_SOULS) {
      const opt = document.createElement('option');
      opt.value = soul.url;
      opt.textContent = soul.name;
      sel.insertBefore(opt, customOpt);
    }
  }

  function toggleSoulUrlField() {
    const preset = $('#set-soul-preset')?.value;
    if (preset === '__custom__') show('#soul-url-field');
    else hide('#soul-url-field');
  }

  function toggleStorageFields() {
    const backend = $('#set-storage-backend').value;
    const githubFields = $('#github-fields');
    const notionFields = $('#notion-storage-fields');
    if (backend === 'github') {
      show(githubFields);
      hide(notionFields);
    } else if (backend === 'notion') {
      hide(githubFields);
      show(notionFields);
    } else {
      hide(githubFields);
      hide(notionFields);
    }
  }

  function toggleThinkingFields() {
    const checked = $('#set-enable-thinking').checked;
    if (checked) {
      show('#thinking-fields');
    } else {
      hide('#thinking-fields');
    }
  }

  function toggleActionFields() {
    const useStorage = $('#set-action-use-storage')?.checked;
    if (useStorage) {
      hide('#action-custom-repo-fields');
    } else {
      show('#action-custom-repo-fields');
    }
  }

  /**
   * Build the GitHub Actions config object from current session settings.
   * When "use storage repo" is on, reuses the global GitHub storage credentials.
   */
  function getActionConfig() {
    const useStorage = getSessionSetting('actionUseStorage', true);
    let token, owner, repo;
    if (useStorage) {
      token = getSessionSetting('githubToken');
      owner = getSessionSetting('githubOwner');
      repo  = getSessionSetting('githubRepo');
    } else {
      token = getSessionSetting('actionToken');
      owner = getSessionSetting('actionOwner');
      repo  = getSessionSetting('actionRepo');
    }
    if (!token || !owner || !repo) {
      throw new Error('GitHub Actions repository not configured. Open session settings to configure.');
    }
    return {
      token,
      owner,
      repo,
      branch: getSessionSetting('actionBranch', 'main'),
      workflow: getSessionSetting('actionWorkflow', 'execute.yml'),
      artifactDir: getSessionSetting('actionArtifactDir', 'artifacts'),
    };
  }

  // ─── Auto-Create GitHub Repo ───────────────────────────────────────

  async function autoCreateGitHubRepo() {
    const token = $('#set-github-token').value.trim();
    if (!token) {
      showToast('Please enter your GitHub token first', 'error');
      return;
    }

    const repoName = $('#set-github-repo').value.trim() || 'browseragent-sessions';
    const sessionsDir = $('#set-github-path').value.trim() || 'sessions';
    const btn = $('#auto-create-repo-btn');
    const originalText = btn.textContent;

    try {
      btn.disabled = true;
      btn.textContent = '⏳ Creating…';

      // 1. Get authenticated user info
      const userResp = await fetch('https://api.github.com/user', {
        headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' },
      });
      if (!userResp.ok) throw new Error('Invalid token or network error');
      const user = await userResp.json();
      const owner = user.login;

      // 2. Check if repo already exists
      const checkResp = await fetch(`https://api.github.com/repos/${owner}/${repoName}`, {
        headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' },
      });

      if (checkResp.status === 200) {
        // Repo exists — just fill in the fields
        $('#set-github-owner').value = owner;
        $('#set-github-repo').value = repoName;
        showToast(`Repo "${repoName}" already exists — fields filled`, 'info');
        return;
      }

      // 3. Create private repo
      const createResp = await fetch('https://api.github.com/user/repos', {
        method: 'POST',
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: repoName,
          description: 'Encrypted session storage for BrowserAgent',
          private: !!$('#set-repo-private')?.checked,
          auto_init: true,  // creates initial commit with README
        }),
      });

      if (!createResp.ok) {
        const err = await createResp.json();
        throw new Error(err.message || `HTTP ${createResp.status}`);
      }

      // 4. Create sessions directory with a .gitkeep
      // Small delay to let GitHub process the initial commit
      await new Promise(r => setTimeout(r, 1500));

      await fetch(`https://api.github.com/repos/${owner}/${repoName}/contents/${sessionsDir}/.gitkeep`, {
        method: 'PUT',
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: 'Initialize sessions directory',
          content: btoa(''),  // empty file
        }),
      });

      // 5. Fill in the fields
      $('#set-github-owner').value = owner;
      $('#set-github-repo').value = repoName;
      $('#set-github-path').value = sessionsDir;

      const visibility = $('#set-repo-private')?.checked ? 'private' : 'public';
      showToast(`✅ Created ${visibility} repo "${owner}/${repoName}"`, 'success');
    } catch (err) {
      console.error('Auto-create repo failed:', err);
      showToast(`Failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }

  // ─── Auto-Create Action Repo ───────────────────────────────────────

  async function autoCreateActionRepo() {
    const token = $('#set-action-token').value.trim();
    if (!token) {
      showToast('Enter a GitHub token for the action repo first', 'error');
      return;
    }
    const repoName = $('#set-action-repo').value.trim() || 'browseragent-exec';
    const isPrivate = !!$('#set-action-repo-private')?.checked;
    const btn = $('#auto-create-action-repo-btn');
    const originalText = btn.textContent;

    try {
      btn.disabled = true;
      btn.textContent = '⏳ Creating…';

      const user = await GitHubActions.getUser(token);
      const owner = user.login;

      const exists = await GitHubActions.repoExists(token, owner, repoName);
      if (exists) {
        $('#set-action-owner').value = owner;
        $('#set-action-repo').value = repoName;
        showToast(`Repo "${repoName}" already exists — fields filled`, 'info');
        return;
      }

      await GitHubActions.createRepo(token, repoName, isPrivate);
      $('#set-action-owner').value = owner;
      $('#set-action-repo').value = repoName;
      const vis = isPrivate ? 'private' : 'public';
      showToast(`✅ Created ${vis} repo "${owner}/${repoName}"`, 'success');
    } catch (err) {
      showToast(`Failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }

  // ─── Token Usage Display ───────────────────────────────────────────

  function updateTokenDisplay() {
    const usage = Chat.getTokenUsage();
    const el = $('#token-count');
    if (!el) return;

    const total = usage.totalTokens;
    let display;
    if (total >= 1000000) {
      display = (total / 1000000).toFixed(1) + 'M';
    } else if (total >= 1000) {
      display = (total / 1000).toFixed(1) + 'K';
    } else {
      display = String(total);
    }
    el.textContent = display + ' tokens';

    // Update tooltip with detailed breakdown
    const container = $('#token-display');
    if (container) {
      container.title = [
        `Total: ${usage.totalTokens.toLocaleString()} tokens`,
        `Prompt: ${usage.promptTokens.toLocaleString()}`,
        `Output: ${usage.candidatesTokens.toLocaleString()}`,
        usage.thoughtsTokens ? `Thoughts: ${usage.thoughtsTokens.toLocaleString()}` : '',
        `Requests: ${usage.requestCount}`,
      ].filter(Boolean).join('\n');
    }
  }

  // ─── Grounding Sources Rendering ───────────────────────────────────

  function renderGroundingSources(grounding) {
    if (!grounding) return;

    const chunks = grounding.groundingChunks || [];
    const webChunks = chunks.filter(c => c.web);
    if (webChunks.length === 0) return;

    const chatBox = $('#chat-box');
    const sourcesDiv = document.createElement('div');
    sourcesDiv.className = 'grounding-sources';

    const header = document.createElement('div');
    header.className = 'grounding-header';
    header.textContent = '🔍 Sources';
    sourcesDiv.appendChild(header);

    const list = document.createElement('div');
    list.className = 'grounding-list';

    for (const chunk of webChunks) {
      const link = document.createElement('a');
      link.className = 'grounding-link';
      link.href = chunk.web.uri;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = chunk.web.title || chunk.web.uri;
      list.appendChild(link);
    }

    sourcesDiv.appendChild(list);

    // Append search queries if available
    if (grounding.webSearchQueries?.length > 0) {
      const queries = document.createElement('div');
      queries.className = 'grounding-queries';
      queries.textContent = 'Searched: ' + grounding.webSearchQueries.join(', ');
      sourcesDiv.appendChild(queries);
    }

    chatBox.appendChild(sourcesDiv);
    scrollToBottom();
  }

  // ─── Deploy Bundle Detection & Rendering ──────────────────────────

  /**
   * Parse DEPLOY_BUNDLE markers from raw AI response text.
   * Returns array of { meta, artifacts[] } or empty array if none found.
   */
  function parseDeployBundles(rawText) {
    const bundles = [];
    const bundleRegex = /<!--DEPLOY_BUNDLE:(.*?)-->([\s\S]*?)<!--\/DEPLOY_BUNDLE-->/g;
    let match;

    while ((match = bundleRegex.exec(rawText)) !== null) {
      try {
        const meta = JSON.parse(match[1]);
        const bundleContent = match[2];

        // Extract code blocks within this bundle
        const codeRegex = /```(\w+)?(?::([^\n]+))?\n([\s\S]*?)```/g;
        const artifacts = [];
        let codeMatch;

        while ((codeMatch = codeRegex.exec(bundleContent)) !== null) {
          const language = (codeMatch[1] || 'text').toLowerCase();
          const filename = codeMatch[2]?.trim() || `artifact_${artifacts.length + 1}.txt`;
          const code = codeMatch[3].trimEnd();
          artifacts.push({ language, filename, code });
        }

        if (artifacts.length > 0) {
          bundles.push({ meta, artifacts, raw: match[0] });
        }
      } catch (e) {
        console.warn('Failed to parse DEPLOY_BUNDLE meta:', e);
      }
    }
    return bundles;
  }

  /**
   * Check if raw text contains DEPLOY_BUNDLE markers.
   */
  function hasDeployBundle(rawText) {
    return /<!--DEPLOY_BUNDLE:/.test(rawText);
  }

  /**
   * Render a compact deploy card for a DEPLOY_BUNDLE.
   * Replaces the verbose markdown with a clean card UI.
   */
  function renderDeployBundleCard(bubble, rawText) {
    const bundles = parseDeployBundles(rawText);
    if (bundles.length === 0) return false;

    // Extract any text BEFORE the first bundle (the ✅ summary line)
    const firstBundleIdx = rawText.indexOf('<!--DEPLOY_BUNDLE:');
    const preText = rawText.substring(0, firstBundleIdx).trim();

    // Clear the bubble and rebuild with compact UI
    bubble.innerHTML = '';

    // Render the short pre-text (e.g. "✅ 已配置每日AI新闻摘要任务。")
    if (preText) {
      const intro = document.createElement('div');
      intro.className = 'deploy-bundle-intro';
      intro.innerHTML = renderMarkdown(preText);
      bubble.appendChild(intro);
    }

    for (const bundle of bundles) {
      const card = document.createElement('div');
      card.className = 'deploy-bundle-card';

      // Card header with meta info
      const header = document.createElement('div');
      header.className = 'deploy-bundle-header';
      header.innerHTML = `
        <div class="deploy-bundle-title">
          <span class="deploy-bundle-icon">📦</span>
          <span class="deploy-bundle-name">${escapeHtml(bundle.meta.name || 'Deploy Bundle')}</span>
        </div>
        <div class="deploy-bundle-meta">
          ${bundle.meta.scheduleText ? `<span class="deploy-bundle-schedule">🕐 ${escapeHtml(bundle.meta.scheduleText)}</span>` : ''}
          ${bundle.meta.description ? `<span class="deploy-bundle-desc">${escapeHtml(bundle.meta.description)}</span>` : ''}
        </div>
      `;
      card.appendChild(header);

      // File list
      const fileList = document.createElement('div');
      fileList.className = 'deploy-bundle-files';

      for (const artifact of bundle.artifacts) {
        const isWorkflow = artifact.filename.startsWith('.github/workflows/');
        const fileItem = document.createElement('div');
        fileItem.className = 'deploy-bundle-file';

        const fileIcon = isWorkflow ? '⚙️' : '📄';
        const fileInfo = document.createElement('div');
        fileInfo.className = 'deploy-bundle-file-info';
        fileInfo.innerHTML = `<span class="deploy-bundle-file-icon">${fileIcon}</span><span class="deploy-bundle-file-name">${escapeHtml(artifact.filename)}</span>`;

        const fileActions = document.createElement('div');
        fileActions.className = 'deploy-bundle-file-actions';

        // Toggle code view button
        const viewBtn = document.createElement('button');
        viewBtn.className = 'deploy-bundle-file-btn';
        viewBtn.textContent = '👁 View';
        viewBtn.title = 'Toggle code view';

        // Copy button
        const copyBtn = document.createElement('button');
        copyBtn.className = 'deploy-bundle-file-btn';
        copyBtn.textContent = '📋';
        copyBtn.title = 'Copy code';
        copyBtn.onclick = () => {
          navigator.clipboard.writeText(artifact.code);
          copyBtn.textContent = '✓';
          setTimeout(() => (copyBtn.textContent = '📋'), 1500);
        };

        fileActions.appendChild(viewBtn);
        fileActions.appendChild(copyBtn);

        fileItem.appendChild(fileInfo);
        fileItem.appendChild(fileActions);
        fileList.appendChild(fileItem);

        // Collapsible code block (hidden by default)
        const codeContainer = document.createElement('div');
        codeContainer.className = 'deploy-bundle-code hidden';
        const pre = document.createElement('pre');
        const codeEl = document.createElement('code');
        codeEl.className = `language-${artifact.language}`;
        codeEl.textContent = artifact.code;
        pre.appendChild(codeEl);
        codeContainer.appendChild(pre);
        fileList.appendChild(codeContainer);

        // Highlight
        if (artifact.language && hljs.getLanguage(artifact.language)) {
          try {
            codeEl.innerHTML = hljs.highlight(artifact.code, { language: artifact.language }).value;
          } catch {}
        }

        // Toggle handler
        viewBtn.onclick = () => {
          const isHidden = codeContainer.classList.contains('hidden');
          codeContainer.classList.toggle('hidden');
          viewBtn.textContent = isHidden ? '🔽 Hide' : '👁 View';
        };
      }

      card.appendChild(fileList);

      // Deploy All button
      const deployAllBtn = document.createElement('button');
      deployAllBtn.className = 'deploy-bundle-deploy-btn';
      deployAllBtn.innerHTML = '🚀 Deploy All';
      deployAllBtn.onclick = () => handleDeployBundle(bundle, card);
      card.appendChild(deployAllBtn);

      bubble.appendChild(card);
    }

    return true;
  }

  /**
   * Handle deploying all files in a bundle at once.
   */
  async function handleDeployBundle(bundle, cardEl) {
    let config;
    try {
      config = getActionConfig();
    } catch (e) {
      showToast(e.message, 'error');
      return;
    }

    const statusCard = createStatusCard(cardEl);

    // Collect non-workflow script filenames for path fixing
    const scriptFilenames = bundle.artifacts
      .filter(a => !a.filename.startsWith('.github/'))
      .map(a => a.filename);

    // Prepare all files — fix workflow YAML that references bare script names
    const files = bundle.artifacts.map(artifact => {
      const isWorkflow = artifact.filename.startsWith('.github/');
      let content = artifact.code;

      // Auto-fix: ensure workflow YAML references scripts with artifacts/ prefix
      if (isWorkflow && scriptFilenames.length > 0) {
        for (const scriptName of scriptFilenames) {
          // Match bare script name NOT already prefixed with artifacts/
          // Handles patterns like: python3 script.py, python "script.py", node script.js
          const escaped = scriptName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(`(?<!artifacts/)(?<![\\w/])${escaped}`, 'g');
          content = content.replace(re, `artifacts/${scriptName}`);
        }
      }

      return {
        path: isWorkflow ? artifact.filename : `${config.artifactDir}/${artifact.filename}`,
        content,
      };
    });

    const fileNames = bundle.artifacts.map(a => a.filename).join(', ');

    try {
      // Step 1: Push all files in a single atomic commit
      updateStatusCard(statusCard, 'in_progress', `Pushing ${files.length} files…`);
      await GitHubActions.pushFiles(
        config,
        files,
        `Deploy bundle "${bundle.meta.name}" from BrowserAgent`
      );

      // Check if any file is NOT a workflow (needs execution)
      const hasWorkflow = bundle.artifacts.some(a => a.filename.startsWith('.github/workflows/'));
      const nonWorkflowArtifacts = bundle.artifacts.filter(a => !a.filename.startsWith('.github/workflows/'));

      if (nonWorkflowArtifacts.length > 0 && !hasWorkflow) {
        // If there's a non-workflow file but no workflow, trigger default execute
        updateStatusCard(statusCard, 'in_progress', 'Checking workflow…');
        await GitHubActions.ensureWorkflow(config, `.github/workflows/${config.workflow}`);

        const firstScript = nonWorkflowArtifacts[0];
        const filePath = `${config.artifactDir}/${firstScript.filename}`;
        const runtime = GitHubActions.detectRuntime(firstScript.language);

        updateStatusCard(statusCard, 'in_progress', 'Triggering workflow…');
        await GitHubActions.dispatchWorkflow(config, config.workflow, {
          entrypoint: filePath,
          language: runtime,
        });

        // Poll for run
        updateStatusCard(statusCard, 'queued', 'Waiting for workflow run…');
        let run = null;
        for (let attempt = 0; attempt < 6; attempt++) {
          await new Promise((r) => setTimeout(r, 3000));
          run = await GitHubActions.findLatestRun(config, config.workflow);
          if (run && run.status !== 'completed') break;
          if (run) {
            const age = Date.now() - new Date(run.created_at).getTime();
            if (age < 30000) break;
            run = null;
          }
        }

        if (run) {
          const runUrl = run.html_url;
          updateStatusCard(statusCard, 'in_progress', 'Running…', runUrl);
          const finalRun = await GitHubActions.pollRun(config, run.id, (r) => {
            const label = r.status === 'in_progress' ? 'Running…' : r.status === 'queued' ? 'Queued…' : r.status;
            updateStatusCard(statusCard, r.status, label, runUrl);
          });

          try {
            const jobs = await GitHubActions.getRunJobs(config, finalRun.id);
            const job = jobs.jobs?.[0];
            if (job) {
              const rawLogs = await GitHubActions.getJobLogs(config, job.id);
              const { output, exitCode } = GitHubActions.parseLogOutput(rawLogs);
              const statusLabel = finalRun.conclusion === 'success'
                ? 'Completed (exit 0)' : `Failed (exit ${exitCode ?? '?'})`;
              updateStatusCard(statusCard, finalRun.conclusion, statusLabel, runUrl, output || '(no output)');
            } else {
              updateStatusCard(statusCard, finalRun.conclusion,
                finalRun.conclusion === 'success' ? 'Completed' : `Failed (${finalRun.conclusion})`,
                runUrl
              );
            }
          } catch (logErr) {
            console.warn('Could not fetch logs:', logErr);
            updateStatusCard(statusCard, finalRun.conclusion,
              finalRun.conclusion === 'success' ? 'Completed' : `Done (${finalRun.conclusion})`,
              runUrl
            );
          }
        } else {
          updateStatusCard(statusCard, 'failure',
            'Could not find workflow run. Check the Actions tab.',
            `https://github.com/${config.owner}/${config.repo}/actions`
          );
        }
      } else {
        // All files deployed (workflow files auto-activate, scripts pushed)
        const repoUrl = `https://github.com/${config.owner}/${config.repo}`;
        const scheduleInfo = bundle.meta.scheduleText ? ` — scheduled ${bundle.meta.scheduleText}` : '';
        updateStatusCard(statusCard, 'success',
          `All ${files.length} files deployed${scheduleInfo}`,
          `${repoUrl}/actions`
        );

        // Auto-sync secrets & variables to the repo
        try {
          updateStatusCard(statusCard, 'in_progress',
            `Syncing secrets & variables…`,
            `${repoUrl}/actions`
          );

          const settings = {
            geminiApiKey: getSessionSetting('apiKey'),
            resendApiKey: getSessionSetting('resendApiKey'),
            notifyEmail: getSessionSetting('notifyEmail'),
          };

          const result = await GitHubActions.syncSecretsAndVars(config, settings);

          // Build summary
          const parts = [];
          if (result.synced.length > 0) parts.push(`✅ ${result.synced.join(', ')}`);
          if (result.skipped.length > 0) parts.push(`⏭ skipped: ${result.skipped.join(', ')}`);
          if (result.errors.length > 0) parts.push(`❌ ${result.errors.join('; ')}`);

          const hasErrors = result.errors.length > 0;
          const allDeployedMsg = `All ${files.length} files deployed${scheduleInfo}`;

          updateStatusCard(statusCard,
            hasErrors ? 'failure' : 'success',
            allDeployedMsg,
            `${repoUrl}/actions`
          );

          // Show secrets sync result
          const secretsHint = document.createElement('div');
          secretsHint.className = 'deploy-bundle-secrets-hint';
          secretsHint.innerHTML = `
            <span class="deploy-bundle-secrets-icon">🔑</span>
            <span>${parts.join(' · ')}</span>
          `;
          cardEl.appendChild(secretsHint);

          if (result.skipped.length > 0) {
            const missingHint = document.createElement('div');
            missingHint.className = 'deploy-bundle-secrets-hint';
            missingHint.innerHTML = `
              <span class="deploy-bundle-secrets-icon">⚠️</span>
              <span>Skipped keys are not configured in BrowserAgent settings. <a href="${repoUrl}/settings/secrets/actions" target="_blank" rel="noopener">Add manually</a> or configure in Settings first.</span>
            `;
            cardEl.appendChild(missingHint);
          }
        } catch (secretsErr) {
          console.warn('Secrets sync failed:', secretsErr);
          // Still show success for file deploy, but warn about secrets
          const secretsHint = document.createElement('div');
          secretsHint.className = 'deploy-bundle-secrets-hint';
          secretsHint.innerHTML = `
            <span class="deploy-bundle-secrets-icon">⚠️</span>
            <span>Files deployed, but secrets sync failed: ${escapeHtml(secretsErr.message)}. <a href="${repoUrl}/settings/secrets/actions" target="_blank" rel="noopener">Add secrets manually</a></span>
          `;
          cardEl.appendChild(secretsHint);
        }
      }

      showToast(`Deployed ${fileNames}`, 'success');
    } catch (err) {
      updateStatusCard(statusCard, 'failure', `Deploy failed: ${err.message}`);
      showToast(`Deploy failed: ${err.message}`, 'error');
    }
  }

  // ─── Artifact Toolbars on Code Blocks ────────────────────────────

  /**
   * Post-process a rendered message bubble to add action toolbars
   * (Copy / Push / Push & Run) on every code block.
   */
  function addCodeBlockToolbars(bubble, rawText) {
    if (typeof GitHubActions === 'undefined') return;
    const artifacts = GitHubActions.extractArtifacts(rawText);
    if (artifacts.length === 0) return;

    const preBlocks = bubble.querySelectorAll('pre');
    preBlocks.forEach((pre, idx) => {
      if (idx >= artifacts.length) return;
      const artifact = artifacts[idx];
      const isWorkflow = artifact.filename.startsWith('.github/workflows/');

      // Toolbar
      const toolbar = document.createElement('div');
      toolbar.className = 'code-toolbar';

      const fileLabel = document.createElement('span');
      fileLabel.className = 'code-filename';
      fileLabel.textContent = artifact.filename;
      toolbar.appendChild(fileLabel);

      const actions = document.createElement('div');
      actions.className = 'code-toolbar-actions';

      // Copy
      const copyBtn = document.createElement('button');
      copyBtn.className = 'code-toolbar-btn';
      copyBtn.textContent = '📋';
      copyBtn.title = 'Copy code';
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(artifact.code);
        copyBtn.textContent = '✓';
        setTimeout(() => (copyBtn.textContent = '📋'), 1500);
      };
      actions.appendChild(copyBtn);

      // Push
      const pushBtn = document.createElement('button');
      pushBtn.className = 'code-toolbar-btn';
      pushBtn.textContent = '↑ Push';
      pushBtn.title = 'Push to GitHub';
      pushBtn.onclick = () => handlePushArtifact(artifact, pre);
      actions.appendChild(pushBtn);

      // Push & Run / Deploy
      const runBtn = document.createElement('button');
      runBtn.className = 'code-toolbar-btn code-toolbar-btn-primary';
      runBtn.textContent = isWorkflow ? '📦 Deploy' : '▶ Run';
      runBtn.title = isWorkflow
        ? 'Push workflow file to .github/workflows/'
        : 'Push & trigger GitHub Actions workflow';
      runBtn.onclick = () => handlePushAndRun(artifact, pre);
      actions.appendChild(runBtn);

      toolbar.appendChild(actions);

      // Wrap <pre> in container
      const container = document.createElement('div');
      container.className = 'code-block-container';
      pre.parentNode.insertBefore(container, pre);
      container.appendChild(toolbar);
      container.appendChild(pre);

      // If code is inside a <details>, add a prominent Execute button outside
      const details = container.closest('details');
      if (details) {
        const existingBtn = details.parentElement.querySelector('.quick-exec-btn');
        if (!existingBtn) {
          const quickBtn = document.createElement('button');
          quickBtn.className = 'quick-exec-btn';
          quickBtn.innerHTML = isWorkflow
            ? '📦 Deploy Workflow'
            : '⚡ Execute';
          quickBtn.onclick = () => handlePushAndRun(artifact, pre);
          details.parentElement.insertBefore(quickBtn, details.nextSibling);
        }
      }
    });
  }

  // ─── Execution Status Card ─────────────────────────────────────────

  function createStatusCard(parentEl) {
    const card = document.createElement('div');
    card.className = 'exec-status-card';
    card.innerHTML = `
      <div class="exec-status-header">
        <span class="exec-status-icon">⏳</span>
        <span class="exec-status-text">Preparing…</span>
        <a class="exec-status-link hidden" href="#" target="_blank" rel="noopener">View on GitHub ↗</a>
      </div>
      <div class="exec-status-log hidden">
        <pre class="exec-log-content"></pre>
      </div>
    `;
    parentEl.appendChild(card);
    scrollToBottom();
    return card;
  }

  function updateStatusCard(card, status, text, url, logContent) {
    const icons = {
      queued: '⏳', in_progress: '🔄', completed: '✅',
      success: '✅', failure: '❌', cancelled: '⚠️',
    };
    card.querySelector('.exec-status-icon').textContent = icons[status] || '⏳';
    card.querySelector('.exec-status-text').textContent = text;
    if (url) {
      const link = card.querySelector('.exec-status-link');
      link.href = url;
      link.classList.remove('hidden');
    }
    if (logContent != null) {
      const logDiv = card.querySelector('.exec-status-log');
      logDiv.classList.remove('hidden');
      card.querySelector('.exec-log-content').textContent = logContent;
    }
    scrollToBottom();
  }

  // ─── Push & Run Handlers ───────────────────────────────────────────

  async function handlePushArtifact(artifact, preElement) {
    let config;
    try { config = getActionConfig(); } catch (e) {
      showToast(e.message, 'error');
      return;
    }

    const details = preElement.closest('details');
    const container = details
      ? (details.closest('.message-bubble') || details.parentElement)
      : (preElement.closest('.code-block-container') || preElement.parentElement);
    const card = createStatusCard(container);
    // Files starting with .github/ go to repo root; others go under artifactDir
    const filePath = artifact.filename.startsWith('.github/')
      ? artifact.filename
      : `${config.artifactDir}/${artifact.filename}`;

    try {
      updateStatusCard(card, 'in_progress', `Pushing ${artifact.filename}…`);
      await GitHubActions.pushFiles(config,
        [{ path: filePath, content: artifact.code }],
        `Push ${artifact.filename} from BrowserAgent`
      );
      const fileUrl = `https://github.com/${config.owner}/${config.repo}/blob/${config.branch}/${filePath}`;
      updateStatusCard(card, 'success', `Pushed to ${filePath}`, fileUrl);
      showToast(`Pushed ${artifact.filename}`, 'success');
    } catch (err) {
      updateStatusCard(card, 'failure', `Push failed: ${err.message}`);
      showToast(`Push failed: ${err.message}`, 'error');
    }
  }

  async function handlePushAndRun(artifact, preElement) {
    let config;
    try { config = getActionConfig(); } catch (e) {
      showToast(e.message, 'error');
      return;
    }

    // Place status card at visible level — if code is inside <details>, put card outside it
    const details = preElement.closest('details');
    const container = details
      ? (details.closest('.message-bubble') || details.parentElement)
      : (preElement.closest('.code-block-container') || preElement.parentElement);
    const card = createStatusCard(container);
    // Files starting with .github/ go to repo root; others go under artifactDir
    const filePath = artifact.filename.startsWith('.github/')
      ? artifact.filename
      : `${config.artifactDir}/${artifact.filename}`;
    const runtime = GitHubActions.detectRuntime(artifact.language);

    // Workflow YAML files → deploy only (push to .github/workflows/, no dispatch)
    const isWorkflowFile = filePath.startsWith('.github/workflows/');
    if (isWorkflowFile) {
      try {
        updateStatusCard(card, 'in_progress', `Deploying workflow ${artifact.filename}…`);
        await GitHubActions.pushFiles(config,
          [{ path: filePath, content: artifact.code }],
          `Deploy workflow ${artifact.filename} from BrowserAgent`
        );
        const fileUrl = `https://github.com/${config.owner}/${config.repo}/blob/${config.branch}/${filePath}`;
        updateStatusCard(card, 'success', `Workflow deployed → ${filePath}`, fileUrl);
        showToast(`Deployed ${artifact.filename}`, 'success');
      } catch (err) {
        updateStatusCard(card, 'failure', `Deploy failed: ${err.message}`);
        showToast(`Deploy failed: ${err.message}`, 'error');
      }
      return;
    }

    try {
      // 1. Ensure execute workflow
      updateStatusCard(card, 'in_progress', 'Checking workflow…');
      await GitHubActions.ensureWorkflow(config, `.github/workflows/${config.workflow}`);

      // 2. Push artifact
      updateStatusCard(card, 'in_progress', `Pushing ${artifact.filename}…`);
      await GitHubActions.pushFiles(config,
        [{ path: filePath, content: artifact.code }],
        `Push ${artifact.filename} from BrowserAgent`
      );

      // 3. Dispatch workflow
      updateStatusCard(card, 'in_progress', 'Triggering workflow…');
      await GitHubActions.dispatchWorkflow(config, config.workflow, {
        entrypoint: filePath,
        language: runtime,
      });

      // 4. Find the triggered run (with retries)
      updateStatusCard(card, 'queued', 'Waiting for workflow run…');
      let run = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        await new Promise((r) => setTimeout(r, 3000));
        run = await GitHubActions.findLatestRun(config, config.workflow);
        if (run && run.status !== 'completed') break;
        // The latest run may be from a previous dispatch; check creation time
        if (run) {
          const age = Date.now() - new Date(run.created_at).getTime();
          if (age < 30000) break; // created within last 30s → it's ours
          run = null; // too old, keep waiting
        }
      }

      if (!run) {
        updateStatusCard(card, 'failure',
          'Could not find workflow run. Check the Actions tab on GitHub.',
          `https://github.com/${config.owner}/${config.repo}/actions`
        );
        return;
      }

      // 5. Poll for completion
      const runUrl = run.html_url;
      updateStatusCard(card, 'in_progress', 'Running…', runUrl);

      const finalRun = await GitHubActions.pollRun(config, run.id, (r) => {
        const label = r.status === 'in_progress' ? 'Running…' : r.status === 'queued' ? 'Queued…' : r.status;
        updateStatusCard(card, r.status, label, runUrl);
      });

      // 6. Fetch & parse logs
      try {
        const jobs = await GitHubActions.getRunJobs(config, finalRun.id);
        const job = jobs.jobs?.[0];
        if (job) {
          const rawLogs = await GitHubActions.getJobLogs(config, job.id);
          const { output, exitCode } = GitHubActions.parseLogOutput(rawLogs);
          const statusLabel = finalRun.conclusion === 'success'
            ? `Completed (exit 0)` : `Failed (exit ${exitCode ?? '?'})`;
          updateStatusCard(card, finalRun.conclusion, statusLabel, runUrl, output || '(no output)');
        } else {
          updateStatusCard(card, finalRun.conclusion,
            finalRun.conclusion === 'success' ? 'Completed' : `Failed (${finalRun.conclusion})`,
            runUrl
          );
        }
      } catch (logErr) {
        console.warn('Could not fetch logs:', logErr);
        updateStatusCard(card, finalRun.conclusion,
          finalRun.conclusion === 'success' ? 'Completed' : `Done (${finalRun.conclusion})`,
          runUrl
        );
      }
    } catch (err) {
      updateStatusCard(card, 'failure', `Error: ${err.message}`);
      showToast(`Push & Run failed: ${err.message}`, 'error');
    }
  }

  // ─── SOUL + Skills Loading ────────────────────────────────────────

  /**
   * Build a context block describing current user settings so the AI model
   * can reference them (e.g. auto-fill model name, know which keys exist).
   * Actual key values are NOT exposed — only whether they are configured.
   */
  function buildSessionContext() {
    const model = getSessionSetting('model');
    const hasGeminiKey = !!getSessionSetting('apiKey');
    const hasGithubToken = !!getSessionSetting('githubToken');
    const useStorage = getSessionSetting('actionUseStorage', true);
    const actionOwner = useStorage ? getSessionSetting('githubOwner') : getSessionSetting('actionOwner');
    const actionRepo = useStorage ? getSessionSetting('githubRepo') : getSessionSetting('actionRepo');
    const hasResendKey = !!getSessionSetting('resendApiKey');
    const notifyEmail = getSessionSetting('notifyEmail');

    const lines = [
      '## 📋 Current Session Context',
      '',
      'This is automatically injected — use these values when generating code or workflows.',
      '',
      `- **Current AI Model**: \`${model}\``,
      `- **Gemini API Key**: ${hasGeminiKey ? '✅ configured' : '❌ not set'}`,
      `- **GitHub Token**: ${hasGithubToken ? '✅ configured' : '❌ not set'}`,
    ];

    if (actionOwner) lines.push(`- **GitHub Owner**: \`${actionOwner}\``);
    if (actionRepo) lines.push(`- **GitHub Actions Repo**: \`${actionRepo}\``);

    lines.push(`- **Resend API Key**: ${hasResendKey ? '✅ configured' : '❌ not set'}`);
    lines.push(`- **Notification Email**: ${notifyEmail ? '\`' + notifyEmail + '\`' : '❌ not set'}`);
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## ⛔ MANDATORY RULES — YOU MUST FOLLOW THESE');
    lines.push('');
    lines.push('### Rule 1: Never Generate Content Directly When Email Delivery Is Requested');
    lines.push('');
    lines.push('When the user asks you to do something AND send/email the result:');
    lines.push('- ❌ WRONG: Generate the content in your chat response, then ask "should I send it to your email?"');
    lines.push('- ❌ WRONG: Show the content in chat and say "I need your email"');
    lines.push('- ❌ WRONG: Produce content as text and offer to "set up automation later"');
    lines.push('- ✅ CORRECT: Generate a **Python script** that does the work AND sends the email, using the DEPLOY_BUNDLE format');
    lines.push('');
    lines.push('The content must be generated BY THE SCRIPT AT RUNTIME on GitHub Actions — not by you in the chat.');
    lines.push('');
    lines.push('### Rule 2: Use the Session Values Above');
    lines.push('- Use the model name above in generated scripts (do not ask the user which model).');
    lines.push('- If a key is marked ✅, reference it as a GitHub Actions secret (e.g. `${{ secrets.GEMINI_API_KEY }}`) — do not ask the user to provide the value again.');
    lines.push('- Secrets (GEMINI_API_KEY, RESEND_API_KEY) and variables (NOTIFY_EMAIL) are **automatically synced** to the GitHub repo when the user clicks Deploy. Do NOT tell the user to manually add secrets or variables.');
    lines.push(`- If Notification Email is set above (${notifyEmail || 'not set'}), use it directly in the script.`);
    lines.push('- If a key is marked ❌, tell the user they need to configure it first in BrowserAgent settings.');
    lines.push('');
    lines.push('### Rule 3: Use DEPLOY_BUNDLE Format for Scheduled / Multi-file Tasks');
    lines.push('');
    lines.push('When producing scheduled tasks or multi-file deployments (script + workflow), wrap ALL code blocks in a DEPLOY_BUNDLE:');
    lines.push('');
    lines.push('```');
    lines.push('✅ [1 sentence: what this does]');
    lines.push('');
    lines.push('<!--DEPLOY_BUNDLE:{"name":"task-slug","schedule":"0 9 * * *","scheduleText":"every day 9am UTC","description":"one-line summary"}-->');
    lines.push('');
    lines.push('```python:descriptive-filename.py');
    lines.push('# the actual script');
    lines.push('```');
    lines.push('');
    lines.push('```yaml:.github/workflows/workflow-name.yml');
    lines.push('# the workflow');
    lines.push('```');
    lines.push('');
    lines.push('<!--/DEPLOY_BUNDLE-->');
    lines.push('```');
    lines.push('');
    lines.push('CRITICAL RULES for DEPLOY_BUNDLE:');
    lines.push('- The <!--DEPLOY_BUNDLE:...-->  line MUST contain valid JSON with name, schedule, scheduleText, description');
    lines.push('- Every code block MUST have a language:filename tag (e.g. python:my-task.py)');
    lines.push('- Do NOT add ANY explanatory text between or after code blocks inside the bundle');
    lines.push('- Do NOT add setup instructions, bullet lists, or "click here" text after the bundle');
    lines.push('- The frontend renders a compact deploy card with a single "Deploy All" button automatically');
    lines.push('- Before the bundle, add at most ONE short sentence (the ✅ line)');
    lines.push('');
    lines.push('### Rule 4: Single-file Tasks Use Collapsed Format');
    lines.push('');
    lines.push('For single executable scripts (not scheduled), use the collapsed details pattern:');
    lines.push('');
    lines.push('```');
    lines.push('✅ [1 sentence: what this does]');
    lines.push('');
    lines.push('<details>');
    lines.push('<summary>📄 View script details</summary>');
    lines.push('');
    lines.push('```python:descriptive-filename.py');
    lines.push('# the actual script');
    lines.push('```');
    lines.push('');
    lines.push('</details>');
    lines.push('```');
    lines.push('');
    lines.push('The fenced code block MUST have a filename (e.g. `python:my-task.py`). Without a filename, the Execute button will not appear.');
    lines.push('The UI automatically adds an ⚡ Execute button outside the `<details>`. The user clicks it once to deploy and run.');

    return lines.join('\n');
  }

  async function loadSoulAndSkills() {
    // Ensure built-in souls cache is ready
    await loadBuiltinSouls();

    const soulUrl = getSessionSetting('soulUrl');

    if (!soulUrl) {
      soulOnlyInstruction = '';
      currentSoulName = '';
      applySkillsToInstruction();
      await restoreSessionSkills();
      return;
    }

    try {
      showToast('Loading SOUL…', 'info');

      // Check if this is a pre-loaded built-in soul (use cached content, no extra fetch)
      const builtin = BUILTIN_SOULS.find(s => s.url === soulUrl);
      if (builtin && builtin.content) {
        soulOnlyInstruction = `=== SOUL ===\n\n${builtin.content}`;
        currentSoulName = SoulLoader.extractSoulName(builtin.content);
        applySkillsToInstruction();
        await restoreSessionSkills();
        showToast(`Loaded: ${currentSoulName} + ${loadedSkillCount} skill(s)`, 'success');
        return;
      }
      const result = await SoulLoader.load({
        soulUrl,
        skillUrls: [], // Skills are managed at runtime via /skills
        notionToken: getSessionSetting('notionToken'),
        corsProxy: getSessionSetting('corsProxy'),
      });

      soulOnlyInstruction = result.systemInstruction; // SOUL text only (no skills yet)
      currentSoulName = result.soulName;
      applySkillsToInstruction(); // Compose final instruction with any already-loaded skills
      await restoreSessionSkills(); // Restore skills saved for this session

      showToast(`Loaded: ${currentSoulName} + ${loadedSkillCount} skill(s)`, 'success');
    } catch (err) {
      console.error('SOUL loading failed:', err);
      showToast(`SOUL loading failed: ${err.message}`, 'error');
      await restoreSessionSkills(); // Still try to restore skills even if SOUL failed
    }
  }

  /**
   * Rebuild & push the full system instruction.
   * LAYER 1: Only injects a compact skill menu (name + description).
   * Full skill bodies are injected per-request in resolveActiveSkill().
   */
  function applySkillsToInstruction() {
    const parts = [soulOnlyInstruction];

    if (loadedSkills.length > 0) {
      const menu = loadedSkills
        .map(s => `- **${s.meta?.name || 'Unnamed'}**: ${s.meta?.description || ''}`)
        .join('\n');
      parts.push(
        `=== AVAILABLE SKILLS ===\n\nYou have the following skills available. When a user request clearly matches one, reply FIRST with a single line:\n[[SKILL: <exact skill name>]]\nthen continue your response. Do NOT output this line if no skill is needed.\n\n${menu}`
      );
    }

    const ctx = buildSessionContext();
    baseSoulInstruction = parts.filter(Boolean).join('\n\n---\n\n');
    Chat.setSystemInstruction(baseSoulInstruction + (ctx ? '\n\n' + ctx : ''));
    loadedSkillCount = loadedSkills.length;
    updateSoulStatus();
  }

  /**
   * LAYER 2: Intercept a [[SKILL: Name]] signal in the first chunk of the model response.
   * If detected, transparently re-issue the request with the full skill body injected.
   * Returns { override: string|null } — the augmented system instruction to use, or null.
   */
  async function resolveSkillOverride(userText, apiKey, _model) {
    if (!loadedSkills.length) return null;

    // Skip preflight for very short / trivial messages
    if (userText.length < 6) return null;

    // Always use a fast, stable model for preflight — never the user's (possibly slow/broken) model
    const PREFLIGHT_MODEL = 'gemini-2.0-flash-lite';

    // Preflight: lightweight non-streaming call to detect which skill is needed
    const menu = loadedSkills
      .map(s => `- ${s.meta?.name || 'Unnamed'}: ${s.meta?.description || ''}`)
      .join('\n');

    const preflightPrompt = `You have these skills available:\n${menu}\n\nUser message: "${userText}"\n\nWhich skill (if any) is needed to best answer this? Reply with ONLY the exact skill name from the list above, or the single word none. No other text.`;

    // 5-second timeout to avoid indefinite hangs
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);

    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${PREFLIGHT_MODEL}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: preflightPrompt }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 32 },
          }),
          signal: ac.signal,
        }
      );
      clearTimeout(timer);
      if (!resp.ok) return null;
      const data = await resp.json();
      const pick = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'none';

      if (!pick || pick.toLowerCase() === 'none') return null;

      // Match back to a loaded skill (case-insensitive)
      const matched = loadedSkills.find(
        s => s.meta?.name?.toLowerCase() === pick.toLowerCase()
      );
      if (!matched) return null;

      // Build override: SOUL + full skill body + any other loaded skill metadata + context
      const menuOthers = loadedSkills
        .filter(s => s !== matched)
        .map(s => `- **${s.meta?.name}**: ${s.meta?.description || ''}`)
        .join('\n');

      const overrideParts = [soulOnlyInstruction];
      if (menuOthers) {
        overrideParts.push(`=== OTHER AVAILABLE SKILLS ===\n\n${menuOthers}`);
      }
      overrideParts.push(
        `=== ACTIVE SKILL: ${matched.meta?.name || 'Unnamed'} ===\n\n${matched.content}`
      );
      const ctx = buildSessionContext();
      const override = overrideParts.filter(Boolean).join('\n\n---\n\n') + (ctx ? '\n\n' + ctx : '');
      return { override, skillName: matched.meta?.name };
    } catch {
      clearTimeout(timer);
      return null;
    }
  }

  /**
   * Fetch a skill from a URL, parse it, add to loadedSkills, and apply.
   * Stores the source URL on the parsed object for later identity checks.
   */
  async function loadSkillFromUrl(url) {
    const raw = await SoulLoader.fetchRawText(url);
    const parsed = SoulLoader.parseSkillFile(raw);
    parsed.url = url;
    if (!loadedSkills.find(s => s.url === url)) {
      loadedSkills.push(parsed);
    }
    applySkillsToInstruction();
    saveSessionSkills(); // persist skill state for this session
    return parsed;
  }

  /**
   * Remove a loaded skill by URL and re-apply system instruction.
   */
  function unloadSkill(url) {
    loadedSkills = loadedSkills.filter(s => s.url !== url);
    applySkillsToInstruction();
    saveSessionSkills(); // persist skill state for this session
  }

  /**
   * Enable/disable the input area
   */
  function setInputEnabled(enabled) {
    const inputArea = document.querySelector('.input-area');
    const input = $('#message-input');
    const sendBtn = $('#send-btn');
    if (inputArea) {
      if (enabled) { inputArea.classList.remove('hidden'); }
      else         { inputArea.classList.add('hidden'); }
    }
    if (input) {
      input.disabled = !enabled;
      input.placeholder = enabled
        ? 'Type a message… (Enter to send, Shift+Enter for new line)'
        : 'Click + to start a new session';
    }
    if (sendBtn) sendBtn.disabled = !enabled;
  }

  // ─── Restore Sessions from GitHub ─────────────────────────────────

  function openRestoreDialog() {
    const dialog = $('#restore-dialog');
    show(dialog);
    // Pre-fill from global settings if available
    $('#restore-github-token').value = getSetting('githubToken', '');
    $('#restore-github-owner').value = getSetting('githubOwner', '');
    $('#restore-github-repo').value = getSetting('githubRepo', '');
    $('#restore-github-path').value = getSetting('githubPath', 'sessions');
    setRestoreStatus('', '');
    $('#restore-submit').disabled = false;
    $('#restore-github-token').focus();
  }

  function closeRestoreDialog() {
    hide('#restore-dialog');
    setRestoreStatus('', '');
  }

  function setRestoreStatus(message, type) {
    const el = $('#restore-status');
    if (!el) return;
    if (!message) {
      hide(el);
      el.textContent = '';
      el.className = 'restore-status hidden';
      return;
    }
    el.textContent = message;
    el.className = `restore-status status-${type}`;
    show(el);
  }

  async function submitRestore() {
    const token = $('#restore-github-token').value.trim();
    const owner = $('#restore-github-owner').value.trim();
    const repo  = $('#restore-github-repo').value.trim();
    const path  = $('#restore-github-path').value.trim() || 'sessions';

    if (!token || !owner || !repo) {
      setRestoreStatus('Please fill in Token, Owner, and Repository fields.', 'error');
      return;
    }

    const submitBtn = $('#restore-submit');
    submitBtn.disabled = true;
    setRestoreStatus('Connecting to GitHub…', 'loading');

    try {
      const config = { token, owner, repo, path };
      const remoteIds = await Storage.GitHub.list(config);

      if (remoteIds.length === 0) {
        setRestoreStatus('No sessions found in this repository.', 'error');
        submitBtn.disabled = false;
        return;
      }

      // Merge remote sessions into local index
      const localIndex = Storage.getIndex();
      const localIdSet = new Set(localIndex.map(s => s.id));
      let imported = 0;

      for (const id of remoteIds) {
        // Save GitHub credentials to each session's config for independent access
        const sessCfg = getSessionConfig(id);
        sessCfg.githubToken = token;
        sessCfg.githubOwner = owner;
        sessCfg.githubRepo = repo;
        sessCfg.githubPath = path;
        sessCfg.storageBackend = 'github';
        saveSessionConfig(id, sessCfg);

        if (localIdSet.has(id)) continue; // already in index
        const entry = {
          id,
          title: `GitHub Session (${id.slice(0, 8)}…)`,
          soulName: '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          backend: 'github',
        };
        localIndex.unshift(entry);
        imported++;
      }

      Storage.saveIndex(localIndex);

      // Also persist GitHub credentials globally as template for new sessions
      setSetting('githubToken', token);
      setSetting('githubOwner', owner);
      setSetting('githubRepo', repo);
      setSetting('githubPath', path);

      setRestoreStatus(
        `Found ${remoteIds.length} session(s), imported ${imported} new session(s).`,
        'success'
      );

      renderSidebar();

      // Auto-close after a short delay on success
      setTimeout(() => closeRestoreDialog(), 1500);
    } catch (err) {
      console.error('Restore failed:', err);
      setRestoreStatus(`Restore failed: ${err.message}`, 'error');
      submitBtn.disabled = false;
    }
  }

  // ─── Passphrase Dialog ────────────────────────────────────────────

  /**
   * Show passphrase dialog for decrypting a saved session.
   * Returns a Promise that resolves with the passphrase or null if cancelled.
   */
  function promptPassphrase(message) {
    return new Promise((resolve) => {
      const dialog = $('#passphrase-dialog');
      const msgEl = $('#passphrase-message');
      if (msgEl) msgEl.textContent = message || 'Enter the passphrase to decrypt this session.';
      show(dialog);
      const input = $('#passphrase-input');
      input.value = '';
      input.focus();
      dialog._resolve = resolve;
    });
  }

  function submitPassphrase() {
    const input = $('#passphrase-input');
    const val = input.value;
    if (!val) {
      showToast('Passphrase cannot be empty', 'error');
      return;
    }
    input.value = '';
    hide('#passphrase-dialog');
    const dialog = $('#passphrase-dialog');
    if (dialog._resolve) {
      dialog._resolve(val);
      dialog._resolve = null;
    }
  }

  function cancelPassphrase() {
    hide('#passphrase-dialog');
    const dialog = $('#passphrase-dialog');
    if (dialog._resolve) {
      dialog._resolve(null);
      dialog._resolve = null;
    }
  }

  // ─── Input Auto-Resize ────────────────────────────────────────────

  function autoResizeInput() {
    const input = $('#message-input');
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  }

  // ─── Sidebar Toggle ───────────────────────────────────────────────

  function toggleSidebar() {
    const sidebar = $('#sidebar');
    sidebar.classList.toggle('collapsed');
  }

  // ─── Init ──────────────────────────────────────────────────────────

  function init() {
    configureMarked();

    // Event listeners
    $('#send-btn')?.addEventListener('click', sendMessage);
    $('#stop-btn')?.addEventListener('click', () => {
      Chat.abort();
      setStreamingState(false);
      showToast('Generation stopped', 'info');
    });

    $('#message-input')?.addEventListener('keydown', (e) => {
      const isComposing = e.isComposing || e.keyCode === 229;

      // Slash autocomplete navigation
      if (!$('#slash-autocomplete').classList.contains('hidden')) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          slashAutocompleteMoveSelection(1);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          slashAutocompleteMoveSelection(-1);
          return;
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !isComposing && slashAutocompleteActiveIndex() >= 0)) {
          e.preventDefault();
          slashAutocompleteConfirm();
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          slashAutocompleteHide();
          return;
        }
      }
      if (e.key === 'Enter' && !e.shiftKey && !isComposing) {
        e.preventDefault();
        sendMessage();
      }
    });

    $('#message-input')?.addEventListener('input', () => {
      autoResizeInput();
      slashAutocompleteUpdate();
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.input-area')) slashAutocompleteHide();
    });

    $('#settings-btn')?.addEventListener('click', () => openSettings());
    $('#close-settings')?.addEventListener('click', closeSettings);
    $('#apply-settings')?.addEventListener('click', applySettings);

    // Toggle visibility for all password fields
    document.querySelectorAll('.password-toggle').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const inputId = btn.getAttribute('data-for');
        const input = $(`#${inputId}`);
        if (input) {
          const isPassword = input.type === 'password';
          input.type = isPassword ? 'text' : 'password';
          btn.textContent = isPassword ? '🙈' : '👁';
          input.focus();
        }
      });
    });

    $('#set-storage-backend')?.addEventListener('change', toggleStorageFields);
    $('#set-enable-thinking')?.addEventListener('change', toggleThinkingFields);
    $('#auto-create-repo-btn')?.addEventListener('click', autoCreateGitHubRepo);
    $('#set-action-use-storage')?.addEventListener('change', toggleActionFields);
    $('#auto-create-action-repo-btn')?.addEventListener('click', autoCreateActionRepo);

    $('#new-session-btn')?.addEventListener('click', () => {
      const pendingId = Storage.uuid();
      initSessionConfig(pendingId);
      openSettings(pendingId);
    });

    $('#sidebar-toggle')?.addEventListener('click', toggleSidebar);

    // Restore sessions dialog
    $('#restore-sessions-btn')?.addEventListener('click', openRestoreDialog);
    $('#restore-submit')?.addEventListener('click', submitRestore);
    $('#restore-cancel')?.addEventListener('click', closeRestoreDialog);

    // Passphrase dialog
    $('#passphrase-submit')?.addEventListener('click', submitPassphrase);
    $('#passphrase-cancel')?.addEventListener('click', cancelPassphrase);
    $('#passphrase-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitPassphrase();
      }
    });

    // Reload SOUL button — persist current form values first so the fetch uses what's in the inputs
    $('#reload-soul-btn')?.addEventListener('click', async () => {
      const panel = $('#settings-panel');
      const isOpen = panel && !panel.classList.contains('hidden');
      if (isOpen && settingsTarget && settingsTarget === currentSessionId) {
        const cfg = getSessionConfig(settingsTarget);
        const soulPreset = $('#set-soul-preset').value;
        cfg.soulUrl     = soulPreset === '__custom__' ? $('#set-soul-url').value.trim() : soulPreset;
        cfg.notionToken = $('#set-notion-token').value.trim();
        cfg.corsProxy   = $('#set-cors-proxy').value.trim();
        saveSessionConfig(settingsTarget, cfg);
      }
      await loadSoulAndSkills();
    });

    $('#set-soul-preset')?.addEventListener('change', toggleSoulUrlField);

    // Load built-in SOUL list, then render sidebar
    loadBuiltinSouls();

    // No session on startup — show landing, disable input
    showLanding();
    setInputEnabled(false);
    renderSidebar();
  }

  // ─── Expose ────────────────────────────────────────────────────────
  return { init };
})();

export default App;

// Boot
document.addEventListener('DOMContentLoaded', App.init);
