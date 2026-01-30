# AI Organiser - Development Status

**Version:** 1.0.15
**Last Updated:** January 30, 2026
**Status:** Feature Complete - Command Picker Phase 2 + PDF Table Fix + UX Polish

---

## Recent Updates

### Command Picker Redesign Phase 2 & PDF Table Fix (2026-01-30)

**All Parts Complete**

| Part | Feature | Status |
|------|---------|--------|
| PDF Fix | Strip blockquote/callout prefixes in preprocessMarkdown for table detection | Complete |
| Phase 2 | Deeper command grouping: Highlight, Tags, Ask AI, Find Notes groups | Complete |
| Phase 2 | Rename Search+Analyze to Discover (5 categories, 7 groups) | Complete |
| Phase 2 | Move Manage Index to Bases group (Separation of Concerns) | Complete |

**Build Status**: 871 tests passing (39 suites)

**Key Files Modified:**
- `src/utils/markdownParser.ts` — Added `.replace(/^> ?/gm, '')` to strip blockquote prefixes
- `src/ui/modals/CommandPickerModal.ts` — Full restructure of `buildCommandCategories()`
- `src/i18n/types.ts` — Removed `categorySearch`/`categoryAnalyze`, added `categoryDiscover`, `groupHighlight`, `groupTags`, `groupAskAI`, `groupFindNotes`
- `src/i18n/en.ts`, `src/i18n/zh-cn.ts` — New translations for Discover, Highlight, Tags, Ask AI, Find Notes
- `tests/commandPicker.test.ts` — Rewritten for new 5-category structure with 7 sub-groups
- `tests/markdownPdfGenerator.test.ts` — 4 new tests for table rendering and callout handling

**Command Picker Structure (After):**
| Category | Top-level Items | Groups |
|----------|----------------|--------|
| Create (3) | Smart Summarize, Meeting Minutes, Export Note | — |
| Enhance (3) | Enhance Note, Translate, **Highlight** group | Highlight (2 sub) |
| Organize (2) | **Tags** group, **Bases** group | Tags (4 sub), Bases (4 sub incl. Manage Index) |
| Discover (2) | **Ask AI** group, **Find Notes** group | Ask AI (2 sub), Find Notes (3 sub) |
| Integrate (2) | **Pending** group, **NotebookLM** group | Pending (3 sub), NotebookLM (4 sub) |

**Design Rationale:**
- Tags group (Gestalt proximity): "I want to do something with tags" consolidates Tag/Clear/Network/Export
- Highlight group (inverse operation): Do/Undo on same feature reduces Enhance noise
- Search → Discover (reframing): AI-powered exploration, not Ctrl+F text matching
- Manage Index → Bases (SoC): Admin maintenance stays with infrastructure, not user-mode discovery

**Documentation**: `docs/completed/menu-plan.md` (archived)

---

### Preview Modal, Global LLM Busy Indicator & UX Polish (2026-01-30)

**All Parts Complete + 3 Review Rounds**

| Part | Feature | Status |
|------|---------|--------|
| Part 1 | Fix summary preview modal for all paths (text + PDF) | Complete |
| Part 2 | Global LLM busy indicator with ref counting | Complete |
| Review 1 | Spinner scoped to LLM only, not preview modal wait | Complete |
| Review 2 | YouTube chunks + traditional web path coverage gaps | Complete |
| Review 3 | Coverage audit: all 27 LLM call sites verified wrapped | Complete |
| UX Polish | Discard button warning signifier, pulse animation, keyframe DRY cleanup | Complete |
| Review 4 | 6 findings: reasoning model gating, debug guard, em dash, failure Notice, version, tests | Complete |

**Build Status**: 868 tests passing (39 suites)

**New Files Created:**
- `src/utils/busyIndicator.ts` — ref-counted show/hide/withBusyIndicator/reset + 400ms minimum display
- `tests/busyIndicator.test.ts` — 11 tests (ref counting, concurrent ops, null guard, minimum display, deferred hide)
- `tests/llmFacade.test.ts` — 6 tests (pluginContext, summarizeText, getServiceType)

