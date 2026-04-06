# Obsidian Review Bot — Rules Reference

**Last updated**: 2026-04-06
**Source**: ObsidianReviewBot automated scans on PR #11635
**Plugin**: `eslint-plugin-obsidianmd` v0.1.9

## How the Bot Works

The ObsidianReviewBot is a GitHub bot account that runs externally (not via GitHub Actions in the obsidian-releases repo). It scans your plugin's **source code** (not `main.js`) using the `eslint-plugin-obsidianmd` package.

### Config Used

The bot uses **`recommendedWithLocalesEn`** — NOT plain `recommended`. This is critical because:
- `recommended` checks `.setName()`, `.setDesc()`, `.setText()`, `.setButtonText()`, `.setPlaceholder()`, `.setTooltip()`, `createEl({ text: })` etc.
- `recommendedWithLocalesEn` ALSO scans `**/en.ts`, `**/en.json`, `**/en-*.ts` files with `sentence-case-locale-module` rule, checking ALL string values in locale files

### Scan Behaviour
- Rescans within **6 hours** of pushing to main
- Posts a new comment on the PR with results
- Categories: **Required** (must fix) and **Optional** (warnings)
- Does NOT run tests or build — purely lint-based

---

## Rules the Bot Enforces

### Sentence Case (biggest category)

**Rules**: `obsidianmd/ui/sentence-case`, `obsidianmd/ui/sentence-case-locale-module`

The bot checks ALL UI-facing strings for sentence case. Only the first word is capitalized, plus brands and acronyms.

**What counts as a "UI string":**
- `.setName('...')`, `.setDesc('...')`, `.setButtonText('...')`, `.setTooltip('...')`, `.setPlaceholder('...')`, `.setText('...')`, `.setTitle('...')`
- `.addRibbonIcon(icon, 'tooltip')` (2nd arg)
- `.addOption(value, 'label')` (2nd arg)
- `createEl(tag, { text: '...' })`, `createEl(tag, { title: '...' })`
- `createEl(tag, { attr: { 'aria-label': '...', title: '...', placeholder: '...' } })`
- `.textContent = '...'`, `.innerText = '...'`, `.title = '...'` assignments
- ALL string values in `src/i18n/en.ts` (locale module rule)

**DEFAULT_BRANDS** (46 brands preserved as-is):
iOS, iPadOS, macOS, Windows, Android, Linux, Obsidian, Obsidian Sync, Obsidian Publish, Google Drive, Dropbox, OneDrive, iCloud Drive, YouTube, Slack, Discord, Telegram, WhatsApp, Twitter, X, Readwise, Zotero, Excalidraw, Mermaid, Markdown, LaTeX, JavaScript, TypeScript, Node.js, npm, pnpm, Yarn, Git, GitHub, GitLab, Notion, Evernote, Roam Research, Logseq, Reddit, VS Code, Visual Studio Code, IntelliJ IDEA, WebStorm, PyCharm

**DEFAULT_ACRONYMS** (60 acronyms preserved uppercase):
API, HTTP, HTTPS, URL, DNS, TCP, IP, SSH, TLS, SSL, FTP, SFTP, SMTP, JSON, XML, HTML, CSS, PDF, CSV, YAML, SQL, PNG, JPG, JPEG, GIF, SVG, 2FA, MFA, OAuth, JWT, LDAP, SAML, SDK, IDE, CLI, GUI, CRUD, REST, SOAP, CPU, GPU, RAM, SSD, USB, UI, OK, RSS, S3, WebDAV, ID, UUID, GUID, SHA, MD5, ASCII, UTF-8, UTF-16, DOM, CDN, FAQ, AI, ML

**NOT in defaults** (must be lowercased mid-sentence or placed at sentence start):
Claude, Gemini, OpenAI, Kindle, Gmail, Amazon, NotebookLM, Ollama, Groq, Cohere, Anthropic, Google, Whisper, Voyage AI, Tavily, Bright Data, Supabase, Siliconflow, Readability, Dataview, Bases, Dataverse, Anki, Brainscape, GTD, Electron, Zoom

**CRITICAL**: The `brands` and `acronyms` options **REPLACE** defaults, not extend. If you provide a custom list, you LOSE the defaults. Our `eslint.config.mjs` only adds custom `acronyms` (for LLM, GTD, PPTX, etc.) and does NOT provide custom `brands` to preserve all 46 defaults.

### Rules That Reject eslint-disable Comments

The bot treats these as "Disabling 'X' is not allowed":
- `import/no-nodejs-modules`
- `@typescript-eslint/no-deprecated`
- `no-restricted-globals`
- `obsidianmd/ui/sentence-case`
- `obsidianmd/platform`
- `@typescript-eslint/no-explicit-any`

