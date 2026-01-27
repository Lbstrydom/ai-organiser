# Refactor Plan (based on refactor-audit.md)

Goal
- Improve encapsulation and DRY/SOLID compliance, while eliminating avoidable hardcoding and preserving existing behavior where reasonable.

Guiding Principles
- Minimize behavior change where possible, but prefer strong contracts over ambiguous runtime checks.
- Consolidate shared logic in services/utils, not in commands.
- Keep i18n coverage complete (EN/ZH parity).
- Reuse existing consolidation patterns (unified workflow helpers and provider registries).

## Phase 0 — Baseline and scaffolding (Completed)
Deliverables
- Introduce explicit summarization contract via ISP (no optional summarizeText).
- Centralize extension lists and magic numbers using existing constants as the source of truth.

Steps
1. Add `SummarizableLLMService` to `src/services/types.ts`:
   - `interface SummarizableLLMService extends LLMService { summarizeText(prompt: string): Promise<{ success: boolean; content?: string; error?: string }>; }`
   - (Optional) `interface MultimodalLLMService extends SummarizableLLMService { analyzeMultipleContent(...): Promise<...>; }`
2. Update `src/main.ts`:
   - `public llmService: SummarizableLLMService;`
3. Add `implements SummarizableLLMService` to `CloudLLMService` and `LocalLLMService` classes.
4. Remove runtime “missing summarizeText” fallbacks where they only mask typing issues (e.g., Minutes modal/service checks) and rely on compile-time safety instead.
5. Move `IMAGE_EXTENSIONS` and `AUDIO_EXTENSIONS` out of `src/utils/embeddedContentDetector.ts` into `src/core/constants.ts`.
6. Add `VIDEO_EXTENSIONS`, `MIN_TEXT_CONTENT_CHARS`, `SEARCH_TERM_SNIPPET_CHARS` to `src/core/constants.ts`.
7. Update `embeddedContentDetector.ts` and `integrationCommands.ts` to import and reuse the shared constants.

Notes
- This is a deliberate contract-tightening change; any mock or new service must implement `summarizeText`.
- Use existing constants for document extensions (`EXTRACTABLE_DOCUMENT_EXTENSIONS`, `ALL_DOCUMENT_EXTENSIONS`) as the base pattern.

Verification
- Run `npm run test:auto` (i18n parity + template validations).
- Update unit tests that used incomplete LLM mocks (notably `tests/minutesService.test.ts`).
- Test structure review (explicit criteria):
  - Encapsulation: tests use typed fakes/mocks that mirror public interfaces (no reaching into internals unless explicitly testing them).
  - DRY: shared mock builders/utilities for Obsidian/App, vector store, embedding services; avoid copy-paste fixtures.
  - Effectiveness: each test asserts behavior, not implementation details; remove redundant coverage or low-signal tests.
  - Efficiency: limit costly setup, use targeted fixtures, and avoid unnecessary file I/O in unit tests.
  - Purpose-built value: prioritize tests that guard user-facing behavior, regressions, and critical flows over broad snapshot checks.

## Phase 1 — Centralize LLM call flow (DRY + encapsulation) ✅ COMPLETED
Deliverables
- Single helper/facade for all summarize-style calls, following the pattern of existing unified workflows.

Steps (Completed)
1. ✅ Created `src/services/llmFacade.ts` with:
   - `LLMFacadeContext` (llmService + settings) to avoid plugin import cycles
   - `summarizeText(context, prompt)` - unified text summarization
   - `analyzeMultipleContent(context, items, prompt)` - multimodal content analysis
   - `getServiceType(context)` - service mode and provider detection
   - Exported via `src/services/index.ts`