**Key Files Modified:**
- `src/commands/summarizeCommands.ts` — insertTextSummary/insertPdfSummary preview modal; 12 withBusyIndicator wrappers scoped to LLM calls only
- `src/commands/translateCommands.ts` — withBusyIndicator + pluginContext
- `src/commands/smartNoteCommands.ts` — withBusyIndicator + pluginContext (3 calls)
- `src/commands/flashcardCommands.ts` — withBusyIndicator + pluginContext
- `src/commands/integrationCommands.ts` — withBusyIndicator + pluginContext
- `src/services/minutesService.ts` — withBusyIndicator + pluginContext
- `src/ui/modals/MinutesCreationModal.ts` — withBusyIndicator for dictionary extraction
- `src/ui/settings/ConfigurationSettingsSection.ts` — withBusyIndicator for 6 taxonomy suggestion calls
- `src/main.ts` — busyStatusBarEl init/cleanup, withBusyIndicator for analyzeAndTagNote
- `src/services/llmFacade.ts` — pluginContext() DRY helper
- `src/ui/modals/SummaryResultModal.ts` — Discard button .setWarning()
- `styles.css` — busy indicator CSS with pulse animation, namespaced @keyframes (DRY)
- `src/i18n/types.ts`, `en.ts`, `zh-cn.ts` — aiProcessing, summaryCombinedFromSections
- `src/services/cloudService.ts` — reasoning model gating by model name (not adapter type), debug logging guard, em dash fix
- `tests/cloudService.defaults.test.ts` — 3 new tests for reasoning model request body

**Key Design Decisions:**
- Spinner scoped to LLM calls only — preview modal (user action) does not hold spinner
- Ref counting handles concurrent LLM operations (show on first, hide when all complete)
- Chunked flows wrapped at outer level to prevent flicker
- Chat commands intentionally excluded (have own persistent Notice indicator)
- Minimum 400ms display duration ensures spinner is visible even for fast LLM responses (e.g., tagging)
- Namespaced CSS keyframes: `ai-organiser-spin`, `ai-organiser-pulse`, `related-notes-spin`
- Reasoning model detection by model name prefix (gpt-5, o1, o3), not adapter type — works across OpenRouter/Groq/DeepSeek
- Multi-source failure Notice fires on discard (not only on insert)

**Documentation**: `docs/completed/wirr-plan.md`

---

### Menu Cleanup & Integration Enhancement (2026-01-29)

✅ **All 5 Parts + Review Fixes Complete**

| Part | Feature | Status |
|------|---------|--------|
| Part 1 | Remove redundant `generate-from-embedded` command | ✅ Complete |
| Part 2 | Enhanced integration: placement/format/detail dropdowns + auto-tag | ✅ Complete |
| Part 3 | Translate note: insert-at-cursor toggle | ✅ Complete |
| Part 4 | Shared `editorUtils.ts` (DRY insertion utility) | ✅ Complete |
| Part 5 | Summary result preview modal (insert/copy/discard) | ✅ Complete |
| Review | 8 findings fixed (modal Promise leak, metadata gating, stale buffer, CSS, i18n, regex, DRY extraction, tests) | ✅ Complete |

**Build Status**: 848 tests passing (37 suites) ✅

**New Files Created:**
- `src/utils/editorUtils.ts` — `insertAtCursor()`, `appendAsNewSections()`
- `src/services/prompts/integrationPrompts.ts` — placement/format/detail prompt helpers
- `src/ui/modals/SummaryResultModal.ts` — markdown preview with insert/copy/discard
- `tests/integrationPrompts.test.ts` — 16 tests (helpers + buildIntegrationPrompt)
- `tests/editorUtils.test.ts` — 7 tests (cursor insert, section append, edge cases)

**Files Deleted:**
- `src/ui/modals/ContentSelectionModal.ts` — orphaned by Part 1 removal

**Key Files Modified:**
- `src/commands/integrationCommands.ts` — modal dropdowns, prompt builder, placement branching
- `src/commands/summarizeCommands.ts` — async insert functions with preview modal, DRY `showSummaryPreviewOrInsert()` helper
- `src/commands/translateCommands.ts` — insert-at-cursor support
- `src/ui/modals/TranslateModal.ts` — toggle UI
- `src/core/constants.ts` — `PlacementStrategy`, `FormatStrategy`, `DetailStrategy` types + defaults
- `styles.css` — scrollable `.ai-organiser-summary-preview` (max-height 50vh)
- i18n files — 20+ new keys (integration dropdowns, translate toggle, summary modal, copiedToClipboard)

