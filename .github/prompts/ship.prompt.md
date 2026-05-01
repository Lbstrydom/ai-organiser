<!-- audit-loop-bundle:prompt:start -->
---
description: "Sync all project documentation, optionally update a plan, then commit and push to git."
mode: agent
---
# /ship

Commit, push, and gate against UX P0 warnings from persona-test.

## Run

Invoke the engineering skills CLI:

```bash
node .audit-loop/scripts/ship.mjs ${input:args}
```

Underlying script: `.audit-loop/scripts/ship.mjs` — same code path that Claude skills orchestrate, so output is consistent across both surfaces.

## Notes for Copilot users

For the full skill flow (progressive disclosure, multi-pass orchestration, conversational fix-iterate loops), use Claude Code with `/ship`. This prompt file provides CLI parity for VS Code Copilot users — output is structured JSON / log lines, not the conversational UX Claude offers.
<!-- audit-loop-bundle:prompt:end -->
