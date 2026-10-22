# Agent Connectors

Help for connecting an AI app to the vault, an honest statement of what each route does and does not enforce, and a vault map to upload to a chat project. Default off (`agent-connectors`, stage Find, requires `agent-index`) and byte-identical when off: no command, no section, no file. Setting: `agentConnectorFolder` (where generated files go; empty until the person chooses, never assumed).

**Principle**: the plugin never edits another application's configuration. The guide shows text to copy and where the file is. Every vendor fact in the guide was read from the vendor's own documentation on 2026-10-22; the screens link the current documentation instead of copying more than that.

## Routes and what each enforces

| Route | Enforced | Only advised | Not controlled |
|---|---|---|---|
| Claude Desktop with the official filesystem server | nothing | Claude Desktop asks before each action | the server can read, change and delete any file in the vault, including excluded and protected folders |
| Read-only connector (Cluster H) | only notes inside the index scope can be read; excluded, protected and hidden folders cannot be listed, searched or read; it never writes, runs programs or uses the network | the AGENTS.md text | other file or terminal access the same app has; a local program racing the filesystem during one request; turning off or uninstalling the plugin does not remove the connector from the AI app |
| Codex (AGENTS.md) | nothing | the AGENTS.md text | whatever Codex's sandbox allows in the opened folder |
| Command-line agent (Claude Code, Codex CLI, Gemini CLI) | nothing | AGENTS.md; for Claude Code, `permissions.deny` rules that Claude Code enforces | whatever the shell allows |
| Chat project file | excluded, protected and hidden folders are left out when the file is made | n/a | the titles, paths, tags and links of included notes leave the computer when the file is uploaded |

`ROUTE_CLAIMS` (`connectorGuides.ts`) fixes what each route claims, so no route can claim enforcement it does not give.

## Verified vendor facts used (2026-10-22)

