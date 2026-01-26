# AI Organiser - Manual Test Checklist

**Version:** 1.0.15
**Full Test Time:** ~30 minutes
**Quick Smoke Test:** ~10 minutes (sections marked with *)

---

## Pre-Test *

- [x] `npm run build:quick` passes
- [x] Files deployed: `main.js`, `manifest.json`, `styles.css`
- [x] Obsidian restarted, plugin enabled

---

## 1. Settings UI (3 min) *

### Section Order & Visual Hierarchy
- [x] Open Settings → AI Organiser
- [x] Sections visible in order:
  1. **AI Provider** (h1 with icon)
  2. **Tagging** (h1 with icon)
  3. **Summarization** (h1 with icon)
     - YouTube (h2 with youtube icon)
     - Audio Transcription (h2 with mic icon)
  4. **Meeting Minutes** (h1 with icon)
  5. **Semantic Search** (h1 with brain icon)
     - Indexing (h3 subheader)
     - Vault Content (RAG) (h3 subheader)
  6. **Integrations** (h1 with puzzle icon)
     - Bases (h2 text only)
     - NotebookLM Export (h2 text only)
  7. **Language** (h1 with icon)
  8. **Mobile** (h1 with icon)
  9. **Advanced** (h1 with settings icon) - contains Config Folder

### Settings Functionality
- [x] Toggle Semantic Search ON/OFF 3× → no duplicate UI elements
- [x] API key shows masked format: `sk-abc•••••••`
- [x] Provider dropdown changes available models
- [x] "Test Connection" button works

---

## 2. Command Picker / Sparkles Menu (2 min) *

- [x] Ctrl+P → "AI Organiser" or ribbon icon → Command Picker opens
- [x] Fuzzy search works (type "tag" → finds tagging commands)
- [x] Categories visible: Create, Enhance, Organize, Search, Analyze, Integrate
- [x] Each command has icon and category badge
- [x] Keyboard navigation works (↑↓ to navigate, ↵ to select, Esc to close)

---

## 3. Tagging (3 min) *

### Generate Tags
- [x] Open any note → Ctrl+P → "Tag this note" → tags appear in frontmatter
- [x] Tags follow kebab-case format (e.g., `machine-learning`)
- [x] Nested tags preserved (e.g., `science/biology`)

### Clear Tags
- [x] "Clear tags" command removes tags from current note
- [x] Frontmatter preserved (only tags removed)

### Batch Operations (optional)
- [x] "Tag folder" → progress indicator → tags all notes in folder
- [x] "Clear folder tags" → removes tags from folder

---

## 4. Summarization (5 min) *

Pick at least ONE source type:

### URL Summarization
- [x] Create note with URL (e.g., `https://example.com/article`)
- [x] "Summarize" → modal detects URL → summary inserted
- [x] Frontmatter contains `source_url` (when Bases enabled)
- [x] Summary follows selected persona style

### YouTube Summarization
- [ ] Note with YouTube link → "Summarize"
- [ ] Video processed via Gemini (requires Gemini key)
- [ ] Transcript saved (if enabled in settings)

### PDF Summarization
- [ ] Open note with embedded PDF → "Summarize"
- [ ] PDF content extracted and summarized (requires Claude/Gemini)

### Audio Summarization
- [ ] Note with embedded audio file → "Summarize"
- [ ] Audio transcribed via Whisper → summary generated
- [ ] Transcript saved (if enabled)

### Multi-Source Summarization
- [ ] Note with multiple URLs/PDFs → "Summarize"
- [ ] Modal shows detected sources with checkboxes
- [ ] Oversized document handling works (truncate/full/skip)

---

## 5. Translation (2 min)

### Note Translation
- [ ] Open note → "Translate" → language picker
- [ ] Full note translated, formatting preserved

### Selection Translation
- [ ] Select text → "Translate selection"
- [ ] Only selection translated, rest unchanged

---

## 6. Smart Note Features (3 min)

### Enhance Note (Smart Picker)
- [ ] "Enhance note" → shows options: Improve, Diagram, Resources, Flashcards
- [ ] Each option works:
  - [ ] **Improve**: Enhances writing quality
  - [ ] **Diagram**: Inserts Mermaid diagram
  - [ ] **Resources**: Suggests related resources
  - [ ] **Flashcards**: Exports to Anki format

### Generate from Embedded
- [ ] Note with `![[embedded-note]]` → "Generate from embedded"
- [ ] Content generated based on embedded context

---

## 7. Meeting Minutes (4 min)

### Basic Generation
- [ ] Ctrl+P → "Create Meeting Minutes" → modal opens
- [ ] Fill: Title, Date, Participants, Transcript
- [ ] Select persona from dropdown
- [ ] Generate → note created with structured output
- [ ] Check frontmatter: `aio_meeting_date`, `aio_attendees`

### Context Documents
- [ ] Add agenda/presentation via "Add Document" button
- [ ] Oversized documents show truncation controls
- [ ] Documents included in minutes context

### Terminology Dictionary
- [ ] Create new dictionary → add terms
- [ ] Load existing dictionary → terms available
- [ ] Extract terms from documents → populates dictionary
- [ ] Dictionary improves name/term consistency in output

