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
- [x] Command Picker → Create → "Record Audio" → modal opens
- [x] Record button starts recording → timer + size display update live
- [x] Stop button stops recording → can Play to preview
- [x] "Insert at cursor" inserts transcript (with `![[recording.webm]]` embed if enabled)
- [x] "Create new note" creates `.md` file with embed + transcript
- [x] Recording saved to `AI-Organiser/Recordings/` folder
- [x] Auto-transcribe works when file ≤ 25MB and API key available
- [x] Without API key → recording saves, auto-transcribe disabled with info

#### Minutes Modal Integration
- [x] Minutes modal → Record button visible (both mobile + desktop)
- [x] Record → transcript appends to transcript textarea via `---` separator
- [x] Multiple recordings: each appended with separator

#### Multi-Source Modal Integration
- [x] Multi-Source modal → Audio section → Record button visible in header
- [x] Record → file appears in audio source list
- [x] Record button persists after section rerender (add manual audio, verify button still there)

#### Close Safety
- [x] Close modal during active recording → recording auto-saved with `-unsaved` suffix
- [x] Close modal with stopped (unsaved) recording → recording auto-saved
- [x] Notice shows "Recording auto-saved"

#### Edge Cases
- [ ] No active editor → "Insert at cursor" disabled, defaults to "Create new note"
- [ ] Recording >25MB → auto-transcribe checkbox auto-disabled, recording still saves
- [ ] "Max ~52 min" label visible when auto-transcribe enabled

#### Mobile (if testing on mobile)
- [x] Record button visible in Minutes modal (outside mobile gate)
- [x] `.m4a` file saved on iOS, `.m4a` or `.webm` on Android (device-dependent)
- [x] Live size display shows actual recorded bytes
- [x] Uses `transcribeAudio()` directly (no FFmpeg crash)

---

## 5. Translation (2 min)

### Note Translation
- [x] Open note → "Translate" → language picker
- [x] Full note translated, formatting preserved
- [x] **Insert at cursor toggle** — enable toggle → translation inserted at cursor instead of replacing note

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

### Output Folder Override (Folder Picker)
- [x] Minutes modal → "Output folder" button visible near bottom of form (not text input)
- [x] Click button → folder picker modal opens with tree view
- [x] Default folder shown or prefilled from settings (e.g., `AI-Organiser/Meetings`)
- [x] Search folders → filters correctly
- [x] Type non-existing folder → "+ Create" item appears
- [x] Resolved path preview shown inside picker before confirm
- [x] Select folder → display updates to show selected path
- [x] Generate minutes → file created in chosen folder
- [x] Leave default → generate minutes → file goes to default folder

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
- [x] Enable Semantic Search in settings
- [x] Select embedding provider (OpenAI, Gemini, Ollama, etc.)
- [x] Enter API key if needed (or use main key)
- [x] "Build Index" → indexing progress shown

### Related Notes Sidebar
- [x] View → "Related Notes" → sidebar opens
- [x] Switch between notes → panel updates (500ms debounce)
- [x] Similarity badges color-coded (green ≥0.8, yellow ≥0.6, gray <0.6)
- [x] Scores vary across results (not all "excellent" — real cosine similarity, not placeholder)
- [x] Open a note that previously had few results → verify more unique files appear (dedup working)
- [x] Multiple chunks from same file → only 1 result per file shown (dedup by file path)
- [x] Click related note → navigates to it
- [x] Hover → preview shown
- [x] Settings → Semantic Search → Related Notes Count = 3 → sidebar shows 3 results
- [x] Change Related Notes Count to 25 → sidebar expands to match

#### Folder Scope
- [x] Open note in subfolder → results default to current folder
- [x] Footer shows "Searching in: FolderName/"
- [x] Click scope button → folder picker → select different folder → results update
- [x] Pin icon appears when folder-scoped; click pin → unpins → reverts to auto-follow
- [x] Switch notes between folders → scope auto-follows when unpinned
- [x] When pinned → scope stays fixed across note switches
- [x] Options menu → "Search current folder" / "Search entire vault" work
- [x] Few results in folder → hint shown below results
- [x] No results in folder → scoped empty state with "Search all notes" action
- [x] Root-level note → defaults to vault-wide (no folder scope)
- [x] Mobile modal: "This folder" / "All notes" toggle works

### Search Commands
- [ ] "Semantic Search" → search modal → finds semantically similar notes
- [ ] "Find Related" → opens Related Notes sidebar
- [ ] "Show Related Notes" modal → uses Related Notes Count setting
- [ ] "Chat with Vault" → RAG-enhanced Q&A modal
- [ ] "Ask about current note" → Q&A for active note
- [ ] "Insert Related Notes" → inserts links to related notes

### Wide Net Retrieval Verification (Enhanced Semantic Search)
- [ ] Investigation Board → related note count matches Related Notes Count setting
- [ ] Highlight Chat → related notes context uses Related Notes Count setting
- [ ] Folder scope still works with new pipeline (sidebar folder filter + Investigation Board)
- [ ] Very small vault (<15 notes) → returns fewer than requested (no error)
- [ ] Notes with only frontmatter → still returns results (title-only query)

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
- [ ] Related note count matches Related Notes Count setting
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

## 10b. Chat with Vault UX (4 min)

### Markdown Rendering
- [ ] Open Chat with Vault → ask a question that returns markdown (e.g., "List 3 key topics in my vault")
- [ ] Assistant response renders **bold**, *italic*, headers, lists, and `code` properly
- [ ] User messages stay plain text (no markdown rendering)
- [ ] Code blocks in assistant response show with proper formatting

