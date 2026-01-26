# AI Organiser - Development Status

**Version:** 1.0.15
**Last Updated:** January 26, 2026
**Status:** Feature Complete - Manual Testing In Progress

---

## Recent Updates

### Manual Testing Started (2026-01-26)

✅ **Pre-Test Checklist Complete**
- Build: `npm run build:quick` passes (3.0 MB, 79ms)
- Deployment: Files deployed to Obsidian plugin folder
- Status: Plugin ready for manual smoke test

**Next Steps**: Testing Settings UI → Command Picker → Tagging features

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
- **Test coverage**: 679 tests across 29 suites (48 new tests added during remediation)

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
| **Translation** | Note, Selection | 20+ languages |
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
npm test           # Run 679 unit tests (29 suites)
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
