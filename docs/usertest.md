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
- [x] Command Picker shows Chinese category names (当前笔记, 采集, 知识库, 工具与流程)
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
- [x] Categories visible: Active Note, Capture, Vault Intelligence, Tools & Workflows
- [x] Each command has icon and category badge
- [x] Keyboard navigation works (↑↓ to navigate, ↵ to select, Esc to close)
- [x] No "undefined" or raw i18n keys visible in command names/categories
- [x] "Generate from embedded" does NOT appear in picker (removed)
- [x] Vault Intelligence has sub-groups: Ask & Search, Visualize
- [x] Ask & Search contains: Chat with AI, Semantic Search
- [x] Visualize contains: Group Notes by Tag, Visualize Tag Graph, Create Bases Dashboard
- [x] Capture has "Smart Summarize" (not "Summarize Web / YouTube")
- [x] Tools has only NotebookLM group (no "Export all tags")
- [x] Root view shows ~10 items (4 Active Note groups + 3 Capture + 2 Vault groups + 1 Tools group)

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
- [x] Command Picker → Capture → "Record Audio" → modal opens
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

### Improve Note — Placement & Preview

#### Duplication Fix (References/Pending)
- [x] Open note with `## References` and `## Pending Integration` sections
- [x] Run Improve Note → verify improved output does NOT contain duplicate References/Pending sections
- [x] Open note with References only → Improve Note → verify NO duplicate References
- [x] Translate Note (single note) on note with References → verify NO duplicate sections
- [x] Multi-source Translate on note with References → verify NO duplicate sections

#### Editor Buffer (Unsaved Edits)
- [x] Open a note, make an unsaved edit (type something without saving)
- [x] Run Improve Note → verify the unsaved edit appears in the improved content

#### Placement: Replace (default)
- [x] Improve Note → select "Replace note content" (default)
- [x] Preview modal shows with "Replace note" button (warning/red style)
- [x] Click "Replace note" → main body replaced, References/Pending preserved

#### Placement: Insert at Cursor
- [ ] Place cursor in middle of note
- [ ] Improve Note → select "Insert at cursor" → submit
- [ ] Preview modal shows with "Insert at cursor" button (CTA/blue style)
- [ ] Click "Insert at cursor" → only new content inserted at cursor position

#### Placement: Create New Note
- [ ] Improve Note → select "Create new note" → submit
- [ ] Preview modal shows with "Create note" button (CTA/blue style)
- [ ] Click "Create note" → new file created (e.g., "MyNote (improved).md"), original untouched
- [ ] Run again → second file gets suffix ("MyNote (improved) 2.md")

#### Preview Modal Actions
- [ ] Preview shows rendered markdown (scrollable)
- [ ] "Copy to clipboard" → content copied, notice shown
- [ ] "Discard" → nothing inserted, no side effects
- [ ] Close with ESC or X → treated as discard, no side effects

### Improve Note — Modal Layout
- [ ] Examples section is collapsible (click triangle to toggle)
- [ ] Placement dropdown appears between persona and textarea
- [ ] Textarea has auto-expand (type long text → grows up to ~200px)

### Textarea Auto-Expand
- [ ] Improve Note modal → type long request → textarea grows
- [ ] Find Resources modal → type long query → textarea grows
- [ ] Mermaid Diagram modal → type long instruction → textarea grows
- [ ] Minutes modal → paste long transcript → textarea grows (up to ~300px)
- [ ] Minutes modal → type long custom instructions → textarea grows
- [ ] Unified Chat → type long message → textarea grows (existing behavior preserved)

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
- [x] "Semantic Search" → search modal → finds semantically similar notes
- [x] "Find Related" → opens Related Notes sidebar
- [x] "Show Related Notes" modal → uses Related Notes Count setting
- [x] "Chat with AI" → unified chat modal (auto-selects mode based on context)
- [x] "Insert Related Notes" → inserts links to related notes

### Wide Net Retrieval Verification (Enhanced Semantic Search)
- [x] Investigation Board → related note count matches Related Notes Count setting
- [x] Highlight Chat → related notes context uses Related Notes Count setting
- [x] Folder scope still works with new pipeline (sidebar folder filter + Investigation Board)
- [x] Very small vault (<15 notes) → returns fewer than requested (no error)
- [x] Notes with only frontmatter → still returns results (title-only query)

### Index Management
- [x] "Manage Index" → shows options: Build, Update, Clear
- [x] Update → re-indexes changed files
- [x] Clear → removes index (requires rebuild)

