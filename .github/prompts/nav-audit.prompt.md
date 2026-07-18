<!-- audit-loop-bundle:prompt:start -->
---
description: "Static, code-derived navigation / information-architecture audit — the system-level third lens complementing /persona-test (journey-level) and /click-test (page-level)."
mode: agent
---
# /nav-audit

Static navigation / IA audit — the system-level lens; offered-vs-needed, drift-only CI gate.

## Run

Invoke the engineering skills CLI:

```bash
node scripts/.claude-skills/nav-audit.mjs --scope diff
```

Underlying script: `scripts/nav-audit.mjs` — same code path that Claude skills orchestrate, so output is consistent across both surfaces.

## Notes for Copilot users

For the full skill flow (progressive disclosure, multi-pass orchestration, conversational fix-iterate loops), use Claude Code with `/nav-audit`. This prompt file provides CLI parity for VS Code Copilot users — output is structured JSON / log lines, not the conversational UX Claude offers.
<!-- audit-loop-bundle:prompt:end -->
