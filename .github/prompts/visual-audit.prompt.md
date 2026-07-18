<!-- audit-loop-bundle:prompt:start -->
---
description: "Math-first, deterministic visual/paint inspection — the 4th UX lens, complementing persona-test (journey), click-test (page), and nav-audit (system)."
mode: agent
---
# /visual-audit

Math-first visual/paint audit — the paint-level lens; token/theme/layout/signifier tiers, drift-only CI gate.

## Run

Invoke the engineering skills CLI:

```bash
node scripts/.claude-skills/visual-audit.mjs --verify ${input:url}
```

Underlying script: `scripts/visual-audit.mjs` — same code path that Claude skills orchestrate, so output is consistent across both surfaces.

## Notes for Copilot users

For the full skill flow (progressive disclosure, multi-pass orchestration, conversational fix-iterate loops), use Claude Code with `/visual-audit`. This prompt file provides CLI parity for VS Code Copilot users — output is structured JSON / log lines, not the conversational UX Claude offers.
<!-- audit-loop-bundle:prompt:end -->
