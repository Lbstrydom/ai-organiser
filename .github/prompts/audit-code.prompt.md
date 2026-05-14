<!-- audit-loop-bundle:prompt:start -->
---
description: "Iteratively audit code against a plan with GPT + Gemini final gate."
mode: agent
---
# /audit-code

Multi-pass code audit against a plan with R2+ ledger suppression and debt capture.

## Run

Invoke the engineering skills CLI:

```bash
node scripts/openai-audit.mjs code ${input:plan_path} --scope diff
```

Underlying script: `scripts/openai-audit.mjs` — same code path that Claude skills orchestrate, so output is consistent across both surfaces.

## Notes for Copilot users

For the full skill flow (progressive disclosure, multi-pass orchestration, conversational fix-iterate loops), use Claude Code with `/audit-code`. This prompt file provides CLI parity for VS Code Copilot users — output is structured JSON / log lines, not the conversational UX Claude offers.
<!-- audit-loop-bundle:prompt:end -->
