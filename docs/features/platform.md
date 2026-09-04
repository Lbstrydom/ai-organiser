# Platform & Cross-Surface Infrastructure

> Subsystem detail moved out of [AGENTS.md](../../AGENTS.md) so the canonical
> context file stays invariant-sized. AGENTS.md keeps the one-line stub and the
> load-bearing rules; the operational depth lives here.

Repo-wide machinery the features sit on: progress reporting, per-feature gating, and the workflow-stage taxonomy that keeps settings and the command picker in step.

---

## ProgressReporter — Universal Progress Indicator

**Status**: ✅ Infrastructure + hot-list migration delivered (April 2026)

**Plan**: [docs/completed/progress-reporter.md](../completed/progress-reporter.md)

Unifies progress UX across LLM-calling code paths via one typed, phase-aware helper. Replaces the prior mix of `busyIndicator` (status bar only), `executeWithNotice` (one-shot toasts), and ad-hoc `new Notice(msg, 0) + setMessage()` copy-pasted across 8+ files.

### API

```typescript
import { withProgress, withProgressResult, ProgressReporter } from 'src/services/progress';

// Canonical call-site pattern
const r = await withProgress(
    { plugin, initialPhase: { key: 'working' }, resolvePhase: (p) => plugin.t.progress.foo[p.key] },
    async (reporter) => {
        reporter.setPhase({ key: 'fetching', params: { current: 1, total: 5 } });
        return await doWork();
    },
);
if (!r.ok) return; // reporter fired the toast — caller does NOT
use(r.value);
```

- **Three surfaces**: status-bar broker ticket (ambient) + persistent Notice (primary) + optional host-inline modal label
- **Terminal states**: `succeed() | fail(err) | cancel() | timedOut(ms)` — reporter owns all notifications
- **Typed phases**: `TKey` union narrowed to per-flow vocabulary; i18n-gated via `plugin.t.progress.{flow}.{phase}`
- **Cancellation**: optional `AbortController` → Cancel button in Notice; `reporter.signal` propagated to downstream work
- **Cancel sentinel**: `{ ok: false, error: 'cancelled' }` routes to neutral "Cancelled" toast, not red "Failed"
- **Stable DOM**: build once, mutate `.textContent` + CSS var; no focus loss, no listener leaks
- **Heartbeat watchdog**: 30s passive ping keeps status bar alive across long single-phase work; 3min leak protection

### Migrated flows (PR 2)

| Flow | Location | Pattern |
|---|---|---|
| Smart note — diagram + improve | [smartNoteCommands.ts:230](../../src/commands/smartNoteCommands.ts) | `withProgress<Phase>` with phase transitions |
| Newsletter — fetch + audio regen | [newsletterCommands.ts:43](../../src/commands/newsletterCommands.ts) | `withProgress` with per-item `triaging` phase |
| Multi-source summarize | [summarizeCommands.ts:449](../../src/commands/summarizeCommands.ts) | Persistent Notice + `setMessage` + `hideProgress()` on all exits |
| Multi-source translate (+ `translateNote`/`translateSelection`) | [translateCommands.ts](../../src/commands/translateCommands.ts) | **`withProgress` raw-phase** (waiting-state-ux Cluster B, June 2026) — shared elapsed ticker + status-bar broker + heartbeat; reporter spans the full op incl. assembly |
| Integration — resolve + merge | [integrationCommands.ts](../../src/commands/integrationCommands.ts) | **`withProgress` raw-phase** (waiting-state-ux Cluster B, June 2026) — replaced ad-hoc Notice + `showBusy`/`hideBusy`; inner catch `dispose()`s (not `fail()`) to avoid double-toast |
| YouTube summarize (pre-existing) | [summarizeCommands.ts:2277](../../src/commands/summarizeCommands.ts) | Ad-hoc persistent Notice (fixed April 2026) |

### Intentionally deferred (plan §11 Out of Scope)

- Kindle sync — already has modal-internal progress callback
- Presentation builder — already uses `GenerationProgressController` with phases
- Flashcards / canvas / generate / digitisation — already using correct ad-hoc pattern; cosmetic consolidation deferred to avoid regression risk
- `ChatModeHandler`/`FreeChatModeHandler` — modal-internal progress already good
- `embedScanCommands` custom progress-bar DOM — battle-tested
- Per-flow `ProgressPhase` unions — defined inline at each call site

### Waiting-state UX — shared elapsed indicator (✅ Complete, June 2026)

