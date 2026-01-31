# AI Organiser - Manual Test Checklist

**Version:** 1.0.15
**Full Test Time:** ~35 minutes
**Quick Smoke Test:** ~10 minutes (sections marked with *)
**SecretStorage Tests:** Require Obsidian 1.11+

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

### i18n Verification (optional)
- [x] Switch Language to 简体中文 → restart → UI shows Chinese
- [x] Command Picker shows Chinese category names (创建, 增强, 整理, 发现, 集成)
- [x] Switch back to English → restart → UI restored

---

## 1b. SecretStorage (5 min) - Requires Obsidian 1.11+

### Availability Check
- [x] Open Settings → AI Provider section
- [x] If Obsidian 1.11+: API key field shows "🔒 Stored on this device only" badge
- [x] If older Obsidian: Shows "⚠️ Secure storage unavailable" warning

### Fresh Key Entry (1.11+)
- [x] Clear any existing API key
- [x] Enter new API key → key stored in OS keychain
- [x] Reload Obsidian → key still accessible (retrieved from SecretStorage)
- [x] Check `data.json` → cloudApiKey should NOT contain plain text key

### Migration Flow (1.11+)
- [x] If migration available: "Migrate to Secure Storage" button visible
- [x] Click migrate → MigrationConfirmModal opens
- [x] Modal shows warning: "Keys are device-specific. You'll need to re-enter on other devices."
- [x] Accept migration → keys moved to OS keychain
- [x] Check `data.json` → keys cleared from settings
- [x] Decline migration → keys remain in settings file

### Key Status Indicators
- [x] API key configured → shows "✓ Key configured" badge
- [x] No API key → shows "○ No key set" badge
- [x] "Test Key" button validates without showing actual key value

### Inheritance Chain (Advanced)
- [x] Set OpenAI key in AI Provider section
- [x] Go to Embedding settings → select OpenAI provider
- [x] Embedding key should auto-inherit from main provider key
- [x] Test "Use main API key" button functionality

### Cross-Device Behavior
- [x] Understand: Keys are device-local (standard security practice)
- [x] New device: Must re-enter API keys
- [x] Multi-device sync: Keys NOT synced via Obsidian Sync (expected)

---

## 2. Command Picker / Sparkles Menu (2 min) *

- [x] Ctrl+P → "AI Organiser" or ribbon icon → Command Picker opens
- [x] Fuzzy search works (type "tag" → finds tagging commands)
- [x] Categories visible: Create, Enhance, Organize, Discover, Integrate
- [x] Each command has icon and category badge
- [x] Keyboard navigation works (↑↓ to navigate, ↵ to select, Esc to close)
- [x] No "undefined" or raw i18n keys visible in command names/categories
- [x] "Generate from embedded" does NOT appear in picker (removed)

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
- [x] Note with YouTube link → "Summarize"
- [x] Video processed via Gemini (requires Gemini key)
- [x] Transcript saved (if enabled in settings)

### PDF Summarization
- [x] Open note with embedded PDF → "Summarize"
- [x] PDF content extracted and summarized (requires Claude/Gemini)

### Audio Summarization
- [x] Note with embedded audio file → "Summarize"
- [x] Audio transcribed via Whisper → summary generated
- [x] Transcript saved (if enabled)

### Summary Preview Modal
- [x] After any summarization (URL/YouTube/PDF/Audio/Text) → preview modal appears
- [x] Modal shows rendered markdown preview (scrollable for long content)
- [x] **Insert at cursor** button (CTA styling) → content inserted at cursor position
- [x] **Copy to clipboard** button → content copied, notice shown
- [x] **Discard** button (red/warning styling) → nothing inserted, no metadata written
- [x] ESC / X close → treated as discard (no hanging Promise)
- [x] Chunked summary → preview shows, notice says "combined from sections"

### LLM Busy Indicator *
- [x] Any LLM operation → status bar spinner appears at bottom of Obsidian
- [x] Spinner text shows "AI processing..." (or "AI 处理中..." in Chinese)
- [x] Spinner pulses in opacity while spinning (peripheral visibility)
- [x] Spinner disappears when LLM completes (before preview modal opens)
- [x] Spinner does NOT stay active while preview modal is open
- [x] Chunked summarization → spinner stays visible throughout (no flicker between chunks)
- [x] Tag generation → spinner shows during analysis
- [x] Translation → spinner shows during LLM call
- [x] Meeting Minutes dictionary extraction → spinner shows
- [x] Settings → Taxonomy suggestion buttons → spinner shows
- [x] Settings → Test Connection → spinner still works (namespaced keyframes)
- [x] Related Notes sidebar → refresh button spinner still works

