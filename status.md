# Project Status Log

## 2026-06-05 — Azure-mode feature sweep (live CDP) + >TPM fail-fast fix

Live Electron/CDP sweep of the core Azure-routed features against the real Azure-mode vault (`azure-claude`, `swedencentral`), with real test materials. **All 6 features verified working**: summarize note, generate tags, ingest PDF (multimodal), digitise image (multimodal), Mermaid diagram, translate. Harness: `scripts/persona-harness/azure-feature-sweep.mjs`.

### Bug found + fixed: the >TPM fail-fast over-counted `max_tokens`
The sweep caught a real code bug: a tiny Mermaid request **hard-failed** with ">TPM: ~64k tokens" at a 10k TPM. Root cause: `estimateMinProcessedTokens` added the requested `max_tokens` (the **64000 adaptive-thinking ceiling**) to the lower-bound estimate, so any small text request that hit a token-dim 429 was killed instead of retried — even though it would succeed (translate, same path, recovered via retry).
- Fix (`azureRateLimitHeaders.ts`): the text estimate is now **INPUT-ONLY** (`len/5`) — `max_tokens` is a ceiling, not committed usage, so the true minimum is input + 0 output. Fail-fast fires only when the INPUT alone can never fit; everything else retries. Multimodal now never pre-emptively fail-fasts (`estimateMultimodalMinTokens` → 0; no reliable client-side estimate) and relies on the exhausted-retry error.
- Verified live: post-fix, Mermaid generates a proper flowchart (retries instead of hard-failing). Reverses an over-cautious first-pass audit decision on empirical evidence.

### Test-methodology note (digitise image)
The sweep's first image attempt sent the **raw 657KB full-res** image and failed on TPM — but the real digitise feature **resizes via `ImageProcessorService`** first. With a production-style resize (1024px JPEG, ~98KB) the image passes cleanly and reads the infographic accurately. The harness image step now resizes to mirror production.

### Files Affected
- `src/services/azure/azureRateLimitHeaders.ts` (input-only estimate), `tests/{azureRateLimitHeaders,cloudServiceAzureThrottle}.test.ts` (updated), `scripts/persona-harness/azure-feature-sweep.mjs` (harness), `AGENTS.md` (estimate note).

---

## 2026-06-05 — Slides preview fidelity fix + live Electron/CDP E2E verification

### Live E2E (Playwright CDP → real Obsidian Electron, Azure-mode vault)
Drove the actual app via `--remote-debugging-port` + `connectOverCDP` to make a slide deck **with a web-search source** and prove slides + web search work in Azure mode **without throttling**. A real Azure 429 on the web-search call (`Rate limit … wait 37 seconds`) was caught and **retried to success** with the 37s Azure backoff — zero hard failures, 8 slides generated, PPTX exported. Confirms the Azure pacing/retry coverage end-to-end.

