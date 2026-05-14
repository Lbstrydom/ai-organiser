<!-- audit-loop-bundle:prompt:start -->
---
description: "DEPRECATED — use `/cycle` for the full chained workflow, OR `/audit-plan` / `/audit-code` for atomic invocations."
mode: agent
---
# /audit-loop

DEPRECATED — use /cycle for chained workflow, /audit-plan or /audit-code for atomic invocations.

## Run

Invoke the engineering skills CLI:

```bash
node scripts/openai-audit.mjs code ${input:plan_path}
```

Underlying script: `scripts/openai-audit.mjs` — same code path that Claude skills orchestrate, so output is consistent across both surfaces.

## Notes for Copilot users

For the full skill flow (progressive disclosure, multi-pass orchestration, conversational fix-iterate loops), use Claude Code with `/audit-loop`. This prompt file provides CLI parity for VS Code Copilot users — output is structured JSON / log lines, not the conversational UX Claude offers.
<!-- audit-loop-bundle:prompt:end -->