---

## 9. Integrations (4 min)

### Bases Integration
- [x] "Upgrade metadata" → MigrationModal opens
- [x] Analysis shows: total, needs migration, already migrated
- [x] Run migration → metadata added to notes
- [x] Check frontmatter: `summary`, `source_url` (minimal set)
- [x] "Create dashboard" → DashboardCreationModal
- [x] Dashboard created with folder filtering

### NotebookLM Integration
- [x] "NotebookLM: Select for Export" → adds/removes note from export list (renamed from "Toggle Selection")
- [x] After selecting a note → status bar shows "NotebookLM: 1 selected"
- [x] Select 3 notes → status bar shows "NotebookLM: 3 selected"
- [x] Click status bar counter → export modal opens
- [x] Deselect all notes → status bar counter hidden
- [x] "NotebookLM: Export Source Pack" → ExportPreviewModal opens
- [x] Preview shows selected notes, linked documents, total size
- [x] Export → creates PDF in export folder with AI-generated descriptive name (e.g., `meeting-notes-alpha_2026-02-03`)
- [x] Export same content again → collision-safe folder name with `-2` suffix
- [x] LLM unavailable → export folder falls back to timestamp format
- [x] "NotebookLM: Clear Selection" → removes all selections, status bar updates
- [x] "NotebookLM: Open Export Folder" → opens folder in file explorer

### Pending Integration (Enhanced)
- [x] "Add to Pending Integration" → adds selection/content to pending
- [x] "Integrate pending content" → modal opens with 3 dropdowns + toggle:
  - [x] **Placement dropdown**: Insert at cursor / Add as new section(s) / Add as callouts / Merge into sections
  - [x] **Format dropdown**: Prose / Bullet points / Action items / Table
  - [x] **Detail dropdown**: Full detail / Concise / Summary only
  - [x] **Auto-tag toggle**: Re-tag note after integration
- [x] **Placement: cursor** — content appears at cursor, note body untouched
- [x] **Placement: append** — new section at bottom of main content (before References)
- [x] **Placement: merge** — warning text appears in dropdown description
- [x] **Format: tasks** — output uses `- [ ]` checkbox syntax
- [x] **Source extraction**: After integration, sources from `### Source:` blocks are moved to References section
- [x] **Deduplication**: Sources already in References are not duplicated
- [x] "Resolve pending embeds" → extracts text from embedded documents
- [x] **Pending auto-resolution**: Pending with web URL → integration includes article text
- [x] **Pending auto-resolution**: Pending with YouTube link + Gemini key → transcript used
- [x] **Pending auto-resolution**: Pending with YouTube link + no Gemini key → caption scraping fallback works (not skipped)
- [x] **Pending auto-resolution**: Pending with `![[recording.wav]]` + OpenAI/Groq key → transcript used
- [x] **Pending auto-resolution**: Pending with `![[recording.wav]]` + no audio key → notice shown, audio skipped
- [x] **Pending auto-resolution**: Pending with `![[report.pdf]]` (vault) → multimodal extraction via Claude/Gemini (when available)
- [x] **Pending auto-resolution**: Pending with external PDF URL → multimodal or text extraction based on provider
- [x] **Pending auto-resolution**: Pending with `![[data.docx]]` → text extracted and integrated
- [x] **Pending auto-resolution**: Mixed sources → all resolved, rich integration produced
- [x] **Pending auto-resolution**: Failed source (bad URL) → graceful skip, rest integrated
- [x] **Privacy consent**: Local LLM + YouTube/audio → consent shown for Gemini/OpenAI specifically
- [x] **Truncation**: `merge` placement with large enriched content → truncated to fit limits

---

## 10. Canvas Toolkit (5 min) - Desktop Only

### Investigation Board (requires Semantic Search enabled + indexed vault)
- [x] Open a note with content -> Command Picker -> Active Note -> Note Maps -> "Map Related Concepts"
- [x] Folder picker opens → defaults to current note's folder
- [x] Can change folder or create new one
- [x] Confirm → canvas file created in chosen folder
- [x] Canvas opens automatically (if `openAfterCreate` enabled)
- [x] Center node is current note (cyan color)
- [x] Related notes appear as satellite nodes (green, purple if score ≥0.8)
- [x] Related note count matches Related Notes Count setting
- [x] Edges have LLM-generated labels (if edge labels enabled in settings)
- [x] With edge labels disabled: no labels on edges
- [x] Empty note → shows notice, no canvas created
- [x] No semantic search → shows "Requires Semantic Search" notice
- [x] Mobile → shows "Desktop only" notice

