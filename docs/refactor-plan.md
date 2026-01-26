# Refactor Plan (based on refactor-audit.md)

Goal
- Improve encapsulation and DRY/SOLID compliance, while eliminating avoidable hardcoding and preserving existing behavior where reasonable.

Guiding Principles
- Minimize behavior change where possible, but prefer strong contracts over ambiguous runtime checks.
- Consolidate shared logic in services/utils, not in commands.
- Keep i18n coverage complete (EN/ZH parity).
- Reuse existing consolidation patterns (unified workflow helpers and provider registries).

## Phase 0 — Baseline and scaffolding
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

## Phase 1 — Centralize LLM call flow (DRY + encapsulation)
Deliverables
- Single helper/facade for all summarize-style calls, following the pattern of existing unified workflows.

Steps
1. Create `src/services/llmFacade.ts` (or `src/utils/llmCallHelper.ts`) with:
   - `summarizeText(plugin, prompt)`
   - `analyzeMultipleContent(plugin, items, prompt)` (returns a typed failure if unsupported)
   - `getServiceType(plugin)` (for privacy/capability checks)
2. Replace local/cloud branching in:
   - `src/commands/translateCommands.ts`
   - `src/commands/integrationCommands.ts`
   - `src/commands/flashcardCommands.ts`
   - `src/commands/summarizeCommands.ts`
   - `src/commands/smartNoteCommands.ts`
   - `src/commands/chatCommands.ts`
   - `src/services/minutesService.ts`

Notes
- Treat existing workflow helpers (`transcribeAudioWithFullWorkflow`, `summarizePdfWithFullWorkflow`) as prior art for shared orchestration.

Verification
- Smoke: translate, flashcards, summarize, smart note, and chat flows.

## Phase 2 — Centralize privacy gating
Deliverables
- Single consent helper used across summarize/smart-note flows.

Steps
1. Add `ensurePrivacyConsent(plugin, provider)` to `src/services/privacyNotice.ts` (or new helper module).
2. Remove duplicated `showPrivacyNotice` implementations in:
   - `src/commands/summarizeCommands.ts`
   - `src/commands/smartNoteCommands.ts`

Verification
- Smoke: Any cloud-provider summarize flow should show the notice only once per session.

## Phase 3 — Unify error handling and response checks
Deliverables
- Consistent Notice/error handling across command flows.

Steps
1. Add `executeWithNotice({ onStart, onSuccess, onError, task })` helper in `src/utils`.
2. Apply to translate, flashcard, integration, and smart note flows.

Verification
- Trigger an intentional failure to confirm error messaging is consistent (e.g., invalid API key).

## Phase 4 — Hardcoding + i18n cleanup
Deliverables
- Remove fallback literals that bypass i18n.

Steps
1. Replace inline command names and modal copy in `src/commands/integrationCommands.ts` and `src/commands/chatCommands.ts` with i18n keys.
2. Move all fallback strings into `src/i18n/types.ts`, `src/i18n/en.ts`, `src/i18n/zh-cn.ts`.
3. Keep `plugin.t` as primary, avoid literal fallbacks in UI paths.

Verification
- Run `npm run test:auto` (i18n parity should pass).

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
