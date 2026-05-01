<!-- audit-loop-bundle:prompt:start -->
---
description: "Frontend UX and implementation planning with design and engineering principles."
mode: agent
---
# /plan-frontend

Generate a frontend/UX plan with acceptance criteria. Output to docs/plans/.

## Run

Invoke the engineering skills CLI:

```bash
node .audit-loop/scripts/plan-frontend.mjs ${input:task}
```

Underlying script: `.audit-loop/scripts/plan-frontend.mjs` — same code path that Claude skills orchestrate, so output is consistent across both surfaces.

## Notes for Copilot users

For the full skill flow (progressive disclosure, multi-pass orchestration, conversational fix-iterate loops), use Claude Code with `/plan-frontend`. This prompt file provides CLI parity for VS Code Copilot users — output is structured JSON / log lines, not the conversational UX Claude offers.
<!-- audit-loop-bundle:prompt:end -->
