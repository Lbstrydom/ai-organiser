# AI Organiser - Test Checklist

**Version:** 1.0.15
**Features:** Core AI, Semantic Search, Bases Integration, NotebookLM Export

---

## Pre-Test Setup

- [x] `npm run build` passes
- [ ] Files deployed to Obsidian plugins folder
- [ ] Obsidian restarted, plugin enabled

---

## 1. Settings UI (4/4) ✓

| Test | Steps | Pass |
|------|-------|------|
| Sections order | Open Settings | AI Provider → Tagging → Summarization → Vault Context → Integrations (Bases, NotebookLM) → Interface → Mobile → Configuration | [x] |
| No duplicate UI | Toggle semantic search 5× | No duplicate blocks | [x] |
| Clean redraw | Change embedding provider 3× | Settings refresh cleanly | [x] |
| API key masking | Enter API key | Shows `sk-abc•••••••` format | [x] |

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
| Summarize URL → metadata added | [x] |
| Summarize PDF (Claude/Gemini) | [x] |
| Summarize YouTube | [x] |
| Summarize audio file | [x] |
| 5 personas available | [x] |

### Meeting Minutes

| Test | Steps | Pass |
|------|-------|------|
| Open modal | Ctrl+P → "Create Meeting Minutes" | [ ] |
| Persona dropdown | Shows personas from minutes-personas.md | [ ] |
| Privacy warning toggles | Set Output audience = External or enable external version | [ ] |
| Transcript autofill | Open transcript in AI-Organiser/Transcripts, open modal | [ ] |
| Output note created | File saved in Minutes folder | [ ] |
| Frontmatter keys | Includes aio_meeting_date, aio_context, aio_attendees | [ ] |
| External/internal callouts | External (info) + Internal (danger) blocks in same file | [ ] |
| Hidden JSON comment | HTML comment with AIO_MINUTES_JSON at bottom | [ ] |
| Tasks format | Enable Tasks toggle → actions appended as - [ ] | [ ] |
| Chunked transcript | Use long transcript (>6k tokens) → no UI freeze | [ ] |

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

## 4. Obsidian Bases Integration (/15)

### Settings

| Test | Pass |
|------|------|
| Section visible between Semantic Search and NotebookLM | [x] |
| Enable structured metadata toggle (default ON) | [ ] |
| Include model toggle (default ON) | [ ] |
| Auto-detect content type toggle (default ON) | [ ] |
| Migrate button visible | [ ] |

### Structured Metadata

After summarizing a URL with Bases enabled:

| Property | Check | Pass |
|----------|-------|------|
| `summary` | Max 280 chars summary hook | [x] |
| `source_url` | Original URL | [x] |

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

## 5. NotebookLM Export (/8)

### Settings

| Setting | Default | Pass |
|---------|---------|------|
| Section header visible | "NotebookLM Export" | [ ] |
| Selection tag | notebooklm | [ ] |
| Export folder picker | AI-Organiser/NotebookLM | [ ] |
| PDF info box visible | Shows why PDF format | [ ] |

### Commands (Not Yet Implemented)

| Test | Steps | Pass |
|------|-------|------|
| Toggle selection | Ctrl+P → "NotebookLM: Toggle Selection" on 3 notes | [ ] |
| Tag added | Notes have `notebooklm` tag | [ ] |
| Export command | Ctrl+P → "NotebookLM: Export Source Pack" | [ ] |
| Preview modal | Shows note count, size estimate | [ ] |
| Export completes | Creates pack folder with PDFs | [ ] |

### PDF Export Validation

Check output in `AI-Organiser/NotebookLM/Pack_*/`:

| File | Check | Pass |
|------|-------|------|
| `README.md` | Upload instructions, note list | [ ] |
| `*.pdf` files | PDFs preserve images, diagrams | [ ] |
| `manifest.json` | Note entries, stats | [ ] |

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
| Settings UI | 4 | 4 |
| Core AI | 5 | 22 |
| Semantic Search | | 8 |
| Bases Integration | 3 | 9 |
| NotebookLM Export | | 8 |
| Mobile | | 4 |
| LLM Providers | | 6 |
| Utilities | | 4 |
| **TOTAL** | 12 | **65** |

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