- **Claude Desktop**: config at `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) and `%APPDATA%\Claude\claude_desktop_config.json` (Windows); no Linux path is documented, so none is shown. Entries go under `mcpServers`; paths absolute; full quit and restart. The official filesystem server needs Node.js and can create, move and rename files.
- **Claude Desktop extensions**: a `.mcpb` ZIP with `manifest.json` (spec 0.3); Claude Desktop includes Node.js, so node extensions need no separate install; `user_config` supports a `directory` picker.
- **Codex**: the desktop app, CLI and IDE extension share `~/.codex/config.toml`; stdio servers are `[mcp_servers.<name>]` tables. The CLI reads `AGENTS.md` (32 KiB default budget); the docs do not say whether the app or the extension do.
- **Gemini CLI**: reads `GEMINI.md`; set `context.fileName` in `settings.json` to read `AGENTS.md` too. A notice on the documentation says the tool is being replaced for some users, so the screen says it may differ.
- **Claude Code**: reads `AGENTS.md` itself only when there is no `CLAUDE.md`; otherwise import it with `@AGENTS.md`.

## Pieces (Cluster G)

- `connectorGuides.ts`: pure builders for every snippet (`JSON.stringify`, so any vault path round-trips), documentation links, the instruction-size check against Codex's budget, the route claims.
- `localTools.ts`: `checkNodeInstalled` (`node --version`, fixed arguments, 3 s limit) and `openTerminalInVault` (Windows and macOS only; argument arrays and `cwd`, never a command string). Both go through an injected spawner and never throw.
- `operationController.ts`: `idle | running | done | failed` per action, conflicting actions in a group ignored while one runs, a time limit per action.
- `chatExport.ts` and `connectorRuntime.ts`: the vault map. Built from the index's own projection (`includedRecords`), so one scope function decides which notes appear; no note text; its own short map-reading note (never the file-access instructions, because those name the excluded folders); exact UTF-8 byte accounting per part (400 KB), one note line capped at 4 KB; marker on the first line; parts named `AI Organiser vault map (part i of N).md`; superseded marker-bearing parts are trashed after a run, unmarked files are never touched; the confirmation is bound to a scope revision.
- UI: `AgentConnectorsModal` (one tab per route), `AgentConnectorsSettingsSection`, commands `open-agent-connectors` and `export-vault-map`.

## Tests

`connectorGuides`, `connectorLocalTools`, `connectorChatExport`, `connectorRuntime`, `operationController`, `agentConnectorsOffPath`, `protectedWriteSites`, `commandPicker`.

## The read-only connector (Cluster H)

A small local MCP server the person saves as a file, so an AI app can search and read the notes the **index scope includes** and nothing else. It is the only route that enforces the scope.

- **What it is**: one static JavaScript file (`connectorServerSource.ts`, held as a string; no dependencies; only `node:fs`, `node:path`, `node:os`). It cannot write, delete, start a program or use the network, and tests scan its text for every such API. Tools (all read-only): `search_notes` (over the agent index), `read_note`, `list_folder`.
- **Delivery**: `ai-organiser-vault-connector.mcpb` (a ZIP built by `src/utils/zipStore.ts`, store-only, no dependency; manifest spec 0.3 with a `directory` setting, so the bundle contains no path and Claude Desktop shows its own folder picker; Claude Desktop includes Node.js, so nothing to install) and `ai-organiser-vault-server.cjs` for Codex plus a `~/.codex/config.toml` table built with a TOML basic-string serializer (Codex needs Node.js on the computer; the screen checks it). No shell command line is offered.
- **Scope is data, read on every request**: `.ai-organiser/agent-connector-scope.json` (`CONNECTOR_SCOPE_PATH`, one constant) holds include, exclude and protected folders and the configured index path. The server reads and validates it (64 KB cap) at the start of **every** request, no timestamp shortcut; a request in progress finishes under the scope it started with. Missing, damaged, wrong-kind or `disabled: true` means every tool refuses. The scope rule is a transliteration of `isInIndexScope` plus the protected folders; a parity suite compares the two over 6 000 generated paths. **Any change to `isInIndexScope` must be mirrored in the server source.**
- **Revocation is part of the feature** (`connectorScope.ts`): `ScopePublisher` publishes whenever the effective state changes (feature on AND `agent-index` on, or any scope field), after every settings save, at load and when either feature flips. A move to off publishes a tombstone and reads it back before success. A failure sets `agentConnectorScopeStale`, shown on the screen with the remedy "remove the connector in your AI app", and is retried. A never-enabled installation writes nothing. **Disabling or uninstalling the whole plugin does not revoke access** (the plugin cannot tell Obsidian closing from the user disabling it, and the connector is meant to work while Obsidian is closed); the screen says so.
- **Containment** (every path, every call): rejects non-strings, NUL, backslashes, leading slash, drive prefixes, `.`/`..`/empty segments, hidden segments, anything over 1 024 characters, non-`.md` notes; each component is `lstat`ed and a link or junction is refused; the real path must stay inside the real vault root; the scope is applied to both the requested spelling and the real relative path (case variants and links cannot reach an excluded folder); the opened descriptor must be the same file as the one checked and the real path is confirmed again after the open. **Threat model**: protects against the AI asking for more than was included and against ordinary changes between requests; **not** against a local process racing the filesystem during one request (portable Node has no no-follow, directory-relative open).
- **Protocol**: both eras, hand-written. Modern (`server/discover`, per-request `_meta` version, `resultType: "complete"`, `-32022` for an unsupported version) and legacy (`initialize` with version echo, `initialize first` error before it, `notifications/initialized`). Envelope validation, no batches, notifications never answered, one request at a time from a queue of 64, stdout back-pressure, asynchronous file access with a cooperative 5 s deadline, bounded directory iteration (5 000 examined, 200 returned), a 32 MB index cap and a 1 MB note cap.
- **Test the connector** (`connectorSelfTest.ts`): starts the saved server with `node` from the PATH and runs both protocol flows. It reports only that the connector starts and answers; it can never say that Claude Desktop or Codex is connected.
- **Files** (`connectorFiles.ts`): created in the chosen folder through the vault adapter (the vault index does not track `.mcpb`/`.cjs`), temp-then-swap, replaced only when they carry the marker (first line of the server, the ZIP comment of the bundle).

### Tests (H)

`connectorServer` (the real server as a child process: both eras, framing, containment table, links via junction, hot reload, fail-closed, revocation end to end with the real publisher), `connectorServerSource` (static scan, parity), `connectorBundle` (ZIP written then read back by an independent reader and a real ZIP library when installed, manifest, TOML round trip), `connectorScope` (publisher lifecycle), `connectorFiles`, `connectorSelfTest`.