For these rules, you MUST fix the underlying code. No suppression accepted.

### Rules That Accept eslint-disable (with description)

Every `// eslint-disable-next-line` MUST have a `-- reason` description:
```typescript
// eslint-disable-next-line @typescript-eslint/no-require-imports -- WASM loader
```

Undescribed directives are flagged as "Unexpected undescribed directive comment."

Block-level `/* eslint-disable X */` must have matching `/* eslint-enable X */`.

Unused `eslint-disable` directives (where the rule doesn't fire) are also flagged.

---

## Rule-by-Rule Reference

### DOM & Styling
| Rule | Severity | Fix |
|------|----------|-----|
| `no-static-styles-assignment` | error | `el.addClass()` + CSS class, or `el.setCssProps()` for dynamic values |
| `no-forbidden-elements` (innerHTML) | error | Use `createEl()`, `empty()`, `setText()`, `DOMParser` |
| `no-tfile-tfolder-cast` | error | Use `instanceof TFile` / `instanceof TFolder` |
| `prefer-file-manager-trash-file` | warn | Use `fileManager.trashFile()` not `vault.delete()`/`vault.trash()` |
| `hardcoded-config-path` | error | Use `vault.configDir` not `.obsidian` |
| `detach-leaves` | error | Don't call `detachLeavesOfType()` in `onunload()` |
| `platform` | error | Use `Platform` API not `navigator.userAgent` |
| `regex-lookbehind` | error | No `(?<=...)` — iOS < 16.4 incompatible |
| `object-assign` | error | Use spread `{...obj}` not `Object.assign` |

### Async & Promises
| Rule | Severity | Fix |
|------|----------|-----|
| `no-misused-promises` | error | Wrap async in `() => { void (async () => {...})(); }` for void callbacks |
| `no-floating-promises` | error | Add `void`, `await`, or `.catch()` |
| `require-await` | error | Remove `async` if no `await`, or return `Promise.resolve()` |
| `await-thenable` | error | Remove `await` from non-Promise values |

### Types
| Rule | Severity | Fix |
|------|----------|-----|
| `no-explicit-any` | error | Use `unknown` + type guards, or define interfaces |
| `no-unused-vars` | error | Remove unused imports/vars. Bot does NOT respect `_` prefix ignore |
| `no-deprecated` | error | Replace deprecated APIs (no disable allowed) |
| `no-require-imports` | error | Use ES imports or `desktopRequire()` helper |

### Imports
| Rule | Severity | Fix |
|------|----------|-----|
| `import/no-nodejs-modules` | error | Use `desktopRequire()` helper (no disable allowed) |
| `no-restricted-globals` (fetch) | error | Use `requestUrl()` or `globalThis.fetch` for SSE |
| `import/no-extraneous-dependencies` | error | Add to devDependencies in package.json |

### Commands
| Rule | Severity | Fix |
|------|----------|-----|
| `no-command-in-command-id` | error | Remove "command" from command IDs |
| `no-command-in-command-name` | error | Remove "command" from command names |
| `no-plugin-id-in-command-id` | error | Don't include plugin ID in command IDs |

---

## Our ESLint Config

File: `eslint.config.mjs`

Uses `recommendedWithLocalesEn` (matches bot). Key overrides:
- Custom `acronyms` list for domain terms (LLM, GTD, PPTX, DOCX, RAG, etc.)
- Locale-module rule override with same acronyms for `**/en.ts`
- `no-unsafe-*` rules off (too noisy for plugin code)
- `no-undef` off (browser globals available in Obsidian)
- `sample-names` and `no-sample-code` off (not applicable)

### Running Locally

```bash
# Match bot scan exactly
npm run lint

# Auto-fix what's fixable
npm run lint:fix

# Check en.ts specifically
npx eslint src/i18n/en.ts
```

---

## Common Gotchas

1. **Custom brands/acronyms REPLACE defaults** — never provide `brands` option (lose 46 defaults). Only provide `acronyms` additions with ALL defaults restated.

2. **Bot scans en.ts locale file** — every string value is checked. This is where most violations come from.

3. **eslint-disable is rejected** for many rules — the bot has a hardcoded list of rules where disabling is not allowed.

4. **Unused eslint-disable** is flagged — remove stale disables after fixing code.

5. **window.require** pattern — use `desktopRequire()` from `src/utils/desktopRequire.ts` instead of `(window as any).require(...)`.

6. **SSE streaming fetch** — use `globalThis.fetch` (not bare `fetch` which triggers `no-restricted-globals`).

7. **Obsidian SecretStorage API** is synchronous (`getSecret(): string | null`) — wrap in `Promise.resolve()` for async interface compatibility.

8. **Test mocks** need `fileManager.trashFile` mock and `TFile` instances (from `createTFile()`) for `instanceof` checks.