**Review Fixes Applied:**
- Modal ESC/X now fires `'discard'` action (no hanging Promise)
- Structured web summary metadata gated on `action === 'cursor'` only
- Auto-tag uses `editor.getValue()` instead of disk read (fresh buffer)
- Preview modal scrollable via CSS (`.ai-organiser-summary-preview`)
- `copiedToClipboard` i18n key replaces hardcoded notice
- `appendAsNewSections` regex matches `## References` at file start
- 3× duplicated preview block extracted to `showSummaryPreviewOrInsert()`

**Documentation**: `docs/completed/menu-plan.md`

---

### Multi-Source Translation Feature Complete (2026-01-29)

✅ **All 3 Phases + 2 Review Rounds Complete**

| Phase | Feature | Status |
|-------|---------|--------|
| Phase 1 | Multi-Source Translation | ✅ Complete |
| Phase 2 | Wikilink Source Cleanup | ✅ Complete |
| Phase 3 | External PDF URL Download | ✅ Complete |
| Review Round 2 | 3 code fixes (double-wrap, document type, YouTube title) | ✅ Complete |
| Review Round 3 | 4 doc fixes (plan consistency) | ✅ Complete |

**Build Status**: 825 tests passing (35 suites) ✅

**New Files Created:**
- `src/services/apiKeyHelpers.ts` — shared API key resolution (YouTube Gemini, audio transcription)
- `src/services/pdfTranslationService.ts` — shared PDF provider config + multimodal translation
- `tests/pdfService.test.ts` — 11 tests for external PDF URL download

**Key Files Modified:**
- `src/commands/translateCommands.ts` — smart dispatch, multi-source orchestrator, sequential processing
- `src/ui/modals/MultiSourceModal.ts` — parameterized for translate mode (language selector, CTA)
- `src/services/pdfService.ts` — URL download support for external PDFs (HTTPS, 20MB limit)
- `src/utils/sourceDetection.ts` — wikilink cleanup in `removeProcessedSources()`
- `src/utils/noteStructure.ts` — added `'document'` SourceType
- `src/services/prompts/translatePrompts.ts` — source context (type, title) for better translations
- `src/i18n/types.ts`, `en.ts`, `zh-cn.ts` — translate modal + message keys

**Feature Summary:**
- Smart dispatch: selection → translate selection; no selection + sources → multi-source modal; no selection + no sources → translate note
- Multi-source modal reuse: parameterized existing `MultiSourceModal` with translate mode config
- Source types: URLs, YouTube, PDFs (vault + external), documents, audio
- Sequential processing with per-source progress notices
- Error isolation: failed sources don't block others
- Privacy consent gating before external fetch
- Content chunking for large sources via `chunkContent()` + `getMaxContentChars()`
- Wikilink cleanup after processing (cross-cutting fix for summarize + translate)
- External PDF download via Obsidian `requestUrl` (cross-cutting fix)

**Documentation**: `docs/completed/translate-plan.md`

---

### Obsidian API Upgrade Complete - Ready for Signoff (2026-01-27)

✅ **All Three Phases Implemented and Tested**

| Phase | Feature | Status | Tests |
|-------|---------|--------|-------|
| Phase 1 | SecretStorage | ✅ Complete | 32 tests |
| Phase 2 | SettingGroup | ✅ Complete | No regressions |
| Phase 3 | Bases Service | ✅ Complete | 4 tests |

**Build Status**: 802 tests passing ✅

**Documentation**:
- `docs/API-UPGRADE-REFERENCE.md`: Quick reference for developers (keep)
- `docs/api-plan.md`: Planning document (can archive)
- `docs/api-upgrade-summary.md`: Implementation summary (can archive)
- `docs/usertest.md`: Updated with SecretStorage manual tests

**Test Fix (2026-01-27)**:
- Fixed dashboardService.test.ts: Added `basesService` mock to plugin mock object
- All 802 tests now pass (was 793 before fix)

**Next Steps**:
- Manual testing on Obsidian 1.11+ for SecretStorage verification
- Version bump to 1.0.16
- Deploy to Obsidian vault

---

### SettingGroup Phase 2 Complete (2026-01-27)

✅ **Obsidian 1.11+ SettingGroup Native Integration**
- **Updated File** (40 lines):
  - `src/ui/settings/BaseSettingSection.ts`: Added SettingGroup wrapper with fallback

