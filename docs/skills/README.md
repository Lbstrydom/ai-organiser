# Skills for AI apps

Skills an AI app can load so that what it hands back lands in the shape the plugin reads. They change nothing in the plugin.

| Skill | What it does | Drift guard |
|---|---|---|
| [`vault-handback`](vault-handback/SKILL.md) | End-of-session `## Handoff` hand-back, or one capture per note; writes a new file to `0 Inbox/From Claude/` when a file tool exists, otherwise prints paste-ready text | `tests/vaultHandbackSkill.test.ts` runs the skill's grammar and examples through `renderHandoffContract`, `handoffParser`, the sweep guard and the capture text-first rules |

## Install

Each skill folder is upload-ready: the zip must hold the folder itself, with `SKILL.md` inside it.

- **claude.ai or Claude Desktop:** make the zip, then upload it under *Settings > Capabilities > Skills* (code execution must be on).

  ```powershell
  Compress-Archive -Path docs/skills/vault-handback -DestinationPath vault-handback.zip
  ```

  ```bash
  cd docs/skills && zip -r ../../vault-handback.zip vault-handback
  ```

- **Claude Code:** copy the folder to `~/.claude/skills/vault-handback/` (all projects) or `.claude/skills/vault-handback/` (one project).

The drop folder `0 Inbox/From Claude/` is not created by the skill or the plugin: create it in your vault if you want file delivery. Without it the skill stops and says so.
