/**
 * storage.js — Encrypted session persistence to GitHub / Notion / localStorage
 *
 * Session index (titles, ids, timestamps) lives in localStorage unencrypted.
 * Session content (messages) is AES-256-GCM encrypted before writing anywhere.
 */

import Crypto from './crypto.js';

const Storage = (() => {
  /* eslint-disable -- keeping original structure */
  const INDEX_KEY = 'browseragent_sessions_index';
  const DEFAULT_CORS_PROXY = 'https://corsproxy.io/?url=';

  // ─── Session Index (always localStorage) ───────────────────────────

  function getIndex() {
    try {
      return JSON.parse(localStorage.getItem(INDEX_KEY)) || [];
    } catch {
      return [];
    }
  }

  function saveIndex(index) {
    localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  }

  function addToIndex(session) {
    const index = getIndex();
    const existing = index.findIndex((s) => s.id === session.id);
    const entry = {
      id: session.id,
      title: session.title,
      soulName: session.soulName || '',
      createdAt: session.createdAt,
      updatedAt: new Date().toISOString(),
      backend: session.backend || 'local',
    };
    if (existing >= 0) {
      index[existing] = entry;
    } else {
      index.unshift(entry);
    }
    saveIndex(index);
  }

  function removeFromIndex(sessionId) {
    const index = getIndex().filter((s) => s.id !== sessionId);
    saveIndex(index);
  }

  // ─── UUID v4 ───────────────────────────────────────────────────────

  function uuid() {
    return crypto.randomUUID?.() || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(
      /[xy]/g,
      (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      }
    );
  }

  // ─── Local Storage Backend ─────────────────────────────────────────

  const Local = {
    async save(sessionData, passphrase) {
      const json = JSON.stringify(sessionData);
      const encrypted = await Crypto.encrypt(passphrase, json);
      localStorage.setItem(`session_${sessionData.id}`, encrypted);
      addToIndex(sessionData);
    },

    async load(sessionId, passphrase) {
      const blob = localStorage.getItem(`session_${sessionId}`);
      if (!blob) throw new Error('Session not found locally');
      const json = await Crypto.decrypt(passphrase, blob);
      return JSON.parse(json);
    },

    async remove(sessionId) {
      localStorage.removeItem(`session_${sessionId}`);
      removeFromIndex(sessionId);
    },
  };

  // ─── GitHub Backend ────────────────────────────────────────────────

  const GitHub = {
    /**
     * Save encrypted session to GitHub repo
     * @param {Object} sessionData
     * @param {string} passphrase
     * @param {Object} config - { token, owner, repo, path? }
     */
    async save(sessionData, passphrase, config) {
      const json = JSON.stringify(sessionData);
      const encrypted = await Crypto.encrypt(passphrase, json);

      const filePath = `${config.path || 'sessions'}/${sessionData.id}.enc`;
      const apiUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${filePath}`;

      // Check if file exists (to get SHA for update)
      let sha;
      try {
        const existing = await fetch(apiUrl, {
          headers: {
            Authorization: `Bearer ${config.token}`,
            Accept: 'application/vnd.github.v3+json',
          },
        });
        if (existing.ok) {
          const data = await existing.json();
          sha = data.sha;
        }
      } catch {
        // File doesn't exist, that's fine
      }

      const body = {
        message: `Update session ${sessionData.id}`,
        content: btoa(unescape(encodeURIComponent(encrypted))),
        ...(sha ? { sha } : {}),
      };

      const resp = await fetch(apiUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${config.token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`GitHub save failed (${resp.status}): ${err}`);
      }

      sessionData.backend = 'github';
      addToIndex(sessionData);
    },

    /**
     * Load encrypted session from GitHub repo
     */
    async load(sessionId, passphrase, config) {
      const filePath = `${config.path || 'sessions'}/${sessionId}.enc`;
      const apiUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${filePath}`;

      const resp = await fetch(apiUrl, {
        headers: {
          Authorization: `Bearer ${config.token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      });

      if (!resp.ok) throw new Error(`GitHub load failed: ${resp.status}`);

      const data = await resp.json();
      const encrypted = decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))));
      const json = await Crypto.decrypt(passphrase, encrypted);
      return JSON.parse(json);
    },

    /**
     * Remove session from GitHub repo
     */
    async remove(sessionId, config) {
      const filePath = `${config.path || 'sessions'}/${sessionId}.enc`;
      const apiUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${filePath}`;

      // Get SHA first
      const existing = await fetch(apiUrl, {
        headers: {
          Authorization: `Bearer ${config.token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      });

      if (existing.ok) {
        const data = await existing.json();
        await fetch(apiUrl, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${config.token}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: `Delete session ${sessionId}`,
            sha: data.sha,
          }),
        });
      }

      removeFromIndex(sessionId);
    },

    /**
     * List all sessions from GitHub repo
     */
    async list(config) {
      const dirPath = config.path || 'sessions';
      const apiUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${dirPath}`;

      const resp = await fetch(apiUrl, {
        headers: {
          Authorization: `Bearer ${config.token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      });

      if (!resp.ok) return [];
      const files = await resp.json();
      return (Array.isArray(files) ? files : [])
        .filter((f) => f.name.endsWith('.enc'))
        .map((f) => f.name.replace('.enc', ''));
    },
  };

  // ─── Notion Backend ────────────────────────────────────────────────

  const Notion = {
    /**
     * Save encrypted session as a Notion page (child of parentPageId)
     */
    async save(sessionData, passphrase, config) {
      const json = JSON.stringify(sessionData);
      const encrypted = await Crypto.encrypt(passphrase, json);

      const proxy = config.corsProxy || DEFAULT_CORS_PROXY;
      const apiUrl = `${proxy}${encodeURIComponent(
        'https://api.notion.com/v1/pages'
      )}`;

      // Split encrypted content into chunks of 2000 chars (Notion limit)
      const chunks = [];
      for (let i = 0; i < encrypted.length; i += 2000) {
        chunks.push(encrypted.slice(i, i + 2000));
      }

      const body = {
        parent: { page_id: config.parentPageId },
        properties: {
          title: {
            title: [
              {
                text: {
                  content: `[BrowserAgent] ${sessionData.title} | ${sessionData.id}`,
                },
              },
            ],
          },
        },
        children: chunks.map((chunk) => ({
          object: 'block',
          type: 'code',
          code: {
            rich_text: [{ type: 'text', text: { content: chunk } }],
            language: 'plain text',
          },
        })),
      };

      const resp = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.token}`,
          'Content-Type': 'application/json',
          'Notion-Version': '2022-06-28',
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`Notion save failed (${resp.status}): ${err}`);
      }

      const result = await resp.json();
      // Store the Notion page ID for future updates
      sessionData.notionPageId = result.id;
      sessionData.backend = 'notion';
      addToIndex(sessionData);
    },

    /**
     * Load encrypted session from a Notion page
     */
    async load(sessionId, passphrase, config) {
      const index = getIndex();
      const entry = index.find((s) => s.id === sessionId);
      if (!entry?.notionPageId) {
        throw new Error('Notion page ID not found in index');
      }

      const proxy = config.corsProxy || DEFAULT_CORS_PROXY;
      const apiUrl = `${proxy}${encodeURIComponent(
        `https://api.notion.com/v1/blocks/${entry.notionPageId}/children?page_size=100`
      )}`;

      const resp = await fetch(apiUrl, {
        headers: {
          Authorization: `Bearer ${config.token}`,
          'Notion-Version': '2022-06-28',
        },
      });

      if (!resp.ok) throw new Error(`Notion load failed: ${resp.status}`);
      const data = await resp.json();

      // Reassemble encrypted content from code blocks
      const encrypted = (data.results || [])
        .filter((b) => b.type === 'code')
        .map((b) => b.code.rich_text.map((rt) => rt.plain_text).join(''))
        .join('');

      const json = await Crypto.decrypt(passphrase, encrypted);
      return JSON.parse(json);
    },

    async remove(sessionId, config) {
      // Notion API doesn't have a true delete from client — we archive the page
      const index = getIndex();
      const entry = index.find((s) => s.id === sessionId);
      if (entry?.notionPageId) {
        const proxy = config.corsProxy || DEFAULT_CORS_PROXY;
        const apiUrl = `${proxy}${encodeURIComponent(
          `https://api.notion.com/v1/pages/${entry.notionPageId}`
        )}`;

        await fetch(apiUrl, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${config.token}`,
            'Content-Type': 'application/json',
            'Notion-Version': '2022-06-28',
          },
          body: JSON.stringify({ archived: true }),
        });
      }
      removeFromIndex(sessionId);
    },
  };

  // ─── Public API ────────────────────────────────────────────────────

  return {
    uuid,
    getIndex,
    saveIndex,
    removeFromIndex,
    Local,
    GitHub,
    Notion,
  };
})();

export default Storage;