### Multi-Source Summarization
- [x] Note with multiple URLs/PDFs → "Summarize"
- [x] Modal shows detected sources with checkboxes
- [x] Oversized document handling works (truncate/full/skip)

### Audio Recording (NEW)

#### Standalone Recording
- [ ] Command Picker → Create → "Record Audio" → modal opens
- [ ] Record button starts recording → timer + size display update live
- [ ] Stop button stops recording → can Play to preview
- [ ] "Insert at cursor" inserts transcript (with `![[recording.webm]]` embed if enabled)
- [ ] "Create new note" creates `.md` file with embed + transcript
- [ ] Recording saved to `AI-Organiser/Recordings/` folder
- [ ] Auto-transcribe works when file ≤ 25MB and API key available
- [ ] Without API key → recording saves, auto-transcribe disabled with info

#### Minutes Modal Integration
- [ ] Minutes modal → Record button visible (both mobile + desktop)
- [ ] Record → transcript appends to transcript textarea via `---` separator
- [ ] Multiple recordings: each appended with separator

#### Multi-Source Modal Integration
- [ ] Multi-Source modal → Audio section → Record button visible in header
- [ ] Record → file appears in audio source list
- [ ] Record button persists after section rerender (add manual audio, verify button still there)

#### Close Safety
- [ ] Close modal during active recording → recording auto-saved with `-unsaved` suffix
- [ ] Close modal with stopped (unsaved) recording → recording auto-saved
- [ ] Notice shows "Recording auto-saved"

#### Edge Cases
- [ ] No active editor → "Insert at cursor" disabled, defaults to "Create new note"
- [ ] Recording >25MB → auto-transcribe checkbox auto-disabled, recording still saves
- [ ] "Max ~52 min" label visible when auto-transcribe enabled

#### Mobile (if testing on mobile)
- [ ] Record button visible in Minutes modal (outside mobile gate)
- [ ] `.m4a` file saved on iOS, `.webm` on Android
- [ ] Live size display shows actual recorded bytes
- [ ] Uses `transcribeAudio()` directly (no FFmpeg crash)

---

## 5. Translation (2 min)

### Note Translation
- [x] Open note → "Translate" → language picker
- [x] Full note translated, formatting preserved
- [ ] **Insert at cursor toggle** — enable toggle → translation inserted at cursor instead of replacing note

### Selection Translation
- [x] Select text → "Translate selection"
- [x] Only selection translated, rest unchanged

---

## 6. Smart Note Features (3 min)

### Enhance Note (Smart Picker)
- [x] "Enhance note" → shows options: Improve, Diagram, Resources, Flashcards
- [x] Each option works:
  - [x] **Improve**: Enhances writing quality
  - [x] **Diagram**: Inserts Mermaid diagram
  - [x] **Resources**: Suggests related resources
  - [x] **Flashcards**: Exports to Anki format

---

## 7. Meeting Minutes (4 min)

### Basic Generation
- [x] Ctrl+P → "Create Meeting Minutes" → modal opens
- [x] Fill: Title, Date, Participants, Transcript
- [x] Select persona from dropdown
- [x] Generate → note created with structured output
- [x] Check frontmatter: `meeting_date`, `attendees` (clean names, no prefix)

### Context Documents
- [x] Add agenda/presentation via "Add Document" button
- [x] Oversized documents show truncation controls
- [x] Documents included in minutes context

### Terminology Dictionary
- [x] Create new dictionary → add terms
- [x] Load existing dictionary → terms available
- [x] Extract terms from documents → populates dictionary
- [x] Dictionary improves name/term consistency in output

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

### Pending Integration (Enhanced)
- [ ] "Add to Pending Integration" → adds selection/content to pending
- [ ] "Integrate pending content" → modal opens with 3 dropdowns + toggle:
  - [ ] **Placement dropdown**: Insert at cursor / Add as new section(s) / Add as callouts / Merge into sections
  - [ ] **Format dropdown**: Prose / Bullet points / Action items / Table
  - [ ] **Detail dropdown**: Full detail / Concise / Summary only
  - [ ] **Auto-tag toggle**: Re-tag note after integration
- [ ] **Placement: cursor** — content appears at cursor, note body untouched
- [ ] **Placement: append** — new section at bottom of main content (before References)
- [ ] **Placement: merge** — warning text appears in dropdown description
- [ ] **Format: tasks** — output uses `- [ ]` checkbox syntax
- [ ] "Resolve pending embeds" → extracts text from embedded documents

---

## 10. Canvas Toolkit (5 min) - Desktop Only