- **Key Features**:
  - Detects SettingGroup API availability (Obsidian 1.11+)
  - Uses native SettingGroup for h1 headers when available
  - Falls back to custom headers for h2 or older Obsidian versions
  - Zero breaking changes - all existing sections work unchanged
  - Progressive enhancement - native API auto-used when available

- **Test Results**: 802 tests pass ✅ (no new tests added, verified backward compatibility)

**Implementation Details**:
- `isSettingGroupAvailable()`: Safely detects SettingGroup in Obsidian module
- `createNativeSettingGroup()`: Wraps SettingGroup with icon and title
- `createCustomHeader()`: Existing fallback implementation preserved
- `createSectionHeader()`: Router logic selects native vs fallback
- Non-breaking: All existing section classes work without modification

**Gestalt UI Principles Preserved**:
- Proximity: Same grouped settings structure
- Similarity: Same h1/h2 visual hierarchy (native SettingGroup maintains this)
- Common Region: Same section containers
- Continuity: Same logical flow through settings

### Phase 6 Implementation Verified (2026-01-27)

✅ **All 5 Settings Sections Now Using renderApiKeyField()**
- `LLMSettingsSection.ts`: Uses renderApiKeyField() for cloud API key
- `SemanticSearchSettingsSection.ts`: Uses renderApiKeyField() with fallback
- `YouTubeSettingsSection.ts`: Uses renderApiKeyField() for Gemini key
- `PDFSettingsSection.ts`: Uses renderApiKeyField() with provider selection
- `AudioTranscriptionSettingsSection.ts`: Uses renderApiKeyField() for audio keys

**Phase 6 Complete**: All API key fields now unified through renderApiKeyField() helper

### SecretStorage Phase 1 Complete (2026-01-27)

✅ **Obsidian SecretStorage Integration (API v1.11+)**
- **New Files Created** (555 lines total):
  - `src/core/secretIds.ts`: Standard/plugin-specific secret IDs with 10 provider mappings
  - `src/services/secretStorageService.ts`: Full service with 4-step key resolution chain
  - `src/ui/modals/MigrationConfirmModal.ts`: User confirmation with device-specific warnings
  - `tests/mocks/mockSecretStorage.ts`: In-memory mock for CI/CD
  - `tests/secretStorageService.test.ts`: 32 comprehensive tests

- **Files Updated** (6 files):
  - Settings, services, main plugin, UI helpers, i18n (19 strings), CSS styles

- **Key Features**:
  - Cross-plugin key sharing (standard secret IDs)
  - 4-step inheritance chain: plugin → provider → main → fallback
  - User-initiated migration with device-specific warnings
  - Backward compatible (pre-1.11 uses plain-text fallback)

- **Test Results**: 802 tests pass ✅ (32 new SecretStorage + 770 existing)

### Audit Fixes Complete (2026-01-27)

✅ **Command Picker i18n Audit**
- Replaced all hardcoded UI strings with i18n keys
- Added 10 new translation keys (`modals.commandPicker.*`)
- Category names now localized: Create, Enhance, Organize, Search, Analyze, Integrate
- Command names use existing `t.commands.*` keys
- Arrow characters (↑↓, ↵) confirmed as valid Unicode

✅ **New Test Coverage**
- `tests/commandPicker.test.ts`: 12 integration tests for categories and commands
- `tests/sourcePackService.test.ts`: 5 settings-to-SourcePackConfig wiring tests
- **Total: 766 tests across 30 suites** (17 new tests added)

### Summarization Testing Complete (2026-01-26)

✅ **Section 4: Summarization - All Tests Passed**
- URL Summarization: Source detection, summary insertion, metadata
- YouTube Summarization: Gemini-native video processing, transcript saving
- PDF Summarization: Vault and external PDF handling
- Audio Summarization: Transcription via Whisper, transcript saving
- Multi-Source Summarization: Combined sources with oversized handling

**DRY/SOLID Refactoring Applied**:
- `transcribeAudioWithFullWorkflow()`: Unified audio function (chunked >20min, compressed >25MB, direct)
- `summarizePdfWithFullWorkflow()`: Unified PDF function (vault + external handling)
- Both multi-source and standalone handlers now use same encapsulated functions
- Removed ~150 lines of duplicate code