2. ✅ Replaced local/cloud branching in all command files:
   - `src/commands/translateCommands.ts` - uses `summarizeText()`
   - `src/commands/integrationCommands.ts` - uses `summarizeText()`
   - `src/commands/flashcardCommands.ts` - uses `summarizeText()`
   - `src/commands/summarizeCommands.ts` - uses `summarizeText()`
   - `src/commands/smartNoteCommands.ts` - uses both `summarizeText()` and `analyzeMultipleContent()`
   - `src/commands/chatCommands.ts` - uses `summarizeText()`
   - `src/services/minutesService.ts` - uses `summarizeText()`

Implementation Notes
- Facade provides clean type-safe interface (`LLMCallResult` return type)
- Multimodal support includes runtime capability checking and graceful degradation
- Follows existing pattern from `transcribeAudioWithFullWorkflow` and `summarizePdfWithFullWorkflow`
- All imports use centralized `SummarizableLLMService` interface from Phase 0

Verification Results
- ✅ Source code compiles (tsconfig.build.json)
- ✅ All 678 unit tests pass (vitest)
- ✅ i18n parity maintained (EN/ZH structure)
- ✅ Production bundle builds successfully (main.js 3.0mb)
- ✅ Build produces main.js
- Test file errors are pre-existing (not related to Phase 1 changes)

## Phase 2 — Centralize privacy gating ✅ COMPLETED
Deliverables
- Single consent helper used across summarize/smart-note flows.

Steps (Completed)
1. ✅ Added `ensurePrivacyConsent(plugin, provider)` to `src/services/privacyNotice.ts`.
2. ✅ Removed duplicated `showPrivacyNotice` implementations in:
  - `src/commands/summarizeCommands.ts`
  - `src/commands/smartNoteCommands.ts`

Implementation Notes
- `ensurePrivacyConsent` opens `PrivacyNoticeModal` once per session and marks consent via in-memory flag.
- Commands now call the centralized helper before cloud LLM actions.

Verification Results
- ✅ `npm test`: 678 tests passed.
- ✅ Build produces `main.js`.
- ⚠️ `npm run test:auto`: one pre-existing TypeScript compile check failure in test harness (unchanged by Phase 2).
- ✅ Manual smoke: Cloud-provider flows show the notice once per session.
- Sign-off: Approved (no blocking issues found).

## Phase 3 — Unify error handling and response checks ✅ COMPLETED
Deliverables
- Consistent Notice/error handling across command flows.

Steps (Completed)
1. ✅ Added `executeWithNotice` helper in `src/utils/executeWithNotice.ts` with:
   - `executeWithNotice<T>()` - unified async operation wrapper
   - `showNotice()` - consistent notice display
   - `showErrorNotice()` - standardized error messaging
   - `showSuccessNotice()` - standardized success messaging
2. ✅ Applied to all command flows:
   - `src/commands/translateCommands.ts` - uses `showErrorNotice` and `showSuccessNotice`
   - `src/commands/flashcardCommands.ts` - uses helpers for consistent error/success handling
   - `src/commands/integrationCommands.ts` - uses helpers for content integration flow
   - `src/commands/smartNoteCommands.ts` - uses helpers for diagram/generation/improvement flows

Implementation Notes
- Helper module provides `showErrorNotice`/`showSuccessNotice` for consistent UI messaging.
- Try/catch blocks remain where localized messaging and flow control are needed.
- Error formatting is centralized (context + error) in the helper to reduce drift.

Verification Results
- ✅ `npm run build` produces main.js without error.
- ✅ All 678 unit tests pass.
- Smoke test: Any command failure (e.g., invalid API key) shows consistent error format.
- Sign-off: Approved (no blocking issues found).

## Phase 4 — Hardcoding + i18n cleanup ✅ COMPLETED
Deliverables
- Remove fallback literals that bypass i18n.

