# Boxed Agent 🤖

⚠️ **Status: Under Active Development** — Features and APIs may change

A fully **browser-based AI assistant** with customizable SOUL personality, pluggable Skills, and seamless session management. Run AI workflows directly in your browser with encrypted session storage.

> **Powered by Google Gemini + Qwen APIs** | **Works offline after initial load** | **Zero server backend required**

🚀 **[Try it now](https://masteraux101.github.io/boxed-agent/main.html)** — No installation required!

---

## ✨ Key Features

### 🎭 SOUL System
- Define custom AI personalities and behaviors via `SOUL` markdown files
- Switch between different SOULs per session (e.g., "Code Reviewer", "Life Coach")
- Built-in SOULs included; load custom SOULs from URLs
- SOUL instructions are dynamically composed with loaded Skills

**Load external SOUL example:**
```
/soul https://raw.githubusercontent.com/masteraux101/boxed-agent/refs/heads/main/examples/souls/GUIDE_SOUL.md
```

### 🛠️ Skills
- Add specialized capabilities (code review, email sending, translation, etc.)
- Skills can be bundled with the app or loaded from external URLs
- Built-in skills: AI Prompt Scheduler, Code Review, Email (Resend), Translator

**Load external Skill example:**
```
/skill https://raw.githubusercontent.com/masteraux101/boxed-agent/refs/heads/main/examples/skills/ai-prompt-scheduler.md
```

### 🔐 Encrypted Storage
- **AES-256-GCM encryption** with PBKDF2 key derivation (310K iterations)
- You control the passphrase—it's **never stored anywhere**
- Session index (unencrypted) lives in localStorage; session content is encrypted
- Supports multiple storage backends:
  - **localStorage** (device-local, temporary)
  - **GitHub** (persistent, needs GitHub PAT + repo)
  - **Notion** (planned)

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
- Google Gemini API key (optional, [get one free](https://ai.google.dev))
- Qwen API key (optional, from DashScope/Bailian)
- Optional: GitHub PAT for cloud storage

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
2. Choose provider: **Gemini** or **Qwen**
3. Enter corresponding API key in settings
4. Select a SOUL or create a custom one
5. Start chatting!

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
    apiKey, qwenApiKey, provider, model,
    enableSearch, enableThinking, ...       # per-session config (encrypted)
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

---

## ⚙️ Configuration

### Global Settings
Stored in `localStorage` under `browseragent_settings` (plaintext):
- Default provider
- Default API keys (Gemini/Qwen)
- Default model (gemini-*, qwen-*, etc.)
- CORS proxy URL
- Default storage backend

### Per-Session Settings
Stored in `localStorage` under `browseragent_session_cfg_<sessionId>` (encrypted):
- Session-specific provider and API key override
- Model selection
- Search/thinking enablement (dynamic by model capability)
- Storage backend (GitHub, Notion, etc.)

### Environment Variables (Development)
Create a `.env` file (not committed):
```bash
VITE_CORS_PROXY=https://corsproxy.io/?url=
VITE_API_ENDPOINT=https://api.google.dev  # or your proxy
```

---

## 🔗 API Integration

### Google Gemini
- Uses `@google/genai` SDK (`models.generateContentStream`)
- Supports model-based search/thinking options

### Qwen (DashScope OpenAI-compatible)
- Uses DashScope compatible endpoint:
  - `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`
- Uses streaming (`SSE`) and token usage parsing
- Supports model-based capability switching:
  - search and thinking are enabled/disabled per model dimensions

### GitHub API
```javascript
// Token-based authentication for repo access
Authorization: `Bearer ${githubToken}`
// Used for reading/writing session files
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
│   └── soul-loader.js         # Load SOUL definitions
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

### 🛡️ Best Practices
1. **Use strong passphrases** for your sessions
2. **Never share your passphrase** (not recoverable)
3. **Review auto-loaded Skills** before using them in production

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
| `openai` | OpenAI-compatible client utilities (Qwen ecosystem) |
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

For Qwen/DashScope, make sure your network can access Aliyun endpoints and your account quota is sufficient.

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

### Qwen 403 / free tier exhausted
- Your key is valid but model quota/billing is exhausted
- Switch to a billed model or recharge your DashScope/Bailian account
- Try setting a specific model in `.env`: `QWEN_MODEL=qwen3-max-2026-01-23`

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
- [Qwen / DashScope Docs](https://help.aliyun.com/zh/model-studio/)
- [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
- [GitHub API Docs](https://docs.github.com/en/rest)
- [LangGraph Docs](https://python.langchain.com/docs/langgraph)
- [Vite Build Tool](https://vitejs.dev)

---

## 💡 Examples

### Example: Set up a code reviewer
1. Create new session
2. Load "Code Review" Skill
3. Select "Code Reviewer" SOUL
4. Paste your code → AI reviews it

---

**Made with ❤️ for AI-driven development workflows**
