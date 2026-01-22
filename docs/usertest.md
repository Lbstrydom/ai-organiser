# AI Organiser - Test Checklist

**Version:** 1.0.15
**Features:** Core AI, Semantic Search, Bases Integration, NotebookLM Export

---

## Pre-Test Setup

- [x] `npm run build` passes
- [ ] Files deployed to Obsidian plugins folder
- [ ] Obsidian restarted, plugin enabled

---

## 1. Settings UI (/4)

| Test | Steps | Pass |
|------|-------|------|
| Sections order | Open Settings | AI Provider → Language → Tagging → Summarization → Semantic Search → Bases → NotebookLM → Mobile → Configuration | [x] |
| No duplicate UI | Toggle semantic search 5× | No duplicate blocks | [ ] |
| Clean redraw | Change embedding provider 3× | Settings refresh cleanly | [ ] |
| API key masking | Enter API key | Shows `sk-abc•••••••` format | [ ] |

---

## 2. Core AI Features (/12)

### Tagging

| Test | Pass |
|------|------|
| Tag this note (Ctrl+P) | [ ] |
| Tags appear in frontmatter | [ ] |
| Predefined tags mode | [ ] |

### Summarization

| Test | Pass |
|------|------|
| Summarize URL → metadata added | [ ] |
| Summarize PDF (Claude/Gemini) | [ ] |
| Summarize YouTube | [ ] |
| Summarize audio file | [ ] |
| 5 personas available | [ ] |

### Other AI

| Test | Pass |
|------|------|
| Translate note | [ ] |
| Improve with AI | [ ] |
| Create diagram (Mermaid) | [ ] |
| Ask about note | [ ] |

---

## 3. Semantic Search (/8)

| Test | Steps | Pass |
|------|-------|------|
| Enable toggle | Settings → Semantic Search → Enable | [ ] |
| Embedding provider | Select OpenAI/Ollama/Gemini | [ ] |
| Index builds | Check console for indexing activity | [ ] |
| Search command | Ctrl+P → "Semantic search" | [ ] |
| Related Notes panel | Open sidebar, switch notes | [ ] |
| "Related" badge | Check panel shows "Related" not "90%" | [ ] |
| Disable cleanup | Disable semantic search | Console shows no indexing | [ ] |
| Re-enable works | Enable again | Indexing resumes | [ ] |

---

## 4. Obsidian Bases Integration (/16)

### Settings

| Test | Pass |
|------|------|
| Section visible between Semantic Search and NotebookLM | [x] |
| Enable structured metadata toggle (default ON) | [ ] |
| Include model toggle (default ON) | [ ] |
| Auto-detect content type toggle (default ON) | [ ] |
| Migrate button visible | [ ] |
| Dashboard info text visible (no button) | [ ] |

### Structured Metadata

After summarizing a URL with Bases enabled:

| Property | Check | Pass |
|----------|-------|------|
| `aio_summary` | Max 280 chars | [ ] |
| `aio_status` | = "processed" | [ ] |
| `aio_type` | = note/research/meeting/project/reference | [ ] |
| `aio_processed` | ISO timestamp | [ ] |
| `aio_model` | Model name (if enabled) | [ ] |
| `aio_source` | = url/pdf/youtube/audio | [ ] |
| `aio_source_url` | Original URL | [ ] |
| `aio_persona` | Summary persona used | [ ] |

### Migration

| Test | Steps | Pass |
|------|-------|------|
| Open modal | Settings → Bases → Migrate | [ ] |
| Analysis stage | Shows note counts | [ ] |
| Options stage | Click Next, see toggles | [ ] |
| Progress stage | Start migration, see progress | [ ] |
| Results stage | See processed/skipped/errors | [ ] |

### Dashboard Creation

