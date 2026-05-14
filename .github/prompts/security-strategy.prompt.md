<!-- audit-loop-bundle:prompt:start -->
---
description: "On-demand maintenance of the per-repo security memory: bootstrap an initial threat model + add/append incidents to docs/security-strategy.md with proper marker comments, then refresh the Supabase index."
mode: agent
---
# /security-strategy

Refresh security_incidents from docs/security-strategy.md (interview/edit modes are skill-driven; CLI runs the refresh).

## Run

Invoke the engineering skills CLI:

```bash
node scripts/security-memory/refresh-incidents.mjs
```

Underlying script: `scripts/security-memory/refresh-incidents.mjs` — same code path that Claude skills orchestrate, so output is consistent across both surfaces.

## Notes for Copilot users

For the full skill flow (progressive disclosure, multi-pass orchestration, conversational fix-iterate loops), use Claude Code with `/security-strategy`. This prompt file provides CLI parity for VS Code Copilot users — output is structured JSON / log lines, not the conversational UX Claude offers.
<!-- audit-loop-bundle:prompt:end -->
