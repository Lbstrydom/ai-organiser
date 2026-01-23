# AI Organiser - Development Status

**Version:** 1.0.15
**Last Updated:** January 23, 2026
**Status:** Feature Complete

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
│   └── summary-personas.md   # Summarization personas
├── Transcripts/              # Audio/YouTube transcripts
└── Flashcards/               # Exported flashcards
```

---

## Recent Updates (January 2026)

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
npm run dev      # Development (watch mode)
npm run build    # Production build
npm test         # Run 95 unit tests
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
