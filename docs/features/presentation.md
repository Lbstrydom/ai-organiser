# Presentation & Slides

> Subsystem detail moved out of [AGENTS.md](../../AGENTS.md) so the canonical
> context file stays invariant-sized. AGENTS.md keeps the one-line stub and the
> load-bearing rules; the operational depth lives here.

The slide-generation subsystem: the consultant storyboard layer above the IR deck, the chat-mode handler and its collaborators, the side-rail workspace, the sanitizer trust boundary, brand fidelity, and the depth controls.

---

## Consultant-Quality Slides (storyboard → dot-dash storyline → native visuals)

**Status**: ✅ Implemented (June 2026). **Per-deck choice since 2026-06-08**: a "Plan" pill row in the create panel (`Storyline first | Straight to slides`) lets the user pick storyline-first vs direct PER PRESENTATION (`CreationConfig.planMode`). The global `presentationConsultantMode` setting (default `false`) only SEEDS the pill once per creation cycle — it's no longer a hard gate. Clusters A–D + chat loop, GPT per-cluster audited + consolidated Gemini gate + a 4-round targeted renderer gate (all APPROVE).

A McKinsey/BCG-quality semantic layer ABOVE the existing IR deck: action-titled, MECE, **evidence-bound** slides drafted as a reviewable **dot-dash storyline** the user signs off on BEFORE any slide is designed. Strictly additive — `presentationConsultantMode: false` is byte-identical to the prior pipeline.