### Manual Testing Started (2026-01-26)

✅ **Pre-Test Checklist Complete**
- Build: `npm run build:quick` passes (3.0 MB, 79ms)
- Deployment: Files deployed to Obsidian plugin folder
- Status: Plugin ready for manual smoke test

**Sections Completed**:
- ✅ Pre-Test
- ✅ Settings UI
- ✅ Command Picker
- ✅ Tagging
- ✅ Summarization

**Next Steps**: Testing Translation → Smart Notes → Meeting Minutes

---

### Hardcoding Remediation Complete (2026-01-26)

### Hardcoding Remediation Complete (2026-01-26)

✅ **All 4 Phases Delivered**

| Phase | Scope | Outcome |
|-------|-------|---------|
| 1. Path Resolution | P0 | Centralized folder helpers with legacy path tolerance |
| 2. Constants | P1 | `SUMMARY_HOOK_MAX_LENGTH`, `CHUNK_TOKEN_LIMIT` unified |
| 3. Provider Registry | P1 | 14 LLM adapters with single-source defaults/endpoints |
| 4. Service Defaults | P1 | Embedding registry, audio transcription registry |

**Key Achievements**:
- **Path drift eliminated**: All folder-sensitive flows honor `pluginFolder` with legacy full-path tolerance
- **Provider registry**: `providerRegistry.ts` drives dropdowns, defaults, endpoints for all 14 adapters
- **Embedding registry**: `embeddingRegistry.ts` with 6 providers, model lists, UI-friendly labels
- **Build separation**: `tsconfig.build.json` for source-only type checking (test types isolated)
- **Test coverage**: 766 tests across 30 suites (87 new tests added during remediation)

### Testing Strategy Complete (2026-01-25)

✅ **All Three Testing Gaps Closed**

| Gap | Tests | Coverage | Status |
|-----|-------|----------|--------|
| MinutesService | 23 | 100% statements, 80.7% branches | ✅ Complete |
| Prompt Modules | 72 | 80.57% module coverage | ✅ Complete |
| RAG/Embeddings | 19 | ~75% RAGService coverage | ✅ Complete |

**Final Test Suite**: 631 tests across 23 test files (~48% overall coverage)

**Key Achievements**:
- MinutesService: Full coverage of chunked/non-chunked paths, language fallback, deduplication
- Prompt Modules: Invariant-based tests (no brittle snapshots) for all 8 prompt builders
- RAGService: Deterministic tests with TestVectorStore mock (no network calls)

See [usertest.md](usertest.md) for manual testing checklist.

### UX/UI Refactoring Complete (2026-01-25)

✅ **All 5 Phases Delivered**

| Phase | Priority | Achievement |
|-------|----------|-------------|
| 1. Command Picker | P0 | Expanded from 13 to 29 commands with category styling |
| 2. i18n Core | P0 | 24 keys added, chatCommands/integrationCommands converted |
| 3. i18n Summarize | P1 | 20 hard-coded notices replaced with plugin.t |
| 4. RAG Options Gating | P1 | RAG settings hidden when vault chat disabled |
| 5. Browser Prompt | P1 | Replaced prompt() with in-modal folder input |

**Metrics**:
- 40 new i18n keys added (with dynamic placeholders)
- 38+ hard-coded notices converted (72% of high-priority areas)
- Command picker coverage: 13 → 29 commands (123% increase)
- All tests passing (631 unit + 17 integration)

---

## Overview

AI Organiser is an Obsidian plugin that uses AI to automatically organize, tag, summarize, and enhance notes. It supports multiple LLM providers (local and cloud) and includes semantic search, RAG-enhanced features, and knowledge organization tools.

---

## Architecture

### Core Structure

```
src/
├── main.ts                    # Plugin entry point
├── core/settings.ts           # Settings schema
├── commands/                  # Command registration (9 files)
├── services/
│   ├── cloudService.ts        # Cloud LLM integration
│   ├── localService.ts        # Local LLM (Ollama, etc.)
│   ├── adapters/              # 13 provider adapters
│   ├── embeddings/            # 5 embedding providers
│   ├── vector/                # Voy WASM vector store
│   └── prompts/               # Prompt engineering
├── ui/
│   ├── modals/                # 15 interaction modals
│   ├── settings/              # 11 settings sections
│   └── views/                 # Tag network, Related notes
├── utils/                     # Utilities (tag, note structure, URL validation)
└── i18n/                      # English + Chinese translations
```

