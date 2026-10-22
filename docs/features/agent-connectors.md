# Agent Connectors

Help for connecting an AI app to the vault, an honest statement of what each route does and does not enforce, and a vault map to upload to a chat project. Default off (`agent-connectors`, stage Find, requires `agent-index`) and byte-identical when off: no command, no section, no file. Setting: `agentConnectorFolder` (where generated files go; empty until the person chooses, never assumed).

**Principle**: the plugin never edits another application's configuration. The guide shows text to copy and where the file is. Every vendor fact in the guide was read from the vendor's own documentation on 2026-10-22; the screens link the current documentation instead of copying more than that.

## Routes and what each enforces

| Route | Enforced | Only advised | Not controlled |
|---|---|---|---|
| Claude Desktop with the official filesystem server | nothing | Claude Desktop asks before each action | the server can read, change and delete any file in the vault, including excluded and protected folders |
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
