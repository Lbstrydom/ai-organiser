# AI Organiser for Obsidian

[![English](https://img.shields.io/badge/lang-English-blue.svg)](README.md) [![中文](https://img.shields.io/badge/lang-��文-red.svg)](README_CN.md)

**Your notes deserve more than storage.** AI Organiser turns Obsidian into a thinking partner — summarize anything, research the web, build presentations, record meetings, sync Kindle highlights, and let AI tag and connect your knowledge. One plugin, 14 providers, works locally or in the cloud.

<!-- TODO: Add hero GIF/screenshot showing command picker or chat -->

---

## What does it actually do?

**Drop in a URL** and get a structured summary with tags — or paste five URLs and get a single synthesized note. **Record a meeting** and walk away with structured minutes, action items in GTD format, and a Word document ready to send. **Ask "what do I know about X?"** and get answers grounded in your own vault, with citations. **Say "make me a deck about Q3 results"** and watch slides appear in a live preview, then export to PowerPoint.

Everything works from a single **Command Picker** — press one hotkey, browse by category, search by keyword. No menus to memorize.

---

## Highlights

### AI Chat — 6 modes, one modal

Chat about your active note, search your vault with semantic RAG, research the web with source scoring and citations, build slide decks in conversation, or just talk. Conversations persist across sessions, support file attachments, and remember context through projects and global memory.

### Summarize anything

URLs, PDFs, YouTube videos, audio recordings, Office documents — individually or in bulk. Choose from 5 built-in personas (Student, Executive, Technical, Researcher, Casual) or write your own. Every write shows an inline diff preview so you approve changes before they land.

### Web Research

Ask a question and the plugin decomposes it into sub-queries, searches multiple providers, scores source quality, extracts findings, and synthesizes an answer with numbered citations. Academic mode adds DOI extraction and author-year formatting. Budget guardrails stop you from accidentally burning through your API credits.

### Presentation Builder

Describe what you want in plain language. The LLM generates themed HTML slides with speaker notes, previewed live in a sandboxed iframe. Chat to refine, then export to editable PPTX or self-contained HTML. Optional brand guidelines keep everything on-brand.

### Meeting Minutes

Record audio in-plugin or paste a transcript. Get structured minutes with agenda items, decisions, and action items — optionally classified by GTD context (`@office`, `@call`, `@errand`). Terminology dictionaries keep names and acronyms consistent. Export to Word with one click.

### Newsletter Digest

Connect your Gmail via a simple Apps Script. The plugin fetches unread newsletters, triages each one with AI, writes individual notes with key links, and synthesizes a thematic daily brief that groups stories across sources. Optional audio podcast generation reads you the brief.

### Intelligent Tagging

Auto-tag notes using your own taxonomy with 3-tier hierarchical tags. Match existing tags, generate new ones, or use a hybrid. Batch-tag entire folders. Visualize your tag network as an interactive D3.js graph.

### Semantic Search & RAG

7 embedding providers including a zero-setup local option (no API key needed). Find related notes in a persistent sidebar. Export search results as new notes. Every AI response can be grounded in your vault context.

---

## More features

<details>
<summary><strong>Smart Digitisation</strong> — extract text from photos of handwritten notes, whiteboards, and diagrams</summary>

- 5 modes: auto, handwriting, diagram, whiteboard, mixed
- Built-in sketch pad with pressure-sensitive drawing (perfect-freehand)
- Image compression with backlink-safe vault replacement
</details>

<details>
<summary><strong>Kindle Sync</strong> — import highlights from My Clippings.txt or Amazon cloud</summary>

- Differential sync (only new highlights)
- 4 highlight styles: blockquote, callout, bullet, plain
- Color grouping and cover images
- AI auto-tagging after import
</details>

<details>
<summary><strong>Mermaid Chat</strong> — conversational diagram editing with live preview</summary>

- Version history and line-level diff view
- Template library (built-in + custom)
- Multi-format export (SVG, PNG, .mermaid, canvas)
- Staleness detection when note content changes
- Convert between 12 diagram types
</details>

<details>
<summary><strong>Canvas Toolkit</strong> — 3 board types for visual thinking</summary>

- **Investigation Board** — RAG-based related note visualization
- **Context Board** — map embedded content (YouTube, PDF, web, audio)
- **Cluster Board** — tag-based grouping with LLM clustering
</details>

<details>
<summary><strong>Document Export</strong> — PDF, Word, PowerPoint, flashcards</summary>

- 5 color scheme presets + custom colors
- Configurable font family and size
- Flashcard export for Anki and Brainscape
</details>

<details>
<summary><strong>Translation</strong> — notes, selections, or multi-source</summary>

- 20+ target languages
- Smart dispatch: selection > multi-source > full note
- Translate URLs, YouTube, PDFs, documents, and audio
</details>

<details>
<summary><strong>Vault Tools</strong> — Quick Peek, Web Reader, Find Embeds, Bases integration</summary>

- **Quick Peek** — fast 1-paragraph triage of any embedded source
- **Web Reader** — batch URL triage and note creation
- **Find Embeds** — vault hygiene scan for orphaned assets
- **Pending Integration** — auto-resolve embedded content
- **Obsidian Bases** — structured metadata and dashboard generation
</details>

---

## Supported Providers

Works with **14 cloud providers** and **5+ local options** — pick what fits your budget and privacy needs.

<details>
<summary>Full provider list</summary>

| Provider | Example Models |
|----------|---------------|
| **Anthropic** | Claude Opus 4.6, Sonnet 4.6, Haiku 4.5 |
| **OpenAI** | GPT-5.4, GPT-4o, o3, o4-mini |
| **Google Gemini** | Gemini 2.5 Pro, 2.5 Flash |
| **DeepSeek** | R1, V3 |
| **Groq** | Llama, Mixtral (fast inference) |
| **Mistral** | Large, Codestral |
| **Cohere** | Command R+ |
| **Grok** | Grok-2 |
| **OpenRouter** | 200+ models |
| **Requesty** | Multi-provider routing |
| **Amazon Bedrock** | Claude, Llama, Titan |
| **Google Vertex AI** | Gemini models |
| **Alibaba (Aliyun)** | Qwen models |
| **SiliconFlow** | Open-source models |

**Local**: Ollama, LM Studio, LocalAI, Jan, KoboldCpp

**Embeddings**: OpenAI, Gemini, Ollama, Cohere, Voyage AI, OpenRouter, Local ONNX (zero-setup, no API key)

</details>

---

## Mobile

Works on iOS and Android — cloud providers, touch-optimized modals, audio recording with automatic codec negotiation, RAM-aware indexing.

## Languages

Full interface support for **English** and **Simplified Chinese**. Output language configurable independently.

---

## Getting Started

1. **Install** — Community Plugins > Browse > search **AI Organiser** > Install > Enable
2. **Configure** — Settings > AI Organiser > select a provider and enter your API key
3. **Go** — Open the Command Picker (set a hotkey) and explore

<details>
<summary>Manual installation</summary>

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/Lbstrydom/ai-organiser/releases)
2. Create `<vault>/.obsidian/plugins/ai-organiser/`
3. Copy the three files into the folder
4. Reload Obsidian and enable in Settings > Community Plugins
</details>

---

## Contributing

```bash
git clone https://github.com/Lbstrydom/ai-organiser.git
npm install
npm run dev    # watch mode
npm test       # 3700+ unit tests
npm run build  # production
```

See [AGENTS.md](AGENTS.md) for architecture documentation.

## License

MIT — see [LICENSE](LICENSE).

## Support

If you find this plugin useful:

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-support-yellow)](https://buymeacoffee.com/lbstrydom)
