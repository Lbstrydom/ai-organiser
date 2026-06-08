# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

> **Note:** This is the canonical reference for all AI coding agents. Keep in sync with `CLAUDE.md`.

## Build Commands

```bash
# Development build with watch mode and inline sourcemaps
npm run dev

# Production build (source type-check + tests + bundle)
npm run build

# Quick production build (source type-check + bundle, skips test types)
npm run build:quick

# Version bump (updates manifest.json and versions.json)
npm run version
```

**Build Configuration**:
- `tsconfig.json` - Full config including tests (for IDE)
- `tsconfig.build.json` - Source-only config (for production builds)

The build process uses esbuild to bundle `src/main.ts` into `main.js`. Production builds disable sourcemaps; dev builds enable inline sourcemaps.

## Architecture Overview

### Core Plugin Structure

**Entry Point**: `src/main.ts` (`AIOrganiserPlugin` class)
- Main plugin class extending Obsidian's `Plugin`
- Manages lifecycle: settings loading, LLM service initialization, command registration
- Handles tag operations: `analyzeAndTagNote()`, `showTagNetwork()`, batch processing
- Central coordinator between services, UI, and Obsidian API

### Service Layer Architecture

**LLM Services** (`src/services/`)
- **Base abstractions**: `LLMService` interface defines contract for all providers
- **Two service types**:
  - `LocalLLMService`: Ollama, LM Studio, LocalAI, OpenAI-compatible endpoints
  - `CloudLLMService`: Cloud providers (OpenAI, Claude, Gemini, Groq, etc.)
- **Adapter pattern** (`src/services/adapters/`): Each cloud provider has its own adapter (e.g., `claudeAdapter.ts`, `geminiAdapter.ts`) handling API-specific formatting
- **Prompt engineering** (`src/services/prompts/`): XML-structured prompts optimized for Claude/GPT

**Key service flow**:
1. Plugin calls `llmService.analyzeTags(content, candidateTags, mode, maxTags, language)`
2. Service builds prompt via `buildTagPrompt()` with mode-specific instructions
3. For cloud: Adapter formats request → calls API → parses response
4. Returns `LLMResponse` with `suggestedTags` and `matchedExistingTags`

### Provider Registries

**LLM Provider Registry** (`src/services/adapters/providerRegistry.ts`):
- `ALL_ADAPTERS`: List of all 14 supported adapter types
- `PROVIDER_DEFAULT_MODEL`: Default model per provider
- `PROVIDER_ENDPOINT`: Default API endpoint per provider
- `buildProviderOptions(t)`: Generate dropdown options from translations

**Embedding Provider Registry** (`src/services/embeddings/embeddingRegistry.ts`):
- `EMBEDDING_DEFAULT_MODEL`: Default model per embedding provider (6 providers)
- `EMBEDDING_MODELS`: Available models per provider
- `getEmbeddingModelOptions(provider)`: UI-friendly labeled options

### Settings & Configuration

**Settings schema** (`src/core/settings.ts`):
- `AIOrganiserSettings` interface with 35+ configuration options
- Key settings: `serviceType`, `cloudServiceType`, `interfaceLanguage`, `enableSemanticSearch`, `embeddingProvider`
- Settings UI split into modular sections (`src/ui/settings/`), wrapped in 10 collapsible `<details>/<summary>` groups:
  - `LLMSettingsSection`: Service provider configuration, API keys, Getting Started info box
  - `SpecialistProvidersSettingsSection`: Dedicated providers for YouTube, PDF, Audio, Flashcards
  - `TaggingSettingsSection`: Max tags, folder exclusions, note structure toggle, taxonomy guardrail
  - `InterfaceSettingsSection`: Interface language, output languages
  - `SummarizationSettingsSection`: Summary style, personas, transcript options
  - `AudioTranscriptionSettingsSection`: Audio recording, transcription settings
  - `DigitisationSettingsSection`: Smart digitisation mode, image quality
  - `SketchSettingsSection`: Sketch pad output, auto-digitise, pen defaults
  - `MinutesSettingsSection`: Meeting minutes output, timezone, personas, GTD overlay
  - `SemanticSearchSettingsSection`: Embeddings, indexing, RAG settings
  - `KindleSettingsSection`: Kindle output folder, highlight style, sync options
  - `MermaidChatSettingsSection`: Mermaid chat context, staleness, alt-text, export options
  - `CanvasSettingsSection`: Canvas output, edge labels, LLM clustering
  - `BasesSettingsSection`: Structured metadata, migration
  - `NotebookLMSettingsSection`: NotebookLM export settings
  - `ExportSettingsSection`: Document export (flashcards, export theme: colour scheme, font, size)
  - `InterfaceSettingsSection`: Interface language, tag output language, summary language
  - `MobileSettingsSection`: Mobile provider mode, fallback settings
  - `ConfigurationSettingsSection`: Config files management

**Settings persistence**: Loaded in `loadSettings()`, saved via `saveSettings()`, triggers service reinitialization.

**Settings migration** (`src/core/settings.ts`):
- `migrateOldSettings()`: Pure function migrating old settings to current schema
- Called from `loadSettings()` in `main.ts` — all migrations in one testable function
- Handles: `ollama`→`local`, tag range→`maxTags`, `student`→`brief`, 5 retired minutes persona IDs→`standard`/`governance`, summary length rename (`comprehensive`→`detailed`→`standard`, order-safe)

### Internationalization (i18n)

**Translation system** (`src/i18n/`):
- **English only** (`en.ts`). The i18n system stays (typed `t.*` access), but the Simplified-Chinese locale was retired 2026-06 — the EN/ZH parity maintenance burden outweighed its use. `migrateOldSettings` coerces any stored `interfaceLanguage: 'zh-cn'` → `'en'`.
- Type-safe translations via the `Translations` interface
- Access translations: `this.t.settings.someKey` or `plugin.t.messages.someMessage`
- Interface language change requires Obsidian restart
- Re-adding a locale later = add a `Translations` impl + an entry in `src/i18n/index.ts`

**Adding new i18n strings**:
1. Add to the `Translations` interface in `types.ts`
2. Implement in `en.ts` (the only locale)
3. Reference via `t.section.key` in code

### Tag Utilities & Operations

**Core utilities** (`src/utils/tagUtils.ts`):
- `TagUtils.formatTags()`: Sanitizes tags (removes prefixes, enforces kebab-case)
- `TagUtils.updateNoteTags()`: Modifies frontmatter YAML, handles merge vs replace
- `TagUtils.getAllTags()`: Extracts all tags from vault frontmatter
- `TagUtils.getTagsFromFile()`: Reads predefined tags from markdown file

**Tag formatting rules**:
- Remove `#` prefix and malformed prefixes (`tag:`, `matchedExistingTags-`, etc.)
- Convert to kebab-case (spaces/special chars → hyphens)
- Preserve `/` for nested tags (e.g., `science/biology`)

### RAG & Semantic Search

**Vector Store** (`src/services/vector/`):
- `VoyVectorStore`: Production vector storage using Voy WASM
- `IVectorStore` interface for vector operations
- Chunk-based indexing with configurable size and overlap

**RAG Service** (`src/services/ragService.ts`):
- `RAGService.getRelatedNotes()`: Semantic note discovery
- `RAGService.retrieveContext()`: Context retrieval for RAG
- `RAGService.buildRAGPrompt()`: Enhanced prompt building with vault context
- `RAGService.formatSources()`: Source citation formatting

**Embedding Services** (`src/services/embeddings/`):
- **IEmbeddingService interface** with `generateEmbedding()`, `batchGenerateEmbeddings()`
- **5 Embedding Providers**:
  - **OpenAI** - text-embedding-3-small/large (1536/3072 dims)
  - **Ollama** - nomic-embed-text, mxbai-embed-large (local)
  - **Gemini** - text-embedding-004 (768 dims)
  - **Cohere** - embed-english-v3.0 (1024 dims)
  - **Voyage AI** - voyage-3/voyage-3-lite (high quality)
- **Factory pattern**: `createEmbeddingServiceFromSettings()` handles API key inheritance
- **Note**: Claude/Anthropic does NOT have an embeddings API - use Voyage AI instead

**Semantic Search Modal** (`src/commands/semanticSearchCommands.ts`):
- `SemanticSearchResultsModal`: Main search interface with multi-select and export
- **Selection Features**:
  - Checkboxes on each result for multi-select
  - "Select All" / "Deselect All" toggle in header
  - Selection count badge (live updates)
  - "Export Selected" button (disabled when none selected)
- **Export Functionality**:
  - `ExportSearchResultsModal`: Export selected results to notes
  - Target options: New note (with folder picker) or existing note
  - Format options: Links only or links with excerpts (1-line blockquotes)
  - Auto-opens new note after export
  - Appends to existing note with timestamp header

**Related Notes View** (`src/ui/views/RelatedNotesView.ts`):
- Persistent sidebar ItemView showing semantically similar notes
- Auto-updates with 500ms debounce on note switch
- Interactive features: click navigation, hover preview, copy markdown link
### Obsidian Bases Integration

**Overview**: Structured metadata system enabling dashboard views through Obsidian Bases plugin.

**Core Components** (`src/core/`, `src/utils/`, `src/services/`):
- `constants.ts`: AIO_META namespace with simple property names (`summary`, `source_url`, etc.)
- `frontmatterUtils.ts`: CRUD operations for metadata (updateAIOMetadata, getAIOMetadata, createSummaryHook)
- `structuredPrompts.ts`: JSON-structured prompts for LLMs (StructuredSummaryResponse interface)
- `responseParser.ts`: 4-tier fallback JSON parsing (direct parse → code fence → object search → plain text)