### Service Pattern

```
main.ts (Plugin)
    │
    ├── CloudService ──► Adapters (Claude, OpenAI, Gemini, etc.)
    ├── LocalService ──► Ollama, LM Studio, LocalAI
    ├── EmbeddingService ──► OpenAI, Ollama, Gemini, Cohere, Voyage
    └── VectorStore ──► Voy WASM (semantic search)
```

---

## Features

### Core Features

| Feature | Commands | Notes |
|---------|----------|-------|
| **Tagging** | Tag note/folder/vault, Clear tags | Taxonomy-based, 3-tier hierarchy |
| **Summarization** | URL, PDF, YouTube, Audio | 5 personas, RAG-enhanced, Gemini-native YouTube, 6hr+ audio chunking |
| **Meeting Minutes** | Create meeting minutes | Persona-based, transcript chunking, Obsidian Tasks |
| **Smart Notes** | Improve, Find resources, Diagrams | AI personas, Mermaid support |
| **Translation** | Note, Selection, Multi-Source | 20+ languages, URL/YouTube/PDF/audio/document sources |
| **Semantic Search** | Search, Index, Related notes | Voy WASM, 5 embedding providers |
| **NotebookLM** | Export, Toggle, Clear, Open folder | Sanitized source packs, modular export |
| **Utilities** | Tag network, Export flashcards | D3.js visualization, Anki/Brainscape |

### LLM Providers

| Type | Providers |
|------|-----------|
| **Cloud** | Claude, OpenAI, Gemini, Groq, DeepSeek, OpenRouter, Cohere, Mistral, Grok, AWS Bedrock, Vertex AI, Aliyun |
| **Local** | Ollama, LM Studio, LocalAI, Jan, KoboldCpp |

### Embedding Providers

| Provider | Models |
|----------|--------|
| OpenAI | text-embedding-3-small/large |
| Ollama | nomic-embed-text, mxbai-embed-large |
| Gemini | text-embedding-004 |
| Cohere | embed-english-v3.0 |
| Voyage AI | voyage-3, voyage-3-lite |

---

## Settings Organization

Settings display in logical order:

1. **AI Provider** - LLM provider, API keys, models
2. **Language** - Interface and output language settings
3. **Tagging** - Max tags, exclusions, note structure toggle
4. **Summarization** - Length, personas, transcript saving
5. **YouTube** - Gemini API key (auto-inherits), model selection
6. **Audio Transcription** - Provider (OpenAI/Groq), API key (auto-inherits)
7. **Semantic Search** - Embeddings, indexing, RAG options
8. **Obsidian Bases** - Structured metadata, migration, dashboards
9. **NotebookLM** - Export settings, sanitisation, module word budget
10. **Mobile** - Provider fallback, vector store guards
11. **Configuration** - Config folder, taxonomy files

---

## Configuration Files

All plugin files under `AI-Organiser/` (configurable):

```
AI-Organiser/
├── Config/
│   ├── taxonomy.md           # Tagging themes/disciplines
│   ├── excluded-tags.md      # Tags to never suggest
│   ├── writing-personas.md   # Note improvement personas
│   ├── summary-personas.md   # Summarization personas
│   ├── minutes-personas.md   # Meeting minutes personas
│   └── dictionaries/         # Terminology dictionaries (syncs across devices)
├── Transcripts/              # Audio/YouTube transcripts
└── Flashcards/               # Exported flashcards
```

---

## Recent Updates (January 2026)

### Document Extraction & Multi-Feature Enhancements (January 24)
- **Centralized Document Extensions**: Single source of truth in `constants.ts`
  - `EXTRACTABLE_DOCUMENT_EXTENSIONS`: docx, xlsx, pptx, txt, rtf
  - `ALL_DOCUMENT_EXTENSIONS`: Includes PDF
  - Used consistently across detection, extraction, and pickers
- **Document Extraction Service Enhancements**:
  - TXT extraction (direct file read)
  - RTF extraction with hex/unicode decode and readability validation
  - External document URL download (HTTPS only) with progress feedback
  - Error handling for network failures and complex RTF formats