One visual language for long LLM waits. Cluster A extracted the SSOT `formatElapsed` ([elapsed.ts](../../src/services/progress/elapsed.ts)) + shared indicator ([progressIndicatorDom.ts](../../src/services/progress/progressIndicatorDom.ts)), rewired the chat thinking indicator onto it, renamed CSS to `.ai-organiser-progress-*`, and added the elapsed ticker to `ProgressReporter`'s Notice surface. **Cluster B** migrated the last ad-hoc progress notices (translate ×3 + integration resolve/merge) onto `withProgress` (see the two table rows above), dropping the nested `withBusyIndicator` in the LLM helpers (status-bar overlap rule — the broker owns one ticket). Code-audited (GPT + Gemini APPROVE) + live persona-verified (8/8: elapsed appears/ticks/clears, single status-bar ticket). Plan: [docs/completed/waiting-state-ux.md](../completed/waiting-state-ux.md).

### Tests

- `tests/progressReporter.test.ts` — 21 tests (state machine, surfaces, terminals, normalizeError)
- `tests/withProgress.test.ts` — 17 tests (Result contract, cancel sentinel, toast ownership)
- `tests/transcriptSanitizer.test.ts` — 8 tests (paste sanitizer for Minutes)

### Transcript paste sanitizer (April 2026 hotfix)

User pasted Office 365 HTML into Minutes transcript field → hundreds of `file:///…/msohtmlclip1/…/clip_imageXXX.gif` references survived to LLM output note → Obsidian CSP blocked each one → UI freeze. Fix: [src/utils/transcriptSanitizer.ts](../../src/utils/transcriptSanitizer.ts) strips file:// refs + markdown image syntax + bare clip_imageNNN tokens on paste (input) AND in `renderMinutesFromJson` output (belt-and-braces).

## Feature Toggles (per-feature on/off gating)

**Status**: ✅ Implemented (June 2026) — Clusters A (read-side gating) + B (toggle UI).

A **Features** settings section lets each feature be turned on/off. OFF ⟹ its commands don't
register, its settings (sub)section is hidden, its picker leaves are hidden, its owned
views/gutter/context-menu items are suppressed, its chat-mode entry is dropped, and its
background services don't init. Default is **Lean** (heavy-use trio chat/research/presentation +
common writing tools on; most add-ons off). Lifecycle is **reload-to-apply** (FT-5): only enabled
features register commands/views at load; toggling persists + re-renders settings + shows a
reload Notice. The gating predicate is the SSOT — `isFeatureEnabled(settings, id)`.

