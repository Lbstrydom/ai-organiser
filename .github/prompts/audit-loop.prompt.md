<!-- audit-loop-bundle:prompt:start -->
---
description: "Orchestrator for /audit-plan + /audit-code."
mode: agent
---
# /audit-loop

Orchestrator for /audit-plan + /audit-code; dispatches by mode keyword or shorthand.

## Run

Invoke the engineering skills CLI:

```bash
node .audit-loop/scripts/openai-audit.mjs code ${input:plan_path}
```

Underlying script: `.audit-loop/scripts/openai-audit.mjs` — same code path that Claude skills orchestrate, so output is consistent across both surfaces.

## Notes for Copilot users

For the full skill flow (progressive disclosure, multi-pass orchestration, conversational fix-iterate loops), use Claude Code with `/audit-loop`. This prompt file provides CLI parity for VS Code Copilot users — output is structured JSON / log lines, not the conversational UX Claude offers.
<!-- audit-loop-bundle:prompt:end -->
