<!-- audit-loop-bundle:prompt:start -->
---
description: "End-to-end feature cycle orchestrator."
mode: agent
---
# /cycle

End-to-end feature cycle: plan → audit-plan → impl gate → audit-code → persona-test → ux-lock → ship.

## Run

Invoke the engineering skills CLI:

```bash
node .audit-loop/scripts/cycle.mjs ${input:task_or_plan}
```

Underlying script: `.audit-loop/scripts/cycle.mjs` — same code path that Claude skills orchestrate, so output is consistent across both surfaces.

## Notes for Copilot users

For the full skill flow (progressive disclosure, multi-pass orchestration, conversational fix-iterate loops), use Claude Code with `/cycle`. This prompt file provides CLI parity for VS Code Copilot users — output is structured JSON / log lines, not the conversational UX Claude offers.
<!-- audit-loop-bundle:prompt:end -->
