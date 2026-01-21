# AI Organiser - Development Status

**Version:** 1.0.15
**Last Updated:** January 21, 2026
**Status:** Feature Complete + Phase 4.4 RAG Enhancements

---

## Overview

AI Organiser is an Obsidian plugin that leverages AI to automatically organize, tag, summarize, and enhance notes. It supports multiple LLM providers (local and cloud) and includes features for content summarization, translation, smart note enhancement, and knowledge organization.

---

## Architecture

### Core Structure

```
src/
├── main.ts                    # Plugin entry point, lifecycle management
├── core/
│   └── settings.ts            # Settings schema and defaults
├── commands/                  # Command registration by category
│   ├── index.ts               # Command registration orchestrator
│   ├── generateCommands.ts    # Tag generation commands
│   ├── clearCommands.ts       # Tag clearing commands
│   ├── summarizeCommands.ts   # URL/PDF/YouTube/Audio summarization
│   ├── translateCommands.ts   # Translation commands
│   ├── smartNoteCommands.ts   # Improve note, find resources, mermaid diagrams
│   ├── integrationCommands.ts # Pending Integration workflow
│   ├── flashcardCommands.ts   # Flashcard export (Anki/Brainscape)
│   ├── highlightCommands.ts   # Text highlighting commands
│   └── utilityCommands.ts     # Collect tags, tag network
├── services/                  # Business logic layer
│   ├── cloudService.ts        # Cloud LLM integration
│   ├── localService.ts        # Local LLM integration (Ollama, etc.)
│   ├── baseService.ts         # Common LLM service interface
│   ├── configurationService.ts # User-editable config management
│   ├── adapters/              # Provider-specific adapters
│   │   ├── claudeAdapter.ts
│   │   ├── openaiAdapter.ts
│   │   ├── geminiAdapter.ts
│   │   ├── groqAdapter.ts
│   │   └── ... (13 total adapters)
│   ├── embeddings/            # Embedding service layer (NEW)
│   │   ├── types.ts           # IEmbeddingService interface
│   │   ├── embeddingServiceFactory.ts # Factory with API key inheritance
│   │   ├── openaiEmbeddingService.ts
│   │   ├── ollamaEmbeddingService.ts
│   │   ├── geminiEmbeddingService.ts
│   │   ├── cohereEmbeddingService.ts
│   │   └── voyageEmbeddingService.ts
│   ├── vector/                # Vector store (Voy WASM)
│   │   ├── types.ts           # IVectorStore, VectorDocument
│   │   ├── vectorStoreService.ts # Service with search caching
│   │   ├── voyVectorStore.ts  # Voy WASM implementation
│   │   └── simpleVectorStore.ts # Fallback implementation
│   ├── prompts/               # Prompt engineering
│   │   ├── tagPrompts.ts      # Tagging prompts
│   │   ├── summaryPrompts.ts  # Summarization prompts
│   │   ├── summaryPersonas.ts # Summary style personas
│   │   ├── translatePrompts.ts
│   │   ├── flashcardPrompts.ts # Flashcard generation (Anki/Brainscape)
│   │   └── diagramPrompts.ts   # Mermaid diagram generation
│   └── ... (specialized services)
├── ui/
│   ├── modals/                # User interaction modals
│   │   ├── CommandPickerModal.ts    # Unified command launcher
│   │   ├── PersonaSelectModal.ts    # AI persona selection
│   │   ├── ImproveNoteModal.ts      # Note improvement dialog
│   │   ├── UrlInputModal.ts         # URL summarization input
│   │   ├── PdfSelectModal.ts        # PDF file picker
│   │   ├── AudioSelectModal.ts      # Audio file picker
│   │   ├── FlashcardExportModal.ts  # Flashcard format/style selection
│   │   ├── MermaidDiagramModal.ts   # Diagram type selection
│   │   ├── LocalSetupWizardModal.ts # Local AI setup wizard (NEW)
│   │   └── ... (15 total modals)
│   ├── settings/              # Settings UI sections
│   │   ├── AIOrganiserSettingTab.ts # Main settings tab orchestrator
│   │   ├── BaseSettingSection.ts    # Base class for sections
│   │   ├── LLMSettingsSection.ts    # LLM provider, API keys
│   │   ├── InterfaceSettingsSection.ts # Languages (interface + output)
│   │   ├── TaggingSettingsSection.ts   # Max tags, exclusions
│   │   ├── SummarizationSettingsSection.ts # Summary options
│   │   ├── SemanticSearchSettingsSection.ts # Embeddings, RAG
│   │   ├── ConfigurationSettingsSection.ts  # Config files
│   │   └── SupportSection.ts        # Buy me a coffee
│   └── views/
│       └── TagNetworkView.ts  # D3.js tag visualization
├── utils/                     # Utility functions
│   ├── tagUtils.ts            # Tag formatting and operations
│   ├── noteStructure.ts       # Standard note sections
│   ├── urlValidator.ts        # SSRF protection
│   └── ...
└── i18n/                      # Internationalization
    ├── types.ts               # Type-safe translation keys
    ├── en.ts                  # English translations
    └── zh-cn.ts               # Simplified Chinese translations
```

