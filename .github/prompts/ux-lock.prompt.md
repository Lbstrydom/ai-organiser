<!-- audit-loop-bundle:prompt:start -->
---
description: "Generate Playwright e2e specs."
mode: agent
---
# /ux-lock

Generate Playwright e2e specs that lock fixed behaviour or grade a plan.

## Run

Invoke the engineering skills CLI:

```bash
node .audit-loop/scripts/ux-lock.mjs ${input:mode_and_args}
```

Underlying script: `.audit-loop/scripts/ux-lock.mjs` — same code path that Claude skills orchestrate, so output is consistent across both surfaces.

## Notes for Copilot users

For the full skill flow (progressive disclosure, multi-pass orchestration, conversational fix-iterate loops), use Claude Code with `/ux-lock`. This prompt file provides CLI parity for VS Code Copilot users — output is structured JSON / log lines, not the conversational UX Claude offers.
<!-- audit-loop-bundle:prompt:end -->