### Sanitizer CSS-allowlist fix (preview fidelity)
Comparing the exported PPTX→PDF against the HTML preview surfaced two real **preview-only** bugs (the PPTX export was always correct): bar-chart bars collapsed (didn't scale) and stat/process **card borders disappeared**. Root cause: `presentationSanitizer` enumerates CSSOM **longhands** via `style.item(i)`, but `ALLOWED_CSS_PROPERTIES` only had the `flex` and `border` **shorthands** — the CSSOM expands `flex:1`→`flex-grow/shrink/basis` and `border:2px solid`→per-side longhands, which were then dropped, collapsing flex-grow tracks + erasing borders.
- Fix: added the flex + per-side-border longhands to `ALLOWED_CSS_PROPERTIES` (`src/utils/presentationSanitizePolicy.ts`). Pure layout, still value-guarded — no security change. Re-rendered deck confirms bars now scale (Brazil 95% → Honduras 11%), matching the PPTX.

### Polish-in-the-wild check (#2 fix)
The user's polished export merged two "Consumer Trends" table slides into one bullet slide (all 5 trends + numbers preserved) **and added** the missing "Bottom Line" closing slide — condensed without deleting substance, exactly as the preservation guardrail intends.

### Files Affected
- `src/utils/presentationSanitizePolicy.ts` (allowlist longhands), `tests/presentationSanitizer.test.ts` (+2 regression tests). Harness (committed, exception to the persona-harness gitignore): `scripts/persona-harness/{driver,pres-websearch-throttle,render-deck-html}.mjs`.

---

## 2026-06-05 — Azure throttle coverage (pace ALL Azure egress, not just text)

The first Azure-429 pass only paced 2 of cloudService's egress primitives. This closes the **4 remaining Azure Foundry egress gaps** so batch/parallel work through them no longer 429-storms. Full `/plan` → `/audit-plan` (GPT R1-R2 + Gemini, REJECT was a pure plan-audit category-error) → `/cycle --autonomous` (2 clusters + code audit + consolidated Gemini APPROVE).

### Changes
- **Shared lease + SSOT keys** (`azureRequestPacer.ts`): `withAzureLease(key,signal,fn)` (the one lease wrapper for fetch/cross-module egress); `normalizeAzureEndpointToHost` (ONE canonical host normalizer, no raw fallback) + `buildAzureClaudeDeploymentKey`/`buildAzureOpenAIDeploymentKey` (SSOT key builders, host+model canonicalized) + `isAzureHost`. Removed the now-dead, divergent `azureRateLimitKey`.
- **Multimodal estimate** (`azureRateLimitHeaders.ts`): `estimateMultimodalMinTokens` = output-budget-only (a base64 PDF/image body is not char≈token → never false-flags an RPM 429 as >TPM).
- **cloudService** (`cloudService.ts`): `sendMultimodal` (PDF/image) now paced + retried + conservative >TPM fail-fast + exhausted-token-429 → actionable error; `summarizeTextStream` gets an **admission-only** lease (covers just the initial fetch+status, releases before the SSE body streams — never ties a slot up for the stream's life) + initial-429 retry; `azurePacerKey()` onto the SSOT builders; `pacedRequestUrl` refactored onto `withAzureLease`.
- **Web-search** (`claudeWebSearchAdapter.ts`): `sendNonStreaming` (per-attempt) + `runStreamLoop` (admission-only) acquire a lease on the **SAME** azure-claude bucket the text path uses → text + research share ONE RPM budget.
- **Audio/Whisper** (`audioTranscriptionService.ts`): `pacedWhisperRequest` **self-detects** Azure from the resolved endpoint (`resolveWhisperPacingKey`) — no `TranscriptionOptions` change, no edits to the 9 call sites. Owns its timeout via an internal AbortController (clears the timer + aborts the retry loop on timeout — no zombie). Embeddings untouched (already cap-1 queued).

### Coverage now
PDF/image, streaming, audio/Whisper, web-search RPM, tagging, summarize/chat/minutes — all Azure-paced. Embeddings via `embeddingQueue` (separate). Non-Azure paths byte-identical.

### Verification
5547 unit tests pass (+24), tsc clean, lint 0 errors, build deployed. Consolidated Gemini APPROVE.

### Files Affected
- `src/services/azure/{azureRequestPacer,azureRateLimitHeaders}.ts`, `src/services/cloudService.ts`, `src/services/research/adapters/claudeWebSearchAdapter.ts`, `src/services/audioTranscriptionService.ts`. Tests: `withAzureLease`, `cloudServiceAzureThrottle` (extended), `claudeWebSearchPacing`, `audioTranscriptionPacing`, `azureRateLimitHeaders` (extended), `azureThrottleWiring` (updated).

---

## 2026-06-05 — Polish no longer deletes load-bearing content (#2)

The per-slide polish (`refineDeckIrSelective`) optimised for word-count under "concision" with no guardrail, so it deleted load-bearing content (e.g. cut a 6-step process-flow to 4, dropping the "Clean Grid" payoff; removed chart framing + summary bullets).

### Changes
- `buildSelectivePrompt` (`refineDeckIrSelective.ts`): added a **PRESERVE load-bearing content** requirement — cut only filler/redundancy; keep the FINAL/payoff step of any process-flow (the conclusion), the slide's thesis sentence, any sentence that frames a chart/gives units, and takeaway bullets; **split rather than delete** when content won't fit. Default no-instruction text softened from "concision" to "tighten wording WITHOUT dropping substance".

### Verification
- Hermetic prompt-invariant test (`refineDeckIrSelective.test.ts`).
- **Live LLM check** (`tests/live/polishPreservesContent.live.test.ts`, gated `LIVE_LLM=1`, skipped in CI): under the exact "this slide is too dense — reduce the text" pressure, the fixed prompt preserved all 6 flow steps (incl. "Clean Grid") + the chart axisLabel + takeaways. Honest caveat: the control (guidance-stripped) run with gpt-4o also kept content on a single run — the original deletion was model-specific (Azure Claude) / nondeterministic, so this is a likelihood-reducing hardening, not a provable before/after.

---

## 2026-06-05 — Azure 429 rate-limit throttling (RPM pacing + Azure-aware retry)

Paces outbound Azure requests under the low Azure RPM cap (~10/min) and adds Azure-aware retry, so batch tagging / index rebuilds no longer 429-storm. Full `/plan` → `/audit-plan` (GPT R1-R2 + Gemini) → `/cycle --autonomous` flow.

### Changes
- **`AzureRequestPacer`** (`src/services/azure/azureRequestPacer.ts`): a self-contained, bounded-FIFO, **two-gate** scheduler — (a) max-concurrency + (b) a rolling-60s **RPM admission window** (a concurrency cap alone is NOT rate pacing). Abortable leases (cancel-while-queued), per-deployment registry, in-place `setPolicy`, injectable clock. `AZURE_PACER_MAX_QUEUE=256`.
- **Pure header/timing helpers** (`azureRateLimitHeaders.ts`): parse both Azure header shapes + `retry-after-ms`/`x-ms-retry-after-ms`; **dimension-aware backoff** (wait for the exhausted dimension's reset, MAX-not-min, authoritative resets honoured uncapped); **evidence-based >TPM fail-fast** = token-dim 429 body AND a conservative lower-bound estimate **incl. the requested output budget** (`max_tokens`) > limit.
- **Typed `AzureRateLimitError`** + shared `formatAzureRateLimitNotice` i18n mapper (`t.azureRateLimit.*`).
- **Wired into `cloudService`** (`postWithRetry` + `makeRequestWithRetry`, Azure-gated via `isAzureAdapter`): per-attempt lease acquire/release (held only for the in-flight HTTP — released before backoff, so no pool stall), Azure backoff, >TPM fail-fast, header logging. **Non-Azure path byte-identical.**
- **`main.ts`**: `setAzurePacerPolicy` from settings on init + settings-change; `disposeAzurePacers` on unload. **Settings**: `azureMaxConcurrentRequests` (default 2) + `azureMaxRpm` (default 10) + migration + `LLMSettingsSection` controls + i18n.

### Decisions / deviations
- The pacer is a unified two-gate FIFO that **supersedes** the standalone (previously-unused) `SimpleSemaphore` for the Azure path — a fixed-size semaphore queue can't express a dual gate, and in-place policy needs a resizable counter.
- The ~20 i18n-god-file audit findings (`en.ts` placeholder/pluralization/taxonomy) are **pre-existing architecture**, deferred (a separate project; flagged only because `en.ts` was touched).
- Known minor (non-blocking, Gemini-APPROVE): `makeRequest` maps an unload-time pacer AbortError to "timed out" — rare; the signal-bearing summarize path is correct.

### Files Affected
- New: `src/services/azure/{azureRequestPacer,azureRateLimitHeaders,azureRateLimitError,formatAzureRateLimitNotice}.ts`. Modified: `cloudService.ts`, `main.ts`, `core/settings.ts`, `ui/settings/LLMSettingsSection.ts`, `i18n/{en,types}.ts`.

### Verification
- 5523 unit tests pass (+35 Azure incl. FIFO/RPM-window/abort/deadlock/NaN/backoff/TPM), type-check clean, lint 0 errors, build deployed. GPT plan R1-R2 + Gemini APPROVE; GPT code audit + consolidated Gemini APPROVE.

---

## 2026-06-05 — Presentation quality fixes (#1 vertical layout, #3 chart credibility, #4 emphasis)

Three deterministic presentation-render/prompt fixes from the slide-deck critique (the remaining items after font embedding + 429 retry).

### Changes
- **#1 vertical layout**: content slides were top-anchored with ~45% empty bottom. The body block-group now uses `justify-content: safe center` (`irToHtml`) — centres sparse content in the body area; `safe` falls back to top-align on overflow so tall slides never clip. (Also fixed the dead `gap:${…}` single-quoted-string interpolation earlier in the font cycle.) **Affects existing decks on re-render** (pure render change).
- **#3 chart credibility**: `bar-chart` IR gains optional `axisLabel` (metric + unit) + `source` (provenance) — `slideIr` schema + `irToHtml` (renders below the bars) + `irToPptx` (annotations below the chart, height-adjusted) + `irPrompts` (LLM now told to ALWAYS set `axisLabel` + cite `source`). Needs a new generation to populate.
- **#4 typography/emphasis**: prompt now restricts paragraph `emphasis` to a single short key sentence (was bolding whole multi-line passages). Body size stays user-configurable (Settings → Export → font size).

### Files Affected
- `src/services/presentationIr/{irToHtml,irToPptx,slideIr,irPrompts}.ts`; tests (`irToHtml`, `slideIr`, `irPrompts`).

### Notes
- #3/#4 are prompt-driven → take effect on the next deck generation; #1 is render-side → visible on re-render of existing decks.
- Remaining: polish-deletes-content (#2) still needs live regen to verify (blocked until Azure TPM quota raised). The **Azure 429 RPM throttling brief** is recommended for `/plan` + `/audit-plan` (shared-transport, high blast radius, 4+ existing scattered 429 mechanisms).

---

## 2026-06-05 — Brand-asset robustness hardening (follow-up to font embedding)

Addressed the pre-existing brand-asset robustness gaps surfaced by the font-embedding code audit (`task_fb71daa0`). Right-sized: did the concrete fixes; skipped the over-engineered refactors (per-context service instances) where Obsidian's single-app model makes them unnecessary.

### Changes
- **Bounded icon concurrency** (M10/M14): extracted `mapWithConcurrency` to `src/utils/mapWithConcurrency.ts` (shared with `llmMarkdownEnhancer`); `resolveBrandRenderContext` now resolves icons through it (cap 6) instead of an unbounded `Promise.all`.
- **Transient-vs-durable cache** (M3): `getLogo`/`getBrandIcon` no longer cache a *transient* raster failure (no DOM / load / timeout / taint) — only durable outcomes (success, or absent/oversize/unsafe). A later attempt with a DOM can succeed.
- **Post-read size recheck** (M4): SVG (decoded chars), PNG + font (`buf.byteLength`) re-checked against caps after read, not just `stat.size`.
- **PNG signature validation** (H2): `getLogo` validates the 8-byte PNG magic (parallel to the woff2 `wOF2` check); shared `hasMagic` helper.
- **Manifest cache keyed by path+mtime** (M11): two brand folders' `icons/manifest.json` no longer collide.
- **Removed `brandFolderPath` cast shim** (M9/M16): it is now a first-class typed `AIOrganiserSettings` field.
- **Font-size bounds** (M12): `sanitizeExportTheme` clamps `fontSize` to [6, 96] pt (`coerceBodyFontSize`). `slide.background` is already Zod-validated (6-hex) — no change needed.

### Files Affected
- `src/utils/mapWithConcurrency.ts` (new), `src/services/audioNarration/llmMarkdownEnhancer.ts`, `src/services/export/brand/{brandAssets,brandRenderContext}.ts`, `src/services/presentationIr/themeSafe.ts`, tests (`brandAssets`, `themeSafe`, `mapWithConcurrency`).

### Verification
- 5484 unit tests pass (+13 new), type-check clean, lint 0 errors, build deployed.

---

## 2026-06-05 — Brand font embedding (preview/PDF render true brand fonts) + web-search 429 retry

Two presentation fixes. (1) Claude web-search 429 rate-limit no longer drops a slide source on the first hit. (2) On-brand decks can now embed `woff2` fonts so the preview + PDF render the true brand face (e.g. Noto Sans) instead of a system fallback.

### Changes
- **Web-search 429 retry** (committed `3cb3ee0`): `claudeWebSearchAdapter.sendNonStreaming` now retries 429 / 529 / transient 5xx with `Retry-After`-honouring backoff (mirrors `CloudLLMService`); on exhaustion the error is tagged so `presentationSourceService` classifies it as `web-search-rate-limited` and shows "try again in a minute" rather than a generic failure. The Azure 10K-TPM quota itself is an IT action (separate).
- **Brand font embedding**: drop `woff2` into `<brandFolder>/fonts/` (default `999_Brand/fonts/`, mirrors `icons/`) → embedded `@font-face` in the preview/PDF.
  - `brandAssets.getBrandFonts` (magic-validate → base64 → `@font-face` bound to the serialized primary family, 2 MB/8 MB caps, byte-bounded LRU, fail-closed) + sync `inspectBrandFontCandidates` (settings status) + `brandFontsSignature` (memo-bust).
  - `themeSafe`: `sanitizeCssFontFamily` (Unicode-aware, injection-safe) **vs** `serializeCssFontFamily` (quoted-once) split; `sanitizeExportTheme` always populates `fontStack` (fixes off-brand stack comma-strip).
  - `brandExportTheme.composeFontStack` leads the stack with the embedded primary (was naming only the fallback).
  - `ExportTheme.fontStack?`/`fontFaceCss?` (optional → PPTX/non-brand byte-identical); injected via the existing `brandCss` head seam in `presentationHtmlService.buildHtmlFromDeckIr`; authorized by `font-src data:` added to `presentationSanitizer.CSP_META`.
  - Settings: "N candidate font file(s)" status line; docs in `docs/brand-setup.md` §4b.

### Decisions Made
- **PPTX + filmstrip/dom-to-pptx raster render the fallback face** — documented v1 limitation (SVG-as-`<img>` can't see host `@font-face`; pptxgenjs can't embed). Live preview + printed PDF are correct.
- Pre-existing brand-asset robustness gaps surfaced by the code audit (unbounded icon concurrency, cache-state modeling, post-read size recheck, PNG-signature validation, module-mutable state) deferred as tracked debt (`task_fb71daa0`) — they predate this feature.

### Process
- `/audit-plan` (GPT R1-R3 + Gemini gate) on the plan — caught 5 would-ship bugs (fontStack naming only the fallback; sanitize/serialize quoting conflict; off-brand stack comma-strip; over-claimed PDF/raster coverage; CSS injection). `/cycle --autonomous` implemented + audited both clusters; consolidated Gemini gate APPROVE. 5471 unit tests + e2e CSP spec (real Chromium) pass; lint 0 errors.

### Files Affected
- `src/services/export/brand/{brandAssets,brandExportTheme,brandRenderContext}.ts`, `src/services/export/exportTheme.ts`, `src/services/presentationIr/{themeSafe,irToHtml}.ts`, `src/services/chat/{presentationHtmlService,presentationSanitizer}.ts`, `src/ui/chat/presentation/presentationThemeResolver.ts`, `src/ui/settings/BrandSettingsSection.ts`, `src/i18n/{en,types}.ts`, `docs/brand-setup.md`, `AGENTS.md`.

### Next Steps
- IT: raise the Azure Foundry Claude deployment TPM quota (10K → ≥200K) — separate from this code.
- Remaining presentation-quality fixes still queued: vertical layout/whitespace (#1), chart axis/units (#3), typography emphasis (#4), polish-deletes-content (#2).

---

## 2026-06-05 — Fix: Azure Foundry web-search 401 (provider-gated key resolution) + build auto-deploy

Presentation web search returned HTTP 401 ("Access denied due to invalid subscription key") on Azure AI Foundry. Investigated **live** by attaching to the running Obsidian Electron renderer over CDP (Playwright `connectOverCDP` on `--remote-debugging-port=9222`) and firing the real request in-process.

### Changes
- **Root cause**: `getClaudeWebSearchKey` (`src/services/apiKeyHelpers.ts`) checked the dedicated `RESEARCH_CLAUDE_WEB_SEARCH_KEY` BEFORE the provider. A private direct-Anthropic (`sk-ant`) key was stored, so under `azure-claude` it was Bearer-sent to the Foundry passthrough → 401. Fix: resolve **Azure-first** — under `azure-claude` the Foundry key wins and the dedicated key is ignored (it's an `x-api-key` direct-Anthropic credential); non-Azure providers still use the dedicated/private key. Azure overrides while selected; private keys reactivate when Azure is off.
- **Reverted a wrong intermediate fix** in `claudeWebSearchAdapter.ts` (had forced the basic tool on Azure — proven live that the dynamic `web_search_20260209` tool + `code-execution-web-tools` beta header work fine on Foundry). Kept the `throw: false` on `requestUrl` so the adapter surfaces the provider's real error body instead of a bare "Request failed, status N".
- **Build auto-deploy**: `esbuild.config.mjs` now copies `main.js`/`manifest.json`/`styles.css` to the vault plugin folder AND `C:\Users\User\OneDrive\Across Devices\mobile` after every build (parent-guarded; `AIORG_DEPLOY_TARGETS` override).

### Files Affected
- Modified: `src/services/apiKeyHelpers.ts` (Azure-first resolver), `src/services/research/adapters/claudeWebSearchAdapter.ts` (revert + `throw:false`), `esbuild.config.mjs` (post-build auto-deploy), `tests/claudeWebSearchAdapter.test.ts` (Azure dynamic-tool path test).
- Created: `tests/apiKeyHelpersClaudeWebSearch.test.ts` (key-source precedence: Azure-on override, non-Azure dedicated, direct-claude main).

### Verification
- Live (CDP-attached Obsidian): **both modes → HTTP 200** with web results. `azure-claude` → Foundry key → Azure endpoint (Bearer); `claude` (Azure off) → dedicated private key → `api.anthropic.com` (x-api-key). Setting flipped + restored in-memory, never persisted.
- 5430 unit tests pass, tsc clean, lint 0 errors.

### Decisions Made
- Key resolution is **provider-gated, not key-presence-gated** — a dedicated key must never be Bearer-sent to Azure. Matches the documented intent (dedicated key = non-Azure transport only).
- Build auto-deploy targets vault + OneDrive only (per user request); `docs/mobile/` staging stays manual/optional.

### Next Steps
- None. (Outside the repo: restart Obsidian to drop the `--remote-debugging-port=9222` used for investigation; rotate the Azure key shared during debugging.)

---

## 2026-06-04 — Unified feature taxonomy (one SSOT, two projected surfaces)

Implemented [docs/completed/unified-feature-taxonomy.md](docs/completed/unified-feature-taxonomy.md) end-to-end via an autonomous clustered `/cycle`. Kills the taxonomy-drift class between the **Features settings menu** and the **Command Picker**: both now derive their top-level grouping from ONE shared **workflow-stage** vocabulary (`capture/create/refine/find/maintain`), and `crossSurfaceTaxonomy.test.ts` fails the build if they disagree. Originated from a `/brainstorm --with-gemini` IA-coherence session.

### Changes
- **Cluster A — SSOT + settings projection**: new `core/workflowStages.ts` (`WorkflowStage` union + `WORKFLOW_STAGES` + `FeatureBoundary='external-account'`, pure — no i18n/Lucide). `core/features.ts` `FeatureDef.cluster`→`stage` + `boundary[]`; all 24 features re-staged; `FeatureCluster`/`FEATURE_CLUSTERS` dropped. New pure `services/featureProjection.ts` (`projectSettingsGroups` — Core→stages→Integrations, structure-only) consumed by both `FeaturesSettingsSection` and the cross-surface test. `ui/settings/featureStagePresentation.ts` holds the Lucide/i18n group mapping. Shared `t.workflowStages.*`; `features.clusters`→`{core, integrations}`.
- **Cluster B — picker projection + drift-killer**: `PickerCommand.stage` (required on leaves via `cmd()`); `buildCommandCategories` rebuilt onto **Pinned + 5 stages** (Manage retired; web-reader/research→Capture; tag-network/collect/find-embeds→Maintain; quick-peek cross-lists Pinned+Find). `Essentials→Pinned` everywhere (persisted `pickerEssentialsCommandIds`→`pickerPinnedCommandIds` + `migrateOldSettings` copy-forward & category-id remap with dedup; i18n keys; internal consts/class/CSS). New `tests/crossSurfaceTaxonomy.test.ts` enforces the projection contract in CI.
- **Integrations correctness**: `external-account` boundary = genuine remote-account auth → exactly `{kindle, newsletter}`. Local tools `bases`+`notebooklm` render under Maintain (an audit + Gemini catch — mislabeling would falsely signal vault data leaving the device).

### Files Affected
- Created: `core/workflowStages.ts`, `services/featureProjection.ts`, `ui/settings/featureStagePresentation.ts`, `tests/{featureProjection,crossSurfaceTaxonomy}.test.ts`.
- Modified: `core/features.ts`, `core/settings.ts`, `main.ts`, `ui/modals/CommandPickerModal.ts`, `ui/settings/{FeaturesSettingsSection,InterfaceSettingsSection}.ts`, `i18n/{types,en}.ts`, `tests/{featureRegistry,commandPicker,commandPickerFeatureGating,settingsMigration}.test.ts`.

### Decisions Made
- **Picker stays hand-built; `leaf.stage` is asserted metadata, not a runtime grouping key** — avoided a projection engine that would relocate drift-free icon/alias/legacyHome metadata (right-sizing). The CI invariant is the drift-killer, not a fold.
- **"No contradictory homes" = no UNDECLARED divergence** — settings Integrations float + per-leaf stage overrides are allowed but must trace to a declared field (`core`/`boundary`/enumerated `leaf.stage`/`pinned`); the test enumerates every override.
- **`FeatureBoundary` reduced to `external-account` only** (YAGNI — dropped speculative `needs-key`/`vault-wide`/`experimental`).

### Audit
- `/cycle` autonomous, two clusters. GPT per-cluster + union code audits: all HIGHs triaged as pre-existing whole-repo patterns or repeat false positives (duplicate-import; tsc clean); genuine in-diff findings (discriminated `SettingsGroup`, readonly `boundary`, stronger tie-order test, completed i18n + internal `Essentials→Pinned` rename) fixed.
- **Consolidated Gemini gate: APPROVE** — architectural coherence "Strong"; `crossSurfaceTaxonomy` called "a brilliant architectural enforcement mechanism"; `projectSettingsGroups`/`resolveEnable` "flawless." Sole LOW (internal naming) fixed before ship.
- Verification: 5426 unit tests pass, lint 0 errors, tsc clean, `npm run build` OK, `test:auto` 45/45.

### Next Steps
- None — feature complete. (Future: a 6th "Study" stage for flashcards/narration if that cohort grows; richer enable-friction ordering — both deferred YAGNI.)

---

## 2026-06-04 — Feature toggles (per-feature on/off gating + Features settings UI)

Implemented [docs/completed/feature-toggles.md](docs/completed/feature-toggles.md) end-to-end via a clustered `/cycle` (A: read-side gating; B: toggle UI). A **Features** settings section turns each feature on/off; OFF hides its commands/settings/picker-leaves/views/chat-mode and skips its background-service init. Default is **Lean**; lifecycle is reload-to-apply.

### Changes
- **SSOT (Phase 1)**: `core/features.ts` (deep-frozen `FEATURE_REGISTRY` + `FeatureId` + five ownership maps) + pure `services/featureService.ts` (`isFeatureEnabled` fail-closed on unknown/malformed/cycle; `resolveEnable`/`resolveDisable`/`dependentsOf`; `defaultFeatureFlags`). `migrateOldSettings` seeds the Lean set + absorbs legacy masters (`enableSemanticSearch`→`semantic-search`, `newsletterEnabled`→`newsletter`).
- **Gating (Phase 2)**: six sites — `registerCommands` loop (`REGISTER_BY_FEATURE`), picker leaf `feature` filter + empty group/category suppression, `main.ts` views/gutter/context-menu + bg-service init, `UnifiedChatModal` handler map (`CHATMODE_FEATURE`), procedural settings tab via `renderIfEnabled` + render-spy + empty-umbrella removal. FT-11 sweep migrated all gating readers off the legacy flags; FT-9b extracted `registerMermaidChatCommand`/`registerPresentationCommands`/`registerInsertRelatedNotesCommand` so disabled features don't leak into the native palette. `filterEnabledActions` (FT-13) gates in-app action lists.
- **Toggle UI (Phase 3)**: `FeaturesSettingsSection` (cluster-grouped, core locked, dependency cascade-confirm) + `applyFeatureFlags` (single-flight, full-snapshot revert, `teardownFeature` on toggle-off, awaited re-render, reload Notice) + first-run intro Notice + `t.features.*` i18n.

### Files Affected
- Created: `core/features.ts`, `services/featureService.ts`, `ui/utils/featureActions.ts`, `ui/settings/FeaturesSettingsSection.ts`, `ui/modals/FeatureDisableConfirmModal.ts` + 8 test files.
- Modified: `commands/index.ts`, `commands/{chatCommands,smartNoteCommands}.ts`, `main.ts`, `core/settings.ts`, `ui/settings/AIOrganiserSettingTab.ts`, `ui/modals/{CommandPickerModal,commandPickerViewModel,UnifiedChatModal,EnhanceNoteModal}.ts`, `ui/contextMenu.ts`, `i18n/{types,en}.ts`, + 11 files swept for legacy-flag gating reads.

### Decisions Made
- Teardown lives as a plugin method (`teardownFeature`), not a registry field — keeps `core/features.ts` a pure data module (mirrors the sibling-map pattern).
- `presentation` gained a real register-fn (FT-9b) despite the plan modelling it as command-less — live code registered `presentation-chat`/`select-presentation-slide` under core `chat`.

### Audit
- Cluster A: GPT-5.4 R1→R2→R3 + Gemini gate **APPROVE**. Cluster B: GPT audit (single-flight/frozen-registry/extracted-modal; dismissed a duplicate-import false positive). Consolidated Gemini gate over the union: **R1 CONCERNS** (`removeUmbrellaIfEmpty` selector fragility) → fixed → **R2 APPROVE**. 5404 unit tests · tsc 0 · lint 0 errors.

### Next Steps
- None — feature complete and shipped. Inner legacy `enableSemanticSearch`/`newsletterEnabled` settings toggles are now vestigial (the feature flag is the master); removing those UI controls is a clean future tidy.

---

## 2026-06-04 — LLM gateway-lite (fail-closed profile + observability + contention-safe indexing)

Implemented [docs/completed/llm-gateway-lite.md](docs/completed/llm-gateway-lite.md) end-to-end via a clustered autonomous `/cycle` (3 clusters, GPT-audited per cluster + a consolidated Gemini gate — **architectural coherence Strong**). A thin coordination layer over the existing long-lived LLM service fixes three live-session failures: an Azure routing leak, a background-indexer 429 storm, and invisible call fan-out.

### Changes
- **Fail-closed provider profile (Phase 1)**: `resolveProviderProfile` SSOT + `NullLLMService` (separate class, no network path). Removed the `|| cloudApiKey` Azure personal-key fallback in `main.ts`; a misconfigured Azure setup now installs `NullLLMService` + one Notice. Keystone negative test: misconfigured Azure ⇒ **zero** `requestUrl` calls to any anthropic.com host.
- **Observability (Phase 2)**: provider trust badge in the chat mode-bar (`🏢 Azure` / `👤 Personal` / `💻 Local` / `⚠ not configured`), per-call attribution debug line + logical-call counter in `CloudLLMService`.
- **Contention (Phase 3)**: `ForegroundGate` (ref-counted leak-safe `withForeground` + `onIdle`), `EmbeddingCooldown` (Retry-After + escalating backoff, clamped to 10 min), `EmbeddingQueue` (cap-1 atomic drain — one `maxBatchSize`-chunk request/iteration, no double-billing; typed re-enqueue; 90s timeout; foreground-yield; path-dedup; per-batch completion). `IEmbeddingService` gains typed `reason` + `maxBatchSize`. User-entry flows wrap in `withForeground`.
- **UX (Phase 4)**: `abortableSleep` makes `postWithRetry` backoff cancellable; an aborted op returns a clean `'Aborted'`; a 429 surfaces "retrying in Ns" in the presentation thinking sink.

### Files Affected
- Created: `src/services/providerProfile.ts`, `src/services/llm/nullLLMService.ts`, `src/services/foregroundGate.ts`, `src/services/embeddings/embeddingCooldown.ts`, `src/services/vector/embeddingQueue.ts`, `src/ui/components/providerBadge.ts`, `src/utils/abortableSleep.ts` (+ 7 test files).
- Modified: `src/main.ts` (gate/cooldown/queue lifecycle + fail-closed swap), `src/services/cloudService.ts`, `src/services/llmFacade.ts`, `src/services/types.ts`, `src/services/embeddings/{types,embeddingServiceFactory,openaiEmbeddingService,+5 providers}.ts`, `src/services/vector/vectorStoreService.ts`, `src/services/chat/presentationHtmlService.ts`, `src/ui/chat/PresentationModeHandler.ts`, `src/ui/modals/{UnifiedChatModal,MinutesCreationModal}.ts`, `src/commands/{summarize,translate}Commands.ts`, `src/i18n/{en,types}.ts`, `styles.css`.

### Decisions Made
- **NullLLMService over a flag**: a separate fail-closed class means no method can "forget" the guard — the negative test holds structurally.
- **Cap-1 serializer is the real thundering-herd fix** (not the cooldown alone): the first 429 sets the cooldown before the next request fires.
- **Queue is plugin-scoped** (constructed `onload`, disposed only `onunload`) — `vectorStoreService.dispose()` (settings re-init) must NOT kill it.
- **withForeground wraps at user-entry points**, never inside the embedding/provider services (layering).
- **Consolidated Gemini G1 (silent-truncation HIGH) rebutted as a verified false premise** — `batchGenerateEmbeddings` sizes output to the full input length and loops over all inputs; its fail-fast fix would have regressed the bulk path. Made the contract explicit via a doc comment instead.

### Verification
5283 unit tests pass (274 files). Production build (full tsc incl. tests + 45 integration checks) green. Lint 0 errors. Bundle deployed to vault + `docs/mobile/` + OneDrive Basket.

---

## 2026-06-03 — Presentation web-search grounding (Option A) + feature-toggles plan audit

Two pieces of work. **(1)** Implemented + code-audited **Option A**: presentation `web-search` sources are now LLM-grounded in the deck's attached notes + prompt before dispatch, instead of running the user's literal query verbatim. **(2)** Authored + audited the **feature-toggles plan** (`docs/plans/feature-toggles.md`, gitignored) to implementation-ready (GPT R1–R3 + Gemini ×9 → Strong coherence) — implementation deferred per the agreed sequencing.

### Changes (Option A — shipped)
- `src/services/prompts/presentationChatPrompts.ts`: `buildWebSearchGroundingPrompt()` + `GROUNDED_QUERY_MAX_CHARS` — XML-structured prompt that distils one grounded query; all user/vault fields escaped via `escapeForPrompt`.
- `src/services/chat/presentationSourceService.ts`: `WebSearchGroundingFn`/`WebSearchGroundingContext`/`ResolveOptions`; `resolve()` is now **two-phase** (notes/folders → web-search) so grounding sees resolved note content. `groundQuery()` is the graceful seam (literal fallback on no-grounder/no-context/empty/throw, never throws). Bounds: description ≤2000 chars, 6×1500-char excerpts, grounded query clamped ≤256 chars in-service; abort re-checked after the grounding call; **standalone notes prioritised over folder-derived** for excerpts.
- `src/services/chat/creationSourceController.ts`: threads `groundWebSearchQuery` + `deckDescription`; **forces web-search to bypass the literal-query preload cache** when grounding is active.
- `src/ui/chat/PresentationModeHandler.ts`: `buildWebSearchGrounder(llmCtx)` (via `summarizeText`, single-line clamp); gated on the new setting.
- `src/core/settings.ts` + `AIChatSettingsSection.ts` + i18n: `presentationGroundWebSearch` (default **true**) — privacy off-switch surfacing that note-derived terms reach the search provider.
- Tests: +37 across `presentationSourceService` (grounding, fallbacks, abort, caps, standalone-priority, read-failure), `creationSourceController` (cache bypass), `presentationChatPrompts` (prompt structure + injection escaping). **5199 unit tests green**, lint 0 errors.

### Decisions Made
- **Grounding is automatic but bounded + cancellable + privacy-gated**: notes already reach the LLM as deck sources, so the only new exfiltration surface is a ≤256-char distilled query → search provider; the default-on setting gives an explicit off-switch.
- **`ref` stays the literal query** (stable cache/dedup identity); the grounded query steers dispatch and is noted in the content header when it differs.
- **Audit convergence**: code audit R2 (security+correctness) PASS, 0 findings; Gemini in-scope findings fixed; deferred findings (`projectService` regex frontmatter, `exportService` BOM, `presentationSourceBudget` folder-floor) are **pre-existing code in files this diff did not touch**.

### Next Steps
- Implement feature-toggles (E) when scheduled; the per-feature folder-floor budget behaviour (Gemini, out-of-scope) is a candidate pre-existing-debt cleanup.

---

## 2026-06-02 — Slides side-rail workspace Phase 2 (vertical filmstrip)

Implemented Phase 2 of [docs/plans/slides-side-rail-workspace.md](docs/plans/slides-side-rail-workspace.md) — a thumbnail navigator left of the slide canvas. A real-Chromium spike validated rastering each slide via SVG `<foreignObject>` → `<img>` → `<canvas>` → PNG data-URL: renders the real slide, no canvas taint, **no script execution** (images don't run scripts), **no external fetch** (Phase-1 sanitization restricts sub-resources to `data:`), and slide CSS never touches the host DOM. Code-audited (GPT R1→R2 + Gemini APPROVE).

### Changes
- `src/services/chat/slideThumbnailProvider.ts` (new): offscreen raster from `this.html`, LRU cache keyed by deck version, `AbortSignal`, CDATA-terminator escaping, `XMLSerializer` for valid XHTML; injectable `rasterize` for tests.
- `src/ui/components/SlideFilmstrip.ts` (new): presentational button group, **sequential** thumbnail load (bounded concurrency), `aria-current` + Arrow/Home/End keyboard nav, hidden at ≤1 slide, `listen()` cleanup, `data:image/png`-only `src` guard.
- `PresentationModeHandler`: filmstrip in the canvas region (inside the canvas grid cell → side-rail grid untouched), wired to `navigateToSlide`, refreshed on deck mutation, disposed. `styles.css`: filmstrip layout, hidden on narrow widths.
- Tests: `tests/slideThumbnailProvider.test.ts` (9), `tests/SlideFilmstrip.test.ts` (7). 4936 unit tests green.

### Decisions Made
- **Raster, not HTML clone**: cloning slide HTML into the host DOM would render untrusted slide CSS outside the sandbox — rejected. Inert PNG thumbnails keep the boundary.
- **Sequential load + tight `data:image/png` guard** (audit): no unbounded concurrent rasterization; only the provider's exact PNG contract reaches `img.src`.
- Pre-existing arch debt (god-object handler, dual deck SoT, hardcoded mode registries) + side-rail e2e spec remain **deferred** — out of Phase-2 scope.

### Next Steps
- Phase 3 (mobile bottom-sheet + filmstrip horizontal strip on narrow widths); optional SlideIframePreview-hardening pass for the deferred debt.

---

## 2026-06-02 — Slides chat UX polish (create-state layout + CTA emphasis)

Two small fixes to the Slides chat surfaced by live use:
- **Create-state layout**: in presentation mode with no deck yet, the empty chat transcript was a giant void. `PresentationLayoutController` now sets a `ai-organiser-pres-create` marker (mode === presentation && !hasDeck); CSS hides the empty transcript and vertically centres the create form + composer + actions below the mode tabs (balanced auto-margins). Cleared once a deck exists (side-rail grid takes over). Test added.
- **CTA emphasis**: "Save as HTML note" was the purple CTA (mis-signalled as primary). Removed its `isDefault`; promoted the composer **send button** to the CTA — the primary action in every chat mode.

Files: `PresentationLayoutController.ts`, `styles.css`, `UnifiedChatModal.ts`, `PresentationModeHandler.ts`, `tests/presentationLayoutController.test.ts`. 4921 tests green.

---

## 2026-06-02 — Presentation sanitizer hardening (Phase 2: iframe CSP/sandbox)

Implemented Phase 2 of [docs/plans/presentation-sanitizer-hardening.md](docs/plans/presentation-sanitizer-hardening.md) — **Decision-7 Outcome A (Harden)**. A real-Chromium spike proved the injected slide runtime was already CSP-blocked (so click-to-edit was already dead) and that an injected attacker script is already blocked under `default-src 'none'`. So: dropped `allow-scripts` from the preview iframe sandbox (now `allow-same-origin` only — the parent still reads `contentDocument` for nav/export), removed the dead runtime injection, and added a real-browser e2e harness proving the CSP + sandbox block scripts. Code-audited (GPT + Gemini APPROVE).

### Changes
- `src/ui/components/SlideIframePreview.ts`: sandbox `allow-same-origin allow-scripts` → `allow-same-origin`; removed dead `<script>` runtime injection; documented the boundary (CSP + DOMPurify; sandbox now a real second layer).
- `playwright.config.ts` (new) + `tests/e2e/presentationSanitizerCsp.spec.ts` (new, 3 Chromium tests) + `npm run test:e2e` script + `.gitignore` for `test-results/`.

### Decisions Made
- **Outcome A over B**: the runtime was already CSP-dead, so `allow-scripts` was dead surface — dropping it is strictly safer with no functional loss beyond the already-broken in-iframe click-to-edit (chat refine + prev/next nav unaffected).
- Pre-existing SlideIframePreview debt the audit surfaced (DOM-fix CSS caps, nonce length, focus mgmt, announce i18n) is **deferred** to a future component-hardening pass — out of Phase-2 scope.

### Next Steps
- Optional Phase 3 (svgSanitize absorption); optional SlideIframePreview-hardening pass for the deferred debt.

---

## 2026-06-02 — Presentation sanitizer hardening (Phase 1: regex → DOMPurify)

Implemented Phase 1 of [docs/plans/presentation-sanitizer-hardening.md](docs/plans/presentation-sanitizer-hardening.md) — replaced the regex/string-rewrite sanitizer for LLM-generated slide HTML with a **DOMPurify** engine, closing the parser-differential bypass class the code audit flagged HIGH. Code-audited (GPT R1→R2 + Gemini R1→R3 APPROVE); see [audit summary](docs/plans/presentation-sanitizer-hardening-audit-summary.md).

### Changes
- **`src/utils/presentationSanitizePolicy.ts`** (new, neutral SSOT): allowlists, `isAllowedPresentationUrl` matrix, `parsePresentationDataImageUrl` (decoded-byte measurement), `extractCssUrls` (robust, fail-closed), budget constants. No DOM/DOMPurify import.
- **`src/services/chat/presentationSanitizer.ts`**: rewritten on DOMPurify — singleton engine + per-call `activeCtx` (enforced re-entrancy guard) + hooks (per-element URL policy, CSS-property allowlist via CSSOM, anchor `rel` canonicalisation) + post-walk image/byte budgets + richer typed `SanitizeResult` (`status`/`removed`/`resources`/`budgetHit`) + **fail-closed** on any error. Same signature; consumers unchanged.
- **`src/utils/svgSanitize.ts`**: derives tags + attrs from the shared policy (M6); input-size budget (M7); external-paint detection via the robust extractor (fixes a backtracking false-positive).
- **`dompurify`** added as a bundled dependency (~45 KB; ships its own types).
- **`tests/presentationSanitizer.test.ts`**: 44-test security corpus (classic + mXSS/parser-differential + SVG + anchor + CSS allowlist + budgets + result contract + golden parity + fail-open regression).

### Decisions Made
- **DOMPurify, not a hand-rolled DOMParser walk** — stop owning the XSS arms race; the engine is the industry answer to parser differentials.
- **Strict allowlist** — `ALLOW_DATA_ATTR/ARIA:false` + enumerated data-*/aria- (per plan + Gemini-G2); CSS url() validation **fails closed** on unparseable tokens (Gemini-G1).
- **Phase 2 deferred** — iframe CSP spike (Decision 7) + real-browser Playwright CSP/parity tests need an Obsidian/Playwright e2e harness that doesn't exist yet; the SlideIframePreview findings the audit surfaced belong there.

### Files Affected
- `src/utils/presentationSanitizePolicy.ts` (new), `src/services/chat/presentationSanitizer.ts`, `src/utils/svgSanitize.ts`, `tests/presentationSanitizer.test.ts`, `package.json`, `package-lock.json`

### Next Steps
- Phase 2: Decision-7 iframe CSP spike → CSP Outcome A/B + `allow-scripts` decision + `tests/e2e/presentationSanitizerCsp.spec.ts` (Chromium).

---

## 2026-06-02 — Slides side-rail workspace (Phase 1) + preview quick-wins

Implemented Phase 1 of [docs/plans/slides-side-rail-workspace.md](docs/plans/slides-side-rail-workspace.md) — the chat-driven Slides mode becomes a canvas-dominant **side-rail workspace** so the 16:9 slide is width-bound (large) instead of height-bound (tiny). Plan audited (GPT 3 rounds + Gemini APPROVE); code audited (GPT R1→R2 + Gemini APPROVE) — see [audit summary](docs/plans/slides-side-rail-workspace-audit-summary.md).

### Changes
- **PresentationLayoutController** (`src/ui/controllers/`): owns a `.ai-organiser-pres-workspace` marker class that activates a CSS grid; reversibly reparents the transcript + composer into a `.ai-organiser-pres-rail` wrapper; resizer (`role=separator`, keyboard-operable) + collapse/expand toggle (out of grid flow, reachable when the rail is `inert`); modal-measured `.ai-organiser-pres-narrow` fallback (NOT viewport `@media`); persists RAW width, clamps on read.
- **Earlier quick-wins** (already shipped): zoom in/out/Fit on the preview, `margin:auto` centering + scaler scroll, 3:1 preview split, status events (Saved/Exported/Polished) demoted to toasts + a render-time filter hiding `system` bubbles in Slides mode.
- **Settings**: `presLayout` slice (railCollapsed/railWidthPx/filmstripCollapsed) + `migrateOldSettings` backfill.
- **i18n**: `presentationLayout` namespace (collapse/expand/resize labels).

### Files Affected
- `src/ui/controllers/PresentationLayoutController.ts` (new) — the layout controller
- `src/ui/controllers/presentationLayoutConstants.ts` (new) — TS-owned clamp constants + `clampRailWidth`
- `tests/presentationLayoutController.test.ts` (new) — 17 tests
- `src/ui/modals/UnifiedChatModal.ts` — construct controller, `syncPresentationLayout()`, dispose
- `src/ui/chat/PresentationModeHandler.ts` — `getLayoutState()`
- `src/core/settings.ts`, `src/i18n/{types,en}.ts`, `styles.css`

### Decisions Made
- **Conditional CSS grid + thin controller, NOT a fork** — all 5 modal regions are direct children of contentEl, so a marker-class grid repositions them with one reversible reparent; the other 5 chat modes stay byte-identical.
- **Activation via controller-owned marker class**, never the preview's internal `:has()` class (decoupled, survives loading/error).
- Sanitizer HIGHs surfaced by the audit are **pre-existing, out-of-scope** (a separate hardening pass; `294211a` already addressed a batch).

### Next Steps
- Phase 2: vertical filmstrip (`SlideFilmstrip` + `SlideThumbnailProvider`).
- Phase 3: mobile bottom-sheet fallback + Obsidian-Playwright e2e harness for `tests/e2e/slides-side-rail.spec.ts`.

---

## 2026-06-01 — Slides: retire the legacy HTML presentation engine (Stages 0–4a)

Implemented [docs/plans/retire-legacy-html-engine.md](docs/plans/retire-legacy-html-engine.md) — structured-IR is now the only presentation path. Commits `c2d4af0` (Stage 1) → `1cbb772` (Stage 2) → `36cffa7` (Stage 3+3.1) → `16ef0ad` (Stage 4a).

### Changes
- **Stage 1**: removed the export-engine dropdown; `migrateOldSettings` coerces stored `'html-legacy'` → `'structured-ir'`.
- **Stage 2** ([PresentationModeHandler.ts](src/ui/chat/PresentationModeHandler.ts)): `runGenerate→generateIr` and `runRefine→refineIr` are IR-only with an explicit error on failure (no silent raw-HTML fallback). `runScopedEdit` ported to `refineDeckIrSelective` on the selected slide(s) — IR-native (element precision → slide-level; undo via versions). `PresentationVersion` now snapshots the deck IR; `restoreVersion` restores it. **Invariant: `html != null` ⇒ `deckIr != null` and not stale.**
- **Stage 3 + 3.1**: deleted `deckIrStale` + `invalidateDeckIr` + every `!stale`/engine guard; dropped the legacy HTML polish loop (IR `polishDeckIr` only); PPTX export always renders from IR. Memoised `resolveExportTheme` by a settings signature; localised the whole-deck polish version label.
- **Stage 4a**: narrowed `presentationExportEngine` to `'structured-ir'`; removed the now-dead `SlideDiffModal` machinery from the handler; removed unused `exportEngine*` i18n keys; updated stale "HTML is the source of truth" headers.
- **Audits**: two GPT-5.4 `/audit-code` checkpoints (after Stage 2 + final). In-scope findings (IR-only PPTX, theme cache, localised labels, always-persist deckIr, enum narrowing, headers) all addressed. Legacy sessions without a persisted `deckIr` load view-only and degrade gracefully.
- **Deferred — Stage 4b** (own follow-up PR): delete the orphaned `generateHtml`/`generateHtmlStream`/`refineHtml`/`refineHtmlScoped` services + `SlideDiffModal.ts` + `RefineScoped*` types + their tests. Fully decoupled (no live caller) but `presentationHtmlService.ts` shares prompt builders between the live IR functions and the dead HTML ones, so trimming needs per-symbol review — best after production validation of the IR-only paths.
- Full tsc 0, lint 0, 4907 vitest pass.

---

## 2026-06-01 — Slides: fix preview collapse as chat grows + per-slide background override

### Changes
- **Preview shrank to a tiny slide as the chat grew**: the pres-mode chat transcript was `flex: 0 1 auto` (content-sized), so each new message claimed vertical space and squeezed the `flex:1` preview to nothing. Fixed in [styles.css](styles.css): the preview takes `flex: 2 1 0` with a `min-height: 300px` floor; the transcript is `flex: 1 1 0; min-height: 120px; overflow-y: auto` so it scrolls internally instead of pushing the preview. (Kept the double-rAF re-scale for the load-timing case.)
- **Per-slide background override** (chat "change the title slide background to white" did nothing — backgrounds were 100% theme-driven, no IR field): added optional `background` (6-digit hex) to `SlideIr` ([slideIr.ts](src/services/presentationIr/slideIr.ts)) + a shared `contrastTextColor()` (perceptual luminance → readable text). Both renderers ([irToHtml](src/services/presentationIr/irToHtml.ts), [irToPptx](src/services/presentationIr/irToPptx.ts)) honour the override on title/section/closing + content title/subtitle, auto-picking dark/light text so "white background" never leaves white text invisible. The IR prompt now documents `background` and tells the LLM to set it only when the user asks. So chat "make the first/last slides white" now works.
- **Tests**: +1 (background override + auto-contrast in irToHtml). Golden fixtures intact. Full tsc 0, lint 0, 4907 vitest pass.

---

## 2026-06-01 — Presentation: consolidate preview/commit paths + fix blank render + auto-scale

### Changes
- **Blank render after a deck change**: the preview was updated by 6 ad-hoc `setHtml` call sites with varying navigate/quality/clamp logic, and `restoreVersion` updated `this.html` but never refreshed the preview at all. Consolidated into ONE [`refreshPreview()`](src/ui/chat/PresentationModeHandler.ts) (clamps `activeSlideIndex` to the current slide count, projects editor HTML, restores the active slide, re-applies quality). Every deck-mutation path now routes through it, including `restoreVersion` (which now also re-renders the version nav counter in a stable host).
- **Auto-scale too small after re-render**: on a re-render the iframe `load` fired before the flex layout allocated the wrapper height, so `updateScale` measured a tiny box and the ResizeObserver never corrected it (real size never changed). Added a double-rAF re-scale in [`onIframeLoad`](src/ui/components/SlideIframePreview.ts) so it re-measures once layout settles.
- **Post-mutation drift** (the deeper inconsistency): the "commit a new deck" sequence was duplicated across generate/refine/whole-deck-polish/selective-polish with drift — **polish skipped `updateReliability` + `runQualityCheck` + the background quality scan**, so quality went stale after a polish. Consolidated into one [`commitDeckMutation()`](src/ui/chat/PresentationModeHandler.ts) (set deck/html → refreshPreview → pushVersion → updateReliability → runQualityCheck → clearSelection → setPhase → background scan). Routed refine, whole-deck polish, and selective polish through it; selective polish now re-scans quality instead of hand-filtering stale findings (also handles split-induced index shifts naturally).
- **Tests**: handler "selective success" updated to assert the consolidated commit (deck/html replaced, quality re-scanned, version pushed). Full tsc 0, lint 0, 4906 vitest pass.

---

## 2026-06-01 — Per-slide Polish: allow 1→N slide expansion (split overloaded slides)

### Changes
- **Reversed the "never split, condense instead" constraint** from the prior fix: a selected slide can now legitimately come back as MULTIPLE slides when overloaded.
- **1→N expansion** ([refineDeckIrSelective.ts](src/services/chat/refineDeckIrSelective.ts)): output shape changed from `{slideIndex, slide}` to `{slideIndex, slides: Slide[]}` (1+ slides per selected index; tolerant of the singular `slide` form). `validateAndSplice` inserts the replacement slides at the selected position (shifting later slides), preserves the original `slide.id` on the first replacement, assigns fresh unique ids (`freshId`) to extras, caps a single split at `MAX_SLIDES_PER_SPLIT = 4`, and re-validates the whole deck (≤60 slides via `validateDeckIr`). Unselected slides untouched. Single self-repair retained.
- **Handler** ([PresentationModeHandler.ts](src/ui/chat/PresentationModeHandler.ts)): when a split changes the slide count, all per-slide findings are dropped (indices shifted); otherwise just the polished slides'.
- **Chat path unchanged**: the whole-deck refine already grows the deck — "add a slide about X" / "split slide 5" works via normal chat (only initial generation pins the count).
- **Tests**: +2 (1→N split with unique ids + shifted neighbours; reject split beyond the cap). 25 service tests; full tsc 0, lint 0, 92 presentation tests pass.

---

## 2026-06-01 — Per-slide Polish: fix shape-mismatch (split→condense + single repair)

### Changes
- **Root cause**: auto-detected findings like "slide is overloaded → split into multiple slides" made the LLM return MORE slides than the selective contract allows (one replacement per selected index) → `shape-mismatch` ("AI returned an unexpected number of slides").
- **Prompt** (`buildSelectivePrompt` in [refineDeckIrSelective.ts](src/services/chat/refineDeckIrSelective.ts)): hardened the fixed-count rule — exactly one replacement per requested slideIndex; never split/merge/add/remove; condense an overloaded slide instead of splitting it.
- **Single self-repair**: the service re-asks ONCE on a recoverable post-LLM failure (shape/index/json/schema), echoing the validation error + exact required indices. Extracted `validateAndSplice` (pure parse+validate+splice) reused for both the first response and the repair; added `isRecoverableError` + `buildSelectiveRepairPrompt`. Revises the plan's deliberate no-repair v1 decision now that real usage shows the miscount is common.
- **Tests**: +2 (repair recovers a shape-mismatch; never retries more than once). 23 service tests pass; tsc 0, lint 0.

---

## 2026-06-01 — Slides: model-aware source budget, Polish autodetect+robustness, IR icons restored

### Changes
- **Model-aware source budget** ([presentationSourceBudget.ts](src/services/chat/presentationSourceBudget.ts)): replaced the flat 40K-char cap (+ per-kind 8K note / 4K web caps) with `computeSourceBudgetChars(provider, model)` — a slice of the actual context window (floor 24K, ceiling 600K). `allocateBudget(sources, totalBudgetChars)` now passes content through UNTRUNCATED when it fits, truncating only when over budget (folder→web→standalone priority). The resolver ([presentationSourceService.ts](src/services/chat/presentationSourceService.ts)) reads FULL content; the budget allocator is the single truncation point. Handler computes the budget from settings and threads it via `resolveForSubmit({ totalBudgetChars })`.
- **Polish autodetect + robustness** ([PresentationModeHandler.ts](src/ui/chat/PresentationModeHandler.ts)): `handlePolish` now runs the autodetect quality scan (`ensureQualityFindings`) before opening the per-slide modal so the boxes prefill with detected issues ("Analysing slides…" shown). Fixed the legacy/HTML polish **no-op** (it broke out of the loop when there were no findings → did nothing; now runs a general polish pass). Hardened `openPolishSelector` so a modal-open failure clears the single-flight `activePolish` guard + shows a Notice (was a latent permanent-silent-no-op). Added a `Polish routing —` debug log.
- **IR icons restored** ([slideIr.ts](src/services/presentationIr/slideIr.ts), [irToHtml.ts](src/services/presentationIr/irToHtml.ts), [irToPptx.ts](src/services/presentationIr/irToPptx.ts), [irPrompts.ts](src/services/presentationIr/irPrompts.ts)): the IR path had dropped icons entirely (unused schema field, no prompt instruction, no rendering). Added optional emoji `icon` to stat-grid cards (existed) + process-flow steps; the prompt now asks for one relevant emoji per card/step; both renderers draw them (HTML above value/title, PPTX inline). Emoji chosen for portability (renders in preview AND survives PPTX export).
- **i18n**: `slideCreateSourceViewResults/HideResults/ResultsEmpty` (web-search preview, prior commit) + `polishSelector.analysingLabel`.
- **Tests**: budget rewritten for pass-through + `computeSourceBudgetChars`; `getResolvedSources` (controller); irToHtml icon render; modal/handler updated for `analysingLabel` + pre-scan stub. Full tsc 0 errors, 4902 vitest pass, 47 automated checks, lint 0 errors.
- **Decision**: legacy HTML presentation engine → staged retirement planned (own cycle) per user.

---

## 2026-06-01 — Web-search source results preview (Slides create panel)

### Changes
- **Problem**: in the Slides create panel, adding a web-search source runs the search eagerly (`preloadAsync`) and caches the retrieved content, but the content was never surfaced — the user only saw a green ✓ with no way to see what the search found.
- **Fix**: resolved web-search rows now render a collapsed-by-default, expandable `<details>` preview of the retrieved content ([src/ui/chat/presentation/CreatePanel.ts](src/ui/chat/presentation/CreatePanel.ts) `renderWebSearchPreview`). Collapsed so it never crowds the source list until expanded; summary toggles "View results" ↔ "Hide results".
- **Controller**: new `getResolvedSources(index)` on [creationSourceController.ts](src/services/chat/creationSourceController.ts) exposes the cached `PromptSource[]` for preview UI.
- **i18n**: `slideCreateSourceViewResults` / `slideCreateSourceHideResults` / `slideCreateSourceResultsEmpty` (en + zh + types + CreatePanelT Pick).
- **CSS**: `.ai-organiser-pres-create-source-preview*` (full-width line below the row via `flex-wrap`; scrollable `pre-wrap` body capped at 14em).
- **Tests**: 2 new `creationSourceController.getResolvedSources` cases (retrieved content after preload; empty for unresolved/out-of-range). Full `tsc` 0 errors, i18n parity green.

---

## 2026-06-01 — Per-slide polish (PolishSelectorModal + selective deck-IR refine) + working-tree test alignment

### Changes
- **New service — `refineDeckIrSelective`** ([src/services/chat/refineDeckIrSelective.ts](src/services/chat/refineDeckIrSelective.ts)): selective per-slide deck-IR refine with an all-or-nothing splice contract. Single `summarizeText` call (no 1-repair, intentional divergence from whole-deck `refineDeckIr`). Layered validation — pre-LLM (empty/duplicate/out-of-range selections + provider-aware token-budget guard via `isContentTooLarge` on the **full assembled prompt**) then post-LLM (`tryExtractJson` → shape/length → duplicate-returned-index → exact index-set match → per-slice `SlideIrSchema.safeParse` → deck-level `validateDeckIr` on the spliced candidate). Force-preserves the original `slide.id` on every replacement. Any layer failure → typed `Result.err('<code>: <detail>')`; never throws. `parseRefineErrorCode` decodes the prefix back to a `RefineErrorCode`.
- **New contract module** ([src/services/chat/refineDeckIrSelectiveTypes.ts](src/services/chat/refineDeckIrSelectiveTypes.ts)): `RefineErrorCode` union + `REFINE_ERROR_CODES` set both derived from one `CODES` const array. Neutral module so `i18n/types.ts` imports the union without depending on a service.
- **New modal — `PolishSelectorModal`** ([src/ui/modals/PolishSelectorModal.ts](src/ui/modals/PolishSelectorModal.ts)): pure IoC UI component. Privacy notice (`role=note`), optional deck-wide findings block, "All slides" escape hatch, per-slide checkbox + textarea rows pre-filled from `QualityFinding`s, error banner (`role=alert`), Cancel + Action row. Stays open through the LLM call so the draft survives any failure. Lifecycle-clean via `listen()` + `cleanups`. CSS prefixed `ai-organiser-polish-*`.
- **Handler wiring** ([src/ui/chat/PresentationModeHandler.ts](src/ui/chat/PresentationModeHandler.ts)): `handlePolish` routes IR-backed decks with >1 slide to `PolishSelectorModal` (single-slide IR + legacy HTML keep the existing whole-deck path, extracted to `runWholeDeckPolish`). New `openPolishSelector` + `runPolishSubmit`: selective path wrapped in `withProgressResult`; mutates deck/html/quality/version state only after `Result.ok`; invalidates stale findings for changed slides + zeroes stale scores; pushes a 1-based version label. Single-flight `activePolish` guard (closed in `cancelActiveOperation`).
- **i18n**: `modals.polishSelector` slice added to `types.ts` (`errorByCode: Record<RefineErrorCode, string>`), `en.ts`, `zh-cn.ts`.
- **Tests (3 new, 44 cases)**: `tests/refineDeckIrSelective.test.ts` (21), `tests/PolishSelectorModal.test.ts` (14), `tests/presentationModeHandler.polish.test.ts` (9).
- **Code audit**: GPT-5.4 R1 (1H/11M/3L) → fixed 5 (token-guard fidelity, CSS prefix, `raw` type, derived codes, comment), dismissed 10 as settled/justified plan decisions; Gemini final gate → **APPROVE** (its 2 CONCERNS described the plan pseudocode, not the diff — challenged with evidence). Summary: [docs/plans/per-slide-polish-audit-summary.md](docs/plans/per-slide-polish-audit-summary.md).
- **Working-tree test alignment (required to ship a green tree)**: aligned 6 pre-existing test files to current source contracts from the in-progress presentation-IR / audio / speaker / research work — `claudeWebSearchAdapter.test.ts` (adapter now resolves the `latest-sonnet` sentinel internally → assert resolution + derive tool version, no hardcoded version), `audioNarrationService.test.ts` (`PreparedNarration` now requires `llmIntent`/`fingerprintMtime`), `audioSourcePicker.test.ts` (`AudioSource` union narrowing), `speakerReviewStateCanGenerate.test.ts` (`SpeakerMapping` is now `Record<string,string>`), `transcriptNoteService.test.ts` (`@ts-expect-error` placement), `audioImportService.test.ts` (`createBinary` mock arity). Whole tree now green: full `tsc` 0 errors, 4896 vitest pass, 47 automated checks pass, lint 0 errors.

### Files Affected
- **New (6 + audit summary)**: `src/services/chat/refineDeckIrSelective.ts`, `src/services/chat/refineDeckIrSelectiveTypes.ts`, `src/ui/modals/PolishSelectorModal.ts`, `tests/refineDeckIrSelective.test.ts`, `tests/PolishSelectorModal.test.ts`, `tests/presentationModeHandler.polish.test.ts`, `docs/plans/per-slide-polish-audit-summary.md`.
- **Modified (feature)**: `src/ui/chat/PresentationModeHandler.ts`, `src/i18n/{types,en,zh-cn}.ts`, `styles.css`.
- **Modified (test alignment)**: `tests/{claudeWebSearchAdapter,audioNarrationService,audioSourcePicker,speakerReviewStateCanGenerate,transcriptNoteService,audioImportService}.test.ts`.
- **Note**: this commit also carries a large pre-existing in-progress changeset (presentation structured-IR engine, research adapters) that per-slide-polish builds on — committed together at the user's request after verifying the whole tree is green.

### Decisions Made
- **Full deck sent as read-only LLM context (with a permanent privacy notice)**: extra context prevents drift; the `role=note` disclosure makes the data boundary explicit. Settled across the plan's 6 audit rounds.
- **String-prefix error codes over a forked `Result<T,E>`**: keeps the canonical `Result<T>` intact; `parseRefineErrorCode` round-trips the code for i18n lookup.
- **No 1-repair in the selective path (v1)**: smaller, fully-validated service; the modal keeps the draft for a manual retry on failure.
- **Aligned stale tests to current source (not reverted source)**: the other features' source carries deliberate, commented changes; lagging tests updated to match — version-agnostic assertions where a sentinel resolves, per the always-use-latest-model-sentinels rule.

### Next Steps
- v2 candidates (per plan Out-of-Scope): shared LLM-call+repair+JSON engine; saved polish presets; vault-persisted version history; partial-application on single-slice failure.

---

## 2026-05-31 — Anthropic prompt caching (Phases 1/2/2c/3) + officeparser util-shim cycle fix

### Changes
- **Phase 1 — Cache instrumentation** ([src/services/adapters/claudeAdapter.ts](src/services/adapters/claudeAdapter.ts)): added `logCacheUsage(usage, source)` private method called from both `parseResponseContent` (non-streaming) and `parseStreamingChunk` on `message_start` events. Emits `[Cache] claude {response|stream-start} model=X in=N cache_write=N cache_read=N out=N` via `logger.debug` — silent in production, visible when `debugMode` is on. Foundation for all subsequent phases — no behavioural change.
- **Phase 2 — `SummarizeOptions.stablePrefix` + Claude body shaping** ([src/services/types.ts](src/services/types.ts), [src/services/cloudService.ts](src/services/cloudService.ts)): new optional `stablePrefix` field on `SummarizeOptions`. `buildClaudeSummarizeBody` extracts split into `buildClaudeSystemAndUser(systemPrompt, prompt, modelName, stablePrefix)` helper. When stablePrefix length ≥ per-model minimum (4096 chars for Sonnet/Opus, 8192 for Haiku), emits `system: [{type:text, boilerplate}, {type:text, stablePrefix, cache_control:{type:'ephemeral'}}]`; user message carries only volatile content. Below threshold → falls back to concatenation, no cache_control marker (avoids 1.25× write penalty Anthropic charges for sub-minimum writes). Non-Claude providers (Gemini, OpenAI) silently concatenate via `effectivePrompt` so callers can pass split prompts uniformly without provider branching.
- **Phase 2 — Minutes chunked extraction wiring** ([src/services/minutesService.ts:587-606](src/services/minutesService.ts)): per-chunk extraction loop split into stable header (dictionary + agenda + participants + context summary + format schema via `buildChunkExtractionPrompt`) and volatile per-chunk transcript payload. 90-min meeting → 1 write + 11 reads instead of 12 writes — prefix tokens read at 0.1× after chunk 1.
- **Phase 2c — Single-call + consolidation + intermediate-merge wiring** ([src/services/minutesService.ts:302-336, 672-700, 909-919](src/services/minutesService.ts)): same split applied to the three remaining paths. Short meetings that don't trigger chunking still benefit on truncation retries (`retryIfTruncated` re-fires with same prefix) AND on regeneration (user re-running minutes for same meeting). Consolidation header (`buildStyleConsolidationPrompt`) stable across truncation retries. Intermediate-merge header (`buildIntermediateMergePrompt`) stable across all batches in one reduction pass.
- **Phase 3 — Free Chat stable/volatile split** ([src/ui/chat/ChatModeHandler.ts](src/ui/chat/ChatModeHandler.ts), [src/ui/chat/FreeChatModeHandler.ts:203-333](src/ui/chat/FreeChatModeHandler.ts), [src/ui/modals/UnifiedChatModal.ts:871](src/ui/modals/UnifiedChatModal.ts)): added optional `stablePrefix?: string` to `SendResult` interface. `FreeChatModeHandler.buildPrompt` reorganised so stable parts (auto-memory + global memory + project instructions + project memory + project files + flat attachments) collect into one block, volatile parts (conversation history + RAG retrieval + question) into another. Flat attachments moved BEFORE history so the stable prefix stays contiguous. `UnifiedChatModal` forwards `result.stablePrefix` through `summarizeText` options. Multi-turn sessions cache the system+project+memory+attachments prefix after turn 1; turns 2+ read at 0.1×.
- **officeparser fix — util shim self-recursion cycle** ([esbuild.config.mjs:42-60](esbuild.config.mjs)): root cause of the "n.parseOffice is not a function" cascade users hit when attaching PDFs to Minutes. The original `electronBuiltinShimPlugin` generated shim code containing literal `require('util')` — esbuild's static scanner rewrote that to point at the shim itself, creating an infinite `B_()` cycle that esbuild's cycle detector broke by returning `{}`. Result: `util.inherits` undefined → `file-type → strtok3 → util.inherits(...)` throws inside officeparser's module-load chain → caught → first call's exports cached half-initialised → subsequent calls return broken module with missing `parseOffice`. Fix: shim now resolves require via `window.require || globalThis.require || null` instead of literal `require(...)` — esbuild can't see the call site, no rewrite, no cycle. Diagnostic logging added in [src/services/documentExtractionService.ts:148-172](src/services/documentExtractionService.ts) to surface the actual exception message + defensive null-return when `parseOffice` is missing from the dynamic-import result.
- **Tesseract.js no-op stub** ([src/stubs/tesseractNoop.cjs](src/stubs/tesseractNoop.cjs)): wired via `alias: { 'tesseract.js': ... }` in esbuild config. officeparser eagerly requires tesseract.js at module-load for OCR support; we never enable OCR. Stub provides the full surface (`createWorker`, `createScheduler`, `OEM`, `PSM`, etc.) so officeparser loads cleanly without pulling in Tesseract's Web Worker spawning code (which fails to bundle for Electron renderer anyway). If OCR is ever accidentally enabled, stub returns empty results instead of throwing.
- **Tests** (3 new files + 2 modified): `tests/claudeAdapterCacheUsage.test.ts` (10 tests — instrumentation fires on both code paths, silent when debugMode off, graceful when usage missing); `tests/claudePromptCaching.test.ts` (10 tests — body shape transformation, per-model thresholds, idempotency across calls, no marker for non-Claude providers, composes with adaptive thinking); `tests/freeChatModeHandler.test.ts` extended (5 new tests — stable/volatile split, prefix invariance across turns, prefix-busting on memory mutation); `tests/minutesService.test.ts` updated (5 assertions migrated from `prompt`-only check to combined `prompt + options.stablePrefix` check since style instructions moved out of user message). 4751 unit tests pass.
- **Live verification**: 5 CDP-driven persona-harness runs across the day on `AI-Organiser/Z Tesating run/Test Minutes Hamina 1 1 1.md` (audio + 4 PDFs + agenda docx + 297-term dictionary). Confirmed in production bundle: instrumentation fires (`[Cache]` lines appear in dev console with correct format), officeparser now extracts real text (12473/1001/846 chars per attached doc — vs lossy byte-level fallback before fix), Phase 3 chat wiring fires (3 turns → 3 `[Cache]` lines captured with cache_write=0/cache_read=0 because test had no project/memory/attachments — threshold gate correctly suppressed marker on tiny prefixes, no 1.25× penalty waste). Final manual minutes run with proper audio + full transcript produced minutes file successfully with no console errors.

### Files Affected
- **New (3)**: `src/stubs/tesseractNoop.cjs` (tesseract.js stub), `tests/claudeAdapterCacheUsage.test.ts`, `tests/claudePromptCaching.test.ts`.
- **Modified (10)**: `esbuild.config.mjs` (shim cycle fix + tesseract alias + url+path imports), `src/services/adapters/claudeAdapter.ts` (logCacheUsage hook), `src/services/cloudService.ts` (buildClaudeSystemAndUser helper + effectivePrompt for non-Claude branches), `src/services/documentExtractionService.ts` (officeparser diagnostic logging + null-return guard on missing parseOffice), `src/services/minutesService.ts` (stablePrefix on chunked + single-call + consolidation + intermediate-merge), `src/services/types.ts` (stablePrefix field on SummarizeOptions), `src/ui/chat/ChatModeHandler.ts` (stablePrefix field on SendResult), `src/ui/chat/FreeChatModeHandler.ts` (stable/volatile split in buildPrompt, flat attachments reordered ahead of history), `src/ui/modals/UnifiedChatModal.ts` (forward result.stablePrefix to summarizeText), `tests/freeChatModeHandler.test.ts` (+ buildPrompt tests), `tests/minutesService.test.ts` (assertion updates).

### Decisions Made
- **Conservative per-model thresholds (4096 chars Sonnet/Opus, 8192 Haiku) over Anthropic's stated minimums (1024/2048 tokens)**: real-world prompts vary in chars-per-token (English ~3.5, code ~3, CJK ~1.5). Using 4 chars/token as a defensive estimate guarantees we never write a sub-minimum prefix and pay the 1.25× penalty for nothing. Below-threshold callers get silent concatenation — no observable behaviour change, just no caching engaged.
- **Provider-neutral API surface, Claude-specific implementation**: `stablePrefix` lives on the generic `SummarizeOptions` (not on a Claude-specific helper) so chat/minutes/research/etc callers don't need to branch on provider. Non-Claude paths concatenate transparently. Future Gemini context caching (different API shape — explicit lifecycle + storage fee) can be wired into the same option without changing callers.
- **Stable header in `system` content block, not user message prefix**: Claude Messages API treats system + messages as one continuous context, so functionally identical. But emitting the cached prefix in the system field (Anthropic's recommended pattern) keeps the user message focused on the volatile payload — semantically cleaner and matches their documentation examples.
- **Phase 3 prompt reordering accepted**: moved flat attachments above conversation_history in `FreeChatModeHandler.buildPrompt` to keep the stable prefix contiguous. Prompt-block ordering doesn't materially affect Claude's output quality when blocks are XML-tagged, and this enables caching to work. Documented in the buildPrompt comment.
- **Instrumented FIRST, plumbed SECOND**: Phase 1 (logger-only, no behaviour change) shipped before any caching wiring so we'd be able to measure hit rates immediately when caching turned on. Pattern matched the brainstorm session's "measure before plumb" recommendation.
- **Tesseract stub vs library swap**: chose to stub tesseract.js rather than switch officeparser to a PDF-only alternative (e.g. pdfjs-dist). Stub is one file; library swap would touch every docx/xlsx/pptx flow. We never want OCR; if a user ever does, swapping the stub is trivial.
- **Punted on extending Phase 3 to research / mermaid / other chat surfaces**: only Free Chat wired. ResearchModeHandler and MermaidChatModal have their own prompt builders and conversation-history shapes. Pattern (return `{prompt, stablePrefix}` from SendResult, forward through summarizeText) is now established — extending to those handlers is a one-file change each, deferred until usage data justifies it.

### Next Steps
- Extend Phase 3 to ResearchModeHandler + MermaidChatModal (same `SendResult.stablePrefix` pattern).
- Optional: add a `currentDate` block to FreeChatModeHandler's stable prefix (model genuinely doesn't know today's date; trade-off is cache invalidates daily at midnight). Discussed during this session — held pending user decision.
- Optional: settings toggle to skip the "Low transcript coverage" warning that blocks minutes generation on short/partial transcripts (real friction surfaced this session — user hit it repeatedly during cache verification runs).
- First live `cache_write=N → cache_read=N` pair: run minutes a second time within 5 min on any meeting with a substantial dictionary loaded (the Hamina 297-term dictionary will clear the threshold). Instrumentation + wiring + officeparser fix all in place; purely observation, not engineering.

---

## 2026-05-26 — Multi-segment minutes: full wiring of all 8 deferred items

### Changes
- Resolved every "built but not yet wired" item from the 2026-05-25 MVP slice. Multi-segment is now end-to-end functional in the modal.
- **Modal wiring** ([src/ui/modals/MinutesCreationModal.ts](src/ui/modals/MinutesCreationModal.ts)): instantiate `SectionRegistryController` lazily (matches docController survival pattern), capture `sourceFileAtOpen: TFile` at modal open (R2-M6 — never re-query workspace mid-session), render always-visible "+ Add topic" button next to the modal title + topic chip strip showing the current registry, inline focus-trapped topic-name prompt on click. `handlePickDetectedDocs` now passes the registry + sourceFile into `DocumentMultiPickerModal` AND applies per-row `sectionId` assignments via `docController.setSectionId`. Document list renders `SectionAssignmentSelect` per row when `registry.hasTopics()` (D11 visibility policy).
- **Submit dispatch** ([src/ui/modals/MinutesCreationModal.ts:handleSubmit](src/ui/modals/MinutesCreationModal.ts)): prunes empty topics → computes effective section IDs from doc assignments + general transcript → calls `shouldUseLegacyPath()`. When legacy, today's `generateMinutes()` path runs unchanged. When multi-segment, calls new `generateMultiSegmentMinutes()` with a `MultiSegmentInput` built from state by `buildSegmentsFromState()`. Each segment carries its scoped `contextDocuments` (concat of docs whose `sectionId` matches) but transcripts are general-only for this slice (per-section transcript picker deferred).
- **Service wrapper** ([src/services/minutesService.ts:generateMultiSegmentMinutes](src/services/minutesService.ts)): new `Promise<Result<MinutesGenerationResult>>` entry point. Calls `runMultiSegmentExtraction`, branches on `cancelled` / `allFailed`, renders `MinutesJSON` via `renderMinutesFromJson` (now sections-aware), writes the .md note using the same `buildMinutesFrontmatter` + `buildMinutesJsonComment` machinery as the legacy path. Legacy `generateMinutes()` left untouched — no 30+ test-site migration needed.
- **Renderer** ([src/utils/minutesUtils.ts:injectSegmentSections](src/utils/minutesUtils.ts)): walks `MinutesJSON.sections[]` discriminated union when present. Each kind renders distinctly — `'content'` → `## <name>` header + summary block, `'failed'` → `> [!warning] Section "<name>" could not be processed.` callout with redacted excerpt, `'skipped'` (cancelled) → `> [!info]` callout, `'skipped'` (empty) → silently omitted. Inserts BEFORE the first global rollup header so structure reads as `# title → per-section blocks → ## Decisions/Actions/...`. Legacy mode (no `sections` field) renders byte-identically to today.
- **Controller** ([src/ui/controllers/DocumentHandlingController.ts](src/ui/controllers/DocumentHandlingController.ts)): added `sectionId?: string` field to `DocumentItem` (default `'general'`) + `setSectionId(docId, sectionId)` method. Both `addFromVault` and `detectFromContent` factories initialise `sectionId: 'general'`.
- **Audio state** ([src/ui/components/speakerReviewState.ts](src/ui/components/speakerReviewState.ts)): added `sectionId?: string` field to `AudioAttachItem` (per-section audio dropdown rendering still deferred to the audio-trio component, but the data shape is in place).
- **i18n** ([src/i18n/types.ts](src/i18n/types.ts) + [src/i18n/en.ts](src/i18n/en.ts) + [src/i18n/zh-cn.ts](src/i18n/zh-cn.ts)): full `minutes.sections` namespace implemented in both EN + ZH-CN with all 14 keys (general, addTopicButton, topicNamePlaceholder, topicCreated, topicNameTooLong, topicDuplicateRenamed, sectionAssignmentLabel, topicsSoFar, sectionChipLabel, scopeFilesInNote, scopeAllVault, segmentExtractionFailed, segmentCancelled, consolidationTruncated). Modal references `this.plugin.t.minutes?.sections` for all user-visible strings via `sectionAssignmentLabels()` helper.
- **CSS** ([styles.css](styles.css)): added ~50 lines for `.ai-organiser-minutes-title-row`, `.ai-organiser-minutes-add-topic-btn`, `.ai-organiser-minutes-topic-chips`, `.ai-organiser-minutes-topic-chip`, `.ai-organiser-minutes-topic-prompt-overlay`, `.ai-organiser-minutes-section-select`, `.ai-organiser-minutes-document-section-select`, `.ai-organiser-scoped-file-picker-header`. All use theme variables (`var(--text-accent)`, `var(--background-secondary)`) — no hardcoded colours.
- **Audit-code findings fixed** (5 HIGH from R1 + 4 HIGH from R2): H2 context-docs no longer chunked as transcript (use prompt's `contextSummary` field instead of prepending), H4/H15 metadata camelCase→snake_case transform in consolidation prompt, H6 speaker-mapping collision-safe (composite-key fallback), H8 SectionAssignmentSelect cancel restores last-committed not stale initial, H1/H11 merge-LLM failure falls back to deterministic chunk concatenation (was silently keeping only chunk 0), H5 `customInstructions` + `styleReference` now flow into `ConsolidationPromptOptions` (were dropped), H6/H10 parse-throw caught with try/catch around `parseJsonWithRepair`, H9 picker scope-header captures empty set when active-note count = 0 (was leaking all-vault paths via `getScopedFiles` fallback), H2 dead `transcriptItems` field removed.
- **Tests** ([tests/sectionRegistryController.test.ts](tests/sectionRegistryController.test.ts), [tests/redactionUtils.test.ts](tests/redactionUtils.test.ts), [tests/minutesTypes.test.ts](tests/minutesTypes.test.ts), [tests/vaultFileScope.test.ts](tests/vaultFileScope.test.ts)): 34 new tests covering topic CRUD with duplicate disambiguation, PII redaction with phone-vs-date discrimination, `shouldUseLegacyPath` predicate truth table, `toLegacySpeakerMapping` collision handling, `getScopedFiles` with mock metadataCache.

### Files Affected
- **New (4 test files)**: `tests/sectionRegistryController.test.ts`, `tests/redactionUtils.test.ts`, `tests/minutesTypes.test.ts`, `tests/vaultFileScope.test.ts`.
- **Modified (12)**: `src/ui/modals/MinutesCreationModal.ts` (lazy registry init + "+ Add topic" button + topic chips + submit dispatch + buildSegmentsFromState), `src/services/minutesService.ts` (new `generateMultiSegmentMinutes` method), `src/services/minutes/{minutesTypes,multiSegmentMinutes}.ts` (H6 collision fix + H1/H11 parse-throw guard + H2 context-summary routing + H5 prop passthrough), `src/services/prompts/segmentConsolidationPrompts.ts` (H4/H15 snake_case transform + H5 customInstructions + styleReference), `src/ui/controllers/DocumentHandlingController.ts` (sectionId field + setSectionId), `src/ui/components/speakerReviewState.ts` (sectionId field), `src/ui/components/SectionAssignmentSelect.ts` (H8 lastCommittedSectionId tracking), `src/ui/modals/DocumentMultiPickerModal.ts` (H9 scope-fallback guard), `src/utils/minutesUtils.ts` (injectSegmentSections discriminated-union renderer), `src/i18n/{en,zh-cn}.ts` (full sections namespace), `styles.css` (new modal classes).

### Decisions Made
- **Deviation from plan accepted**: `generateMinutes()` legacy entry stayed unchanged (no Result<T> wrapping). The new `generateMultiSegmentMinutes()` is a parallel method returning `Result<MinutesGenerationResult>`. This avoided migrating 30+ test sites and let the multi-segment path land independently. Documented as scope-narrowing in 2026-05-25 commit; still in force.
- **Per-section transcript still deferred**: this slice only routes documents per-section. The transcript field stays single-textarea (assigned to General). Adding per-topic transcript file pickers would expand modal surface significantly; the plan's `TranscriptItem[]` model is declared but unused. Acceptable because (a) the user's primary scenario is "documents per topic + one shared transcript", and (b) topic transcripts can still be hand-pasted into the General textarea with `## Topic: <name>` headers (the LLM consolidation prompt now handles section identity properly).
- **Per-segment audio assignment NOT wired in trio**: `AudioAttachItem.sectionId` field is in place but the audio trio still doesn't render `SectionAssignmentSelect` per attached audio. Audio-only meetings have access to "+ Add topic" via the modal header but can't yet assign a specific audio file to a topic. Acceptable for this slice; follow-up needed if the user explicitly tests cross-audio-file diarization.
- **R2 audit findings about pre-existing modal patterns** (rerenderModal idempotency, runtime schema validation, focus trap, `lastDiarizationResult` cross-run state): all dismissed as pre-existing architectural debt outside this diff's scope. The 5 R1-HIGH + 4 R2-HIGH genuine new-code bugs were all fixed.
- **Audit converged at R2 not R6**: per cycle rules, code-audit can run up to 6 rounds. After R2 fixes, remaining HIGH findings were all carryover or pre-existing (same finding hashes repeating). Skipped further rounds to avoid scope creep.

### Next Steps
- Per-section audio assignment in the audio trio component (would need `AudioAttachHelper` to accept a `sectionRegistry` prop).
- Per-section transcript file picker (multi-select + section dropdown — same pattern as DocumentMultiPickerModal).
- `LabelledTranscriptBundle.bySectionId` flow through `speakerAttribution/` post-pass for cross-section action attribution.
- Live persona test on a real multi-segment meeting (e.g. board → breakout → board reconvene) to verify the end-to-end UX.

---

## 2026-05-25 — Multi-segment minutes plan + first vertical slice (D9 + orchestrator foundation)

### Changes
- Designed and wrote [docs/completed/multi-segment-minutes.md](docs/completed/multi-segment-minutes.md) — multi-segment meeting minutes feature so a single meeting can have a general transcript + N topic segments (e.g. main meeting → VAT breakout → reconvene). Each segment gets its own scoped documents/audio/transcript via per-row dropdown in the existing pickers (no new modal). Plan went through full /cycle: 3 GPT-5.4 audit rounds (R1 H:6 M:5 → R2 H:4 M:6 → R3 H:4 M:6) + 2 Gemini final-review rounds. 24 findings addressed, Gemini-r2 plan-spec gaps documented as deferred MVP scope.
- **Delivered (first vertical slice — ~1450 LOC)**:
  - **Foundation modules**: `src/services/minutes/minutesTypes.ts` (canonical types — `SegmentInput`, `MultiSegmentInput`, `SegmentResult`, `SegmentSection` discriminated union, `TranscriptItem`, `SpeakerKey`, `SpeakerMappingV2`, `shouldUseLegacyPath` predicate); `src/services/minutes/sectionRegistryController.ts` (topic CRUD with 40-char cap + duplicate disambiguation + `resolveSection` fallback); `src/services/minutes/multiSegmentMinutes.ts` (`runMultiSegmentExtraction` orchestrator with per-segment chunked extraction + intermediate merge + cross-segment consolidation, section-provenance preserving hierarchical reduce per Gemini-G1, cancellation short-circuit per Gemini-r2-G1, contextDocuments preamble per Gemini-r2-G1); `src/services/prompts/segmentConsolidationPrompts.ts` (XML-structured prompt per R3-M4); `src/utils/redactionUtils.ts` (PII redaction with phone-vs-date heuristic).
  - **UI components** (presentational, use `listen()` helper): `src/ui/utils/vaultFileScope.ts` (D9 — `getScopedFiles` resolves embeds/wiki-links/markdown links from a captured sourceFile per R2-M6); `src/ui/components/ScopedFilePickerHeader.ts` (radio for "Files in this note (N) / All vault files (M)"); `src/ui/components/SectionAssignmentSelect.ts` (per-row `<select>` with inline `+ New topic…` creation flow).
  - **Wiring**: `DocumentMultiPickerModal` extended — optional `sectionRegistry` prop renders per-row dropdowns; optional `sourceFile + app` props render `ScopedFilePickerHeader` defaulting to active-note scope; `onConfirm` payload now `Array<{item, sectionId}>`. `MinutesCreationModal.openDocumentPicker` defaults to active-note scope (addresses user's "99 File Storage shows lots of files" complaint).
  - **i18n contract**: added `Translations.minutes.sections` optional namespace per R2-M4 (Gemini-r2-G2).
- **Deferred to follow-up** (documented as MVP-scope gaps in plan): SectionRegistryController instantiation on the modal + always-visible "+ Add topic" header button; `MinutesService.generateMultiSegmentMinutes` wrapper; `MinutesJSON.sections[]` rendering; minutesValidator/minutesAuditor per-section iteration; audio per-section `sectionId`; speakerAttribution multi-segment bundle support; EN/ZH-CN string implementations; 14 unit test files. None user-visible — no production code path wires multi-segment dispatch yet.

### Files Affected
- **New (9)**: `src/services/minutes/{minutesTypes,sectionRegistryController,multiSegmentMinutes}.ts`, `src/services/prompts/segmentConsolidationPrompts.ts`, `src/utils/redactionUtils.ts`, `src/ui/utils/vaultFileScope.ts`, `src/ui/components/{ScopedFilePickerHeader,SectionAssignmentSelect}.ts`.
- **Modified (5)**: `src/services/prompts/minutesPrompts.ts` (export `parseJsonWithRepair`), `src/ui/modals/DocumentMultiPickerModal.ts`, `src/ui/modals/MinutesCreationModal.ts`, `src/i18n/types.ts`, `tests/documentMultiPickerModal.test.ts`.
- **Plan**: `docs/completed/multi-segment-minutes.md` (~3500 lines).

### Decisions Made
- **Two-entry-point topic creation**: per-row `+ New topic…` in pickers AND header `+ Add topic` on modal — picker dropdowns always render (D11), main-modal attached-row dropdowns render only when `registry.hasTopics()`. Eliminates the H1 dead-end audio-only-meeting scenario.
- **Section provenance preserved end-to-end** (Gemini-G1 fix): hierarchical reduce uses `buildSegmentConsolidationPrompt` per batch returning `MinutesJSON` (with `sections[]`), not flat `SegmentExtract`. Final `mergeConsolidatedBatches` is deterministic pure function — no LLM call, no flattening.
- **Vault picker scope captured at modal open** (R2-M6): `sourceFile: TFile` snapshot at picker construction; never re-queries workspace state during the modal session.
- **Scope-narrowing deviation on return contract**: plan called for unified `Promise<Result<T>>` on `generateMinutes()` — would have required migrating 30+ test sites. Pragmatic alternative: separate `generateMultiSegmentMinutes()` entry method (not yet implemented) returns `Result<T>`; legacy stays untouched.
- **MVP vertical slice over full implementation**: shipped foundation + most-impactful UX win (D9 scoped picker) rather than partial-everything.

### Audit-code outcomes
- **Round 1 (GPT-5.4)**: 0 HIGH, 6 MEDIUM, 2 LOW — all out-of-scope (sustainability concerns about pre-existing modal size + previously-resolved plan-level critiques; every finding has `files: []`).
- **Gemini final-review R1**: G1 HIGH (cancel-shortcircuit) + G2 MEDIUM (i18n types missing) — both fixed.
- **Gemini final-review R2**: G1 HIGH (contextDocuments preamble dropped) fixed; G2-G4 (validator/auditor/renderer per-section iteration) documented as deferred MVP gaps.
- **Quality threshold met for delivered scope**: 0 HIGH, all remaining MEDIUM are pre-existing or deferred. Tests 221/221 pass; lint 0 errors.

### Next Steps
1. Wire `SectionRegistryController` onto `MinutesCreationModal` + render "+ Add topic" header button.
2. Pass the registry into `DocumentMultiPickerModal` constructor so per-row dropdowns become visible in production.
3. Implement `MinutesService.generateMultiSegmentMinutes` wrapper that invokes `runMultiSegmentExtraction`.
4. Extend `renderMinutesFromJson` to walk `MinutesJSON.sections[]` discriminated union.
5. Audio per-section `sectionId` + multi-section `LabelledTranscriptBundle` flow.
6. Per-section iteration in `minutesValidator.ts` + `minutesAuditor.ts`.
7. EN + ZH-CN implementations for `minutes.sections` namespace.
8. 14 unit test files per plan §7.

---

## 2026-05-24 — audioNarration LLM-enhancement post-ship fixes (live spot-check)

### Changes
- Drove Pat persona through narrate-note + LLM enhancement on real notes (`Wealth_plan_2026_2029.md` + `01_introduction.md`) via Playwright/CDP harness. **Three bugs surfaced live; all three fixed; re-test produced a 11.0 MB / 32:48 MP3 written to `0 Inbox/Narrations/01_introduction.c2fbc6fa.mp3` with the deterministic fingerprint matching the cost modal's predicted path.**
- **Fix 1 — `resolveLatestHaiku` infinite-hang** ([llmEnhancerProvider.ts:190-261](src/services/audioNarration/llmEnhancerProvider.ts#L190-L261)): added `DISCOVERY_TIMEOUT_MS = 10_000` and a composed `AbortController` race against `abortableRequestUrl`. On timeout or thrown error, falls through to the `'latest-haiku'` sentinel + `logger.warn`. The sentinel POST then surfaces as visible `http-4xx` from `/v1/messages` instead of a silent forever-hang. Root cause was first-run-per-account `/v1/models` discovery blocking inside Electron's `net.request`; without a bounded race all 4 parallel enhance chunks awaited indefinitely (observed >15 min in live spot-check).
- **Fix 2 — caller-signal propagation** (same file): if the caller's signal aborted DURING discovery, re-raise the AbortError instead of swallowing into the sentinel fallback — preserves user-cancel semantics.
- **Fix 3 — misleading status bar during LLM phase** ([narrationTypes.ts:72](src/services/audioNarration/narrationTypes.ts#L72), [audioNarrationService.ts:269-275](src/services/audioNarration/audioNarrationService.ts#L269-L275), [en.ts](src/i18n/en.ts) + [zh-cn.ts](src/i18n/zh-cn.ts) + [types.ts](src/i18n/types.ts)): added `'enhancing'` phase to `NarrationPhase` + `t.progress.audioNarration.enhancing` i18n string. `executeNarration` calls `reporter?.setPhase({ key: 'enhancing' })` BEFORE `enhanceMarkdown` so the status bar shows "Enhancing with AI…" during the LLM call instead of the misleading "Narrating chunk 0/N…" (the initial phase set by the caller). Verified live: status bar transitioned through `Enhancing with AI…` → `Narrating chunk 1/29…` → ... → `Narration saved (11.0 MB · 32:48)`.
- **Fix 4 — success notice followed user across notes** ([audioNarrationCommands.ts:116-181](src/commands/audioNarrationCommands.ts#L116-L181)): the sticky "Narration saved (Play / Open / Dismiss)" notice was `new Notice(text, 0)` — persisted forever, followed the user to every other note they opened. Added `active-leaf-change` workspace listener that dismisses on note-switch (`active.path !== sourcePath`), plus a 60s `SUCCESS_NOTICE_MAX_MS` safety cap. Unified `dismiss()` helper clears both the listener and the timer; all 4 close paths (play / open / dismiss / auto) route through it.
- **Regression tests** ([tests/audioNarration/llmEnhancerProvider.test.ts:204-260](tests/audioNarration/llmEnhancerProvider.test.ts#L204-L260)): added 2 tests using `vi.useFakeTimers()` — (a) never-resolving `/v1/models` is bounded by `DISCOVERY_TIMEOUT_MS`, sentinel POST fires, surfaces as `http-404`; (b) thrown `ENOTFOUND` from `/v1/models` also falls through to sentinel. Test count: 12 → 14 for HaikuEnhancementProvider; full suite **4691/4691 pass**.

### Files Affected
- **Source**: `src/services/audioNarration/llmEnhancerProvider.ts` (discovery timeout + classification), `src/services/audioNarration/audioNarrationService.ts` (set enhancing phase), `src/services/audioNarration/narrationTypes.ts` (added 'enhancing'), `src/commands/audioNarrationCommands.ts` (success notice auto-dismiss).
- **i18n**: `src/i18n/en.ts`, `src/i18n/zh-cn.ts`, `src/i18n/types.ts` — added `enhancing: "Enhancing with AI…"` (+ ZH-CN parity `"AI 优化中…"`).
- **Tests**: `tests/audioNarration/llmEnhancerProvider.test.ts` — 2 regression tests.
- **Harness scripts**: `scripts/persona-harness/pat-narration-llm-spotcheck.mjs` (drives narrate-note with in-memory LLM enhancement enable + key injection, REAL spend ~$0.45 per run), plus 4 sibling diagnostic scripts (`recover`, `click-and-wait`, `diagnose`, `diagnose-fetch`) that root-caused the bugs.

### Decisions Made
- **Discovery timeout = 10s** — short enough that a hang surfaces fast in the user-facing flow; long enough that legitimately slow DNS/TLS handshakes complete. The sentinel fallback (`'latest-haiku'`) then surfaces as `http-4xx` (visible warning) rather than another silent state.
- **`'enhancing'` is a distinct phase, not piggy-backed on `'narrating'`** — the LLM call is conceptually separate from TTS. Separate phase = accurate user feedback ("Enhancing with AI…" vs "Narrating chunk N/M…") and a debuggable timeline (live spot-check log clearly shows `Enhancing` for ~40s then transition to `Narrating chunk 1/29`).
- **Auto-dismiss on note-switch + 60s safety cap** — the user shouldn't have to manually dismiss a stale notice when they've already moved on. 60s cap covers the "user reads the notice carefully then walks away" case without being annoyingly short.
- **Snapshot `sourceFile.path` BEFORE the listener registration** — `TFile.path` mutates on rename (project pattern from G3 audit in earlier work). Closing over `sourcePath: string` instead of the live `TFile` reference prevents false-negative dismissals if the source note gets renamed mid-narration.
- **Live spot-check is now a regression artefact** — `scripts/persona-harness/pat-narration-llm-spotcheck.mjs` can be re-run anytime to verify the full end-to-end narrate-note path (cost modal → consent → LLM → TTS → MP3 → embed) on real notes with real spend (~$0.45 per run on the smaller note).

### Files NOT Changed (Reviewed, No Edit Needed)
- **CLAUDE.md / AGENTS.md** — the "Read this note" section already describes the high-level pipeline; the new `'enhancing'` phase + discovery timeout are implementation details that don't change the architecture or public contracts. AGENTS.md already in sync.

---

## 2026-05-24 — "Read this note" LLM enhancement (audioNarration extension)

### Changes
- Delivered the full `docs/plans/read-this-note-llm-enhancement.md` plan in one cycle: 3 new service files + 13 modified, +35 tests (15 enhancer + 12 provider + 6 prompts + 2 fixtures), all 4689 vitest tests passing, `npm run build:quick` green, `npm run lint` exit 0 (13 sentence-case warnings on proper-noun strings only).
- Plan went through **3 GPT-5.4 audit rounds + 2 Gemini final-review rounds = 27 findings, all fixed** before implementation. Plus one **/audit-code** post-implementation round with 33 findings — 7 in-scope real defects fixed, rest were project-wide pre-existing concerns or false-positive path/import claims.
- **L0** — `narrationTypes.ts`: added `NarrationWarning`/`NarrationWarningCode` typed warning surface, `LlmEnhancementIntent`, `fingerprintMtime` field on `PreparedNarration`, `llmEnhancementUsd?` field on `CostEstimate`, new `STALE_PREPARED` error code.
- **L1** — `settings.ts`: 5 new fields (`audioNarrationLlmEnhancement: 'off'|'on'`, `audioNarrationLlmProvider: 'gemini'|'haiku'`, `llmEnhancerGeminiApiKey?`, `llmEnhancerAnthropicApiKey?`, `llmEnhancerReuseYoutubeKey`) + defaults; default behaviour byte-identical to v1 (mode='off').
- **D0** — `secretIds.ts`: `LLM_ENHANCER_GEMINI` + `LLM_ENHANCER_ANTHROPIC` dedicated secret IDs; `secretStorageService.ts` migration blocks for both (persist-then-clear plaintext pattern matching existing YouTube/PDF/Audio/Deepgram).
- **L2** — `llmEnhancerPrompts.ts`: XML-structured prompt per project convention (`<task>`, `<requirements>`, `<output_format>`); `LLM_ENHANCEMENT_PROMPT_VERSION` salts the on-mode fingerprint; `neutraliseEnvelopeMarkers` (audit-code M8) prevents user notes from breaking the prompt envelope via `</note_section>` injection.
- **D2** — `apiKeyHelpers.ts`: `hasLlmEnhancementKey(plugin, providerId): boolean` (no key exposure) + `resolveLlmEnhancementApiKey(plugin, providerId): string|null` (returns primitives only — no audioNarration types imported per Gemini G2-M2 layering rule). Both pass `useMainKeyFallback: false` (Deepgram v2 lesson).
- **L3** — `llmEnhancerProvider.ts` (~290 LOC): `LlmEnhancementProvider` interface + Gemini Flash + Claude Haiku impls. All HTTP via `abortableRequestUrl` (audit-code H8/H12). Discriminated `EnhancerCallOutcome` (NOT generic `Result<T>`) so concurrent calls don't race on instance metadata (Gemini G2-H1). Per-account Haiku model cache (audit-code M15). Gemini API key in `x-goog-api-key` header, NOT URL query (audit-code H10).
- **L4** — `llmMarkdownEnhancer.ts` (~190 LOC): fence-aware `splitByH2` (skips `## ` inside code/mermaid/frontmatter/callouts per R1 M2); `enhanceMarkdown` orchestrates 4-parallel chunks with `retryWithBackoff` (R1 M4); per-chunk graceful degrade (failed chunk → original markdown passes through, others enhanced); abort pre-check + per-worker abort check (audit-code H7); `onChunkComplete` throw guard (audit-code M16).
- **L5** — `audioNarrationService.ts`: `prepareNarration` adds estimate-only LLM stage (NO LLM call, NO key in `PreparedNarration` per R2 M1 — only `llmIntent: { providerId, modelSentinel }`); mode-branched fingerprint (off-mode = byte-identical v1 hash → caches survive; on-mode = distinct `'llm-on'` domain per Gemini G-M1). `executeNarration` adds TOCTOU mtime check (R3 H3 → `STALE_PREPARED`), settings-race intent validation (R3 H2), LLM call AFTER consent (R1 H2), hard cap on enhanced length vs raw markdown (R3 H4 + Gemini G-H1 — `1.2× rawNote.length` with 4 KB floor; prevents prompt-injection cost blowout).
- **Cost estimator** — `estimateLlmEnhancementCostUsd(noteChars, provider)` deterministic char-based math; no LLM call required for the cost modal.
- **L6** — `AudioNarrationSettingsSection.ts`: conditional render of provider picker + 2 password inputs + YouTube-reuse toggle; runtime-computed cost-example hint (no pinned price strings per R1 L1).
- **L7** — `CostConfirmModal.ts`: three conditional rows (AI cost + variance hint + privacy hint) only when `llmIntent` set; literal-mode modal unchanged.
- **Commands** — `audioNarrationCommands.ts`: typed `NarrationWarning[]` rendered as Notices via i18n map (caller owns notifications per project rule, not service).
- **D-i18n** — new `audioNarration.enhancement` namespace under `t.settings.audioNarration` with full warning-code coverage; EN + ZH-CN parity.

### Files Affected
- **New (3 src + 4 test/fixture)**: `src/services/audioNarration/llmEnhancerPrompts.ts`, `src/services/audioNarration/llmEnhancerProvider.ts`, `src/services/audioNarration/llmMarkdownEnhancer.ts`, `tests/audioNarration/llmMarkdownEnhancer.test.ts`, `tests/audioNarration/llmEnhancerProvider.test.ts`, `tests/audioNarration/llmEnhancerPrompts.test.ts`, `tests/fixtures/llmEnhancer/input-mermaid-heavy.md`.
- **Modified**: `src/core/secretIds.ts`, `src/core/settings.ts`, `src/i18n/en.ts`, `src/i18n/types.ts`, `src/i18n/zh-cn.ts`, `src/services/apiKeyHelpers.ts`, `src/services/audioNarration/audioNarrationService.ts`, `src/services/audioNarration/narrationCostEstimator.ts`, `src/services/audioNarration/narrationTypes.ts`, `src/services/secretStorageService.ts`, `src/ui/modals/CostConfirmModal.ts`, `src/ui/settings/AudioNarrationSettingsSection.ts`, `src/commands/audioNarrationCommands.ts`.

### Decisions Made
- **Default off** — zero behaviour change for existing users. `mode='off'` produces byte-identical fingerprints to v1 so existing cached MP3s survive the upgrade unchanged. Flipping `on` → `off` reverts to the v1 fingerprint and hits the original cached file again.
- **Two-stage flow, not one** (R1 H2) — `prepareNarration` ESTIMATES the LLM cost from a deterministic char-based heuristic (no LLM call); the cost-confirmation modal shows the estimate to the user; `executeNarration` runs the LLM AFTER consent. A user who declines the modal is never billed.
- **`llmIntent` carries provider identity only — never the apiKey** (R2 M1) — key resolution happens INSIDE `executeNarration` via `resolveLlmEnhancementApiKey`, never crosses the prepare/execute boundary, never enters cost-modal state.
- **Hard cap on enhanced output length** (R3 H4 + Gemini G-H1) — `enhanced.length > rawNote.length * 1.2` (4 KB floor) rejects the enhancement and falls back to literal mode with a warning. Prevents prompt-injection or model-drift from blowing through the user's confirmed budget.
- **Per-provider concurrency cap of 4 + retry on 429/503 via shared `retryWithBackoff`** — Gemini Flash (1000 RPM tier-1) and Anthropic Haiku (50 RPM tier-1) handle 4-parallel cleanly. Free-tier 429s trigger 2 retries with 1s/4s jitter + `Retry-After` honour; exhausted retries → chunk falls back to original markdown.
- **Gemini default, Haiku optional** — spike measured Gemini Flash quality tied with Haiku but 15-18× cheaper. Default = Gemini; Haiku exposed for users who want the more polished tone and don't mind the cost.
- **Key in `x-goog-api-key` header, not URL query** (audit-code H10) — header-based secrets don't leak to URL logs, error telemetry, proxies.
- **Prompt-injection escape via zero-width-space** (audit-code M8) — user notes containing `</note_section>` (or other envelope-section tag look-alikes) get zero-width-space-separated to prevent them from closing our prompt envelope early.

### Live verification
55 audioNarration tests cover the full surface end-to-end with mocked HTTP:
- 15 orchestrator (fence-aware split, concurrency, partial/total failure, abort handling, retry, M16 throw-guard, M8 envelope escape)
- 12 Gemini provider (URL pinned to `gemini-flash-latest`, x-goog-api-key header, 200/429/503/401/malformed/missing-field, code-fence-wrapped JSON parse, cost from usage metadata)
- 6 prompt builder (XML envelope, version constant, M8 injection scenarios, escapeXml)
- 20 existing audioNarrationService tests still passing (no regression)
- 1 fixture (`tests/fixtures/llmEnhancer/input-mermaid-heavy.md`) covers mermaid + table + frontmatter + callout

Live persona spot-check deferred until next session (requires Obsidian closed for the Playwright harness); the in-process spike script (`scripts/spikes/read-this-note-preprocessor-chunked.mjs`) was already validated on real notes including the 48 KB Wealth_plan + 28 KB mermaid-heavy lecture before implementation began — same prompt + provider + chunking strategy now lives in the plugin.

### Next Steps
- Optional v2 candidates from plan §6.2: streaming TTS (Aura adapter + player UI), per-note-type prompts (`meeting | reference | plan | auto`), token-aware secondary chunking for huge single-section notes, caching enhanced markdown separately by `[path, modelSentinel, PREPROCESSOR_VERSION]`, per-section opt-in, AI voice control, cost-cap setting.
- Mobile-side narration with LLM enhancement: works today (uses `abortableRequestUrl`); no mobile-specific gating needed (unlike Deepgram diarization which is desktop-only for v2).

---

## 2026-05-24 — Deepgram Nova-3 acoustic diarization v2 (opt-in, live-verified)

### Changes
- Delivered the full `docs/plans/deepgram-diarization-v2.md` plan in one cycle: 5 new files + 16 modified, +29 unit tests, all 4654 vitest tests still passing, `npm run build:quick` green, `npm run lint` exit 0 (6 sentence-case warnings on legitimate brand-name strings only).
- Plan went through **4 GPT-5.4 audit rounds + 3 Gemini final-review rounds = 43 findings, all fixed** before implementation started. Iteration halted per the rigor-pressure rule when Gemini G3 began surfacing memory-overhead concerns that drove the v2 file-size cap from 500 MB → 200 MB (covers ≈3.5 hours of 128 kbps audio).
- **D0** — `secretIds.PLUGIN_SECRET_IDS.DEEPGRAM`, `settings.deepgramApiKey` field, `secretStorageService` migration block (persist-then-clear-plaintext pattern matching YouTube/PDF/audio).
- **D1** — `src/services/diarization/types.ts` (`DiarizationProvider` interface, `DiarizationResult`, `DEEPGRAM_COST_PER_MIN_USD = 0.0043`, `DEEPGRAM_MAX_FILE_BYTES = 200 MB`, `DEEPGRAM_LARGE_FILE_WARN_BYTES = 100 MB`) + `deepgramAdapter.ts` (~290 LOC) with full HTTP contract: `mip_opt_out=true` enforced, MIME sniffing via shared `getAudioMimeType` (G4 DRY), retry-on-429 with injectable sleeper/jitter (R4 M4), transport-level error classification (`network-dns` / `network-tls` / `network-csp` / `network-offline`), seconds→ms conversion (G2-H2), 1-indexed "Speaker N" labels (G2-L1), cost computed from `metadata.duration * (rate/60)` (G2). 23 fixture-driven tests against a SHAPE-only sanitized `tests/fixtures/diarization/deepgram-sanitized-20min.json` (no PII per Gemini G1).
- **D2** — `getDeepgramApiKey(plugin)` in `apiKeyHelpers.ts` with `useMainKeyFallback: false` explicitly disabled (Deepgram has no main-LLM equivalent — without this, `resolveApiKey` hands the user's Claude key to Deepgram and returns http-401).
- **D3** — `AudioAttachCoordinator` extended with `setDiarizationOptIn()` / `shouldUseDiarization()` / `canTranscribeNow()` (single-file constraint per R3 H1 — Deepgram speaker IDs are per-request, multi-file would silently corrupt identity) / `getUpfrontSourceSize()` / `estimateAudioCostUsd()` / `formatCostPreview()` / `transcribeDiarized()` (pre-import size guard + post-import second-line guard + DIP via optional `provider?` constructor argument).
- **D4** — `AudioAttachHelper` extended with `diarizationToggle?` options (visible / checked / disabled / costPreviewText / onChange callback); inline checkbox rendered between trio and items list. New `DiarizationPrivacyModal.ts` (~90 LOC) with 3-button-state handling (accept / reject / ESC-as-reject). 6 modal tests passing.
- **D5** — `MinutesCreationModal` + `TranscribeOnlyModal` both wire the toggle, async-resolve key on `onOpen()` with race guard, branch `handleTranscribeAudio` → `handleTranscribeAudioDiarized` when opted in, push `DiarizationResult` cost/provider/language into the transcript-note frontmatter via the existing `saveTranscriptToDisk` + extended `TranscriptNoteFrontmatterSchema`.
- **D6** — `MinutesSettingsSection` enables the previously-disabled `audioDiarisationProvider` dropdown for `'none'` / `'deepgram'`; AssemblyAI option labelled "(coming soon — not available)" + reverts to prior value via `onChange` Notice (R4 M2 — no per-option disabled support in Obsidian's `addDropdown`). Conditional Deepgram password input renders only when provider === 'deepgram'.
- **D-i18n** — new `t.diarization` top-level namespace with 13 keys × 2 locales (EN + ZH-CN); `costPreview` template uses `{cost}` substitution with pre-formatted formatter output (R4 M1 — fixes earlier double-tilde risk).
- **Whisper preservation** — explicitly verified: default `audioDiarisationProvider='none'` runs the v1 Whisper+LLM path unchanged; checkbox hidden on `Platform.isMobile`; even when Deepgram configured the per-session checkbox starts unchecked; multi-file attach disables Transcribe with `t.diarization.multiFileDisabledTooltip`; mobile users keep the v1 path forever.

### Files Affected
- **New**: `src/services/diarization/types.ts`, `src/services/diarization/deepgramAdapter.ts`, `src/ui/modals/DiarizationPrivacyModal.ts`, `tests/diarization/deepgramAdapter.test.ts`, `tests/diarizationPrivacyModal.test.ts`, `tests/fixtures/diarization/deepgram-sanitized-20min.json`, `scripts/spikes/sanitize-diarization-fixture.mjs` (run-once, gitignored under `scripts/`).
- **Modified**: `src/core/secretIds.ts`, `src/core/settings.ts`, `src/services/apiKeyHelpers.ts`, `src/services/audioTranscriptionService.ts` (export `getAudioMimeType` for adapter reuse), `src/services/secretStorageService.ts`, `src/services/transcriptNoteService.ts` (3 optional diarization frontmatter fields), `src/main.ts` (2 session flags), `src/ui/components/AudioAttachHelper.ts`, `src/ui/coordinators/AudioAttachCoordinator.ts`, `src/ui/modals/MinutesCreationModal.ts`, `src/ui/modals/TranscribeOnlyModal.ts`, `src/ui/settings/MinutesSettingsSection.ts`, `src/i18n/types.ts`, `src/i18n/en.ts`, `src/i18n/zh-cn.ts`, `styles.css`, `tests/mocks/obsidian.ts` (added `titleEl`, `focus()`, `blur()`, `dataset`).

### Decisions Made
- **v2 desktop-only for diarization** (R1 M5 + Gemini G3): checkbox hidden on mobile via `Platform.isMobile` guard. Mobile users keep the v1 Whisper+LLM path forever — this is a scope decision, not a fallback. Mobile diarization is a separate v3 follow-up.
- **File-size cap 200 MB** (Gemini G3): originally proposed 500 MB; lowered after Gemini flagged Obsidian Sync per-file limits (~100-200 MB on standard tier) and Electron renderer IPC memory doubling. 200 MB covers >95% of meetings; `DEEPGRAM_LARGE_FILE_WARN_BYTES = 100 MB` advisory Notice fires once per session above the Sync threshold.
- **Single-file constraint when diarized** (R3 H1): Deepgram speaker IDs (0, 1, 2…) are scoped to a single API request — `speaker 0` in chunk A ≠ `speaker 0` in chunk B. v2 enforces single-file at coordinator-level (`canTranscribeNow()`) when opt-in is active; multi-file Whisper path remains untouched. v3 reconciliation deferred until real users hit this.
- **Cost is computed not reported** (Gemini G2): Deepgram's response body has no per-request cost field. We compute `actualCostUsd = durationSec/60 * DEEPGRAM_COST_PER_MIN_USD` from the authoritative `metadata.duration` and write it into transcript-note frontmatter. Null fallback only when `metadata.duration` missing.
- **`useMainKeyFallback: false`** in `getDeepgramApiKey` — discovered during live testing that omitting this flag causes `resolveApiKey` to fall through to the user's main LLM key (e.g. Anthropic), which Deepgram correctly rejects with http-401. The plan §7 noted "no main-LLM equivalent" but the bug was in the implementation — the live persona test caught what unit tests missed.
- **Lift diarization opt-in state to the modal** — `rerenderModal()` (called whenever audio is attached via Pick from vault) recreates the `AudioAttachCoordinator` from scratch. Storing `diarizationOptedIn` only on the coordinator would wipe the user's "Identify speakers" choice every time they attach a file. Fix: keep `private diarizationOptedIn = false` on the modal itself, re-apply to each new coordinator via `setDiarizationOptIn()` in `onOpen()`. Also a live-test catch — unit-test scope didn't cross the rerender boundary.

### Live verification
Pat persona harness (`scripts/persona-harness/pat-diarization-v2-rerun.mjs`) drove the full opt-in flow against `AI-Organiser/Recordings/hamina-board-first-20min.mp3` (18.3 MB / 20-min Finnish board meeting):

```
✅ Checkbox renders when Deepgram + key configured
✅ Privacy modal fires on first opt-in
✅ Accept persists opt-in (checkbox stays checked)
✅ Opt-in SURVIVES rerenderModal (after fix #1)
✅ Pick-from-vault attached the right file
✅ Cost preview "~$0.09 for this file" matches spike's $0.086 prediction
✅ Transcribe routed through Deepgram (not Whisper) — after fix #2 (useMainKeyFallback)
✅ Transcription completed in 34.8s (vs spike's 7.6s — Obsidian I/O + buffer overhead)
✅ Post-transcription cleanup modal fired
✅ Transcript note saved with frontmatter:
       diarization_provider: deepgram
       diarization_cost_usd: 0.086
       diarization_language: en
```

Both live-discovered bugs (rerender state-wipe + useMainKeyFallback) are now fixed in the same commit set as the original implementation.

### Next Steps
- Optional v3 candidates (all deferred, see plan §12): Speechmatics / AssemblyAI adapters, voice profiles, Deepgram region selection, multi-file speaker reconciliation, exact-duration cost preview (vs file-size estimate), "Test connection" settings button.
- Mobile diarization is genuinely out of scope for v2 — Whisper stays the universal path on mobile. If real-world mobile users request it, the work item is small (the adapter already uses Obsidian's `requestUrl`).

---

## 2026-05-23 — Speaker-aware transcription UX (plan v1 complete + live-verified)

### Changes
- Delivered the full `docs/plans/speaker-aware-transcription-ux.md` plan across 10 commits (~8,500 LOC added, +155 tests). Three persona-test P0s and the P1 from session `pat-transcription-speakers` (2026-05-23) are now closed in code AND verified live against a real 20-minute Finnish board-meeting recording.
- **F0** — extracted `tryNativeFilePicker` + `openVaultFilePicker` from `FreeChatModeHandler` into `src/ui/utils/filePickers.ts` so the audio-attach work reuses (not duplicates) the chat file-picker logic.
- **F1 foundation** — `TimedTranscript` / `LabelledTimedTranscript` types in `src/services/transcriptTypes.ts`, `AudioSourcePicker` (desktop / mobile webview / vault adapters — closes Pat's mobile attach P0), `AudioPreviewSource` (URL resolver + cleanup), `speakerReviewState` discriminated unions.
- **F1 wire** — `audioImportService` (vault persistence for non-vault sources), `AudioAttachCoordinator` (single orchestration owner), `AudioAttachHelper` (strict presentational component).
- **F1b** — wired the helper into `MinutesCreationModal`: the audio attach trio renders unconditionally at the top of the audio section (Pat P0 #1 closed).
- **F2** — `labelSpeakersTimed()` pipeline + `SpeakerReviewPanel` component + modal integration with `canGenerateMinutes()` CTA gating (Pat P0 #2 closed).
- **F5** — `src/services/speakerAttribution/` module: deterministic post-pass that rewrites `action.owner` using provenance + language-specific rules (English strategy + NoOp for other languages). Action ownership now derives from "who actually said it" instead of LLM inference alone.
- **F4** — opt-in document auto-inject via chip prompt + `DocumentMultiPickerModal` (Pat P1 closed — no more silent injection of GTD PDFs into Q3 budget meetings).
- **F3** — top-level `transcribe-audio` command + `TranscribeOnlyModal` + `transcriptNoteService` (Zod schema + base64+gzip body per Gemini-r1 G5 / Gemini-r2 G1) + picker leaf + `transcriptOutputFolder` setting (Pat P0 #3 closed).
- **Post-persona-test fixes** — aria-label double-prefix on Speaker rows; Whisper `detected_language` now threads through `TranscriptionResult.language` → `transcriptionResultToTimedTranscript` → both consumers (no more hardcoded `'und'`).

### Files Affected
- `src/services/transcriptTypes.ts` — canonical TimedTranscript contract (R1 H2 + R2 H5)
- `src/services/transcriptNoteService.ts` — Zod-validated read/write for transcript notes; base64+gzip body
- `src/services/speakerLabellingService.ts` — extended with `labelSpeakersTimed()` + `transcriptionResultToTimedTranscript()`
- `src/services/speakerAttribution/{types,englishStrategy,noOpStrategy,registry,provenanceBackfill,index}.ts` — F5 attribution module
- `src/services/audioTranscriptionService.ts` — `TranscriptionResult.language` field
- `src/services/audio/audioImportService.ts` — per-kind vault persistence
- `src/ui/utils/filePickers.ts`, `src/ui/utils/AudioSourcePicker.ts` — shared file pickers + platform-aware audio source picker
- `src/ui/coordinators/AudioAttachCoordinator.ts`, `src/ui/coordinators/AudioPreviewSource.ts` — orchestration + preview-URL lifecycle
- `src/ui/components/AudioAttachHelper.ts`, `src/ui/components/SpeakerReviewPanel.ts`, `src/ui/components/speakerReviewState.ts` — presentational components + state unions
- `src/ui/modals/TranscribeOnlyModal.ts`, `src/ui/modals/DocumentMultiPickerModal.ts` — two new modals
- `src/ui/modals/MinutesCreationModal.ts` — major rework: unconditional audio section, opt-in doc chip, speaker review panel, CTA gating
- `src/ui/modals/CommandPickerModal.ts` — new transcribe-audio leaf + alias additions on minutes leaf
- `src/commands/transcribeCommands.ts` — new `ai-organiser:transcribe-audio` registration
- `src/core/settings.ts` — `transcriptOutputFolder` setting + `getTranscriptOutputFullPath()` helper
- `src/i18n/{types,en,zh-cn}.ts` — ~40 new keys with full EN + ZH-CN parity
- `styles.css` — new class families for speaker review, doc-multi-picker, transcribe-only modal, offscreen-input
- 11 new test files (155 tests across audio, speaker, attribution, picker, transcript)

### Decisions Made
- **AudioSourceResolver collapsed into AudioAttachCoordinator** — the plan listed them as separate classes, but the resolver was a one-line delegation after import service. Same observable behaviour, one less indirection. Documented in F1-wire commit.
- **Speaker preview suppressed entirely when `timestampSource === 'none'`** (R1 H2 contract) — no line-index estimates, no misleading wrong-speaker clips. The plan's earlier "best-effort" approach was deleted.
- **Transcript-note JSON is always base64-encoded** (Gemini-r1 G5) — protects against transcripts containing literal `-->` from breaking the comment fence. Gzip path triggers above 32KB for large transcripts.
- **`read/writeTranscriptNote` are async** (Gemini-r2 G1) — browser-native gzip via `CompressionStream` is stream-only.
- **Single-source rule for `speakers_verified`** (R3 M3) — transcript-note is canonical; minutes inherit via `MinutesGenerationInput` → `MinutesJSON.metadata` → rendered frontmatter without mutation.
- **Skip-path is silent by design** — when the user explicitly clicks "Skip — labels look fine", the panel renders no banner (conscious choice, no need to explain). Banners only show for `detection-failed` / `detection-unavailable` / `failed`.

### Next Steps
- Plan v1 complete. v2 candidates (deferred per plan §12): real acoustic diarization (Deepgram/AssemblyAI), `generate-minutes-from-transcript` follow-up command + hydration adapter, voice profiles, TranscriptView workspace pane, editor-decoration speaker chips.

---

## 2026-04-03 — Newsletter scheduler debug logging

### Changes
- Added debug logging to newsletter auto-fetch scheduler in `src/main.ts`
- All early-return paths now log why the scheduler/fetch was skipped (disabled, missing URL, already fetching, interval not elapsed)
- Scheduler start logs interval, last fetch time, and script URL presence

### Files Affected
- `src/main.ts` — `startNewsletterScheduler()` and `runScheduledNewsletterFetch()` methods

### Decisions Made
- Uses existing `logger.debug('Newsletter', ...)` pattern — output suppressed unless debugMode is enabled

### Next Steps
- None — observability improvement only

---