### Service Layer Pattern

```
┌─────────────────────────────────────────────────────────────┐
│                      main.ts (Plugin)                       │
│  - Lifecycle management                                     │
│  - Command registration                                     │
│  - Service orchestration                                    │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  CloudService   │ │  LocalService   │ │ ConfigService   │
│  - API calls    │ │  - Ollama/local │ │ - Taxonomy      │
│  - Adapters     │ │  - Model fetch  │ │ - Personas      │
└─────────────────┘ └─────────────────┘ └─────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│                    Adapter Layer                            │
│  Claude | OpenAI | Gemini | Groq | DeepSeek | ...          │
│  - Provider-specific API formatting                         │
│  - Response parsing                                         │
│  - Error handling                                          │
└─────────────────────────────────────────────────────────────┘
```

---

## Features Implemented

### 1. Intelligent Tagging System

**Commands:**
- Generate tags for current note
- Generate tags for folder
- Generate tags for entire vault
- Clear tags (note/folder/vault)

**Features:**
- Taxonomy-based tagging with themes and disciplines
- 3-tier tag hierarchy enforcement
- User-editable taxonomy via markdown files
- Excluded tags configuration
- Title and folder suggestions

### 2. Content Summarization

**Commands:**
- Summarize from URL (web articles)
- Summarize from PDF (multimodal for Claude/Gemini)
- Summarize from YouTube (via captions)
- Summarize from Audio (transcription + summarization)

**Features:**
- 5 built-in summary personas (Student, Executive, Casual, Researcher, Technical)
- Content chunking for large documents
- Token limit handling with user choice (truncate/chunk)
- Privacy notices for cloud providers
- Automatic reference section population
- **Transcript saving** - Full transcripts from audio/YouTube saved to configurable folder with metadata

### 3. Smart Note Features

**Commands:**
- Improve note with AI (context-aware enhancement)
- Find related resources (YouTube + web search)
- Generate note from embedded content
- Integrate pending content into notes

**Features:**
- User-selectable AI personas for writing style
- Standard note structure with References and Pending Integration sections
- Embedded content extraction (images, PDFs, links)

### 4. Translation

**Commands:**
- Translate entire note
- Translate selection

**Features:**
- Language dropdown with common languages
- Preserves markdown formatting

### 5. Flashcard Export

**Commands:**
- Export flashcards from current note

**Features:**
- Two card styles:
  - **Standard Q&A** - Traditional question and answer format
  - **Multiple Choice** - Exam-style with A, B, C, D options and explanations
- Two export formats:
  - **Anki** - CSV with MathJax notation support
  - **Brainscape** - CSV with plain text math conversion
- Optional context for card generation focus
- Validates CSV output before saving
- Saved to `AI-Organiser/Flashcards/` folder

**Implementation:**
- [flashcardCommands.ts](../src/commands/flashcardCommands.ts)
- [flashcardPrompts.ts](../src/services/prompts/flashcardPrompts.ts)
- [FlashcardExportModal.ts](../src/ui/modals/FlashcardExportModal.ts)

