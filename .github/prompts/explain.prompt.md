<!-- audit-loop-bundle:prompt:start -->
---
description: "Explain WHY a piece of code is structured the way it is."
mode: agent
---
# /explain

Explain WHY code is structured this way — synthesises arch-memory, git history, principles, and plan citations.

## Run

Invoke the engineering skills CLI:

```bash
node .audit-loop/scripts/explain.mjs ${input:target}
```

Underlying script: `.audit-loop/scripts/explain.mjs` — same code path that Claude skills orchestrate, so output is consistent across both surfaces.

## Notes for Copilot users

For the full skill flow (progressive disclosure, multi-pass orchestration, conversational fix-iterate loops), use Claude Code with `/explain`. This prompt file provides CLI parity for VS Code Copilot users — output is structured JSON / log lines, not the conversational UX Claude offers.
<!-- audit-loop-bundle:prompt:end -->
