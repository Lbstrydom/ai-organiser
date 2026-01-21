# AI Organiser: Intelligent Note Organization for Obsidian

[![English](https://img.shields.io/badge/lang-English-blue.svg)](README.md) [![中文](https://img.shields.io/badge/lang-中文-red.svg)](README_CN.md)

![AI Organiser](https://img.shields.io/badge/Obsidian-AI%20Organiser-purple)
![Obsidian Compatibility](https://img.shields.io/badge/Obsidian-v1.4.0+-blue)

> A comprehensive AI-powered plugin for Obsidian that helps you organize, tag, summarize, and enhance your notes. Supports 13+ cloud providers and 5+ local LLM options.

## Features

### Intelligent Tagging
- **Taxonomy-based tagging** with customizable themes and disciplines
- **3-tier hierarchical tags** (e.g., `science/biology/genetics`)
- **Multiple tagging modes**: Generate new, match existing, hybrid, or custom
- **Batch operations** for folders or entire vault
- **Tag network visualization** with D3.js interactive graph

### Content Summarization
- **Summarize from URLs** - Web articles with link preservation
- **Summarize from PDFs** - Native multimodal support (Claude/Gemini)
- **Summarize from YouTube** - Via captions extraction
- **Summarize from Audio** - Transcription + summarization (MP3, WAV, M4A, OGG)
- **5 built-in personas** - Student, Executive, Casual, Researcher, Technical
- **Transcript saving** - Full transcripts saved with metadata

### Flashcard Export
- **Two card styles**:
  - Standard Q&A - Traditional question and answer format
  - Multiple Choice - Exam-style with A/B/C/D options and explanations
- **Two export formats**:
  - Anki - CSV with MathJax notation
  - Brainscape - CSV with plain text math
- **Optional context** for focused card generation

### Smart Note Features
- **Improve note with AI** - Context-aware enhancement with persona selection
- **Find related resources** - YouTube and web search integration
- **Generate Mermaid diagrams** - Flowchart, sequence, class, mindmap, timeline, ER, state
- **Text highlighting** - Multiple color options

### Translation
- Translate entire notes or selections
- Preserves markdown formatting
- Supports all major languages

### Utilities
- **Command Picker** - Unified modal for all 27+ commands
- **Tag Network** - Interactive visualization of tag relationships
- **Collect Tags** - Export all vault tags to a file

## Installation

### From Obsidian Community Plugins (Recommended)
1. Open Obsidian Settings
2. Navigate to Community Plugins
3. Search for "AI Organiser"
4. Click Install, then Enable

### Manual Installation
1. Download the latest release from [GitHub](https://github.com/Lbstrydom/ai-organiser)
2. Extract to `.obsidian/plugins/ai-organiser/`
3. Reload Obsidian and enable the plugin

## Quick Start

1. **Configure your AI provider**:
   - Settings → AI Organiser → LLM Settings
   - Choose Local (Ollama, LM Studio) or Cloud (OpenAI, Claude, Gemini, etc.)
   - Enter endpoint URL and API key

2. **Access commands**:
   - Click the sparkles icon in the ribbon
   - Or use Command Palette (Ctrl/Cmd+P)

3. **Start organizing**:
   - Generate tags for notes
   - Summarize web content
   - Create flashcards
   - Improve notes with AI

## Supported LLM Providers

### Cloud Services (13 adapters)
| Provider | Tagging | Summarization | PDF | Audio |
|----------|---------|---------------|-----|-------|
| Claude | Yes | Yes | Yes (native) | via OpenAI |
| OpenAI | Yes | Yes | No | Yes (Whisper) |
| Gemini | Yes | Yes | Yes (native) | via OpenAI |
| Groq | Yes | Yes | No | Yes (Whisper) |
| DeepSeek | Yes | Yes | No | - |
| OpenRouter | Yes | Yes | varies | - |
| AWS Bedrock | Yes | Yes | varies | - |
| Vertex AI | Yes | Yes | Yes | - |
| Mistral | Yes | Yes | No | - |
| Cohere | Yes | Yes | No | - |
| Grok | Yes | Yes | No | - |
| Aliyun | Yes | Yes | No | - |
| OpenAI Compatible | Yes | Yes | No | - |

### Local Providers
- Ollama
- LM Studio
- LocalAI
- Jan
- KoboldCpp

## Configuration

All plugin files are stored in a configurable folder (default: `AI-Organiser/`):

```
AI-Organiser/
├── Config/                    # User-editable configuration
│   ├── taxonomy.md            # Themes and disciplines for tagging
│   ├── excluded-tags.md       # Tags to never suggest
│   ├── personas.md            # AI writing personas
│   └── summary-personas.md    # Summary style personas
├── Transcripts/               # Audio/YouTube transcripts
└── Flashcards/                # Exported flashcard files
```

### Key Settings

- **LLM Settings** - Provider, API keys, models
- **Tagging Settings** - Max tags, language, taxonomy
- **Summarization** - Length, language, transcript saving
- **Interface** - Language (English/Chinese)

## Language Support

### Interface
- English
- Simplified Chinese (中文)

### Content Generation
Tags and summaries can be generated in any language supported by your LLM.

## Commands

| Category | Commands |
|----------|----------|
| Tagging | Generate tags (note/folder/vault), Clear tags, Assign predefined tags |
| Summarize | From URL, PDF, YouTube, Audio |
| Smart Notes | Improve note, Find resources, Generate diagram |
| Flashcards | Export flashcards |
| Translate | Translate note, Translate selection |
| Utilities | Command picker, Tag network, Collect tags |

## Development

```bash
# Install dependencies
npm install

# Development build (watch mode)
npm run dev

# Production build
npm run build

# Run tests
npm test
```

## License

MIT License - see [LICENSE](LICENSE) file

## Contributing

Contributions are welcome! Please submit issues and pull requests on [GitHub](https://github.com/Lbstrydom/ai-organiser).

## Support

- [GitHub Issues](https://github.com/Lbstrydom/ai-organiser/issues)
- [Buy Me a Coffee](https://buymeacoffee.com/lbstrydom)

## Acknowledgments

Thanks to all contributors and the Obsidian community!
