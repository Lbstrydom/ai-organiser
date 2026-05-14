<!-- audit-loop-bundle:prompt:start -->
---
description: "Multi-LLM concept-level brainstorming."
mode: agent
---
# /brainstorm

Concept-level multi-LLM brainstorming — calls OpenAI (and optionally Gemini) for independent perspectives; user-driven manual convergence.

## Run

Invoke the engineering skills CLI:

```bash
node scripts/brainstorm-round.mjs --topic-stdin ${input:flags}
```

Underlying script: `scripts/brainstorm-round.mjs` — same code path that Claude skills orchestrate, so output is consistent across both surfaces.

## Notes for Copilot users

For the full skill flow (progressive disclosure, multi-pass orchestration, conversational fix-iterate loops), use Claude Code with `/brainstorm`. This prompt file provides CLI parity for VS Code Copilot users — output is structured JSON / log lines, not the conversational UX Claude offers.
<!-- audit-loop-bundle:prompt:end -->