### Investigation Board (requires Semantic Search enabled + indexed vault)
- [ ] Open a note with content → Command Picker → Discover → Canvas → "Investigation Board"
- [ ] Canvas file created in `AI-Organiser/Canvas/` folder
- [ ] Canvas opens automatically (if `openAfterCreate` enabled)
- [ ] Center node is current note (cyan color)
- [ ] Related notes appear as satellite nodes (green, purple if score ≥0.8)
- [ ] Edges have LLM-generated labels (if edge labels enabled in settings)
- [ ] With edge labels disabled: no labels on edges
- [ ] Empty note → shows notice, no canvas created
- [ ] No semantic search → shows "Requires Semantic Search" notice
- [ ] Mobile → shows "Desktop only" notice

### Context Board (no semantic search required)
- [ ] Open note with embedded content (YouTube links, PDFs, audio, wikilinks)
- [ ] Command Picker → Discover → Canvas → "Context Board"
- [ ] Center node is current note
- [ ] YouTube links → purple link nodes
- [ ] PDF embeds → green file nodes
- [ ] Web links → yellow link nodes
- [ ] Missing file references → red text nodes (not crash)
- [ ] Audio embeds → orange nodes
- [ ] Note with no embedded content → shows "No sources detected" notice

### Cluster Board (requires notes with tags)
- [ ] Command Picker → Discover → Canvas → "Cluster Board"
- [ ] TagPickerModal opens → shows all vault tags
- [ ] Select a tag → canvas generated with grouped nodes
- [ ] Groups shown as labeled rectangles containing file nodes
- [ ] With LLM clustering enabled: AI-generated group labels
- [ ] With LLM clustering disabled: folder-based or subtag-based grouping
- [ ] Tag with no notes → shows "No notes with this tag" notice
- [ ] No tags in vault → shows notice, modal doesn't open

### Canvas Settings
- [ ] Settings → Canvas section visible (after Semantic Search)
- [ ] Output folder setting works (default: Canvas)
- [ ] Open after create toggle works
- [ ] Edge labels toggle works
- [ ] LLM clustering toggle works

---

## 10b. Highlight Chat (3 min)

### Path A: Quick Chat (with editor selection)
- [ ] Select text in editor → Command Picker → Discover → Ask AI → "Chat about highlights"
- [ ] Modal opens directly in **chat phase** (no block picker)
- [ ] Selected text shown as context (collapsed, expandable)
- [ ] Type a question → Send → AI responds about selected text
- [ ] Multi-turn: ask follow-up → AI uses conversation history
- [ ] "Insert Last Answer" → last AI response inserted at cursor
- [ ] "Insert Summary" → AI generates standalone prose summary → inserted at cursor

### Path B: Paragraph Picker (no editor selection)
- [ ] Place cursor without selection → "Chat about highlights" command
- [ ] Modal opens in **selection phase** showing note split into blocks
- [ ] Blocks with `==highlight==` or `<mark>` are pre-selected (accent border)
- [ ] Click blocks to toggle selection
- [ ] Token estimate shown: "Selected: N passages (~Xk tokens)"
- [ ] "Start Chat" disabled if nothing selected
- [ ] Click "Start Chat" → enters chat phase

### Chat Features
- [ ] "Back" button returns to selection phase (chat history preserved)
- [ ] Role labels ("You" / "AI") on chat messages
- [ ] "Insert Summary" disabled until at least one Q/A exchange
- [ ] "Insert Last Answer" disabled until at least one Q/A exchange
- [ ] No active editor → insert buttons disabled with tooltip

### Edge Cases
- [ ] Empty note → notice shown, modal doesn't open
- [ ] Code block containing `==text==` → NOT detected as highlight (code-fence immunity)
- [ ] Note with no highlights → all blocks unselected, user must select manually
- [ ] Anti-hallucination: inserted summary uses standalone prose (no "[Passage 1]" references)

---

## 10c. Highlights (1 min)

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
2. [ ] Settings UI (order correct, no visual issues, canvas section visible)
3. [ ] Command Picker (opens, categories visible, Canvas group in Discover)
4. [ ] Tagging (generate + clear on one note)
5. [ ] Summarization (one source type + preview modal + spinner visible)
6. [ ] LLM Busy Indicator (spinner appears during any LLM call, pulses, stops before modal)
7. [ ] Canvas (one board type — Context Board is fastest, no RAG needed)
8. [ ] Provider Test (connection + one operation)
9. [ ] SecretStorage (Obsidian 1.11+ only): Key status badge visible

**Smoke Test Pass:** All 8 items (+ #9 if 1.11+) checked = Ready for release

---

## SecretStorage Quick Verification (Obsidian 1.11+)

If testing on Obsidian 1.11.0 or later, verify these critical items:

| Check | Pass |
|-------|------|
| "🔒 Stored on this device only" badge visible | [x] |
| API key persists after Obsidian restart | [x] |
| data.json does NOT contain plain-text keys | [x] |
| Migration modal shows device-specific warning | [x] |