- **Minutes Truncation UX** (inline controls following Gestalt proximity):
  - Inline dropdown per oversized document (Truncate/Use Full/Exclude)
  - Bulk "Apply to all" action positioned above document list
  - Settings: `maxDocumentChars` (default 50000), `oversizedDocumentBehavior` (ask/truncate/full)
  - Accessibility: aria-labels, touch-friendly inline warnings
- **Multi-Source Document Support**:
  - Documents section added between PDFs and Audio
  - Vault and external URL document detection
  - Settings: `multiSourceMaxDocumentChars` (100000), `multiSourceOversizedBehavior` (full)
  - Truncation confirmation modal for oversized documents
- **NotebookLM Linked Documents**: Detection and display of linked documents in export preview
- **Pending Integration Enhancement**: Optional "Resolve pending embeds" command
  - Extracts text from embedded documents/PDFs in Pending Integration section
  - Replaces embed syntax with extracted content for review before integration
- **Terminology Dictionary System**: Improve transcription accuracy with reusable dictionaries
  - `DictionaryService` for CRUD operations on terminology dictionaries
  - Dictionaries stored as markdown in `AI-Organiser/Config/dictionaries/` (syncs across devices)
  - Entry categories: person, acronym, term, project, organization
  - LLM-powered extraction from context documents (agendas, presentations)
  - Case-insensitive deduplication when adding entries across meetings
  - Dictionary content injected into prompts for consistent name/term usage
- **i18n**: 84+ new translation strings across EN + ZH-CN
- **SOLID/DRY Refactoring** (Controller Extraction):
  - **DocumentHandlingController**: Extracted document detection, extraction, caching, truncation (23 tests)
  - **DictionaryController**: Extracted dictionary CRUD, term extraction, merging (56 tests)
  - **AudioController**: Extracted audio detection and transcription state (35 tests)
  - **TruncationControls**: Reusable UI components for document truncation (8 tests)
  - Centralized `DEFAULT_MAX_DOCUMENT_CHARS` (50000) and `DEFAULT_MULTI_SOURCE_MAX_DOCUMENT_CHARS` (100000) constants
  - Added `TruncationChoice` and `OversizedBehavior` type aliases
  - Created unified `getTruncationOptions()` for DRY label/tooltip handling
  - Added `MinutesModalDependencies` interface for dependency injection
  - Modal services now support optional DI for testability
  - **No-stubs policy**: All public methods fully implemented with call sites (modal or tests)
  - **631 total tests** (including controller, utility, and prompt invariant tests)
- **Utility Testing Expansion** (238 new tests):
  - `responseParser.test.ts` (40 tests): 4-tier JSON extraction, summary hook sanitization, content type validation
  - `textChunker.test.ts` (30 tests): Transcript chunking, overlap handling, segment-based chunking
  - `sourceDetection.test.ts` (58 tests): URL/YouTube/PDF/audio detection, vault links, section context
  - `frontmatterUtils.test.ts` (45 tests): Summary hook creation, word counting, CJK language detection
  - `dashboardService.test.ts` (23 tests): Filter injection, folder paths, YAML preservation
  - `minutesPrompts.test.ts` (42 tests): Prompt generation, response parsing, JSON repair
  - Fixed `textChunker.ts` bug where `overlapChars: 0` was treated as "use default 400"

### Meeting Minutes & Bug Fixes (January 23)
- **Meeting Minutes Generation**: New feature for structured meeting notes
  - MinutesCreationModal with comprehensive meeting input fields
  - MinutesService with transcript chunking for long meetings (5000 token chunks)
  - Persona-based output styles via `minutes-personas.md` config file
  - Obsidian Tasks format support (`- [ ]` tasks below minutes)
  - Dual output option (internal + public versions)
  - Full i18n support (EN + ZH-CN)
  - New settings section for output folder, timezone, default persona
- **Bug Fixes**:
  - Fixed Enhance actions silently failing (async error handling in all modals)
  - Fixed duplicate References/Pending Integration sections (idempotent detection with case-insensitive matching)
  - Fixed folder suggestions ignoring selected root folder (now respects folder scope)
  - Fixed translation adding unwanted formatting (explicit preserve-only instruction)

### YouTube & Audio Processing (January 23)
- **YouTube**: Switched to Gemini-native video understanding (no more transcript scraping)
  - Gemini processes YouTube URLs directly via native video API
  - Falls back to transcript scraping only if Gemini unavailable
  - Dedicated YouTube settings section with model selection
  - Auto-inherits Gemini API key from main provider settings
