<!-- audit-loop-bundle:prompt:start -->
---
description: "Manage AGENTS.md and CLAUDE.md alignment across a repo so Claude, Copilot, Cursor, Windsurf, and other AI agents share the same project context."
mode: agent
---
# /ai-context-management

Manage AGENTS.md / CLAUDE.md alignment; generate Copilot prompt shims.

## Run

Invoke the engineering skills CLI:

```bash
node scripts/check-context-drift.mjs
```

Underlying script: `scripts/check-context-drift.mjs` — same code path that Claude skills orchestrate, so output is consistent across both surfaces.

## Notes for Copilot users

For the full skill flow (progressive disclosure, multi-pass orchestration, conversational fix-iterate loops), use Claude Code with `/ai-context-management`. This prompt file provides CLI parity for VS Code Copilot users — output is structured JSON / log lines, not the conversational UX Claude offers.
<!-- audit-loop-bundle:prompt:end -->