### Context Board (no semantic search required)
- [x] Open note with embedded content (YouTube links, PDFs, audio, wikilinks)
- [x] Command Picker -> Active Note -> Note Maps -> "Map Attachments"
- [x] Folder picker opens → defaults to current note's folder
- [x] Confirm → canvas file created in chosen folder
- [x] Center node is current note
- [x] YouTube links → purple link nodes
- [x] PDF embeds → green file nodes
- [x] Web links → yellow link nodes
- [x] Missing file references → red text nodes (not crash)
- [x] Audio embeds → orange nodes
- [x] Note with no embedded content → shows "No sources detected" notice

### Cluster Board (requires notes with tags)
- [x] Command Picker -> Vault Intelligence -> Vault Visualizations -> "Group Notes by Tag"
- [x] TagPickerModal opens → shows all vault tags
- [x] Select a tag → folder picker opens
- [x] Folder picker defaults to current note's folder (or settings default)
- [x] Confirm → canvas generated with grouped nodes
- [x] Groups shown as labeled rectangles containing file nodes
- [x] With LLM clustering enabled: AI-generated group labels
- [x] With LLM clustering disabled: folder-based or subtag-based grouping
- [x] Tag with no notes → shows "No notes with this tag" notice
- [x] No tags in vault → shows notice, modal doesn't open

### Canvas Settings
- [x] Settings → Canvas section visible (after Semantic Search)
- [x] Output folder setting works (default: Canvas)
- [x] Open after create toggle works
- [x] Edge labels toggle works
- [x] LLM clustering toggle works

---

## 10b. Unified Chat Modal (6 min)

### Opening & Auto-Mode Selection
- [x] Command Picker -> Vault Intelligence -> Ask & Search -> "Chat with AI" -> unified modal opens
- [x] Modal has 3 tabs at top: **Note**, **Vault**, **Highlight**
- [x] With no note open → defaults to Vault mode (if index available) or shows empty state
- [x] With note open, no selection, no highlights → defaults to Vault or Note mode
- [x] With text selected → defaults to Highlight mode
- [x] With `==highlight==` markup in note → defaults to Highlight mode
- [x] Unavailable modes show disabled tab with tooltip explaining why

### Mode Switching
- [x] Click each tab → mode switches, context panel updates
- [x] Switch Note → Vault → Note → previous Note chat history preserved
- [x] Switch modes during active request → stale response dropped, "Previous request cancelled" notice
- [x] Each mode has its own independent chat history
- [x] Close modal, reopen → all histories cleared (session-only)

### Note Mode
- [x] Note tab shows "Discussing: {noteTitle}" in context panel
- [x] Ask question about note content → AI responds with context from note
- [x] Works without semantic search enabled (no RAG dependency)
- [x] Empty note → Note tab disabled with tooltip

### Vault Mode
- [x] Vault tab shows index status: "Index: N docs (vX.X.X)" in context panel
- [x] Ask question → RAG retrieves relevant chunks → AI responds with sources
- [x] Sources shown as clickable wikilinks below assistant messages
- [x] Without semantic search enabled → Vault tab disabled with tooltip
- [x] Ask follow-up → conversation history preserved, AI references prior answers

### Vault Mode - Folder Scope (NEW)
- [x] Open note in subfolder → Vault mode → scope defaults to current folder
- [x] Context panel shows "Searching in: FolderName" below index status
- [x] Click folder scope button → folder picker opens → select different folder
- [x] Select folder → scope updates, context panel reflects change
- [x] "Entire vault" option in folder picker → removes scope filter
- [x] Ask question with folder scope → results only from that folder
- [x] Root-level note → defaults to entire vault (no folder shown)
- [x] Scope derived from active note at modal open (fixed for session; does not auto-follow when switching notes)
- [x] Manually set scope → stays fixed when switching notes (pinned behavior)

### Highlight Mode
- [x] With text selected → opens directly in chat (selection as context)
- [x] Without selection → passage selector shown (blocks with highlights pre-selected)
- [x] Passage selector: click blocks to toggle, "Start Chat" disabled if none selected
- [x] "Insert Summary" action available (not in Note/Vault modes)
- [x] "Insert Last Answer" works → inserts at cursor