- **Audio Transcription**: Now supports 6+ hour recordings with chunked processing
  - Automatic chunking for files > 20 minutes (5-minute segments)
  - Context chaining between chunks for seamless transcription
  - Extended timeouts: FFmpeg (60 min), compress+split (2 hr), API (10 min/chunk)
  - Dedicated Audio Transcription settings section
  - Auto-inherits OpenAI/Groq API key from main provider settings
  - Progress notifications: "Transcribing chunk 4/24 (17%)"

### Multi-Source Summarization (January 22)
- Persona selection in multi-source modal
- Source processing status checklist
- Summary placement fixed (before references, not after)

### Language & UX Audit
- Rewrote all UI text for clarity and brevity
- Applied American English consistently
- Removed support section from settings
- Updated command names for conciseness

### Command Consolidation (Implemented)
- Consolidated 27 commands to 12 using Smart Dispatcher pattern (56% reduction)
- Context-aware detection eliminates "Click Tax"
- Smart dispatchers for Summarize, Translate, Tag, Clear Tags, Enhance

### Mobile Optimization (Implemented)
- Tri-state provider fallback (auto/cloud-only/custom)
- Vector store size guards with lazy loading
- UI adaptations (Tag Network list, Related Notes modal)
- Vault-only file pickers on mobile
- Network hardening (60s timeouts, data warnings)
- Mobile settings section in plugin settings

### Audit Fixes
- Fixed settings re-render issue (semantic search toggle)
- Added proper cleanup when disabling semantic search
- Changed similarity display from fake "90%" to "Related" badge
- Added `ensureNoteStructureIfEnabled()` to all commands

### Note Structure Feature
- New setting: "Add Note Sections" toggle
- All AI commands ensure References/Pending Integration sections exist
- No duplicate sections created

### Embedding Infrastructure
- 5 embedding providers with factory pattern
- API key inheritance chain
- Local setup wizard for Ollama
- Provider-specific model dropdowns

### RAG Enhancements (Phase 4.4)
- Related Notes sidebar view
- RAG-enhanced summarization with source citations
- Search result caching (5-min TTL)

### NotebookLM Integration (New)
- Export Obsidian notes as sanitized source packs for NotebookLM
- 8-step sanitisation pipeline (frontmatter, dataview, callouts, embeds, links, images, plugin noise)
- 3 export modes: auto, modular (split by word budget), single file
- Cycle detection for embedded notes
- Revision management with automatic changelog generation
- Stable anchors with short IDs for NotebookLM citations
- Post-export tag actions (keep/clear/archive)
- Full i18n support (EN/ZH-CN)

### Obsidian Bases Integration (Completed January 2025)
- Structured metadata system (10 `aio_*` properties including `aio_persona`)
- 4-stage migration wizard with smart content detection
- 10 built-in dashboard templates (.base files) in 2 categories:
  - 5 default templates (Knowledge Base, Research Tracker, etc.)
  - 5 persona templates (Student, Executive, Casual, Researcher, Technical)
- Persona tracking: `aio_persona` written to frontmatter during summarization
- Conditional structured output in summarization
- Complete bilingual support (EN/ZH-CN)
- Settings section with migration and dashboard creation buttons

---

## Build & Test

```bash
npm run dev        # Development (watch mode)
npm run build      # Production build (includes tests)
npm run build:quick # Production build (source type-check only)
npm test           # Run 871 unit tests (39 suites)
npm run test:auto  # Run 22 automated integration tests
```

**Deploy:** Copy `main.js`, `manifest.json`, `styles.css` to Obsidian plugins folder.

**Testing:** See [usertest.md](usertest.md) for manual test checklist.

---

## Known Limitations

1. Interface language change requires Obsidian restart
2. PDF summarization only with Claude/Gemini (multimodal)
3. Audio transcription requires OpenAI or Groq API key (auto-inherits from main provider)
4. Claude/Anthropic has no embeddings API (use Voyage AI)
5. YouTube processing requires Gemini API key (auto-inherits from main provider)
6. Audio chunking requires FFmpeg installed on system

---

## Repository

- **GitHub:** [Lbstrydom/ai-organiser](https://github.com/Lbstrydom/ai-organiser)
- **Author:** L Strydom