### 6. Mermaid Diagram Generation

**Commands:**
- Generate diagram from note content

**Features:**
- Multiple diagram types: flowchart, sequence, class, mindmap, timeline, ER, state
- AI-generated diagrams based on note content
- Persona selection for diagram style
- Diagrams inserted as Mermaid code blocks

**Implementation:**
- [smartNoteCommands.ts](../src/commands/smartNoteCommands.ts)
- [diagramPrompts.ts](../src/services/prompts/diagramPrompts.ts)
- [MermaidDiagramModal.ts](../src/ui/modals/MermaidDiagramModal.ts)

### 7. Text Highlighting

**Commands:**
- Highlight selection (multiple types)

**Features:**
- Multiple highlight types via HTML mark tags
- Quick highlighting of selected text

**Implementation:**
- [highlightCommands.ts](../src/commands/highlightCommands.ts)

### 8. Utilities

**Commands:**
- Collect all tags to file
- Show tag network visualization

**Features:**
- D3.js-powered interactive tag graph
- Tag co-occurrence relationships

---

## UX Design

### Command Picker (NEW)

A unified modal for accessing all plugin commands, solving the UX challenge of 27+ commands in Ctrl+P.

**Access:**
- Ribbon icon (sparkles ✨)
- Command palette: "Open command picker"
- Assignable hotkey

**Features:**
- Fuzzy search across all commands
- Category badges (Tagging, Summarize, Smart Notes, Translate, Utilities)
- Keyboard navigation
- Icons for each command

**Implementation:** [CommandPickerModal.ts](../src/ui/modals/CommandPickerModal.ts)

### Persona System

Two types of personas for different use cases:

**Writing Personas** (`AI-Organiser/Config/writing-personas.md`):
Used for "Improve note with AI" command. Controls writing style and tone.
1. **Balanced** - Clear, well-organized notes (default)
2. **Academic** - Formal, rigorous with citations
3. **Practical** - Actionable, step-by-step focus
4. **Concise** - Brief, essential points only
5. **Creative** - Narrative, engaging style
6. **Socratic** - Question-driven exploration

**Summary Personas** (`AI-Organiser/Config/summary-personas.md`):
Used for URL/PDF/YouTube/Audio summarization. Controls summary format and structure.
1. **Student** - Academic study notes with hierarchical structure (default)
2. **Executive** - Business briefing with ROI and action items
3. **Casual Reader** - Fun, conversational with analogies
4. **Researcher** - Academic notes with methodology and citations
5. **Technical** - Developer-focused with code patterns

**UI Integration:**
- Persona selector button in AI command modals
- Full persona selection modal
- User can edit personas via markdown files

**Implementation:**
- [PersonaSelectModal.ts](../src/ui/modals/PersonaSelectModal.ts)
- [configurationService.ts](../src/services/configurationService.ts)

### Settings Organization

Settings divided into logical sections (in display order):
1. **LLM Settings** - Provider, API keys, models
2. **Interface** - Interface language, output languages (tag/summary) - consolidated
3. **Tagging Settings** - Max tags, folder exclusions
4. **Summarization Settings** - Length, default persona, transcript saving
5. **Semantic Search** - Embeddings, indexing, RAG settings
6. **Configuration** - Config folder, taxonomy management
7. **Support** - Buy Me a Coffee link

**UX Improvements (January 2026):**
- Language settings consolidated into Interface section
- Embedding models now use provider-specific dropdowns
- Embedding API key shows inheritance from main LLM key
- Excluded folders toggle for shared vs custom indexing exclusions

---

## LLM Provider Support

### Cloud Providers (13 adapters)