### Conversation History (Follow-ups)
- [ ] Ask initial question → AI responds
- [ ] Ask follow-up referencing previous answer (e.g., "Tell me more about the first point")
- [ ] AI references prior answer correctly (conversation context preserved)
- [ ] Ask 3-4 questions in sequence → conversation stays coherent
- [ ] Close modal, reopen → history is cleared (fresh session)

### Chat Export
- [ ] Chat with Vault → have at least one Q/A exchange
- [ ] Click "Export" button → folder picker modal opens (tree view, not text input)
- [ ] Default path shown or prefilled: `AI-Organiser/Chats` (or custom chatExportFolder)
- [ ] Search folders in picker → filters correctly
- [ ] Type non-existing folder name → "+ Create" item appears at top with accent color
- [ ] Click Create → folder created (including nested paths), export proceeds
- [ ] Resolved path preview shown inside picker before confirm (e.g. "Destination: AI-Organiser/Chats/MyFolder")
- [ ] Select existing folder → click Export → file created in chosen folder
- [ ] Keep default → click Export → file created in `AI-Organiser/Chats/`
- [ ] Click Cancel / ESC → no file created
- [ ] First run (default folder doesn't exist) → search prefilled with default path, "+ Create" shown
- [ ] Open exported file → proper markdown format:
  - [ ] Heading with date: `# Chat with Vault — {date}`
  - [ ] Messages with timestamps and role labels (**You** / **Assistant**)
  - [ ] Sources as wikilinks: `[[Notes/Meeting.md]]`
  - [ ] Messages separated by `---` horizontal rules
- [ ] Export again within same minute → file gets ` (2)` suffix (collision-safe)
- [ ] With no messages → click Export → "No messages to export" notice shown

### Chat Export Settings
- [ ] Settings → Semantic Search → "Chat export folder" text field visible
- [ ] Change folder name → Chat with Vault export uses new folder
- [ ] Clear field → defaults back to "Chats"

---

## 10c. Highlight Chat (3 min) - Markdown + Chat

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

### Highlight Scoping (NEW)
- [ ] Note with highlights → only highlighted passages shown by default (not all blocks)
- [ ] "Showing X of Y passages" count label visible next to toggle
- [ ] Click "Show all passages" → all blocks visible, highlighted ones still selected
- [ ] Select a non-highlighted block while "Show all" is on
- [ ] Click "Show highlights only" → non-highlighted selections auto-cleared (hidden-selection bug prevention)
- [ ] Token count always reflects actual selected passages (not hidden ones)
- [ ] Verify correct passage text sent: highlight at paragraph #50 → "Show highlights only" → Start Chat → LLM receives paragraph #50 content (not #1)
- [ ] Note with NO highlights and no editor selection → notice shown ("No highlights found..."), modal closes

### Chat Features
- [ ] "Back" button returns to selection phase (chat history preserved)
- [ ] Role labels ("You" / "AI") on chat messages
- [ ] Assistant messages render markdown (bold, lists, code blocks)
- [ ] User messages stay plain text
- [ ] "Insert Summary" disabled until at least one Q/A exchange
- [ ] "Insert Last Answer" disabled until at least one Q/A exchange
- [ ] No active editor → insert buttons disabled with tooltip

### Edge Cases
- [ ] Empty note → notice shown, modal doesn't open
- [ ] Code block containing `==text==` → NOT detected as highlight (code-fence immunity)
- [ ] Note with no highlights and no selection → notice shown, modal closes (changed from previous behavior)
- [ ] Anti-hallucination: inserted summary uses standalone prose (no "[Passage 1]" references)

---

## 10d. Highlights (2 min)

### Command Palette
- [ ] Select text → "Highlight selection" → color picker → text highlighted
- [ ] Select highlighted text → "Remove highlight" → highlight removed
- [ ] Multiple highlight colors available (if configured)

### Right-Click Context Menu (NEW)
- [ ] Select text → right-click → "Highlight" visible in context menu
- [ ] Click "Highlight" → color picker opens → highlights text
- [ ] Select highlighted text (`==text==` or `<mark>`) → right-click → "Remove highlight" also visible
- [ ] Click "Remove highlight" → markup removed, plain text remains
- [ ] Right-click without any selection → no highlight items in menu
- [ ] Select `==A== plain ==B==` → right-click → "Remove highlight" → both highlights removed correctly
- [ ] Select very large text (>5000 chars) → right-click → "Highlight" still visible, "Remove highlight" absent (performance guard)

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
2. [ ] Settings UI (order correct, no visual issues, canvas section visible, chat export folder visible)
3. [ ] Command Picker (opens, categories visible, Canvas group in Discover)
4. [ ] Tagging (generate + clear on one note)
5. [ ] Summarization (one source type + preview modal + spinner visible)
6. [ ] LLM Busy Indicator (spinner appears during any LLM call, pulses, stops before modal)
7. [ ] Canvas (one board type — Context Board is fastest, no RAG needed)
8. [ ] Chat with Vault (markdown renders, follow-up works, export creates file)
9. [ ] Provider Test (connection + one operation)
10. [ ] SecretStorage (Obsidian 1.11+ only): Key status badge visible

**Smoke Test Pass:** All 9 items (+ #10 if 1.11+) checked = Ready for release

---

## SecretStorage Quick Verification (Obsidian 1.11+)

If testing on Obsidian 1.11.0 or later, verify these critical items:

| Check | Pass |
|-------|------|
| "🔒 Stored on this device only" badge visible | [x] |
| API key persists after Obsidian restart | [x] |
| data.json does NOT contain plain-text keys | [x] |
| Migration modal shows device-specific warning | [x] |
