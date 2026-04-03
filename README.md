# AI Organiser: Intelligent Note Organization for Obsidian

[![English](https://img.shields.io/badge/lang-English-blue.svg)](README.md) [![中文](https://img.shields.io/badge/lang-中文-red.svg)](README_CN.md)

![AI Organiser](https://img.shields.io/badge/Obsidian-AI%20Organiser-purple)
![Obsidian Compatibility](https://img.shields.io/badge/Obsidian-v1.4.0+-blue)
![License](https://img.shields.io/badge/License-MIT-green)

> A comprehensive AI-powered plugin for Obsidian with 37+ commands across tagging, summarization, research, meeting minutes, presentations, semantic search, and more. Supports 14 cloud providers and 5+ local LLM options.

## Installation

### From Community Plugins (Recommended)

1. Open Obsidian Settings > Community Plugins > Browse
2. Search for **AI Organiser**
3. Click Install, then Enable

### Manual Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/Lbstrydom/ai-organiser/releases)
2. Create folder `<vault>/.obsidian/plugins/ai-organiser/`
3. Copy the three files into the folder
4. Reload Obsidian and enable the plugin in Settings > Community Plugins

## Quick Start

1. Open Settings > AI Organiser > **AI Provider**
2. Select a provider (Claude, OpenAI, Gemini, Groq, DeepSeek, etc.)
3. Enter your API key
4. Open the **Command Picker** (configurable hotkey) to browse all commands

## Features

### AI Chat

Full-featured chat with 6 modes:

| Mode | Purpose |
|------|---------|
| **Note** | Ask questions about the active note |
| **Vault** | RAG-powered search across your knowledge base |
| **Highlight** | Discuss selected text or highlights |
| **Research** | Web research with source quality scoring |
| **Free Chat** | Open conversation with file attachments and projects |
| **Slides** | Build themed HTML presentations with PPTX export |

Features: conversation persistence, project memory, global memory, smart document indexing (ONNX RAG), model switching, and resume from previous conversations.

### Presentation Builder (Slides Mode)

- Describe your presentation in natural language
- LLM generates rich HTML slides with themed CSS
- Preview in sandboxed iframe with slide navigation
- Chat to refine individual slides or the whole deck
- Export to editable PPTX (via dom-to-pptx) or self-contained HTML
- Optional brand guidelines integration with Haiku audit
- Version history with undo/redo

### Intelligent Tagging

- **Taxonomy-based tagging** with customizable themes and disciplines
- **3-tier hierarchical tags** (e.g., `science/biology/genetics`)
- **Multiple modes**: generate new, match existing, hybrid, or custom
- **Batch operations** for folders or entire vault
- **Tag network visualization** with D3.js interactive graph
- **Taxonomy guardrail** validates tags against your taxonomy

### Content Summarization

- **URLs** - Web articles with link preservation
- **PDFs** - Native multimodal support (Claude/Gemini) or text extraction
- **YouTube** - Via captions extraction
- **Audio** - Transcription + summarization (MP3, WAV, M4A, OGG, WebM)
- **Multi-source** - Summarize multiple sources into one note
- **5 built-in personas** - Student, Executive, Casual, Researcher, Technical
- **Custom personas** via config file
- **Reviewed Edits** - Inline diff preview before any write

### Web Research Assistant

- Multi-provider search (Claude Web Search, Tavily, Bright Data)
- Smart escalation: free fetch > Web Unlocker > Scraping Browser
- Source quality scoring (5 weighted signals)
- Academic mode with DOI extraction and citation formatting
- Multi-perspective query decomposition
- Usage guardrails with monthly budget tracking
- Zotero integration for citation management
- Vault pre-check (search vault before web)
- Streaming synthesis with citations

### Meeting Minutes

- Generate structured minutes from audio transcripts
- GTD overlay: classify actions by context (@office, @call, etc.)
- 2 built-in personas (Standard, Governance) + custom personas
- Terminology dictionaries for transcription accuracy
- Context document support (agendas, presentations)
- Chunked processing for long meetings (5000-token chunks)
- Word document (DOCX) export
- Obsidian Tasks format support

### Audio Recording & Transcription

- In-plugin audio recording (desktop + mobile)
- Whisper-compatible transcription
- Post-transcription cleanup (keep/compress/delete)
- Direct integration with minutes and summarization

### Smart Digitisation

- Extract text from handwritten notes, whiteboards, diagrams
- 5 modes: auto, handwriting, diagram, whiteboard, mixed
- Built-in sketch pad with pressure-sensitive drawing
- Image compression with backlink-safe vault replacement

### Kindle Sync

- Import from My Clippings.txt or Amazon cloud
- Differential sync (only new highlights)
- 4 highlight styles: blockquote, callout, bullet, plain
- Color grouping and cover images
- AI auto-tagging after import

### Newsletter Digest

- Fetch unread Gmail newsletters via Google Apps Script
- AI triage summaries per newsletter
- Rolling daily digest notes
- Key links extraction (spam-filtered)
- Auto-fetch scheduler

### Semantic Search & RAG

- 7 embedding providers (OpenAI, Gemini, Ollama, Cohere, Voyage AI, OpenRouter, local ONNX)
- Vector store with chunk-based indexing
- Related notes sidebar (auto-updates on note switch)
- RAG-enhanced AI responses
- Multi-select export from search results
- Zero-setup ONNX fallback (no API key needed)

### Canvas Toolkit

- **Investigation Board** - RAG-based related note visualization
- **Context Board** - Embedded content mapping (YouTube, PDF, web, audio)
- **Cluster Board** - Tag-based note grouping with LLM clustering

### Mermaid Chat

- Conversational diagram editing with live preview
- Version history and line-level diff view
- Template library (built-in + custom)
- Multi-format export (SVG, PNG, .mermaid, canvas)
- Staleness detection (warns when note content changes after diagram creation)
- Type conversion between 12 diagram types

### Document Export

- Export to PDF, Word (DOCX), or PowerPoint (PPTX)
- 5 color scheme presets + custom colors
- Configurable font family and size
- Flashcard export (Anki, Brainscape)
- Meeting minutes DOCX with structured sections

### Vault Tools

- **Quick Peek** - Fast 1-paragraph triage of embedded sources
- **Web Reader** - Batch URL triage and note creation
- **Find Embeds** - Vault hygiene scan for assets and orphans
- **Pending Integration** - Auto-resolve embedded content before integration
- **Obsidian Bases** - Structured metadata and dashboard generation

### Translation

- Translate notes, selections, or external sources
- 20+ target languages
- Smart dispatch: selection > multi-source > note
- Multi-source translation (URLs, YouTube, PDFs, documents, audio)

## Supported Providers

### Cloud LLM Providers

| Provider | Models |
|----------|--------|
| **Anthropic (Claude)** | Claude 4.6, Sonnet 4.6, Haiku 4.5 |
| **OpenAI** | GPT-5.4, GPT-4o, o3, o4-mini |
| **Google (Gemini)** | Gemini 2.5 Pro/Flash |
| **DeepSeek** | DeepSeek R1, V3 |
| **Groq** | Llama, Mixtral (fast inference) |
| **Mistral** | Mistral Large, Codestral |
| **Cohere** | Command R+ |
| **Grok** | Grok-2 |
| **OpenRouter** | 200+ models |
| **Requesty** | Multi-provider routing |
| **Amazon Bedrock** | Claude, Llama, Titan |
| **Google Vertex AI** | Gemini models |
| **Alibaba (Aliyun)** | Qwen models |
| **SiliconFlow** | Open-source models |

### Local LLM Options

- **Ollama** - Run models locally
- **LM Studio** - GUI-based local inference
- **LocalAI** - OpenAI-compatible local server
- **Jan** - Desktop LLM app
- **KoboldCpp** - GGUF model runner

### Embedding Providers

OpenAI, Gemini, Ollama, Cohere, Voyage AI, OpenRouter, Local ONNX (zero-setup)

## Mobile Support

Works on iOS and Android with:
- Cloud-only provider mode
- RAM-aware indexing limits
- Touch-optimized modals
- Automatic audio codec negotiation

## Internationalization

Full interface and output language support for **English** and **Simplified Chinese**. Output language configurable independently from interface language.

## Configuration

All settings are organized into collapsible sections:

- **AI Provider** - Main LLM setup
- **Specialist Providers** - Dedicated providers for YouTube, PDF, Audio, Flashcards
- **Tagging** - Tag generation and taxonomy
- **Summarization** - Personas, styles, transcript options
- **Capture & Input** - Audio, digitisation, sketch pad
- **Meeting Minutes** - Output, timezone, personas, GTD
- **Vault Intelligence** - Semantic search, canvas, RAG
- **Integrations** - Bases, NotebookLM, document export
- **Preferences** - Language, interface, mobile
- **Advanced** - Configuration files

## Contributing

1. Clone the repo: `git clone https://github.com/Lbstrydom/ai-organiser.git`
2. Install dependencies: `npm install`
3. Development build: `npm run dev`
4. Production build: `npm run build`
5. Run tests: `npm test`

See `AGENTS.md` for detailed architecture documentation.

## License

MIT License - see [LICENSE](LICENSE) for details.

Originally based on work by [Nie Hu](https://github.com/niehu2018). Current development and maintenance by [L Strydom](https://github.com/Lbstrydom).

## Support

If you find this plugin useful:

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-support-yellow)](https://buymeacoffee.com/lbstrydom)