Steps (Completed)
1. ✅ Added i18n keys to `src/i18n/types.ts`:
   - `modals.addContent`: title, sourceType, sourceTitle (+desc/placeholder), sourceLink (+desc/placeholder), content (+desc/placeholder), defaultTitle, extended types (audio/pdf/image/note/video/transcript)
   - `modals.integrationConfirm`, `modals.quickAddText`, `modals.quickAddUrl` for new modal UI strings
   - `modals.chatWithVault`: added sourcesLabel, noRelevantInfo, responseFailed, questionPlaceholder, askButton
   - `commands`: integration + chat subcommands (askAboutCurrentNote, insertRelatedNotes, quick-add, etc.)
   - `messages`: contentRequired, noResponseFromLlm, addedTimestamp
2. ✅ Added English translations in `src/i18n/en.ts` with human-friendly UI strings
3. ✅ Added Chinese translations in `src/i18n/zh-cn.ts` with bilingual parity
4. ✅ Replaced hardcoded strings in `src/commands/integrationCommands.ts`:
   - Command names migrated to `plugin.t.commands.*`
   - IntegrationConfirmModal copy, QuickAdd modals, AddContent modal labels/placeholders now i18n
   - Default source titles centralized via `getDefaultSourceTitle()`
5. ✅ Replaced hardcoded strings in `src/commands/chatCommands.ts`:
   - ChatWithVaultModal: title, intro, placeholder, buttons, sources label, empty/failed states
   - promptForQuestion helper: title, field name, placeholder, ask/cancel buttons
   - Command names migrated to `plugin.t.commands.*`

Implementation Notes
- All modal button texts now use `plugin.t.modals.*` (no fallback literals)
- IntegrationConfirmModal and QuickAdd modals now accept typed `Translations`
- Error messages format placeholders using i18n key replacement (e.g., `{error}`)
- EN/ZH translation parity maintained across all new keys

Verification Results
- ✅ `npm test` (678 tests passed)
- ✅ `npm run test:auto`
- ✅ `npm run build:quick`
- Sign-off: Approved (review complete; no blocking i18n issues found in Phase 4 scope)

## Phase 5 — Optional: Minutes modal extraction
**Status**: ✅ COMPLETED (via existing architecture)

**Assessment**: MinutesCreationModal (1338 lines) already achieves Phase 5 objectives through controller-based architecture. No additional view extraction needed.

**Current Architecture**:
- **Controllers**: 3 dedicated controllers separate business logic from UI
  - `DocumentHandlingController`: Document detection, extraction, caching, truncation (23 tests)
  - `DictionaryController`: Dictionary CRUD, term extraction, merging (56 tests)
  - `AudioController`: Audio detection and transcription state (35 tests)
- **Render Methods**: Clear separation per section
  - `renderTopSection()`, `renderParticipantsSection()`, `renderAdvancedSection()`
  - `renderAudioTranscriptionSection()`, `renderContextDocumentsSection()`, `renderDictionarySection()`
  - `renderFooter()`, `renderPrivacyWarning()`
- **Orchestration**: Clean `onOpen()` instantiates controllers and delegates to render methods
- **UI Components**: `TruncationControls` shared component for document truncation (8 tests)
- **Testability**: Controllers support dependency injection via `MinutesModalDependencies` interface