### Core components
- `src/core/features.ts` — **pure data SSOT** (deep-frozen): `FeatureId` union, `FEATURE_REGISTRY`
  (`{id, labelKey, descKey, cluster, requires[], core?, defaultOn, absorbsLegacyFlag?}`),
  `FEATURE_CLUSTERS`, `FEATURE_BY_ID`, + the five ownership maps `SECTION_FEATURE` / `SURFACE_FEATURE`
  / `CHATMODE_FEATURE` (+ `LEAF_FEATURE` = the picker leaf's `feature` field) + `INFRA_SECTIONS`.
  Display copy lives ONLY in i18n (`t.features.*`); the registry holds typed paths (L1 dedup).
- `src/services/featureService.ts` — **pure** flag logic: `isFeatureEnabled` (core OR
  `(strict-boolean flag ?? defaultOn)` AND all `requires` enabled — fail-CLOSED on unknown id /
  malformed value / cycle, path-based DFS guard so diamonds resolve), `defaultFeatureFlags`,
  `resolveEnable` (transitive auto-enable + `also`), `dependentsOf`, `resolveDisable` (refuses core).
- `src/ui/utils/featureActions.ts` — `filterEnabledActions(actions, settings)` (FT-13): one shared
  seam for in-app action lists (chat-mode map, `EnhanceNoteModal`); no-`feature` actions are kept.
- `src/ui/settings/FeaturesSettingsSection.ts` — cluster-grouped toggles, core locked ("always on"),
  enable shows "also enabled", disable-with-dependents → `FeatureDisableConfirmModal` (FT-8).
- `src/main.ts` — `applyFeatureFlags` (FT-5): **single-flight**, routes through `saveSettings`,
  **full-snapshot revert** on failure (cascade-safe), `teardownFeature` on toggle-off (FT-12:
  semantic-search disposes vector store + nulls refs + detaches related-notes view; newsletter
  stops scheduler), awaited re-render, reload Notice. First-run intro Notice gated by the persisted
  `featuresIntroShown` marker (FT-7).

### Six gating sites + the procedural tab
`registerCommands` loops `REGISTER_BY_FEATURE`; the picker filters leaves by `feature` + suppresses
empty groups/categories; `main.ts` onload gates views/gutter/context-menu items + background-service
init; `UnifiedChatModal` builds its handler map from `CHATMODE_FEATURE`; the **settings tab is
procedural** — every feature-owned child section passes through `renderIfEnabled(sectionId, fn)`
(the guard IS the consumer; a render-spy reconciles the captured ids against `SECTION_FEATURE ∪
INFRA_SECTIONS`), and empty umbrellas are removed post-render via `content.children.length === 0`.

### Key patterns
- **Fail-closed (FT-4)**: an id not in the registry is disabled; a leaf with no `feature` is hidden.
- **Legacy master absorption (FT-11)**: `enableSemanticSearch`→`semantic-search`,
  `newsletterEnabled`→`newsletter` are migrated into `featureFlags` (absorb-before-default order)
  and the flag becomes the **sole** gate — every gating reader was swept to `isFeatureEnabled`.
- **FT-9b extractions**: `registerMermaidChatCommand`, `registerPresentationCommands`,
  `registerInsertRelatedNotesCommand` were lifted out of shared/core registrars so a disabled
  feature's command can't leak into the native palette.
- **Completeness invariant**: tests assert every non-core feature is referenced by ≥1 ownership
  map, every picker leaf is tagged, the live section set = `SECTION_FEATURE ∪ INFRA_SECTIONS`, and
  every `labelKey`/`descKey` resolves in `en`.

### Tests
`tests/{featureService,featureRegistry,featureServiceGating,featureActions,commandPickerFeatureGating,settingsTabFeatureGating,applyFeatureFlags,featuresSettingsSection}.test.ts`.

**Plan** (completed): [docs/completed/feature-toggles.md](../completed/feature-toggles.md) · **Audit summaries** (gitignored): `docs/completed/feature-toggles-audit-summary.md` (+ cluster-A). GPT-5.4 per-cluster audits + consolidated Gemini gate **R1 CONCERNS → R2 APPROVE** over the union diff.

## Unified Feature Taxonomy (one SSOT, two projected surfaces)

**Status**: ✅ Implemented (June 2026)

Kills the taxonomy-drift class between the **Features settings menu** and the **Command Picker**: both now derive their top-level grouping from ONE shared vocabulary, and a CI test fails the build if they disagree. Pre-existing feature-toggle ownership maps (`LEAF_FEATURE`, `SECTION_FEATURE`) made this a completion, not a rewrite.

### The SSOT — workflow stages
- `src/core/workflowStages.ts` (neutral, pure): `WorkflowStage = 'capture'|'create'|'refine'|'find'|'maintain'`, `WORKFLOW_STAGES` (display order), `FeatureBoundary = 'external-account'` (v1, single member). NO i18n labels (live in `t.workflowStages[stage]`), NO Lucide icons (live in `ui`). Stage rule: **capture pulls NEW content in; find operates over EXISTING vault content.**
- `src/core/features.ts`: `FeatureDef` carries `stage: WorkflowStage` + `boundary?: readonly FeatureBoundary[]` (replaced the old `cluster`/`FeatureCluster`/`FEATURE_CLUSTERS`). All 24 features re-staged.

### Two projections (rhyme, not identical)
- **Settings** (`src/services/featureProjection.ts` — pure, structure-only, no `t`/icon): `projectSettingsGroups(registry)` folds → Core (the `core` flag wins) → the 5 stages → **Integrations** (features whose `boundary∋'external-account'`), `defaultOn`-first within each group. `FeaturesSettingsSection` renders it; `src/ui/settings/featureStagePresentation.ts` maps group→icon/label (keeps Lucide/i18n out of `services`).
- **Picker** (`CommandPickerModal.buildCommandCategories` — hand-built): top-level categories are **Pinned + the 5 stages**, labelled from `t.workflowStages.*`. Each leaf declares a `stage` (required on leaves via the `cmd()` helper) that MUST equal its category id. "Manage"/"Essentials" retired (`Essentials→Pinned`, persisted setting `pickerEssentialsCommandIds→pickerPinnedCommandIds` + `migrateOldSettings` copy-forward & category-id remap).

### The drift-killer (the deliverable)
`tests/crossSurfaceTaxonomy.test.ts` asserts both surfaces are derivable from ONE declared dataset — **no UNDECLARED divergence**: every feature/leaf `stage` ∈ vocab; non-`pinned` category id === stage and every leaf `stage` === its category id; `pinned` holds only genuine cross-listings (real stage + same object in the stage category + `canonicalCategoryId === 'pinned'`); the Integrations float is driven ONLY by `external-account` (kindle/newsletter float; **bases + notebooklm do NOT** — both are LOCAL tools, no remote-account auth); every cross-stage `leaf.stage` is an enumerated declared override; completeness (every non-core feature reachable). Any new feature/leaf placed inconsistently fails CI.

### Key patterns
- **`stage`/`boundary` are declared data, not runtime grouping** — the picker stays hand-authored (icons/aliases/legacyHomes/sub-groups inline); `leaf.stage` is *assertion metadata*. Avoided a projection engine that would relocate drift-free metadata (right-sizing).
- **`external-account` = genuinely authenticates/transmits to a remote account** — never "relates to an external product." Mislabeling a local tool would pollute the settings privacy signal.
- **`stage` optional on the `PickerCommand` type, required on leaves via the test** — parallel to the existing `feature?` convention.

### Tests
`tests/{featureProjection,featureRegistry,crossSurfaceTaxonomy,commandPicker,commandPickerFeatureGating,settingsMigration}.test.ts`.

**Plan** (completed): [docs/completed/unified-feature-taxonomy.md](../completed/unified-feature-taxonomy.md). `/cycle` autonomous: GPT per-cluster audits + consolidated Gemini gate **APPROVE** ("brilliant architectural enforcement mechanism").


---

## Settings UI Map

Where every settings group lives, and the collapsible mechanics behind them. The
[Unified Feature Taxonomy](#unified-feature-taxonomy-one-ssot-two-projected-surfaces)
above is what keeps this map and the command picker from drifting apart.

### User Task-Based Organization


Organize by **user mental model**, not technical implementation:

**Settings:** Collapsible sections (10 groups) - Setup → Core → Advanced → Preferences → Config
```
▾ AI Provider              — Configure your main LLM provider                [open by default]
▸ Specialist Providers     — Dedicated providers for YouTube, PDF, Audio, Flashcards
▸ Tagging                  — AI-powered tag generation and management
▸ Summarization            — Summary styles, personas, and output options
▸ Capture & Input          — Audio recording, image digitisation, sketch pad
    h2 Audio & Recording
    h2 Smart Digitisation
    h2 Sketch Pad
▸ Meeting Minutes          — Generate structured meeting minutes from transcripts
▸ Vault Intelligence       — Semantic search, RAG, and canvas visualizations
    h2 Semantic Search
    h2 Canvas Boards
▸ Integrations             — External tools and export options
    h2 Obsidian Bases
    h2 NotebookLM
    h2 Document Export
▸ Preferences              — Language, interface, and mobile settings
    h2 Language & Interface
    h2 Mobile
▸ Advanced                 — Configuration files and management
```
**Collapsible state:** Persists across re-renders via `expandedSections: Set<string>` on tab instance. Toggle listener updates Set; `createCollapsibleSection()` reads from Set on re-render.

**Sub-collapsible sections:** Umbrella groups (Capture & Input, Vault Intelligence, Integrations, Preferences) use `createSubCollapsibleSection(container, id, title, icon)` to wrap each child section class in its own nested `<details>`. The same `expandedSections` Set tracks state. CSS class `ai-organiser-settings-sub-section*` styles the nested headers; inner `h2.ai-organiser-settings-header` is hidden via CSS (sub-collapsible summary is the visual header).

**Command Picker Categories** (`CommandPickerModal.ts`) — output-anchored, two-layer:
```
Essentials   ← User-configurable favourites (max 5; default = chat / search / quick peek)
Create       ← Write + Visualise sub-groups + 3 direct leaves
Refine       ← Mutations on existing notes (flat)
Find         ← Search at top + Discover / Audit-vault sub-groups
Manage       ← Recurring + admin (flat)
```

**Modal Sections:** Inputs first → Options → Actions last

### Visual Hierarchy

**Settings structure:**
- `<details>/<summary>`: Collapsible top-level containers (with chevron indicators)
- `h1` + icon: Main sections (`createSectionHeader(title, icon, 1)`) - hidden inside collapsibles via CSS
- `h2` + icon: Subsections (`createSectionHeader(title, icon, 2)`)
- `h4` plain: Group labels (`createEl('h4')`)

**Summary sections:** Title + icon + description in collapsible header
**CSS:** `.ai-organiser-settings-section-content > h1` hidden (summary already shows title)

**Icons:** Every section/command needs contextual Lucide icon. Use `sparkles` for AI actions.

**Buttons:** Primary = `mod-cta`, destructive = `mod-warning`


### Visual Hierarchy


**Settings structure:**
- `<details>/<summary>`: Collapsible top-level containers (with chevron indicators)
- `h1` + icon: Main sections (`createSectionHeader(title, icon, 1)`) - hidden inside collapsibles via CSS
- `h2` + icon: Subsections (`createSectionHeader(title, icon, 2)`)
- `h4` plain: Group labels (`createEl('h4')`)

**Summary sections:** Title + icon + description in collapsible header
**CSS:** `.ai-organiser-settings-section-content > h1` hidden (summary already shows title)

**Icons:** Every section/command needs contextual Lucide icon. Use `sparkles` for AI actions.

**Buttons:** Primary = `mod-cta`, destructive = `mod-warning`


### Async Rendering


Await async `display()` methods to maintain order:
```typescript
await this.summarizationSection.display();  // Correct
```

### Modal UX

- **Dependency-first:** Documents → Dictionary → Audio (extract terms before transcription)
- **Inline controls:** Place actions next to affected items (Gestalt proximity)
- **Progressive disclosure:** Collapse advanced options

---

## Command Picker Architecture

The picker's construction, cross-listing and gating mechanics. Note the taxonomy
block below is the **pre-2026-06 layout**, kept for the mechanics it documents;
the live top-level categories are Pinned + the five workflow stages — see
[Unified Feature Taxonomy](#unified-feature-taxonomy-one-ssot-two-projected-surfaces).

**Command Picker Categories** (`CommandPickerModal.ts`) — output-anchored, two-layer (locked 2026-05-02):
```
Essentials   ← User-configurable favourites (max 5; default = Chat / Search / Quick peek)
Create       ← Outputs (verb-anchored sub-groups + 3 direct leaves):
               • Write       (summarize, minutes, translate, export note, export minutes)
               • Visualise   (presentation, diagram, sketch, 3 canvas variants)
               • Audio narration / Flashcards / Tags (direct leaves)
Refine       ← Mutations on existing notes (improve, integrate, digitise, etc.)
Find         ← Search (chat + semantic-search at top via cross-listing) +
               • Discover    (web reader, research, find related, insert related)
               • Audit vault (find embeds, tag network, collect tags)
Manage       ← Recurring + admin: Kindle, Newsletter, recording, dashboards,
               metadata migration, NotebookLM export
```

**User-configurable Essentials** (added 2026-05-02): `settings.pickerEssentialsCommandIds` (max 5). Empty = static defaults. UI in *Settings → Preferences → Quick commands* — its own collapsible sub-section (`QuickCommandsSettingsSection`, `sub-quick-commands` registered in `INFRA_SECTIONS`, extracted from `InterfaceSettingsSection` 2026-06-07) — pick from any leaf via FuzzySuggestModal. Selected leaves keep cross-listing identity (same `PickerCommand` object reference), so search dedup still works.

**Sub-grouping**: only Create + Find. Refine and Manage stay flat (≤ 8 leaves each). Sub-group labels are action-verbs (`Write`, `Visualise`, `Discover`, `Audit vault`) — sub-groups collapse by default; user expands via chevron click.

**Cross-listing**: Chat / Vault search / Quick peek live in Essentials AND in Find / Refine. Browse mode renders both placements; search mode dedupes by `command.id` and shows the canonical (Essentials) chip via `canonicalCategoryId`.

**Requirement gating**: Each leaf declares `requires?: RequirementKind` (`'none' | 'active-note' | 'selection' | 'vault' | 'semantic-search'`). The picker renders an orange chip + dims the row + intercepts clicks with a Notice when the precondition isn't met. Built into `pickerRequirements.ts` with a minimal `RequirementContext` (no Obsidian `App` dependency — fully unit-testable). Context is rebuilt per render AND per click — no cache leak across the boundary.

**Backward-compat search**: Each leaf optionally declares `legacyHomes: string[]` (e.g. `'active-note-export'`); the helper auto-derives legacy aliases (`'active note'`, `'export'`) so users who learned the old taxonomy still find moved commands.

**Command Picker Architecture**: Custom `Modal` (not FuzzySuggestModal) with inline tree expansion. Pure view-model logic in `commandPickerViewModel.ts` (`buildVisibleItems`, `flattenSingleChildGroups`, `buildSearchResults` with explicit canonical-placement reduce). Browse mode = expandable tree; search mode = flat deduplicated results via `prepareFuzzySearch()`. 38 unique commands surfaced (41 picker rows including 3 cross-listings). All commands have i18n descriptions shown on highlight.