**Migration System** (`src/services/migrationService.ts`, `src/ui/modals/MigrationModal.ts`):
- Analyzes vault scope (needsMigration vs alreadyMigrated counts)
- Extracts summaries from note body (##Summary, ##TL;DR, first paragraph)
- Determines status from existing tags (processed vs pending)
- Auto-detects content type from keywords (research, meeting, project, reference)
- 4-stage modal UI: Analysis → Options → Progress → Results

**Dashboard Generation** (`src/services/dashboardService.ts`, `src/services/configurationService.ts`):
- Single "Notes Dashboard" template for simplicity
- Template structure: YAML with `filters:` (plural), `columns:`, optional `sorting:`
- `injectFolderFilter()`: Auto-adds `file.inFolder("path")` for folder scoping
- DashboardCreationModal as simple confirmation dialog
- Dashboard created via right-click folder context menu

**Settings Integration** (`src/ui/settings/BasesSettingsSection.ts`):
- 3 toggle settings: enableStructuredMetadata, includeModelInMetadata, autoDetectContentType
- Quick action buttons: Migrate (launches migration modal), Create Dashboards (launches dashboard modal)
- Info box with usage guidance

**Summarization Integration** (`src/commands/summarizeCommands.ts`):
- Conditional structured output: if `enableStructuredMetadata` → use `buildStructuredSummaryPrompt()`, else traditional
- Parses JSON response → extracts body_content, summary_hook, suggested_tags, content_type
- Updates frontmatter with `updateNoteMetadataAfterSummary()` after URL/PDF/YouTube summarization
- Tracks source type and URL for web content

**Commands** (`src/commands/migrationCommands.ts`, `src/commands/dashboardCommands.ts`):
- `ai-organiser:upgrade-metadata` - Migrate entire vault
- `ai-organiser:upgrade-folder-metadata` - Migrate current folder
- `ai-organiser:create-bases-dashboard` - Launch dashboard creator

**Key Patterns**:
- **Simple property names**: Metadata uses clean, user-friendly names (`summary`, `source_url`) for readability
- **Minimal metadata**: Only essential fields stored by default (summary hook and source URL)
- **280-char summaries**: Optimized for Bases preview pane, truncates at sentence boundaries
- **Graceful degradation**: Works without Bases plugin (metadata still useful for Dataview, search)
- **Type safety**: ContentType, StatusValue, SourceType enums in constants.ts
- **i18n**: English-only (`en.ts`); the i18n system remains, the zh-cn locale was retired 2026-06

**Integration Points**:
- Tag generation: Suggested tags from structured responses added to frontmatter
- Semantic search: Content type filters improve RAG context retrieval
- Smart summarization: Auto-detects source type based on input (URL → 'url', PDF → 'pdf')
### Tag Network Visualization

**Implementation** (`src/ui/views/TagNetworkView.ts`):
- Custom Obsidian `ItemView` for graph visualization
- Dynamically loads D3.js v7 from CDN
- Network data built by `TagNetworkManager` (`src/utils/tagNetworkUtils.ts`)
- Interactive features: search filtering, hover tooltips, node dragging

## Command Registration

Commands registered in `src/commands/`:
- `generateCommands.ts`: Tag generation for notes/folders/vault
- `clearCommands.ts`: Clear tags from notes/folders/vault
- `summarizeCommands.ts`: URL/PDF/YouTube/Audio summarization + audio recording command
- `translateCommands.ts`: Note, selection, and multi-source translation
- `smartNoteCommands.ts`: Improve note, find resources, diagrams, mermaid chat
- `integrationCommands.ts`: Pending content integration with placement/format/detail strategies
- `minutesCommands.ts`: Meeting minutes generation + Word document export
- `canvasCommands.ts`: Investigation, Context, and Cluster Board canvas generation
- `chatCommands.ts`: Highlight chat (chat about highlights)
- `flashcardCommands.ts`: Flashcard export (Anki/Brainscape)
- `digitisationCommands.ts`: Smart digitisation of images (handwriting, diagrams, whiteboards)
- `sketchCommands.ts`: Built-in sketch pad with perfect-freehand
- `kindleCommands.ts`: Kindle highlights sync (My Clippings.txt import)
- `embedScanCommands.ts`: Find embeds / vault hygiene scan
- `quickPeekCommands.ts`: Quick Peek fast triage for embedded sources
- `utilityCommands.ts`: Collect tags, tag network

All commands use `plugin.addCommand()` with i18n names and icon support.

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
- `presentationRunController.ts`: single-flight run lifecycle — lock, per-op `AbortController`, thinking sink, active i18n, cancel hook. `run.begin(thinkingSink, t)`/`run.end()` collapse the begin/finally boilerplate; `setPhase` + lock-guards stay on the handler and delegate internals.

**Phase 3 (`PresentationPipeline`) deliberately NOT extracted — over-engineering.** Each generation method couples to ~12 collaborators/helpers (theme, sources, creationConfig, brand, deck, canvas, run, setPhase, commit, audit, quality, progress); a Pipeline-as-class would inject all of them — indirection without decoupling. The generation orchestration is the handler's core SRP. **Plan**: [docs/completed/presentation-handler-decomposition.md](docs/completed/presentation-handler-decomposition.md).

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

**Plan**: [docs/completed/pres-plan.md](docs/completed/pres-plan.md)

### Web-search query grounding (Option A, June 2026)

Presentation `web-search` sources are LLM-grounded in the deck's attached notes + prompt before dispatch (instead of running the literal query). `PresentationSourceService.resolve()` is **two-phase** (notes/folders resolved first → web-search last) so the grounder sees resolved note content; `buildWebSearchGroundingPrompt()` (`presentationChatPrompts.ts`) distils one ≤256-char query. The grounder seam (`WebSearchGroundingFn` injected via `creationSourceController.resolveForSubmit`) is **graceful by contract** — `groundQuery()` falls back to the literal query on no-grounder / no-context / empty / any throw, and never throws. Bounds: description ≤2000 chars, 6×1500-char excerpts (standalone notes prioritised over folder-derived), in-service ≤256-char clamp; abort re-checked after the grounding call. Web-search **bypasses the literal-query preload cache** when grounding is active (else grounding is skipped at submit). `ref` stays the literal query (stable cache identity). Gated by `presentationGroundWebSearch` (default `true`) — the privacy off-switch surfacing that note-derived terms reach the search provider (notes already reach the LLM as deck sources, so the only new surface is the distilled query → search provider).

## Presentation reliability fixes — brand re-render / busy-guard / storyline rebuild (F4/F7/B3)

**Status**: ✅ Implemented (June 2026) — persona-surfaced, plan-audited (GPT×3 + Gemini APPROVE) + code-audited (Gemini APPROVE), live-verified.

Three sustainable fixes to `PresentationModeHandler`, sharing extracted seams (no duplication):
- **F7 — On-brand toggle re-renders the live deck.** `rerenderDeckPreview(ctx, brandEnabled)`: monotonic last-write-wins (`brandReqId` bumped on EVERY request incl. queued), queue-while-locked + flush on the new `PresentationRunController.onRelease` hook, active-slide preserved (capture→clamp→restore), typed `RerenderOutcome` (`applied`/`queued`/`skipped-no-deck`/`error`) → `applyBrandFailurePolicy` (Notice + checkbox reconcile to `lastRenderedBrandEnabled`) on ANY path. The toggle handler `handleBrandToggle` is contained (never rejects). Capture brand state BEFORE the async theme-resolve (TOCTOU) so `lastRenderedBrandEnabled` matches the rendered deck.
- **F4 — `assertNotBusy(ctx, callbacks)`** shared guard: `handlePolish`/`handleBrandAudit` now Notice `presentationBusy` instead of a silent `return` on `run.isLocked()` (parity with export/save).
- **B3 — `build-presentation-from-storyline` command** (`chatCommands.ts`, gated by `presentation` feature): rebuilds a deck from a saved consultant storyline `.md`, decoupled from the in-memory `pendingStoryline` gate (survives modal close/reload). Opens `UnifiedChatModal` with `buildStorylineNotePath` → `onOpen` **bypasses the resume picker** for the direct action → `handler.buildFromStorylineNote()` → `buildDeckFromStoryline(md, [], lang)` (empty catalog = advisory grounding) → shared `commitNewDeck`. Clears `pendingStoryline` on success (no stale-gate clobber). `.md` + `instanceof TFile` guard.
- **`storylineNote.ts`** (pure SSOT): `classifyStorylineNote(content) → {kind:'ok'|'not-storyline'|'empty'}` — fence-aware line scan; `ok` requires a slide anchor AT/AFTER a `##` heading. `isStorylineNote` wrapper. Shared by command preflight + handler.
- **`commitNewDeck`** = the one deck-commit transaction (set IR+HTML, slide 0, `pushVersion` (bumps `deckEpoch`), `lastRenderedBrandEnabled`, reliability) shared by `generateIr` + `buildFromStorylineNote`. F7 re-render is a SEPARATE seam (re-theme: no version push, slide preserved).
- Tests: `storylineNote` (6), `presentationModeHandler.{brandRerender(5),busyGuard(3),buildFromStoryline(4)}`. Persona: `persona-pres-polish-brand` (F7/F4) + `persona-build-from-storyline` (B3) — both 0 P0/P1 live on azure-claude.

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

**Plan**: [docs/completed/per-slide-polish.md](docs/completed/per-slide-polish.md) · **Audit**: [docs/completed/per-slide-polish-audit-summary.md](docs/completed/per-slide-polish-audit-summary.md)

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

**Plan**: [docs/completed/slides-side-rail-workspace.md](docs/completed/slides-side-rail-workspace.md) · **Audit**: [docs/completed/slides-side-rail-workspace-audit-summary.md](docs/completed/slides-side-rail-workspace-audit-summary.md)

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

**Plan**: [docs/plans/presentation-future-phase.md](docs/plans/presentation-future-phase.md) · **Audit**: [docs/completed/presentation-sanitizer-hardening-audit-summary.md](docs/completed/presentation-sanitizer-hardening-audit-summary.md)

## Smart Document Indexing (AI Chat)

**Status**: ✅ Implemented (March 2026)

RAG-based large attachment handling for AI Chat. When attachments exceed `MAX_ATT_CHARS`, users choose: create a project (persistent vault notes + vector index), chat temporarily (ephemeral in-memory index), or truncate (legacy behavior).

### Core Components

**AttachmentIndexService** (`src/services/chat/attachmentIndexService.ts`):
- Single-flight indexing: chunk → batch embed → cosine similarity retrieval
- `query(text, topK)`: Returns top-K relevant chunks per user message
- `isPartial` / `totalChunks` getters for partial-success tracking (some embedding batches failed)
- `dispose()`: Cleanup for ephemeral indexes on modal close
- Inline cosine similarity (no VoyVectorStore dependency — simpler for per-attachment scope)

**IndexingChoiceModal** (`src/ui/modals/IndexingChoiceModal.ts`):
- Promise-based 3-choice modal: project / temporary / truncate
- Shown when attachment exceeds `MAX_ATT_CHARS`

**FreeChatModeHandler** (`src/ui/chat/FreeChatModeHandler.ts`):
- `handleLargeAttachment()`: Orchestrates choice → indexing → project persistence
- `ProjectIndexRequest` interface + `onProjectIndexRequest` callback for cross-boundary project operations
- `notifyRerender()`: Triggers UI refresh after background rehydration
- Partial pill display: `indexingPillPartial` shows `{actual}/{total} chunks` when `isPartial`
- `isProjectActive` detection via `this.projectInstructions !== null` (type-safe)

**UnifiedChatModal** (`src/ui/modals/UnifiedChatModal.ts`):
- `handleProjectIndexRequest()`: Creates/uses project, delegates to `ProjectService.saveIndexedDocument()`
- `rehydrateIndexedDocuments()`: Re-indexes from vault notes on project load, calls `notifyRerender()`

**ProjectService** (`src/services/chat/projectService.ts`):
- `saveIndexedDocument()`: Creates vault note at `{project.folderPath}/indexed/{sanitizedFilename}.md`
- `appendIndexedDocumentManifest()`: Appends entry to `## Indexed Documents` section in `_project.md`
- Path collision handling with incrementing suffix

### Key Patterns

- **Callback pattern**: Handler → Modal delegation via `FreeChatCallbacks.onProjectIndexRequest` (handler lacks ProjectService access)
- **Partial-success tracking**: `totalChunks` vs `chunkCount` detects embedding batch failures; UI shows warning-tinted pill
- **Rehydration**: Project load reads manifest → re-reads vault notes → re-indexes → `notifyRerender()`
- **Ephemeral cleanup**: `dispose()` on modal close for temporary indexes
- **No VoyVectorStore**: Inline cosine similarity avoids WASM dependency for per-attachment scope

### Tests

- `tests/attachmentIndexService.test.ts` (19 tests): Indexing pipeline, retrieval, partial success
- `tests/indexingChoiceModal.test.ts` (8 tests): Modal choices, promise resolution

### CSS

- `.ai-organiser-free-chat-att-pill.is-indexed`: Accent left border for indexed pills
- `.ai-organiser-free-chat-att-indexed.is-partial`: Warning-tinted text for partial indexing

**Plan**: Completed (see CLAUDE.md "Free Chat & Smart Document Indexing" section)

## Important Implementation Patterns

### Modal Naming Convention
- Modal files: `[Feature]Modal.ts` in `src/ui/modals/`
- Class names: `[Feature]Modal` extending Obsidian's `Modal`

### Prompt Engineering Standards

All prompts use XML-style structure:
```
<task>What to do</task>
<requirements>Constraints and rules</requirements>
<output_format>Expected format with examples</output_format>
```

This format optimized for Claude/GPT-4 comprehension.

### Claude Adaptive Thinking

**Claude adaptive thinking** (`claudeAdapter.ts`): Opus 4.6 and Sonnet 4.6 support adaptive thinking where Claude decides when to think deeply. Controlled by `claudeThinkingMode` setting (`standard` | `adaptive`). `applyThinkingParams()` injects `thinking: { type: 'adaptive' }`, bumps `max_tokens` to 64000, removes temperature. `parseResponseContent()` skips thinking blocks; `parseStreamingChunk()` skips `thinking_delta` events.

### Tag Sanitization Pipeline

Always sanitize LLM outputs:
1. Extract tags from response (handle JSON, markdown, plain text)
2. Apply `formatTags()` to strip malformed prefixes
3. Normalize to kebab-case
4. Remove duplicates and empty strings

### Frontmatter Handling

Use Obsidian's `metadataCache` for reading, `vault.modify()` for writing:
- Parse YAML with `js-yaml` library
- Preserve non-tag frontmatter fields
- Handle edge cases: no frontmatter, malformed YAML, empty tags

### Error Handling

- Use `TagOperationResult` interface for operation outcomes
- Show user-friendly notices via `Notice` class
- **Logging**: Use `logger.debug('Tag', msg)` / `logger.warn()` / `logger.error()` from `src/utils/logger.ts` — never use `console.log` directly. Debug/warn output is suppressed unless `debugMode` is enabled; errors always log.
- New services should return `Result<T>` from `src/core/result.ts` at service boundaries
- Graceful degradation: failed operations return `{success: false, message: ...}`

### RAG Integration Patterns

**Semantic Search Enablement**:
- Always check `plugin.settings.enableSemanticSearch` before RAG operations
- Verify `plugin.vectorStore` exists before calling RAG methods
- Provide graceful fallback if RAG unavailable

**API Key Inheritance Chain**:
1. `plugin.settings.embeddingApiKey` (explicit embedding key)
2. `plugin.settings.providerSettings[provider]?.apiKey` (provider-specific key)
3. `plugin.settings.cloudApiKey` (main LLM API key)

## Testing Approach

**Automated Tests**:
```bash
npm test              # Run Vitest unit tests
npm run test:watch    # Watch mode
npm run test:coverage # With coverage report
npm run test:auto     # Run automated integration tests (no Obsidian required)
```

**Automated Integration Tests** (`tests/automated-tests.js`):
- TypeScript compilation verification
- i18n completeness (EN/ZH structure parity)
- Template syntax validation (Bases `filters:` syntax)
- Filter injection logic (folder filtering for dashboards)
- Sanitization pipeline verification
- Settings defaults validation
- Command registration checks
- Import/export consistency

**Manual Testing**:
1. Build plugin: `npm run build`
2. Copy `main.js`, `manifest.json`, `styles.css` to Obsidian plugin folder:
   - **Deploy path**: `C:\obsidian\<vault-name>\.obsidian\plugins/ai-organiser/`
3. Reload Obsidian (Ctrl/Cmd+R or restart)
4. Test with various LLM providers and features

See `docs/usertest.md` for manual testing checklist.

## Deployment Verification ⚠️ CRITICAL

**Auto-deploy (since June 2026)**: `esbuild.config.mjs` copies `main.js`/`manifest.json`/`styles.css` to BOTH the Second Brain vault plugin folder AND `C:\Users\User\OneDrive\Across Devices\mobile` after every build (`npm run dev`/`build:quick`/`build`). Each target is parent-guarded (skipped silently on machines/CI without that path) and overridable via `AIORG_DEPLOY_TARGETS` (`;`-separated dirs). The manual steps below remain a fallback / for other machines.

**Always verify deployment after building.** Stale builds in the Obsidian vault cause confusion when changes appear not to work.

### Deploy Path
```
C:\obsidian\<vault-name>\.obsidian\plugins/ai-organiser/
```

### Required Files to Deploy
After `npm run build`, copy these files to the deploy path:
- `main.js` (required)
- `manifest.json` (required)
- `styles.css` (required)

### Verification Steps
After every build, verify the deployed files are current:

```bash
# Check repo build timestamp
ls -la main.js

# Check deployed file timestamp
ls -la "<vault>/.obsidian/plugins/ai-organiser/main.js"

# Deploy if timestamps don't match
cp main.js manifest.json styles.css "<vault>/.obsidian/plugins/ai-organiser/"
```

### Common Issue: Stale Builds
If changes don't appear after Obsidian restart:
1. Compare timestamps between repo and vault
2. Check file sizes match
3. Re-deploy all three files
4. Restart Obsidian completely (not just reload)

### Quick Deploy Command
```bash
npm run build && cp main.js manifest.json styles.css "<vault>/.obsidian/plugins/ai-organiser/"
```

### Mobile Deploy Staging
The OneDrive **mobile** folder (`C:\Users\User\OneDrive\Across Devices\mobile\`) is now populated **automatically** by the post-build deploy in `esbuild.config.mjs` (see Auto-deploy above) — no manual copy needed; files sync to phone/tablet via the OneDrive app. To also stage into the gitignored `docs/mobile/` (optional, manual):
```bash
cp main.js manifest.json styles.css docs/mobile/
cp main.js manifest.json styles.css "C:/Users/User/OneDrive/Across Devices/mobile/"
```
The `docs/mobile/` folder is gitignored. The OneDrive folder (`C:\Users\User\OneDrive\Across Devices\mobile\`) syncs automatically — files appear on phone/tablet via the OneDrive app. Copy these 3 files to `<vault>/.obsidian/plugins/ai-organiser/` on each mobile device.

## Code Organization Principles

### Modular Settings UI
Each settings section is a separate class extending `BaseSettingSection`. Add new sections by creating a class in `src/ui/settings/` and instantiating in `AIOrganiserSettingTab.ts`.

### Service Adapters
New cloud providers require:
1. Create adapter in `src/services/adapters/[provider]Adapter.ts`
2. Implement `CloudServiceAdapter` interface
3. Add to `AdapterType` type and `adapters` map in `index.ts`
4. Update settings UI dropdown

### Command Pattern
Commands are isolated in `src/commands/` by category. New commands follow pattern:
```typescript
plugin.addCommand({
    id: 'unique-command-id',
    name: plugin.t.commands.commandName,
    icon: 'lucide-icon-name',
    callback: async () => { /* implementation */ }
});
```

## Critical Files for Modifications

- **Adding features**: Start with `src/main.ts` to understand plugin flow
- **Prompt changes**: Edit `src/services/prompts/` (tagPrompts, summaryPrompts, structuredPrompts)
- **UI modifications**: `src/ui/settings/AIOrganiserSettingTab.ts` and section files
- **New LLM providers**: `src/services/adapters/` and update `cloudService.ts`
- **Tag processing logic**: `src/utils/tagUtils.ts`
- **Editor insertion**: `src/utils/editorUtils.ts` (insertAtCursor, appendAsNewSections)
- **Integration prompts**: `src/services/prompts/integrationPrompts.ts`
- **RAG features**: `src/services/ragService.ts`, `src/services/vector/vectorStoreService.ts`
- **Semantic views**: `src/ui/views/RelatedNotesView.ts`
- **Bases integration**: `src/utils/frontmatterUtils.ts`, `src/services/migrationService.ts`, `src/services/dashboardService.ts`
- **Metadata handling**: `src/core/constants.ts`, `src/utils/responseParser.ts`
- **Translations**: `src/i18n/en.ts` (English-only; zh-cn retired 2026-06)
- **Logging**: `src/utils/logger.ts` — centralised Logger singleton (use `logger.debug/warn/error('Tag', msg)`)
- **Result type**: `src/core/result.ts` — `Result<T>` discriminated union for service boundaries
- **Event cleanup helper**: `src/ui/utils/domUtils.ts` — `listen()` helper for modal event listener cleanup
- **Modal conventions**: `src/ui/modals/_conventions.md` — standard lifecycle pattern for modals
- **API key resolution**: `src/services/apiKeyHelpers.ts` — `resolveSpecialistProvider()` + per-feature wrappers

## Git Remotes

This repo pushes to one remote:
- `origin` → Lbstrydom/ai-organiser (public)

Push to origin after committing:
```bash
git push origin main
```

## Version Management

Version is stored in three places (must stay in sync):
- `package.json` → `version`
- `manifest.json` → `version`
- `versions.json` → add new entry

Use `npm run version` to bump all three automatically via `version-bump.mjs`.

## ESLint (Obsidian Review Bot Compliance)

**Config**: `eslint.config.mjs` using `eslint-plugin-obsidianmd` with `recommendedWithLocalesEn` — matches the exact config the Obsidian review bot runs on PR submissions.

**Full bot rules reference**: [docs/obsidian-review-bot.md](docs/obsidian-review-bot.md)

Run `npm run lint` before submitting PRs. Key rules:
- `sentence-case` + `sentence-case-locale-module` — ALL UI strings and i18n values must be sentence case
- `no-static-styles-assignment` — use CSS classes, not `element.style.*`
- `no-tfile-tfolder-cast` — use `instanceof TFile` checks, not `as TFile`
- `prefer-file-manager-trash-file` — use `fileManager.trashFile()`, not `vault.delete()`
- `no-explicit-any` — use `unknown` + type guards (bot rejects eslint-disable for this rule)
- `no-misused-promises` / `no-floating-promises` — all promises awaited, caught, or voided
- `import/no-nodejs-modules` — use `desktopRequire()` helper (bot rejects eslint-disable)

The precommit script runs lint + full test suite: `npm run precommit`.

## Obsidian community-review compliance

The plugin is GPL-3.0 and passes the community review bot's automated scan with **zero blocking errors** (1.0.19). Invariants future changes MUST preserve:

- **`minAppVersion` is `1.11.4`** (manifest.json + versions.json) — the newest Obsidian API the code uses is `SecretStorage` (v1.11.4). The `obsidianmd/no-unsupported-api` ESLint rule is enabled (`eslint.config.mjs`) and reads `minAppVersion`; using an API newer than it is a lint error. If you adopt a newer API, bump `minAppVersion` to the version the rule reports.
- **No remote `<script>` injection.** Obsidian's bot flags `document.createElement("script")` (with or without `src`) as "dynamic script injection" — a blocking error. D3 is bundled (not CDN); the old `heic2any` CDN loader was removed. Don't reintroduce either.
- **The dead `setImmediate` `<script>` polyfill is neutralised at build time.** `jszip` (via `docx`/`pptxgenjs`) bundles an IE-era `setImmediate` polyfill that does `createElement("script")` (empty, no `src`, dead in Electron). The `neutralizeSetImmediateScriptPolyfill` esbuild plugin (`esbuild.config.mjs`) swaps it to `createElement("span")` **per-occurrence**, only at sites within 60 chars of the polyfill's `onreadystatechange` signature — so a genuine script-with-`src` loader (now or in a future dep) is left intact. Verify with `grep -c 'createElement("script")' main.js` → must be `0`. If you add a dep that legitimately creates a script element, the proximity guard protects it; don't broaden the swap.
- **Release attestation**: `.github/workflows/release.yml` builds via `npm ci` (needs `.npmrc` `legacy-peer-deps=true`) + `actions/attest-build-provenance`. Tag pushes (no `v` prefix) trigger it.
- **Disclosed, accepted warnings** (non-blocking): >5 MB bundle (single-file + local ONNX + export suite), `fs`/`child_process` (FFmpeg, desktop-gated), `eval`/`new Function` (bundled-dep polyfills), opt-in newsletter `setInterval`, transitive vuln deps (xlsx/jspdf/dompurify/@xmldom/protobufjs/ws).

## Obsidian API Quirks

Subtle Obsidian-API behaviours that the review bot and TypeScript do NOT catch. Follow these conventions to avoid regressions.

### `ButtonComponent.setIcon()` clobbers button text

Both `setIcon(name)` and `setButtonText(text)` overwrite the button's inner DOM — the one called LAST wins. Chaining `.setButtonText('Import file').setIcon('file-up')` produces an icon-only button with no visible label.

**Convention: call `setIcon()` BEFORE `setButtonText()`.** Text wins and is visible; the icon is lost, but text is the critical discoverability signal — an icon-only button is useless for first-time users who can't hover to see a tooltip.

```typescript
// ❌ Wrong — renders icon-only, empty label
new ButtonComponent(el)
    .setButtonText(t.importFile)
    .setIcon('file-up')
    .setCta();

// ✅ Right — text visible, icon sacrificed
new ButtonComponent(el)
    .setIcon('file-up')
    .setButtonText(t.importFile)
    .setCta();
```

If you genuinely need an icon + text in one button, skip the chain and build the DOM:
```typescript
const btn = new ButtonComponent(el).setButtonText(text);
const iconEl = btn.buttonEl.createSpan();
setIcon(iconEl, 'file-up');
btn.buttonEl.prepend(iconEl);
```

Caught via persona round 5: Kindle Sync modal rendered two empty-label buttons ("" + "" instead of "Import file" + "Sync from amazon"). Six buttons across four files were affected (KindleSyncModal, KindleLoginModal, SemanticSearchSettingsSection, BasesSettingsSection).

## Large-Content Ingestion — Quality-Aware Chunking

**Status**: ✅ Implemented (April 2026)

**Plan**: [docs/completed/large-content-ingestion.md](docs/completed/large-content-ingestion.md)

Replaces scattered `isContentTooLarge` checks + flat map-reduce summarization with a quality-aware chunking pipeline. Fixes the "2-hour meeting crashes" user report by bumping `CHUNK_TOKEN_LIMIT` from 6000 → 12000 (halves call count for long meetings) and introducing hierarchical map-reduce for non-minutes content.

### Key components

| File | Purpose |
|---|---|
| [src/services/contentSizePolicy.ts](src/services/contentSizePolicy.ts) | Single source of truth for quality thresholds (40K/48K/192K chars per content type) + fast-model capability check + `estimateCharsPerToken()` heuristic (Latin/CJK/code) |
| [src/services/chunkingOrchestrator.ts](src/services/chunkingOrchestrator.ts) | Generalised hierarchical map-reduce with rolling `continuationContext` between chunks + per-chunk error isolation (no `[Error summarizing section N]` markers in output) |
| [src/core/constants.ts:64](src/core/constants.ts#L64) | `CHUNK_TOKEN_LIMIT = 12_000` (bumped from 6000) |
| [src/services/minutesService.ts:111-125](src/services/minutesService.ts) | `EXTRACTION_OPTIONS.maxTokens = 8192` (up from 4096); `MERGE_OPTIONS.maxTokens = 12288` (up from 4096); `overlapChars = 1000` (up from 500) |
| [src/commands/summarizeCommands.ts:1615,1676,2094](src/commands/summarizeCommands.ts) | Quality-threshold auto-chunking: URL / text / audio transcripts above ~40K chars auto-route to `summarizeInChunks` instead of one-shot |

### Chunking strategy by content type

| ContentType | Auto-chunk above | Hierarchical reduce above |
|-------------|-----------------|--------------------------|
| `summarization` | 40 000 chars | 120 000 chars (4+ chunks) |
| `minutes` | 48 000 chars | 192 000 chars (4+ chunks) |
| `document` | 40 000 chars | 120 000 chars |

### Fast-model routing

When `useHaikuForFastTasks = true` AND provider is `claude`, map-phase calls use `latest-haiku` (cheap + fast); reduce-phase uses the main model. Non-Claude providers fall back to main model for both phases (graceful degradation).

### Tests

- `tests/contentSizePolicy.test.ts` — 21 tests (assessment, threshold resolution, fast-model gating, char-per-token heuristics)
- `tests/chunkingOrchestrator.test.ts` — 10 tests (map/reduce flow, continuation context, per-chunk error isolation, hierarchical batching, single-chunk short-circuit)

## ProgressReporter — Universal Progress Indicator

**Status**: ✅ Infrastructure + hot-list migration delivered (April 2026)

**Plan**: [docs/completed/progress-reporter.md](docs/completed/progress-reporter.md)

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
| Smart note — diagram + improve | [smartNoteCommands.ts:230](src/commands/smartNoteCommands.ts) | `withProgress<Phase>` with phase transitions |
| Newsletter — fetch + audio regen | [newsletterCommands.ts:43](src/commands/newsletterCommands.ts) | `withProgress` with per-item `triaging` phase |
| Multi-source summarize | [summarizeCommands.ts:449](src/commands/summarizeCommands.ts) | Persistent Notice + `setMessage` + `hideProgress()` on all exits |
| Multi-source translate (+ `translateNote`/`translateSelection`) | [translateCommands.ts](src/commands/translateCommands.ts) | **`withProgress` raw-phase** (waiting-state-ux Cluster B, June 2026) — shared elapsed ticker + status-bar broker + heartbeat; reporter spans the full op incl. assembly |
| Integration — resolve + merge | [integrationCommands.ts](src/commands/integrationCommands.ts) | **`withProgress` raw-phase** (waiting-state-ux Cluster B, June 2026) — replaced ad-hoc Notice + `showBusy`/`hideBusy`; inner catch `dispose()`s (not `fail()`) to avoid double-toast |
| YouTube summarize (pre-existing) | [summarizeCommands.ts:2277](src/commands/summarizeCommands.ts) | Ad-hoc persistent Notice (fixed April 2026) |

### Intentionally deferred (plan §11 Out of Scope)

- Kindle sync — already has modal-internal progress callback
- Presentation builder — already uses `GenerationProgressController` with phases
- Flashcards / canvas / generate / digitisation — already using correct ad-hoc pattern; cosmetic consolidation deferred to avoid regression risk
- `ChatModeHandler`/`FreeChatModeHandler` — modal-internal progress already good
- `embedScanCommands` custom progress-bar DOM — battle-tested
- Per-flow `ProgressPhase` unions — defined inline at each call site

### Waiting-state UX — shared elapsed indicator (✅ Complete, June 2026)

One visual language for long LLM waits. Cluster A extracted the SSOT `formatElapsed` ([elapsed.ts](src/services/progress/elapsed.ts)) + shared indicator ([progressIndicatorDom.ts](src/services/progress/progressIndicatorDom.ts)), rewired the chat thinking indicator onto it, renamed CSS to `.ai-organiser-progress-*`, and added the elapsed ticker to `ProgressReporter`'s Notice surface. **Cluster B** migrated the last ad-hoc progress notices (translate ×3 + integration resolve/merge) onto `withProgress` (see the two table rows above), dropping the nested `withBusyIndicator` in the LLM helpers (status-bar overlap rule — the broker owns one ticket). Code-audited (GPT + Gemini APPROVE) + live persona-verified (8/8: elapsed appears/ticks/clears, single status-bar ticket). Plan: [docs/completed/waiting-state-ux.md](docs/completed/waiting-state-ux.md).

### Tests

- `tests/progressReporter.test.ts` — 21 tests (state machine, surfaces, terminals, normalizeError)
- `tests/withProgress.test.ts` — 17 tests (Result contract, cancel sentinel, toast ownership)
- `tests/transcriptSanitizer.test.ts` — 8 tests (paste sanitizer for Minutes)

### Transcript paste sanitizer (April 2026 hotfix)

User pasted Office 365 HTML into Minutes transcript field → hundreds of `file:///…/msohtmlclip1/…/clip_imageXXX.gif` references survived to LLM output note → Obsidian CSP blocked each one → UI freeze. Fix: [src/utils/transcriptSanitizer.ts](src/utils/transcriptSanitizer.ts) strips file:// refs + markdown image syntax + bare clip_imageNNN tokens on paste (input) AND in `renderMinutesFromJson` output (belt-and-braces).

## Known Constraints

- Obsidian API externals must match platform version (defined in `esbuild.config.mjs`)
- TypeScript compilation is strict mode with ES2020 target
- D3.js is **bundled** as submodules (`d3-selection`/`d3-force`/`d3-drag`/`d3-zoom`) for the tag-network view — **never** CDN-loaded. Obsidian's review bot blocks remote `<script>` injection; do NOT reintroduce a CDN `<script>` loader (or a `heic2any`-style runtime script fetch). See "Obsidian community-review compliance".
- Interface language change requires Obsidian restart (output languages do not)
- Tag formatting preserves `/` for nested tags but converts other special chars to hyphens
- Claude/Anthropic has no embeddings API (use Voyage AI instead)
- URL detection may include trailing punctuation (e.g., `https://example.com.` includes the period) - documented limitation in tests

## CSS Conventions

- Use `ai-organiser-*` prefix for all CSS classes
- Modal styles in `styles.css`
- Settings section styles follow Obsidian conventions

## Mobile Considerations

Use `Platform.isMobile` from Obsidian API to detect mobile environment:

```typescript
import { Platform } from 'obsidian';

if (Platform.isMobile) {
    // Mobile-specific behavior
}
```

Key mobile constraints:
- `localhost` URLs fail (points to phone, not desktop)
- Limited RAM (~2-6GB shared)
- Vault-only file access (no external files)
- Touch interaction (sidebars are awkward)
- Battery drain from background operations

Mobile settings section in plugin settings provides:
- Tri-state provider mode (auto/cloud-only/custom)
- Fallback provider selection
- Index size limits and read-only mode
- Custom endpoint for home servers

## UI/UX Design Principles

Apply consistently across all UI: settings, modals, sidebars, command palettes.

### Gestalt Principles

- **Proximity**: Group related items (settings under parent features, commands by workflow)
- **Similarity**: Consistent styling (icons, headers, spacing) for similar elements
- **Common Region**: Visual containers (header levels, borders) to group related items
- **Continuity**: Logical flow - setup → core → advanced → preferences

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

### Async Rendering

Await async `display()` methods to maintain order:
```typescript
await this.summarizationSection.display();  // Correct
```

### Modal UX

- **Dependency-first:** Documents → Dictionary → Audio (extract terms before transcription)
- **Inline controls:** Place actions next to affected items (Gestalt proximity)
- **Progressive disclosure:** Collapse advanced options

## Obsidian Bases Integration

**Status**: ✅ Fully Implemented (January 2025)

See [docs/bases_integration.md](docs/bases_integration.md) for complete implementation details and [docs/bases_user_guide.md](docs/bases_user_guide.md) for user documentation.

### Overview

The Bases integration enables structured metadata and dashboard generation for seamless integration with the Obsidian Bases plugin. This allows users to:
- Auto-populate 10 metadata properties during AI operations
- Migrate existing notes to the new metadata format
- Generate dashboard views with 5 built-in templates
- Query and organize notes using Bases' powerful filtering system

### Core Components

**Metadata Namespace** ([src/core/constants.ts](src/core/constants.ts))
- `AIO_META` object: Simple, user-friendly property names (no prefix)
- Core properties: `summary`, `source_url` (minimal set used by default)
- Additional properties available: `status`, `type`, `processed`, `model`, `source`, `word_count`, `language`, `persona`
- Type definitions: `ContentType`, `StatusValue`, `SourceType` enums
- `SUMMARY_HOOK_MAX_LENGTH = 280` (optimized for Bases preview pane)

**Frontmatter Utilities** ([src/utils/frontmatterUtils.ts](src/utils/frontmatterUtils.ts))
- `updateAIOMetadata(app, file, metadata)`: CRUD operations preserving existing frontmatter
- `getAIOMetadata(app, file)`: Read all AI Organiser metadata properties
- `createSummaryHook(summary)`: Truncate to 280 chars at sentence boundaries
- `isAIOProcessed(app, file)`: Check processing status
- `countWords(content)` and `detectLanguage(content)`: Auto-population helpers

**Structured Prompts** ([src/services/prompts/structuredPrompts.ts](src/services/prompts/structuredPrompts.ts))
- `StructuredSummaryResponse` interface: 5 fields (summary_hook, body_content, suggested_tags, content_type, detected_language)
- `buildStructuredSummaryPrompt(options)`: XML-style prompt requesting JSON output
- `insertContentIntoStructuredPrompt(prompt, content)`: Template function

**Response Parser** ([src/utils/responseParser.ts](src/utils/responseParser.ts))
- 4-tier fallback JSON parsing:
  1. Direct `JSON.parse()` of response
  2. Extract from markdown code fence (```json ... ```)
  3. Search for JSON object in text ({...})
  4. Create fallback from plain text (keyword detection)
- `createFallbackResponse(text)`: Infers type from keywords, extracts #tags, uses first sentences
- `sanitizeSummaryHook(hook)`: Validates 280-char limit

### Migration System

**Migration Service** ([src/services/migrationService.ts](src/services/migrationService.ts))
- `analyzeMigrationScope(folder?)`: Counts `needsMigration` vs `alreadyMigrated`
- `migrateNote(file, options)`: Extracts summaries from `##Summary`/`##TL;DR`/first paragraph
- `determineStatus()`: Checks for existing tags (processed vs pending)
- `detectContentType()`: Analyzes keywords (research/meeting/project/reference)
- `migrateFolder()` and `migrateVault()`: Batch operations with progress callbacks
- `extractSummaryFromContent()`: Regex patterns for section extraction
- `getMarkdownFilesInFolder()`: Recursive traversal

**Migration Modal** ([src/ui/modals/MigrationModal.ts](src/ui/modals/MigrationModal.ts))
- 4-stage UI workflow:
  1. **Analysis**: Display stats (total/needsMigration/alreadyMigrated)
  2. **Options**: Toggle `overwriteExisting`, `extractSummary`
  3. **Progress**: Live progress bar with updates
  4. **Results**: Summary with error details
- Each stage has dedicated `renderStage()` method with proper cleanup

**Commands** ([src/commands/migrationCommands.ts](src/commands/migrationCommands.ts))
- `upgrade-metadata`: Opens MigrationModal for entire vault
- `upgrade-folder-metadata`: Opens MigrationModal scoped to current folder

### Dashboard Generation

**Templates** ([src/services/configurationService.ts](src/services/configurationService.ts))
- Single "Notes Dashboard" template for simplicity
- YAML structure with `filters:` (plural), `columns:`, optional `sorting:`
- Folder filtering automatically applied via `file.inFolder()` function

**Dashboard Service** ([src/services/dashboardService.ts](src/services/dashboardService.ts))
- `createDashboard(options)`: Create `.base` file from template with folder filtering
- `injectFolderFilter(content, folderPath)`: Automatically adds `file.inFolder("path")` filter
- `getRecommendedDashboardFolder()`: Searches for 'Dashboards'/'Views'/'Bases'
- Folder filter includes all subfolders recursively
- Uses `filters:` (plural) syntax as required by Obsidian Bases

**Dashboard Modal** ([src/ui/modals/DashboardCreationModal.ts](src/ui/modals/DashboardCreationModal.ts))
- Simple confirmation dialog (not template picker)
- Shows target folder path with change option
- Single "Create Dashboard" action
- Dashboard automatically scoped to selected folder

**Commands** ([src/commands/dashboardCommands.ts](src/commands/dashboardCommands.ts))
- `create-bases-dashboard`: Opens DashboardCreationModal

### Settings Integration

**Bases Settings Section** ([src/ui/settings/BasesSettingsSection.ts](src/ui/settings/BasesSettingsSection.ts))
- 3 toggle settings:
  - `enableStructuredMetadata`: Enable Bases integration (default: true)
  - `includeModelInMetadata`: Add `model` property (default: true)
  - `autoDetectContentType`: Auto-detect content type from keywords (default: true)
- Info box with usage guidance (3 bullet points)
- Migration action button (icon: database): Calls `upgrade-metadata` command
- Dashboard creation via right-click folder context menu

### Summarization Integration

**Conditional Structured Output** ([src/commands/summarizeCommands.ts](src/commands/summarizeCommands.ts))
- `updateNoteMetadataAfterSummary()` function:
  - Checks `enableStructuredMetadata` setting
  - Builds minimal metadata: `summary` (hook) and `source_url` (if available)
  - Calls `updateAIOMetadata()` to write frontmatter

- `summarizeAndInsert()` modified:
  - **If `enableStructuredMetadata`**:
    - Use `buildStructuredSummaryPrompt()`
    - Parse JSON response with `parseStructuredResponse()`
    - Extract `body_content`, `summary_hook`, `suggested_tags`, `content_type`
    - Insert body content into note
    - Update metadata with `updateNoteMetadataAfterSummary()`
  - **Else**: Use traditional `buildSummaryPrompt()` (backward compatibility)

**Unified Workflow Functions** (DRY/SOLID pattern):
- `transcribeAudioWithFullWorkflow()` in `src/services/audioTranscriptionService.ts`:
  - Handles all audio paths: chunked (>20 min), compressed (>25MB), direct
  - Used by both multi-source and standalone audio handlers
  - Progress callback for UI updates
- `summarizePdfWithFullWorkflow()` in `src/commands/summarizeCommands.ts`:
  - Handles both vault and external PDFs
  - Uses `getFirstLinkpathDest()` for wiki-link resolution
  - Used by both multi-source and standalone PDF handlers

### Key Implementation Patterns

**Simple Property Names**: Metadata uses clean, user-friendly names (`summary`, `source_url`) for better readability

**Minimal Metadata**: Only essential fields stored by default (summary hook and source URL)

**280-Char Summaries**: Optimized for Bases preview pane, truncates at sentence boundaries

**Graceful Degradation**: Works without Bases plugin (metadata still useful for Dataview, search)

**Type Safety**: `ContentType`, `StatusValue`, `SourceType` enums in constants.ts

**i18n**: English-only (`en.ts`) — zh-cn locale retired 2026-06 (i18n system retained)

**4-Tier JSON Parsing**: Handles various LLM response formats gracefully

**Backward Compatibility**: Structured output controlled by settings toggle, preserves existing summarization behavior when disabled

### Integration Points

**Tag Generation**: Suggested tags from structured responses automatically added to frontmatter

**Semantic Search**: Content type filters improve RAG context retrieval

**Smart Summarization**: Auto-detects source type based on input (URL → 'url', PDF → 'pdf', YouTube → 'youtube')

**Batch Operations**: Migration service supports folder and vault-wide operations with progress tracking

## Audio Recording

**Status**: ✅ Implemented (January 2026)

In-plugin audio recording using MediaRecorder API. Works on desktop and mobile (iOS/Android).

**Core Components**:
- `src/services/audioRecordingService.ts`: MediaRecorder wrapper, mime negotiation (`audio/mp4` → `audio/webm;codecs=opus` → fallbacks), actual chunk size tracking via 1-second timeslice, 64kbps bitrate
- `src/ui/modals/AudioRecorderModal.ts`: Recording modal with states (idle → recording → stopped → saving → transcribing → done), platform-aware transcription, close safety

**Post-Transcription Cleanup** (`src/services/audioCleanupService.ts`):
- `offerPostTranscriptionCleanup(plugin, options)`: Shared utility for all audio transcription paths
- 3-option modal: keep original / replace with compressed / delete audio
- Respects `postRecordingStorage` policy (`'ask' | 'keep-original' | 'keep-compressed' | 'delete'`)
- Checks >10% savings threshold before offering compression
- Wired into: standalone summarize, multi-source summarize, multi-source translate, minutes transcription

**Integration Points**:
- Standalone `record-audio` command in Command Picker Capture category
- Minutes modal: Record button rendered OUTSIDE `!Platform.isMobile` gate
- Multi-Source modal: Record button in BOTH render paths via shared helper (survives rerenders)
- Settings: `autoTranscribeRecordings`, `embedAudioInNote` in Audio Transcription section
- Recordings saved to `AI-Organiser/Recordings/`

**Mobile Safeguards**: Feature detection, mime negotiation with fallback, actual size tracking (not estimate), direct `transcribeAudio()` (no FFmpeg), 64kbps bitrate (~52 min under 25MB), close safety (auto-save).

## Canvas Toolkit

**Status**: ✅ Implemented (January 2026)

### Overview

Three commands that create Obsidian `.canvas` JSON files from note context, RAG results, and tag clusters. Desktop only (gated by `Platform.isMobile`).

### Canvas Types (`src/services/canvas/types.ts`)

- `CanvasNode`, `CanvasEdge`, `CanvasData`: Mirror Obsidian `.canvas` JSON spec
- `NodeDescriptor`, `EdgeDescriptor`, `ClusterDescriptor`: Internal pre-layout descriptors
- `CanvasResult`: Operation result with optional `errorCode: CanvasErrorCode`
- `CanvasErrorCode`: `'no-related-notes' | 'no-sources-detected' | 'no-notes-with-tag' | 'creation-failed'`

### Layout Algorithms (`src/services/canvas/layouts.ts`)

Pure math functions — no Obsidian imports, fully testable:
- `radialLayout(count, centerIdx)`: Center node at (0,0), satellites at equal angles
- `gridLayout(count)`: `cols = ceil(sqrt(N))` grid arrangement
- `adaptiveLayout(count, centerIdx?)`: ≤12 nodes → radial, >12 → grid
- `clusteredLayout(clusters)`: Groups in horizontal row, each with internal grid
- `computeEdgeSides(from, to)`: Determines left/right/top/bottom based on dx vs dy

### Canvas Utilities (`src/services/canvas/canvasUtils.ts`)

- `generateId()`: 16-char lowercase hex via `crypto.getRandomValues` (matches Obsidian's native convention); falls back to base36 timestamp+random if Web Crypto unavailable
- `buildCanvasNode()`, `buildCanvasEdge()`: Construct canvas JSON objects
- `writeCanvasFile()`: Create `.canvas` file with folder creation and auto-increment naming
- `sanitizeCanvasName()`: Strip invalid characters (`/ \ : * ? " < > |`)
- Safety cap: `getAvailableCanvasPath` tries up to 999 increments

### Three Board Types

**Investigation Board** (`src/services/canvas/investigationBoard.ts`):
- Uses RAG to find related notes → radial/grid layout with center note
- Optional LLM edge labels (single batch call via `buildEdgeLabelPrompt`)
- Score-based fallback labels: "Closely related" (≥0.8), "Related" (≥0.6), "Loosely related"
- Requires semantic search enabled

**Context Board** (`src/services/canvas/contextBoard.ts`):
- Detects embedded content (YouTube, PDF, links, audio, documents) via `embeddedContentDetector`
- No LLM call — purely structural visualization
- Works without semantic search
- Color-coded nodes by type (YouTube=purple, PDF=green, web=yellow, etc.)

**Cluster Board** (`src/services/canvas/clusterBoard.ts`):
- Groups notes by tag using LLM clustering or deterministic fallback
- Deterministic algorithm: folder grouping → subtag grouping → chunk-based (size 6)
- `computeMaxNotes()`: Token budget calculation for LLM prompt
- `parseClusterResponse()`: 3-tier JSON parsing via shared `tryExtractJson`
- TagPickerModal (`src/ui/modals/TagPickerModal.ts`) for tag selection

### Prompts (`src/services/prompts/canvasPrompts.ts`)

- `buildEdgeLabelPrompt(pairs, language)`: 1-4 word relationship labels with language support
- `buildClusterPrompt(tag, notes, language)`: Group notes into meaningful clusters

### Settings (`src/core/settings.ts`)

| Setting | Default | Description |
|---------|---------|-------------|
| `canvasOutputFolder` | `'Canvas'` | Subfolder under plugin folder |
| `canvasOpenAfterCreate` | `true` | Open canvas file after creation |
| `canvasEnableEdgeLabels` | `true` | Use LLM for Investigation Board edge labels |
| `canvasUseLLMClustering` | `true` | Use LLM for Cluster Board grouping |

Settings UI: `src/ui/settings/CanvasSettingsSection.ts` (4 toggles, placed after Semantic Search)

### Commands (`src/commands/canvasCommands.ts`)

- `build-investigation-canvas`: Investigation Board (requires semantic search)
- `build-context-canvas`: Context Board (works without semantic search)
- `build-cluster-canvas`: Cluster Board with TagPickerModal

Investigation and Context boards are in Command Picker → Active Note → Note Maps. Cluster Board is in Command Picker → Vault Intelligence → Vault Visualizations.

### Shared Utilities (DRY)

- `tryExtractJson()` in `responseParser.ts`: 3-tier JSON extraction (direct → code fence → object search)
- `extractTagsFromCache()` in `tagUtils.ts`: Shared tag extraction from metadata cache
- Error codes on `CanvasResult` replace string matching in command handlers

### Testing

- `tests/canvasLayouts.test.ts`: 15 tests (radial, grid, clustered, edge sides, edge cases)
- `tests/canvasUtils.test.ts`: 17 tests (sanitize, node/edge building, write paths, ID format, fallback)
- `tests/canvasPrompts.test.ts`: 8 tests (language, structure, empty arrays)
- `tests/investigationBoard.test.ts`: 8 tests (JSON parsing, fallback labels, boundaries)
- `tests/clusterBoard.test.ts`: 10 tests (folder/subtag grouping, token budget, parsing)
- `tests/responseParser.test.ts`: 60 tests (includes 14 for generic JSON extraction)

---

## File Format Conventions

This plugin generates `.canvas`, `.base`, and `.md` files. All implementations align with official Obsidian conventions. See [docs/format-specs.md](docs/format-specs.md) for the full audited compliance checklist.

### Authoritative Specs

- **JSON Canvas 1.0**: https://jsoncanvas.org/spec/1.0/
- **Obsidian Agent Skills** (kepano): https://github.com/kepano/obsidian-skills
- **Agent Skills Spec**: https://agentskills.io/specification

### For AI Agents

Install the official Obsidian Agent Skills for format reference when working with Obsidian vault files:
```
/plugin marketplace add kepano/obsidian-skills
```

### Key Convention Rules

- **Canvas IDs**: 16-char lowercase hex via `crypto.getRandomValues` with base36 fallback (see `canvasUtils.ts`)
- **Canvas colors**: Preset strings `'1'`-`'6'`, never hex colors
- **Canvas spacing**: `NODE_GAP` 60px (spec range 50-100), `GROUP_PADDING` 40px (spec range 20-50)
- **Bases filters**: Always use `filters:` (plural), `file.inFolder()`, `and:`/`or:` operators
- **Markdown**: Standard Obsidian Flavored Markdown (OFM) syntax only

---

## Meeting Minutes Generation

**Status**: ✅ Implemented (January 2026)

### Overview

Generate structured meeting minutes from transcripts with persona-based output styles, GTD action classification overlay, terminology dictionaries for transcription accuracy, and context document support.

### Personas (2 built-in)

| ID | Name | Icon | Description |
|----|------|------|-------------|
| `standard` | Standard | `file-text` | Concise, action-oriented minutes (default) |
| `governance` | Governance | `landmark` | Formal governance minutes with resolutions and fiduciary matters |

Personas stored in `AI-Organiser/Config/minutes-personas.md`. Users can add custom personas following the same `### Name [icon: icon-name]` format.

### GTD Overlay

Optional GTD (Getting Things Done) action classification. When enabled (`minutesGTDOverlay` setting or per-session toggle in modal):
- **Next Actions**: Classified by context (`@office`, `@home`, `@call`, `@computer`, `@agenda`, `@errand`) with energy tags (`low`/`high` — `medium` omitted)
- **Waiting For**: Items with `waiting_on` person and optional `chase_date`
- **Projects**: Multi-step commitments (names only)
- **Someday/Maybe**: Ideas not yet committed to

GTD schema injected conditionally via `getStyleSystemPrompt({ useGTD: true })`. Chunk extraction excluded from GTD.

**GTD interfaces** in `minutesPrompts.ts`: `GTDAction`, `GTDWaitingItem`, `GTDProcessing`, `MinutesJSON.gtd_processing?`

**GTD rendering** in `minutesUtils.ts`: `renderMinutesFromJson(json, style, obsidianTasksFormat?)` — context keys sorted alphabetically, `- [ ]` checkboxes when obsidianTasksFormat is true.

### Core Components

**Minutes Service** (`src/services/minutesService.ts`):
- `generateMinutes()`: Main generation function with transcript chunking
- `MinutesGenerationInput` includes `useGTD?: boolean`
- Supports long transcripts via 5000-token chunked processing
- Context chaining between chunks for coherent output
- Passes `ChunkExtractionContext` (chunkIndex, totalChunks, participants) to chunk extraction prompts
- Passes `IntermediateMergeContext` (chunkCount, participants) to intermediate merge prompts
- Accepts `dictionaryContent` and `contextDocuments` for enhanced accuracy

**Dictionary Service** (`src/services/dictionaryService.ts`):
- CRUD operations for terminology dictionaries stored as markdown
- `addEntries()`: Merge with case-insensitive deduplication
- `formatForPrompt()`: Format dictionary as XML for LLM injection
- `buildExtractionPrompt()`: Extract terms from context documents
- Storage: `AI-Organiser/Config/dictionaries/` (syncs across devices)
- Entry categories: person, acronym, term, project, organization

**Minutes Prompts** (`src/services/prompts/minutesPrompts.ts`):
- `getStyleSystemPrompt(options: MinutesStylePromptOptions)`: Style-specific system prompt with `{ style, outputLanguage, personaInstructions, useGTD? }`
- `buildChunkExtractionPrompt(context: ChunkExtractionContext)`: Chunk-aware extraction with participant list and position label
- `buildIntermediateMergePrompt(context: IntermediateMergeContext)`: Merge prompt with `deferred_items` for irreconcilable conflicts
- `buildStyleConsolidationPrompt(options)`: Style-aware consolidation for chunked processing
- Conditional GTD schema injection and self-check item #9
- Dictionary injection for name/term consistency

**Minutes DOCX Export** (`src/services/export/minutesDocxGenerator.ts`):
- `generateMinutesDocx(json)`: Generates Word document from `MinutesJSON` using `docx` library
- `extractMinutesJsonFromNote(content)`: Parses `<!-- minutes-json: ... -->` HTML comment from note
- Structured sections: header, metadata table, agenda, discussion items, action items, decisions, GTD
- Desktop: system Save dialog via Electron; Mobile: vault file fallback

**Minutes Modal** (`src/ui/modals/MinutesCreationModal.ts`):
- Meeting input form: title, date, time, participants, agenda, transcript
- Context Documents section: attach agendas, presentations, spreadsheets
- Dictionary section: select, create, edit, or extract terminology
- Audio Transcription section: transcribe embedded audio files
- UX flow: Documents → Dictionary → Audio (dependency-first ordering)
- Persona selector, GTD toggle, dual output toggle, Obsidian Tasks toggle

**Minutes Settings** (`src/ui/settings/MinutesSettingsSection.ts`):
- Output folder, default timezone, default persona, Obsidian Tasks format, GTD overlay default

**Text Chunker** (`src/utils/textChunker.ts`):
- `chunkText()`: Split long transcripts by token count with sentence boundaries
- `chunkPlainTextAsync()`: Paragraph → sentence → word boundary lookback splitting (no mid-word cuts)

### Key Patterns

- **Transcript Chunking**: Long meetings split into manageable chunks
- **Context Chaining**: Each chunk receives previous summary for continuity
- **Persona System**: 2 built-in personas (`standard`, `governance`) + custom via config file
- **GTD Overlay**: Optional action classification by GTD context, renders as separate sections
- **Obsidian Tasks + GTD**: When both enabled, GTD next-actions render as `- [ ]` checkboxes
- **Options Object Pattern**: `MinutesSystemPromptOptions` for extensible prompt configuration
- **Dictionary-First Workflow**: Extract terms from documents before transcription
- **Cross-Meeting Reuse**: Same dictionary works across multiple meetings
- **Document Truncation**: Inline controls for oversized documents with configurable settings

## Document Extraction System

**Status**: ✅ Implemented (January 2026)

### Overview

Centralized document detection and extraction supporting Office documents (docx, xlsx, pptx), text formats (txt, rtf), and PDFs across Minutes, Multi-Source Summarization, and NotebookLM features.

### Core Components

**Constants** (`src/core/constants.ts`):
- `EXTRACTABLE_DOCUMENT_EXTENSIONS`: ['docx', 'xlsx', 'pptx', 'txt', 'rtf']
- `ALL_DOCUMENT_EXTENSIONS`: ['pdf', ...EXTRACTABLE_DOCUMENT_EXTENSIONS]
- `DOCUMENT_EXTENSIONS_WITH_DOTS`: For file detection with dots

**Document Extraction Service** (`src/services/documentExtractionService.ts`):
- `extractText(file)`: Extract from vault files (uses officeparser for Office formats)
- `extractFromUrl(url, onProgress?)`: Download and extract from external URLs (HTTPS only)
- `canExtract(file)`: Check if file type is supported
- RTF parsing with hex/unicode decode and readability validation
- TXT direct read support

**Content Extraction Service** (`src/services/contentExtractionService.ts`):
- `extractDocumentContent(item)`: Unified extraction for vault and external documents
- Handles `isExternal` flag for URL-based documents
- Returns `ExtractedContent` with success/error status

**Embedded Content Detector** (`src/utils/embeddedContentDetector.ts`):
- `detectEmbeddedContent()`: Detect documents in note content
- `classifyUrl()`: Classify external URLs including document URLs
- `getExtractableContent()`: Filter for extractable items including documents

### Feature Integration

**Minutes** (`src/ui/modals/MinutesCreationModal.ts`):
- Context Documents section with inline truncation controls
- Settings: `maxDocumentChars`, `oversizedDocumentBehavior`
- Bulk "Apply to all" for multiple oversized documents

**Multi-Source** (`src/ui/modals/MultiSourceModal.ts`):
- Documents section between PDFs and Audio
- Detection from note content and manual input
- Settings: `multiSourceMaxDocumentChars`, `multiSourceOversizedBehavior`

**NotebookLM** (`src/services/notebooklm/sourcePackService.ts`):
- `detectLinkedDocuments()`: Find linked documents in selected notes
- Display in export preview modal

**Pending Integration** (`src/commands/integrationCommands.ts`):
- "Resolve pending embeds" command extracts text from embedded docs
- Replaces embed syntax with extracted content for review

### SOLID/DRY Patterns

**Centralized Constants** (`src/core/constants.ts`):
- `DEFAULT_MAX_DOCUMENT_CHARS = 50000`: Minutes document limit
- `DEFAULT_MULTI_SOURCE_MAX_DOCUMENT_CHARS = 100000`: Multi-source limit
- `TruncationChoice`: Type alias for 'truncate' | 'full' | 'skip'
- `OversizedBehavior`: Type alias for 'ask' | 'truncate' | 'full'

**Unified UI Text** (`src/ui/modals/MinutesCreationModal.ts`):
- `getTruncationOptions(t)`: Single source for truncation labels/tooltips
- Returns `Record<TruncationChoice, {label, tooltip}>` for DRY dropdown rendering

**Dependency Injection** (`src/ui/modals/MinutesCreationModal.ts`):
- `MinutesModalDependencies` interface for optional service injection
- Services: `minutesService`, `dictionaryService`, `documentService`
- Supports testability without modifying production code

**Key Patterns**:
- **DRY Extensions**: All extension checks use constants from `constants.ts`
- **DRY Limits**: Use `DEFAULT_MAX_DOCUMENT_CHARS` / `DEFAULT_MULTI_SOURCE_MAX_DOCUMENT_CHARS`
- **DRY UI Text**: Truncation labels/tooltips via `getTruncationOptions()` helper
- **DIP**: Modal services injectable via `MinutesModalDependencies` interface
- **HTTPS Only**: External URLs must use HTTPS (security requirement)
- **Inline Truncation**: Gestalt proximity - controls next to affected documents
- **Graceful Errors**: RTF validation catches complex formatting, shows user-friendly message

## Controller Architecture (MinutesCreationModal)

**Status**: Implemented (January 2026)

The MinutesCreationModal uses a controller-based architecture to separate concerns and improve testability.

### Controllers

**Location**: `src/ui/controllers/`

| Controller | Responsibility | Tests |
|------------|----------------|-------|
| `DocumentHandlingController` | Document detection, extraction, caching, truncation | 23 |
| `DictionaryController` | Dictionary CRUD, term extraction, merging | 56 |
| `AudioController` | Audio detection and transcription state | 35 |

**Shared Components**: `src/ui/components/TruncationControls.ts` (8 tests)

### Controller Lifecycle

Controllers instantiated per modal open for fresh state:

```typescript
onOpen() {
    this.docController = new DocumentHandlingController(app, plugin, documentService, embeddedDetector);
    this.dictController = new DictionaryController(dictionaryService);
    this.audioController = new AudioController(app); // App only (ISP)
}
```

### No-Stubs Policy

**Critical**: All new code must follow the no-stubs policy:

- **No placeholder methods**: If a method isn't used by modal or tests, remove it
- **Public methods must have call sites**: Modal, other UI, or tests
- **Private helpers allowed**: If used by public methods
- **Errors returned, not thrown**: Use `errors: string[]` on result objects

### Key Patterns

- **Immutable external interface**: All getters return shallow copies
- **ID-based tracking**: File paths for vault items, normalized URLs for external
- **Result objects**: `DocumentHandlingResult`, `DictionaryResult<T>`, `AudioResult<T>` with `errors: string[]`
- **Callback-based UI**: TruncationControls uses callbacks (IoC), no modal dependencies
- **Type-safe translations**: `TruncationTranslations` interface

### Testing

**Service Tests**:
- `tests/minutesService.test.ts` (23 tests): Chunked/non-chunked generation, language fallback
- `tests/ragService.test.ts` (19 tests): Context retrieval, RAG prompt building

**Export Tests**:
- `tests/minutesDocxGenerator.test.ts` (14 tests): DOCX generation, JSON extraction, section structure

**Controller Tests**:
- `tests/documentHandlingController.test.ts` (23 tests)
- `tests/dictionaryController.test.ts` (56 tests)
- `tests/audioController.test.ts` (35 tests)
- `tests/components/truncationControls.test.ts` (8 tests)

**Prompt Tests**:
- `tests/promptInvariants.test.ts` (56 tests): Invariant tests for 8 prompt modules
- `tests/minutesPrompts.test.ts` (102 tests): Prompt generation, chunk extraction, intermediate merge, consolidation, style extraction, context extraction

**Utility Tests**:
- `tests/responseParser.test.ts` (40 tests): 4-tier JSON extraction, sanitization
- `tests/textChunker.test.ts` (35 tests): Transcript chunking, overlap handling, sentence-boundary splitting
- `tests/sourceDetection.test.ts` (58 tests): URL/YouTube/PDF/audio detection
- `tests/frontmatterUtils.test.ts` (45 tests): Summary hooks, word counting, language detection
- `tests/dashboardService.test.ts` (23 tests): Filter injection, folder paths
- `tests/vectorMath.test.ts` (5 tests): Cosine similarity

**GTD & Migration Tests**:
- `tests/minutesGTDRendering.test.ts` (11 tests): GTD rendering, context sorting, checkbox integration
- `tests/settingsMigration.test.ts` (14 tests): `migrateOldSettings()` pure function coverage

**Digitisation Tests**:
- `tests/multimodal.test.ts`: Capability gating, adapter formatting, token handling
- `tests/imageProcessor.test.ts`: Resize, format conversion, MIME validation
- `tests/digitisePrompts.test.ts`: Prompt invariants for all digitise modes
- `tests/strokeManager.test.ts` (185 tests): Add/undo/redo/erase/clear stroke operations
- `tests/sketchExport.test.ts` (49 tests): Canvas mock → blob → vault file
- `tests/mediaCompression.test.ts` (143 lines): Compression offer logic, vault replacement

- `tests/streamingSynthesis.test.ts` (76 tests): P2 fixes, adapter streaming, orchestrator streaming, Siliconflow
- `tests/llmFacadeStream.test.ts` (6 tests): Streaming facade fallback (incl. abort guard)
- `tests/claudeAdapterThinking.test.ts` (31 tests): Adaptive thinking params, response parsing, streaming chunks
- `tests/claudeWebSearchAdapter.test.ts` (60 tests): Adapter unit tests (parseResponse, domain filtering, academic, perspective, multi-turn)
- `tests/claudeWebSearchIntegration.test.ts` (22 tests): Orchestrator integration tests (pipeline, pause_turn, metadata, budget)
- `tests/claudeWebSearchStreaming.test.ts` (56 tests): Streaming tests (SSE, citations_delta, mode-switch abort, multi-turn stream)

- `tests/embedScanService.test.ts` (70 tests): normalizeEmbedPath, classifyExtension, formatFileSize, getEmbedTypeIcon, hasEmbedTypeExtension, isExternalUrl, extractReferencesFromLine, EMBED_TYPE_EXTENSIONS
- `tests/mermaidChangeDetector.test.ts` (24 tests): Snapshot capture, staleness check, snooze, Jaccard similarity
- `tests/mermaidContextService.test.ts` (15 tests): Budget constants, sibling diagrams, context gathering
- `tests/mermaidTemplateService.test.ts` (20 tests): Fallback templates, template file parsing, load/save
- `tests/mermaidExportService.test.ts` (15 tests): .mermaid file, SVG, PNG, canvas export, appendToCanvas

- `tests/quickPeekService.test.ts` (9 tests): Pipeline, provider resolution, abort, fallback excerpt

Total: 3375 unit tests (136 suites) + 39 automated integration tests

## Multi-Source Translation

**Status**: ✅ Implemented (January 2026)

Translate note content and external sources (URLs, YouTube, PDFs, documents, audio) into 20+ languages.

**Smart Dispatch**: Selection → translate selection; no selection + sources → multi-source modal; no selection + no sources → translate note.

**Key Files**:
- `src/commands/translateCommands.ts`: Smart dispatch + multi-source orchestrator
- `src/services/apiKeyHelpers.ts`: Shared YouTube/audio API key resolution (DRY extraction)
- `src/services/pdfTranslationService.ts`: Shared PDF provider config (DRY extraction)
- `src/ui/modals/MultiSourceModal.ts`: Parameterized for both summarize and translate modes

**Patterns**: Modal reuse via config, sequential processing with error isolation, content chunking, privacy consent gating, wikilink + URL source cleanup after processing.

## Enhanced Pending Integration

**Status**: ✅ Implemented (February 2026)

Auto-resolves all embedded content (web articles, YouTube, audio, PDFs, documents) before integration. 3 strategy dropdowns (placement/format/detail) + auto-tag toggle.

**Auto-Resolve Pipeline** (`resolveAllPendingContent()` in `integrationCommands.ts`):
1. Detects embedded content via `detectEmbeddedContent()` (web, YouTube, audio, PDF, documents)
2. Per-provider privacy consent (Gemini/OpenAI/Groq independent of main LLM)
3. Extracts content via `ContentExtractionService` — text-only or multimodal PDF
4. Positional line-based replacement (bottom-up by `lineNumber`)
5. Truncates to fit provider limits (main content + overhead budget)

**Key behaviors**: YouTube falls back to caption scraping without Gemini key; audio skipped without API key; PDF uses multimodal when available, else officeparser text.

**Key Files**:
- `src/commands/integrationCommands.ts`: Command handler, `resolveAllPendingContent()`, `buildEnrichedContent()`, `IntegrationConfirmModal`, `buildIntegrationPrompt()`
- `src/services/contentExtractionService.ts`: Audio support, `extractPdfAsText()`, `extractPdfWithMultimodal()`, `textOnly` flag
- `src/services/prompts/integrationPrompts.ts`: Strategy-specific prompt helpers, `buildPdfExtractionPrompt()`
- `src/utils/editorUtils.ts`: `insertAtCursor()`, `appendAsNewSections()` (shared DRY utility)
- `src/core/constants.ts`: `PlacementStrategy`, `FormatStrategy`, `DetailStrategy` types + defaults

**Patterns**: Per-provider privacy consent (session-scoped), positional line-based replacement, truncation budget (main content for callout/merge + 2000 overhead), guard branching, editor buffer for auto-tag.

## Summary Result Preview Modal

**Status**: ✅ Implemented (January 2026)

Preview modal for all summary insert functions with insert/copy/discard actions.

**Key Files**:
- `src/ui/modals/SummaryResultModal.ts`: Modal with MarkdownRenderer preview
- `src/commands/summarizeCommands.ts`: `showSummaryPreviewOrInsert()` DRY helper

**Patterns**: Action-based return type, ESC-safe `onClose()` fires discard, metadata gated on cursor action only, scrollable `.ai-organiser-summary-preview` CSS.

## Web Research Assistant

**Status**: Phases 1-3 ✅ Implemented (February 2026)

### Overview

Full-featured research chat mode with web search, smart escalation, usage guardrails, quality scoring, academic mode, vault pre-check, multi-perspective decomposition, and Zotero integration. Three phases: Core MVP, Bright Data Integration, Research Intelligence.

### Architecture

**Pipeline**: User question → LLM query decomposition → multi-provider search → LLM triage scoring → content extraction → LLM synthesis → note insertion

**3-Tier Escalation**: Free `requestUrl` + Readability → Bright Data Web Unlocker → Scraping Browser (CDP/WebSocket), each with user consent

### Core Components

**Research Types** (`src/services/research/researchTypes.ts`):
- `SearchResult`, `SearchProviderType`, `ResearchSessionState`, `PaidTier`, `UsageLedger`, `ResearchBudgetStatus`
- `SourceMetadata`, `CslJsonItem`, `VaultPrecheckResult`, `QualitySignals`

**Research Orchestrator** (`src/services/research/researchOrchestrator.ts`):
- `decomposeQuestion()`: LLM query decomposition with perspective-aware parsing
- `executeSearchCycle()`: Multi-query search → triage → quality scoring → extraction → synthesis
- `precheckVaultContext()`: RAGService integration for vault pre-check advisory
- Session persistence with save/load/clear/expiry

**Research Search Service** (`src/services/research/researchSearchService.ts`):
- Provider orchestrator: Tavily, Bright Data SERP, Claude Web Search adapters
- Multi-query merge with URL dedup via `normalizeUrl()` (from `src/utils/urlUtils.ts`)
- Academic query expansion via `buildAcademicQueries()`
- Provider fallback: If primary returns no results, tries remaining configured providers; `fallbackProviderUsed` flag for UI notice

**Research Mode Handler** (`src/ui/chat/ResearchModeHandler.ts`):
- Phase-based UI: idle → searching → reviewing → extracting → done
- Controls row: provider dropdown, scope dropdown, recency dropdown (Any time / Past week / Past year), academic mode toggle
- Budget warn/block messaging with one-time override
- Quality badges, academic DOI badges, perspective chips
- Vault pre-check 3-button advisory (Use Vault / Continue Web / Always Search Web)
- Zotero send + CSL-JSON copy + Save Findings actions in done phase
- Session persistence includes `dateRange` for recency filter resume

**Research Usage Service** (`src/services/research/researchUsageService.ts`):
- JSON ledger at `AI-Organiser/Config/research-usage.json`
- Per-operation cost tracking by provider/tier
- Warn threshold (default 80%) + hard block (default 100%) with `checkBudget()` convenience
- Month rollover auto-reset, malformed file recovery (.bak backup)

**Source Quality Service** (`src/services/research/sourceQualityService.ts`):
- 5 weighted signals: relevance (0.45), authority (0.20), freshness (0.15), depth (0.10), diversity (0.10)
- Built-in authority profiles for ~25 domains
- Deterministic scoring with explainable signal breakdown

**Academic Utils** (`src/services/research/academicUtils.ts`):
- `ACADEMIC_DOMAINS` exported const — shared by `urlUtils.ts` and query expansion (DRY)
- DOI extraction via regex, author/year parsing from snippets
- Academic query expansion with `site:` scoping for academic domains
- Citation formatting: numeric `[1]` and author-year `(Smith, 2024)`

**URL Utilities** (`src/utils/urlUtils.ts`):
- `normalizeUrl()`: Lowercase host, strip trailing slash, remove tracking params (UTM etc.) for dedup
- `extractDomain()`: Strip `www.` prefix for display
- `classifyUrlSource()`: Classify URL as `'web' | 'youtube' | 'academic' | 'pdf'` using `ACADEMIC_DOMAINS`

**Token Limits** (`src/services/tokenLimits.ts`):
- `PROVIDER_LIMITS`: Per-provider max input/output tokens and chars-per-token
- `MODEL_INPUT_TOKEN_OVERRIDES`: Model-specific input token overrides (e.g., Claude 4.6 → 1M tokens)
- `getMaxContentChars(provider)`: Provider-only budget
- `getMaxContentCharsForModel(provider, model?)`: Model-aware budget (prefers model override when matched)
- `truncateContent()`: Paragraph/sentence-boundary truncation with `[Content truncated...]` suffix

**Zotero Bridge Service** (`src/services/research/zoteroBridgeService.ts`):
- Connector detection via `app.plugins.enabledPlugins`
- CSL-JSON transform with type inference (webpage/article-journal/report)
- HTTP send to `localhost:23119` with clipboard fallback
- Desktop only — disabled+tooltip when connector unavailable, hidden on mobile

**Bright Data Adapters** (`src/services/research/adapters/`, `src/services/research/brightdata/`):
- `brightdataSerpAdapter.ts`: SERP API search with date range support
- `webUnlocker.ts`: Anti-bot bypass for Cloudflare-protected sites
- `scrapingBrowser.ts` + `cdpClient.ts`: CDP/WebSocket for JS-rendered pages

**Research Prompts** (`src/services/prompts/researchPrompts.ts`):
- `buildQueryDecompositionPrompt()`: With `academicMode` and perspective-aware output
- `buildSourceTriagePrompt()`: Score 0-10 relevance assessment
- `buildSourceExtractionPrompt()`: Focused findings extraction
- `buildSynthesisPrompt()`: With `citationStyle` parameter

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `researchProvider` | `'claude-web-search'` | Search provider |
| `enableResearchUsageGuardrails` | `true` | Budget tracking and enforcement |
| `researchMonthlyBudgetUsd` | `10` | Monthly budget limit |
| `researchWarnThresholdPercent` | `80` | Warn at this % of budget |
| `researchBlockAtLimit` | `true` | Hard block at 100% |
| `enableResearchQualityScoring` | `true` | Deterministic quality ranking |
| `researchCitationStyle` | `'numeric'` | Citation format in synthesis |
| `enableResearchVaultPrecheck` | `true` | Check vault before web search |
| `researchVaultPrecheckMinSimilarity` | `0.65` | Min similarity for pre-check |
| `enableResearchPerspectiveQueries` | `true` | Multi-perspective decomposition |
| `researchPerspectivePreset` | `'balanced'` | Perspective preset |
| `enableResearchStreamingSynthesis` | `false` | Streaming synthesis (feature-flagged) |
| `enableResearchZoteroIntegration` | `false` | Zotero integration (feature-flagged) |

### Commands
- `research-web`: In Command Picker → Capture category

### Tests
- `tests/researchOrchestrator.test.ts`: 41 orchestrator tests (pipeline + Phase 3 budget/precheck/perspectives/quality/academic)
- `tests/researchUsageService.test.ts`: 24 usage ledger tests
- `tests/sourceQualityService.test.ts`: 20 quality scoring tests
- `tests/academicUtils.test.ts`: 18 academic utility tests
- `tests/zoteroBridgeService.test.ts`: 22 Zotero bridge tests (CSL-JSON + HTTP)
- `tests/researchPrompts.test.ts`: Prompt invariant tests
- `tests/streamingSynthesis.test.ts`: 76 tests (P2 fixes, adapter streaming, orchestrator streaming, Siliconflow)
- `tests/llmFacadeStream.test.ts`: 6 facade fallback tests (incl. abort guard)
- `scripts/automated-tests.js`: Research command + export integration checks

### Key Patterns
- **Phase-based UI**: Handler manages state machine transitions, action descriptors per phase
- **Budget delegation**: Orchestrator calls `usageService.checkBudget(tier)` — no budget math in orchestrator
- **Perspective fallback**: Structured `{ query, perspective }` JSON with backward-compatible plain `string[]` fallback
- **Vault pre-check**: Advisory only, never blocking. One-per-session guard. "Always Search Web" suppresses for remainder of session
- **Zotero gating**: `enableResearchZoteroIntegration` setting + connector awareness + Platform.isMobile check
- **Streaming synthesis**: SSE via native `fetch()` (not `requestUrl`), adapter-level `supportsStreaming()`/`formatStreamingRequest()`/`parseStreamingChunk()` with shared `BaseAdapter` helpers, `summarizeTextStream` facade with automatic fallback to `summarizeText`, AbortController wired in `ResearchModeHandler.dispose()`
- **Search retry**: `searchWithRetry` wrapper in `researchSearchService.ts` — 1 retry on 429/5xx with 2s delay
- **Provider fallback**: If primary provider returns 0 results, automatically tries remaining providers; `fallbackProviderUsed` flag triggers UI notice
- **Date range filtering**: `dateRange` on `SearchOptions` ('recent'|'year'|'any') — Tavily maps to `days` param (7/365), persisted in session state

**Plan**: [docs/completed/web-research-plan.md](docs/completed/web-research-plan.md)

## Claude Web Search Provider

**Status**: Phases 1-3 ✅ Implemented (February 2026)

### Overview

Alternative research provider using Anthropic's native web search tool. Replaces the 4-LLM-call pipeline (decompose → search → triage → extract → synthesize) with a single Claude API call that autonomously searches, fetches, filters with code, and synthesizes — with built-in citations.

### Architecture

**Single API Call**: User question → Claude API with `web_search` tool → Claude autonomously searches → fetches → filters → synthesizes → response with native citations + source metadata.

**Provider-Level Integration** (AD-1): Added as a search provider with an orchestrator-level branch, not a pipeline replacement. All existing providers remain fully functional.

### Core Components

**Claude Web Search Adapter** (`src/services/research/adapters/claudeWebSearchAdapter.ts`):
- `searchAndSynthesize()`: Single API call with web search tool, returns `ClaudeWebSearchResponse`
- `searchAndSynthesizeStream()`: SSE streaming with progressive text rendering and `citations_delta` support
- `searchAndSynthesizeMultiTurn()` / `searchAndSynthesizeMultiTurnStream()`: Multi-turn with conversation history
- `continueSearch()`: Auto-continue for `pause_turn` responses (max 3 continuations)
- `parseResponse()`: Extracts search results, citations, synthesis text from response blocks
- `buildToolDefinition()`: Domain filtering — academic takes precedence, mutually exclusive `allowed_domains`/`blocked_domains`
- `buildSystemPrompt()`: Language, citation style (forces author-year for academic mode), perspective instructions
- Tool version auto-detect: `web_search_20260209` (dynamic filtering) for Claude 4.6, `web_search_20250305` (basic) for older models
- Citation-frequency scoring: implicit quality signal from citation counts

**Orchestrator Branch** (`src/services/research/researchOrchestrator.ts`):
- `executeClaudeWebSearch()` / `executeClaudeWebSearchStream()`: Unified pipeline with budget check, `pause_turn` loop, usage recording, quality scoring
- `executeClaudeWebSearchMultiTurn()` / `executeClaudeWebSearchMultiTurnStream()`: Multi-turn with message history
- `buildSourceMetadataMap()`: Deduplicates citations by URL, propagates academic metadata (DOI, authors, year)
- Phase transitions: `searching` → `continuing` (on pause_turn) → `done`

**Research Mode Handler** (`src/ui/chat/ResearchModeHandler.ts`):
- `executeClaudeWebSearchCycle()`: Branch in `executeSearchCycle()` for `claude-web-search` provider
- Phase simplification: skips reviewing/extracting/synthesizing, goes straight to done
- `onClear()`: Resets conversation history and handler state
- Session persistence includes `conversationHistory` for multi-turn resume
- Perspective resolution from `PERSPECTIVE_PRESETS` for Claude Web Search system prompt

### Key Decisions

- **API Key Reuse** (AD-4): resolution is **provider-gated** (`getClaudeWebSearchKey`, `apiKeyHelpers.ts`). Under `azure-claude` the **Azure Foundry key wins** and any dedicated research key is IGNORED — a dedicated key is a DIRECT-Anthropic (`x-api-key`) credential, so Bearer-sending it to the Foundry passthrough 401s ("invalid subscription key"). For non-Azure providers: dedicated research key → main SecretStorage anthropic key → `cloudApiKey`. So Azure overrides while it's the selected provider; private keys reactivate when Azure is off. (Order is Azure-first by design — verified live against the Foundry endpoint June 2026; the old dedicated-first order was the root cause of a web-search 401.)
- **Domain Filtering** (AD-5): `researchExcludedSites` → `blocked_domains`; academic mode → `allowed_domains` for academic sites
- **Cost Tracking** (AD-6): `$0.01/search` via `usage.server_tool_use.web_search_requests` count
- **Dynamic Filtering** (AD-7): Auto-detect based on model prefix (`claude-opus-4-6`/`claude-sonnet-4-6`)
- **Phase Simplification** (AD-3): `idle` → `searching` → `done` (skips reviewing/extracting)

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `researchClaudeMaxSearches` | `5` | Max searches per query (1-10) |
| `researchClaudeUseDynamicFiltering` | `true` | Dynamic filtering (requires Claude 4.6) |

### Tests
- `tests/claudeWebSearchAdapter.test.ts`: 60 adapter tests (parseResponse, isConfigured, searchAndSynthesize, buildSystemPrompt, tool version, scoring, pause_turn, academic, perspective, multi-turn)
- `tests/claudeWebSearchIntegration.test.ts`: 22 orchestrator integration tests (pipeline, pause_turn accumulation, metadata dedup, budget, quality scoring, academic enrichment, multi-turn)
- `tests/claudeWebSearchStreaming.test.ts`: 56 streaming tests (SSE parsing, citations_delta, mode-switch abort, continuing phase, multi-turn stream)
- **Total**: 138 Claude Web Search tests

### Key Patterns
- **Preamble filtering**: `parseResponse()` excludes pre-search narrative ("I'll search for...") from synthesis
- **Citation-frequency scoring**: Citation counts normalized by max → implicit quality ranking
- **Snippet enrichment**: First `cited_text` per URL fills empty `snippet` on search results
- **Academic metadata propagation**: DOI/authors/year from enriched `SearchResult` copied to `SourceMetadata`
- **Stale-generation guard**: Streaming callbacks check `isStaleGeneration()` to prevent writes after mode switch
- **3-layer abort**: Network abort → callback suppression → final-write guard

**Plan**: [docs/claude-web-search-plan.md](docs/claude-web-search-plan.md)

## Web Reader

**Status**: ✅ Implemented (February 2026)

### Overview
Article triage workflow: extract web URLs from a note, fetch brief LLM summaries, present in an interactive modal for multi-select grouping, create notes ready for full summarization.

### Core Components
- `src/services/prompts/triagePrompts.ts`: 5-10 line triage prompt
- `src/services/webReaderService.ts`: Fetch + triage + note creation
- `src/ui/modals/WebReaderModal.ts`: Two-phase modal (progress → triage)
- `src/commands/webReaderCommands.ts`: Command registration

### Key Patterns
- Sequential fetch with progressive rendering
- LLM failure → Readability excerpt fallback
- Iterative multi-select: create note → remove from list → repeat
- Output notes contain URLs only (user runs normal summarization)
- AbortController for cancellation during fetch phase
- Privacy consent gate before LLM calls
- URL count warning threshold (20+) with confirmation modal

### Settings
| Setting | Default | Description |
|---------|---------|-------------|
| `webReaderOutputFolder` | `'Web Reader'` | Subfolder under plugin folder for output notes |

### Commands
- `web-reader`: In Command Picker → Capture category

### Tests
- `tests/triagePrompts.test.ts`: 17 prompt invariant tests (10 base + 7 content-type)
- `tests/webReaderService.test.ts`: 13 service tests (fetch, LLM fallback, progress, note creation)
- `scripts/automated-tests.js`: 2 integration checks (command registration + index)

## Quick Peek — Fast Triage

**Status**: ✅ Implemented (March 2026)

### Overview

Fast 1-paragraph triage summaries for embedded sources (URLs, PDFs, YouTube, documents, audio) with action cards. Three trigger modes: command palette (full note), right-click selection, right-click cursor-on-link.

### Core Components

- `src/services/quickPeekService.ts`: Orchestrator — detect → extract → triage per source with specialist/main provider
- `src/ui/modals/QuickPeekModal.ts`: Phase-based modal (detecting → extracting → triaging → done) with source cards
- `src/commands/quickPeekCommands.ts`: Command registration + smart dispatch
- `src/services/prompts/triagePrompts.ts`: Extended with `contentType` parameter and type-specific hints

### Smart Dispatch (3 Trigger Modes)

- **Command palette**: All sources in active note
- **Right-click selection**: Links in selection range (line-filtered)
- **Right-click cursor on link**: Single link under cursor

### Source Cards

- Type icon + display name per source
- Triage paragraph (or error/fallback excerpt with ⚠ indicator)
- **Full Summary**: Opens MultiSourceModal with single source pre-selected
- **Open**: Platform-safe via `openInBrowser()` or `openLinkText()`
- **Remove from Note**: Content-match removal with 5-second undo notice

### Key Patterns

- **Specialist provider**: Follows flashcard/audit pattern — `quickPeekProvider` + `quickPeekModel` settings
- **API key inheritance**: SecretStorage → provider key → main key (3-level fallback)
- **Source filter**: `getQuickPeekSources()` includes web-link, youtube, pdf, document, audio; excludes image, internal-link
- **Insert All Peeks**: Idempotent `## Quick Peek` section via `insertOrReplaceQuickPeekSection()`
- **Fallback excerpt**: First 200 chars of extracted content when LLM fails
- **AbortSignal**: Best-effort cancellation on modal close
- **Privacy consent**: Gated before LLM calls
- **Content-type hints**: `buildTriagePrompt()` receives source type for targeted prompts

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `quickPeekProvider` | `'main'` | Specialist or main LLM provider |
| `quickPeekModel` | `''` | Model override (empty = provider default) |

### Commands
- `quick-peek`: In Command Picker → Active Note category

### Tests
- `tests/quickPeekService.test.ts` (9 tests): Pipeline, provider resolution, abort, fallback excerpt
- `tests/triagePrompts.test.ts` (17 tests): Shared with Web Reader — includes 7 content-type tests
- `scripts/automated-tests.js`: 3 Quick Peek integration checks

**Plan**: [docs/completed/quic-plan.md](docs/completed/quic-plan.md)

## Kindle Sync

**Status**: Phases 1-3 ✅ Implemented (February 2026) | Phase 4 ⏳ TODO

### Overview

Kindle highlights sync with dual-mode import: My Clippings.txt file import and Amazon cloud sync via direct HTTP using Obsidian's `requestUrl`. Differential sync, note creation/update, four-phase modal UX, and ASIN-keyed deduplication for Amazon path.

### Core Components

**Kindle Types** (`src/services/kindle/kindleTypes.ts`):
- `KindleHighlight`, `KindleBook`, `KindleSyncState`, `KindleSyncProgress`, `KindleSyncResult`
- `KindleCookiePayload`, `KindleCDPCookie`, `KindleScrapedBook`
- Hash functions: `generateHighlightId()`, `generateBookKey()`, `generateAmazonHighlightId()`
- `toKindleBook()`: Convert scraped book + highlights → `KindleBook`

**Clippings Parser** (`src/services/kindle/kindleClippingsParser.ts`):
- `parseClippings(content)`: Splits by `==========`, parses metadata regex, groups by book
- Deduplicates by content hash, attaches notes to highlights, skips bookmarks

**Note Builder** (`src/services/kindle/kindleNoteBuilder.ts`):
- `buildBookNote()`, `buildFrontmatter()`, `formatHighlight()` (3 styles: blockquote/callout/bullet)
- `appendHighlightsToExisting()`, `updateFrontmatterInContent()` for incremental sync

**Auth Service** (`src/services/kindle/kindleAuthService.ts`):
- `validateCookies()`: HTTP validation via `requestUrl` against notebook page
- `getNotebookUrl()`: Region-specific domains (read.amazon.com, lesen.amazon.de, etc.)
- `buildRequestHeaders()`: Cookie + User-Agent headers for all requests
- `openAmazonInBrowser()`: Opens notebook URL in system browser
- `detectAuthExpiry()`: HTML-based login page detection
- Cookie CRUD: `isAuthenticated()`, `getStoredCookies()`, `storeCookies()`, `clearCookies()`
- `parseManualCookies()`: Cookie string validation (session-id + ubid required)

**Scraper Service** (`src/services/kindle/kindleScraperService.ts`):
- `fetchPageHTML()`: Core HTTP fetcher using `requestUrl` with Cookie auth
- `fetchBookList()` + `parseBookListHTML()`: Book list from Amazon notebook page
- `fetchHighlightsForBook()`: Per-book highlights with server-side pagination
- `parseHighlightsHTML()`: Highlight text, color, location, notes extraction
- `fetchAllHighlights()`: Orchestrator for all ASINs
- Pagination via `contentLimitState` + `token` hidden inputs

**Sync Service** (`src/services/kindle/kindleSyncService.ts`):
- `syncFromClippings()`: Clippings file import path
- `syncFromAmazon()`: Amazon cloud sync via HTTP, auth expiry detection
- `getNewHighlights(book, state, asin?)`: Optional ASIN-keyed lookup
- `updateSyncState(plugin, book, highlights, asin?)`: Dual-write state

**Login Modal** (`src/ui/modals/KindleLoginModal.ts`):
- 3-step flow: open Amazon in browser → copy cookies → paste and validate
- HTTP validation before storing cookies

**Sync Modal** (`src/ui/modals/KindleSyncModal.ts`):
- Four-phase modal supporting both clippings import and Amazon cloud sync
- Mobile vault file picker, cancel support, file tracking

**Settings** (`src/ui/settings/KindleSettingsSection.ts`):
- Amazon Region, Login/Logout, output folder, highlight style, toggles

### Architecture: Direct HTTP (v2)

All scraping via Obsidian's native `requestUrl` with Cookie header:
- Amazon notebook is server-rendered HTML — no JavaScript execution needed
- Region-specific reading domains (`REGION_DOMAINS` mapping, 11 regions)
- Server-side pagination via `contentLimitState` + `token` hidden inputs
- Cookie persistence in SecretStorage with structured `KindleCookiePayload`
- No external dependencies (no Bright Data, no CDP, no WebSocket)

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `kindleOutputFolder` | `'Kindle'` | Subfolder under plugin folder |
| `kindleAmazonRegion` | `'com'` | Amazon domain for cloud sync |
| `kindleHighlightStyle` | `'blockquote'` | How highlights render |
| `kindleGroupByColor` | `false` | Group highlights by color |
| `kindleIncludeCoverImage` | `true` | Embed cover image in note |
| `kindleAutoTag` | `true` | Run AI tagging after import |

### Commands
- `kindle-sync`: In Command Picker → Capture category

### Tests
- `tests/kindleClippingsParser.test.ts`: 21 parser tests
- `tests/kindleNoteBuilder.test.ts`: 34 builder tests
- `tests/kindleSyncService.test.ts`: 26 service tests (clippings + Amazon sync)
- `tests/kindleAuthService.test.ts`: 25 auth tests (cookie CRUD, headers, URL building)
- `tests/kindleScraperService.test.ts`: 20 scraper tests (HTML parsing, ID generation)
- `tests/fixtures/amazon-*.html`: HTML fixtures for `happy-dom` tests

### Remaining Work
- Phase 4: AI enhancement + polish
- Plan: [docs/kindle-plan.md](docs/kindle-plan.md)

## Document Export & Theme

**Status**: ✅ Implemented (March 2026)

### Overview

Export notes as PDF, Word (.docx), or PowerPoint (.pptx) with configurable theme. Users set a default colour scheme, font family, and body font size in settings; the theme applies uniformly across all PPTX and DOCX exports.

### Core Components

**Export Service** (`src/services/export/exportService.ts`):
- `ExportService.exportNotes(config)`: Orchestrates single/multi-note export to PDF, DOCX, PPTX
- `ExportConfig.theme?: ExportTheme`: Forwarded to both generators

**PPTX Generator** (`src/services/export/markdownPptxGenerator.ts`):
- `ExportTheme` interface: `primaryColor`, `accentColor`, `sectionBg`, `bodyColor`, `fontFace`, `fontSize`
- `COLOR_SCHEMES`: 5 preset palettes (navy-gold, forest-amber, slate-coral, burgundy-champagne, charcoal-sky)
- `resolveTheme()`: Pure function mapping scheme name + custom overrides to full `ExportTheme`
- `generatePptx()`: Markdown → slides (H1/H2 splits), themed headings/body/tables
- `generatePptxFromDeck()`: Structured `DeckModel` → themed slides with types (title/section/content/closing)
- Colour math helpers: `darkenHex()`, `lightenHex()` for custom scheme derivation

**DOCX Generator** (`src/services/export/markdownDocxGenerator.ts`):
- `DocxOptions.fontFace` / `DocxOptions.fontSize`: Override defaults (Calibri/11pt)
- Body text uses half-points (`pt × 2`); headings retain proportional constants

**Export Modal** (`src/ui/modals/ExportModal.ts`):
- Builds theme from settings via `resolveTheme()` and passes to `exportNotes()`

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `exportColorScheme` | `'navy-gold'` | Preset palette or `'custom'` |
| `exportPrimaryColor` | `'1A3A5C'` | Custom primary hex (headings, title bg) |
| `exportAccentColor` | `'F5C842'` | Custom accent hex (bars, table headers) |
| `exportFontFace` | `'Noto Sans'` | Font family for exports |
| `exportFontSize` | `14` | Body font size in points (10–18) |

Settings UI: `src/ui/settings/ExportSettingsSection.ts` — colour scheme dropdown with inline colour swatch preview, native colour pickers for custom mode, font dropdown, font size slider with `setDynamicTooltip()`.

## Smart Digitisation & Multimodal Architecture

**Status**: ✅ Implemented (February 2026)

### Overview

Unified multimodal pipeline, image processing, smart digitisation of handwritten notes/whiteboards/diagrams, built-in sketch pad, and media compression with vault replacement. Five phases delivered on branch `claude/smart-digit-plan-O4GpF`.

**Full plan**: [docs/completed/smart-digitisation-plan.md](docs/completed/smart-digitisation-plan.md)

### Multimodal Architecture (Phase 1)

**Adapter pipeline** (`src/services/adapters/`):
- `ContentPart` type: `text | image | document` content parts
- `MultimodalCapability`: `'text-only' | 'image' | 'document' | 'image+document'`
- `formatMultimodalRequest()` on adapters: Claude, Gemini, OpenAI override; others inherit text-only default
- `sendMultimodal()` on `CloudLLMService`: Unified method replacing `analyzeImage`, `summarizePdf`, `analyzeMultipleContent`
- Strict capability validation: Returns error for unsupported media types (no silent drops)
- `extractTextFromParts()` in `src/utils/adapterUtils.ts`: Safe text extraction from `ContentPart[]`

### Image Processing (Phase 2)

**ImageProcessorService** (`src/services/imageProcessorService.ts`):
- Canvas 2D pipeline: load → detect format → convert → resize → compress → base64
- Format conversion: BMP/TIFF/AVIF → JPEG, SVG → PNG (via canvas rasterisation)
- HEIC: Not supported in-plugin (throws with guidance to set iPhone to "Most Compatible")
- MIME validation with `VLM_NATIVE_IMAGE_FORMATS` whitelist
- `processImage(file, options)` → `ProcessedImage` with dimensions, sizes, conversion flags
- `replaceOriginal(file, processedImage)` → backlink-safe vault replacement via `fileManager.renameFile()`

### Smart Digitisation (Phase 3)

**VisionService** (`src/services/visionService.ts`):
- `digitise(file)` / `digitiseWithImage(file)`: Image → VLM → structured markdown + Mermaid
- `canDigitise()`: Provider capability check (returns false for local/text-only providers)
- `findNearestImage()`: Cursor-aware image embed detection (±3 lines)
- `resolveImageEmbed()`: Wiki-link image resolution via vault API

**Digitise Prompts** (`src/services/prompts/digitisePrompts.ts`):
- 5 modes: `auto | handwriting | diagram | whiteboard | mixed`
- XML-structured prompts with `<task>`, `<requirements>`, `<output_format>` sections
- Outputs: `## Extracted Text` (markdown), `## Diagram` (mermaid), `## Uncertainties`

**VisionPreviewModal** (`src/ui/modals/VisionPreviewModal.ts`):
- Split layout: source image | rendered markdown+mermaid output
- Actions: Discard (mod-warning) | Copy to Clipboard | Insert Below (mod-cta)
- Component lifecycle with `component.unload()` cleanup

**Commands** (`src/commands/digitisationCommands.ts`):
- `digitise-image`: Cursor-aware image detection, single/multi image picker
- Context menu entry for image embeds (cursor-position-based, not selection-based)

### Built-in Sketch Pad (Phase 4)

**SketchPadModal** (`src/ui/modals/SketchPadModal.ts`):
- Canvas 2D drawing surface with `perfect-freehand` (1.2 KB, pressure-sensitive strokes)
- Pointer Events API: pressure, tilt, `pointerType` discrimination
- `touch-action: none` prevents iPadOS Scribble interference
- Toolbar: colour picker (black/blue/red), pen width (thin/med/thick), undo/redo/eraser/clear

**StrokeManager** (`src/services/sketch/strokeManager.ts`):
- Stroke-level undo/redo stack
- Eraser: distance-based hit test against stroke bounding boxes
- `getStrokes()` returns shallow copies (immutable external interface)

**SketchExport** (`src/services/sketch/sketchExport.ts`):
- `canvas.toBlob()` → `vault.createBinary()` → embed `![[sketch-*.png]]` in note
- "Done & Digitise" button: saves + digitises in one step

**Commands** (`src/commands/sketchCommands.ts`):
- `new-sketch`: Opens SketchPadModal, saves PNG, embeds in current note

**Settings**: `sketchOutputFolder`, `sketchAutoDigitise`, `sketchDefaultPenColour`, `sketchDefaultPenWidth`

### Media Compression (Phase 5)

**CompressionConfirmModal** (`src/ui/modals/CompressionConfirmModal.ts`):
- 3-action modal: keep original / replace with compressed / delete file
- `CompressionChoice`: `{ action: CompressionAction }` where `CompressionAction = 'keep-original' | 'keep-compressed' | 'delete'`
- `compressedSizeBytes` optional — modal adapts title and hides compress button when no compression available
- Used after digitisation (images) and after transcription (audio via `audioCleanupService`)

**Image compression** (`src/services/imageProcessorService.ts`):
- `replaceOriginal()`: `vault.modifyBinary()` + `fileManager.renameFile()` for backlink safety
- `getEstimate()`: Pre-processing size estimation for UI

**Audio cleanup** (`src/services/audioCleanupService.ts`):
- `offerPostTranscriptionCleanup()`: Shared post-transcription cleanup for all audio paths
- Respects `postRecordingStorage` policy setting
- Auto-actions for `keep-compressed` and `delete` policies; modal shown for `ask`

**Audio compression** (`src/services/audioCompressionService.ts`):
- `replaceAudioFile()`: Backlink-safe audio vault replacement

**Settings**: `offerMediaCompression` (`'always' | 'large-files' | 'never'`), `mediaCompressionThreshold` (image-scoped); `postRecordingStorage` (`'ask' | 'keep-original' | 'keep-compressed' | 'delete'`) for audio cleanup

### Digitisation Settings

**DigitisationSettingsSection** (`src/ui/settings/DigitisationSettingsSection.ts`):
- `digitiseDefaultMode`, `digitiseMaxDimension`, `digitiseImageQuality`

**SketchSettingsSection** (`src/ui/settings/SketchSettingsSection.ts`):
- `sketchOutputFolder`, `sketchAutoDigitise`, `sketchDefaultPenColour`, `sketchDefaultPenWidth`

## Mermaid Chat (Conversational Diagram Editing)

**Status**: ✅ Implemented (March 2026) — Phases 1-4

### Overview

Conversational Mermaid diagram editing modal. Users describe diagrams in natural language; LLM generates/modifies Mermaid code with live preview, version history, diff view, templates, and multi-format export.

### Core Components

**MermaidChatModal** (`src/ui/modals/MermaidChatModal.ts`):
- Split-pane layout: chat left, preview right (desktop); tabbed toggle (mobile)
- Streaming LLM responses with live preview rendering
- Version history navigation (prev/next within session)
- Line-level diff view between consecutive versions
- Edit coalescing: rapid applies within 5s reuse tracked range
- Type conversion via `DiagramTypePickerModal` (12 target types)
- Block fingerprinting for in-place diagram updates
- Privacy consent gating on all LLM calls (chat, alt-text, export)

**MermaidContextService** (`src/services/mermaidContextService.ts`):
- `gatherContext(file, currentDiagram)`: Sibling diagram detection, backlink context, RAG integration
- Token budget management (siblings 2000, backlinks 1500, RAG 1500 chars)

**MermaidChangeDetector** (`src/services/mermaidChangeDetector.ts`):
- Jaccard similarity on word sets + heading structure comparison
- `MIN_JACCARD_SIMILARITY = 0.70`, 30-minute snooze duration
- Captures snapshots on apply, checks staleness on modal re-open

**MermaidTemplateService** (`src/services/mermaidTemplateService.ts`):
- Built-in fallback templates (flowchart, sequence, mindmap, gantt)
- User-defined templates in `AI-Organiser/Config/mermaid-templates.md`
- `parseTemplateFile()` / `saveAsTemplate()` for CRUD

**MermaidExportService** (`src/services/mermaidExportService.ts`):
- `.mermaid` text file, SVG, PNG (Canvas API @ 2x), new canvas, append to existing canvas
- Alt-text injection for SVG (`<title>`) and PNG (companion `.alt.txt` sidecar)
- `CanvasPickerModal` for selecting existing `.canvas` files

**Supporting UI**:
- `MermaidBlockPickerModal`: FuzzySuggestModal for selecting existing mermaid blocks in note
- `MermaidTemplatePickerModal`: FuzzySuggestModal for template selection
- `MermaidChatSettingsSection`: Context toggles, staleness notice, alt-text, export options
- `mermaidStalenessGutter.ts`: Editor gutter extension for stale diagram indicators

**Utilities**:
- `mermaidUtils.ts`: `findMermaidBlocks()`, `resolveBlockByFingerprint()`, `cleanMermaidOutput()`
- `mermaidDiff.ts`: `computeLineDiff()`, `getDiffStats()`, `hasMeaningfulChanges()`

### Prompts (`src/services/prompts/mermaidChatPrompts.ts`)

- `buildMermaidChatSystemPrompt()`: System prompt with provider/model awareness
- `buildMermaidChatUserPrompt()`: User prompt with note context, siblings, backlinks, RAG
- `buildTypeConversionInstruction()`: Type conversion instructions
- `buildDiagramAltTextPrompt()`: Accessibility alt-text generation
- `formatConversationTurn()`: Conversation history formatting

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mermaidChatIncludeNoteContext` | `true` | Include note content in prompts |
| `mermaidChatIncludeBacklinks` | `false` | Include backlink context |
| `mermaidChatIncludeRAG` | `false` | Include RAG context |
| `mermaidChatStalenessNotice` | `false` | Show stale diagram warnings (opt-in) |
| `mermaidChatGenerateAltText` | `false` | Generate accessibility alt-text on export |
| `mermaidChatExportTheme` | `'default'` | Export theme (not yet applied — uses Obsidian theme) |

### Commands
- `mermaid-chat`: In Command Picker → Active Note (via `smartNoteCommands.ts`)

### Tests
- `tests/mermaidDiff.test.ts`: Line diff computation, stats, meaningful change detection
- `tests/mermaidChangeDetector.test.ts` (24 tests): Snapshot, staleness, snooze, Jaccard
- `tests/mermaidContextService.test.ts` (15 tests): Budget, siblings, context gathering
- `tests/mermaidTemplateService.test.ts` (20 tests): Fallback templates, parsing, load/save
- `tests/mermaidExportService.test.ts` (15 tests): All export formats, appendToCanvas

### Key Patterns
- **Block fingerprinting**: First 80 chars of diagram code + line proximity for re-resolution
- **Edit coalescing**: 5-second window to prevent undo-stack noise from rapid applies
- **Consent gating**: All LLM calls (chat, alt-text) require `ensurePrivacyConsent()` — session-scoped
- **Context toggles**: Each context source (note, backlinks, RAG) independently toggled in settings
- **SonarQube compliance**: `handleSend` CC=12, `applyToNote` CC=10 (limit 15)

---

## Find Embeds / Vault Hygiene

**Status**: ✅ Implemented (February 2026)

### Overview

Vault hygiene command that scans for all embedded and linked files, showing reference counts, file sizes, types, and orphan detection. Helps users find assets before deleting notes.

### Core Components

**Embed Scan Service** (`src/services/embedScanService.ts`):
- `scanNotes()`: Main scan function with AbortSignal cancellation and progress callbacks
- `normalizeEmbedPath()`: Case-insensitive, extension-optional, path suffix matching
- `classifyExtension()`: Type classification (image, audio, video, pdf, document, canvas, other)
- `formatFileSize()`: Human-readable size formatting
- `extractReferencesFromLine()`: 4 regex patterns (markdown/wiki × embed/link)
- `getMarkdownFilesInFolder()`: Recursive folder traversal for scope support
- No deduplication — counts every reference occurrence for accurate counts
- Orphan detection: files with 0 inbound references flagged as possibly orphaned

**Embed Scan Results Modal** (`src/ui/modals/EmbedScanResultsModal.ts`):
- Interactive results with expandable rows showing referencing notes
- Filter/sort/search: text search, type chip toggles, min file size filter
- Sort by reference count, file size, or name (ascending/descending)
- "Possibly Orphaned" collapsed section with disclaimer
- File size display with human-readable formatting

**Embed Scan Scope Modal** (`src/ui/modals/EmbedScanScopeModal.ts`):
- Scope picker: current note, current folder, entire vault
- Arrow key navigation + ARIA attributes for accessibility
- Enter/Space activation

**Commands** (`src/commands/embedScanCommands.ts`):
- `find-embeds`: In Command Picker → Tools → Vault Hygiene

### Settings

No dedicated settings — uses existing plugin folder configuration.

### Tests
- `tests/embedScanService.test.ts` (70 tests): normalizeEmbedPath, classifyExtension, formatFileSize, getEmbedTypeIcon, hasEmbedTypeExtension, isExternalUrl, extractReferencesFromLine, EMBED_TYPE_EXTENSIONS
- `tests/commandPicker.test.ts`: Updated leaf count (31→32), added find-embeds command

### Key Patterns
- **No dedup**: Every embed/link occurrence counted separately for accurate reference counts
- **Link normalization**: Case-insensitive matching, optional extensions, path suffix matching
- **Orphan detection**: Advisory only — "possibly orphaned" with disclaimer about potential false positives
- **AbortSignal**: Cancellable scan with progress callback for UI updates
- **ARIA + keyboard nav**: Scope picker follows accessibility best practices
- **i18n**: Full `embedScan` section at top level of Translations (~60 keys)

## Free Chat & Smart Document Indexing (Plan 3)

**Status**: ✅ Implemented (March 2026)

### Overview

Full-featured free-form chat mode with file attachments, smart document indexing (ONNX RAG), project-based persistent conversations, auto-memory extraction, and conversation persistence with resume.

### Core Components

**FreeChatModeHandler** (`src/ui/chat/FreeChatModeHandler.ts`):
- `AttachmentEntry` / `IndexedAttachmentEntry` interfaces for attachment state
- Vault file picker + native OS file picker (Electron dialog, desktop only)
- `handleLargeAttachment()`: triggers `IndexingChoiceModal` when file exceeds token budget
- `indexAttachment()`: creates `AttachmentIndexService`, indexes in background, updates pill state
- `tryAutoBootstrapEmbeddings()`: lazy-initialises ONNX embedding service when no API key is configured
- `rehydrateIndexedDocument()`: re-embeds a persisted document on project load
- `tryReextractAttachment()`: re-reads vault or external files for attachments restored without text
- `resolveProviderAndModel()`: checks `serviceType === 'local'` first for correct token budget
- `addGlobalMemoryFact()` / `addProjectMemoryFact()`: live in-memory update after async vault saves
- `clearProjectContext()`: disposes + removes `indexMode === 'project'` attachments on project switch
- `getProjectName()`: returns `projectConfig.name` for dropdown label
- Prompt budget fractions: system 2%, project instructions 5%, project memory 3%, global memory 3%, history 30%, indexed RAG 25%, flat attachments 20%

**AttachmentIndexService** (`src/services/chat/attachmentIndexService.ts`):
- In-memory cosine-similarity RAG; chunks via `chunkPlainTextAsync`, batched ONNX embedding (10/batch)
- `queryRelevantChunks(query, { topK, maxChars })`: returns trimmed relevant context
- Mobile 200-chunk cap with `isPartial` flag and `totalChunks` for accurate pill display
- `dispose()`: releases embedding references

**IndexingChoiceModal** (`src/ui/modals/IndexingChoiceModal.ts`):
- Options: Project (persist to vault), Temporary (in-session), Truncate, Open Settings (when no embeddings)
- `waitForChoice()`: async Promise with single-flight guard (`resolved` flag prevents double-resolution)
- `onClose()` defaults to `'truncate'` (safe fallback)
- Label changes: "Create project" (no active project) vs "Index into project" (project active)

**LocalOnnxEmbeddingService** (`src/services/embeddings/localOnnxEmbeddingService.ts`):
- Wraps `@xenova/transformers` v2 pipeline (dynamic import, not bundled by default)
- `@xenova/transformers` added to `optionalDependencies` and removed from esbuild externals — **must bundle** for Obsidian deployment (node_modules not available at plugin runtime)
- Bundle size: 7.1 MB → 8.5 MB
- Model: `Xenova/all-MiniLM-L6-v2` (384 dims, 512 token max) — zero-setup fallback

**ConversationPersistenceService** (`src/services/chat/conversationPersistenceService.ts`):
- Per-mode file tracking via `currentFiles: Map<ChatMode, TFile | null>`
- `startNew(mode)`: clears handle so next save creates a fresh file in the correct folder
- `scheduleSave(state)`: 1-second debounced save
- `saveNow(state)`: bypasses debounce (called in `onClose()` before `cancelAllPending()`)
- `pruneOldConversations(days)`: housekeeping on modal open
- `listRecent(n)`: feeds the resume picker

**ConversationCompactionService** (`src/services/chat/conversationCompactionService.ts`):
- Token-aware history trimming with `[Compacted N messages]` marker
- `resetAll()`: called in `onClose()` for clean teardown

**ProjectService** (`src/services/chat/projectService.ts`):
- `createProject(name)` → slug + `_project.md` with YAML frontmatter
- `saveIndexedDocument(projectId, fileName, extractedText, chunkCount)`: creates vault note at `Projects/<slug>/indexed/<name>.md`, appends `- [[indexed/<name>]] (N chunks)` to `## Indexed Documents` in `_project.md`; deduplicates: existing entries have chunk count updated in-place
- `loadIndexedDocuments(config)`: parses manifest, re-reads vault notes for rehydration

**GlobalMemoryService** (`src/services/chat/globalMemoryService.ts`):
- Facts stored at `AI-Organiser/Config/global-memory.md`
- Deduplication on add, pruning support

**UnifiedChatModal wiring**:
- `onClose()` calls `saveNow()` before `cancelAllPending()` — guards 1s debounce window
- All three "enter project" paths call `persistenceService.startNew('free')` — clears stale file handle
- `loadProjectContext()` calls `clearProjectContext()` first — prevents stale attachment leak
- `processMemoryMarkers()` calls `addGlobalMemoryFact()` / `addProjectMemoryFact()` after async saves
- `renderProjectDropdown()` uses `freeChatHandler.getProjectName()` for the active label

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `enableChatPersistence` | `true` | Persist conversations to vault |
| `chatRootFolder` | `'AI Chat'` | Root folder under plugin folder |
| `chatRetentionDays` | `30` | Days before conversations are pruned |

### Tests

- `tests/attachmentIndexService.test.ts`
- `tests/chatPersistenceUtils.test.ts`
- `tests/conversationCompaction.test.ts`
- `tests/globalMemoryService.test.ts`
- `tests/indexingChoiceModal.test.ts` (13 tests: waitForChoice, DOM structure, onClose cleanup)
- `tests/localOnnxEmbeddingService.test.ts`
- `tests/projectService.test.ts`
- `tests/projectServicePersistence.test.ts` (8 tests: saveIndexedDocument, loadIndexedDocuments)

Total: 3375 unit tests (136 suites)

### Key Patterns

- **ONNX fallback**: `embeddingServiceFactory` falls back to `LocalOnnxEmbeddingService` when provider needs API key but none configured — zero-setup path
- **Bundled ONNX**: `@xenova/transformers` must be in bundle, not external — Obsidian plugins cannot access `node_modules` at runtime
- **resolveProviderAndModel()**: always check `serviceType === 'local'` before reading cloud settings for token budgets
- **Single-flight guard**: `IndexingChoiceModal.resolved` flag prevents double-resolution on multiple `onClose()` calls
- **clearProjectContext()**: must dispose `indexMode === 'project'` attachments to prevent memory leaks on project switch
- **saveNow in onClose**: critical for conversations closed within the 1-second debounce window

## Newsletter Digest

**Status**: ✅ Tier 1 Implemented (March 2026)

### Overview

Fetches unread Gmail newsletters via a deployed Google Apps Script (single `doGet` with `action` parameter: default fetches unread, `action=confirm` marks read + archives). Triages each newsletter with AI and writes individual notes + a rolling daily digest.

### Core Components

- `src/services/newsletter/newsletterService.ts`: `fetchFromAppsScript()` passes `?label=...&limit=...` query params; `fetchAndProcess()` sets `hitLimit` flag; `createVaultNotes()` appends `## Key Links` section (top 10 content links, spam-filtered via `extractNewsletterLinks()`); `buildDigestEntry()` writes digest line
- `src/services/newsletter/newsletterTypes.ts`: `NewsletterFetchResult` with `hitLimit: boolean`; `ProcessedNewsletter` with `_rawBody?: string`
- `src/commands/newsletterCommands.ts`: `registerNewsletterCommands()` registers `newsletter-fetch`; `showNewsletterFetchResultNotice()` shows hit-limit warning when fetch count reached limit
- `src/main.ts`: `newsletterLastFetchTime` public field; `startNewsletterScheduler()` / `stopNewsletterScheduler()` / `runScheduledNewsletterFetch()` — interval-based auto-fetch with overdue-check on startup
- `src/ui/settings/NewsletterSettingsSection.ts`: Gmail label, fetch limit dropdown, Test Connection button (uses static `requestUrl` import), auto-fetch toggle + interval, Last Fetched display, Reset Import History

### Key Patterns
- **GET-only Apps Script**: Single `doGet` routes on `action` param (`fetch` default, `confirm` marks read + archives via `getThread().moveToArchive()`). POST was removed — Apps Script redirects POST (302→GET) dropping the body
- **Seen-ID dedup**: persisted in plugin data (`newsletter-seen-ids`); in-memory cache on plugin object
- **HTML login detection**: `response.text.trimStart().startsWith('<')` → throws actionable error before `JSON.parse`
- **Static requestUrl**: must use static import from `'obsidian'` — dynamic `import('obsidian')` hangs in bundled plugins
- **Auto-fetch scheduler**: `setInterval` + overdue-check on startup; stopped in `onunload()`

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `newsletterEnabled` | `false` | Master toggle |
| `newsletterSource` | `'apps-script'` | Connection method |
| `newsletterScriptUrl` | `''` | Deployed Apps Script URL |
| `newsletterGmailLabel` | `'Newsletters'` | Gmail label to fetch from |
| `newsletterFetchLimit` | `20` | Max emails per fetch (10/20/30/50) |
| `newsletterAutoFetch` | `false` | Background auto-fetch |
| `newsletterAutoFetchIntervalMins` | `60` | Interval in minutes |
| `newsletterOutputFolder` | `'Newsletter Inbox'` | Subfolder under plugin folder |
| `newsletterAutoTag` | `false` | Run AI tagging after import |

### Commands
- `newsletter-fetch`: Fetch newsletters now — in Command Picker → Capture

### Tests
- `tests/newsletterServiceIntegration.test.ts` (27 tests): fetch pipeline, seen-ID dedup, two-phase confirmation, HTML detection, key links extraction, hit-limit flag

**Plan**: [docs/completed/newsletter-digest-plan.md](docs/completed/newsletter-digest-plan.md)

## Speaker-Aware Transcription UX

**Status**: ✅ Implemented (May 2026) — v1 closes Pat persona-test P0s + P1

### Overview

Audio-attach trio in Minutes modal, dedicated Transcribe-audio command, SpeakerReviewPanel with audio preview + rename + Same-as merge, deterministic action-attribution post-pass. Closes the three P0 findings + the P1 from persona-test session `pat-transcription-speakers`: Transcribe-as-a-verb is discoverable, attaching audio from any context works (including mobile webview file input), and action owners derive from "who actually said it" instead of LLM inference alone.

### Core Components

**Canonical transcript contract** (`src/services/transcriptTypes.ts`):
- `TimedTranscript` — Whisper `verbose_json` output with real timestamps + BCP-47 `languageCode`. Producer: `audioTranscriptionService.transcribeAudio*()`. Consumer: `labelSpeakersTimed()`.
- `LabelledTimedTranscript` — segments with `speaker?: string` per segment + `speakers[]` in first-appearance order.
- `timestampSource: 'whisper-verbose-json' | 'none'` — drives preview suppression. When `'none'`, downstream components hide audio preview entirely (R1 H2 contract).

**Speaker labelling** (`src/services/speakerLabellingService.ts`):
- `labelSpeakersTimed(plugin, timed, participants, meetingContext?)` — wraps the existing string-based LLM labeller in a TimedTranscript pipeline. Word-stream positional walker (`mapLabelledTextToSegments`) maps LLM-emitted `Name: text` lines back to Whisper segments.
- `transcriptionResultToTimedTranscript(result, fallbackLanguageCode)` — adapter from existing `TranscriptionResult` to the canonical contract. Prefers `result.language` (Whisper's `detected_language`) when present.

**Audio attach pipeline** (presentational + orchestration split per R1 M3):
- `src/ui/utils/AudioSourcePicker.ts` — three platform-aware adapters: `pickAudioFromDesktop()` (Electron `@electron/remote`), `pickAudioFromMobileWebview()` (programmatic `<input type="file" accept="audio/*">`), `pickAudioFromVault()` (FuzzySuggestModal filtered to audio). Returns unified `AudioSource` discriminated union (`vault | desktop-path | webview-blob | recorder`).
- `src/ui/coordinators/AudioAttachCoordinator.ts` — single orchestration owner: picker dispatch, `importToVault()` delegation, `attachPreview()` lifecycle. `dispose()` in `Modal.onClose()` revokes all object URLs.
- `src/ui/coordinators/AudioPreviewSource.ts` — `resolvePreview(source, app)` returns `AudioPreviewHandle { url, dispose }`. Vault → `app.vault.getResourcePath()`; desktop-path → `file://` URL; blob → `URL.createObjectURL` + idempotent `revokeObjectURL` on dispose.
- `src/services/audio/audioImportService.ts` — `importAudioToVault(app, source, opts)` writes non-vault audio sources to the vault (MIME whitelist, collision-safe suffix, AbortSignal → trash partial writes via `fileManager.trashFile`).
- `src/ui/components/AudioAttachHelper.ts` — strict presentational component. Renders trio + per-item rows per `AudioAttachViewState` discriminated union. All intents emit via callbacks.
- `src/ui/components/speakerReviewState.ts` — discriminated unions (`AudioAttachViewState`, `SpeakerReviewState`, `AudioAttachItem`, `DetectedSpeaker`) + pure derivations (`canGenerateMinutes`, `deriveSpeakerDetectionStatus`, `areSpeakersVerified`).

**Speaker review surface** (`src/ui/components/SpeakerReviewPanel.ts`):
- Renders one row per `DetectedSpeaker` with audio preview (5-second time-fragment URI from real Whisper `startMs`), rename input + participant datalist, Same-as merge dropdown.
- Preview suppressed when `timestampsAvailable === false` OR preview handle is null — explanatory subtext shown instead of misleading clips.
- Confirm validates every row has a name before firing `onConfirm(mapping)`; Skip fires immediately.
- Banners for `failed` / `detection-failed` / `detection-unavailable` states; user-skip is silent.

**TranscribeOnlyModal** (`src/ui/modals/TranscribeOnlyModal.ts`):
- Slim purpose-built modal: attach → transcribe → confirm speakers → save `.md` note with `type: transcript` frontmatter. Distinct from `MinutesCreationModal` because the user might want JUST a labelled transcript (no meeting metadata, no minutes generation).
- Composes (not duplicates) `AudioAttachCoordinator` + `AudioAttachHelper` + `labelSpeakersTimed` + `SpeakerReviewPanel` + `writeTranscriptNote`.
- Save gated on labelled transcript + terminal speaker-review state.

**Transcript-note format** (`src/services/transcriptNoteService.ts`):
- Zod-validated `TranscriptNoteFrontmatterSchema` (type / audio / language / duration_seconds / speakers / speakers_verified / speaker_detection_status / timestamp_source / created_at).
- Body: `## Transcript` heading + HTML-comment-fenced `enc=base64[+gzip]` payload + human-readable markdown rendering below.
- **Always base64-encoded** (Gemini-r1 G5 injection guard) so transcripts containing literal `-->` can't break the comment fence. Payloads >32KB use base64+gzip via `CompressionStream`.
- **Async** (Gemini-r2 G1) because browser-native gzip is stream-based async.

**Deterministic action attribution** (`src/services/speakerAttribution/`):
- `applyDeterministicAttribution(input, languageCode): Result<AttributionResult>` runs as a post-pass in `minutesService.generateMinutes` AFTER `parseMinutesResponse` returns.
- Phase 1: `provenanceBackfill.attemptBackfill(action, labelled)` — for actions missing `source_timecodes`, runs token-set Jaccard similarity over a sliding 3-segment window. Match ≥0.35 fills timecodes; below threshold drops confidence to 'low' + emits `missing-provenance` flag.
- Phase 2: `getStrategyForLanguage(code)` dispatches to per-language strategy. English (`'en'` / `'en-*'`) → three rules in priority order:
  1. Provenance + first-person → owner = `speakerMapping[segmentSpeaker]`
  2. Third-person → owner = captured proper noun (case-normalised to canonical participant spelling)
  3. LLM owner not in participants → rewritten to "TBC" + `non-participant-owner` flag
- All other languages route to `NoOpAttributionStrategy` which emits a single `unsupported-language` flag (visible warning, not silent skip).
- Adding a new language: implement `SpeakerAttributionStrategy` in a sibling file + add a case to `registry.ts`. No orchestrator changes.

### Wiring

- `MinutesCreationModal` instantiates `AudioAttachCoordinator` in `onOpen()` (target folder `AI-Organiser/Imports/`), disposes in `onClose()`. Renders helper + speaker review slot at top. After successful transcription: `transcriptionResultToTimedTranscript(result, result.language || setting || 'und')` → `runSpeakerLabelling()` → transitions `speakerReview` state. Submit button class `.ai-organiser-minutes-submit` gated via `canGenerateMinutes()` pure derivation.
- `MinutesGenerationInput` extended with optional `labelledTranscript`, `transcriptLanguageCode`, `speakerMapping`, `speakersVerified`, `speakerDetectionStatus`. `MinutesJSON.metadata` extended with `speakers_verified?` + `speaker_detection_status?` for renderer passthrough (Gemini G4).
- `TranscribeOnlyModal` registered via `src/commands/transcribeCommands.ts` → `ai-organiser:transcribe-audio` command + picker leaf in `create-write` sub-group (after `create-meeting-minutes`). Aliases on both leaves: `['transcribe', 'audio', 'speech-to-text', 'whisper', 'minutes']` so users typing the natural verb find either.
- `transcriptOutputFolder` setting (default `'Transcripts'`) + `getTranscriptOutputFullPath()` helper mirror the existing minutes-folder pattern.

### Key Patterns

- **Discriminated unions over boolean soup** (R1 M1): `AudioAttachViewState` + `SpeakerReviewState` replace `speakerMapping | speakersVerified | speakersTouched | lastTranscribedAudioUrl`. CTA enablement is a pure derivation, not a stored flag.
- **Presentational vs orchestration split** (R1 M3): `AudioAttachHelper` + `SpeakerReviewPanel` have NO service imports. Hosts wire callbacks. `AudioAttachCoordinator` owns picker dispatch + preview lifecycle.
- **Single-source rule for speaker metadata** (R3 M3): transcript-note frontmatter is canonical. Minutes inherit via `MinutesGenerationInput` → `MinutesJSON.metadata` → rendered frontmatter without mutation.
- **Real timestamps or no preview** (R1 H2): when `timestampSource === 'none'`, `SpeakerReviewPanel` suppresses audio preview controls entirely. No estimate fallback.
- **Graceful degradation everywhere**: missing `labelledTranscript` → attribution emits a warning, doesn't throw. Missing `source_timecodes` → backfill or `confidence='low'` flag, never aborts. Unsupported language → NoOp + flag, action owners preserved.

### Tests (155 added across F0-F5)

- `tests/audioImportService.test.ts` (11), `tests/audioAttachCoordinator.test.ts` (13), `tests/audioAttachHelper.test.ts` (16), `tests/audioSourcePicker.test.ts` (21), `tests/audioPreviewSource.test.ts` (12), `tests/filePickers.test.ts` (13), `tests/transcriptTypes.test.ts` (10), `tests/transcriptNoteService.test.ts` (9), `tests/speakerLabellingTimed.test.ts` (14), `tests/speakerReviewPanel.test.ts` (21), `tests/speakerAttributionProvenanceBackfill.test.ts` (6), `tests/speakerAttributionEnglishStrategy.test.ts` (12), `tests/speakerAttributionRegistry.test.ts` (12), `tests/documentControllerAddDocuments.test.ts` (4), `tests/documentMultiPickerModal.test.ts` (5), `tests/commandPicker.test.ts` extended

### Live verification

Persona-test session `pat-transcription-speakers-v3` against `AI-Organiser/Recordings/hamina-board-first-20min.mp3` (20-min Finnish board meeting). Full flow: picker → trio → vault pick → transcribe → SpeakerReviewPanel with 2 detected speakers + real Whisper-timestamp previews → Skip → save → transcript note opened in workspace with valid `TranscriptNoteFrontmatterSchema` frontmatter + base64+gzip body. Screenshots in `scripts/persona-harness/sessions/pat-transcription-speakers-v3/`.

**Plan**: [docs/completed/speaker-aware-transcription-ux.md](docs/completed/speaker-aware-transcription-ux.md) — 5 audit rounds (3 GPT + 2 Gemini), 32 findings accepted + fixed, severity decreased each round.

## Reviewed Edits Modal

**Status**: ✅ Implemented (March 2026)

### Overview

Inline diff review shown before any write command (Improve Note, Translate, Integrate Pending) modifies the active note. User sees a GitHub-style diff and chooses Accept, Copy to Clipboard, or Reject.

### Core Components

- `src/ui/modals/ReviewEditsModal.ts`: `ReviewEditsModal` extends `Modal`; takes `DiffLine[]`, `DiffStats`, `newContent`, and `onAction` callback; `simulateAction()` for testing; ESC-safe `onClose()` fires reject if no action taken
- `src/utils/reviewEditsHelper.ts`: `showReviewEditsModal()` helper that wraps `computeLineDiff()` + modal open into a single awaitable call
- `src/commands/smartNoteCommands.ts`, `translateCommands.ts`, `integrationCommands.ts`: call `showReviewEditsModal()` before applying writes when `settings.reviewEditsEnabled`

### Key Patterns
- **Action types**: `'accept' | 'copy' | 'reject'` — copy writes to clipboard without modifying note
- **Double-fire guard**: `actionFired` boolean prevents `onClose()` from re-firing after button click
- **Diff rendering**: prefix gutter (`+`/`−`) in separate `<span>`, content in separate `<span>` — allows independent CSS targeting
- **Stats chips**: color-coded pills using `color-mix(in srgb, var(--color-green/red) 15%, transparent)` — adapts to light/dark mode
- **Diff tints**: `color-mix(in srgb, var(--color-green/red) 10%, transparent)` for line backgrounds — no hardcoded RGB, fully theme-adaptive

### Settings
| Setting | Default | Description |
|---------|---------|-------------|
| `reviewEditsEnabled` | `true` | Show diff review before applying writes |

### Tests
- `tests/reviewEditsHelper.test.ts`: helper wiring, action dispatch
- `tests/reviewEditsModal.test.ts`: action dispatch, ESC safety, double-fire guard

**Plan**: [docs/completed/reviewed-edits-plan.md](docs/completed/reviewed-edits-plan.md)

## Deepgram Nova-3 Acoustic Diarization (v2)

**Status**: ✅ Implemented (May 2026) — opt-in extension of v1 speaker-aware transcription. Whisper remains the universal default and the only mobile path.

### Overview

Opt-in acoustic speaker diarization via Deepgram Nova-3, gated twice (settings provider + per-session checkbox) and isolated behind a `DiarizationProvider` interface so v3 can swap in Speechmatics/AssemblyAI without touching modal code.

When the user attaches audio with "Identify speakers" checked, the coordinator bypasses Whisper + `labelSpeakersTimed()` entirely and POSTs the bytes to Deepgram's `/v1/listen?model=nova-3&diarize=true&utterances=true&detect_language=true&smart_format=true&punctuate=true&mip_opt_out=true`. Per-utterance speaker labels land directly in `LabelledTimedTranscript` and feed the existing `SpeakerReviewPanel` unchanged.

### Core Components

- `src/services/diarization/types.ts`: `DiarizationProvider` interface, `DiarizationOptions { signal?, languageHint?, timeoutMs?, filename?, mimeType? }`, `DiarizationResult { labelled, transcriptText, durationSec, detectedLanguage, provider, actualCostUsd }`, `DEEPGRAM_COST_PER_MIN_USD = 0.0043`, `DEEPGRAM_MAX_FILE_BYTES = 200 MB`, `DEEPGRAM_LARGE_FILE_WARN_BYTES = 100 MB`.
- `src/services/diarization/deepgramAdapter.ts`: `DeepgramAdapter implements DiarizationProvider`. Uses Obsidian `requestUrl` via the shared `abortableRequestUrl` wrapper. Cost computed deterministically from `metadata.duration` (Deepgram's response has no cost field). Seconds→ms conversion (`startMs = Math.round(utt.start * 1000)`). 1-indexed `Speaker N` labels for UX parity with Whisper+LLM path. Retry-on-429 with injectable `_sleeper?` and `_jitter?` test hooks (3 attempts max, base backoffs 1s/4s). Transport-rejection classification (`network-dns` / `network-tls` / `network-csp` / `network-offline` / `network-other:<msg>`). 5xx payload sanitization (truncated 200 chars, headers redacted).
- `src/ui/coordinators/AudioAttachCoordinator.ts`: extended with `setDiarizationOptIn(value)` / `shouldUseDiarization()` / `canTranscribeNow()` (single-file constraint when opt-in active — Deepgram speaker IDs are per-request) / `getUpfrontSourceSize(source)` (returns size hint from `File.size` / `Blob.size` / `TFile.stat.size`, null for webview-blob) / `estimateAudioCostUsd()` / `formatCostPreview()` / `transcribeDiarized(item, apiKey, signal?)`. Constructor accepts optional `provider?: DiarizationProvider` for DIP — production uses singleton `deepgramAdapter`, tests inject mocks.
- `src/ui/components/AudioAttachHelper.ts`: extended `AudioAttachOptions` with `diarizationToggle?: { visible, checked, disabled, costPreviewText, onChange }`. Pure presentational addition — host owns state.
- `src/ui/modals/DiarizationPrivacyModal.ts`: first-time-per-session disclosure with 3-state outcome (accept / reject / ESC-as-reject). On reject, leaves `plugin.diarizationDisclosureShownThisSession = false` so user can re-trigger by re-checking. Modal does NOT re-fire during the same toggle gesture (only on `unchecked → checked` transition).
- `src/services/transcriptNoteService.ts`: schema extended with optional `diarization_provider: 'deepgram'`, `diarization_cost_usd: number`, `diarization_language: string`. All absent → byte-identical to v1 Whisper notes.
- `src/services/apiKeyHelpers.ts`: `getDeepgramApiKey(plugin)` follows the SecretStorage 3-level pattern but **MUST pass `useMainKeyFallback: false`** — Deepgram has no main-LLM equivalent; without this flag `resolveApiKey` returns the user's Claude key and triggers `http-401`.

### Key Patterns

- **Whisper-stays-forever (user-facing promise)**: default `audioDiarisationProvider='none'` runs the unchanged v1 path. Checkbox hidden on `Platform.isMobile`. Per-session checkbox starts unchecked even when Deepgram configured. Multi-file attach disables Transcribe when opt-in active (single-file constraint via `canTranscribeNow()`). Mobile users keep Whisper indefinitely.
- **Diarization opt-in lives on the modal, not the coordinator**: `rerenderModal()` recreates the coordinator on every audio attach. Storing `diarizationOptedIn` only on the coordinator would silently wipe the user's choice. The modal keeps `private diarizationOptedIn = false` and re-applies it via `setDiarizationOptIn()` after every coordinator construction in `onOpen()`.
- **`useMainKeyFallback: false` is critical** for any specialist provider without a main-LLM analogue. Without it, `resolveApiKey` falls through to the user's main LLM key. Discovered during live persona testing.
- **Single-file constraint**: Deepgram's speaker IDs (0, 1, 2...) are scoped to a single API request. Multi-file batching would silently corrupt speaker identity across chunks. v2 enforces single-file at coordinator level; Whisper path unchanged.
- **Cost is computed, not provider-reported**: `actualCostUsd = (durationSec / 60) * DEEPGRAM_COST_PER_MIN_USD`. Null fallback only when `metadata.duration` missing; transcript-note frontmatter omits the field when null.
- **Sanitized fixture (no PII)**: `tests/fixtures/diarization/deepgram-sanitized-20min.json` preserves SHAPE only — utterance text replaced with `<utterance-N>` placeholders, speaker IDs / timings / confidence / languages preserved verbatim. Generated once via `scripts/spikes/sanitize-diarization-fixture.mjs`.
- **Honest abort semantics**: `abortableRequestUrl` stops the adapter from awaiting locally, but does NOT cancel the in-flight upload — Deepgram MAY still bill. Surfaces honestly via `'aborted'` / `'timeout'` error codes.

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `audioDiarisationProvider` | `'none'` | `'none'` (Whisper only) / `'deepgram'`. `'assemblyai'` stays in the enum but reverts via Notice (R4 M2). |
| `deepgramApiKey` | `''` | Transient plaintext field — migrated to SecretStorage on save via `persistApiKeysToSecretStorage()`. |
| `diarizationDisclosureShownThisSession` | `false` (plugin-instance field, not in settings) | Resets on plugin reload. Drives whether the privacy modal fires on opt-in. |
| `diarizationLargeFileWarningShownThisSession` | `false` (plugin-instance field) | Notice fires once per session above `DEEPGRAM_LARGE_FILE_WARN_BYTES` (100 MB). |

### i18n

New top-level namespace `t.diarization` with 13 keys (EN + ZH-CN parity verified by `npm run test:auto`). Cost-preview template uses `{cost}` substitution with pre-formatted formatter output — `~$X.XX` always 2 decimals with `~$0.01` floor.

### Commands

No new commands — opt-in via the existing `ai-organiser:create-meeting-minutes` (and `ai-organiser:transcribe-audio` from v1) modals.

### Tests

- `tests/diarization/deepgramAdapter.test.ts` (23 tests): happy path against sanitized fixture, all error codes (401/429/500/malformed/no-utterances/empty/aborted), retry policy with mocked sleeper (proves base backoffs `[1000, 4000]`), transport rejection classification, MIME override, JSON-path parsing.
- `tests/diarizationPrivacyModal.test.ts` (6 tests): accept/reject/ESC dispatch, double-fire guard, body mentions `mip_opt_out` literally.
- Live persona harness: `scripts/persona-harness/pat-diarization-v2-rerun.mjs` drives the end-to-end opt-in flow against `AI-Organiser/Recordings/hamina-board-first-20min.mp3` — verifies checkbox renders + privacy modal fires + opt-in survives `rerenderModal()` + Deepgram path routes + transcript-note frontmatter contains `diarization_provider: deepgram`, `diarization_cost_usd: 0.086`, `diarization_language: en`.

**Plan**: [docs/completed/deepgram-diarization-v2.md](docs/completed/deepgram-diarization-v2.md) — 4 GPT-5.4 audit rounds + 3 Gemini final-review rounds, 43 findings, all fixed before implementation. Two additional bugs caught + fixed during live persona testing (rerender state-wipe + useMainKeyFallback default).

## Read-this-note LLM Enhancement (audioNarration extension)

**Status**: ✅ Implemented (May 2026) — opt-in pre-stage of `prepareNarration` that summarises mermaid diagrams + large tables + expands acronyms before TTS. Default off; zero behaviour change for existing users.

### Architecture

Strictly additive to the existing `src/services/audioNarration/` module. The LLM pre-stage feeds CLEANED MARKDOWN into the existing deterministic `transformToSpokenProse` transformer — does NOT replace it. The transformer is still the single source of truth for sentence/section boundaries and TTS chunking.

> **Spoken-content modes (wired 2026-06-07)**: `transformToSpokenProse` accepts `codeBlockMode`/`tableMode`/`imageMode`. These are now threaded from settings via `proseOptionsFromSettings(plugin)` at BOTH call sites (`prepareNarration` + the LLM-enhanced path) and exposed as Code blocks / Tables / Images dropdowns in `AudioNarrationSettingsSection`. Defaults equal `DEFAULT_PROSE_OPTIONS` (`placeholder`/`row-prose`/`alt-text`), so a user who never changes them gets byte-identical spokenText and an unchanged narration fingerprint. (Previously the settings existed but were never read — dead config.)

Two-stage flow (R1 H2 fix — no billing before consent):
```
narrate-note command
  → prepareNarration(plugin, file)          [pure; NO LLM call, NO key in PreparedNarration]
      → vault.read(file) → rawMarkdown
      → transformToSpokenProse(raw) → spokenText for TTS-cost estimate
      → if mode='on' AND hasLlmEnhancementKey(): set llmIntent + estimateLlmEnhancementCostUsd
      → fingerprint MODE-BRANCHED:
          off-mode → sha256([file.path, spokenText, voice, modelId, PREPROCESSOR_VERSION=1])  ← BYTE-IDENTICAL v1
          on-mode  → sha256([file.path, mtime, voice, modelId, llmIntent.providerId, ..., 'llm-on'])
  → CostConfirmModal — extra rows shown only when llmIntent set:
      • AI cost line ($ amount)
      • Variance hint ("Final TTS cost may vary ±15%")
      • Privacy hint ("Your note will be sent to <provider>")
  → user confirms → executeNarration(plugin, prepared, { signal, onProgress })
      → TOCTOU mtime re-check → STALE_PREPARED if file changed during modal
      → if prepared.llmIntent AND settings still match (R3 H2):
          resolveLlmEnhancementApiKey(plugin, providerId) → apiKey
          enhanceMarkdown(rawNote, provider, apiKey, {onChunkComplete}, signal)
            → splitByH2 (fence-aware: skips ## inside code/mermaid/frontmatter/callouts)
            → 4-parallel via mapWithConcurrency(signal-aware)
            → per-chunk retryWithBackoff on 429/503 (1s/4s ±25% jitter + Retry-After honour)
            → graceful: failed chunk → original markdown pass-through + warning
            → total failure → Result.err → caller falls back to literal
          → hard cap: enhancedSpokenText.length > rawNote.length * 1.2 → reject, warn
          → spokenText = transformToSpokenProse(enhancedMarkdown)
      → TTS synth + MP3 write + syncEmbed (unchanged from v1)
      → return NarrateOutcome { ..., warnings: NarrationWarning[] }
  → command renders one Notice per warning code via t.audioNarration.enhancement.warnings[code]
```

### Core Components

- `src/services/audioNarration/llmEnhancerPrompts.ts`: XML-structured prompt (`<task>`, `<requirements>`, `<output_format>`); `LLM_ENHANCEMENT_PROMPT_VERSION` salts on-mode fingerprint; `neutraliseEnvelopeMarkers` (audit-code M8) zero-width-spaces user-supplied envelope tags to prevent prompt injection.
- `src/services/audioNarration/llmEnhancerProvider.ts`: `LlmEnhancementProvider` interface + Gemini Flash + Claude Haiku impls. All HTTP via `abortableRequestUrl`. Discriminated `EnhancerCallOutcome` (not `Result<T>`) carries per-call metadata — safe for concurrent invocation (Gemini G2-H1 race fix). Gemini uses `gemini-flash-latest` URL alias + `x-goog-api-key` HEADER (audit-code H10 — not URL query). Haiku resolves newest via `/v1/models` query, cached per-account (audit-code M15).
- `src/services/audioNarration/llmMarkdownEnhancer.ts`: `splitByH2` fence-aware splitter (skips `## ` inside code/mermaid/frontmatter/callouts). `enhanceMarkdown` orchestrates 4-parallel chunks with signal-aware worker pool (audit-code H7 — drops queued chunks on abort), `retryWithBackoff` shared from `tts/ttsRetry`, `onChunkComplete` throw-guard (audit-code M16), graceful per-chunk fallback.
- `src/services/audioNarration/audioNarrationService.ts`: `prepareNarration` extended to estimate LLM cost without calling the LLM and snapshot `llmIntent` (provider + sentinel, NOT key). `executeNarration` runs the LLM AFTER cost confirmation with TOCTOU mtime check, settings-race intent validation, hard cap on enhanced length.
- `src/services/apiKeyHelpers.ts`: `hasLlmEnhancementKey` (boolean, no key exposure) + `resolveLlmEnhancementApiKey` (primitive `string | null`, no audioNarration types imported — avoids upward layering violation per Gemini G2-M2). Both pass `useMainKeyFallback: false` (Deepgram v2 lesson). Optional `llmEnhancerReuseYoutubeKey` toggle reuses the full `getYouTubeGeminiApiKey` chain (Gemini G2-M1).
- `src/services/audioNarration/narrationCostEstimator.ts`: `estimateLlmEnhancementCostUsd(noteChars, provider)` — deterministic char-based math; no LLM call.

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `audioNarrationLlmEnhancement` | `'off'` | Master toggle. Off = zero behaviour change. |
| `audioNarrationLlmProvider` | `'gemini'` | `'gemini'` (Gemini Flash, ~$0.01/long-note) or `'haiku'` (~$0.10). |
| `llmEnhancerGeminiApiKey` | `''` | Transient; migrated to SecretStorage on save. |
| `llmEnhancerAnthropicApiKey` | `''` | Transient; migrated to SecretStorage on save. |
| `llmEnhancerReuseYoutubeKey` | `false` | Opt-in fallback to YouTube Gemini key when no dedicated key set. |

### Fingerprint discipline

`PREPROCESSOR_VERSION` stays at 1 (never bumped in this plan) — preserves all existing literal-mode caches. `LLM_ENHANCEMENT_PROMPT_VERSION` lives separately and salts only the on-mode fingerprint. Mode-branched inputs guarantee off-mode users get byte-identical hashes to v1.

### Tests

- `tests/audioNarration/llmMarkdownEnhancer.test.ts` (17 tests): fence-aware split, concurrency cap, partial/total failure, abort pre-check + mid-run abort, onChunkComplete throw-guard.
- `tests/audioNarration/llmEnhancerProvider.test.ts` (12 tests): Gemini (URL alias + x-goog-api-key header + cost from usage), Haiku (`/v1/models` discovery + cache + cost).
- `tests/audioNarration/llmEnhancerPrompts.test.ts` (6 tests): XML envelope, prompt-injection escape variants, escapeXml.
- `tests/fixtures/llmEnhancer/input-mermaid-heavy.md`: real-shape fixture with H1 + 2 H2s + mermaid + table + frontmatter + callout.

### Key Patterns

- **Default off; explicit opt-in**: zero behaviour change for existing users. Per Whisper-stays-forever rule.
- **LLM call AFTER consent, NEVER in prepare** (R1 H2): cost-confirmation modal shows the estimate; LLM runs only if the user clicks Generate.
- **Provider identity in `PreparedNarration`, key in `executeNarration` only** (R2 M1): `llmIntent` carries `{ providerId, modelSentinel }` only; key resolution happens at execute time.
- **Mode-branched fingerprint** (R2 H2 + Gemini G-M1): off-mode tuple is byte-identical to v1; on-mode uses distinct `'llm-on'` domain.
- **Hard cap on enhanced output** (R3 H4 + Gemini G-H1): `enhanced.length > rawNote.length * 1.2` (4 KB floor) — prevents prompt-injection cost blowout. Compare to RAW markdown length, NOT stripped spokenText (which collapses diagrams to "[diagram omitted]" — would yield false-positive rejection).
- **`useMainKeyFallback: false` always** (Deepgram v2 lesson): Gemini/Haiku enhancer keys never silently use the user's main LLM key.
- **`abortableRequestUrl` for ALL outbound HTTP** (audit-code H8/H12): cancellable, consistent.
- **`x-goog-api-key` header for Gemini** (audit-code H10): never in URL query (leaks to logs).
- **Per-account Haiku model cache** (audit-code M15): keyed by `apiKey.slice(0, 16)` so multi-account users don't cross-contaminate.
- **Prompt-injection escape** (audit-code M8): user notes containing `</note_section>` or other envelope tags get zero-width-space-separated to prevent them closing the prompt envelope early.
- **Signal-aware worker pool** (audit-code H7): workers re-check `signal.aborted` before picking up each chunk; queued work drops on abort.

**Plan**: [docs/completed/read-this-note-llm-enhancement.md](docs/completed/read-this-note-llm-enhancement.md) — 3 GPT-5.4 audit rounds + 2 Gemini final-review rounds (27 plan findings) + 1 audit-code round (7 in-scope post-impl fixes), all addressed.

## Anthropic Prompt Caching (Phases 1/2/2c/3)

**Status**: ✅ Implemented (May 2026) — Claude-only, opt-in per call

### Overview

The Claude adapter emits `cache_control: {type: 'ephemeral'}` markers on stable prompt prefixes so repeat calls within the 5-minute TTL read prefix tokens at 0.1× the input cost instead of 1× (Anthropic's 90% cache-read discount). Cache writes cost 1.25× — we only emit the marker when the prefix clears the per-model minimum (4096 chars for Sonnet/Opus, 8192 for Haiku) so we never pay the write penalty for a prefix Anthropic would silently refuse to cache.

### Architecture

**Provider-neutral API** ([src/services/types.ts:96-127](src/services/types.ts)):
- `SummarizeOptions.stablePrefix?: string` — optional cacheable prefix
- Callers pass volatile content via `prompt`, stable content via `stablePrefix`
- Non-Claude providers (Gemini, OpenAI) silently concatenate via `effectivePrompt` in [src/services/cloudService.ts:518-595](src/services/cloudService.ts) — no caller-side branching needed

**Claude-specific shaping** ([src/services/cloudService.ts:632-720](src/services/cloudService.ts)):
- `buildClaudeSystemAndUser(systemPrompt, prompt, modelName, stablePrefix)` helper returns `{ systemField, userContent }`
- Above threshold: `systemField = [{type:text, boilerplate}, {type:text, stablePrefix, cache_control:{type:'ephemeral'}}]`, `userContent = prompt`
- Below threshold OR no stablePrefix: `systemField = string boilerplate`, `userContent = stablePrefix ? `${stablePrefix}\n\n${prompt}` : prompt`
- Composes with adaptive thinking — both can be present in the same body

**Cache usage instrumentation** ([src/services/adapters/claudeAdapter.ts:151-167, 206-225](src/services/adapters/claudeAdapter.ts)):
- `logCacheUsage(usage, source)` called from `parseResponseContent` (non-streaming) and `parseStreamingChunk` on `message_start`
- Format: `[Cache] claude {response|stream-start} model=X in=N cache_write=N cache_read=N out=N`
- Routes through `logger.debug` — silent in production, visible when `debugMode` is on
- Foundation for measuring hit rates without external metrics pipeline

### Wired call sites

| Site | File | Stable header | Volatile payload |
|---|---|---|---|
| Minutes chunked extraction (Phase 2) | [minutesService.ts:587-606](src/services/minutesService.ts) | `buildChunkExtractionPrompt({dictionary, agenda, participants, contextSummary, ...})` | per-chunk transcript |
| Minutes single-call (Phase 2c) | [minutesService.ts:302-336](src/services/minutesService.ts) | `getStyleSystemPrompt({...})` | `buildMinutesUserPrompt({...meta, transcript, ...})` JSON |
| Minutes consolidation (Phase 2c) | [minutesService.ts:672-700](src/services/minutesService.ts) | `buildStyleConsolidationPrompt({...})` | `JSON.stringify(consolidationPayload)` |
| Minutes intermediate-merge (Phase 2c) | [minutesService.ts:909-919](src/services/minutesService.ts) | `buildIntermediateMergePrompt(mergeContext)` | `Extracts to merge:\n${JSON.stringify(batch)}` |
| Free Chat (Phase 3) | [FreeChatModeHandler.ts:203-333](src/ui/chat/FreeChatModeHandler.ts) | auto-memory instruction + global memory + project instructions/memory/files + flat attachments | conversation history + RAG retrieval + question |

### Where caching pays off

- **Chunked minutes** (90-min meeting → 12+ sequential calls): 1 write + 11 reads = ~80% prefix-token cost reduction
- **Truncation retries** (`retryIfTruncated` re-fires with same prefix + larger maxTokens): write on attempt 1, read on attempts 2-3
- **Regeneration** (user re-runs minutes for same meeting after tweaking persona / re-running on Low-coverage warning): cache_read across runs within TTL
- **Multi-turn chat** (project mode with substantial instructions + attached files): write on turn 1, read on turns 2-N. TTL refreshes on every hit
- **Hierarchical merge** (multiple batches within one reduction pass): same merge header reused across batches

### Phase 3 — chat stable/volatile split discipline

Free Chat reorganised `buildPrompt` ([FreeChatModeHandler.ts:203-333](src/ui/chat/FreeChatModeHandler.ts)) so stable parts collect into one contiguous prefix, volatile parts into a separate suffix:

```
STABLE (eligible for cache_control):
  1. auto_memory_instruction          ← only when memory exists
  2. global_memory
  3. project_instructions
  4. project_memory
  5. project_files (pinned)
  6. flat attachments                  ← moved AHEAD of history to stay contiguous

VOLATILE (must come AFTER cache marker):
  7. conversation_history              ← grows per turn
  8. attachment_context (RAG retrieval) ← varies per query
  9. question                          ← the new user input
```

`SendResult.stablePrefix?: string` ([ChatModeHandler.ts:110-133](src/ui/chat/ChatModeHandler.ts)) carries the split; `UnifiedChatModal.processChatRequest` forwards it to `summarizeText` options when present.

### officeparser bundling fix (related)

Phase 2 work surfaced that officeparser was silently broken in the production bundle (cascade: `util.inherits is not a function` → `file-type` chain throws → esbuild's `__commonJS` caches half-initialised exports → all subsequent calls return broken module with missing `parseOffice`). Root cause: the original `electronBuiltinShimPlugin` in [esbuild.config.mjs:42-60](esbuild.config.mjs) wrote literal `require('util')` inside the shim, which esbuild's static scanner rewrote to point at the shim itself — infinite cycle, esbuild returned `{}`. Fixed by resolving require indirectly via `window.require || globalThis.require || null` so esbuild can't see the call site. Also added [src/stubs/tesseractNoop.cjs](src/stubs/tesseractNoop.cjs) and aliased `'tesseract.js' → stub` so officeparser's eager `require('tesseract.js')` (for OCR support we never use) doesn't pull in Web Worker spawning code that fails to bundle for Electron renderer. Diagnostic logging in [documentExtractionService.ts:148-172](src/services/documentExtractionService.ts) surfaces the actual exception on future officeparser load failures + defensively returns null when `parseOffice` is missing.

### Verifying caching is working

1. Enable Debug mode (Settings → AI Organiser → AI provider)
2. Open Dev Tools (Ctrl+Shift+I), filter Console by `Cache`
3. Run any Claude-routed flow that has a long stable prefix (Minutes with a loaded dictionary, chat with a project + memory + attached doc)
4. Look for `cache_write=N` on first call, `cache_read=N` on subsequent calls within 5 min
5. If `cache_write` stays 0: prefix is below the threshold (4096 chars for Sonnet/Opus, 8192 for Haiku) — add more stable context
6. If writes happen but `cache_read` stays 0 between calls: something dynamic is busting the prefix (timestamp? date? user-id?) — diff two consecutive prefixes

### Tests (25 new + 5 modified)

- [tests/claudeAdapterCacheUsage.test.ts](tests/claudeAdapterCacheUsage.test.ts) (10 tests): `logCacheUsage` fires correctly on both code paths, silent when `debugMode` off, graceful when `usage` field missing or response is null/undefined
- [tests/claudePromptCaching.test.ts](tests/claudePromptCaching.test.ts) (10 tests): body shape transformation, per-model thresholds (Sonnet 4096 / Haiku 8192), idempotency (same prefix → byte-identical system field across calls), no marker for non-Claude providers, composes with adaptive thinking
- `tests/freeChatModeHandler.test.ts` (5 new): stable/volatile split, prefix invariance across turns with same context, prefix-busting when memory is added between turns
- `tests/minutesService.test.ts` (5 updated): assertions migrated from `prompt`-only to combined `prompt + options.stablePrefix` (style instructions moved out of user message into stablePrefix)

### Key patterns
- **Threshold gate**: cloud service falls back to silent concatenation when stablePrefix < per-model minimum. Avoids paying 1.25× write penalty for a prefix Anthropic won't cache. Below-threshold callers get no behaviour change.
- **Fingerprint discipline**: same patterns from audio narration's `LLM_ENHANCEMENT_PROMPT_VERSION` salting apply here — any change before the cache marker busts the cache hash. Avoid embedding timestamps, dynamic IDs, or per-call counters in the stable prefix.
- **Volatile-after-stable invariant** (chat handler): test `freeChatModeHandler.test.ts` asserts `stablePrefix` is byte-identical between turns 1 and 2 when context doesn't change. The reorder of "flat attachments above history" is what makes this true — pre-Phase-3, attachments sat AFTER history, so the prefix wasn't contiguous.
- **Provider-neutral API**: `stablePrefix` on generic `SummarizeOptions` works for all providers. Claude uses it for `cache_control`; others silently concatenate. Adding Gemini context caching later doesn't require changing callers.

## Azure AI Foundry Providers

**Status**: ✅ Implemented (June 2026) — config-gated, default off

Two first-class providers for Azure AI Foundry, which exposes two surfaces under one resource + one API key (`azure-ai-foundry-key`):
- **`azure-claude`** — Claude via `/anthropic/v1/messages`, `Authorization: Bearer` + `anthropic-version: 2023-06-01`. Native Anthropic request/response (mirrors `ClaudeAdapter`).
- **`azure-openai`** — GPT chat + embeddings + Whisper via `/openai/v1/*` (model-based, model in body, no api-version) or `/openai/deployments/<dep>/...?api-version=` (deployment-based); `api-key` header. Mirrors `OpenAIAdapter`.

### Core components
- `src/services/adapters/azureClaudeAdapter.ts` / `azureOpenAIAdapter.ts` — thin variants of the public `claude`/`openai` adapters (auth header + endpoint + concrete default model differ; everything else identical). **Concrete default models, never `latest-*` sentinels** (Azure deployments lag; sentinel resolution is structurally absent on the Azure path).
- `src/services/azure/endpointResolver.ts` — single source of all Azure URLs (`getClaudeMessagesEndpoint`/`getOpenAIChatEndpoint`/`getOpenAIEmbeddingsEndpoint`/`getWhisperEndpoint`/`normalizeEndpointUrl`) + `isAzureMode(settings)` (= `cloudServiceType.startsWith('azure')`).
- `src/core/modelCatalog.ts` (+ `src/core/taskTypes.ts`) — model capabilities/defaults/aliases SSOT; embedding cross-dimension aliasing forbidden (would invalidate vector indexes).
- `src/services/azure/settingsValidator.ts` — pre-flight config validation (host-anchored `*.services.ai.azure.com` / `*.openai.azure.com`, https-only, deployment-name charset).
- `src/services/azure/azureConnectionTest.ts` — **live** connection test: real round-trips to all four surfaces (Claude / OpenAI chat / embeddings / Whisper-via-tiny-silent-WAV), per-surface `{ok, status, message}` with REDACTED messages (never echoes endpoint/key/headers).
- `src/services/azure/requestLimiter.ts` — `SimpleSemaphore` concurrency cap.

### Azure mode (auto-routing, no silent fallback)
`isAzureMode` (main provider is `azure-*`) auto-routes specialist services to the right Azure surface — both surfaces share one resource+key:
- **Audio → Azure Whisper**, **embeddings → Azure OpenAI**, **PDF → Azure Claude** (documents). **No silent fallback**: in Azure mode a missing/invalid Azure surface surfaces a clear error, never quietly borrows the user's personal key. **YouTube** genuinely needs a separate Gemini key (Azure has no path) — shown explicitly, not a fallback.
- Settings UI streamlines in Azure-first mode: provider choice lives in the Azure section; the generic provider config (endpoint/key/model/test) is suppressed (`displayCloudSettings` early-returns on `isAzureMode`); Specialist Providers show "handled by Azure". A "use a different provider" escape hatch reveals the full provider dropdown to switch (a switch, NOT a fallback).

#### Flexible per-capability Azure routing (azure-capability-flexibility, 2026-06-07)
Azure specialist routing is **config-driven, not hardcoded** — any user's Foundry (full / partial / no coverage) is handled, nothing fails silently. SSOT registry `src/services/azure/azureCapabilities.ts` declares the 5 specialist capabilities (transcription, embeddings, websearch, tts, youtube) with support level (full/partial/none), surface, BYO providers, and feature gates. Each is configured **3-state** per capability via `settings.azureCapabilities[id] = {mode: 'azure'|'byo'|'off', deployment?}` (the map is consulted ONLY in Azure mode; non-Azure byte-identical):
- **Resolution**: `resolveAzureCapability.ts` is the single decision owner — fail-closed off-Azure, **never-throws** (wraps the SSOT endpoint builders), `isByoConfigured` uses LOW-LEVEL SecretStorage/settings primitives (NOT the resolver-aware key helpers → no recursion), reason on the caller's stack (no shared-state race). Wired at each capability's existing resolution entry (`getAudioTranscriptionApiKey`, `getClaudeWebSearchKey`, `getYouTubeGeminiApiKey`, narration `prepareNarration`, newsletter podcast). `getAzureApiKey` extracted to `azure/azureKey.ts` to break the apiKeyHelpers↔resolver module cycle.
- **TTS now HAS an Azure path**: `azureSpeechTtsEngine.ts` (Azure OpenAI Speech, PCM via `getSpeechEndpoint` SSOT, `abortableRequestUrl`) — registered as the `internalOnly` `azure-openai` narration provider (not shown in the non-azure dropdown). Narration + newsletter podcast select it when `tts` capability = azure; byo → Gemini; off/unavailable → clear notice. (For a Foundry with no speech deployment, `mode:'azure'` → `unavailable('no-deployment')`.)
- **Web search works for azure-openai-main too** (Foundry Claude surface + a configured Claude deployment), gated on the websearch capability `mode==='azure'` (`researchSearchService` only hands the Claude adapter the azure base when `wsAzure`).
- **UI**: `AzureCapabilitiesSettingsSection` renders the per-capability rows (Use Azure deployment / Bring your own / Off) under AI provider → Azure capabilities, with a ✓/⚠/✗ situation line; BYO shows a configured/not-set status (no key field — keys live in the existing specialist sections).
- **Migration** (`migrateOldSettings`, sync, no secret reads): seeds `azureCapabilities` from observable specialist settings to PRESERVE each capability's prior reachable behaviour — azure-claude users keep transcription/embeddings/websearch on Azure; an azure-openai user on Tavily/non-OpenAI-embeddings keeps BYO (never force-converted to a blank Azure deployment).
- **Deferred follow-ups**: Azure connection-test tts/websearch probes, TTS request-pacer integration, `resolveEndpoint` azure-claude SSOT routing, research fallback-on-throw.
- **Plan**: [docs/completed/azure-capability-flexibility.md](docs/completed/azure-capability-flexibility.md).

### Key patterns
- **`getAzureApiKey(plugin, provider)`** — `useMainKeyFallback: false` always (no personal-key borrow). `azure-openai` falls back to the shared Foundry key via two sequential lookups.
- **`blockOverride = adapterType === 'azure-openai'`** in `cloudService` drops `modelOverride` on the deployment-routed URL.
- **Capability detection**: the resolved canonical model id flows as `modelName` (so `modelCapabilities`/`tokenLimits` regexes match); the deployment name never escapes the adapter.
- **Hygiene**: `PROVIDER_ENDPOINT` Azure entries `''`; no corporate endpoints/keys in defaults; redacted logs. `docs/plans/sync/azure-providers.md` (+ audit summary) are gitignored.

### Tests
`tests/azureClaudeAdapter.test.ts`, `tests/azureOpenAIAdapter.test.ts`, `tests/endpointResolver.test.ts`, `tests/modelCatalog.test.ts`, `tests/requestLimiter.test.ts`, `tests/openaiEmbeddingService.test.ts`, `tests/azureMode.test.ts` (isAzureMode, no-fallback, connection-test redaction).

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

By default a brand font is only **named** in CSS, so the preview/PDF render it only where the OS has it (Windows lacks Noto Sans). Dropping `woff2` files into a `<brandFolder>/fonts/` subfolder (mirrors `icons/`) **embeds** the real face so the **live preview + printed PDF** render true everywhere. PPTX still only names the font (pptxgenjs can't embed); **filmstrip thumbnails + the dom-to-pptx raster fallback render the fallback face** (SVG-as-`<img>` ignores host `@font-face`) — a documented v1 limitation. User guide: [docs/brand-setup.md](docs/brand-setup.md) §4b.
- `brandAssets.ts` — `getBrandFonts(app, settings, family)` (woff2 magic-validate → base64 → `@font-face` bound to the serialized primary family, per-file 2 MB / 8 MB-total caps, byte-bounded LRU, fail-closed `skipped[]`); `inspectBrandFontCandidates` (**sync**, stat-only, for the settings status line); `brandFontsSignature` (memo-bust). `FONTS_DIR='fonts'`; filename grammar `<slug>-<weight>[-italic].woff2`; no manifest in v1.
- `themeSafe.ts` — `sanitizeCssFontFamily` (validate → bare raw, **Unicode-aware** allowlist so CJK/accented names survive while injection chars are stripped) **vs** `serializeCssFontFamily` (render → CSS token, generics bare else quoted-**once**) — never conflated, so PPTX gets a bare `fontFace` and CSS gets a correctly-quoted token (no `''Noto Sans''`). `sanitizeCssFontFamilyList` builds `fontStack`. `sanitizeExportTheme` **always** populates `fontStack` from the raw value (off-brand `fontFace` may itself be a stack — single-family sanitize would comma-strip it) + sets `fontFace` to the first bare family.
- `brandExportTheme.composeFontStack(brand)` — leads the stack with the embedded **primary** then `fontFallback` (NOT `fontFallback` alone — that named only the fallback, never the embedded face).
- `ExportTheme` gains optional `fontStack?` (HTML, always-populated) + `fontFaceCss?` (the `@font-face` block, brand-with-fonts only); PPTX ignores both → byte-identical.
- Injection seam: the resolved `@font-face` rides the existing `brandCss` head argument in `presentationHtmlService.buildHtmlFromDeckIr` (injected **after** sanitize → DOMPurify can't strip it) and is authorized by **`font-src data:`** added to `presentationSanitizer.CSP_META` (data:-only; no `script-src` change → scripts still blocked). Real-Chromium proof: `tests/e2e/presentationSanitizerCsp.spec.ts` (data: font allowed, https: blocked, scripts blocked).
- Tests: `themeSafe.test.ts`, `brandAssets.test.ts`, `brandExportTheme.test.ts`, `brandRenderContext.test.ts`, `presentationSanitizer.test.ts`, `tests/e2e/presentationSanitizerCsp.spec.ts`. **Plan**: [docs/completed/brand-font-embedding.md](docs/completed/brand-font-embedding.md) (GPT R1-R3 + Gemini gate; caught 5 would-ship bugs incl. fontStack-naming-only-fallback, sanitize/serialize quoting conflict, off-brand stack comma-stripping).

## Consultant-Quality Slides (storyboard → dot-dash storyline → native visuals)

**Status**: ✅ Implemented (June 2026) — **default ON since 2026-06-08** (`presentationConsultantMode: true`; storyline-first is the intended Slides flow). A one-time guarded migration (`presentationConsultantDefaultedOn`) flips legacy default-off vaults to ON once; a later user opt-out persists (guard stays true → never re-flipped). Clusters A–D + chat loop, GPT per-cluster audited + consolidated Gemini gate + a 4-round targeted renderer gate (all APPROVE).

A McKinsey/BCG-quality semantic layer ABOVE the existing IR deck: action-titled, MECE, **evidence-bound** slides drafted as a reviewable **dot-dash storyline** the user signs off on BEFORE any slide is designed. Strictly additive — `presentationConsultantMode: false` is byte-identical to the prior pipeline.

### Pipeline (`src/services/presentationIr/`, `src/services/chat/`)
- `consultantStoryboard.ts` — Zod `ConsultantStoryboard` schema (`.strict()` + slide/deck-level `.superRefine` for unique ids, section refs, table/harvey column-length). The semantic "ghost deck": action titles, MECE `role`, evidence-bound `visual_data`, optional `sections`.
- `evidenceGrounding.ts` — **tiered deterministic grounding** (`exact`/`numeric`/`inferential`/`grounded-text`/`ungrounded`). `checkClaim`/`selfCheckStoryboard`/`buildGroundingAuditPayload` (blind `{claim, cited_spans}` for the critic). The **number parser** (`NUMERIC_RE`/`NUMERIC_CELL_RE`/`normaliseNumeric`/`magnitudeKey`) is comprehensive: percent · decimal · **dot-prefix (`.5`)** · **letter-identifier lookbehind (`Q3`/`FY24`/`v2` are NOT quantities)** · magnitude (`50bn`, gated so "50 billion" ≠ "50") · currency · **negative-currency sign (`-$50` keeps its sign)** · whole-cell gate (a prose/year cell is an accepted no-false-positive gap). Inferential → critic; ungrounded/dangling → blockers.
- `storyboardService.ts` — `generateStoryboard`/`generateRevisedStoryboard` (shared `runStoryboardLLM`) + `translateStoryboardToIr` (emits NATIVE blocks; harvey header is `['Option', ...cols]` — never empty). `visualDataToBlock` maps the 5 consultant visuals.
- `slideIr.ts` — new block kinds `waterfall`/`line-chart`/`pyramid` + table `style` (`matrix-2x2`/`rating`) + optional slide provenance (`action_title`/`storyboard_slide_id`); `chartNum = z.number()` (zod v4 rejects Infinity/NaN — `.finite()` is a deprecated no-op); a `.superRefine` enforces matrix-2x2 is a 3×3 grid.
- `irToHtml.ts` / `irToPptx.ts` — the 5 visuals render NATIVELY with **HTML/PPTX parity**: 2×2 CSS-grid quadrants, rating → harvey balls + a **clip-free visually-hidden "N of M" text node** (`ALLOW_ARIA_ATTR:false` strips aria — a11y needs a real text node), waterfall signed bridge bars, line SVG polyline, pyramid. PPTX uses native `addChart('line')` + text fallback.
- `dotDashSerializer.ts` / `dotDashParser.ts` / `dotDashAnchor.ts` — the human-editable storyline `.md`: `##` action titles + `- ` bullets (multi-bullet AND wrapped-continuation captured) + `> visual:` (display-only) + a `⚠ Storyline check` block, with machine state in a base64 `<!-- aio-slide:1 … -->` anchor (`-->`-safe; `btoa`/`atob`/`TextEncoder` — mobile-safe, NOT Node Buffer). `encodeMetaComment`/`decodeMetaComment` round-trip `sections` (dangling slide_ids dropped pre-validation so a user-deleted slide can't fail the parse).
- `presentationModelResolver.ts` — 5 pipeline roles → 2 settings (`presentationModelRoles`); `familyOf(provider, model)` enforces cross-family **independence** + a competence invariant; same-provider `modelOverride` vs cross-provider specialist `CloudLLMService`.
- `consultantAuditService.ts` (structural) + `consultantCriticService.ts` (`buildStoryboardJudge` — one LLM call verifying inferential numbers on a BLIND payload + MECE/laddering, bounded findings, never throws). The critic resolves through a DIFFERENT model family for genuine independent review.
- `consultantStoryboardPipeline.ts` — `runStoryboardStage`/`reviseStoryboard`/`buildDeckFromStoryline`/`buildDeckFromStoryboard`/`looksLikeBuildCommand`.

### Conversational review loop (`src/ui/chat/PresentationModeHandler.ts`)
`runConsultantStage` drafts the storyboard → writes a `<title> — storyline.md` to the Presentations folder + opens it (review gate). Each subsequent chat turn while a storyline is pending either **REVISES** it in place (any message + the doc's `<!-- comment: … -->` notes, re-grounded/re-audited) or **BUILDS** the deck (`looksLikeBuildCommand`). **Create deck button** (2026-06-08): while a storyline is pending (`pendingStoryline != null`, no deck yet) `getActionDescriptors` returns a single primary **"Create deck"** action → `handleCreateDeckFromStoryline` → the shared `buildFromStorylineNote` build path → `callbacks.rerenderContext?.()` swaps the create panel for the deck preview. The create panel (slides/sources/web-search/model/On-brand) stays visible THROUGHOUT the storyline phase (`renderContextPanel` renders it whenever `!deck.html`), so those settings shape the storyline up front and brand applies at the build; the button is the discoverable affordance for the build step (chat `looksLikeBuildCommand` still works as a shortcut). `ActionCallbacks.rerenderContext?()` (optional) → `UnifiedChatModal.renderContextPanel`. `resolveRoleRun(r, role)` builds the per-role specialist service; the background visual scan routes through the `visual_critic` context in consultant mode. Settings: `presentationConsultantMode` (**true**, default-on via the `presentationConsultantDefaultedOn` migration), `presentationStorylineGate` ('review'), `presentationModelRoles` ({generator,critic}); UI in `PresentationModelsSettingsSection.ts` — the master *Consultant-quality mode* toggle + *Storyline review* gate dropdown + the per-role model dropdowns.

### Key patterns
- **Deterministic-first**: grounding is pure code; the LLM critic only judges what the deterministic tier marks inferential (blind payload — no fabricated-number rubber-stamp).
- **Round-trip fidelity**: the user's storyline edits survive the build (anchors carry machine state; prose carries titles/bullets).
- **No-false-positive grounding**: a number-shaped identifier (`Q3`) or a prose/year table cell is deliberately NOT grounded — false positives nag worse than the rare missed prose number; the primary title + visual claims are always grounded.
- **Sanitizer CSSOM-longhand trap**: every new visual's CSS must have its LONGHANDS allowlisted (the targeted renderer gate caught `border-radius` corner longhands being stripped — square corners in preview, PPTX unaffected).

### Tests
`tests/{consultantStoryboard,evidenceGrounding,storyboardTranslation,consultantAuditService,consultantCriticService,dotDashRoundTrip,dotDashSerializer,dotDashAnchor,consultantStoryboardPipeline,presentationModelResolver,presentationFrameworkBlocks}.test.ts`. Plan + audit summary gitignored (`docs/completed/consultant-quality-slides*.md`). **Renderer gate** (post-consolidated, 4 rounds → APPROVE) found 7 real renderer/grounding defects the per-cluster + consolidated audits missed (dot-decimal, identifier digits, section-deletion regression, negative-currency sign, harvey count, border-radius, multi-line bullets) — the renderer/sanitizer surface had not been independently reviewed until then.

## Azure 429 Rate-Limit Throttling (RPM pacing + Azure-aware retry)

**Status**: ✅ Implemented (June 2026) — pass 1 (text egress) + **coverage pass (ALL egress)**

Paces outbound Azure requests under the low Azure RPM cap (~10/min) so batch tagging / index rebuilds don't 429-storm, + Azure-aware retry. A concurrency cap **alone is not RPM pacing** (cap-2 × fast calls ≈ hundreds/min), so the pacer enforces TWO gates.

### Coverage (azure-throttle-coverage) — EVERY Azure egress is paced
Non-Azure byte-identical; embeddings excluded (already cap-1 `embeddingQueue`):
- **Shared seam**: `withAzureLease(key, signal, fn)` (the ONE lease wrapper for fetch/cross-module egress) + **SSOT key builders** `buildAzureClaudeDeploymentKey` / `buildAzureOpenAIDeploymentKey` (over the ONE canonical `normalizeAzureEndpointToHost` — no raw fallback; host+model canonicalized) + `isAzureHost`. The old divergent `azureRateLimitKey` was REMOVED. `cloudService.pacedRequestUrl` + `azurePacerKey()` route through these.
- **Multimodal** (`sendMultimodal`, PDF/image — the high-TPM gap): paced + retried + an **exhausted-token-429 → actionable `AzureRateLimitError`** fallback. **No pre-emptive >TPM fail-fast** — a base64 body has no reliable client-side token estimate and `max_tokens` is only a ceiling, so `estimateMultimodalMinTokens` returns 0 (`classifyTpm` never fires for multimodal); every 429 retries and a genuine >TPM surfaces via the exhausted path.
- **Streaming** (`summarizeTextStream` + web-search `runStreamLoop`): **admission-ONLY** lease — wraps just the initial fetch + status read so the RPM start is counted, then releases; the SSE body streams un-leased (a whole-stream lease would freeze all other Azure calls at `maxConcurrent`). Initial-429 retries outside the lease.
- **Web-search** (`claudeWebSearchAdapter`): per-attempt admission lease on the **SAME** `buildAzureClaudeDeploymentKey` bucket the text path uses → text + research share ONE deployment RPM budget (released before the WS backoff — deadlock-safe).
- **Audio/Whisper** (`audioTranscriptionService`): `pacedWhisperRequest` **self-detects** Azure from the resolved endpoint (`resolveWhisperPacingKey` → `extractWhisperDeployment`) — NO `TranscriptionOptions` change, NO edits to the 9 call sites. It OWNS its request timeout via an internal `AbortController` (clears the timer + aborts the retry loop on timeout → no leaked timer, no zombie paced loop; at most one in-flight `requestUrl` dangles since Obsidian can't cancel it).
- Tests: `withAzureLease.test.ts`, `cloudServiceAzureThrottle.test.ts` (extended), `claudeWebSearchPacing.test.ts`, `audioTranscriptionPacing.test.ts`. **Plan**: [docs/completed/azure-throttle-coverage.md](docs/completed/azure-throttle-coverage.md).

### Pass 1 (text egress) — the pacer core
- `src/services/azure/azureRequestPacer.ts` — **`AzureRequestPacer`**: a self-contained, bounded-FIFO, two-gate scheduler — (a) max-concurrency + (b) a rolling-60s **request-START window** (max-RPM admission). Single FIFO, atomic dual-gate grant (start ts recorded at grant), **abortable leases** (cancel-while-queued removes the waiter), **in-place `setPolicy`** (preserves window/active/FIFO — no recreation), injectable `{now,setTimeout,clearTimeout}`. Per-deployment registry `getAzurePacer(key)` keyed by the SSOT `buildAzure{Claude,OpenAI}DeploymentKey` builders (see Coverage above); `setAzurePacerPolicy` (global, in-place) + `disposeAzurePacers` (unload). `AZURE_PACER_MAX_QUEUE=256`. **Supersedes** the previously-unused `requestLimiter.SimpleSemaphore` for the Azure path (a fixed-size semaphore queue can't express a dual gate).
- `src/services/azure/azureRateLimitHeaders.ts` (pure) — parse BOTH Azure header shapes (`x-ratelimit-*` + `-reset-*`/`-renewalperiod-*` + `retry-after` + `retry-after-ms`/`x-ms-retry-after-ms`). **`computeAzureBackoffMs`**: exhausted-dimension reset → MAX-of-resets (never min — min re-429s) → capped exponential; **authoritative resets/retry-after honoured uncapped**, only the fallback capped at 60s. **`classifyTpm` + `estimateMinProcessedTokens`** — the text >TPM fail-fast = token-dim 429 body AND the **INPUT-ONLY** lower bound (`len/5`) > `limit-tokens`. It does NOT count `max_tokens` (a ceiling, not committed usage): live-proven that counting it hard-failed a tiny Mermaid prompt as "~64k tokens" at a 10k TPM when it would have succeeded on retry. Fail-fast only when the INPUT alone can never fit; everything else retries. `logAzureRateLimitHeaders` (allowlisted numeric headers only).
- `src/services/azure/azureRateLimitError.ts` — typed `AzureRateLimitError{kind:'tpm-exceeded'|'queue-full'}`; `formatAzureRateLimitNotice.ts` — shared i18n mapper (`t.azureRateLimit.*`).
- `cloudService.ts` — wired into BOTH `postWithRetry` (summarize) + `makeRequestWithRetry`/`tryOneRequest` (tagging) via `pacedRequestUrl`, **Azure-gated** (`isAzureAdapter` = `adapterType.startsWith('azure')`). The lease is held ONLY for the in-flight HTTP (released before backoff → no pool stall — the deadlock crux). >TPM throws `AzureRateLimitError` (non-retriable via `isNonRetriableError`). **Non-Azure path byte-identical.** Summarize path propagates the caller `AbortSignal`; tagging path has no caller signal (pre-existing, not cancellable) → waiters drain via the RPM window + are rejected on dispose.
- `main.ts` sets the policy from settings on init + change, disposes on unload. Settings: `azureMaxConcurrentRequests` (2) + `azureMaxRpm` (10) + migration + `LLMSettingsSection` controls.
- Tests: `azureRequestPacer.test.ts` (FIFO/RPM-window/abort/deadlock/NaN/policy/dispose), `azureRateLimitHeaders.test.ts`, `cloudServiceAzureThrottle.test.ts` (>TPM fail-fast, non-Azure-untouched, RPM-retry), `formatAzureRateLimitNotice.test.ts`, `azureThrottleWiring.test.ts`. **Plan**: [docs/completed/azure-429-throttling.md](docs/completed/azure-429-throttling.md) (GPT R1-R2 + Gemini; caught: concurrency≠RPM, output-budget TPM, single-FIFO cancellation, dimension-aware backoff).

## LLM Gateway-Lite (fail-closed profile + observability + contention-safe indexing)

**Status**: ✅ Implemented (June 2026)

A thin coordination layer over the existing long-lived LLM service — NOT a gateway rewrite. Three plugin-scoped SSOTs the rest of the code reads, fixing three live-session failures (Azure routing leak, background-indexer 429 storm, invisible call fan-out).

### Core components
- `src/services/providerProfile.ts` — `resolveProviderProfile(plugin): ProviderProfile` (D1 SSOT): `{ valid, mode: 'azure'|'personal'|'local', provider, providerLabel, endpointHost, model, keySource, error? }`. Composes `isAzureMode`/`resolveEndpoint`/`getAzureApiKey`/`getProviderKey`; never throws (secret lookups wrapped); Azure validity requires a well-formed **HTTPS** endpoint + non-blank key.
- `src/services/llm/nullLLMService.ts` — `NullLLMService` (D2): a SEPARATE fail-closed class (not a flag) implementing `MultimodalLLMService` whose every method returns `{ success:false, error }` with **no network path**. Installed by `initializeLLMService` when `mode==='azure' && !valid` + one Notice. The structural reason the negative test holds.
- `src/services/foregroundGate.ts` — `ForegroundGate` (D3): ref-counted boolean mutex. `isActive()`, `withForeground<T>(fn)` (acquire→`try/finally` release — leak-safe, the ONLY access), `onIdle(listener)` (fires on end→idle, returns unsubscribe). Constructed ONCE in `onload`.
- `src/services/embeddings/embeddingCooldown.ts` — `EmbeddingCooldown` (D4.2): `note429(retryAfterHeader)` sets `max(Retry-After, escalating backoff)` clamped to a **10-min ceiling**; `isCoolingDown()`/`remainingMs()`/`reset()`. `parseRetryAfter` handles delta-seconds + HTTP-date. Injectable clock for tests.
- `src/services/vector/embeddingQueue.ts` — `EmbeddingQueue` (D4.4): plugin-scoped cap-1 serializer. One enqueue = one note (`ChunkTask[]` + `onBatchSuccess`). The drain dequeues exactly `maxBatchSize` **chunks**/iteration so one iteration = one request (no double-billing on partial failure). Typed re-enqueue on `cooldown`/`rate-limit`; drop+settle on `error`/throw; **90s per-request timeout** (cap-1 liveness); foreground-yield via one-shot `onIdle`; path-dedup/supersede; per-batch completion promise. **Disposed only in `onunload`** (NOT `vectorStoreService.dispose()`, which runs on settings re-init).
- `src/ui/components/providerBadge.ts` — pure `renderProviderBadge(container, profile, t)`: `🏢 Azure`/`👤 Personal`/`💻 Local`/`⚠ not configured` pill, `role="img"` + `aria-label`, host tooltip. Warns for ANY invalid profile.
- `src/utils/abortableSleep.ts` — `abortableSleep(ms, signal)`: resolves early on abort, clears timer, never rejects.

### Key wiring
- `main.ts`: constructs `foregroundGate`/`embeddingCooldown`/`embeddingQueue` ONCE in `onload`; `initializeLLMService` resolves+caches `providerProfile` (init-epoch guard so the latest init wins), installs `NullLLMService` on invalid Azure, wires the `onCall` counter + `onProfileChange` listener set. Plugin contract gains `providerProfile`, `foregroundGate`, `withForeground`, `onProfileChange`, `llmCallCounter`, `embeddingQueue`, `embeddingCooldown`.
- `IEmbeddingService` (`embeddings/types.ts`) gains a typed failure `reason: 'cooldown'|'rate-limit'|'error'` + `readonly maxBatchSize` (implemented on all 6 providers). Only network providers set cooldown/rate-limit. `openaiEmbeddingService` short-circuits on cooldown, uses `requestUrl({throw:false})`, reads `Retry-After`. The shared cooldown is injected via `createEmbeddingServiceFromSettings(settings, key, cooldown)`.
- `vectorStoreService`: splits notes → `ChunkTask` → `embeddingQueue.enqueue`; `indexNote` is fire-and-forget, `rebuildVault`/`indexAllNotes` `await` the per-batch completion (truthful "rebuild complete"); `removePath` on delete/rename. `batchGenerateEmbeddings` CONTRACT: any-size input → multi-request → strict 1:1 output (the queue passes ≤`maxBatchSize`; bulk callers rely on the split loop).
- `CloudLLMService`: per-call attribution `logger.debug('LLM', …)` + injected `onCall()` counter + `options.label`; `postWithRetry` threads `signal` + `onRetryStatus`, uses `abortableSleep` (Cancel interrupts a 429 stall), an aborted op throws `'Aborted'` (not the last 429 response). `summarizeTextStream` gains a trailing `options` param; the facade merges options into the stream→non-stream fallback.
- `withForeground` wraps user-entry flows: chat send (`UnifiedChatModal.handleSend`), presentation build/polish/brand-audit (`PresentationModeHandler`), `summarize`/`translate`/`minutes` (the minutes wrap is in `MinutesCreationModal` — the real LLM call site). Tagging + newsletter deferred (graceful, additive).

### Patterns
- **NullLLMService over a flag**: no two-mode service, no method can forget the guard. Negative test (`azureMode.test.ts`): misconfigured Azure ⇒ `NullLLMService` ⇒ zero `requestUrl` calls to any `anthropic.com` host.
- **Cap-1 serializer is the real thundering-herd fix** (not the cooldown alone): the first 429 sets the cooldown before the next request fires.
- **Queue reaches the CURRENT embedding service indirectly** (`getEmbeddingService()` accessor) so a settings-driven swap doesn't leave a stale instance.
- **i18n**: `t.llmGateway.*` (badge labels, status line, retry/cancel, Azure-misconfig notice).

### Tests
`tests/providerProfile.test.ts`, `tests/foregroundGate.test.ts`, `tests/embeddingCooldown.test.ts`, `tests/embeddingQueue.test.ts`, `tests/providerBadge.test.ts`, `tests/abortableSleep.test.ts`, extended `tests/azureMode.test.ts` (keystone negative test) + `tests/openaiEmbeddingService.test.ts` (cooldown short-circuit + Retry-After + maxBatchSize).

**Plan**: [docs/completed/llm-gateway-lite.md](docs/completed/llm-gateway-lite.md) · **Audit summary** (gitignored): `docs/completed/llm-gateway-lite-audit-summary.md`.

## Note-Edit Write Seam (command-layer-hardening, Clusters A+B+C)

**Status**: ✅ Complete (June 2026) — Clusters A (write seam) + B (hygiene) + D2 (additive summary) + **C (multi-source decomposition)**.

The command layer mutates notes through **one write seam** instead of scattered
`editor.setValue`/`replaceSelection`/`replaceRange`/`insertAtCursor` calls — closing a
silent-data-loss class (a long async pipeline writing to a stale/changed editor buffer).

### Core components (`src/services/noteEdit/`)
- `applyNoteEdit.ts` — `applyNoteEdit(plugin, target, opts): Promise<Result<void>>`, the ONLY way the command layer mutates a note. **Compare-and-commit**: re-resolves the file captured at command start, optionally shows the Reviewed Edits modal, then commits via `NoteWritePort`. `captureSnapshot(view)` / `captureSnapshotFromEditor(app, editor)` snapshot `{filePath, baseline, cursorAnchor, selection}` at command start. `EditTarget` is a discriminated union — `full-replace` (rewrite, **strict baseline gate**: aborts + copies result to clipboard on concurrent edit), `range-replace`/`cursor-insert` (content-anchor relocation, **degrade-to-append** when absent OR ambiguous), `append`, `composite` (additive recompute against live content — **no baseline gate**, so a concurrent keystroke can't discard the result, G2). §5 failure-matrix Notices are i18n'd (`t.messages.note*`).
- `noteWritePort.ts` — the ONLY module that calls `editor.replaceRange`/`vault.process`/`vault.modify` for command writes. Turns a full candidate into a **minimal common-prefix/suffix diff** (`minimalEdit`) applied as one undo/cursor-safe editor transaction when the note is open in **any** visible leaf (split-pane safe), else `vault.process` (abort-by-**throw** so a rejected write leaves mtime intact; `vault.modify` fallback pre-1.4). Never throws — typed `Result.err` on any failure (incl. a CodeMirror throw).
- `noteMutation.ts` — pure-string composition (`NoteMutation` fluent builder + `cleanupSourcesText`/`addReferenceText`/`ensureStructureText`/`replaceMainContentText`/`insertBeforeTrailingSectionsText`/`insertAtAnchorText`/`replaceAnchoredSelectionText`). Reuses existing **pure** exports from `noteStructure.ts` (`formatSourceReference`, `findSectionInText`, header constants) + `sourceDetection.removeProcessedSources`. **Body-only** — frontmatter stays on the existing `fileManager.processFrontMatter` path (no hand-rolled YAML).

### Key patterns
- **ESLint guard** (`eslint.config.mjs`, `no-restricted-syntax`): direct `editor.setValue/replaceSelection/replaceRange`/`insertAtCursor`/`appendAsNewSections`/`vault.modify` are forbidden in `src/commands/{summarize,translate}Commands.ts` + `src/services/multiSource/**` — they must route through `applyNoteEdit`. `src/services/noteEdit/**` owns the commit and is exempt.
- **Additive multi-source summary (D2)**: the multi-source summary **appends** + cleans up processed source links (preserving the user's body) rather than replacing the body. Single-source inserts are `cursor-insert`; full-note/multi-source translate rewrites are `full-replace` (baseline-gated).
- **Cluster B hygiene**: temp `CloudLLMService` (PDF provider override) disposed in `finally` (`pdfTranslationService`, `contentExtractionService`, `summarizeCommands`); chunked map-reduce egress wrapped in `withForeground`; RAG failure logs via `logger`.

### Cluster C — multi-source decomposition (`src/services/multiSource/`)
`handleMultiSourceResult` decomposed into three collaborators; `summarizeCommands` is now a thin adapter (snapshot → flatten sources → orchestrate → format → `applyNoteEdit`):
- `multiSourceOrchestrator.ts` — `MultiSourceOrchestrator.run(sources, opts)` runs the per-source `detect→extract→transcribe→summarize` pipeline, **error-isolated per source**, returns `Result<BatchResult<SourceOutcome>>` (`BatchResult`/`BatchError` live in `core/result.ts`, D5). Editor-free. Constructed with **narrow function seams** (`summarizeContent`/`summarizePdf`/`extractDocument`) + `plugin` + `notify` + `onAudioCleanup` — a documented deviation from the plan's literal `{facade,pdfService,documentService}` DI that breaks the orchestrator↔command import cycle AND avoids relocating large dependency tails (M2). LLM-summarize egress is gated via the injected seams; `opts.signal` threads into the direct `summarizeText` calls (G1). Cancelled run → `err('aborted')` (no partial write); credential fetch wrapped in `safeFetch` (degrade to null, G3); lazy `initVision()` runs inside `processImage`'s try/catch (G2).
- `summaryInsertion.ts` — formats the `## Summary` body (single / LLM-synthesis / headers-fallback) + the "Sources Processed" checklist (+ `buildFailureChecklist`); owns `buildSynthesisPrompt`. Pure except the injected synthesize seam; newline-sanitises checklist titles (G3); skips synthesis when 0 summaries (G2).
- `sourceMetadataWriter.ts` — `deriveCleanupTargets` (which processed links/embeds to strip) + `addSourceReferences` (References contributions). Pure.
- `summarizeTypes.ts` — `PdfSummarization{Result,Options}` extracted here to break the import cycle.

### Tests
`tests/{applyNoteEdit,noteWritePort,noteMutation}.test.ts` (39) + `tests/multiSourceOrchestrator.test.ts` (16: per-source isolation, BatchResult shapes, progress, abort/G1, credential-isolation/G3, vision-isolation/G2, signal-threading) + `tests/summaryParity.test.ts` (golden byte-parity + SummaryInsertion defensive guard) + `tests/fixtures/multiSource/golden-note.md`.

**Plan** (completed): [docs/completed/command-layer-hardening.md](docs/completed/command-layer-hardening.md) · **Audit summary** (gitignored): `docs/completed/command-layer-hardening-audit-summary.md`. Cluster C audited GPT-5.4 R1 (only M2 in-scope, documented deviation) + consolidated Gemini gate **R1→R2→R3 APPROVE**.

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

**Plan** (completed): [docs/completed/feature-toggles.md](docs/completed/feature-toggles.md) · **Audit summaries** (gitignored): `docs/completed/feature-toggles-audit-summary.md` (+ cluster-A). GPT-5.4 per-cluster audits + consolidated Gemini gate **R1 CONCERNS → R2 APPROVE** over the union diff.

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

**Plan** (completed): [docs/completed/unified-feature-taxonomy.md](docs/completed/unified-feature-taxonomy.md). `/cycle` autonomous: GPT per-cluster audits + consolidated Gemini gate **APPROVE** ("brilliant architectural enforcement mechanism").

## Documentation

See `docs/` folder for additional documentation:
- [docs/STATUS.md](docs/STATUS.md): Development status and recent updates
- [docs/bases_user_guide.md](docs/bases_user_guide.md): Obsidian Bases integration guide
- [docs/usertest.md](docs/usertest.md): Manual testing checklist
- [docs/format-specs.md](docs/format-specs.md): File format compliance checklist (Canvas, Bases, Markdown)
- [docs/kindle-plan.md](docs/kindle-plan.md): Kindle Sync implementation plan (Phases 3-4 pending)
- [docs/claude-web-search-plan.md](docs/claude-web-search-plan.md): Claude Web Search provider plan
- [docs/completed/reviewed-edits-plan.md](docs/completed/reviewed-edits-plan.md): Inline diff review for write commands (Improve, Translate, Integrate)
- [docs/completed/newsletter-digest-plan.md](docs/completed/newsletter-digest-plan.md): Gmail newsletters → AI triage summary → vault inbox
- [docs/completed/pres-plan.md](docs/completed/pres-plan.md): AI Chat + Presentation Builder implementation plan
- [docs/completed/web-research-plan.md](docs/completed/web-research-plan.md): Web Research Assistant implementation plan (Phases 1-3)
- [docs/completed/smart-digitisation-plan.md](docs/completed/smart-digitisation-plan.md): Smart Digitisation project plan
- [docs/completed/quic-plan.md](docs/completed/quic-plan.md): Quick Peek fast triage implementation plan
- [docs/plans/command-picker-ux.md](docs/plans/command-picker-ux.md): Command Picker UX overhaul plan (implemented)
- [docs/cde-plan.md](docs/cde-plan.md): Chunking, Decomposition & Extraction quality plan (6 phases)
- [docs/det-plan.md](docs/det-plan.md): Deterministic Validation & LLM Audit plan (6 phases)
