# Content Pipeline & Note Writes

> Subsystem detail moved out of [AGENTS.md](../../AGENTS.md) so the canonical
> context file stays invariant-sized. AGENTS.md keeps the one-line stub and the
> load-bearing rules; the operational depth lives here.

How external content becomes note content, and the single seam every command write goes through: extraction, chunking, translation, integration, digitisation, export, and the reviewed-edit write path.

---

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

## Large-Content Ingestion — Quality-Aware Chunking

**Status**: ✅ Implemented (April 2026)

**Plan**: [docs/completed/large-content-ingestion.md](../completed/large-content-ingestion.md)

Replaces scattered `isContentTooLarge` checks + flat map-reduce summarization with a quality-aware chunking pipeline. Fixes the "2-hour meeting crashes" user report by bumping `CHUNK_TOKEN_LIMIT` from 6000 → 12000 (halves call count for long meetings) and introducing hierarchical map-reduce for non-minutes content.

### Key components

| File | Purpose |
|---|---|
| [src/services/contentSizePolicy.ts](../../src/services/contentSizePolicy.ts) | Single source of truth for quality thresholds (40K/48K/192K chars per content type) + fast-model capability check + `estimateCharsPerToken()` heuristic (Latin/CJK/code) |
| [src/services/chunkingOrchestrator.ts](../../src/services/chunkingOrchestrator.ts) | Generalised hierarchical map-reduce with rolling `continuationContext` between chunks + per-chunk error isolation (no `[Error summarizing section N]` markers in output) |
| [src/core/constants.ts:64](../../src/core/constants.ts#L64) | `CHUNK_TOKEN_LIMIT = 12_000` (bumped from 6000) |
| [src/services/minutesService.ts:111-125](../../src/services/minutesService.ts) | `EXTRACTION_OPTIONS.maxTokens = 8192` (up from 4096); `MERGE_OPTIONS.maxTokens = 12288` (up from 4096); `overlapChars = 1000` (up from 500) |
| [src/commands/summarizeCommands.ts:1615,1676,2094](../../src/commands/summarizeCommands.ts) | Quality-threshold auto-chunking: URL / text / audio transcripts above ~40K chars auto-route to `summarizeInChunks` instead of one-shot |

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

## Smart Digitisation & Multimodal Architecture

**Status**: ✅ Implemented (February 2026)

### Overview

Unified multimodal pipeline, image processing, smart digitisation of handwritten notes/whiteboards/diagrams, built-in sketch pad, and media compression with vault replacement. Five phases delivered on branch `claude/smart-digit-plan-O4GpF`.

**Full plan**: [docs/completed/smart-digitisation-plan.md](../completed/smart-digitisation-plan.md)

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

**Plan** (completed): [docs/completed/command-layer-hardening.md](../completed/command-layer-hardening.md) · **Audit summary** (gitignored): `docs/completed/command-layer-hardening-audit-summary.md`. Cluster C audited GPT-5.4 R1 (only M2 in-scope, documented deviation) + consolidated Gemini gate **R1→R2→R3 APPROVE**.

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

**Plan**: [docs/completed/reviewed-edits-plan.md](../completed/reviewed-edits-plan.md)