| Test | Steps | Pass |
|------|-------|------|
| Folder context menu | Right-click folder → "Create Bases Dashboard Here" | [ ] |
| Command palette | Ctrl+P → "Create Bases dashboard" | [ ] |
| Confirmation modal | Shows target folder, Create button | [ ] |
| Creates .base file | File created in target folder | [ ] |
| Folder filter works | Dashboard only shows notes in that folder + subfolders | [ ] |

---

## 5. NotebookLM Export (/16)

### Settings

| Setting | Default | Pass |
|---------|---------|------|
| Selection tag | notebooklm | [ ] |
| Export folder | NotebookLM | [ ] |
| Export mode | auto | [ ] |
| Words per module | 120,000 | [ ] |
| Remove frontmatter | ON | [ ] |
| Flatten callouts | ON | [ ] |
| Strip Dataview | ON | [ ] |
| Image handling | strip | [ ] |
| Resolve embeds | none | [ ] |
| Post-export action | keep | [ ] |

### Commands

| Test | Steps | Pass |
|------|-------|------|
| Toggle selection | Ctrl+P → "NotebookLM: Toggle Selection" on 3 notes | [ ] |
| Tag added | Notes have `notebooklm` tag | [ ] |
| Export command | Ctrl+P → "NotebookLM: Export Source Pack" | [ ] |
| Preview modal | Shows note count, word count, warnings | [ ] |
| Export completes | Creates pack folder | [ ] |
| Clear selection | Ctrl+P → "NotebookLM: Clear Selection" | [ ] |

### Export Validation

Check output in `AI-Organiser/NotebookLM/Pack_*/`:

| File | Check | Pass |
|------|-------|------|
| `index.md` | Upload instructions, TOC | [ ] |
| `module_01.md` | Sanitized content, stable anchors | [ ] |
| `manifest.json` | Note entries, stats | [ ] |
| `changelog.md` | Changes from previous export | [ ] |

### Sanitization

In `module_01.md`:

| Check | Pass |
|-------|------|
| No YAML frontmatter | [ ] |
| No dataview blocks | [ ] |
| Callouts flattened | [ ] |
| Images removed/placeholder | [ ] |
| Links converted to plain text | [ ] |
| Stable anchors: `## Note: Title (id: abc123)` | [ ] |

---

## 6. Mobile Compatibility (/4)

| Test | Pass |
|------|------|
| Mobile provider fallback setting | [ ] |
| Vector store size guard | [ ] |
| Tag network shows list on mobile | [ ] |
| Related notes uses modal on mobile | [ ] |

---

## 7. LLM Providers (/6)

Test with at least one provider:

| Provider | Connection | Tag | Summarize | Pass |
|----------|------------|-----|-----------|------|
| OpenAI | [ ] | [ ] | [ ] | [ ] |
| Claude | [ ] | [ ] | [ ] | [ ] |
| Gemini | [ ] | [ ] | [ ] | [ ] |
| Ollama (local) | [ ] | [ ] | [ ] | [ ] |

---

## 8. Utility Features (/4)

| Test | Pass |
|------|------|
| Tag network visualization | [ ] |
| Export flashcards (Anki) | [ ] |
| Collect vault tags | [ ] |
| Insert related notes | [ ] |

---

## Summary

| Category | Passed | Total |
|----------|--------|-------|
| Settings UI | 1 | 4 |
| Core AI | | 12 |
| Semantic Search | | 8 |
| Bases Integration | 1 | 16 |
| NotebookLM Export | | 16 |
| Mobile | | 4 |
| LLM Providers | | 6 |
| Utilities | | 4 |
| **TOTAL** | 2 | **70** |

---

## Issues Found

### Critical

| Issue | Description | Fixed |
|-------|-------------|-------|
| | | [ ] |

### Minor

| Issue | Description | Fixed |
|-------|-------------|-------|
| Bases dashboard button | Was in Settings, should be folder context menu | [x] |

---

## Environment

| Property | Value |
|----------|-------|
| Obsidian Version | |
| OS | |
| Plugin Version | 1.0.15 |
| Test Date | |
| Tester | |
