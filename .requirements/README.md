# `.requirements/` — the de-facto requirements ledger

A **materialized view** of this codebase's de-facto requirements — the
behavioural / safety / security / correctness / persistence invariants the
code already enforces. Generated + reconciled by `scripts/requirements.mjs`
(synced from the `claude-engineering-skills` tooling bundle); do not
hand-edit the generated files.

| File | Origin | Committed? | Purpose |
|---|---|---|---|
| `candidates.json` | generated (`requirements extract`) | no — gitignored | raw 2×-merged extraction output; a transient input to `reconcile` |
| `gaps.json` | generated (`requirements extract`) | no — gitignored | gap-challenge assessments; a transient input to `reconcile` |
| `ledger.json` | generated (`requirements reconcile`) | **yes** | the reconciled requirements at every status — the single source of truth; only `active` ones enter the enforced `/audit-code` rubric. **Committed** so the rubric travels with the repo |
| `overrides.json` | **hand-curated** | **yes** (when present) | per-id `accept` / `reject` / edited `assertion` — the human's deltas-only refine surface |

Workflow:

```bash
node scripts/requirements.mjs extract --files <a,b,...>   # → candidates.json + gaps.json
# (optionally edit .requirements/overrides.json to accept/reject/edit)
node scripts/requirements.mjs reconcile                   # → ledger.json
node scripts/requirements.mjs index                       # print the active index
```

Requirements are surfaced to `/audit-code` as an invariant rubric via
`scripts/lib/requirements/context.mjs`. Ledger absent → `/audit-code`
simply runs without the rubric.