---

## 8. Semantic Search / RAG (5 min)

### Setup
- [ ] Enable Semantic Search in settings
- [ ] Select embedding provider (OpenAI, Gemini, Ollama, etc.)
- [ ] Enter API key if needed (or use main key)
- [ ] "Build Index" → indexing progress shown

### Related Notes Sidebar
- [ ] View → "Related Notes" → sidebar opens
- [ ] Switch between notes → panel updates (500ms debounce)
- [ ] Similarity badges color-coded (green ≥0.8, yellow ≥0.6, gray <0.6)
- [ ] Click related note → navigates to it
- [ ] Hover → preview shown

### Search Commands
- [ ] "Semantic Search" → search modal → finds semantically similar notes
- [ ] "Find Related" → opens Related Notes sidebar
- [ ] "Chat with Vault" → RAG-enhanced Q&A modal
- [ ] "Ask about current note" → Q&A for active note
- [ ] "Insert Related Notes" → inserts links to related notes

### Index Management
- [ ] "Manage Index" → shows options: Build, Update, Clear
- [ ] Update → re-indexes changed files
- [ ] Clear → removes index (requires rebuild)

---

## 9. Integrations (4 min)

### Bases Integration
- [ ] "Upgrade metadata" → MigrationModal opens
- [ ] Analysis shows: total, needs migration, already migrated
- [ ] Run migration → metadata added to notes
- [ ] Check frontmatter: `summary`, `source_url` (minimal set)
- [ ] "Create dashboard" → DashboardCreationModal
- [ ] Dashboard created with folder filtering

### NotebookLM Integration
- [ ] "NotebookLM: Toggle Selection" → adds/removes note from export list
- [ ] "NotebookLM: Export Source Pack" → ExportPreviewModal opens
- [ ] Preview shows selected notes, linked documents, total size
- [ ] Export → creates PDF in export folder
- [ ] "NotebookLM: Clear Selection" → removes all selections
- [ ] "NotebookLM: Open Export Folder" → opens folder in file explorer

### Pending Integration
- [ ] "Add to Pending Integration" → adds selection/content to pending
- [ ] "Integrate pending content" → merges pending into current note
- [ ] "Resolve pending embeds" → extracts text from embedded documents

---

## 10. Highlights (1 min)

- [ ] Select text → "Highlight selection" → text highlighted
- [ ] Select highlighted text → "Remove highlight" → highlight removed
- [ ] Multiple highlight colors available (if configured)

---

## 11. Tag Analysis (2 min)

### Tag Network
- [ ] "Show Tag Network" → visualization opens
- [ ] Nodes represent tags, edges show co-occurrence
- [ ] Search/filter works
- [ ] Hover shows tag details
- [ ] Nodes draggable

### Collect Tags
- [ ] "Collect all tags" → creates file with all vault tags
- [ ] Tags sorted and deduplicated

---

## 12. Configuration Files (2 min)

- [ ] Open `AI-Organiser/Config/` folder in vault
- [ ] Files present (created on first use):
  - [ ] `taxonomy.md` - Tag taxonomy with themes/disciplines
  - [ ] `excluded-tags.md` - Tags to never suggest
  - [ ] `writing-personas.md` - Personas for note improvement
  - [ ] `summary-personas.md` - Personas for summarization
  - [ ] `minutes-personas.md` - Personas for meeting minutes
  - [ ] `bases-templates.md` - Bases dashboard templates
- [ ] Dictionaries folder: `AI-Organiser/Config/dictionaries/`
- [ ] Edit persona file → changes reflected in dropdowns

---

## 13. Provider Quick Test *

Test with your configured provider:

| Check | Pass |
|-------|------|
| Connection test passes | [ ] |
| Tag generation works | [ ] |
| Summarization works | [ ] |
| Translation works | [ ] |

---

## 14. Mobile-Specific (if testing on mobile)

- [ ] Plugin loads without errors
- [ ] Cloud provider works (localhost endpoints fail on mobile)
- [ ] Semantic search respects mobile limits
- [ ] Touch interactions work (modals, settings)

---

## Issues Found

| Severity | Section | Issue | Steps to Reproduce |
|----------|---------|-------|-------------------|
| | | | |

**Severity Guide:**
- **Critical**: Plugin crashes, data loss, security issue
- **High**: Feature completely broken
- **Medium**: Feature partially broken or confusing UX
- **Low**: Minor cosmetic or edge case issue

---

## Environment

| Property | Value |
|----------|-------|
| Obsidian Version | |
| OS | |
| Plugin Version | 1.0.15 |
| AI Provider | |
| Test Date | |
| Tester | |

---

## Quick Smoke Test Checklist

For rapid verification, test only sections marked with *:

1. [ ] Pre-Test (build, deploy, restart)
2. [ ] Settings UI (order correct, no visual issues)
3. [ ] Command Picker (opens, categories visible)
4. [ ] Tagging (generate + clear on one note)
5. [ ] Summarization (one source type)
6. [ ] Provider Test (connection + one operation)

**Smoke Test Pass:** All 6 items checked = Ready for release