### Pipeline (`src/services/presentationIr/`, `src/services/chat/`)
- `consultantStoryboard.ts` — Zod `ConsultantStoryboard` schema (`.strict()` + slide/deck-level `.superRefine` for unique ids, section refs, table/harvey column-length). The semantic "ghost deck": action titles, MECE `role`, evidence-bound `visual_data`, optional `sections`.
- `evidenceGrounding.ts` — **tiered deterministic grounding** (`exact`/`numeric`/`inferential`/`grounded-text`/`ungrounded`). `checkClaim`/`selfCheckStoryboard`/`buildGroundingAuditPayload` (blind `{claim, cited_spans}` for the critic). The **number parser** (`NUMERIC_RE`/`NUMERIC_CELL_RE`/`normaliseNumeric`/`magnitudeKey`) is comprehensive: percent · decimal · **dot-prefix (`.5`)** · **letter-identifier lookbehind (`Q3`/`FY24`/`v2` are NOT quantities)** · magnitude (`50bn`, gated so "50 billion" ≠ "50") · currency · **negative-currency sign (`-$50` keeps its sign)** · whole-cell gate (a prose/year cell is an accepted no-false-positive gap). Inferential → critic; ungrounded/dangling → blockers.
- `storyboardService.ts` — `generateStoryboard`/`generateRevisedStoryboard` (shared `runStoryboardLLM`) + `translateStoryboardToIr` (emits NATIVE blocks; harvey header is `['Option', ...cols]` — never empty). `visualDataToBlock` maps the 5 consultant visuals.
- **Brief-authority invariant (`storyboardPrompts.ts`, 2026-06-08):** `buildStoryboardPrompt` gives `<user_brief>` PRIMACY (positioned BEFORE `<evidence_catalog>`) + an explicit **BRIEF AUTHORITY** rule — the brief decides the deck's subject/angle/scope; the catalog is facts-to-cite, NOT the topic; if the catalog's subject diverges from the brief, FOLLOW THE BRIEF and write qualitatively where the catalog lacks relevant facts. Fixes content bleed where a divergent active note (auto-attached as a source) reproduced its own topic instead of the typed brief (e.g. "highlight of todays news" → learning-techniques content).
- `slideIr.ts` — new block kinds `waterfall`/`line-chart`/`pyramid` + table `style` (`matrix-2x2`/`rating`) + optional slide provenance (`action_title`/`storyboard_slide_id`); `chartNum = z.number()` (zod v4 rejects Infinity/NaN — `.finite()` is a deprecated no-op); a `.superRefine` enforces matrix-2x2 is a 3×3 grid.
- `irToHtml.ts` / `irToPptx.ts` — the 5 visuals render NATIVELY with **HTML/PPTX parity**: 2×2 CSS-grid quadrants, rating → harvey balls + a **clip-free visually-hidden "N of M" text node** (`ALLOW_ARIA_ATTR:false` strips aria — a11y needs a real text node), waterfall signed bridge bars, line SVG polyline, pyramid. PPTX uses native `addChart('line')` + text fallback.
- `dotDashSerializer.ts` / `dotDashParser.ts` / `dotDashAnchor.ts` — the human-editable storyline `.md`: `##` action titles + `- ` bullets (multi-bullet AND wrapped-continuation captured) + `> visual:` (display-only) + a `⚠ Storyline check` block, with machine state in a base64 `<!-- aio-slide:1 … -->` anchor (`-->`-safe; `btoa`/`atob`/`TextEncoder` — mobile-safe, NOT Node Buffer). `encodeMetaComment`/`decodeMetaComment` round-trip `sections` (dangling slide_ids dropped pre-validation so a user-deleted slide can't fail the parse).
- `presentationModelResolver.ts` — 5 pipeline roles → 2 settings (`presentationModelRoles`); `familyOf(provider, model)` enforces cross-family **independence** + a competence invariant; same-provider `modelOverride` vs cross-provider specialist `CloudLLMService`.
- `consultantAuditService.ts` (structural) + `consultantCriticService.ts` (`buildStoryboardJudge` — one LLM call verifying inferential numbers on a BLIND payload + MECE/laddering, bounded findings, never throws). The critic resolves through a DIFFERENT model family for genuine independent review.
- `consultantStoryboardPipeline.ts` — `runStoryboardStage`/`reviseStoryboard`/`buildDeckFromStoryline`/`buildDeckFromStoryboard`/`looksLikeBuildCommand`.

### Conversational review loop (`src/ui/chat/PresentationModeHandler.ts`)
**Per-deck Plan gate (2026-06-08)**: `generateIr` branches on `this.creationConfig.planMode` (NOT the global setting) — `'storyline'` runs `runConsultantStage`, `'direct'` runs `generateDeckIr`. The Plan pill (`CreatePanel.renderPlanRow`) writes `planMode`; it's seeded from `settings.presentationConsultantMode` once per creation cycle via `planModeSeededEpoch` (a user pill click within the cycle is preserved; a new deck — `creationFlowEpoch++` in `onClear` — re-seeds). `DEFAULT_CREATION_CONFIG.planMode='direct'`.

`runConsultantStage` drafts the storyboard → **posts the storyline markdown IN the chat** (conversational review) and **auto-saves** a `<title> — storyline.md` to the Presentations folder (NOT force-opened — `writeStorylineNote` no longer `openFile`s; it's the synced background copy, hand-editable if the user navigates to it). The storyboard pipeline runs with **`disableThinking: true`** (structured JSON — adaptive thinking was a large latency/timeout source) and a distinct **`'storyboarding'` phase → "Drafting storyline…"** (was mislabelled "Generating slides…"). Each subsequent chat turn while a storyline is pending either **REVISES** it (re-grounded/re-audited, re-posted in chat + re-saved) or **BUILDS** the deck (`looksLikeBuildCommand`). **Create deck button** (2026-06-08): while a storyline is pending (`pendingStoryline != null`, no deck yet) `getActionDescriptors` returns a single primary **"Create deck"** action → `handleCreateDeckFromStoryline` → the shared `buildFromStorylineNote` build path → `callbacks.rerenderContext?.()` swaps the create panel for the deck preview. The create panel (slides/sources/web-search/model/On-brand/Plan) stays visible THROUGHOUT the storyline phase (`renderContextPanel` renders it whenever `!deck.html`), so those settings shape the storyline up front and brand applies at the build; the button is the discoverable affordance for the build step (chat `looksLikeBuildCommand` still works as a shortcut). `ActionCallbacks.rerenderContext?()` (optional) → `UnifiedChatModal.renderContextPanel`. `resolveRoleRun(r, role)` builds the per-role specialist service; the background visual scan routes through the `visual_critic` context for storyline decks. Settings: `presentationConsultantMode` (**false** default — only seeds the per-deck Plan pill), `presentationStorylineGate` ('review'), `presentationModelRoles` ({generator,critic}); UI in `PresentationModelsSettingsSection.ts` — the master *Consultant-quality mode* toggle + *Storyline review* gate dropdown + the per-role model dropdowns.

**Deferred `.md` materialization (storyline-deferred-materialization, 2026-06-08)** — supersedes the eager-write description above. The working storyline now lives IN MEMORY: `pendingStoryline = { catalog, storyboard, storylineMarkdown, deckName, savedNotePath? }` (was `{ notePath }`). `runConsultantStage` does NOT write a `.md` — it sets `pendingStoryline`, posts the storyline in chat, and sets the `'storyline-review'` phase (clears the "Drafting storyline…" label; side-panel status `phaseStorylineReview`). A `.md` is materialized ONLY on an explicit choice — `getActionDescriptors` returns **two** review CTAs: **Save storyline** (`handleSaveStorylineNote` → `saveStorylineNote`: write once via `writeStorylineNote`, then `vault.modify` `savedNotePath` in place) and **Create deck** (`buildPendingStoryboard` → `buildDeckFromStoryboard(pending.storyboard)` in-memory + a provenance `.md` copy). `handlePendingStoryline` builds/revises the in-memory storyboard (no file read; revise re-posts + syncs `savedNotePath` if set). Crash-safety moved to the snapshot: `getSerializableState` serializes the pending storyline when `!deck.html`; `restoreState` validates via `validateStoryboard` + re-derives markdown via `storyboardToMarkdown` (the chat message restores via normal history). `onClear` nulls `pendingStoryline` (was a latent leak). `looksLikeBuildCommand` loosened so "Build slides from this storyline" (the instructed phrase) builds. Cramped-transcript fix: `getLayoutState().reviewingStoryline` → `PresentationLayoutController` `ai-organiser-pres-reviewing` marker overrides the create-mode `display:none` transcript collapse (the storyline is the review surface). `build-presentation-from-storyline` (saved-note hand-edit path) + `buildFromStorylineNote` are unchanged and now share the `commitBuiltDeck` deck-commit transaction.

**Storyboard robustness invariants (retry + parse hardening, audited 2026-06-08):** (1) `runStoryboardLLM` retries up to `MAX_STORYBOARD_ATTEMPTS = 3` — Azure Claude intermittently returns a 200 with non-JSON/empty content for the JSON prompt. An **empty 200** retries the base prompt fresh; a **non-empty unparseable** one feeds a repair prompt; a **`!res.success` failure is TERMINAL** (cloudService/`postWithRetry` already did 429/5xx backoff — never re-fire and hammer the provider). (2) `stripZeroWidthDeep()` runs at the storyboard parse boundary (`parseStoryboardFromResponse` + `validateStoryboard`) — the prompt builder defangs `<`→`<ZWSP`, and the LLM copies unchanged slides verbatim, so without stripping the ZWSP would **accumulate** into the stored storyboard + rendered deck across revision cycles. (3) Every pipeline service-boundary export (`runStoryboardStage`/`reviseStoryboard`/`buildDeckFromStoryboard`/`buildDeckFromStoryline`) is wrapped so a throw (injected judge / serializer / audit) returns `Result.err`, never rejects past the contract. (4) **Bounded strings TRUNCATE, they don't reject** (`boundedText()` in `consultantStoryboard.ts`): `core_message`/`thesis` use a larger `prose` budget (`MAX_PROSE=1500`), all other text fields `MAX_TEXT=800` — a length overage truncates at a word boundary, it does NOT hard-fail the storyboard (live: consultant `core_message`s ran past a hard `.max(800)` and every repair re-emitted one, killing generation). Do NOT revert these to a rejecting `.max()`. (5) **Ragged table/harvey rows COERCE, they don't reject** (`storyboardSlideSchema` `.transform`): a row whose cell/rating count ≠ the declared `columns` is padded (em-dash cell / 0 rating) or truncated to the header count — the LLM routinely emits a mismatch and every repair reproduces it (live: `harvey row 0 has 3 ratings but 4 columns` hard-failed the whole deck across both repair attempts). Do NOT revert this to a rejecting `superRefine`. **General principle: the storyboard schema degrades fixable structural/length issues gracefully (truncate/pad/coerce) — a single bad field must never hard-fail the whole generation, because the repair retry tends to reproduce the same mistake.** The `action_title` prompt constraint (≤ ~16 words, one line) keeps titles inside a slide's title area (storyline ↔ slide-capacity coupling), since the renderer caps per-slide physically (canvas + font autofit + min-font floor + table-row truncation) and the two layers should agree. (6) **The storyboard OUTPUT-token budget SCALES with slide count** (`storyboardMaxTokens(targetLength)=max(8192, 3000+slides×1400)`, threaded via `StoryboardCallOpts.maxTokens`) — the whole storyboard is ONE JSON response, so a 20–40 slide deck overflows the fixed 8192 default → JSON truncates → `no JSON object found`. This is the "total budget = per-slide × slides" axis (the per-field CHAR caps stay scale-invariant per-slide). `buildClaudeSummarizeBody` clamps `maxTokens` to `getProviderLimits(provider).maxOutputTokens` (azure-claude/claude=64k) so the generous request can't exceed the model limit; the OpenAI path is NOT clamped (reasoning `max_completion_tokens` covers reasoning+output and legitimately exceeds the output limit). (7) **SYSTEMATIC FINISHER — a malformed visual DEGRADES, it doesn't hard-fail** (`visual_data: visualDataSchema.catch({type:'bullets'})`): any visual too broken to render (line <2 points, harvey >8 columns, missing field) falls back to a prose bullets visual (the slide keeps title + core_message, loses the chart); `suggested_visual` reconciles to the actual `visual_data.type` (the rejecting `refine` is gone). This ENDS the per-constraint whack-a-mole — the only remaining `err` path is a STRUCTURAL break (a slide missing `id`/`role`). Do NOT re-add a rejecting refine/superRefine on visual shape. (8) **Max deck size is PROVIDER-AWARE** (`maxStoryboardSlides(provider)=clamp((maxOutputTokens−3000)/1400, 3, 40)`): the storyboard is ONE response, so the provider's output ceiling sets the max slides (azure-claude/claude=40, OpenAI~9, low-output floored at 3). The create-panel slide-count input clamps + advises this (`slideCreateLengthProviderCap`), and the handler caps `targetLength` so an over-large config can't silently truncate. The 1400-tokens/slide factor is the per-slide CONTENT budget (model-independent — schema-bounded); only the CEILING varies by provider. `PROVIDER_LIMITS.maxOutputTokens` reflects each provider's 2026 flagship output ceiling (claude/azure-claude 64000; openai/azure-openai/gemini/groq/deepseek/openrouter 65536) so flagship models clear ≥35 slides; `local` stays 4096. But the provider flagship is NOT the per-MODEL ceiling — an older selected model (gpt-4o = 16384) caps lower, so **`getModelOutputLimit(provider, model)`** applies a per-model floor (`MODEL_OUTPUT_OVERRIDES`) and is the SSOT for BOTH the token clamp AND `maxStoryboardSlides(provider, model)` (the UI advisory caps gpt-4o at ~9, gpt-5.x at 40). The clamp is applied on EVERY path — Claude (`buildClaudeSummarizeBody`), OpenAI **non-reasoning** (reasoning `max_completion_tokens` legitimately exceeds the output limit so it's left unclamped), and `localService` (clamps to the 4096 local ceiling) — because the scaled storyboard request would otherwise 400 a model whose real max is below the request (Gemini G1: gpt-4o + a large deck = HTTP 400 without this).

**Embedding-queue init-race tolerance (`embeddingQueue.ts`, 2026-06-08):** on plugin load a vault re-index can enqueue chunks before the async embedding service finishes initializing; `drainOnce` now waits a bounded `MAX_NULL_SERVICE_WAITS=8 × NULL_SERVICE_RETRY_MS=1500ms` for the service to appear instead of dropping all pending chunks on the first null (`failing N pending chunks — no embedding service`). It only fails when the service is genuinely absent (no key + no ONNX fallback); the wait counter resets once the service appears.

### Key patterns
- **Deterministic-first**: grounding is pure code; the LLM critic only judges what the deterministic tier marks inferential (blind payload — no fabricated-number rubber-stamp).
- **Round-trip fidelity**: the user's storyline edits survive the build (anchors carry machine state; prose carries titles/bullets).
- **No-false-positive grounding**: a number-shaped identifier (`Q3`) or a prose/year table cell is deliberately NOT grounded — false positives nag worse than the rare missed prose number; the primary title + visual claims are always grounded.
- **Sanitizer CSSOM-longhand trap**: every new visual's CSS must have its LONGHANDS allowlisted (the targeted renderer gate caught `border-radius` corner longhands being stripped — square corners in preview, PPTX unaffected).

### Tests
`tests/{consultantStoryboard,evidenceGrounding,storyboardTranslation,consultantAuditService,consultantCriticService,dotDashRoundTrip,dotDashSerializer,dotDashAnchor,consultantStoryboardPipeline,presentationModelResolver,presentationFrameworkBlocks}.test.ts`. Plan + audit summary gitignored (`docs/completed/consultant-quality-slides*.md`). **Renderer gate** (post-consolidated, 4 rounds → APPROVE) found 7 real renderer/grounding defects the per-cluster + consolidated audits missed (dot-decimal, identifier digits, section-deletion regression, negative-currency sign, harvey count, border-radius, multi-line bullets) — the renderer/sanitizer surface had not been independently reviewed until then.

## AI Chat + Presentation Builder

**Status**: ✅ Implemented (March 2026)

AI free-form chat inside `UnifiedChatModal`.

### Core Components

- `src/ui/chat/FreeChatModeHandler.ts`: Main handler for AI Chat, attachments, On-brand toggle, slides mode, build actions, and export flow
- `src/services/chat/presentationService.ts`: Phase 2 pipeline — generate → brand audit → layout audit → refine
- `src/services/chat/presentationAuditService.ts`: Deterministic audit execution and repair retry handling
- `src/services/chat/presentationTypes.ts`: `DeckModel`, `AuditFinding`, `BuildState`, `PresentationSnapshot`, and related contracts
- `src/services/prompts/presentationPrompts.ts`: Slide generation, audit, refinement, attachment packing, and brand-guideline prompts
- `src/ui/settings/AIChatSettingsSection.ts`: AI Chat settings UI

### PresentationModeHandler decomposition (TD-SSR-02, June 2026) ✅ complete-as-scoped

`PresentationModeHandler` was decomposed from a 1909-line god-object into a generation-orchestrator + `ChatModeHandler` facade over 7 single-responsibility collaborators under `src/ui/chat/presentation/` (handler **1909 → 1569 lines**):
- `presentationCommandRegistry.ts`: explicit register/unregister (replaces the old static `activeInstance`; true most-recently-activated, no dangling pointer). Global slide-picker command queries it.
- `presentationDeckStore.ts`: **single source of truth** for deck state (phase, html, deckIr, versions, activeSlideIndex, qualityResult, monotonic `deckEpoch`, `pushVersion`). Public mutable fields — handler mutates in place. `deckEpoch` MUST stay monotonic (thumbnail-cache key + layout signal; never `versions.length`).
- `presentationThemeResolver.ts`: shared `ExportTheme` resolver + memo cache.
- `presentationExporter.ts`: rich IR→PPTX + dom-to-pptx fallback, download, HTML vault write.
- `editScopeController.ts`: selection / editMode / editFlags + the chat-input accessory; injected `getOperation`/`isLocked`/`onActiveSlide`.
- `presentationCanvasView.ts`: the visual surface (iframe preview + filmstrip + thumbnail provider + slide-nav + `refreshPreview`); talked to via `canvas.*`. **Security invariant**: thumbnail provider fed only `deck.html` (post-sanitize), rasterized offscreen — slide CSS never enters the host DOM.
- `presentationRunController.ts`: single-flight run lifecycle — lock, per-op `AbortController`, thinking sink, active i18n, cancel hook. `run.begin(thinkingSink, t)`/`run.end()` collapse the begin/finally boilerplate; `setPhase` + lock-guards stay on the handler and delegate internals. **Lock-release invariant (2026-06-08):** `run.abort()` signals the AbortController but does NOT clear `locked` — only `run.end()`/`unlock()` do. `cancelActiveOperation` (used by `onClear`/`handleDiscard`) MUST call `run.end()` after `abort()`, else a wedged run (an op whose `finally` never ran) stays locked forever, disabling every deck action (`hasDeck && !locked` → Discard/Polish/Export/Save) AND making Clear/Discard unrecoverable. Clearing a deck must ALSO re-render the context panel (`UnifiedChatModal.renderContextPanel` / `ActionCallbacks.rerenderContext`), not just the toolbar/messages, or the stale slide preview stays painted (the "dead Clear" illusion). `handleClear` saves the conversation state AFTER `onClear` (deck snapshot already null) so the cleared file can't auto-restore the deck on reopen.

**Phase 3 (`PresentationPipeline`) deliberately NOT extracted — over-engineering.** Each generation method couples to ~12 collaborators/helpers (theme, sources, creationConfig, brand, deck, canvas, run, setPhase, commit, audit, quality, progress); a Pipeline-as-class would inject all of them — indirection without decoupling. The generation orchestration is the handler's core SRP. **Plan**: [docs/completed/presentation-handler-decomposition.md](../completed/presentation-handler-decomposition.md).

### Key Patterns

- **Model routing**: Opus reasoning for generation/refinement, non-reasoning Sonnet for audits
- **Handler-owned UI**: attachments and stateful actions live in `FreeChatModeHandler`, not the modal
- **Single deck model**: exports and refinement operate on the same normalized `DeckModel`
- **No streaming**: build progress shown as sequential state updates

### Tests

- `tests/freeChatModeHandler.test.ts`
- `tests/presentationTypes.test.ts`
- `tests/presentationPrompts.test.ts`
- `tests/presentationAuditService.test.ts`
- `tests/presentationService.test.ts`
- `tests/presentationExport.test.ts`
- `tests/brandedPptx.test.ts`

**Plan**: [docs/completed/pres-plan.md](../completed/pres-plan.md)

### Web-search query grounding (Option A, June 2026)

Presentation `web-search` sources are LLM-grounded in the deck's attached notes + prompt before dispatch (instead of running the literal query). `PresentationSourceService.resolve()` is **two-phase** (notes/folders resolved first → web-search last) so the grounder sees resolved note content; `buildWebSearchGroundingPrompt()` (`presentationChatPrompts.ts`) distils one ≤256-char query. The grounder seam (`WebSearchGroundingFn` injected via `creationSourceController.resolveForSubmit`) is **graceful by contract** — `groundQuery()` falls back to the literal query on no-grounder / no-context / empty / any throw, and never throws. Bounds: description ≤2000 chars, 6×1500-char excerpts (standalone notes prioritised over folder-derived), in-service ≤256-char clamp; abort re-checked after the grounding call. Web-search **bypasses the literal-query preload cache** when grounding is active (else grounding is skipped at submit). `ref` stays the literal query (stable cache identity). Gated by `presentationGroundWebSearch` (default `true`) — the privacy off-switch surfacing that note-derived terms reach the search provider (notes already reach the LLM as deck sources, so the only new surface is the distilled query → search provider).

## Presentation / LLM Depth Controls (thinking opt-in + Speed pill + per-call modelOverride fix)

**Status**: ✅ Implemented (June 2026) — Clusters A (core) + B (consumers), consolidated Gemini gate APPROVE.

Two coupled depth controls rooted in the core LLM service, plus the latent-bug fix that makes them work.

### Cluster A — core LLM-service contract (`src/services/cloudService.ts`, `src/services/types.ts`, `src/core/settings.ts`, `src/core/modelCatalog.ts`)
- **The core fix**: `buildClaudeSummarizeBody` previously IGNORED `options.modelOverride` on `claude`/`azure-claude` — a silent no-op that broke every per-call route on the dominant provider (`presentationModelRoles` same-provider role, `contentSizePolicy.mapModelOverride='latest-haiku'` chunk-map, selective refine). Now both the Claude path and the OpenAI branch route through one shared, exported, pure **`resolveModelOverride(adapterType, override, availableIds)`** — resolves `latest-*` against the live/static pool and **DROPS an unresolvable sentinel to `''`** (never sends a literal alias). `azure-claude` honours the override (model-in-body); `azure-openai` keeps `blockOverride` (deployment-routed URL). The companion **`computeAvailableModelIds(adapterType)`** is the pure live-cache-else-static pool helper (constructor + UI share it).
- **`SummarizeOptions.enableThinking`** — symmetric twin of `disableThinking`; `useThinking = (thinkingMode==='adaptive' || enableThinking) && claudeSupportsAdaptiveThinking(RESOLVED model) && !disableThinking` — **`disableThinking` wins**; capability is checked against the resolved override model.
- **Pacer-key ripple**: the resolved body model threads `sendSummarizeRequest → postWithRetry → pacedRequestUrl → azurePacerKey(pacerModel?)` so a per-call Sonnet→Opus override paces under the **Opus** deployment's RPM bucket, not the static service model's.
- **Thinking default OFF**: `claudeThinkingMode` default `'adaptive' → 'standard'` + guarded one-time migration **`thinkingDefaultOffV1`** (flips a persisted `'adaptive' → 'standard'` once; a deliberate re-enable after the guard is preserved; mirrors `azureModelDefaultsV3`).
- **`resolveDepthModel({adapterType, tier, availableIds})`** (modelCatalog SSOT): fast→`''`; direct-claude quality→`'latest-opus'`; `azure-claude` quality→newest catalog Opus present in `availableIds` (tenant on 4-6 still gets Deep), `''` if populated-no-opus, newest catalog opus if pool empty; other providers→`''`. Opus ids derived from `MODEL_CATALOG`.
- Constructor diagnosability: `logger.warn` when a configured service model is still an unresolved `latest-*` (no real trigger; makes a misconfig self-diagnosing instead of a cryptic API error).

### Cluster B — the two consumers
- **Speed pill → storyboard generator** (`src/ui/chat/presentation/speedPillModel.ts` pure, `PresentationModeHandler.ts`, `CreatePanel.ts`): `resolveStoryboardModelOverride` — an explicit `storyboard_generator` role override WINS; else the pill upgrades the MAIN provider (**Deep=Opus** via `resolveDepthModel`, **Fast=main**). Applies ONLY on the main context (a cross-provider role keeps its baked model — never leaks a main-provider Opus id elsewhere) and never to local; non-Claude mains → `''`. Used at BOTH generator call sites (`runStoryboardStage` + `reviseStoryboard`) — the **critic is untouched**. Speed pills get a `setTooltip` naming the effect.
- **Research Deep-thinking toggle** (`ResearchModeHandler.ts`, `researchOrchestrator.ts`, `researchTypes.ts`): **`buildResearchSynthesisOptions({deepThinking})`** — `enableThinking` or authoritative `disableThinking` (turns thinking OFF even when the global is adaptive) — applied on `synthesize` + `synthesizeStream` + the vault-precheck fallback. **`researchDeepThinkingAvailable(settings)`** capability-gates the checkbox (Claude-family + adaptive-capable resolved model only — never a silent no-op). `ResearchSessionState.deepThinking` persisted/restored alongside `academicMode`.

### Key patterns
- **Non-Claude / non-Azure byte-identical** — a no-override / no-thinking-flag call is unchanged (locked by baseline tests).
- **`disableThinking` wins** over `enableThinking` and over the global adaptive default — the complete symmetric per-call thinking contract.
- **Concrete override passes through; only `latest-*` is pool-gated and dropped-if-unresolvable** — never a literal sentinel to the API.

### Tests
`tests/{cloudServiceClaudeRouting,speedPillModel,modelCatalog,settingsMigration,researchOrchestrator,streamingSynthesis}.test.ts`. Plan + audit summary gitignored (`docs/plans/presentation-depth-controls*.md`); consolidated Gemini gate **APPROVE** ("exceptional… production-ready").

## Per-Slide Polish (Presentation)

**Status**: ✅ Implemented (June 2026)

Targeted polish of individual slides in an IR-backed deck. `handlePolish` routes a multi-slide deck to `PolishSelectorModal`; single-slide IR and legacy HTML decks keep the existing whole-deck path.

### Core Components

- `src/services/chat/refineDeckIrSelective.ts`: Selective deck-IR refine — single LLM call, **all-or-nothing splice**. Layered validation (pre-LLM: empty/duplicate/out-of-range selections + provider-aware token guard on the full assembled prompt; post-LLM: `tryExtractJson` → shape/length → duplicate/index-set → per-slice `SlideIrSchema.safeParse` → deck-level `validateDeckIr`). Force-preserves original `slide.id`. Never throws — every failure is a typed `Result.err('<code>: <detail>')`. `parseRefineErrorCode` decodes the prefix.
- `src/services/chat/refineDeckIrSelectiveTypes.ts`: `RefineErrorCode` + `REFINE_ERROR_CODES` both derived from one `CODES` const array (neutral module — i18n imports the union without depending on a service).
- `src/ui/modals/PolishSelectorModal.ts`: Pure IoC modal — collects a `PolishSubmit` draft, hands it to `opts.onSubmit`, stays open through the call so the draft survives failure. Privacy notice (`role=note`), deck-wide findings, "All slides" escape hatch, per-row checkbox+textarea, error banner (`role=alert`). CSS prefix `ai-organiser-polish-*`.
- `src/ui/chat/PresentationModeHandler.ts`: `openPolishSelector` + `runPolishSubmit` (selective wrapped in `withProgressResult`; state mutated only after `Result.ok`; stale findings invalidated; 1-based version label). Single-flight `activePolish` guard.

### Key Patterns

- **All-or-nothing**: any validation layer fails → no splice, no mutation, draft preserved for retry.
- **Whole-deck context, disclosed**: the full deck IR is sent as read-only context; the permanent privacy notice states unselected slides aren't modified.
- **Intentional divergence**: selective path has no 1-repair (whole-deck `refineDeckIr` keeps its). Shared engine deferred to v2.
- **0-based internal `slideIndex`, 1-based UI numbers** — converted at the seam.

### Tests

- `tests/refineDeckIrSelective.test.ts` (21), `tests/PolishSelectorModal.test.ts` (14), `tests/presentationModeHandler.polish.test.ts` (9).

**Plan**: [docs/completed/per-slide-polish.md](../completed/per-slide-polish.md) · **Audit**: [docs/completed/per-slide-polish-audit-summary.md](../completed/per-slide-polish-audit-summary.md)

## Presentation reliability fixes — brand re-render / busy-guard / storyline rebuild (F4/F7/B3)

**Status**: ✅ Implemented (June 2026) — persona-surfaced, plan-audited (GPT×3 + Gemini APPROVE) + code-audited (Gemini APPROVE), live-verified.

Three sustainable fixes to `PresentationModeHandler`, sharing extracted seams (no duplication):
- **F7 — On-brand toggle re-renders the live deck.** `rerenderDeckPreview(ctx, brandEnabled)`: monotonic last-write-wins (`brandReqId` bumped on EVERY request incl. queued), queue-while-locked + flush on the new `PresentationRunController.onRelease` hook, active-slide preserved (capture→clamp→restore), typed `RerenderOutcome` (`applied`/`queued`/`skipped-no-deck`/`error`) → `applyBrandFailurePolicy` (Notice + checkbox reconcile to `lastRenderedBrandEnabled`) on ANY path. The toggle handler `handleBrandToggle` is contained (never rejects). Capture brand state BEFORE the async theme-resolve (TOCTOU) so `lastRenderedBrandEnabled` matches the rendered deck.
- **F4 — `assertNotBusy(ctx, callbacks)`** shared guard: `handlePolish`/`handleBrandAudit` now Notice `presentationBusy` instead of a silent `return` on `run.isLocked()` (parity with export/save).
- **B3 — `build-presentation-from-storyline` command** (`chatCommands.ts`, gated by `presentation` feature): rebuilds a deck from a saved consultant storyline `.md`, decoupled from the in-memory `pendingStoryline` gate (survives modal close/reload). Opens `UnifiedChatModal` with `buildStorylineNotePath` → `onOpen` **bypasses the resume picker** for the direct action → `handler.buildFromStorylineNote()` → `buildDeckFromStoryline(md, [], lang)` (empty catalog = advisory grounding) → shared `commitNewDeck`. Clears `pendingStoryline` on success (no stale-gate clobber). `.md` + `instanceof TFile` guard.
- **`storylineNote.ts`** (pure SSOT): `classifyStorylineNote(content) → {kind:'ok'|'not-storyline'|'empty'}` — fence-aware line scan; `ok` requires a slide anchor AT/AFTER a `##` heading. `isStorylineNote` wrapper. Shared by command preflight + handler.
- **`commitNewDeck`** = the one deck-commit transaction (set IR+HTML, slide 0, `pushVersion` (bumps `deckEpoch`), `lastRenderedBrandEnabled`, reliability) shared by `generateIr` + `buildFromStorylineNote`. F7 re-render is a SEPARATE seam (re-theme: no version push, slide preserved).
- Tests: `storylineNote` (6), `presentationModeHandler.{brandRerender(5),busyGuard(3),buildFromStoryline(4)}`. Persona: `persona-pres-polish-brand` (F7/F4) + `persona-build-from-storyline` (B3) — both 0 P0/P1 live on azure-claude.

## Slides Side-Rail Workspace

**Status**: ✅ Phases 1 + 2 (filmstrip) + 3 (mobile bottom-sheet) implemented (June 2026). Plan complete.

In Slides mode the `UnifiedChatModal` becomes a **canvas-dominant side-rail workspace**: the 1920×1080 preview is the artifact (width-bound, large), and the transcript + composer dock into a resizable/collapsible right rail. The other five chat modes are untouched.

### Core Components

- `src/ui/controllers/PresentationLayoutController.ts`: owns the whole layout. `sync({mode, hasDeck, deckVersion})` toggles the `.ai-organiser-pres-workspace` marker class (which activates the CSS grid), reversibly reparents `chat-area` + `input-row` into a `.ai-organiser-pres-rail` wrapper, mounts the resizer + collapse toggle, applies persisted width/collapse. `dispose()` restores the DOM + flushes persistence.
- `src/ui/controllers/presentationLayoutConstants.ts`: TS-owned constants + `clampRailWidth(desired, modalWidth)` (NaN/Infinity-safe; caps at 40% of modal width).
- `PresentationModeHandler.getLayoutState()`: `{ hasDeck, deckVersion }` — the deck-state source the modal feeds to `sync()`.
- `UnifiedChatModal.syncPresentationLayout()`: called from `renderContextPanel` (covers renderAll/switchMode/post-generation); constructs the controller in `renderShell`, disposes in `onClose`.

### Key Patterns

- **Activation = controller-owned marker class**, NEVER the preview's internal `:has(.ai-organiser-pres-preview-container)` class (decoupled; survives transient loading/error phases).
- **Capture-once reparent**: original parent/next-sibling captured only on the enter edge; resyncs never re-capture (else restore would target the rail). Restore order is input-row then chat-area.
- **Narrow detection is modal-measured** (`ResizeObserver` → `.ai-organiser-pres-narrow`), NOT a viewport `@media` (the modal is ~92vw, so a viewport query fires at the wrong width). `< PRES_NARROW_BREAKPOINT_PX` falls back to the stacked column.
- **Persist RAW width, clamp on read** — a large-monitor preference survives a temporary open on a small screen.
- **Collapse a11y**: collapsed rail gets `inert` + `aria-hidden`; the expand toggle lives OUTSIDE the rail (out of grid flow via `position:absolute`) so it stays reachable; focus moves to it on collapse.
- **CSS grid scroll contract**: `minmax(0,1fr)` track + `min-width/height:0` on canvas/rail; transcript `overflow-y:auto`, composer `flex:0 0 auto`.
- Settings: `presLayout { railCollapsed, railWidthPx, filmstripCollapsed }` (per-device).

### Tests

- `tests/presentationLayoutController.test.ts` (17): clamp math, enter/leave + exact restore, capture-once regression, collapse + inert + focus move, keyboard resize, persist coalescing, dispose flush, presentation-no-deck stacked.

### Phase 2 — filmstrip (June 2026)

A vertical thumbnail navigator left of the canvas (`SlideFilmstrip` + `SlideThumbnailProvider`).
- **Thumbnails are inert rasters**: each slide → SVG `<foreignObject>` → `<img>` → `<canvas>` → PNG data-URL. Images don't run scripts and the sanitized deck restricts sub-resources to `data:`, so this renders the real slide (theme `<style>` + inline styles + data: images) with **no script execution and no network** — strictly more inert than the preview iframe. Provider must only be fed `this.html` (post-sanitize).
- `src/services/chat/slideThumbnailProvider.ts`: offscreen raster, LRU cache keyed by deck version, `AbortSignal`, CDATA-terminator escaping, `XMLSerializer` (foreignObject needs valid XHTML). Injectable `rasterize` for tests.
- `src/ui/components/SlideFilmstrip.ts`: presentational button group (NOT role=list — that breaks button semantics), **sequential** thumbnail load (bounded), **roving tabindex** (active = only tab stop) + `aria-current` + Arrow/Home/End keyboard nav (clamped both ends), focus restored to active thumb on rebuild, `scrollIntoView` on active change, `logger.warn` on thumbnail failures (no silent swallow), i18n group + item labels, `type=button`, hidden at ≤1 slide, `listen()` cleanup, data:image/png-only `src` guard.
- Wired in `PresentationModeHandler` canvas region (inside the canvas grid cell, so the side-rail grid is untouched). The inert-raster security claim (audit H1) is locked by a real-Chromium e2e spec: `tests/e2e/slideThumbnailRaster.spec.ts` (`npm run test:e2e`) — asserts the img-loaded foreignObject SVG produces a PNG, leaves the canvas un-tainted, executes no embedded `<script>`, and fetches no external sub-resource.

### Phase 3 — mobile bottom-sheet (June 2026)

At narrow modal widths the chat rail docks off-canvas as a **bottom-sheet** (`PresentationLayoutController`): a `💬` FAB (shown only when narrow, hidden when open) reveals it; a backdrop + Escape + close-on-widen dismiss it.
- **Marker-class driven**: `CLS_SHEET_OPEN` toggles the sheet transform (`translateY(110%)` → `0`); the FAB + backdrop are mounted via `listen()` and torn down in `leaveWorkspace()`.
- **Focus management**: `openSheet()` clears `inert`/`aria-hidden`, sets `aria-expanded=true`, focuses the first focusable in the rail, and attaches a Tab-trap keydown; `closeSheet()` reverses it and returns focus to the FAB. `updateNarrowClass()` auto-closes the sheet when the modal widens past `PRES_NARROW_BREAKPOINT_PX`.
- The filmstrip becomes a horizontal strip on narrow widths (CSS only).

**Plan**: [docs/completed/slides-side-rail-workspace.md](../completed/slides-side-rail-workspace.md) · **Audit**: [docs/completed/slides-side-rail-workspace-audit-summary.md](../completed/slides-side-rail-workspace-audit-summary.md)

## Presentation Sanitizer (DOMPurify)

**Status**: ✅ Phase 1 + Phase 2 (June 2026). Phase 3 (svgSanitize absorption) optional.

`sanitizePresentation` (`src/services/chat/presentationSanitizer.ts`) is the **trust boundary** for LLM-generated slide HTML before it renders in the preview iframe. Phase 1 replaced the regex engine with **DOMPurify** (parser-differential / mXSS); Phase 2 hardened the iframe: `sandbox="allow-same-origin"` (NO `allow-scripts`) + CSP `default-src 'none'` + DOMPurify are the layered boundary. A real-Chromium spike (Decision 7 Outcome A) confirmed scripts can't execute; the in-iframe runtime was retired (it was already CSP-blocked). The parent keeps `contentDocument` access (needs only same-origin) for nav / `applyDomFixes` / dom-to-pptx export. **Real-browser CSP/sandbox tests**: `tests/e2e/presentationSanitizerCsp.spec.ts` (`npm run test:e2e`).

### Components
- `src/utils/presentationSanitizePolicy.ts` — **neutral SSOT** (no DOM/DOMPurify): `ALLOWED_TAGS`/`ALLOWED_ATTR`/`FORBID_TAGS`, `ALLOWED_CSS_PROPERTIES`, `isAllowedPresentationUrl(el,attr,val)` matrix, `parsePresentationDataImageUrl` (decoded-byte size), `extractCssUrls` (robust, fail-closed), budgets (`MAX_INPUT_CHARS`/`MAX_DATA_URI_BYTES`/`MAX_IMAGE_COUNT`/`MAX_ATTR_CHARS`). Both the sanitizer and `svgSanitize` import downward into it.
- `src/services/chat/presentationSanitizer.ts` — DOMPurify singleton (hooks registered once) + per-call `activeCtx` (enforced re-entrancy guard) + hooks (URL/CSS-allowlist via CSSOM/anchor) + post-sanitize image-budget walk + filtered `removed` accounting + richer `SanitizeResult`. Returns the plain result object (NOT `Result<T>`); fails **closed** (empty html) on any error or absent DOM.
- `src/utils/svgSanitize.ts` — DOMParser allowlist walk for embedded SVG; derives tags+attrs from the policy.

### Key patterns
- **CSS allowlist enumerates CSSOM LONGHANDS** (`style.item(i)`), so a shorthand in `ALLOWED_CSS_PROPERTIES` is dead unless its expanded longhands are ALSO listed. `flex:1`→`flex-grow/shrink/basis`, `border:2px solid X`→per-side `border-{side}-{width,style,color}`, **`gap`→`row-gap`/`column-gap`** — all must be allowlisted (they are, since June 2026), else flex-grow tracks collapse, card borders vanish, **and flex/grid items collapse together (bar-chart labels touched the bars)** in the preview while the PPTX export (drawn directly) stays correct. `margin`/`padding`/`background` already had their longhands; **`gap` did NOT — `row-gap`/`column-gap` were added June 2026 after the layout radar caught chart labels touching the bars.** happy-dom keeps `gap` verbatim, so ONLY the real-Chromium render exposes this — lock via a live render measurement (the gap between label and bar), not the happy-dom unit test.
- **DOMPurify config strict**: `ALLOW_DATA_ATTR:false` + `ALLOW_ARIA_ATTR:false` — only the enumerated data-*/aria- in the policy survive.
- **URL validation in hooks** (parsed node, not re-parsed string); per-element matrix. `a@href` = https/#/mailto; `use@href` = `#frag`; `img@src` + CSS `url()` = data:image raster only; SVG paint `fill`/`stroke` url() = `#frag`/data-raster.
- **Fail-closed CSS url() extraction**: `extractCssUrls` reports `clean:false` when `url(` count ≠ parsed-token count → caller drops the declaration (no fail-open on crafted `url("…)…")`).
- **Budgets**: oversized input → fail-closed empty; per-image bytes / image count degrade gracefully (strip the resource, keep the deck).
- **`DANGEROUS_HTML_PATTERNS`** stays exported but is documented as the streaming reliability **heuristic only — NOT a security boundary**.
- `injectCSP` keeps `default-src 'none'; style-src 'unsafe-inline'; img-src data:`. Phase 2 (Decision 7 Outcome A) dropped iframe `allow-scripts` and removed the in-iframe runtime — scripts cannot execute (proven by `tests/e2e/presentationSanitizerCsp.spec.ts` in real Chromium).

### Tests
- `tests/presentationSanitizer.test.ts` (44, happy-dom): classic XSS + mXSS/parser-differential + SVG specialisation + anchor canonicalisation + CSS allowlist + budgets + result contract + golden parity + fail-open regression. (Real-browser CSP/parity tests are Phase 2.)

**Plan**: [docs/plans/presentation-future-phase.md](../plans/presentation-future-phase.md) · **Audit**: [docs/completed/presentation-sanitizer-hardening-audit-summary.md](../completed/presentation-sanitizer-hardening-audit-summary.md)

## Brand Fidelity (presentation/DOCX export)

**Status**: ✅ Implemented (June 2026)

Makes presentation (PPTX) + DOCX exports on-brand and **template-ready**: a vault `brand-guidelines.md` now feeds the **export `ExportTheme`** (not just the HTML preview) — brand colours + font + a per-role **min-font floor** + **template safe-area geometry**. Brand is **configured once in settings**; the existing **per-deck "On-brand" toggle** decides whether a deck applies it (settings = config, toggle = apply).

### Vault brand pack (config, never in repo)
`<vault>/<brandFolderPath>/` (default `999_Brand`): `brand-guidelines.md` (required — `## Colors`/`## Typography` incl. `Font fallback` + `Min {body,caption,table,footer} pt` + `Body pt`/`## Layout` zones in inches/`## Composition Rules`), optional `logo-light/dark.(png|svg)`, optional `icons/<concept>.svg` (+ optional `icons/index.json`). Read via the vault API (must be inside the vault; works on mobile; Obsidian-Sync-distributable). Corporate brand assets are **gitignored** (`docs/plans/brand/`, `docs/plans/999_Brand/`); public ships only the generic mechanism + neutral defaults.

### Core components
- `src/services/chat/brandThemeService.ts` — parses `brand-guidelines.md` → `BrandTheme` (colours, font, `fontFallback`, `bodyFontPt`, `minFont`, `layout`, `warnings`); degrade-to-default per section; `loadBrandTheme` returns `Result<BrandTheme>`. (`extractSection` reads full multi-line sections.)
- `src/services/export/brand/brandExportTheme.ts` — **pure** `toExportTheme(brand)` + `getSafeArea(brand)`; colours via `safeHex`, `firstFontFamily` (strips CSS quotes), `fontSize` = nominal `Body pt` clamped ≥ `minFont.body`.
- `src/services/export/brand/brandRenderContext.ts` — `resolveBrandRenderContext(app, settings, brandEnabled, usedConcepts, fallbackTheme): Result<BrandRenderContext>`; resolved **once, async**, passed to all export entry points; renderers stay pure. Source `'brand' | 'example' | 'export-settings'` (missing brand file → generic `exampleBrandTheme`, matching preview + export).
- `src/services/export/brand/brandAssets.ts` — vault asset resolution: `getBrandFolder`, `getLogo`, `getBrandIcon` (concept→file via `icons/index.json` or `<concept>.svg`), `sanitizeSvgMarkup` fail-closed, `MAX_SVG_BYTES`/`MAX_PNG_BYTES` caps, offscreen SVG→PNG raster with timeout + light/dark recolour, LRU cache keyed by `(kind, full-path, variant, mtime, recolour)`. Shared filename constants (`BRAND_GUIDELINES_FILE`, `LOGO_LIGHT/DARK`, `ICONS_DIR`).
- `src/services/presentationIr/deckIconConcepts.ts` — extracts the icon concepts a deck references (bounds rasterization).
- `src/ui/settings/BrandSettingsSection.ts` — dedicated **Brand** settings section (folder path + on-brand-default + detected-status state machine); debounced save + `validationSeq` stale-write guard. Migration: `presentationBrandGuidelinesPath` (deprecated) → `brandFolderPath` (parent folder).

### Key patterns
- **Renderers stay pure**: `irToPptx`/`richPptxRenderer` consume a resolved `ExportTheme` (`minFont?`/`safeArea?` optional → non-brand exports byte-identical) + `RenderPptxOptions.brandAssets`; brand icon by concept (variant by slide bg) → Lucide fallback (logged).
- **Min-font = shrink-floor**: fixed-size text clamps up; autofit lower-bounds at the role floor, then existing overflow/truncation runs (no new clipping).
- **Safe-area**: content rectangle reserves the master logo (top-right) + footer (bottom-left) zones so decks paste cleanly into the corporate template ("Use Destination Theme"); the template delivers the swoosh/logo. Logo drawing is opt-in (default off; `// TODO(brand)`).
- **SVG safety**: all brand SVGs pass `sanitizeSvgMarkup` (fail-closed), byte-capped; redacted diagnostics (asset name only).

### Tests
`tests/brandThemeService.test.ts`, `tests/brandExportTheme.test.ts`, `tests/brandAssets.test.ts`, `tests/brandRenderContext.test.ts`, `tests/deckIconConcepts.test.ts`, `tests/irToPptxBrand.test.ts`, `tests/markdownDocxBrand.test.ts`, `tests/settingsMigration.test.ts` (brand migration). Plans (gitignored): `docs/plans/sync/brand-fidelity.md` (+ audit summary).

### Brand Font Embedding (June 2026)

By default a brand font is only **named** in CSS, so the preview/PDF render it only where the OS has it (Windows lacks Noto Sans). Dropping `woff2` files into a `<brandFolder>/fonts/` subfolder (mirrors `icons/`) **embeds** the real face so the **live preview + printed PDF** render true everywhere. PPTX still only names the font (pptxgenjs can't embed); **filmstrip thumbnails + the dom-to-pptx raster fallback render the fallback face** (SVG-as-`<img>` ignores host `@font-face`) — a documented v1 limitation. User guide: [docs/brand-setup.md](../brand-setup.md) §4b.
- `brandAssets.ts` — `getBrandFonts(app, settings, family)` (woff2 magic-validate → base64 → `@font-face` bound to the serialized primary family, per-file 2 MB / 8 MB-total caps, byte-bounded LRU, fail-closed `skipped[]`); `inspectBrandFontCandidates` (**sync**, stat-only, for the settings status line); `brandFontsSignature` (memo-bust). `FONTS_DIR='fonts'`; filename grammar `<slug>-<weight>[-italic].woff2`; no manifest in v1.
- `themeSafe.ts` — `sanitizeCssFontFamily` (validate → bare raw, **Unicode-aware** allowlist so CJK/accented names survive while injection chars are stripped) **vs** `serializeCssFontFamily` (render → CSS token, generics bare else quoted-**once**) — never conflated, so PPTX gets a bare `fontFace` and CSS gets a correctly-quoted token (no `''Noto Sans''`). `sanitizeCssFontFamilyList` builds `fontStack`. `sanitizeExportTheme` **always** populates `fontStack` from the raw value (off-brand `fontFace` may itself be a stack — single-family sanitize would comma-strip it) + sets `fontFace` to the first bare family.
- `brandExportTheme.composeFontStack(brand)` — leads the stack with the embedded **primary** then `fontFallback` (NOT `fontFallback` alone — that named only the fallback, never the embedded face).
- `ExportTheme` gains optional `fontStack?` (HTML, always-populated) + `fontFaceCss?` (the `@font-face` block, brand-with-fonts only); PPTX ignores both → byte-identical.
- Injection seam: the resolved `@font-face` rides the existing `brandCss` head argument in `presentationHtmlService.buildHtmlFromDeckIr` (injected **after** sanitize → DOMPurify can't strip it) and is authorized by **`font-src data:`** added to `presentationSanitizer.CSP_META` (data:-only; no `script-src` change → scripts still blocked). Real-Chromium proof: `tests/e2e/presentationSanitizerCsp.spec.ts` (data: font allowed, https: blocked, scripts blocked).
- Tests: `themeSafe.test.ts`, `brandAssets.test.ts`, `brandExportTheme.test.ts`, `brandRenderContext.test.ts`, `presentationSanitizer.test.ts`, `tests/e2e/presentationSanitizerCsp.spec.ts`. **Plan**: [docs/completed/brand-font-embedding.md](../completed/brand-font-embedding.md) (GPT R1-R3 + Gemini gate; caught 5 would-ship bugs incl. fontStack-naming-only-fallback, sanitize/serialize quoting conflict, off-brand stack comma-stripping).
