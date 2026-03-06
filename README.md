# Boxed Agent 🤖

⚠️ **Status: Under Active Development** — Features and APIs may change

A fully **browser-based AI assistant** with customizable SOUL personality, pluggable Skills, and seamless GitHub Actions integration. Run AI workflows directly in your browser with encrypted session storage.

> **Powered by Google Gemini API** | **Works offline after initial load** | **Zero server backend required**

🚀 **[Try it now](https://masteraux101.github.io/boxed-agent/main.html)** — No installation required!

---

## ✨ Key Features

### 🎭 SOUL System
- Define custom AI personalities and behaviors via `SOUL` markdown files
- Switch between different SOULs per session (e.g., "Code Reviewer", "Life Coach")
- Built-in SOULs included; load custom SOULs from URLs
- SOUL instructions are dynamically composed with loaded Skills

### 🛠️ Skills
- Add specialized capabilities (code review, email sending, translation, etc.)
- Skills can be bundled with the app or loaded from external URLs
- Skills are safely evaluated in the context of GitHub Actions workflows
- Built-in skills: AI Prompt Scheduler, Code Review, Email (Resend), GitHub Scheduler, Translator

### 🔐 Encrypted Storage
- **AES-256-GCM encryption** with PBKDF2 key derivation (310K iterations)
- You control the passphrase—it's **never stored anywhere**
- Session index (unencrypted) lives in localStorage; session content is encrypted
- Supports multiple storage backends:
  - **localStorage** (device-local, temporary)
  - **GitHub** (persistent, needs GitHub PAT + repo)
  - **Notion** (planned)

### ⚙️ GitHub Actions Integration
- Deploy and execute model-generated code directly to GitHub Actions
- Set up scheduled workflows with cron expressions
- Receive notifications via email or webhooks
- Long-running tasks can self-heal via watchdog workflow chaining
- Full audit trail in your GitHub repo

### 🔄 Session Management
- Create multiple independent sessions with different SOULs and settings
- Per-session configuration isolation (API keys, model settings, storage backend)
- Load/save sessions from different backends seamlessly
- All session data encrypted by default

---

## 🚀 Quick Start

### Zero Setup: Use Online
Visit **[https://masteraux101.github.io/boxed-agent/main.html](https://masteraux101.github.io/boxed-agent/main.html)** and start immediately!
- No installation needed
- Your data stays in your browser (encrypted)
- Connect your own GitHub account for cloud storage

### Local Development

- Node.js 18+ (for development only; app runs in browser)
- Google Gemini API key ([get one free](https://ai.google.dev))
- Optional: GitHub PAT for cloud storage and Actions integration

### Installation

1. **Clone and install:**
   ```bash
   git clone <repo-url>
   cd boxed-agent
   npm install
   ```

2. **Start development server:**
   ```bash
   npm run dev
   ```
   Opens at `http://localhost:5173` (or configured port)

3. **Build for production:**
   ```bash
   npm build
   ```
   Output in `dist/` folder

### First Use

1. Open the app in your browser
2. Enter your **Google Gemini API key** in settings
3. Select a SOUL or create a custom one
4. Start chatting!

---

## 📋 Core Concepts

### Session Architecture
```
Session {
  id: UUID
  title: string
  soulName: string                         # which personality to use
  messages: Array<{ role, content }>       # chat history (encrypted)
  settings: {
    apiKey, model, enableSearch, ...       # per-session config (encrypted)
  }
  backend: "local" | "github" | "notion"   # storage location
}
```

**Session Index** (localStorage, unencrypted):
```
[
  { id, title, soulName, createdAt, updatedAt, backend },
  ...
]
```

### Encryption Flow
```
plaintext (session JSON)
    ↓
   [encrypt with passphrase]
    ↓
   salt (16 bytes) + IV (12 bytes) + ciphertext
    ↓
   base64 encode
    ↓
   store (localStorage / GitHub / Notion)
```

**Decryption**: Reverse the process with the same passphrase.

### SOUL + Skill Composition
```
baseSoulInstruction = SOUL_SYSTEM_PROMPT + 
                      (SKILL_1_PROMPT + SKILL_2_PROMPT + ...)
                      
This combined prompt is sent to the model for each message.
```

### GitHub Actions Workflow
```
Model generates code
    ↓
User reviews in UI
    ↓
Push to GitHub Actions
    ↓
Runner executes task
    ↓
Watchdog monitors progress
    ↓
Send notifications (email / webhook)
```

---

## ⚙️ Configuration

### Global Settings
Stored in `localStorage` under `browseragent_settings` (plaintext):
- Default API key
- Default model (gemini-pro, etc.)
- CORS proxy URL
- Default storage backend

### Per-Session Settings
Stored in `localStorage` under `browseragent_session_cfg_<sessionId>` (encrypted):
- Session-specific API key override
- Model selection
- Search/thinking enablement
- Storage backend (GitHub, Notion, etc.)
- GitHub Actions configuration
- Notification settings

### Environment Variables (Development)
Create a `.env` file (not committed):
```bash
VITE_CORS_PROXY=https://corsproxy.io/?url=
VITE_API_ENDPOINT=https://api.google.dev  # or your proxy
```

---

## 🔗 API Integration

### Google Gemini
```javascript
// Configured in app.js
const response = await fetch('https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent', {
  method: 'POST',
  headers: { 'x-goog-api-key': apiKey, ... },
  body: JSON.stringify({ contents: [ ... ] })
});
```

### GitHub API
```javascript
// Token-based authentication for repo access
Authorization: `Bearer ${githubToken}`
// Used for reading/writing session files and triggering workflows
```

### Notion API
```javascript
// Integration for storing sessions in Notion databases
Authorization: `Bearer ${notionToken}`
```

---

## 📁 Project Structure

```
.
├── index.html                  # Entry point
├── package.json               # Dependencies
├── vite.config.js             # Build configuration
├── style.css                  # Global styles
│
├── src/
│   ├── app.js                 # Main coordinator (UI, settings, lifecycle)
│   ├── chat.js                # Message handling, streaming
│   ├── crypto.js              # AES-256-GCM encryption (Web Crypto API)
│   ├── storage.js             # Persistence layer (localStorage/GitHub/Notion)
│   ├── soul-loader.js         # Load SOUL definitions
│   └── github-actions.js      # Trigger workflows, monitor runs
│
└── examples/
    ├── souls/
    │   ├── DEFAULT_SOUL.md    # Default assistant personality
    │   ├── GUIDE_SOUL.md      # Coach/mentor personality
    │   └── index.json         # Soul registry
    └── skills/
        ├── ai-prompt-scheduler.md
        ├── code-review.md
        ├── email-resend.md
        ├── github-scheduler.md
        └── translator.md
```

---

## 🔒 Security Notes

### ✅ What's Encrypted
- All session messages
- All session settings
- Sensitive credentials (API keys, tokens)

### ⚠️ What's Not Encrypted
- Session index (IDs, titles, timestamps)
- Global settings (unless explicitly set per-session)
- GitHub repo names and paths (encrypted at rest in GitHub)

### 🛡️ Best Practices
1. **Use strong passphrases** for your sessions
2. **Rotate GitHub PATs** regularly
3. **Never share your passphrase** (not recoverable)
4. **Review auto-loaded Skills** before using them in production
5. **Audit GitHub Actions logs** in your repo

---

## 🛠️ Development

### Add a New SOUL
1. Create `examples/souls/MySoul.md` with system prompt
2. Add entry to `examples/souls/index.json`
3. Reload app; new SOUL appears in dropdown

### Add a New Skill
1. Create `examples/skills/my-skill.md` with:
   ```markdown
   # My Skill
   
   Description and usage instructions.
   
   ## System Prompt
   
   [Your skill instructions for the model]
   ```
2. Add to `BUILTIN_SKILLS` in `src/app.js`, or load from URL
3. Skills are auto-merged with SOUL instructions

### Extend Storage Backends
Edit `src/storage.js`:
- Implement `save()`, `load()`, `remove()` for your backend
- Encryption happens at `Crypto` layer; you just handle transport
- Register in `Storage.handlers` or UI settings

---

## 📦 Dependencies

| Package | Purpose |
|---------|---------|
| `@google/genai` | Google Gemini API client |
| `@langchain/langgraph` | Multi-agent workflow orchestration |
| `@browserbasehq/stagehand` | Browser automation (optional) |
| `tweetnacl` | Encryption utils (optional) |
| `marked` | Markdown rendering |
| `highlight.js` | Syntax highlighting |
| `vite` | Build tool |

---

## 🚢 Deployment

### Static Hosting (Vercel, Netlify, GitHub Pages)
```bash
npm run build
# Upload dist/ folder to your host
```

**No backend needed!** The app is fully client-side.

### With Custom API Proxy
If you need to proxy Gemini requests for privacy/rate-limiting:
1. Deploy a reverse proxy (e.g., Cloudflare Workers)
2. Set `VITE_API_ENDPOINT` environment variable
3. Redeploy

### GitHub Pages Example
```bash
npm run build
git add dist/
git commit -m "Deploy"
git subtree push --prefix dist origin gh-pages
```

---

## 🐛 Troubleshooting

### "Session not found locally"
- Session data might be in GitHub backend; provide correct PAT and repo

### "Decryption failed — wrong passphrase"
- Wrong passphrase entered
- Session data corrupted (very rare)

### "GitHub save failed (401)"
- Invalid or expired GitHub PAT
- Token missing `repo` scope

### CORS errors on API calls
- Verify `CORS_PROXY` setting in global/session config
- Some APIs don't support CORS; use proxy or backend

### Skills not showing up
- Verify markdown format (## Heading)
- Check console for load errors
- Ensure SOUL instructions are being composed correctly

---

## 📝 License

[Add your license here]

---

## 🤝 Contributing

Contributions welcome! Please:
1. Follow existing code style (ESLint config provided)
3. Document new SOULs and Skills with examples
4. Update this README for major features

---

## 📚 Resources

- [Google Gemini API Docs](https://ai.google.dev)
- [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
- [GitHub API Docs](https://docs.github.com/en/rest)
- [LangGraph Docs](https://python.langchain.com/docs/langgraph)
- [Vite Build Tool](https://vitejs.dev)

---

## 💡 Examples

### Example 1: Set up a code reviewer
1. Create new session
2. Load "Code Review" Skill
3. Select "Code Reviewer" SOUL
4. Paste your code → AI reviews it

### Example 2: Schedule a daily report
1. Load "GitHub Scheduler" Skill
2. Configure cron: `0 9 * * *` (9 AM daily)
3. Set email notification
4. Deploy to GitHub Actions
5. Receive reports automatically

### Example 3: Self-healing long job
1. Create a task that might timeout
2. Use "langgraph-watchdog.js" pattern
3. Watchdog monitors progress
4. Auto-restarts if needed
5. Final status via webhook

---

**Made with ❤️ for AI-driven development workflows**