| Provider | Tagging | Summarization | PDF Support | Audio |
|----------|---------|---------------|-------------|-------|
| Claude | ✅ | ✅ | ✅ (native) | via OpenAI |
| OpenAI | ✅ | ✅ | ❌ | ✅ (Whisper) |
| Gemini | ✅ | ✅ | ✅ (native) | via OpenAI |
| Groq | ✅ | ✅ | ❌ | ✅ (Whisper) |
| DeepSeek | ✅ | ✅ | ❌ | - |
| OpenRouter | ✅ | ✅ | varies | - |
| AWS Bedrock | ✅ | ✅ | varies | - |
| Vertex AI | ✅ | ✅ | ✅ | - |
| Aliyun | ✅ | ✅ | ❌ | - |
| Cohere | ✅ | ✅ | ❌ | - |
| Grok | ✅ | ✅ | ❌ | - |
| Mistral | ✅ | ✅ | ❌ | - |
| OpenAI Compatible | ✅ | ✅ | ❌ | - |

### Local Providers

- **Ollama** - Full support
- **LM Studio** - Full support
- **LocalAI** - Full support
- **Jan** - Full support
- **KoboldCpp** - Full support

---

## Configuration System

### Unified Folder Structure

All plugin files are consolidated under a single configurable folder (default: `AI-Organiser/`):

```
AI-Organiser/
├── Config/                    # User-editable configuration files
│   ├── taxonomy.md            # Themes and disciplines for tagging
│   ├── excluded-tags.md       # Tags to never suggest
│   ├── writing-personas.md    # Personas for note improvement
│   └── summary-personas.md    # Personas for summarization
├── Transcripts/               # Audio/YouTube transcripts
│   └── [note-name] - transcript.md
└── Flashcards/                # Exported flashcard files
    └── [note-name] - [format] - [date].csv
```

### User-Editable Config Files

Located in `AI-Organiser/Config/`:

1. **taxonomy.md** - Themes and disciplines for tagging
2. **excluded-tags.md** - Tags to never suggest
3. **writing-personas.md** - Personas for note improvement
4. **summary-personas.md** - Personas for summarization

### Markdown Format

```markdown
### balanced
**Name:** Balanced
**Description:** Clear, informative notes
**Default:** Yes

```prompt
Style guidelines:
- Use clear, straightforward language
- Balance detail with readability
```
```

---

## Internationalization

**Supported Languages:**
- English (en)
- Simplified Chinese (zh-cn)

**Type-Safe Implementation:**
- `Translations` interface in [types.ts](../src/i18n/types.ts)
- All UI strings referenced via `plugin.t.section.key`
- Language change requires Obsidian restart

---

## Security Considerations

### SSRF Protection
- URL validation in [urlValidator.ts](../src/utils/urlValidator.ts)
- Blocks private IP ranges, localhost, internal networks

### Prompt Injection Protection
- XML-structured prompts with explicit boundaries
- Critical instructions wrapper in summary prompts
- Input sanitization before LLM calls

### Privacy
- Session-based privacy notices for cloud providers
- No data persistence beyond Obsidian vault
- API keys stored in Obsidian's settings

---

## Build & Deploy

### Commands

```bash
# Development (watch mode)
npm run dev

# Production build
npm run build

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Version bump
npm run version
```

### Output

- `main.js` - Bundled plugin (~746kb)
- `manifest.json` - Plugin metadata
- `styles.css` - UI styles

### Deploy Path

```
C:\obsidian\Second Brain\.obsidian\plugins\ai-organiser\
```

---

## Testing

### Automated Tests

**95 unit tests** using Vitest:

| Test File | Tests | Coverage |
|-----------|-------|----------|
| `tests/urlValidator.test.ts` | 30 | SSRF protection, URL validation |
| `tests/tagUtils.test.ts` | 43 | Tag formatting, merging, exclusion patterns |
| `tests/summaryPrompts.test.ts` | 22 | Prompt building, content insertion |

**Run tests:**
```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # With coverage report
```

### CI/CD

GitHub Actions workflow (`.github/workflows/ci.yml`):
- Runs on push to main/develop and PRs
- Tests on Node 18.x and 20.x
- Runs unit tests then builds
- TypeScript type checking

### Manual Testing

See [usertest.md](usertest.md) for comprehensive manual testing checklist (254 test cases).

---

## File Summary

