/**
 * github-actions.js — Push artifacts to GitHub & trigger Actions workflows
 *
 * Uses GitHub Trees API for atomic multi-file commits,
 * workflow_dispatch API for triggering runs, and
 * Actions API for polling status and fetching logs.
 */

import nacl from 'tweetnacl';

const GitHubActions = (() => {
  /* eslint-disable -- keeping original structure */
  const API = 'https://api.github.com';

  function hdrs(token) {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    };
  }

  // ─── Repo helpers ──────────────────────────────────────────────────

  async function getUser(token) {
    const resp = await fetch(`${API}/user`, { headers: hdrs(token) });
    if (!resp.ok) throw new Error('Invalid GitHub token');
    return resp.json();
  }

  async function repoExists(token, owner, repo) {
    const resp = await fetch(`${API}/repos/${owner}/${repo}`, { headers: hdrs(token) });
    return resp.ok;
  }

  async function createRepo(token, name, isPrivate = false) {
    const resp = await fetch(`${API}/user/repos`, {
      method: 'POST',
      headers: hdrs(token),
      body: JSON.stringify({
        name,
        description: 'BrowserAgent execution environment',
        private: isPrivate,
        auto_init: true,
      }),
    });
    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.message || `Create repo failed: ${resp.status}`);
    }
    return resp.json();
  }

  // ─── Atomic multi-file push (Trees API) ────────────────────────────

  /**
   * Push one or more files in a single atomic commit.
   * @param {Object}   config       - { token, owner, repo, branch }
   * @param {Array}    files        - [{ path: 'dir/file.py', content: '...' }, …]
   * @param {string}   message      - commit message
   */
  async function pushFiles(config, files, message = 'Push artifacts from BrowserAgent') {
    const { token, owner, repo, branch = 'main' } = config;
    const h = hdrs(token);

    // 1. Current branch tip
    const refResp = await fetch(
      `${API}/repos/${owner}/${repo}/git/ref/heads/${branch}`,
      { headers: h }
    );
    if (!refResp.ok) throw new Error(`Branch "${branch}" not found`);
    const latestSha = (await refResp.json()).object.sha;

    // 2. Base tree
    const commitResp = await fetch(
      `${API}/repos/${owner}/${repo}/git/commits/${latestSha}`,
      { headers: h }
    );
    const baseTreeSha = (await commitResp.json()).tree.sha;

    // 3. Create blobs
    const treeItems = [];
    for (const file of files) {
      const blobResp = await fetch(`${API}/repos/${owner}/${repo}/git/blobs`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ content: file.content, encoding: 'utf-8' }),
      });
      if (!blobResp.ok) throw new Error(`Blob creation failed for ${file.path}`);
      treeItems.push({
        path: file.path,
        mode: '100644',
        type: 'blob',
        sha: (await blobResp.json()).sha,
      });
    }

    // 4. New tree
    const treeResp = await fetch(`${API}/repos/${owner}/${repo}/git/trees`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems }),
    });
    if (!treeResp.ok) throw new Error('Tree creation failed');
    const newTreeSha = (await treeResp.json()).sha;

    // 5. New commit
    const newCommitResp = await fetch(`${API}/repos/${owner}/${repo}/git/commits`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ message, tree: newTreeSha, parents: [latestSha] }),
    });
    if (!newCommitResp.ok) throw new Error('Commit creation failed');
    const newCommitData = await newCommitResp.json();

    // 6. Update branch ref (force:true handles non-fast-forward and race conditions)
    const updateResp = await fetch(
      `${API}/repos/${owner}/${repo}/git/refs/heads/${branch}`,
      { method: 'PATCH', headers: h, body: JSON.stringify({ sha: newCommitData.sha, force: true }) }
    );
    if (!updateResp.ok) {
      const errBody = await updateResp.text();
      throw new Error(`Branch update failed (${updateResp.status}): ${errBody}`);
    }

    return newCommitData;
  }

  // ─── Workflow management ───────────────────────────────────────────

  async function ensureWorkflow(config, workflowPath = '.github/workflows/execute.yml') {
    // Always overwrite so the latest workflow template is always in the repo

    const yaml = [
      '# browseragent-workflow: v3',
      'name: Execute Artifact',
      '',
      'on:',
      '  workflow_dispatch:',
      '    inputs:',
      '      entrypoint:',
      "        description: 'Entry point file to execute'",
      '        required: true',
      "        default: 'main.py'",
      '      language:',
      "        description: 'Language runtime (python/node/bash)'",
      '        required: true',
      "        default: 'python'",
      '      args:',
      "        description: 'Extra arguments'",
      '        required: false',
      "        default: ''",
      '',
      'jobs:',
      '  execute:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '',
      '      - name: Setup Python',
      "        if: inputs.language == 'python'",
      '        uses: actions/setup-python@v5',
      '        with:',
      "          python-version: '3.12'",
      '',
      '      - name: Setup Node.js',
      "        if: inputs.language == 'node'",
      '        uses: actions/setup-node@v4',
      '        with:',
      "          node-version: '20'",
      '',
      '      - name: Install Python deps',
      "        if: inputs.language == 'python' && hashFiles('requirements.txt') != ''",
      '        run: pip install -r requirements.txt',
      '',
      '      - name: Install Node deps',
      "        if: inputs.language == 'node' && hashFiles('package.json') != ''",
      '        run: npm install',
      '',
      '      - name: Execute',
      '        id: run_artifact',
      '        run: |',
      '          EXIT_CODE=0',
      '          OUT=/tmp/_browseragent_output.txt',
      '          case "${{ inputs.language }}" in',
      '            python) python "${{ inputs.entrypoint }}" ${{ inputs.args }} > "$OUT" 2>&1 || EXIT_CODE=$? ;;',
      '            node)   node   "${{ inputs.entrypoint }}" ${{ inputs.args }} > "$OUT" 2>&1 || EXIT_CODE=$? ;;',
      '            bash|shell|sh) bash "${{ inputs.entrypoint }}" ${{ inputs.args }} > "$OUT" 2>&1 || EXIT_CODE=$? ;;',
      '            *) echo "Unsupported language: ${{ inputs.language }}" > "$OUT" ; EXIT_CODE=1 ;;',
      '          esac',
      '          echo BROWSERAGENT_OUTPUT_BEGIN',
      '          cat "$OUT"',
      '          echo BROWSERAGENT_OUTPUT_END',
      '          echo "BROWSERAGENT_EXIT_CODE=${EXIT_CODE}"',
      '          exit $EXIT_CODE',
    ].join('\n');

    await pushFiles(config, [{ path: workflowPath, content: yaml }],
      'Update execute workflow to v3');

    // Give GitHub time to register the workflow
    await new Promise((r) => setTimeout(r, 2000));
  }

  /**
   * Trigger workflow_dispatch.
   * @param {Object} config        - { token, owner, repo, branch }
   * @param {string} workflowFile  - e.g. 'execute.yml'
   * @param {Object} inputs        - key/value pairs for the workflow inputs
   */
  async function dispatchWorkflow(config, workflowFile = 'execute.yml', inputs = {}) {
    const { token, owner, repo, branch = 'main' } = config;
    const resp = await fetch(
      `${API}/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`,
      {
        method: 'POST',
        headers: hdrs(token),
        body: JSON.stringify({ ref: branch, inputs }),
      }
    );
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Dispatch failed (${resp.status}): ${body}`);
    }
    return true; // 204 No Content
  }

  // ─── Run monitoring ────────────────────────────────────────────────

  async function findLatestRun(config, workflowFile = 'execute.yml') {
    const { token, owner, repo, branch = 'main' } = config;
    const h = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' };
    const resp = await fetch(
      `${API}/repos/${owner}/${repo}/actions/workflows/${workflowFile}/runs?branch=${branch}&per_page=1&event=workflow_dispatch`,
      { headers: h }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.workflow_runs?.[0] || null;
  }

  async function getRun(config, runId) {
    const { token, owner, repo } = config;
    const h = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' };
    const resp = await fetch(`${API}/repos/${owner}/${repo}/actions/runs/${runId}`, { headers: h });
    if (!resp.ok) throw new Error(`Get run failed: ${resp.status}`);
    return resp.json();
  }

  async function getRunJobs(config, runId) {
    const { token, owner, repo } = config;
    const h = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' };
    const resp = await fetch(`${API}/repos/${owner}/${repo}/actions/runs/${runId}/jobs`, { headers: h });
    if (!resp.ok) throw new Error(`Get jobs failed: ${resp.status}`);
    return resp.json();
  }

  async function getJobLogs(config, jobId) {
    const { token, owner, repo } = config;
    const h = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' };
    const resp = await fetch(`${API}/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`, {
      headers: h,
      redirect: 'follow',
    });
    if (!resp.ok) throw new Error(`Get logs failed: ${resp.status}`);
    return resp.text();
  }

  /**
   * Poll a workflow run until it completes or times out.
   * @param {Function} onStatus - called with run object on each poll
   * @returns {Object} final run object
   */
  async function pollRun(config, runId, onStatus, intervalMs = 5000, timeoutMs = 600000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const run = await getRun(config, runId);
      if (onStatus) onStatus(run);
      if (run.status === 'completed') return run;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error('Workflow run timed out');
  }

  // ─── Artifact extraction from Markdown ─────────────────────────────

  /**
   * Parse code blocks from raw Markdown text.
   * Supports:  ```python:main.py   or   # filename: main.py  as first line
   * Falls back to auto-generated filename from language.
   */
  function extractArtifacts(rawText) {
    const artifacts = [];
    const regex = /```(\w+)?(?::([^\n]+))?\n([\s\S]*?)```/g;
    let match;

    while ((match = regex.exec(rawText)) !== null) {
      const language = (match[1] || 'text').toLowerCase();
      let filename = match[2]?.trim() || null;
      const code = match[3];

      // Try detecting filename from a header comment
      if (!filename) {
        const firstLine = code.split('\n')[0].trim();
        const cm = firstLine.match(
          /^(?:#|\/\/|\/\*|--|;)\s*(?:file(?:name)?|name):\s*(.+?)(?:\s*\*\/)?$/i
        );
        if (cm) filename = cm[1].trim();
      }

      // Auto-generate from language
      if (!filename) {
        const ext = {
          python: 'py', javascript: 'js', typescript: 'ts', jsx: 'jsx', tsx: 'tsx',
          bash: 'sh', shell: 'sh', sh: 'sh', zsh: 'sh',
          yaml: 'yml', yml: 'yml', json: 'json', xml: 'xml',
          html: 'html', css: 'css', scss: 'scss',
          go: 'go', rust: 'rs', java: 'java', kotlin: 'kt',
          cpp: 'cpp', c: 'c', csharp: 'cs',
          ruby: 'rb', php: 'php', sql: 'sql',
          dockerfile: 'Dockerfile', makefile: 'Makefile',
          text: 'txt', markdown: 'md', md: 'md',
        }[language] || 'txt';
        const idx = artifacts.length + 1;
        filename = idx === 1 ? `artifact.${ext}` : `artifact_${idx}.${ext}`;
      }

      artifacts.push({ language, filename, code: code.trimEnd() });
    }
    return artifacts;
  }

  /**
   * Extract the program output from raw GitHub Actions logs.
   * Looks for content between ===BROWSERAGENT_OUTPUT_BEGIN=== and ===BROWSERAGENT_OUTPUT_END===.
   * Also extracts the exit code if present.
   * Falls back to a best-effort cleanup of the raw log.
   */
  function parseLogOutput(rawLog) {
    // Strip GitHub Actions timestamp prefixes (e.g. "2026-03-01T12:57:20.2943324Z ")
    // and ANSI color/style escape codes (e.g. "\x1b[36;1m...\x1b[0m")
    const lines = rawLog.split('\n').map(line =>
      line
        .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, '')
        .replace(/\x1b\[[\d;]*m/g, '')
    );

    // ── v3 markers: plain tokens (no === wrappers) to avoid echo-preview collisions ──
    const beginIdx = lines.findIndex(l => l.trim() === 'BROWSERAGENT_OUTPUT_BEGIN');
    const endIdx   = lines.findIndex(l => l.trim() === 'BROWSERAGENT_OUTPUT_END');

    let output;
    let exitCode = null;

    if (beginIdx >= 0 && endIdx > beginIdx) {
      output = lines.slice(beginIdx + 1, endIdx).join('\n').trim();
    } else {
      // ── Fallback for old workflows or unexpected formats ──
      // GitHub always prints env vars ending with LD_LIBRARY_PATH before actual output,
      // and "Post job cleanup." after the last step's output.
      const ldIdx = lines.reduce((last, l, i) =>
        l.trim().startsWith('LD_LIBRARY_PATH:') ? i : last, -1);
      const cleanupIdx = lines.findIndex(l => l.trim() === 'Post job cleanup.');

      if (ldIdx >= 0 && cleanupIdx > ldIdx) {
        output = lines.slice(ldIdx + 1, cleanupIdx)
          .filter(l => l.trim() && !l.startsWith('##[') && !l.startsWith('[command]'))
          .join('\n').trim();
      } else {
        // Last-resort: strip control/meta lines
        output = lines
          .filter(l => l.trim() &&
            !l.startsWith('##[') &&
            !l.startsWith('[command]') &&
            !l.match(/^\s+(\w+Location|\w+_ROOT_DIR|LD_LIBRARY_PATH|PKG_CONFIG_PATH|python\w*|node\w*)\s*:/) &&
            !l.startsWith('Post job cleanup.') &&
            !l.startsWith('Cleaning up'))
          .join('\n').trim();
      }
    }

    // Extract exit code (v3: BROWSERAGENT_EXIT_CODE=N, v2: ===BROWSERAGENT_EXIT_CODE=N===)
    const exitRe = /(?:===)?BROWSERAGENT_EXIT_CODE=(\d+)(?:===)?/;
    for (const line of lines) {
      const m = line.match(exitRe);
      if (m) { exitCode = parseInt(m[1], 10); break; }
    }

    return { output, exitCode };
  }

  /**
   * Map a code-block language tag to an Actions runtime name.
   */
  function detectRuntime(language) {
    const map = {
      python: 'python', py: 'python',
      javascript: 'node', js: 'node', typescript: 'node', ts: 'node',
      jsx: 'node', tsx: 'node',
      bash: 'bash', shell: 'bash', sh: 'bash', zsh: 'bash',
    };
    return map[language] || 'bash';
  }

  // ─── Repo Secrets & Variables ──────────────────────────────────────

  // ── Minimal BLAKE2b (RFC 7693) for sealed-box nonce derivation ─────
  // Only supports unkeyed hashing with arbitrary output length.
  const _blake2b = (() => {
    const IV = new Uint32Array([
      0xF3BCC908, 0x6A09E667, 0x84CAA73B, 0xBB67AE85,
      0xFE94F82B, 0x3C6EF372, 0x5F1D36F1, 0xA54FF53A,
      0xADE682D1, 0x510E527F, 0x2B3E6C1F, 0x9B05688C,
      0xFB41BD6B, 0x1F83D9AB, 0x137E2179, 0x5BE0CD19,
    ]);
    const SIGMA = [
      [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],
      [14,10,4,8,9,15,13,6,1,12,0,2,11,7,5,3],
      [11,8,12,0,5,2,15,13,10,14,3,6,7,1,9,4],
      [7,9,3,1,13,12,11,14,2,6,5,10,4,0,15,8],
      [9,0,5,7,2,4,10,15,14,1,11,12,6,8,3,13],
      [2,12,6,10,0,11,8,3,4,13,7,5,15,14,1,9],
      [12,5,1,15,14,13,4,10,0,7,6,3,9,2,8,11],
      [13,11,7,14,12,1,3,9,5,0,15,4,8,6,2,10],
      [6,15,14,9,11,3,0,8,12,2,13,7,1,4,10,5],
      [10,2,8,4,7,6,1,5,15,11,9,14,3,12,13,0],
      [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],
      [14,10,4,8,9,15,13,6,1,12,0,2,11,7,5,3],
    ];
    function ADD64(v, a, b) {
      const o0 = v[a] + v[b];
      let o1 = v[a+1] + v[b+1];
      if (o0 >= 0x100000000) o1++;
      v[a] = o0; v[a+1] = o1;
    }
    function ADD64_32(v, a, lo, hi) {
      let o0 = v[a] + lo;
      let o1 = v[a+1] + hi;
      if (o0 >= 0x100000000) o1++;
      v[a] = o0; v[a+1] = o1;
    }
    function G(v, a, b, c, d, ix, iy, m) {
      ADD64(v, a, b); ADD64_32(v, a, m[ix], m[ix+1]);
      let x0 = v[d] ^ v[a], x1 = v[d+1] ^ v[a+1];
      v[d] = x1; v[d+1] = x0;
      ADD64(v, c, d);
      x0 = v[b] ^ v[c]; x1 = v[b+1] ^ v[c+1];
      v[b] = (x0 >>> 24) ^ (x1 << 8);
      v[b+1] = (x1 >>> 24) ^ (x0 << 8);
      ADD64(v, a, b); ADD64_32(v, a, m[iy], m[iy+1]);
      x0 = v[d] ^ v[a]; x1 = v[d+1] ^ v[a+1];
      v[d] = (x0 >>> 16) ^ (x1 << 16);
      v[d+1] = (x1 >>> 16) ^ (x0 << 16);
      ADD64(v, c, d);
      x0 = v[b] ^ v[c]; x1 = v[b+1] ^ v[c+1];
      v[b] = (x1 >>> 31) ^ (x0 << 1);
      v[b+1] = (x0 >>> 31) ^ (x1 << 1);
    }
    function compress(ctx, last) {
      const v = new Uint32Array(32);
      const m = new Uint32Array(32);
      for (let i = 0; i < 16; i++) v[i] = ctx.h[i];
      for (let i = 0; i < 16; i++) v[i + 16] = IV[i];
      v[24] ^= ctx.t; v[25] ^= ctx.t_hi;
      if (last) { v[28] = ~v[28]; v[29] = ~v[29]; }
      for (let i = 0; i < 32; i++) {
        m[i] = ctx.b[i*4] | (ctx.b[i*4+1] << 8) | (ctx.b[i*4+2] << 16) | (ctx.b[i*4+3] << 24);
      }
      for (let i = 0; i < 12; i++) {
        const s = SIGMA[i];
        G(v,0,8,16,24,s[0]*2,s[1]*2,m);
        G(v,2,10,18,26,s[2]*2,s[3]*2,m);
        G(v,4,12,20,28,s[4]*2,s[5]*2,m);
        G(v,6,14,22,30,s[6]*2,s[7]*2,m);
        G(v,0,10,20,30,s[8]*2,s[9]*2,m);
        G(v,2,12,22,24,s[10]*2,s[11]*2,m);
        G(v,4,14,16,26,s[12]*2,s[13]*2,m);
        G(v,6,8,18,28,s[14]*2,s[15]*2,m);
      }
      for (let i = 0; i < 16; i++) ctx.h[i] ^= v[i] ^ v[i + 16];
    }
    return function blake2b(input, outlen) {
      const ctx = {
        h: new Uint32Array(IV), b: new Uint8Array(128),
        c: 0, t: 0, t_hi: 0,
      };
      ctx.h[0] ^= 0x01010000 ^ outlen;
      for (let i = 0; i < input.length; i++) {
        if (ctx.c === 128) {
          ctx.t += ctx.c;
          if (ctx.t >= 0x100000000) { ctx.t_hi++; ctx.t -= 0x100000000; }
          ctx.c = 0; compress(ctx, false);
        }
        ctx.b[ctx.c++] = input[i];
      }
      ctx.t += ctx.c;
      if (ctx.t >= 0x100000000) { ctx.t_hi++; ctx.t -= 0x100000000; }
      while (ctx.c < 128) ctx.b[ctx.c++] = 0;
      compress(ctx, true);
      const out = new Uint8Array(outlen);
      for (let i = 0; i < outlen; i++) out[i] = (ctx.h[i >> 2] >> (8 * (i & 3))) & 0xFF;
      return out;
    };
  })();

  /**
   * Get the repo's Actions public key for encrypting secrets.
   */
  async function getPublicKey(config) {
    const { token, owner, repo } = config;
    const resp = await fetch(
      `${API}/repos/${owner}/${repo}/actions/secrets/public-key`,
      { headers: hdrs(token) }
    );
    if (!resp.ok) throw new Error(`Failed to get public key: ${resp.status}`);
    return resp.json(); // { key_id, key }
  }

  /**
   * Encrypt a secret value using the repo's public key.
   * Implements libsodium's crypto_box_seal:
   *   nonce = blake2b(ephemeralPK || recipientPK, outlen=24)
   *   ciphertext = nacl.box(message, nonce, recipientPK, ephemeralSK)
   *   output = ephemeralPK (32 bytes) + ciphertext
   * Requires tweetnacl (nacl global). blake2b is inlined above.
   */
  function encryptSecret(publicKeyB64, secretValue) {
    const publicKey = Uint8Array.from(atob(publicKeyB64), c => c.charCodeAt(0));
    const message   = new TextEncoder().encode(secretValue);

    // Generate ephemeral keypair
    const ek = nacl.box.keyPair();

    // Derive nonce: blake2b(ephemeralPK || recipientPK, outlen=24)
    const nonceInput = new Uint8Array(ek.publicKey.length + publicKey.length);
    nonceInput.set(ek.publicKey);
    nonceInput.set(publicKey, ek.publicKey.length);
    const nonce = _blake2b(nonceInput, 24);

    // Encrypt with nacl.box
    const ciphertext = nacl.box(message, nonce, publicKey, ek.secretKey);
    if (!ciphertext) throw new Error('nacl.box encryption failed');

    // Output: ephemeralPK (32 bytes) + ciphertext
    const sealed = new Uint8Array(ek.publicKey.length + ciphertext.length);
    sealed.set(ek.publicKey);
    sealed.set(ciphertext, ek.publicKey.length);

    let binary = '';
    for (let i = 0; i < sealed.length; i++) binary += String.fromCharCode(sealed[i]);
    return btoa(binary);
  }

  /**
   * Create or update a repository Actions secret.
   * @param {Object} config - { token, owner, repo }
   * @param {string} secretName - e.g. 'GEMINI_API_KEY'
   * @param {string} secretValue - the plaintext value
   */
  async function setRepoSecret(config, secretName, secretValue) {
    const { token, owner, repo } = config;
    const { key, key_id } = await getPublicKey(config);
    const encryptedValue = encryptSecret(key, secretValue);

    const resp = await fetch(
      `${API}/repos/${owner}/${repo}/actions/secrets/${secretName}`,
      {
        method: 'PUT',
        headers: hdrs(token),
        body: JSON.stringify({
          encrypted_value: encryptedValue,
          key_id: key_id,
        }),
      }
    );
    if (!resp.ok && resp.status !== 201 && resp.status !== 204) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.message || `Set secret failed: ${resp.status}`);
    }
  }

  /**
   * Create or update a repository Actions variable.
   * @param {Object} config - { token, owner, repo }
   * @param {string} varName - e.g. 'NOTIFY_EMAIL'
   * @param {string} varValue - the value
   */
  async function setRepoVariable(config, varName, varValue) {
    const { token, owner, repo } = config;

    // Check if variable already exists to avoid 409 console noise
    const getResp = await fetch(
      `${API}/repos/${owner}/${repo}/actions/variables/${varName}`,
      { headers: hdrs(token) }
    );

    if (getResp.ok) {
      // Variable exists — update via PATCH
      const patchResp = await fetch(
        `${API}/repos/${owner}/${repo}/actions/variables/${varName}`,
        {
          method: 'PATCH',
          headers: hdrs(token),
          body: JSON.stringify({ value: varValue }),
        }
      );
      if (patchResp.ok || patchResp.status === 204) return;
      const err = await patchResp.json().catch(() => ({}));
      throw new Error(err.message || `Update variable failed: ${patchResp.status}`);
    }

    // Variable doesn't exist — create via POST
    const postResp = await fetch(
      `${API}/repos/${owner}/${repo}/actions/variables`,
      {
        method: 'POST',
        headers: hdrs(token),
        body: JSON.stringify({ name: varName, value: varValue }),
      }
    );
    if (postResp.ok || postResp.status === 201) return;
    const err = await postResp.json().catch(() => ({}));
    throw new Error(err.message || `Set variable failed: ${postResp.status}`);
  }

  /**
   * Sync all required secrets and variables for scheduled tasks.
   * Reads values from the provided settings map and pushes to the repo.
   * @param {Object} config - { token, owner, repo }
   * @param {Object} settings - { geminiApiKey?, qwenApiKey?, resendApiKey?, notifyEmail? }
   * @returns {Object} { synced: string[], skipped: string[], errors: string[] }
   */
  async function syncSecretsAndVars(config, settings) {
    const synced = [];
    const skipped = [];
    const errors = [];

    // Secrets
    const secrets = [
      { name: 'GEMINI_API_KEY', value: settings.geminiApiKey },
      { name: 'QWEN_API_KEY', value: settings.qwenApiKey },
      { name: 'RESEND_API_KEY', value: settings.resendApiKey },
    ];

    for (const s of secrets) {
      if (!s.value) {
        skipped.push(s.name);
        continue;
      }
      try {
        await setRepoSecret(config, s.name, s.value);
        synced.push(s.name);
      } catch (e) {
        errors.push(`${s.name}: ${e.message}`);
      }
    }

    // Variables
    if (settings.notifyEmail) {
      try {
        await setRepoVariable(config, 'NOTIFY_EMAIL', settings.notifyEmail);
        synced.push('NOTIFY_EMAIL');
      } catch (e) {
        errors.push(`NOTIFY_EMAIL: ${e.message}`);
      }
    } else {
      skipped.push('NOTIFY_EMAIL');
    }

    return { synced, skipped, errors };
  }

  // ─── Status / Inspection ──────────────────────────────────────────

  /**
   * List all workflows in a repo.
   * @returns {Array} workflow objects with { id, name, path, state }
   */
  async function listWorkflows(config) {
    const { token, owner, repo } = config;
    const resp = await fetch(
      `${API}/repos/${owner}/${repo}/actions/workflows?per_page=100`,
      { headers: hdrs(token) }
    );
    if (!resp.ok) throw new Error(`List workflows failed: ${resp.status}`);
    const data = await resp.json();
    return data.workflows || [];
  }

  /**
   * List recent workflow runs, optionally filtered by status.
   * @param {string} [status] - 'queued'|'in_progress'|'completed' etc. Omit for all.
   * @param {number} [limit=20]
   * @returns {Array} run objects
   */
  async function listRecentRuns(config, status, limit = 20) {
    const { token, owner, repo } = config;
    let url = `${API}/repos/${owner}/${repo}/actions/runs?per_page=${limit}`;
    if (status) url += `&status=${status}`;
    const resp = await fetch(url, { headers: hdrs(token) });
    if (!resp.ok) throw new Error(`List runs failed: ${resp.status}`);
    const data = await resp.json();
    return data.workflow_runs || [];
  }

  /**
   * Delete a file from the repo via Contents API.
   * @param {Object} config - { token, owner, repo, branch }
   * @param {string} filePath - e.g. '.github/workflows/my.yml'
   * @param {string} [message] - commit message
   */
  async function deleteFile(config, filePath, message) {
    const { token, owner, repo, branch = 'main' } = config;
    // 1. Get current SHA of the file
    const getResp = await fetch(
      `${API}/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`,
      { headers: hdrs(token) }
    );
    if (!getResp.ok) throw new Error(`File not found: ${filePath} (${getResp.status})`);
    const { sha } = await getResp.json();

    // 2. Delete it
    const delResp = await fetch(
      `${API}/repos/${owner}/${repo}/contents/${filePath}`,
      {
        method: 'DELETE',
        headers: hdrs(token),
        body: JSON.stringify({
          message: message || `Delete ${filePath} via BrowserAgent`,
          sha,
          branch,
        }),
      }
    );
    if (!delResp.ok) {
      const err = await delResp.json().catch(() => ({}));
      throw new Error(err.message || `Delete failed: ${delResp.status}`);
    }
  }

  // ─── Public API ────────────────────────────────────────────────────

  return {
    getUser,
    repoExists,
    createRepo,
    pushFiles,
    ensureWorkflow,
    dispatchWorkflow,
    findLatestRun,
    getRun,
    getRunJobs,
    getJobLogs,
    pollRun,
    extractArtifacts,
    detectRuntime,
    parseLogOutput,
    setRepoSecret,
    setRepoVariable,
    syncSecretsAndVars,
    listWorkflows,
    listRecentRuns,
    deleteFile,
  };
})();

export default GitHubActions;
