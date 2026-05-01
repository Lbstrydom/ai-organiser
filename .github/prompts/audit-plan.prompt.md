<!-- audit-loop-bundle:prompt:start -->
---
description: "Iteratively audit a plan file (docs/plans/*.md) with GPT + Gemini final gate."
mode: agent
---
# /audit-plan

Iteratively audit a plan file with GPT + Gemini final gate (max 3 rounds).

## Run

Invoke the engineering skills CLI:

```bash
node .audit-loop/scripts/openai-audit.mjs plan ${input:plan_path} --mode plan
```

Underlying script: `.audit-loop/scripts/openai-audit.mjs` — same code path that Claude skills orchestrate, so output is consistent across both surfaces.

## Notes for Copilot users

For the full skill flow (progressive disclosure, multi-pass orchestration, conversational fix-iterate loops), use Claude Code with `/audit-plan`. This prompt file provides CLI parity for VS Code Copilot users — output is structured JSON / log lines, not the conversational UX Claude offers.
<!-- audit-loop-bundle:prompt:end -->
