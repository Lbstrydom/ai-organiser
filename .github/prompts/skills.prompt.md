<!-- audit-loop-bundle:prompt:start -->
---
description: "Quick reference for every available skill in this repo — name, one-line purpose, triggers, usage examples — without having to open each individual SKILL.md document."
mode: agent
---
# /skills

Quick reference for every available skill — name, one-liner, triggers, usage. Reads SKILL.md frontmatter directly so it cannot drift.

## Run

Invoke the engineering skills CLI:

```bash
node scripts/skills-help.mjs ${input:skill_or_blank}
```

Underlying script: `scripts/skills-help.mjs` — same code path that Claude skills orchestrate, so output is consistent across both surfaces.

## Notes for Copilot users

For the full skill flow (progressive disclosure, multi-pass orchestration, conversational fix-iterate loops), use Claude Code with `/skills`. This prompt file provides CLI parity for VS Code Copilot users — output is structured JSON / log lines, not the conversational UX Claude offers.
<!-- audit-loop-bundle:prompt:end -->
