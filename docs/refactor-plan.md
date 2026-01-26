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
Deliverables
- Smaller rendering units and clearer separation of orchestration vs view.

Steps
- Extract rendering sections from `src/ui/modals/MinutesCreationModal.ts` into dedicated view helpers or components.

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
- Add `jspdf` dependency (only add `@types/jspdf` if TS requires it).
- Extend `src/services/notebooklm/types.ts`:
  - Add `PdfConfig`, `IPdfGenerator`, `DEFAULT_PDF_CONFIG`.
  - Extend `PackEntry` with `type: 'note-pdf' | 'attachment'`.
- Update `src/core/settings.ts` and `NotebookLMSettingsSection.ts` to include PDF settings:
  - page size, font name, font size, include frontmatter, include title.

#### Phase 2: Semantic PDF Generator
- Create `src/services/notebooklm/pdf/MarkdownPdfGenerator.ts`.
- Implement `generate(title, markdown, config): Promise<ArrayBuffer>`.
- v1 constraints:
  - Handle H1-H3, lists, and paragraphs.
  - Strip or skip complex blocks (HTML, Dataview, code fences) for clean AI parsing.
  - If `includeFrontmatter`, render a simple metadata header block.
- Add a v1 warning in UI: Latin-only fonts (CJK/RTL not supported yet).

#### Phase 3: Service Orchestration
- Update `src/services/notebooklm/sourcePackService.ts`:
  - Implement `executeExport(selection)`.
  - Instantiate `MarkdownPdfGenerator`.
  - Create pack folder via `WriterService.ensureFolder`.
  - For each note:
    - read markdown, generate PDF, write via `vault.createBinary`.
    - append `PackEntry` with `type: 'note-pdf'`.
  - Linked documents:
    - Detect with `detectEmbeddedContent`.
    - Copy linked PDFs/images as sidecar files (no PDF merging).
    - Append `PackEntry` with `type: 'attachment'`.
    - Update UI copy: “linked documents will be included as separate files”.
  - Hashing:
    - Use existing `computeSHA256` for markdown.
    - Add a helper for binary hashes (ArrayBuffer/Uint8Array) for attachments.
  - Async yielding: after every 5 items, `await sleep(20)` to keep UI responsive.
  - Write manifest/README via `WriterService`, update `RegistryService`, then apply post-export tag action.
- Update `getExportPreview`:
  - Count attachments toward 50-source warning.
  - Adjust size estimate/warnings to mention attached files.

#### Phase 4: UI & i18n
- Update `src/ui/modals/NotebookLMExportModal.ts`:
  - Remove “coming soon”.
  - Wire export button to `executeExport`.
  - Show progress and completion messages.
  - Add Latin-only limitation warning.
  - Update linked-document copy to “included as separate files”.
- Add i18n keys to `src/i18n/types.ts`, `src/i18n/en.ts`, `src/i18n/zh-cn.ts`.

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
