# CLAUDE.md — Claude Code addendum

@./AGENTS.md

> **Canonical project context lives in [AGENTS.md](./AGENTS.md)** — every AI coding
> agent (Claude Code, Copilot, Cursor, Windsurf, Codex) reads it. Edit shared rules
> in AGENTS.md, not here; this file holds only what does not apply to other agents.
> Migrated mirror→thin 2026-06 to match the canonical topology.
>
> **Never copy this file over AGENTS.md.** They are not mirrors — a thin addendum
> written over the canonical file destroys it. If the two have drifted, run
> `/ai-context-management reconcile`, which moves content *to* AGENTS.md.

## Claude Code-only Notes

### Worktree preflight — hydrate the skills tooling first

Claude Code sessions usually run in a linked git worktree under
`.claude/worktrees/`. The synced tooling tree `scripts/.claude-skills/` is
gitignored, so `git worktree add` does not populate it, and every skill that
shells into it (`/ship`, `/audit-code`, `/ai-context-management`, …) dies on a
bare `MODULE_NOT_FOUND`. Run this once per worktree, before invoking any skill:

```bash
npm run skills:hydrate
```

It copies the tree in from the main checkout via `git rev-parse --git-common-dir`,
and is a no-op in the main checkout. It needs nothing but node and git.

**Do not `cd` to the main checkout instead.** `ship-commit.mjs` and
`cross-skill.mjs` read HEAD, branch and `commit_sha` from the working directory —
from there they would commit and attribute the wrong tree, silently.

### Memory & the `#`-key

Pressing `#` during a session files a learning into Claude's private per-project
memory at `~/.claude/projects/<repo-slug>/memory/` (here:
`C:\Users\User\.claude\projects\C--GIT-ai-organiser\memory\`). That directory is
**local to this machine and invisible to every other agent**.

So route by audience, not by where you noticed it:

- **A fact about this codebase** — a build command, a convention, an invariant, a
  correction to a stale claim — belongs in **AGENTS.md**, even when a Claude
  session is what surfaced it. Copilot and Cursor need it too.
- **`#`-memory is for what is true of *you and this machine*** — user preferences,
  workflow habits, local paths, credentials-adjacent notes that must not be
  committed.

When in doubt, ask whether a teammate's Cursor session would need it. If yes, it
is an AGENTS.md edit, not a memory file.
