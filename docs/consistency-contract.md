# Persona-Test Consistency Mode — HTML Attribute Contract

> Authoritative spec for consumer-app frontend devs adopting consistency mode.
> Plan: [docs/plans/persona-test-consistency-mode.md](plans/persona-test-consistency-mode.md).

This document defines the HTML `data-*` attribute contract that lets the
consistency-mode rig detect cross-step UI/state contradictions without
text-parsing. The Zod schema enforcing the contract lives in
[`scripts/lib/persona-test/schemas.mjs`](../scripts/lib/persona-test/schemas.mjs)
— this doc is the human-readable companion.

## Why an attribute contract

Cross-step contradictions ("the engine says cellar is full but the chip
shows it's empty") are inherently impossible to detect by reading rendered
text. The rig needs to know, for every state-rendering element:

1. Which engine field it claims to project.
2. What value it claims that field has.
3. How fresh that claim is.

Encoding that as data-attributes makes the contract portable across apps,
removes text-parsing ambiguity, and lets the same rig work against
wine-cellar-app and ai-organiser without app-specific branches.

The cost is a one-time annotation pass per consumer app. The payoff is
that contradiction detection becomes a deterministic property of the
annotation + the rig — no LLM in the hot path.

---

## Required attributes (the core three)

Every state-rendering DOM element MUST carry these three attributes when it
asserts a claim about engine state.

### `data-engine-claim`

Dotted path of the engine field being projected.

```html
<span data-engine-claim="capacityRemedy.feasibility">
```

For elements inside a collection (a list/grid item), use `[]` array
notation — the scope binding (below) fills in the index:

```html
<li data-engine-scope="wines-grid" data-engine-key="wine-uuid-abc123"
    data-engine-claim="wines[].vintage">
```

**Note**: the rig diffs against network response JSON, not against rendered
text. The value of `data-engine-claim` matches the `field` in `surfaces.json`
which in turn maps to a `jsonPath` in the network response.

### `data-engine-value`

The projected value as a string. The diff engine coerces this to the
manifest's declared `type` before comparison:

| Manifest `type` | DOM string | After coercion |
|---|---|---|
| `boolean` | `"true"` / `"false"` | `true` / `false` |
| `integer`, `count` | `"42"` | `42` (`NaN` flagged P1 `value-coercion-error`) |
| `enum` | the literal value | must appear in manifest's `semanticValues` |
| `id` | the id string | string compare |
| `freshness` | `"current"` / `"stale"` / `"absent"` | direct compare |
| `prose` | any string | semantic match only if `llmSafe:true` |

```html
<span data-engine-claim="capacityRemedy.feasibility"
      data-engine-value="infeasible"
      data-freshness="current">
  Cannot reorganise — cellar is at capacity.
</span>
```

### `data-freshness`

Required. One of `current` / `stale` / `absent`:

- **`current`** — value is from the most recent engine response known to this surface.
- **`stale`** — value is older than the surface's staleness threshold (cached while a refetch is in flight; SWR pattern).
- **`absent`** — surface knows no value (skeleton state, error state with no last-known).

**Stale-projection rule**: `stale` + any visible claim emits a contradiction
with `kind: 'stale-projection'` at the surface's `severityFloor` (NOT
hardcoded P0 — consumer apps tune per-surface). The point is to surface
stale-projection bugs as their own bug class while letting genuinely-
intentional SWR / optimistic-update patterns set `severityFloor: 'P2'`.

**Null-grounded rule**: when the JSON ground-truth value is `null`, the DOM
is REQUIRED to have `data-freshness="absent"`. Any other freshness on a
null-grounded surface emits a P1 `absent-not-rendered` contradiction.
`data-engine-value` is ignored when freshness is `absent` (the value carries
no claim when the surface knows it has no value).

---

## Collection scope attributes (for lists, grids, tables)

When a surface lives inside a collection of repeated entities, two extra
attributes bind the DOM row to the right entry in the network response.

### `data-engine-scope`

The collection's binding ID. Matches a `collections[].id` in `surfaces.json`.

### `data-engine-key`

The key value that identifies this item within the bound collection.
The manifest's `collectionBinding.keyField` declares how to extract this
key from each response entry.