| Category | Count | Key Files |
|----------|-------|-----------|
| Commands | 9 | generateCommands, summarizeCommands, flashcardCommands, highlightCommands |
| Services | 15 | cloudService, localService, configurationService |
| Adapters | 13 | claude, openai, gemini, groq, etc. |
| Modals | 14 | CommandPickerModal, FlashcardExportModal, MermaidDiagramModal |
| Settings | 7 | LLMSettingsSection, TaggingSettingsSection, SummarizationSettingsSection |
| Prompts | 5 | tagPrompts, summaryPrompts, flashcardPrompts, diagramPrompts |
| i18n | 3 | types, en, zh-cn |
| Utils | 8 | tagUtils, noteStructure, urlValidator |
| Tests | 3 | urlValidator.test, tagUtils.test, summaryPrompts.test |

**Total TypeScript Files:** 85+
**Lines of Code:** ~13,000+
**Unit Tests:** 95

---

## Recent Development

### 1. Flashcard Export Feature
- Generate flashcards from note content using AI
- Two card styles:
  - **Standard Q&A** - Traditional question and answer cards
  - **Multiple Choice** - Exam-prep cards with A/B/C/D options and explanations for each choice
- Two export formats:
  - **Anki** - CSV with MathJax math notation (`\(...\)` and `\[...\]`)
  - **Brainscape** - CSV with plain text math conversion
- Optional context input for focusing card generation
- CSV validation and proper escaping
- Files saved to `AI-Organiser/Flashcards/` subfolder

### 2. Mermaid Diagram Generation
- Generate visual diagrams from note content
- Supports multiple diagram types: flowchart, sequence, class, mindmap, timeline, ER, state
- Persona selection for diagram complexity/style
- Inserts Mermaid code blocks directly into notes

### 3. Text Highlighting
- Quick highlight selected text with HTML mark tags
- Multiple highlight color types

### 4. Unified Folder Structure
- All plugin-generated files consolidated under `AI-Organiser/`
- Subfolders: `Config/`, `Transcripts/`, `Flashcards/`
- Single configurable base folder in settings
- Auto-exclusion of plugin folder from tagging operations

### 5. Transcript Saving Feature
- Save full transcripts from audio/YouTube to separate files
- Configurable transcript folder (default: `AI-Organiser/Transcripts/`)
- Transcript files include metadata (source, date, duration, type)
- Summary notes link to transcript files via callout

### 6. Test Infrastructure
- Added Vitest for unit testing
- 95 tests for pure utility functions
- GitHub Actions CI for automated testing
- Tests for tagUtils, urlValidator, and summaryPrompts

### 7. User Testing Guide
- Created comprehensive `usertest.md` with 254 test cases
- Covers all features, settings, and edge cases
- Organized into 15 categories

### 8. Settings UX Improvements (January 2026)
- **Language consolidation**: All language settings (interface, tag output, summary) now in one Interface section
- **Restart notice fix**: Interface language change notice only shows when language actually changes
- **Embedding model dropdowns**: Provider-specific model lists with recommended defaults (not free text)
- **API key inheritance**: "Use main API key" button when embedding provider matches LLM provider
- **Excluded folders toggle**: Clear toggle for shared vs custom indexing exclusions
- **Settings reordering**: Logical flow from core setup → language → features → advanced

### 9. Phase 4.4: RAG Enhancements (January 21, 2026)

#### Related Notes Sidebar View (4.4.1)
- **Persistent sidebar panel** showing semantically similar notes
- Auto-updates when switching notes (500ms debounce)
- Interactive features:
  - Click to open note
  - Hover for preview tooltip
  - Copy markdown link button
  - Manual refresh and cache clearing
- Color-coded similarity scores (Excellent/Good/Fair)
- Graceful error handling (disabled, loading, empty, error states)
- **Implementation**: `src/ui/views/RelatedNotesView.ts` (458 lines)
- **Styling**: `styles.css` (~100 lines of related-notes-* classes)
- **Command**: "Show Related Notes" in right sidebar

