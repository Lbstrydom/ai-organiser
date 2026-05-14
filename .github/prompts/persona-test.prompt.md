<!-- audit-loop-bundle:prompt:start -->
---
description: "Persona-driven exploratory browser testing against a live URL."
mode: agent
---
# /persona-test

Drive a browser as a persona against a live URL; report UX findings.

## Run

Invoke the engineering skills CLI:

```bash
node scripts/persona-test.mjs ${input:persona} ${input:url}
```

Underlying script: `scripts/persona-test.mjs` — same code path that Claude skills orchestrate, so output is consistent across both surfaces.

## Notes for Copilot users

For the full skill flow (progressive disclosure, multi-pass orchestration, conversational fix-iterate loops), use Claude Code with `/persona-test`. This prompt file provides CLI parity for VS Code Copilot users — output is structured JSON / log lines, not the conversational UX Claude offers.
<!-- audit-loop-bundle:prompt:end -->