```html
<!-- surfaces.json declares: -->
<!-- collections: [{ id: "wines-grid",
                     urlPattern: "/api/cellar",
                     jsonPath: "wines",
                     keyField: "id" }]                                  -->

<ul>
  <li data-engine-scope="wines-grid" data-engine-key="wine-uuid-abc123">
    <span data-engine-claim="wines[].vintage" data-engine-value="2020"
          data-freshness="current">2020</span>
  </li>
  <li data-engine-scope="wines-grid" data-engine-key="wine-uuid-def456">
    <span data-engine-claim="wines[].vintage" data-engine-value="2021"
          data-freshness="current">2021</span>
  </li>
</ul>
```

The rig sees the network response `{wines: [{id:"abc123",vintage:2020}, {id:"def456",vintage:2021}]}` and matches each DOM row to its entry via `id` ↔ `data-engine-key`, then diffs `vintage` per row independently.

Nested scopes inherit through DOM ancestry — innermost wins.

---

## Surface manifest (`surfaces.json`)

The manifest declares every state-rendering surface and which engine fields
it projects. Resolution order (the runner tries each in turn):

1. `<repo-root>/.persona-test/surfaces.json` — colocated with canaries (recommended default)
2. `<repo-root>/persona-test-manifest.json` — for repos that prefer surface authorship at root
3. `<src-root>/persona-test-surfaces.json` — for monorepo `src/` layouts

Pick one. The schema is enforced via Zod
([`SurfaceManifestSchema`](../scripts/lib/persona-test/schemas.mjs)).

### Minimum example

```json
{
  "version": 1,
  "collections": [
    { "id": "wines-grid",
      "urlPattern": "/api/cellar",
      "jsonPath": "wines",
      "keyField": "id" }
  ],
  "surfaces": [
    {
      "id": "status-chip",
      "locator": { "kind": "role", "role": "status" },
      "severityFloor": "P0",
      "engineFields": [
        {
          "field": "capacityRemedy.feasibility",
          "type": "enum",
          "semanticValues": ["feasible", "infeasible", "unknown"],
          "networkSource": {
            "urlPattern": "/api/cellar",
            "jsonPath": "capacityRemedy.feasibility"
          }
        }
      ]
    }
  ]
}
```

### Severity floors

Each surface declares a `severityFloor` (`P0`/`P1`/`P2`/`P3`). Contradictions
on that surface CANNOT be raised below this floor — keeps the skill generic
and lets consumer apps tune signal-to-noise per surface.

**Three-tier guidance for status surfaces** (the most common consistency-mode
target — and the one where severity choice gets adopters burned first):

| Surface type | severityFloor | Why |
|---|---|---|
| Contract-critical currency (account balance, payment status, anything where stale is wrong by definition) | `P0` | Every stale-projection event IS a bug. Fail CI on it. |
| Documented stale-tolerant UX (SWR with visible "…updating" copy, optimistic-update patterns, background-sync indicators) | `P1` | The stale-projection still gets recorded in the ledger for trend analysis, but won't fail CI on intentional grace. The chip is doing its job. |
| Recommendation / advisory copy (Restock suggestions, "you might like…", anything where stale is acceptable noise) | `P2` | Surfaced for visibility, never blocks. |
| Pure observability metadata (footer timestamps, debug overlays) | `P3` | Logged for completeness; almost never reviewed. |

**Common adopter trap**: setting a stale-tolerant SWR chip to `P0` because
"it's the main status indicator". Every page-load where the engine is
mid-recompute fires P0 — that's noise, not signal, and adopters either
(a) lower the floor for the wrong reasons or (b) learn to ignore P0s
(corrupting their CI gate). If your chip has documented stale-tolerant
UX, **start at P1**.

The stale-projection contradiction kind ALWAYS fires when
`data-freshness="stale"` is visible — severity choice controls whether
that fires loud or quiet, not whether it fires at all.

### Locators

The `locator` is a discriminated union:

```json
{ "kind": "role",   "role": "status" }
{ "kind": "label",  "text": "Cellar status" }
{ "kind": "testid", "id":   "status-chip" }
{ "kind": "css",    "selector": ".status-chip", "warn": true }
```

Prefer `role`/`label`/`testid` — they're stable. The `css` variant carries
`warn: true` by default so the diff engine emits a P2 finding
("use semantic locator") to nudge migration.

### LLM-safe prose