#### RAG-Enhanced Summarization (4.4.2)
- Enhanced `summarizeTextWithLLM()` with optional RAG context injection
- **useRAG parameter**: Enables context retrieval from vault
- **Context retrieval**: Gets 3 most relevant chunks (similarity ≥ 0.7)
- **Enhanced prompts**: Builds RAG-aware prompts with background knowledge
- **Source citations**: Automatically appends source notes to summary
- Graceful fallback if RAG fails
- Backward compatible (useRAG defaults to false)
- **Implementation**: `src/commands/summarizeCommands.ts` (+53 lines)

#### Semantic Search Settings UI
- **Complete settings section** for semantic search and RAG
- Master toggle: "Enable Semantic Search"
- **Embedding provider configuration**:
  - Supports: OpenAI, Claude (Voyage), Gemini, Ollama, OpenRouter, Cohere, Voyage AI
  - Auto-updates model on provider change
  - Auto-fills API key from main LLM key if blank
  - API key masking: Shows only first 6 characters (e.g., `sk-abc•••••••`)
- **Indexing settings**:
  - Auto-index new notes toggle
  - Excluded folders (inherits from main exclusions if empty)
  - Chunk size (default: 2000 chars)
  - Chunk overlap (default: 200 chars)
  - Max chunks per note (default: 10)
- **RAG settings**:
  - Enable vault chat toggle
  - Context chunks count (default: 5)
  - Include metadata toggle
- Full i18n support (English & Chinese)

#### UX Polish
- Support section moved to end with smaller heading
- Added `fundingUrl` to manifest.json for ❤️ heart icon in community plugins
- Settings order: LLM → Tagging → Config → Interface → Semantic Search → Summarization → Support
- Embedding model updates automatically when provider changes
- API keys properly masked for security

### 10. Embedding Service Infrastructure (January 21, 2026)

Complete embedding service layer for semantic search vector generation:

#### Embedding Services (`src/services/embeddings/`)
- **IEmbeddingService interface** with `generateEmbedding()`, `batchGenerateEmbeddings()`
- **5 Embedding Providers**:
  - **OpenAI** - text-embedding-3-small/large (1536/3072 dims)
  - **Ollama** - nomic-embed-text, mxbai-embed-large (local)
  - **Gemini** - text-embedding-004 (768 dims)
  - **Cohere** - embed-english-v3.0 (1024 dims)
  - **Voyage AI** - voyage-3/voyage-3-lite (high quality)
- **Factory pattern**: `createEmbeddingServiceFromSettings()` handles API key inheritance
- **API key chain**: embeddingApiKey → providerSettings → cloudApiKey

#### Performance Optimizations (Phase 4.4.3)
- **Search caching**: 5-minute TTL cache for search results
- **Cache invalidation**: Automatic on file modify/delete/rename
- **Batch processing**: Process embedding requests efficiently

#### Local Setup Wizard (`LocalSetupWizardModal.ts`)
- **3-step wizard** for setting up local AI (Ollama)
- **Step 1**: Install Ollama with platform-specific instructions
- **Step 2**: Download models with hardware-aware recommendations
- **Step 3**: Test connection and apply settings
- **Model recommendations** for 2026:
  - **Chat**: Llama 3.3, Qwen 2.5, DeepSeek R1, Mistral, Phi-4, Gemma 2
  - **Embeddings**: nomic-embed-text, mxbai-embed-large, bge-m3
  - **Multimodal**: Llava 1.6 for image/PDF analysis
- **RAM detection**: Recommends models based on available memory
- **Copy-to-clipboard**: Install commands ready to paste in terminal

**Note**: Claude/Anthropic does NOT have an embeddings API - use Voyage AI instead.

---

## Known Limitations

1. **Interface Language Change** - Requires Obsidian restart (output languages do not)
2. **PDF Support** - Only Claude and Gemini support native PDF
3. **Audio Transcription** - Requires OpenAI or Groq API key
4. **D3.js** - Loaded from CDN, not bundled
5. **Large Vaults** - Batch operations may take time
6. **Embedding API** - Some providers (Claude) don't have native embeddings, use Voyage AI instead

---

## Repository

- **GitHub:** [Lbstrydom/ai-organiser](https://github.com/Lbstrydom/ai-organiser)
- **Author:** L Strydom