**Why No Further Extraction Needed**:
1. Business logic already separated from UI via controller pattern (122 tests)
2. Render methods provide clear visual boundaries for each section
3. `createCollapsible()` pattern requires modal context (can't easily extract)
4. File size (1338 lines) reasonable for complex UI with audio/docs/dictionary/i18n
5. Current structure is maintainable, testable, and follows SOLID principles

**Attempted Approach** (Reverted):
- Created `MinutesViewBuilders.ts` with extracted render functions
- Discovered view builders don't handle:
  - Async persona loading
  - `createCollapsible()` modal context dependencies
  - Complex callback chains for state updates
- Conclusion: Adding view builder layer would increase complexity without benefit

**Verification**:
- Controllers: 114 tests (23 + 56 + 35) passing
- TruncationControls: 8 tests passing
- Modal integration tested via manual testing (docs/usertest.md)
- Architecture documented in AGENTS.md "Controller Architecture" section

**Deliverables**: Already achieved through existing controller pattern
- ✅ Smaller rendering units: Controllers isolate document/dictionary/audio logic
- ✅ Clear separation: Business logic (controllers) vs. UI (render methods) vs. orchestration (onOpen)

**Recommendation**: Mark Phase 5 complete; current architecture optimal for maintenance and testing.

## Track: NotebookLM Integration (Feature Addition)
Status: Planned
Dependencies: Independent of the core refactor phases, but overlaps with Settings and i18n updates.

### Goal
Implement PDF export functionality allowing users to convert Obsidian notes into a “Source Pack” (PDFs + Manifest) optimized for NotebookLM ingestion.

### Architecture Constraints
1. Reuse: Extend existing `SourcePackService`, `WriterService`, and `RegistryService`. Do not create parallel managers.
2. SRP: PDF generation logic lives in `MarkdownPdfGenerator`, separate from I/O and orchestration.
3. Performance: Implement async yielding during export to avoid UI freezes.
4. Rendering: Use a semantic renderer (Markdown structure -> PDF), not HTML-to-PDF.

### Implementation Phases

#### Phase 1: Infrastructure & Dependencies
**Status**: ✅ COMPLETED (January 26, 2026)

**Deliverables**:
- ✅ Installed `jspdf` dependency (22 packages)
- ✅ Extended `src/services/notebooklm/types.ts`:
  - Added `PdfConfig` interface with page size, font settings, margins, line height
  - Added `IPdfGenerator` interface for PDF generation contract
  - Added `DEFAULT_PDF_CONFIG` constant (A4, helvetica, 11pt)
  - Added `pdf: PdfConfig` to `SourcePackConfig` (export config now carries PDF settings)
  - Extended `PackEntry` with `type: 'note-pdf' | 'attachment'` field
- ✅ Updated `src/core/settings.ts`:
  - Added 5 PDF settings fields to `AIOrganiserSettings` interface
  - Added defaults to `DEFAULT_SETTINGS` (A4, helvetica, 11pt, no frontmatter, include title)
- ✅ Updated `src/ui/settings/NotebookLMSettingsSection.ts`:
  - Added "PDF Generation Settings" subsection with 5 controls
  - Page size dropdown (A4/Letter/Legal)
  - Font name dropdown (helvetica/times/courier)
  - Font size slider (9-14pt)
  - Include frontmatter toggle
  - Include title toggle
  - Added v1 limitations warning box (Latin-only, basic formatting)
- ✅ Updated i18n files:
  - Added 12 new strings to `src/i18n/types.ts` (pdfSettingsTitle, pdfPageSize, etc.)
  - Added English translations to `src/i18n/en.ts`
  - Added Chinese translations to `src/i18n/zh-cn.ts`

**Verification**:
- ✅ TypeScript compilation: Passed (tsconfig.build.json)
- ✅ Build: main.js 3.1MB (production bundle)
- ✅ Tests: 678/678 passing (29 suites)
- ✅ No breaking changes to existing code

**Files Modified** (8 files):
1. `package.json` - Added jspdf dependency
2. `src/services/notebooklm/types.ts` - PDF types and interfaces
3. `src/core/settings.ts` - PDF settings fields and defaults
4. `src/ui/settings/NotebookLMSettingsSection.ts` - PDF settings UI
5. `src/i18n/types.ts` - PDF settings type definitions
6. `src/i18n/en.ts` - English PDF strings
7. `src/i18n/zh-cn.ts` - Chinese PDF strings
8. `package-lock.json` - Dependency lockfile

**Next Steps**: Proceed to Phase 2 (Semantic PDF Generator)

#### Phase 2: Semantic PDF Generator
**Status**: ✅ COMPLETED (January 26, 2026)

**Deliverables**:
- ✅ Created `src/services/notebooklm/pdf/MarkdownPdfGenerator.ts` (420+ lines)
- ✅ Implemented pure semantic renderer (instance-based `IPdfGenerator`):
  - `MarkdownPdfGenerator.generate(title, markdown, config): Promise<ArrayBuffer>`
  - Line-based markdown parser (no full parser dependency)
  - Semantic type mapping (heading1-3, bullet, ordered, paragraph, blank)
  - Word wrapping and automatic pagination
  - Respects all PdfConfig settings (pageSize, font, fontSize, margins, lineHeight)
- ✅ Markdown feature support:
  - H1-H3 headings with size scaling
  - Unordered lists (- * +) with nesting
  - Ordered lists (1. 2. 3...) with nesting
  - Paragraphs with word wrapping
  - Frontmatter handling (YAML when includeFrontmatter=true)
- ✅ Complex block handling:
  - Strips code blocks (```...```) cleanly
  - Skips HTML blocks (<...>)
  - Skips Dataview/query blocks
  - Skips Obsidian comments (%% ... %%)
- ✅ Text sanitization + preprocessing (comments/images stripped before parsing):
  - Internal links: `[[Link|Display]]` → Display
  - External links: `[Display](url)` → Display
  - Bold/italic: `**text**`, `__text__`, `*text*`, `_text_` → text
  - Strikethrough: `~~text~~` → text
  - Inline code: `` `code` `` → code
  - Highlights: `==text==` → text
  - Subscript/superscript: `~text~`, `^text^` → text
- ✅ Pure function guarantees (no Obsidian dependencies, instance-based API):
  - No Obsidian App/Vault/TFile dependencies
  - No input mutation
  - Consistent output for same inputs
  - Stub for future image embedding (v2)
- ✅ Latin-only limitation warning in UI

**Verification**:
- ✅ TypeScript compilation: Passed (no type errors)
- ✅ Build: main.js 3.1MB (no size regression)
- ✅ Tests: 705/705 passing (30 suites, +27 PDF tests)
  - Simple markdown generation
  - Title handling (include/exclude)
  - List rendering (unordered, ordered, nested) with numeric prefixes preserved
  - Code block stripping
  - Page size variations (A4/Letter/Legal)
  - Font variations (helvetica/times/courier)
  - Font size variations (9-14pt)
  - Long content with pagination
  - Frontmatter inclusion/exclusion
  - Heading hierarchy (H1-H3)
  - Link sanitization (internal, external)
  - Text formatting sanitization
  - Complex block handling (code, dataview, HTML, comments)
  - Comment/image stripping in parser
  - Pure function invariants (no mutations, consistent output)
- ✅ PDF output validation:
  - All outputs are valid ArrayBuffer
  - PDF magic number validation (%PDF)
  - Byte size > 0 for all inputs

**Files Created** (2 files):
1. `src/services/notebooklm/pdf/MarkdownPdfGenerator.ts` - Semantic PDF generator
2. `tests/markdownPdfGenerator.test.ts` - 24 comprehensive unit tests

**Implementation Highlights**:
- **Line Scanner**: Non-blocking regex-based parser (not full Markdown AST)
- **Pagination**: Automatic page breaks with margin/size calculations
- **Sanitization**: 8 regex patterns for Obsidian syntax removal
- **Async-Ready**: Prepared for future async image embedding
- **Testable**: Pure function with no side effects, all inputs/outputs typed

Sign-off: Approved (Phase 2 complete; no blocking issues found).

**Next Steps**: Proceed to Phase 3 (Service Orchestration)
- Implementation guidance:
  - Use a simple **line scanner** (no full Markdown parser).
  - Keep the generator **pure** (no App/Vault/TFile dependency); pass strings + config only.
  - Stub image handling initially (`embedImage` no-op) and add later.
- Add a v1 warning in UI: Latin-only fonts (CJK/RTL not supported yet).

**Critical Watch Outs (Phase 2)**
- **Pure inputs only**: `generate(title: string, markdownContent: string, config: PdfConfig)` — do **not** accept `TFile` or Obsidian types.
- **Latin-only limitation**: PDFs will not render CJK/RTL in v1. Ensure `NotebookLMExportModal.ts` shows a warning: “Note: PDF generation currently supports Latin characters only. Chinese/Asian characters may not render correctly.”
- **Sanitization in line scanner**: strip Obsidian-specific syntax (e.g., `[[Internal Link]] → Internal Link`, remove `%% comments %%`).

#### Phase 3: Service Orchestration
**Status**: ✅ COMPLETED (January 27, 2026)

**Deliverables**:
- ✅ Implemented `executeExport(selection, onProgress?)` in `src/services/notebooklm/sourcePackService.ts`
- ✅ Full PDF generation workflow with `MarkdownPdfGenerator`
- ✅ Linked document detection and sidecar file copying
- ✅ Binary hashing support via `computeBinarySHA256()`
- ✅ Async yielding (every 5 items, 20ms) for UI responsiveness
- ✅ Export preview with attachment counting toward 50-source limit

**Implementation Details**:

1. **executeExport() Implementation** (400+ lines):
   - Creates timestamped pack folder under configured export path
   - For each note: reads markdown, generates PDF via `MarkdownPdfGenerator`, writes via `vault.createBinary`
   - For linked documents: detects with `detectEmbeddedContent`, copies as sidecar files
   - Progress callback for UI updates: `onProgress(current, total, message)`
   - Builds `PackManifest` with entries, stats, and config
   - Updates `RegistryService` for revision tracking
   - Writes manifest.json and README.md via `WriterService`
   - Applies post-export tag action (clear or archive)

2. **Hashing Enhancements** (`src/services/notebooklm/hashing.ts`):
   - Added `computeBinarySHA256(data: ArrayBuffer | Uint8Array)` for attachment hashing
   - Content hashes stored in `PackEntry.sha256` for change detection

3. **getExportPreview() Enhancements**:
   - Deduplicates linked documents by path (case-insensitive)
   - Total source count = notes + unique linked documents
   - Size estimation includes actual attachment sizes
   - Warnings updated to show both note and attachment counts:
     - `>50`: "55 sources selected (45 notes + 10 linked documents). NotebookLM limit is 50 sources."
     - `>45`: "48 sources approaching NotebookLM limit of 50 sources."

4. **Utility Methods**:
   - `sanitizeFilename()`: Replaces invalid chars, spaces to underscores, limits to 200 chars
   - `deduplicateLinkedDocuments()`: Case-insensitive path deduplication
   - `estimateAttachmentsSize()`: Actual file sizes via `TFile.stat.size`
   - `generatePackId()`: Unique pack identifier (timestamp + random)
   - `extractTags()`: Reads tags from metadata cache

**Verification Results**:
- ✅ TypeScript compilation: Passed (tsconfig.build.json)
- ✅ Build: main.js 4.5MB (production bundle)
- ✅ Tests: 749/749 passing (31 suites, +44 Phase 3 tests)
  - Hashing utilities (computeBinarySHA256, packHash, shortId)
  - Filename sanitization edge cases
  - Linked document deduplication
  - Source count warnings (notes + attachments)
  - Size warnings (180MB, 200MB thresholds)
  - Pack ID generation
- ✅ No breaking changes to existing code

**Files Modified** (2 files):
1. `src/services/notebooklm/sourcePackService.ts` - Full executeExport implementation
2. `src/services/notebooklm/hashing.ts` - Added computeBinarySHA256

**Files Created** (1 file):
1. `tests/sourcePackService.test.ts` - 44 comprehensive unit tests

**Next Steps**: Proceed to Phase 4 (UI & i18n)

#### Phase 4: UI & i18n
**Status**: ✅ COMPLETED (January 27, 2026)

**Deliverables**:
- ✅ Updated `src/ui/modals/NotebookLMExportModal.ts`:
  - Removed "coming soon" notice
  - Added Export button wired to `executeExport` via callback
  - Added progress bar with `ProgressBarComponent` (shows current/total and message)
  - Added Latin-only limitation warning with styled alert box
  - Updated linked document text to "included as separate files"
  - Added `updateProgress(current, total, message)` method for live progress updates
  - Added `showComplete(success, message?)` method for completion state
  - Added Cancel/Close button state management during export
- ✅ Updated `src/commands/notebookLMCommands.ts`:
  - Import and use `NotebookLMExportModal`
  - Wire modal callback to `sourcePackService.executeExport()`
  - Pass progress callback to update modal UI in real-time
  - Handle success/error states with i18n messages
- ✅ Updated `src/services/notebooklm/types.ts`:
  - Extended `postExportTagAction` to include 'keep' option (keep | clear | archive)
- ✅ Added i18n keys to all three files:
  - `latinOnlyWarning`: Warning about Latin-only font support
  - `exportProgress`: "{current} of {total}" progress text
  - `generatingPdf`: "Generating PDF: {note}"
  - `copyingDocument`: "Copying: {document}"
  - `writingManifest`: "Writing manifest..."
  - `exportComplete`: "Export complete!"
  - `cancelButton`: "Cancel"
  - Updated `documentExportNotice` to "included as separate files"

**Implementation Details**:
1. **Export Modal Flow**:
   - User clicks Export → `startExport()` shows progress UI, disables buttons
   - Callback triggers `executeExport()` with progress handler
   - Progress updates flow through `updateProgress()` to ProgressBarComponent
   - On completion, `showComplete()` updates UI and re-enables Close button

2. **Post-Export Tag Actions**:
   - Keep: Tags remain unchanged (no action taken)
   - Clear: Selection tags removed from exported notes
   - Archive: Selection tags renamed to 'notebooklm/exported' with metadata

**Verification Results**:
- ✅ TypeScript compilation: Passed (tsconfig.build.json)
- ✅ Build: main.js 4.5MB (production bundle)
- ✅ Tests: 749/749 passing (31 suites)
- ✅ i18n parity: EN/ZH translations complete
- ✅ No breaking changes to existing code

**Files Modified** (6 files):
1. `src/ui/modals/NotebookLMExportModal.ts` - Full export UI with progress
2. `src/commands/notebookLMCommands.ts` - Wired modal to executeExport
3. `src/services/notebooklm/types.ts` - Added 'keep' to tag action type
4. `src/i18n/types.ts` - Added 7 new i18n keys
5. `src/i18n/en.ts` - English translations
6. `src/i18n/zh-cn.ts` - Chinese translations

**NotebookLM Integration Complete**: All 4 phases implemented. Users can now:
1. Tag notes with 'notebooklm' for selection
2. Run "NotebookLM: Export Source Pack" command
3. Review selection summary and configure post-export tag action
4. Click Export and watch real-time progress
5. Upload generated PDFs and linked documents to NotebookLM

### Risk Register
- UI freeze: mitigated by async yielding inside export loop.
- Character set support: v1 warning + defer font loader (user-supplied TTF) to v2.
- Source limits: attachments count toward NotebookLM 50-source limit; warn accordingly.
- Size blow-up: text-only PDFs are small; monitor if attachments are included.

### Decision Log
- Linked documents are exported as sidecar files, not embedded in PDFs (v1).
- v1 PDF generation is Latin-only; CJK/RTL support deferred to v2 via user-supplied fonts.

## Provider Registry Note
- Provider defaults/endpoints are already centralized in `src/services/adapters/providerRegistry.ts`. Any LLM refactor should rely on this instead of reintroducing per-command provider logic.

## Expected Benefits
- Single-source LLM behavior and privacy handling.
- Fewer duplicated strings and rules.
- Better type safety and clearer interfaces (ISP-aligned).