### Markdown Rendering
- [x] Assistant responses render **bold**, *italic*, headers, lists, `code` properly
- [x] User messages stay plain text
- [x] Code blocks show with proper formatting

### Animated Thinking Indicator
- [x] Send message → animated dots appear in chat area ("Thinking...")
- [x] Dots auto-scroll into view
- [x] Send button and textarea disabled during processing
- [x] Indicator removed when response arrives

### Chat Export
- [x] Have at least one Q/A exchange → click "Export"
- [x] Folder picker opens (tree view with search, create folder support)
- [x] Exported file has mode-aware title (e.g., "Chat with Vault — {date}", "Chat about {noteTitle} — {date}")
- [x] Messages with timestamps, role labels, sources as wikilinks, `---` separators
- [x] Export again within same minute → collision-safe ` (2)` suffix
- [x] With no messages → "No messages to export" notice

### Actions Bar
- [x] "Clear" resets current mode's conversation only (other modes preserved)
- [x] "Insert Last Answer" disabled until Q/A exchange exists
- [x] "Export" works from all modes
- [x] "Insert Summary" only visible in Highlight mode

### Edge Cases
- [x] All modes unavailable (no note, no index) → explanatory empty state shown, no crash
- [x] Code block containing `==text==` → NOT detected as highlight (code-fence immunity)
- [x] Anti-hallucination: inserted summary uses standalone prose (no "[Passage 1]" references)

---

## 10d. Highlights (2 min)

### Command Palette
- [x] Select text → "Highlight selection" → color picker → text highlighted
- [x] Select highlighted text → "Remove highlight" → highlight removed
- [x] Multiple highlight colors available (if configured)

### Right-Click Context Menu (NEW)
- [x] Select text → right-click → "Highlight" visible in context menu
- [x] Click "Highlight" → color picker opens → highlights text
- [x] Select highlighted text (`==text==` or `<mark>`) → right-click → "Remove highlight" also visible
- [x] Click "Remove highlight" → markup removed, plain text remains
- [x] Right-click without any selection → no highlight items in menu
- [x] Select `==A== plain ==B==` → right-click → "Remove highlight" → both highlights removed correctly
- [x] Select very large text (>5000 chars) → right-click → "Highlight" still visible, "Remove highlight" absent (performance guard)

### Right-Click Context Menu: AI & Workflow (NEW)
- [x] Select text → right-click → Ask AI and Translate visible alongside Highlight group (no separator between them)
- [x] "Ask AI" visible with sparkles icon → opens Chat modal with selection locked
- [x] "Translate" visible with languages icon → opens Translate modal with selection pre-loaded
- [x] Single separator visible before "Add to Pending" (workflow group)
- [x] "Add to Pending" visible with inbox icon → instant action, Notice toast shown
- [x] Select URL → right-click → "Add to Pending" → auto-detects as 'web' type
- [x] Select `[[wikilink]]` → right-click → "Add to Pending" → auto-detects as 'note' type
- [x] Right-click without any selection → no AI/Workflow items in menu
- [x] All 5 items visible when selecting highlighted text (Highlight, Remove Highlight, Ask AI, Translate, Add to Pending)

### Command Picker: Translate Rename
- [x] Open Command Picker → Refine Content → verify label shows "Translate Note" (not "Translate")
- [x] Search "translate" in picker → "Translate Note" appears
- [x] Invoke "Translate Note" with selection → still translates selection (smart dispatch)
- [x] Invoke "Translate Note" without selection → translates note or opens multi-source

---

## 11. Tag Analysis (2 min)

### Tag Network
- [x] "Show Tag Network" → visualization opens
- [x] Nodes represent tags, edges show co-occurrence
- [x] Search/filter works
- [x] Hover shows tag details
- [x] Nodes draggable

### Collect Tags
- [x] "Collect all tags" → creates file with all vault tags
- [x] Tags sorted and deduplicated

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
3. [ ] Command Picker (opens, categories visible, Vault has Ask & Search and Visualize sub-groups)
4. [ ] Tagging (generate + clear on one note)
5. [ ] Summarization (one source type + preview modal + spinner visible)
6. [ ] LLM Busy Indicator (spinner appears during any LLM call, pulses, stops before modal)
7. [ ] Canvas (one board type — Context Board is fastest, no RAG needed)
8. [ ] Unified Chat (single "Chat with AI" command, mode tabs work, markdown renders, export works)
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
