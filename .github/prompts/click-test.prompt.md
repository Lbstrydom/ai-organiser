<!-- audit-loop-bundle:prompt:start -->
---
description: "Structural DOM audit of a live app — walk every interactive element and assert semantic-HTML contracts (duplicate IDs, orphan labels, inputs without names, ARIA misuse, heading hierarchy, missing alt text, undersized touch targets)."
mode: agent
---
# /click-test

Structural DOM audit — walk every interactive element and assert semantic-HTML contracts. Complement to /persona-test.

## Run

Invoke the engineering skills CLI:

```bash
node scripts/click-test.mjs ${input:url} ${input:flags}
```

Underlying script: `scripts/click-test.mjs` — same code path that Claude skills orchestrate, so output is consistent across both surfaces.

## Notes for Copilot users

For the full skill flow (progressive disclosure, multi-pass orchestration, conversational fix-iterate loops), use Claude Code with `/click-test`. This prompt file provides CLI parity for VS Code Copilot users — output is structured JSON / log lines, not the conversational UX Claude offers.
<!-- audit-loop-bundle:prompt:end -->
