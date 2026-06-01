# Project Status Log

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
- Designed and wrote [docs/plans/multi-segment-minutes.md](docs/plans/multi-segment-minutes.md) — multi-segment meeting minutes feature so a single meeting can have a general transcript + N topic segments (e.g. main meeting → VAT breakout → reconvene). Each segment gets its own scoped documents/audio/transcript via per-row dropdown in the existing pickers (no new modal). Plan went through full /cycle: 3 GPT-5.4 audit rounds (R1 H:6 M:5 → R2 H:4 M:6 → R3 H:4 M:6) + 2 Gemini final-review rounds. 24 findings addressed, Gemini-r2 plan-spec gaps documented as deferred MVP scope.
- **Delivered (first vertical slice — ~1450 LOC)**:
  - **Foundation modules**: `src/services/minutes/minutesTypes.ts` (canonical types — `SegmentInput`, `MultiSegmentInput`, `SegmentResult`, `SegmentSection` discriminated union, `TranscriptItem`, `SpeakerKey`, `SpeakerMappingV2`, `shouldUseLegacyPath` predicate); `src/services/minutes/sectionRegistryController.ts` (topic CRUD with 40-char cap + duplicate disambiguation + `resolveSection` fallback); `src/services/minutes/multiSegmentMinutes.ts` (`runMultiSegmentExtraction` orchestrator with per-segment chunked extraction + intermediate merge + cross-segment consolidation, section-provenance preserving hierarchical reduce per Gemini-G1, cancellation short-circuit per Gemini-r2-G1, contextDocuments preamble per Gemini-r2-G1); `src/services/prompts/segmentConsolidationPrompts.ts` (XML-structured prompt per R3-M4); `src/utils/redactionUtils.ts` (PII redaction with phone-vs-date heuristic).
  - **UI components** (presentational, use `listen()` helper): `src/ui/utils/vaultFileScope.ts` (D9 — `getScopedFiles` resolves embeds/wiki-links/markdown links from a captured sourceFile per R2-M6); `src/ui/components/ScopedFilePickerHeader.ts` (radio for "Files in this note (N) / All vault files (M)"); `src/ui/components/SectionAssignmentSelect.ts` (per-row `<select>` with inline `+ New topic…` creation flow).
  - **Wiring**: `DocumentMultiPickerModal` extended — optional `sectionRegistry` prop renders per-row dropdowns; optional `sourceFile + app` props render `ScopedFilePickerHeader` defaulting to active-note scope; `onConfirm` payload now `Array<{item, sectionId}>`. `MinutesCreationModal.openDocumentPicker` defaults to active-note scope (addresses user's "99 File Storage shows lots of files" complaint).
  - **i18n contract**: added `Translations.minutes.sections` optional namespace per R2-M4 (Gemini-r2-G2).
- **Deferred to follow-up** (documented as MVP-scope gaps in plan): SectionRegistryController instantiation on the modal + always-visible "+ Add topic" header button; `MinutesService.generateMultiSegmentMinutes` wrapper; `MinutesJSON.sections[]` rendering; minutesValidator/minutesAuditor per-section iteration; audio per-section `sectionId`; speakerAttribution multi-segment bundle support; EN/ZH-CN string implementations; 14 unit test files. None user-visible — no production code path wires multi-segment dispatch yet.

### Files Affected
- **New (9)**: `src/services/minutes/{minutesTypes,sectionRegistryController,multiSegmentMinutes}.ts`, `src/services/prompts/segmentConsolidationPrompts.ts`, `src/utils/redactionUtils.ts`, `src/ui/utils/vaultFileScope.ts`, `src/ui/components/{ScopedFilePickerHeader,SectionAssignmentSelect}.ts`.
- **Modified (5)**: `src/services/prompts/minutesPrompts.ts` (export `parseJsonWithRepair`), `src/ui/modals/DocumentMultiPickerModal.ts`, `src/ui/modals/MinutesCreationModal.ts`, `src/i18n/types.ts`, `tests/documentMultiPickerModal.test.ts`.
- **Plan**: `docs/plans/multi-segment-minutes.md` (~3500 lines).

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
