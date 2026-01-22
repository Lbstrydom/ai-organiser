# AI Organiser - Development Status

**Version:** 1.0.15
**Last Updated:** January 22, 2026
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
│   ├── settings/              # 6 settings sections
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
| **Summarization** | URL, PDF, YouTube, Audio | 5 personas, RAG-enhanced |
| **Smart Notes** | Improve, Find resources, Diagrams | AI personas, Mermaid support |
| **Translation** | Note, Selection | 20+ languages |
| **Semantic Search** | Search, Index, Related notes | Voy WASM, 5 embedding providers |
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
5. **Semantic Search** - Embeddings, indexing, RAG options
6. **Configuration** - Config folder, taxonomy files

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

### Language & UX Audit
- Rewrote all UI text for clarity and brevity
- Applied American English consistently
- Removed support section from settings
- Updated command names for conciseness

### Command Consolidation Proposal
- Analyzed 27 commands using MECE principles
- Proposed consolidation to 17 commands (37% reduction)
- See [command-consolidation-proposal.md](command-consolidation-proposal.md)

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
3. Audio transcription requires OpenAI or Groq API
4. Claude/Anthropic has no embeddings API (use Voyage AI)

---

## Repository

- **GitHub:** [Lbstrydom/ai-organiser](https://github.com/Lbstrydom/ai-organiser)
- **Author:** L Strydom