Only `engineFields[].llmSafe: true` fields get sent to the semantic comparator.
Default is `false` — opt-in protects against accidental PII / business-secret
egress. `llmMaxChars` (default 2000) caps prose length per call to bound LLM cost.

**Contract guidance**: only mark `llmSafe:true` for surfaces whose content
is editorially safe — copy from your own design system, advisory prose,
generic recommendations. Never mark user-input-derived prose `llmSafe:true`.

---

## Canary definition (`.persona-test/canaries/<name>.json`)

A canary is a registered (persona, journey, fixture-seed, expectation) tuple
that lets the consistency rig self-test against a known reference journey.

```json
{
  "name": "oliver-infeasible-reorg",
  "personaId": "pieter-wine-enthusiast",
  "fixtureSeed": "wine-cellar-infeasible-2026-05",
  "authBootstrap": { "kind": "storageState", "storageStatePath": ".persona-test/storage-states/authed.json" },
  "routes": { "cellar": "/cellar", "organise": "/cellar/organise" },
  "scripts": {},
  "journeySteps": [
    { "action": "navigate", "label": "Open cellar", "routeKey": "cellar",
      "waitUntil": "load" },
    { "action": "click", "label": "Start reorganise",
      "locator": { "kind": "role", "role": "button", "name": "Reorganise" } }
  ],
  "expectedContradictions": {
    "min": 1,
    "shapes": [
      {
        "surfaceId": "reorganise-cta",
        "engineField": "capacityRemedy.feasibility",
        "kind": "value-mismatch"
      }
    ]
  }
}
```

### `expectedContradictions`

- `min: 1` ⇒ **broken-canary canary** — rig MUST find ≥1 contradiction. Zero findings = rig is broken (e.g. attribute drift, manifest mismatch). The runner exits 2 (`rig-broken`).
- `max: 0` ⇒ **clean reference canary** — rig must find zero contradictions. Any finding = consumer regression.
- `shapes` ⇒ **strongly recommended** — assert specific `(engineField, surfaceId, kind)` triples are among the contradictions. Without `shapes`, the `min: 1` gate is satisfied by ANY P1+ state-contradiction on the page — which means an unrelated stale-projection on a different surface counts as "the canary passed" even though it has nothing to do with the journey's premise.

**The `shapes` filter is the difference between**:

