<!-- audit-loop-bundle:prompt:start -->
---
description: "DEPRECATED — thin alias for `/plan --scope=backend`."
mode: agent
---
# /plan-backend

DEPRECATED alias — invokes /plan with --scope=backend. Prefer /plan directly.

## Run

Invoke the engineering skills CLI:

```bash
node .audit-loop/scripts/plan-backend.mjs ${input:task}
```

Underlying script: `.audit-loop/scripts/plan-backend.mjs` — same code path that Claude skills orchestrate, so output is consistent across both surfaces.

## Notes for Copilot users

For the full skill flow (progressive disclosure, multi-pass orchestration, conversational fix-iterate loops), use Claude Code with `/plan-backend`. This prompt file provides CLI parity for VS Code Copilot users — output is structured JSON / log lines, not the conversational UX Claude offers.
<!-- audit-loop-bundle:prompt:end -->