- "Rig caught ANYTHING this run" (a `min: 1` canary without shapes — trivial bar)
- "Rig caught the INTENDED bug" (a `min: 1` + shapes canary — proves the rig works for THIS journey's purpose)

Write the shape for what the journey is supposed to expose. If the journey
exercises "infeasible-reorg shows Reorganise CTA anyway", the shape is the
contradiction kind, surface, and field that proves it. Without that, a stale
status chip three surfaces away masquerades as a passing canary.

Run with: `/persona-test --mode consistency --canary oliver-infeasible-reorg <url>`.

---

## Setup

```bash
# 1. Install playwright in the consumer repo (one-time)
npm install playwright
npx playwright install chromium

# 2. Create the manifest
mkdir -p .persona-test/canaries
$EDITOR .persona-test/surfaces.json
$EDITOR .persona-test/canaries/<your-canary>.json

# 3. Annotate one state-rendering surface in the consumer app
#    (Add data-engine-claim / data-engine-value / data-freshness)

# 4. Run
node scripts/persona-consistency-run.mjs \
  --canary <your-canary> \
  --url http://localhost:3000
```

### Async-data surfaces (loading states)

The null-grounded rule (above) applies to your **loading shell** too,
not just the post-fetch render. If your chip mounts as a loading
placeholder before the API response arrives, that initial shell still
needs the three attributes:

```html
<!-- Loading shell — fetch hasn't completed yet -->
<span id="status-chip"
      data-engine-claim="capacityRemedy.feasibility"
      data-engine-value=""
      data-freshness="absent">
  Loading…
</span>
```

When the data arrives, your render path swaps `data-freshness` to
`current` and populates `data-engine-value`. The rig auto-awaits manifest
network sources before capturing (up to ~1.5s), so most async surfaces
will be captured in their populated state. But for slow APIs OR for
captures that legitimately happen mid-fetch (e.g. polling), the
loading-state attribute set lets the rig record the truth: "engine
hasn't returned a value yet; DOM correctly knows it doesn't have one."

Without loading-state attributes, the rig sees `unannotated-surface`
during the loading window and `value-mismatch` after the render — both
spurious. With them, it sees `absent → current` transition, which is
exactly what the contract expects.

#### Cross-surface loading derivation (the chip → CTA pattern)

A common case: a slow endpoint backs a secondary surface (e.g. an
Analysis-view CTA card derived from `/api/cellar/analyse`), while a
faster cached endpoint backs a primary surface (e.g. a header chip
from `/api/cellar/status`). A naive implementation hides the secondary
surface until the slow endpoint returns — which strands the user
between "primary says action needed" and "secondary has nothing to
click yet".

The contract-conformant pattern: derive the secondary surface's
*loading shell visibility* from the primary surface's already-rendered
state, NOT from the slow endpoint's response. The chip renders fast,
sets its `data-engine-value` to the actionable state, and (via either
a `CustomEvent` it dispatches OR a `window.__cellarStatus` snapshot it
writes) signals the secondary surface to render its skeleton + disabled
affordance immediately.

This keeps both surfaces in lockstep from first paint:

```html
<!-- T+50ms (chip fetch returned) -->
<button id="status-chip"
        data-engine-claim="stateV2"
        data-engine-value="major"
        data-freshness="current">
  🟠 158 bottles in the wrong section
</button>

<!-- T+50ms (analysis fetch still in flight) — derives from chip -->
<div id="organize-cta" data-variant="loading"
     data-engine-claim="organiseProjection.moveCount"
     data-engine-value=""
     data-freshness="absent">
  <span role="status" aria-live="polite">Computing your plan…</span>
  <button disabled>Organize Now</button>
</div>
```

Adopters MUST NOT use this pattern to invent state the engine hasn't
returned. The secondary surface's `data-engine-value` STAYS `""` /
`data-freshness="absent"` until ITS engine source actually responds.
Cross-surface derivation only controls **visibility of the loading
shell**, never the claimed value.

### Running against local vs deployed builds

A common first-adoption hazard: you annotate in a branch, then run the
canary against your deployed staging URL. The deployed build doesn't
have your annotations yet → guaranteed `unannotated-surface` findings.

Three recommended cadences:

1. **Local-first** (fastest iteration): `--url http://localhost:3000`
   after `npm start` or `npm run dev`. Tightest feedback loop;
   annotations land instantly.

2. **PR-preview** (CI-integrated): your CI builds a preview deployment
   per PR; the canary runs against that preview URL as part of the
   PR check. Annotations and canary live in the same branch, deploy
   together, get tested together.

3. **Staging-after-merge** (slowest, baseline): annotations merge to
   main, deploy to staging, canary runs against staging. Loses the
   per-PR signal but cheap to wire up if no preview infra exists.

The rig emits `unannotated-surface` (P2) when the locator matches an
element but `data-engine-claim` is absent — that's the diagnostic for
"branch annotated, deployed build hasn't caught up". Distinct from
`missing-surface` (locator matched nothing — wrong route or auth state).

**Deploy cadence note**: typical Railway/Vercel/Netlify deploy from
`git push` to "new bundle served" is 3-10 minutes (Docker build +
provider pickup + cache warm-up). CI that runs the canary on the same
workflow as the push trigger will canary the OLD bundle. Two options:

- **PR-preview**: wait for the preview URL to be available (most
  providers post a deployment-ready webhook or status check). Run the
  canary on that URL, not the main staging URL.
- **Two-job pipeline**: job 1 pushes and waits for deploy; job 2 (gated
  on job 1's success) runs the canary against the now-fresh URL.

Without one of these, your CI will report `unannotated-surface` for
every recently-pushed annotation and adopters will think the rig is
broken when it's actually just ahead of the deploy.

### SPA storage-key gotchas (programmatic auth-state seeders)

If your app overrides Supabase's default storage key, programmatic
storage-state seeders that write to `sb-<ref>-auth-token` (the default)
will silently fail — the session looks valid on disk but the app
ignores it. Inspect your `createClient` call:

```ts
// If you see this in your app:
const supabase = createClient(url, key, {
  auth: { storageKey: 'my-app-auth' }   // ← non-default
});
```

…then your seeder must write to `my-app-auth`, not the default key.
For `npx playwright codegen` users this isn't a problem (codegen
captures whatever the app actually writes). For CI jobs that can't
drive a headed browser, audit the storage key before seeding.

### Authoring caveat

**`networkSource.urlPattern` and `jsonPath` values shown in any prompt or
plan are illustrative.** Real-world adoption needs you to open your
app's devtools network tab, navigate to the state you want to test,
find the actual response carrying the field, and write the manifest
against THAT URL and JSON path. A first-time adopter who copy-pastes
`/api/cellar` + `capacityRemedy.feasibility` from example prose against
a real app whose endpoint is `/api/cellar/status` + `stateV2` will get
zero network matches and the rig will silently emit
`unresolved-ground-truth` (or, on this v1, `missing-surface` if the
auth-walled surface never rendered).

### Auth-walled surfaces — the first-run footgun

**Most real SPAs auth-wall their state surfaces.** The
`authBootstrap: { kind: 'none' }` default in the canary template will
land you on the public landing page, the chip will never mount, and
the rig will report zero contradictions (or only rig artefacts) — a
false-positive "rig works". Pick ONE of these BEFORE your first canary
run:

- **`kind: 'storageState'`** — record a Playwright storage state once
  (`npx playwright codegen` and stop after login; save with `Save as`).
  Then reference the file in the canary:
  ```json
  "authBootstrap": {
    "kind": "storageState",
    "storageStatePath": ".persona-test/storage-states/authed.json"
  }
  ```
- **`kind: 'token'`** — if your app accepts bearer tokens for the API
  the chip reads:
  ```json
  "authBootstrap": {
    "kind": "token",
    "tokenEnv": "CELLAR_BEARER_TOKEN"
  }
  ```
  The runner reads `process.env.CELLAR_BEARER_TOKEN` and attaches it
  via `Authorization: Bearer <token>` on every request.

Use `kind: 'none'` only for public surfaces (marketing pages, public
search). For state surfaces inside auth, always specify the auth
mechanism — the rig won't warn you if your "infeasible" canary lands
on the login page instead.

### CI

Add to your existing test workflow:

```yaml
- run: npx playwright install --with-deps chromium
- run: node scripts/persona-consistency-run.mjs --canary <canary> --url $STAGING_URL
```

The runner exits with one of:

| Exit | Meaning |
|---|---|
| 0 | Healthy — canary expectations met, no surprises |
| 2 | Canary broken — rig found fewer (or more) contradictions than expected; investigate rig drift |
| 3 | Fatal rig — manifest missing, canary schema invalid, Playwright disconnected |
| 4 | Ledger persist failed — distinct from "rig found a problem" (disk full / permission) |
| 5 | Playwright missing — run `npx playwright install chromium` |
| 6 | App-error — a journey action threw (e.g. element didn't exist); APP regression, not rig issue |

The session ledger at `.persona-test/sessions/<SID>.json` is ALWAYS persisted
before exit (except when exit 4 fires — that's the explicit "couldn't even
write the ledger" condition).

---

## Retention

These artifacts are local-only (gitignored):

- `.persona-test/sessions/*.json` — per-run ledgers, retain 30 days locally then delete
- `.persona-test/semantic-cache.json` — derived; safe to delete
- `.persona-test/semantic-egress.log` — audit-only, rotates at 10MB

Tracked in git:

- `.persona-test/surfaces.json` (or wherever it resolves per resolution order above)
- `.persona-test/canaries/*.json`

---

## Security / privacy

Consistency mode introduces two egress boundaries — both are gated:

**LLM egress (semantic-compare)**: only fields with `llmSafe: true` get sent
to the external LLM, and content runs through `scripts/lib/redact.mjs`
secret-pattern redactor before egress. Every call is logged to
`.persona-test/semantic-egress.log` with `{timestamp, surfaceId, modelId,
charsIn, costUsd, redactionCount}` (NOT the prose itself).

**Supabase candidate writes**: every JSONB column populated by consistency
mode (`witness_snapshot`, `contradiction_payload`, `journey_context`,
`selectorContextSnippet`) is deep-redacted via `redactObject` before the
cross-skill write. The `redaction_count` is preserved on each row so the
egress trail is verifiable.

**Annotation contract guidance**: annotate STATE-derived surfaces (status,
counts, feasibility), not IDENTITY-derived surfaces (email, name). A name
field is a value the engine renders verbatim — not a state claim — and
doesn't belong in the contract at all.
