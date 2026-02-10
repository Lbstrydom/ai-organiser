# AI Organiser - Development Status

**Version:** 1.0.15
**Last Updated:** February 8, 2026
**Status:** Companion Personas — Phases 1-6 Complete

---

## Recent Updates

### Companion Personas: Phases 1-6 (2026-02-08) — COMPLETE

**Simplified personas from 6 to 5 across all persona types, added Study Companion dual-output, and wired companion into all summarization pipelines.**

| Phase | Description | Status |
|-------|-------------|--------|
| Phase 1 — Clean Slate | Delete dead code, marker-based config migration | Complete |
| Phase 2 — Summary Personas | 5 new summary personas (brief, study, business-operator, feynman, learning-insight) | Complete |
| Phase 3 — Companion Schema | `companion_content` JSON field, `STUDY_COMPANION_DELIMITER`, `splitCompanionContent()` | Complete |
| Phase 4 — Companion Pipelines | Wired companion into all 11 summarization pipelines (URL, YouTube, PDF, Audio, multi-source, plain text) | Complete |
| Phase 5 — Companion UI Toggle | `enableStudyCompanion` setting, conditional toggle in URL/YouTube/PDF/Audio/MultiSource modals | Complete |
| Phase 6 — Writing Personas Mirror | 5 writing personas mirroring summary IDs, schema version bump to 3 | Complete |
| Build | 1181 tests passing (55 suites) |

**Key Architecture Decisions:**
- **Companion guard**: `shouldIncludeCompanion(personaId, includeCompanion, enableStudyCompanion)` — centralized predicate in `companionUtils.ts`
- **Cursor-only gating**: Companion file created ONLY when user chooses "Insert at cursor" (never on copy/discard)
- **Structured + traditional paths**: JSON `companion_content` field for structured; `STUDY_COMPANION_DELIMITER` for traditional; `splitCompanionContent()` safety net for fallback
- **Multi-source**: Companion only on final synthesis, not per-source
- **Persona mirroring**: Writing persona IDs exactly match summary persona IDs for consistency
- **Config migration**: Marker-based versioning (`v3`) with backup of customized files

**Files Created:**
- `src/utils/companionUtils.ts` — `processCompanionOutput()` + `shouldIncludeCompanion()`
- `tests/companionUtils.test.ts` — 15 tests for companion utility + predicate + edge cases

**Files Modified:**
- `src/services/configurationService.ts` — New DEFAULT_PERSONAS (5 writing), DEFAULT_SUMMARY_PERSONAS (5 summary), schema version 3, icon markers in config file generation
- `src/commands/summarizeCommands.ts` — Companion threading in all 11 pipeline functions, multi-source single-audio persona passthrough
- `src/services/prompts/structuredPrompts.ts` — `companion_content` in structured schema
- `src/services/prompts/summaryPrompts.ts` — `STUDY_COMPANION_DELIMITER` for traditional path
- `src/utils/responseParser.ts` — `splitCompanionContent()`, companion passthrough in structured parsing
- `src/core/settings.ts` — `enableStudyCompanion` setting
- `src/ui/modals/UrlInputModal.ts` — Companion toggle (study persona conditional)
- `src/ui/modals/YouTubeInputModal.ts` — Companion toggle
- `src/ui/modals/MultiSourceModal.ts` — Companion toggle + result field
- `src/ui/modals/PdfSelectModal.ts` — Companion toggle
- `src/ui/modals/AudioSelectModal.ts` — Companion toggle, fixed i18n keys
- `src/ui/settings/SummarizationSettingsSection.ts` — `enableStudyCompanion` settings toggle
- `src/i18n/types.ts`, `src/i18n/en.ts`, `src/i18n/zh-cn.ts` — Companion messages + settings labels
- `tests/promptInvariants.test.ts` — Writing persona invariant tests (8 new)
- `docs/comp-plan.md` — Phases 1-6 checked off

**Remaining Phases:** 7 (Minutes personas + GTD), 8 (Settings migration), 9 (i18n cleanup), 10 (Tests), 11 (Documentation)

---

### Right-Click Context Menu, Spellcheck & Folder Reorganization (2026-02-03) — COMPLETE

**Added 3 new right-click context menu items, enabled OS spellcheck on text inputs, and reorganized plugin folder structure.**

| Aspect | Status |
|--------|--------|
| Context menu: Ask AI | Complete — opens UnifiedChatModal with selection locked, sparkles icon |
| Context menu: Translate | Complete — opens TranslateModal with selection pre-loaded, languages icon |
| Context menu: Add to Pending | Complete — instant action with Notice feedback, inbox icon |
| Centralized context menu handler | Complete — `src/ui/contextMenu.ts` replaces per-command registration |
| Context menu Gestalt layout | Complete — single separator before Add to Pending (actions + workflow groups) |
| Command Picker rename | Complete — "Translate" → "Translate Note" (macro/micro disambiguation) |
| OS spellcheck on textareas | Complete — `spellcheck = true` on 10 freeform textareas across 7 modals |
| Participants folder move | Complete — from Config/ to Meetings/participants/ |
| Build | 1108 tests passing (2 pre-existing parallel-only failures unrelated) |

**Architecture: Centralized Context Menu Handler**

Created dedicated `src/ui/contextMenu.ts` instead of adding items to individual command files. Single `editor-menu` event registration orchestrates all plugin context menu items. Exported helper functions from command modules use dependency injection (plugin parameter) to prevent circular imports.

```
main.ts → contextMenu.ts → translateCommands.ts (logic only)
                          → chatCommands.ts (logic only)
                          → integrationCommands.ts (logic only)
                          → highlightCommands.ts (logic only)
```

**Context Menu Layout (when text selected):**
```
  Highlight               (highlighter)     ← always
  Remove Highlight        (eraser)          ← conditional: markup detected, ≤5000 chars
  Ask AI                  (sparkles)        ← always
  Translate               (languages)       ← always
  ─────────────────────────                 ← single separator
  Add to Pending          (inbox)           ← always (instant, no modal)
```

**Macro/Micro Disambiguation:**
- Right-click "Translate" = micro (selection-scoped)
- Command Picker "Translate Note" = macro (note/vault-scoped)
- Smart dispatch preserved: "Translate Note" still translates selection when present

**Spellcheck:** Enabled native OS spellcheck on freeform text inputs in UnifiedChatModal, FindResourcesModal, ImproveNoteModal, AudioSelectModal, FlashcardExportModal, MermaidDiagramModal, and MinutesCreationModal (4 textareas).

**Files Created:**
- `src/ui/contextMenu.ts` — Centralized right-click context menu handler

**Files Modified:**
- `src/commands/highlightCommands.ts` — Removed editor-menu registration (moved to contextMenu.ts)
- `src/commands/translateCommands.ts` — Exported `translateSelectionFromMenu()` helper
- `src/commands/chatCommands.ts` — Exported `openChatWithSelection()` helper, added `Editor` import
- `src/commands/integrationCommands.ts` — Exported `dropSelectionToPending()` helper, refactored command
- `src/commands/index.ts` — Import and register contextMenu
- `src/i18n/types.ts` — Added `contextMenu` section to Translations interface
- `src/i18n/en.ts` — Added contextMenu labels, renamed `commands.translate` → "Translate Note"
- `src/i18n/zh-cn.ts` — Chinese translations for contextMenu + translate rename
- `src/services/participantListService.ts` — Updated doc comment for new folder location
- `src/ui/modals/MinutesCreationModal.ts` — Changed participants base to Meetings folder
- `src/ui/modals/UnifiedChatModal.ts` — Added spellcheck to textarea
- `src/ui/modals/FindResourcesModal.ts` — Added spellcheck to textarea
- `src/ui/modals/ImproveNoteModal.ts` — Added spellcheck to textarea
- `src/ui/modals/AudioSelectModal.ts` — Added spellcheck to textarea
- `src/ui/modals/FlashcardExportModal.ts` — Added spellcheck to textarea
- `src/ui/modals/MermaidDiagramModal.ts` — Added spellcheck to textarea
- `src/ui/modals/MinutesCreationModal.ts` — Added spellcheck to 4 textareas
- `docs/usertest.md` — Added test cases for context menu + translate rename

---

### Command Picker Naming & Canvas Folder Picker (2026-02-03) — COMPLETE

**Improved naming clarity and added folder picker for canvas creation.**

| Aspect | Status |
|--------|--------|
| Rename "Connections & Maps" → "Note Maps" | Complete — clarifies note-scoped context |
| Rename "Visualize" → "Vault Visualizations" | Complete — clarifies vault-scoped context |
| Canvas folder picker | Complete — defaults to current note's folder, allows change |
| Build | 1118 tests passing |

**Files Modified:**
- `src/i18n/types.ts`, `src/i18n/en.ts`, `src/i18n/zh-cn.ts` — New group names and folder picker i18n
- `src/ui/modals/CommandPickerModal.ts` — Updated i18n key references
- `src/commands/canvasCommands.ts` — All 3 canvas commands now show FolderScopePickerModal

---

### Tag Network & AI Suggestions Modal Fixes (2026-02-03) — COMPLETE

**Fixed tag network view initialization error and improved AI suggestions modal with Gestalt-compliant card layout.**

| Aspect | Status |
|--------|--------|
| Tag network view initialization | Complete — pass networkData to newly created views, use needsNewLeaf flag |
| AI suggestions modal layout | Complete — Gestalt card design with proper visual hierarchy |
| Build | 1118 tests passing |

**Root cause (tag network):** When opening tag network for the first time, `updateNetworkData()` was called before the view was fully initialized. Fixed by using a `needsNewLeaf` boolean flag pattern and passing `networkData` after `setViewState()` completes.

**Root cause (suggestions modal):** Obsidian's Setting component places toggle and text controls in a vertical layout by default. CSS specificity was too low to override. Added high-specificity selectors with `.ai-organiser-modal-content` prefix and `!important` flags.

**Files Modified:**
- `src/main.ts` — `showTagNetwork()` refactored with proper view initialization, `revealLeaf()` for focus
- `styles.css` — `.ai-organiser-suggestion-item` card layout with background, border, fixed 140px label width

---

### Multimodal PDF Extraction for Pending Integration (2026-02-03) — COMPLETE

**Pending Integration now uses Claude/Gemini multimodal to extract full PDF content including images, diagrams, and tables — matching Smart Summarize quality.**

| Aspect | Status |
|--------|--------|
| Multimodal PDF extraction | Complete — sends base64 to Claude/Gemini with extraction prompt |
| PDF extraction prompt | Complete — extracts full content, describes visuals, converts tables to markdown |
| Graceful fallback | Complete — uses text extraction (officeparser) when no multimodal provider |
| Privacy consent | Complete — requests consent for PDF provider (may differ from main LLM) |
| Tests | Complete — integrationResolve.test.ts (23 cases), integrationPrompts.test.ts (7 new) |

**Files Modified:**
- `src/services/contentExtractionService.ts` — `PdfExtractionConfig`, `setPdfExtractionConfig()`, `extractPdfWithMultimodal()`
- `src/services/prompts/integrationPrompts.ts` — `buildPdfExtractionPrompt()` for multimodal extraction
- `src/commands/integrationCommands.ts` — configures PDF extraction, passes textOnly=false when multimodal available
- `tests/integrationResolve.test.ts` — multimodal PDF tests, language config test
- `tests/integrationPrompts.test.ts` — PDF extraction prompt tests

### Pending Integration: Auto-Resolve All Sources (2026-02-03) — COMPLETE

**Pending Integration now resolves web articles, YouTube/audio transcripts, PDFs, and documents before integration.**

| Aspect | Status |
|--------|--------|
| Content resolution pipeline | Complete — web/YouTube/audio/PDF/document/internal links |
| Privacy consent gating | Complete — per-provider consent (Gemini/OpenAI/Groq + main LLM) |
| Positional replacement | Complete — line-based, bottom-up replacement |
| Prompt truncation budget | Complete — accounts for main content and overhead |
| Tests | Complete — integrationResolve.test.ts (20 cases) |

**Build Status**: 1108 tests passing (54 suites)

**Files Modified:**
- `src/services/contentExtractionService.ts` — audio transcription support, text-only PDF extraction path
- `src/commands/integrationCommands.ts` — resolveAllPendingContent, privacy consent, truncation budget
- `src/i18n/types.ts`, `src/i18n/en.ts`, `src/i18n/zh-cn.ts` — new integration messages
- `tests/integrationResolve.test.ts` — content resolution, consent, and truncation tests
- `docs/usertest.md` — manual test cases for pending auto-resolution


### Pending Integration Fix + Chat AI Naming (2026-02-03) — COMPLETE

**Fixed pending integration source extraction to handle unstructured content (raw URLs, wikilink embeds). Added AI-generated filenames for chat exports.**

| Aspect | Status |
|--------|--------|
| Pending source extraction: unstructured content support | Complete — raw URLs, `![[embeds]]`, dedup |
| Chat export AI naming | Complete — LLM generates descriptive filename, fallback to timestamp |
| Tests | Complete — 21 tests (noteStructure.test.ts) |

**Build Status**: 1087 tests passing (53 suites)

**Root cause (pending refs bug):** `extractSourcesFromPending()` only parsed structured `### Source:` / `> From:` format. Users paste raw URLs and wikilinks directly into `## Pending Integration` without using the "Add to Pending" command. Added Pass 2 (raw URL extraction) and Pass 3 (wikilink embed extraction) with cross-pass deduplication.

**Files Modified:**
- `src/utils/noteStructure.ts` — `extractSourcesFromPending()` now handles raw URLs and `![[embeds]]`
- `src/ui/modals/UnifiedChatModal.ts` — `generateChatFileName()` via LLM, fallback to `Chat-{date}.md`
- `src/services/prompts/chatPrompts.ts` — New: `buildChatFileNamePrompt()`
- `tests/noteStructure.test.ts` — 6 new tests for unstructured content

---

### NotebookLM UX Improvements (2026-02-03) — COMPLETE

**Four changes: renamed command, status bar counter, AI folder names, and pending source extraction.**

| Aspect | Status |
|--------|--------|
| Change 1: Rename "Toggle Selection" → "Select for Export" | Complete — i18n only |
| Change 2: Status bar selection counter | Complete — desktop only, click to export |
| Change 3: AI-generated export folder names | Complete — LLM in command layer, collision-safe |
| Change 4: Pending Integration source extraction | Complete — sources moved to References before clearing |
| Tests | Complete — 21 tests (noteStructure.test.ts) |

**Build Status**: 1087 tests passing (53 suites)

**Files Modified:**
- `src/i18n/types.ts`, `src/i18n/en.ts`, `src/i18n/zh-cn.ts` — New i18n keys
- `src/main.ts` — NotebookLM status bar element, debounced metadata listener, `updateNotebookLMStatus()`
- `src/services/notebooklm/selectionService.ts` — Optimized `getSelectionCount()` to synchronous cache-only
- `src/services/notebooklm/sourcePackService.ts` — Accept optional `folderName`, collision-safe increment
- `src/commands/notebookLMCommands.ts` — AI folder name generation via LLM, status bar updates after toggle/clear
- `src/services/prompts/notebookLMPrompts.ts` — New: `buildFolderNamePrompt()`
- `src/utils/noteStructure.ts` — New: `extractSourcesFromPending()`, `getReferencesContent()`
- `src/commands/integrationCommands.ts` — `movePendingSourcesToReferences()` before clearing pending
- `styles.css` — NotebookLM status bar styles
- `tests/noteStructure.test.ts` — 21 unit tests for source extraction
- `docs/usertest.md` — Updated NotebookLM + Pending Integration test items
- `docs/completed/menu-plan-command-picker.md` — "Toggle Selection" → "Select for Export"

---

### Command Picker Restructuring (2026-02-03) — COMPLETE

**Restructured Command Picker from functional grouping (Create, Enhance, Organize, Discover, Integrate) to context-based grouping (Active Note, Capture, Vault Intelligence, Tools & Workflows).**

| Aspect | Status |
|--------|--------|
| Plan | Complete — `docs/completed/menu-plan-command-picker.md` (3 rounds of review) |
| Implementation | Complete |
| Tests | Complete — 9 tests covering structure, callbacks, leaf count |

**Build Status**: 1066 tests passing (52 suites)

**New Command Picker Structure:**
| Category | Sub-groups | Leaf Commands |
|----------|-----------|---------------|
| Active Note (4 groups) | Note Maps (4), Refine Content (4), Pending Integration (3), Export (2) | 13 |
| Capture (3 flat) | — | 3 |
| Vault Intelligence (2 groups) | Ask & Search (2), Visualize (3) | 5 |
| Tools & Workflows (1 group) | NotebookLM (4) | 4 |
| **Total** | | **25 entries, 25 unique** |

**Key design decisions:**
- Context-based grouping (Gestalt proximity — commands grouped by user's current focus)
- `smart-summarize` in Capture only — removed from Refine Content to eliminate duplicate command with confusing labels
- "Refine Content" contains only in-place note transforms (tag, improve, translate, clear) — no external sources
- Vault sub-grouped into "Ask & Search" (chat, semantic search) and "Visualize" (cluster, tag graph, dashboard) — reduces root items
- "Collect All Tags" removed from picker (rare maintenance utility, still in Ctrl+P)
- "Summarize Web / YouTube" renamed to "Smart Summarize" (covers all 7 source types)
- Strict i18n: no `?.` or `|| 'fallback'` patterns, all keys in `Translations` interface
- Shared alias token arrays for fuzzy search consistency
- Full CSS audit: only 4 `[data-category]` selectors remain

**Files Modified:**
- `src/ui/modals/CommandPickerModal.ts` — `buildCommandCategories()` rewritten
- `src/i18n/types.ts` — 12 new keys added, 8 obsolete removed
- `src/i18n/en.ts`, `src/i18n/zh-cn.ts` — New translations added
- `styles.css` — Category color selectors updated (blue/orange/green/gray)
- `tests/commandPicker.test.ts` — Rewritten with exhaustive leaf command assertions
- `CLAUDE.md`, `AGENTS.md` — Command Picker docs updated
- `docs/usertest.md` — Command Picker test section updated

**Documentation**: `docs/completed/menu-plan-command-picker.md`

---

### Unified Chat Modal (2026-02-03) — COMPLETE

**Consolidated three separate chat interfaces into a single unified modal with mode tabs (Note/Vault/Highlight). Single "Chat with AI" command replaces three separate commands.**

| Aspect | Status |
|--------|--------|
| Plan | Complete — 3 rounds of reviewer feedback incorporated |
| Implementation | Complete |
| Command Consolidation | Complete — 3 commands → 1 "Chat with AI" |

**Build Status**: 1067 tests passing (52 suites)

**Key design decisions:**
- Strategy pattern: `ChatModeHandler` interface with 3 implementations (Note, Vault, Highlight)
- Preloaded `ModalContext` for sync availability checks
- Per-mode chat history (`Map<ChatMode, ChatMessage[]>`) — no data loss on tab switch
- Request generation counter for race condition prevention
- Action descriptors (data, not closures) to prevent handler boundary leak
- Animated thinking indicator in chat area (CSS `@keyframes`)
- Auto-mode selection: selection → highlight, highlights in note → highlight, index available → vault, else → note
- Session-only history (resets on modal reopen)
- Single command entry point: `chat-with-ai` replaces `chat-with-vault`, `ask-about-current-note`, `chat-about-highlights`

**New Files Created:**
- `src/ui/chat/ChatModeHandler.ts` — Interface, types, ModalContext, ActionDescriptor
- `src/ui/chat/NoteModeHandler.ts` — Note mode strategy (no RAG required)
- `src/ui/chat/VaultModeHandler.ts` — Vault mode strategy (RAG search)
- `src/ui/chat/HighlightModeHandler.ts` — Highlight mode strategy (passage selector)
- `src/ui/modals/UnifiedChatModal.ts` — Unified chat shell (~700 lines)
- `src/services/prompts/chatPrompts.ts` — Note + vault fallback prompts
- `tests/unifiedChat.test.ts` — 12 tests: mode selection, handler availability, per-mode history, action descriptors

**Key Files Modified:**
- `src/commands/chatCommands.ts` — 3 commands replaced with single `chat-with-ai` command
- `src/ui/modals/CommandPickerModal.ts` — Ask AI group replaced with single "Chat with AI" entry in Discover
- `src/utils/chatExportUtils.ts` — `formatExportMarkdown()` accepts pre-computed mode-aware title
- `src/i18n/types.ts`, `en.ts`, `zh-cn.ts` — `modals.unifiedChat` section (58 keys), `chatWithAI` command, old chat sections removed
- `styles.css` — Legacy chat styles replaced with unified `.ai-organiser-chat-*` namespace
- `src/ui/modals/HighlightChatModal.ts` — Deprecated stub (no longer functional)

**Command Picker Structure (After — superseded by Command Picker Restructuring above):**
| Category | Top-level Items | Groups |
|----------|----------------|--------|
| Create (4) | Smart Summarize, Meeting Minutes, Export Note, Record Audio | — |
| Enhance (3) | Enhance Note, Translate, **Highlight** group | Highlight (2 sub) |
| Organize (2) | **Tags** group, **Bases** group | Tags (4 sub), Bases (4 sub incl. Manage Index) |
| Discover (3) | **Chat with AI**, **Find Notes** group, **Canvas** group | Find Notes (3 sub), Canvas (3 sub) |
| Integrate (2) | **Pending** group, **NotebookLM** group | Pending (3 sub), NotebookLM (4 sub) |

**Documentation**: `docs/completed/uni-plan.md`

---

### Index Version Persistence (2026-02-02)

**Fix index version persisting as `1.0.0` after clear+rebuild. Add distinct Build (full rebuild) vs Update (incremental) semantics.**

| Area | Fix | Status |
|------|-----|--------|
| Lazy Migration | Version stamp on every `upsert()` — active users don't see false "outdated" warning | Complete |
| Full Rebuild | `rebuildVault()` — clear + reindex all, distinct from incremental `indexVault()` | Complete |
| DRY Extraction | `indexAllNotes()` shared by both `indexVault()` and `rebuildVault()` | Complete |
| Centralized Constant | `INDEX_SCHEMA_VERSION` in `types.ts`, re-exported from `vectorStoreService.ts` | Complete |
| ManageIndexModal | Build button wired to `rebuildVault()`, re-renders after operations | Complete |
| Embedding Guard | `rebuildVault()` early-returns `{0,0}` when embedding service is null | Complete |
| Search Cache | `rebuildVault()` clears search cache during rebuild | Complete |
| Load Ordering | `rebuildVault()` awaits `loadPromise` before calling `clear()` | Complete |
| Tests | 10 new tests: version stamp, rebuild semantics, warning flag, load ordering, cache clear, embedding guard | Complete |

**Build Status**: 1054 tests passing (52 suites)

**Root Cause**: `load()` overwrites default metadata (including version `2.0.0`) from persisted `meta.json` containing `1.0.0`. `clear()` only reset counts but left the stale version. After clear+rebuild, old version persisted.

**Expert Review**: 3 rounds — synthesized architectural purity (full rebuild path) with pragmatic UX (lazy migration). See `docs/completed/index-plan.md` for full review analysis.

**Key Files Modified:**
- `src/services/vector/types.ts` — `INDEX_SCHEMA_VERSION` constant with JSDoc
- `src/services/vector/vectorStoreService.ts` — Re-export, `indexAllNotes()`, `rebuildVault()`, `hasWarnedIndexVersion` reset
- `src/services/vector/voyVectorStore.ts` — Import constant, version stamp in `upsert()` with trade-off comment
- `src/services/vector/simpleVectorStore.ts` — Import constant, version stamp in `upsert()`
- `src/ui/modals/ManageIndexModal.ts` — Build → `rebuildVault()`, embedding service guard
- `tests/semanticSearchPlan.test.ts` — 10 new tests

**Documentation**: `docs/completed/index-plan.md`

---

### UX Fixes: Export Folder Picker, Highlight Context Menu, Highlight Chat Scoping (2026-02-02)

**Three UX improvements addressing user friction in export workflows, highlight interactions, and highlight chat modal.**

| Feature | Description | Status |
|---------|-------------|--------|
| Export Folder Picker | Replace plain text folder inputs with `FolderScopePickerModal` in chat export and minutes output | Complete |
| Search-to-Create | Type non-existing folder name → "+" Create" affordance with safe recursive creation via `ensureFolderExists()` | Complete |
| Resolved Path Preview | Inline preview of destination path inside picker before confirm (`resolvePreview` callback) | Complete |
| Default Folder Prefill | If `defaultFolder` doesn't exist in vault, prefill search input and show Create affordance | Complete |
| Confirm Button Text | `confirmButtonText` option (e.g. "Export" instead of "Select") | Complete |
| Right-Click Highlight | `editor-menu` registration: "Highlight" always visible, "Remove highlight" conditional on markup detection | Complete |
| Performance Guard | Strip check skipped for selections >5000 chars; "Highlight" still shown | Complete |
| Highlight Chat Scoping | Default to showing only highlighted blocks; toggle with "Show all passages" / "Show highlights only" | Complete |
| Auto-Deselect | Non-highlighted block selections auto-cleared on toggle-back (prevents hidden-selection bug) | Complete |
| No Highlights Early Exit | Notice + modal close when note has no highlights and no editor selection | Complete |
| originalIndex Tracking | Selection indices reference `this.blocks` positions, not filtered-array loop indices | Complete |
| Showing Count | "Showing {visible} of {total} passages" label on toggle button | Complete |
| Duplicate Related Notes Fix | `getLeavesOfType()` check before `getRightLeaf(false)` prevents duplicate sidebar views | Complete |
| Highlight Group Removed | Removed Highlight sub-group from Command Picker Enhance category (right-click replaces it) | Complete |
| i18n | 6 new keys: 4 highlightChat + 2 folderScopePicker (EN + ZH-CN) | Complete |
| Tests | 33 new tests in `uxFixes.test.ts` covering all three features + i18n completeness | Complete |

**Expert Review Findings Addressed:**

| Finding | Severity | Resolution |
|---------|----------|------------|
| >5000 guard hides all context actions | Blocker | Guard only applies to "Remove highlight" detection; "Highlight" always visible |
| `vault.createFolder()` risky for nested/invalid paths | Blocker | Use `ensureFolderExists()` (recursive) + path normalization/validation |
| Resolved path preview should be inside picker, not second step | High | Added `resolvePreview` callback to `FolderScopePickerModal` |
| Hidden-selection bug on toggle-back | High | Auto-deselect non-highlighted blocks when filtering back |
| Default folder may not exist on first run | Medium | Prefill search + show Create affordance |
| DRY highlight detection | Medium | Reuse `stripExistingHighlight` instead of separate regex |
| Unused `Menu` import may fail strict builds | Medium | No explicit import — Obsidian event callback types are inferred |

**Build Status**: 1028 tests passing (51 suites)

**Key Files Modified:**
- `src/commands/highlightCommands.ts` — `editor-menu` registration with conditional "Remove highlight", `stripExistingHighlight` exported
- `src/ui/modals/HighlightChatModal.ts` — `showAllBlocks` toggle, `originalIndex` tracking, auto-deselect, no-highlights early exit, count label
- `src/commands/chatCommands.ts` — `promptExportFolder()` replaced with `FolderScopePickerModal`
- `src/ui/modals/FolderScopePickerModal.ts` — `confirmButtonText`, `allowNewFolder`, `resolvePreview`, `normalizeCreatePath()`, `shouldShowCreateFolder()` (exported for testing)
- `src/ui/modals/MinutesCreationModal.ts` — Output folder text input replaced with folder picker button
- `src/commands/semanticSearchCommands.ts` — `getLeavesOfType()` duplicate view prevention
- `src/ui/modals/CommandPickerModal.ts` — Removed Highlight sub-group from Enhance category
- `src/i18n/types.ts`, `en.ts`, `zh-cn.ts` — 6 new keys (highlightChat + folderScopePicker)
- `tests/uxFixes.test.ts` — 33 tests: stripExistingHighlight, highlight chat scoping, FolderScopePickerOptions, normalizeCreatePath, shouldShowCreateFolder, i18n completeness

**Documentation**: `docs/completed/uxfix-plan.md`

---

### Chat UX Improvements + Minutes Folder Selection (2026-02-02)

**Markdown rendering, conversation history, chat export, and minutes folder override across ChatWithVault, HighlightChat, and Minutes modals.**

| Feature | Description | Status |
|---------|-------------|--------|
| Markdown Rendering | `MarkdownRenderer.render()` for assistant messages in ChatWithVault + HighlightChat | Complete |
| Component Lifecycle | Reset `Component` at start of each `renderMessages()` call to prevent listener accumulation | Complete |
| Conversation History | `formatConversationHistory()` with MAX_HISTORY_MESSAGES (20) + MAX_HISTORY_CHARS (8000) limits | Complete |
| History Injection | `<conversation_history>` XML section appended to both RAG and fallback prompt paths | Complete |
| Chat Export Button | "Export Chat" button in ChatWithVault modal header | Complete |
| Export Folder Confirm | One-off folder override modal (does not persist to settings) | Complete |
| Export File Format | `Chat-YYYY-MM-DD-HHmm.md` with timestamps, sources as wikilinks, collision-safe naming | Complete |
| Chat Export Setting | `chatExportFolder` subfolder under pluginFolder (default: `Chats`) | Complete |
| Minutes Output Folder | Editable output folder field in MinutesCreationModal (one-off override) | Complete |
| CSS | Markdown margin fixes for `p:first-child/last-child` and `pre` in chat bubbles | Complete |
| i18n | 9 new keys: 6 chat export, 2 settings, 1 minutes (EN + ZH-CN) | Complete |
| Tests | 10 new tests in `chatExport.test.ts`, 3 new tests in `pathUtils.test.ts` | Complete |

**Review Findings Addressed:**

| Finding | Severity | Fix |
|---------|----------|-----|
| Export folder modal Esc/X hangs `handleExport()` promise | High | `resolved` flag + `onClose` fallback in `promptExportFolder()` |
| Hardcoded English error notice in export | Medium | Added `exportFailed` i18n key with `{error}` placeholder (EN + ZH-CN) |
| Tests are logic copies, not testing production code | Medium | Extracted pure functions to `chatExportUtils.ts`, imported by both production and tests |
| Folder edit inconsistency with subfolder model | Medium | Typed values run through `resolvePluginPath()` in both chat export and minutes modal |

**Build Status**: 995 tests passing (50 suites)

**Key Files Modified:**
- `src/commands/chatCommands.ts` — Unified chat modal entrypoints, export handler + folder prompt modal
- `src/utils/chatExportUtils.ts` — Shared pure functions: `formatConversationHistory()`, `formatExportMarkdown()`, constants, `ChatExportMessage` interface
- `src/ui/modals/UnifiedChatModal.ts` — Unified chat shell and markdown rendering with `.ai-organiser-chat-msg-content`
- `src/core/settings.ts` — `chatExportFolder` setting + default + `getChatExportFullPath()` resolver; `resolvePluginPath()` exported
- `src/ui/settings/SemanticSearchSettingsSection.ts` — Chat export folder text field in RAG subsection
- `src/ui/modals/MinutesCreationModal.ts` — `outputFolder` state field, editable text field, `resolvePluginPath()` in `handleSubmit()`
- `src/i18n/types.ts`, `en.ts`, `zh-cn.ts` — Chat export keys (incl. `exportFailed`), minutes outputFolderLabel, semanticSearch chatExportFolder
- `styles.css` — Unified chat modal layout, chat bubbles, and markdown margin fixes
- `tests/chatExport.test.ts` — Imports from production `chatExportUtils.ts` (10 tests)
- `tests/pathUtils.test.ts` — `getChatExportFullPath()` tests (3 tests)

**Design Decisions:**
- Export in unified chat; Insert Summary is available only in Highlight mode
- Folder overrides are one-off — consistent with no other feature persisting modal-level folder changes
- History excludes system messages and the just-added user query (`.slice(0, -1)`) to avoid duplication
- RAG retrieval still uses only the latest query — correct since we search for the new topic

**Documentation**: `docs/completed/chat-plan.md`

---

### Tag Network Search Enhancement (2026-02-02)

**Replace plain text filter with chip/token multi-tag input, autocomplete dropdown, and hover-safe graph highlighting. Convert all hardcoded strings to i18n.**

| Area | Feature | Status |
|------|---------|--------|
| Constructor | Pass `plugin` as 4th arg to TagNetworkView for i18n access | Complete |
| Search UI | Chip/token multi-tag input with × remove buttons | Complete |
| Dropdown | Autocomplete suggestions filtered by substring, sorted by frequency, max 8 | Complete |
| Keyboard | ↑/↓ navigation, Enter selects, Escape closes, Backspace removes last chip | Complete |
| Graph Filter | Multi-tag OR highlighting with `computeFilterSets()` pure function | Complete |
| Hover Safety | `applyFilterState()` restores filter on mouseout instead of hardcoded defaults | Complete |
| Constants | Opacity values extracted to named constants (no magic numbers) | Complete |
| Pure Functions | `filterSuggestions()` and `computeFilterSets()` exported for testability | Complete |
| i18n | 13 hardcoded English strings converted to `tagNetwork` i18n section (EN + ZH-CN) | Complete |
| CSS | Chip container, dropdown, positioning (`position: relative` on search) | Complete |
| Mobile | Chip input in list view, co-occurrence filtering via graph edges | Complete |
| Tests | `tagNetworkSearch.test.ts` — suggestion filtering, filter set computation | Complete |

**Build Status**: 974+ tests passing

**Key Files Modified:**
- `src/ui/views/TagNetworkView.ts` — Chip input, dropdown, `filterSuggestions()`, `computeFilterSets()`, `applyFilterState()`, opacity constants, full i18n conversion
- `src/main.ts` — Pass `this` (plugin) as 4th arg to TagNetworkView constructor
- `src/i18n/types.ts` — New `tagNetwork` section (13 keys)
- `src/i18n/en.ts`, `src/i18n/zh-cn.ts` — English + Chinese translations
- `styles.css` — `.tag-network-chip-*`, `.tag-network-dropdown-*` classes
- `tests/tagNetworkSearch.test.ts` — Pure function unit tests

**Expert Review Findings Addressed:**
1. `this.plugin` didn't exist — added as 4th constructor arg
2. Hover resets wiped search highlighting — `applyFilterState()` restores filter state on mouseout
3. Tag ID vs label mismatch — chips store node IDs internally, display labels in UI
4. No `views` section in i18n — created dedicated `tagNetwork` top-level section
5. All 13 hardcoded strings converted to i18n in same pass
6. Dropdown CSS positioning — `position: relative` on `.tag-network-search`
7. Event cleanup — all listeners registered with `this.cleanup.push()`
8. Unit tests added for pure logic functions

**Documentation**: `docs/completed/tag-improplan.md`

---

### Index Version Persistence Fix & Chat with Vault Improvements (2026-02-02)

**Fix index version persisting as `1.0.0` after clear+rebuild. Fix Chat with Vault modal ordering, LLM fallback, and diagnostics.**

| Area | Fix | Status |
|------|-----|--------|
| VoyVectorStore | `clear()` resets entire metadata object including version (was only resetting counts) | Complete |
| VectorStoreService | Reset `hasWarnedIndexVersion` after clearing in `updateEmbeddingService()` | Complete |
| ManageIndexModal | Re-render modal after Build/Update/Clear operations (`await this.onOpen()`) | Complete |
| ChatCommands | Replace hardcoded `'2.0.0'` with `INDEX_SCHEMA_VERSION` constant | Complete |
| ChatCommands | Fix modal CSS class, chat container ordering, LLM fallback path | Complete |
| i18n | Add `noVaultContextFallback` and `embeddingServiceMissing` keys (EN + ZH-CN) | Complete |

**Build Status**: 974+ tests passing

**Root Cause**: `load()` overwrites default metadata (including version `2.0.0`) from persisted `meta.json` containing `1.0.0`. `clear()` only reset `totalDocuments`, `totalNotes`, `lastUpdated` but left the stale version. After clear+rebuild, the old version persisted.

**Key Files Modified:**
- `src/services/vector/voyVectorStore.ts` — `clear()` resets full metadata object preserving `embeddingDims`/`embeddingModel`
- `src/services/vector/vectorStoreService.ts` — `hasWarnedIndexVersion = false` after clear
- `src/ui/modals/ManageIndexModal.ts` — `await this.onOpen()` after operations to refresh version warning
- `src/commands/chatCommands.ts` — `INDEX_SCHEMA_VERSION` constant, modal class fix, container ordering, fallback
- `src/i18n/types.ts`, `en.ts`, `zh-cn.ts` — Chat diagnostics i18n keys
- `styles.css` — Chat modal CSS selector fixes

---

### Semantic Search Stability & Quality Overhaul (2026-02-02)

**Fix critical index lifecycle bug, improve retrieval quality via metadata injection, fix "Update Index" scope**

| Phase | Feature | Status |
|-------|---------|--------|
| Phase 1.1 | Conditional embedding reinit in `saveSettings()` — stop wiping index on every settings change | Complete |
| Phase 1.2 | `shouldClear` parameter on `updateEmbeddingService()` — only clear when explicitly requested | Complete |
| Phase 2.1 | "Update Index" changed from active-note-only to vault-wide via `indexVault()` | Complete |
| Phase 2.2 | i18n label updates (EN + ZH-CN): "Update changed files" | Complete |
| Phase 3.1 | Metadata injection: Title/Path/Tags prepended to chunk text for embedding only | Complete |
| Phase 3.2 | Index schema version bump to `2.0.0` (Voy + Simple stores) | Complete |
| Phase 3.3 | Staleness detection: ManageIndexModal warns when index version mismatches | Complete |
| Phase 3.4 | i18n strings for `indexOutdated` warning (EN + ZH-CN) | Complete |
| Phase 4.1 | Re-embed on rename/move: `renameNote()` does full re-index with metadata prefix | Complete |
| Phase 4.1b | Fallback: lightweight path rewrite when embedding service unavailable | Complete |
| Phase 4.2 | Bulk Rename Guard: debounced queue (500ms), threshold (10), prevents folder rename bombs | Complete |
| Tests | `semanticSearchPlan.test.ts` — conditional clear, metadata prefix, rename, bulk guard | Complete |

**Build Status**: 968+ tests passing

**Root Causes Fixed:**
1. **Index wipe on any settings change** — `saveSettings()` unconditionally called `initializeEmbeddingService()` → `vectorStore.clear()`. Now tracks `lastEmbeddingConfig` and only reinitializes when embedding provider/model/enabled changes.
2. **"Update Index" only updated active note** — `handleUpdateIndex()` called `indexNote(file)` for just the active file. Now calls `indexVault()` which uses the change tracker to skip unchanged files.
3. **Missing categorical context in embeddings** — "GROW Model" note in `Coaching/` folder didn't embed "coaching" concept. Now prepends `Title: / Path: / Tags:` metadata prefix (max 200 chars) to chunks for embedding generation only (not stored in content field).
4. **Stale embeddings after rename/move** — With metadata injection, folder path baked into embeddings becomes stale on rename. Now re-embeds at new path. Bulk rename guard prevents mass API calls when moving folders.

**Key Files Modified:**
- `src/main.ts` — `saveSettings()` conditional embedding reinit with `lastEmbeddingConfig` tracking
- `src/services/vector/vectorStoreService.ts` — `updateEmbeddingService(service, shouldClear)`, `buildMetadataPrefix()`, `getFileTags()`, `queueRenameNote()`, `flushRenames()`, `INDEX_SCHEMA_VERSION = '2.0.0'`
- `src/ui/modals/ManageIndexModal.ts` — Vault-wide `handleUpdateIndex()`, schema staleness warning
- `src/services/vector/voyVectorStore.ts` — Version bump to `2.0.0`
- `src/services/vector/simpleVectorStore.ts` — Version bump to `2.0.0`
- `src/i18n/types.ts`, `en.ts`, `zh-cn.ts` — `updateLabel`, `updateDesc`, `indexOutdated` strings

**Expert Review Decisions:**
- **`score > 0` gate preserved** — Negative cosine similarity indicates genuinely anti-correlated content. Removing the gate would flood results with noise.
- **TagNetworkView semantic links deferred** — Architecture mismatch: tag graph uses tags as nodes, semantic links are file-to-file. Existing alternatives (Related Notes sidebar, Investigation Board) already serve this need.
- **Content hash change detection** — Already implemented via `createContentHash(content)` + `changeTracker.hasChanged()` (not mtime-based). No changes needed.

**Documentation**: `docs/completed/semsearch-plan.md`

---

### Enhanced Semantic Search: Wide Net Retrieval + User Configuration (2026-02-01)

**Fix "light results" in Related Notes — query dilution, chunk starvation, placeholder scores**

| Phase | Feature | Status |
|-------|---------|--------|
| Phase 1.1 | Core pipeline refactor: focused query, over-fetch, dedup | Complete |
| Phase 1.2 | Shared `vectorMath.ts` — extracted `cosineSimilarity` (DRY) | Complete |
| Phase 1.3 | Voy real cosine scores replacing placeholder `0.9` | Complete |
| Phase 1.4 | SimpleVectorStore imports shared cosine | Complete |
| Phase 2.1 | `relatedNotesCount` setting (default 15, range 1-50) | Complete |
| Phase 2.2 | Settings UI numeric input | Complete |
| Phase 2.3-2.6 | All 4 call sites use setting (sidebar, modal, canvas, chat) | Complete |
| Phase 2.7 | i18n strings (EN + ZH-CN) | Complete |
| Tests | `vectorMath.test.ts` (5 tests), `ragService.test.ts` updates (30 tests) | Complete |

**Build Status**: 968 tests passing (47 suites) + 17 integration tests

**New Files Created:**
- `src/services/vector/vectorMath.ts` — Shared `cosineSimilarity` function (extracted from SimpleVectorStore)
- `tests/vectorMath.test.ts` — 5 unit tests (identical, orthogonal, mismatch, zero-magnitude, known vectors)

**Key Files Modified:**
- `src/services/ragService.ts` — `getRelatedNotes()` refactored: focused query (title + 2500 chars body), over-fetch 5×maxResults (capped 200), exclude self before dedup, dedup by file path, sort + slice
- `src/services/vector/voyVectorStore.ts` — Real cosine similarity via `cosineSimilarity(queryVector, doc.embedding)` replacing hardcoded `score: 0.9`; fallback `0.5` for old index data
- `src/services/vector/simpleVectorStore.ts` — Imports shared `cosineSimilarity` from `vectorMath.ts` (local copy removed)
- `src/core/settings.ts` — `relatedNotesCount: number` (default 15)
- `src/ui/settings/SemanticSearchSettingsSection.ts` — Numeric input with parseInt validation (1-50)
- `src/ui/views/RelatedNotesView.ts` — Uses `plugin.settings.relatedNotesCount || 15`
- `src/ui/modals/RelatedNotesModal.ts` — Uses `plugin.settings.relatedNotesCount || 15`
- `src/commands/canvasCommands.ts` — Uses setting for Investigation Board
- `src/commands/chatCommands.ts` — Uses setting for highlight chat
- `src/i18n/types.ts`, `en.ts`, `zh-cn.ts` — `relatedNotesCount` name + description strings

**Root Causes Fixed:**
1. **Query embedding dilution** — Full 30K-char note content produced blurred embedding; now uses focused query (title + first 2500 chars of stripped body)
2. **Chunk slot starvation** — Only 5-8 results requested; now over-fetches 5× with dedup to surface more unique files
3. **Placeholder similarity scores** — Voy WASM hardcoded `score: 0.9` broke ranking and badges; now computes real cosine similarity

**Review Findings Incorporated:**
- Exclude current file before dedup (not after)
- `score > 0` gate in SimpleVectorStore preserved (negative cosine = genuinely irrelevant)
- Over-fetch cap raised to 200 (adaptive re-query rejected for complexity)
- Setting applies to all 4 call sites (sidebar, modal, canvas, chat)

**Documentation**: `docs/completed/semantic-plan.md`

---

### Canvas & Code Quality Polish (2026-02-01)

**Magic number extraction, i18n edge labels, SOLID cleanup**

| Area | Change | Status |
|------|--------|--------|
| Investigation Board | Edge label strings now i18n-driven via `EdgeLabelStrings` interface | Complete |
| Investigation Board | Score thresholds extracted to named constants (`SCORE_THRESHOLD_HIGH/MEDIUM`) | Complete |
| Investigation Board | Snippet char limit extracted to `EDGE_SNIPPET_CHARS` constant | Complete |
| Cluster Board | Deterministic chunk size extracted to `DETERMINISTIC_CHUNK_SIZE` constant | Complete |
| Layouts | Radial/grid threshold extracted to `RADIAL_LAYOUT_THRESHOLD` constant | Complete |
| RAG Service | `DEFAULT_MIN_SIMILARITY` and `MAX_QUERY_CHARS` extracted to module-level constants | Complete |
| Highlight Extractor | Display text limit extracted to `DISPLAY_TEXT_LIMIT` constant | Complete |
| i18n | 3 new edge label strings (`edgeCloselyRelated`, `edgeRelated`, `edgeLooselyRelated`) in EN + ZH-CN | Complete |

**Build Status**: 968 tests passing (47 suites) + 17 integration tests

**Key Files Modified:**
- `src/services/canvas/investigationBoard.ts` — `EdgeLabelStrings` interface, score/snippet constants, i18n-driven fallback labels
- `src/services/canvas/clusterBoard.ts` — `DETERMINISTIC_CHUNK_SIZE` constant
- `src/services/canvas/layouts.ts` — `RADIAL_LAYOUT_THRESHOLD` export
- `src/services/ragService.ts` — `DEFAULT_MIN_SIMILARITY`, `MAX_QUERY_CHARS` module-level constants
- `src/utils/highlightExtractor.ts` — `DISPLAY_TEXT_LIMIT` constant
- `src/commands/canvasCommands.ts` — Passes `edgeLabelStrings` from i18n to Investigation Board
- `src/i18n/types.ts`, `en.ts`, `zh-cn.ts` — 3 new edge label translation keys

**Design Rationale:**
- Magic numbers replaced with named constants for readability and maintainability
- Edge label fallbacks ("Closely related", "Related", "Loosely related") were hardcoded English — now driven by i18n system
- No behavioral changes — pure refactor with identical test results

---

### Canvas Toolkit + Audit Refactor (2026-01-31)

**Implementation Complete + Dual Audit Refactor (24 findings addressed)**

| Part | Feature | Status |
|------|---------|--------|
| Phase 0 | Shared infrastructure: types, layouts, canvas utilities | Complete |
| Phase 1 | Investigation Board — RAG-based related notes canvas with LLM edge labels | Complete |
| Phase 2 | Context Board — embedded content visualization (YouTube, PDF, links, audio, docs) | Complete |
| Phase 3 | Cluster Board — tag-based grouping with LLM or deterministic clustering | Complete |
| Phase 4 | Integration: settings, i18n, Command Picker Canvas group, TagPickerModal | Complete |
| Audit | DRY extraction (shared JSON parser, tag extractor), SOLID fixes, error codes, language support, UX | Complete |
| Tests | 75 new tests across 7 test files (layouts, utils, prompts, boards, response parser) | Complete |

**Build Status**: 968 tests passing (47 suites) + 17 integration tests

**New Files Created:**
- `src/services/canvas/types.ts` — Canvas JSON types (CanvasNode, CanvasEdge, CanvasData) + internal descriptors (NodeDescriptor, EdgeDescriptor, ClusterDescriptor) + CanvasErrorCode type
- `src/services/canvas/layouts.ts` — Pure layout algorithms: radial, grid, adaptive, clustered + edge side computation
- `src/services/canvas/canvasUtils.ts` — File creation, node/edge builders, ID generation, name sanitization, safety-capped path deduplication
- `src/services/canvas/investigationBoard.ts` — Investigation Board builder with RAG + LLM edge labels + score-based fallback
- `src/services/canvas/contextBoard.ts` — Context Board builder with embedded content detection (no LLM required)
- `src/services/canvas/clusterBoard.ts` — Cluster Board builder with deterministic fallback (folder → subtag → chunk)
- `src/services/prompts/canvasPrompts.ts` — Edge label + cluster prompts with language parameter
- `src/commands/canvasCommands.ts` — Three canvas commands with error code handling, try/catch, language resolution
- `src/ui/settings/CanvasSettingsSection.ts` — 4 settings: output folder, open after create, edge labels, LLM clustering
- `src/ui/modals/TagPickerModal.ts` — FuzzySuggestModal for tag selection with empty-tag guard

**Audit Findings Addressed:**
1. DRY: Extracted `tryParseJson`, `tryParseJsonFromFence`, `tryParseJsonFromObject`, `tryExtractJson` into `responseParser.ts` (was duplicated in investigation + cluster boards)
2. DRY: Extracted `extractTagsFromCache()` into `tagUtils.ts` (was in 3 files: canvasCommands, clusterBoard, sourcePackService)
3. DRY: Extracted `getClusterColor()` helper replacing 4 inline `CLUSTER_COLORS[i % len]` usages
4. SOLID: Removed `globalThis.app` from clusterBoard — `app` parameter threaded explicitly
5. SOLID: Added `CanvasErrorCode` type union (`no-related-notes`, `no-sources-detected`, `no-notes-with-tag`, `creation-failed`) replacing string matching
6. New setting: `canvasUseLLMClustering` toggle (was hardcoded `true`)
7. Language: `buildEdgeLabelPrompt` now accepts language parameter with `<requirements>` section
8. Language: Cluster Board uses `summaryLanguage` setting instead of hardcoded `'English'`
9. Dead code: Removed `canvas.selectTag` i18n key
10. UX: TagPickerModal checks tag count before opening, shows notice if empty
11. UX: Edge labels description mentions "Investigation Board" scope
12. Robustness: `buildCanvasEdge` warns on missing positions with `console.warn`
13. Robustness: `getAvailableCanvasPath` has MAX_COUNTER=999 safety cap
14. Error handling: All `withBusyIndicator` calls wrapped in try/catch
15. Removed redundant line in `radialLayout`
16. Removed fallback i18n strings in TagPickerModal (keys exist in both locales)

**Key Files Modified:**
- `src/utils/responseParser.ts` — 4 new generic JSON extraction exports
- `src/utils/tagUtils.ts` — `extractTagsFromCache()` shared utility
- `src/services/canvas/types.ts` — `CanvasErrorCode` + `errorCode` on `CanvasResult`
- `src/commands/canvasCommands.ts` — Error codes, try/catch, shared utilities, LLM clustering setting, language
- `src/i18n/types.ts`, `en.ts`, `zh-cn.ts` — Canvas section, LLM clustering strings, dead key removal
- `src/services/notebooklm/sourcePackService.ts` — Uses shared `extractTagsFromCache`

---

### Highlight Chat Feature (2026-01-31)

**Implementation Complete + Dual Audit Refactor (12 findings addressed)**

| Part | Feature | Status |
|------|---------|--------|
| Core | Block-aware content parser (`highlightExtractor.ts`) | Complete |
| Core | Two-phase modal: block selection → chat → insert (`HighlightChatModal.ts`) | Complete |
| Core | Prompt module with anti-hallucination instructions (`highlightChatPrompts.ts`) | Complete |
| Integration | `chat-about-highlights` command + Command Picker (Discover > Ask AI) | Complete |
| i18n | 20 new highlight chat strings (EN + ZH-CN) | Complete |
| CSS | `ai-organiser-hc-*` styles (selection, chat, passages, empty state) | Complete |
| Tests | 5 unit tests (block parsing, list continuation, code-fence immunity, markup stripping) | Complete |
| Audit | Dual audit refactor — DRY, SOLID, dead code, UX/Gestalt fixes | Complete |

**Build Status**: 878 tests passing (40 suites)

**New Files Created:**
- `src/ui/modals/HighlightChatModal.ts` — Two-phase modal: block selection with checkbox picker → multi-turn AI chat → insert summary/answer at cursor
- `src/utils/highlightExtractor.ts` — Block-aware parser (paragraph, code, callout, list, table, heading) with frontmatter stripping, code-fence-aware highlight detection, non-text placeholders
- `src/services/prompts/highlightChatPrompts.ts` — XML-structured prompts with anti-hallucination instructions for standalone prose output

**Key Files Modified:**
- `src/commands/chatCommands.ts` — `chat-about-highlights` command with smart dispatch (selection → Path A, no selection → Path B)
- `src/ui/modals/CommandPickerModal.ts` — Added to Discover > Ask AI group (3 sub-commands)
- `src/i18n/types.ts`, `en.ts`, `zh-cn.ts` — 20 highlight chat keys + `chatAboutHighlights` command
- `styles.css` — 25 CSS rules for selection phase, chat phase, passage summary, selected state, empty state, role labels
- `tests/highlightExtractor.test.ts` — 5 tests for block parser + highlight extraction
- `tests/commandPicker.test.ts` — Ask AI group assertion updated (3 sub-commands)

**Audit Findings Addressed:**
1. List continuation lines absorbed into list block (was splitting nested content as paragraphs)
2. Code block `==`/`<mark>` stripping — `normalizePassage` now preserves code block content
3. Dead code removed: `extractHighlightedPassages`, `HighlightedPassage`, `ContentBlockType` export, `filePath` option, `phase` field
4. DRY: Extracted `formatPassages()`/`formatHistory()` helpers in prompts (3x duplication)
5. DRY: Extracted `formatError()` in modal (6x duplication)
6. DRY: Extracted `notify()` helper for Obsidian Notice pattern
7. SOLID: Replaced boolean-parameter `toggleBlock()` with `selectBlock()`/`deselectBlock()`
8. UX: "Insert Last Answer" disabled until Q/A exchange exists + during processing
9. UX: Disabled insert buttons show tooltip explaining why (no active editor)
10. UX: Empty chat state with placeholder guidance text
11. UX: Role labels ("You" / "AI") on chat message bubbles
12. UX: Selected-row visual state (background highlight on non-marked selected blocks)

**User Workflow:**
- **Path A (Quick Chat)**: Select text → command → modal opens in chat phase with selection as context
- **Path B (Paragraph Picker)**: No selection → command → block picker with highlights pre-selected → Start Chat → multi-turn conversation → Insert Summary or Insert Last Answer

---

### In-Plugin Audio Recording (2026-01-31)

**All Parts Complete + 2 Expert Review Rounds (18 findings addressed)**

| Part | Feature | Status |
|------|---------|--------|
| Core | AudioRecordingService — MediaRecorder wrapper with mime negotiation | Complete |
| Core | AudioRecorderModal — Record/Stop/Play/Save with live timer + size | Complete |
| Integration | Standalone `record-audio` command + Command Picker | Complete |
| Integration | Minutes modal — Record button (mobile + desktop, outside mobile gate) | Complete |
| Integration | Multi-Source modal — Record button in both render paths | Complete |
| Settings | Recording sub-section in Audio Transcription settings | Complete |
| i18n | 28 new recording strings (EN + ZH-CN) | Complete |
| CSS | `ai-organiser-audio-recorder-*` styles | Complete |
| Tests | commandPicker.test.ts updated for `record-audio` | Complete |

**Build Status**: 874 tests passing (39 suites)

**New Files Created:**
- `src/services/audioRecordingService.ts` — MediaRecorder wrapper, mime negotiation (`audio/mp4` → `audio/webm;codecs=opus` → fallbacks), actual chunk size tracking via 1-second timeslice, 64kbps bitrate
- `src/ui/modals/AudioRecorderModal.ts` — Full recording modal with states (idle → recording → stopped → saving → transcribing → done), platform-aware transcription, close safety (auto-save on accidental close)

**Key Files Modified:**
- `src/ui/modals/MinutesCreationModal.ts` — `renderRecordButton()` method rendered OUTSIDE `!Platform.isMobile` gate
- `src/ui/modals/MultiSourceModal.ts` — `renderAudioRecordButton()` helper called from both `renderSourceSection()` AND `renderSectionContent()` to survive rerenders
- `src/commands/summarizeCommands.ts` — `record-audio` command registration
- `src/ui/modals/CommandPickerModal.ts` — Record Audio in Create category with aliases
- `src/core/settings.ts` — `autoTranscribeRecordings`, `embedAudioInNote` settings
- `src/core/constants.ts` — `DEFAULT_RECORDING_FOLDER`
- `src/ui/settings/AudioTranscriptionSettingsSection.ts` — Recording sub-section (toggles + info)
- `src/i18n/types.ts`, `en.ts`, `zh-cn.ts` — 28 recording keys + `recordAudio` command
- `styles.css` — Audio recorder modal, minutes record button, multi-source record button styles
- `tests/commandPicker.test.ts` — `record-audio` assertion in Create category

**Expert Review Findings Addressed:**
1. FFmpeg crash on mobile — uses `transcribeAudio()` directly, never `transcribeAudioWithFullWorkflow()`
2. Multi-Source rerender button loss — record button in BOTH render paths via shared helper
3. Fixed size estimate unreliable — actual chunk size accumulation via `mediaRecorder.start(1000)` timeslice
4. `isTypeSupported` unreliable — fallback to default `new MediaRecorder(stream)`, read `mimeType` from instance
5. Property name typo — `this.transcriptTextArea` (capital A)
6. CSS prefix convention — all classes use `ai-organiser-audio-recorder-*` prefix
7. Duplicate constant — reuses existing `MAX_FILE_SIZE_BYTES` from `audioTranscriptionService.ts`
8. Missing transcription language — passes `transcriptionLanguage` from Minutes modal state
9. Lost recording prevention — auto-save on modal close during recording or with unsaved data
10. Bitrate control — `audioBitsPerSecond: 64000` (64kbps, ~52 min under 25MB)
11. Upfront time limit warning — "Max ~52 min" label shown when auto-transcribe enabled

**Folder Structure (After):**
```
AI-Organiser/
├── Chats/           # Exported chat conversations
├── Config/          # Taxonomy, personas, dictionaries
├── Exports/         # NotebookLM exports, note exports
├── Flashcards/      # Anki/Brainscape flashcards
├── Meetings/        # Meeting minutes output
├── NotebookLM/      # NotebookLM source packs
├── Recordings/      # Audio recordings
└── Transcripts/     # Audio/YouTube transcripts
```

---

### Minutes Fixes & Folder Consolidation (2026-01-30)

**All Parts Complete**

| Part | Feature | Status |
|------|---------|--------|
| Minutes Fix | JSON body rendering — `isUsableMarkdown()` guard rejects JSON fragments | Complete |
| Minutes Fix | Removed `aio_` prefix from all 17 frontmatter properties (now clean names) | Complete |
| Minutes Fix | Participant list dropdown refresh after save | Complete |
| Minutes Fix | Debug logging for context documents and dictionary content | Complete |
| Folder Consolidation | All output folders nested under `AI-Organiser/` via resolver functions | Complete |

**Build Status**: 874 tests passing (39 suites)

**Key Files Modified:**
- `src/services/minutesService.ts` — Added `isUsableMarkdown()` method, debug logging for context docs/dictionary
- `src/utils/minutesUtils.ts` — Removed `aio_` prefix from all 17 frontmatter property names
- `src/ui/modals/MinutesCreationModal.ts` — Added `refreshParticipantListDropdown()` after save; use resolver imports
- `src/core/settings.ts` — 4 new resolver functions: `getMinutesOutputFullPath`, `getExportOutputFullPath`, `getFlashcardFullPath`, `getTranscriptFullPath`
- `src/commands/flashcardCommands.ts` — DRY folder resolution via resolver + `ensureFolderExists()`
- `src/commands/summarizeCommands.ts` — DRY folder resolution via resolver + `ensureFolderExists()`
- `src/ui/modals/ExportModal.ts` — Resolved export path via `getExportOutputFullPath()`
- `tests/minutesService.test.ts` — Updated assertions for clean property names

**Folder Structure (After):**
```
AI-Organiser/
├── Config/          # Taxonomy, personas, dictionaries
├── Exports/         # NotebookLM exports, note exports
├── Flashcards/      # Anki/Brainscape flashcards
├── Meetings/        # Meeting minutes output
├── NotebookLM/      # NotebookLM source packs
└── Transcripts/     # Audio/YouTube transcripts
```

Settings store subfolder names only (e.g., `Meetings`); resolver functions prepend the plugin folder at consumption time. Legacy full paths (e.g., `AI-Organiser/Meetings`) are tolerated without duplication.

---

### Command Picker Redesign Phase 2 & PDF Table Fix (2026-01-30)

**All Parts Complete**

| Part | Feature | Status |
|------|---------|--------|
| PDF Fix | Strip blockquote/callout prefixes in preprocessMarkdown for table detection | Complete |
| Phase 2 | Deeper command grouping: Highlight, Tags, Ask AI, Find Notes groups | Complete |
| Phase 2 | Rename Search+Analyze to Discover (5 categories, 7 groups) | Complete |
| Phase 2 | Move Manage Index to Bases group (Separation of Concerns) | Complete |

**Build Status**: 874 tests passing (39 suites)

**Key Files Modified:**
- `src/utils/markdownParser.ts` — Added `.replace(/^> ?/gm, '')` to strip blockquote prefixes
- `src/ui/modals/CommandPickerModal.ts` — Full restructure of `buildCommandCategories()`
- `src/i18n/types.ts` — Removed `categorySearch`/`categoryAnalyze`, added `categoryDiscover`, `groupHighlight`, `groupTags`, `groupAskAI`, `groupFindNotes`
- `src/i18n/en.ts`, `src/i18n/zh-cn.ts` — New translations for Discover, Highlight, Tags, Ask AI, Find Notes
- `tests/commandPicker.test.ts` — Rewritten for new 5-category structure with 7 sub-groups
- `tests/markdownPdfGenerator.test.ts` — 4 new tests for table rendering and callout handling

**Command Picker Structure (After):**
| Category | Top-level Items | Groups |
|----------|----------------|--------|
| Create (4) | Smart Summarize, Meeting Minutes, Export Note, Record Audio | — |
| Enhance (3) | Enhance Note, Translate, **Highlight** group | Highlight (2 sub) |
| Organize (2) | **Tags** group, **Bases** group | Tags (4 sub), Bases (4 sub incl. Manage Index) |
| Discover (2) | **Ask AI** group, **Find Notes** group | Ask AI (2 sub), Find Notes (3 sub) |
| Integrate (2) | **Pending** group, **NotebookLM** group | Pending (3 sub), NotebookLM (4 sub) |

**Design Rationale:**
- Tags group (Gestalt proximity): "I want to do something with tags" consolidates Tag/Clear/Network/Export
- Highlight group (inverse operation): Do/Undo on same feature reduces Enhance noise
- Search → Discover (reframing): AI-powered exploration, not Ctrl+F text matching
- Manage Index → Bases (SoC): Admin maintenance stays with infrastructure, not user-mode discovery

**Documentation**: `docs/completed/menu-plan.md` (archived)

---

### Preview Modal, Global LLM Busy Indicator & UX Polish (2026-01-30)

**All Parts Complete + 3 Review Rounds**

| Part | Feature | Status |
|------|---------|--------|
| Part 1 | Fix summary preview modal for all paths (text + PDF) | Complete |
| Part 2 | Global LLM busy indicator with ref counting | Complete |
| Review 1 | Spinner scoped to LLM only, not preview modal wait | Complete |
| Review 2 | YouTube chunks + traditional web path coverage gaps | Complete |
| Review 3 | Coverage audit: all 27 LLM call sites verified wrapped | Complete |
| UX Polish | Discard button warning signifier, pulse animation, keyframe DRY cleanup | Complete |
| Review 4 | 6 findings: reasoning model gating, debug guard, em dash, failure Notice, version, tests | Complete |

**Build Status**: 868 tests passing (39 suites)

**New Files Created:**
- `src/utils/busyIndicator.ts` — ref-counted show/hide/withBusyIndicator/reset + 400ms minimum display
- `tests/busyIndicator.test.ts` — 11 tests (ref counting, concurrent ops, null guard, minimum display, deferred hide)
- `tests/llmFacade.test.ts` — 6 tests (pluginContext, summarizeText, getServiceType)

**Key Files Modified:**
- `src/commands/summarizeCommands.ts` — insertTextSummary/insertPdfSummary preview modal; 12 withBusyIndicator wrappers scoped to LLM calls only
- `src/commands/translateCommands.ts` — withBusyIndicator + pluginContext
- `src/commands/smartNoteCommands.ts` — withBusyIndicator + pluginContext (3 calls)
- `src/commands/flashcardCommands.ts` — withBusyIndicator + pluginContext
- `src/commands/integrationCommands.ts` — withBusyIndicator + pluginContext
- `src/services/minutesService.ts` — withBusyIndicator + pluginContext
- `src/ui/modals/MinutesCreationModal.ts` — withBusyIndicator for dictionary extraction
- `src/ui/settings/ConfigurationSettingsSection.ts` — withBusyIndicator for 6 taxonomy suggestion calls
- `src/main.ts` — busyStatusBarEl init/cleanup, withBusyIndicator for analyzeAndTagNote
- `src/services/llmFacade.ts` — pluginContext() DRY helper
- `src/ui/modals/SummaryResultModal.ts` — Discard button .setWarning()
- `styles.css` — busy indicator CSS with pulse animation, namespaced @keyframes (DRY)
- `src/i18n/types.ts`, `en.ts`, `zh-cn.ts` — aiProcessing, summaryCombinedFromSections
- `src/services/cloudService.ts` — reasoning model gating by model name (not adapter type), debug logging guard, em dash fix
- `tests/cloudService.defaults.test.ts` — 3 new tests for reasoning model request body

**Key Design Decisions:**
- Spinner scoped to LLM calls only — preview modal (user action) does not hold spinner
- Ref counting handles concurrent LLM operations (show on first, hide when all complete)
- Chunked flows wrapped at outer level to prevent flicker
- Chat commands intentionally excluded (have own persistent Notice indicator)
- Minimum 400ms display duration ensures spinner is visible even for fast LLM responses (e.g., tagging)
- Namespaced CSS keyframes: `ai-organiser-spin`, `ai-organiser-pulse`, `related-notes-spin`
- Reasoning model detection by model name prefix (gpt-5, o1, o3), not adapter type — works across OpenRouter/Groq/DeepSeek
- Multi-source failure Notice fires on discard (not only on insert)

**Documentation**: `docs/completed/wirr-plan.md`

---

### Menu Cleanup & Integration Enhancement (2026-01-29)

✅ **All 5 Parts + Review Fixes Complete**

| Part | Feature | Status |
|------|---------|--------|
| Part 1 | Remove redundant `generate-from-embedded` command | ✅ Complete |
| Part 2 | Enhanced integration: placement/format/detail dropdowns + auto-tag | ✅ Complete |
| Part 3 | Translate note: insert-at-cursor toggle | ✅ Complete |
| Part 4 | Shared `editorUtils.ts` (DRY insertion utility) | ✅ Complete |
| Part 5 | Summary result preview modal (insert/copy/discard) | ✅ Complete |
| Review | 8 findings fixed (modal Promise leak, metadata gating, stale buffer, CSS, i18n, regex, DRY extraction, tests) | ✅ Complete |

**Build Status**: 848 tests passing (37 suites) ✅

**New Files Created:**
- `src/utils/editorUtils.ts` — `insertAtCursor()`, `appendAsNewSections()`
- `src/services/prompts/integrationPrompts.ts` — placement/format/detail prompt helpers
- `src/ui/modals/SummaryResultModal.ts` — markdown preview with insert/copy/discard
- `tests/integrationPrompts.test.ts` — 16 tests (helpers + buildIntegrationPrompt)
- `tests/editorUtils.test.ts` — 7 tests (cursor insert, section append, edge cases)

**Files Deleted:**
- `src/ui/modals/ContentSelectionModal.ts` — orphaned by Part 1 removal

**Key Files Modified:**
- `src/commands/integrationCommands.ts` — modal dropdowns, prompt builder, placement branching
- `src/commands/summarizeCommands.ts` — async insert functions with preview modal, DRY `showSummaryPreviewOrInsert()` helper
- `src/commands/translateCommands.ts` — insert-at-cursor support
- `src/ui/modals/TranslateModal.ts` — toggle UI
- `src/core/constants.ts` — `PlacementStrategy`, `FormatStrategy`, `DetailStrategy` types + defaults
- `styles.css` — scrollable `.ai-organiser-summary-preview` (max-height 50vh)
- i18n files — 20+ new keys (integration dropdowns, translate toggle, summary modal, copiedToClipboard)

**Review Fixes Applied:**
- Modal ESC/X now fires `'discard'` action (no hanging Promise)
- Structured web summary metadata gated on `action === 'cursor'` only
- Auto-tag uses `editor.getValue()` instead of disk read (fresh buffer)
- Preview modal scrollable via CSS (`.ai-organiser-summary-preview`)
- `copiedToClipboard` i18n key replaces hardcoded notice
- `appendAsNewSections` regex matches `## References` at file start
- 3× duplicated preview block extracted to `showSummaryPreviewOrInsert()`

**Documentation**: `docs/completed/menu-plan.md`

---

### Multi-Source Translation Feature Complete (2026-01-29)

✅ **All 3 Phases + 2 Review Rounds Complete**

| Phase | Feature | Status |
|-------|---------|--------|
| Phase 1 | Multi-Source Translation | ✅ Complete |
| Phase 2 | Wikilink Source Cleanup | ✅ Complete |
| Phase 3 | External PDF URL Download | ✅ Complete |
| Review Round 2 | 3 code fixes (double-wrap, document type, YouTube title) | ✅ Complete |
| Review Round 3 | 4 doc fixes (plan consistency) | ✅ Complete |

**Build Status**: 825 tests passing (35 suites) ✅

**New Files Created:**
- `src/services/apiKeyHelpers.ts` — shared API key resolution (YouTube Gemini, audio transcription)
- `src/services/pdfTranslationService.ts` — shared PDF provider config + multimodal translation
- `tests/pdfService.test.ts` — 11 tests for external PDF URL download

**Key Files Modified:**
- `src/commands/translateCommands.ts` — smart dispatch, multi-source orchestrator, sequential processing
- `src/ui/modals/MultiSourceModal.ts` — parameterized for translate mode (language selector, CTA)
- `src/services/pdfService.ts` — URL download support for external PDFs (HTTPS, 20MB limit)
- `src/utils/sourceDetection.ts` — wikilink cleanup in `removeProcessedSources()`
- `src/utils/noteStructure.ts` — added `'document'` SourceType
- `src/services/prompts/translatePrompts.ts` — source context (type, title) for better translations
- `src/i18n/types.ts`, `en.ts`, `zh-cn.ts` — translate modal + message keys

**Feature Summary:**
- Smart dispatch: selection → translate selection; no selection + sources → multi-source modal; no selection + no sources → translate note
- Multi-source modal reuse: parameterized existing `MultiSourceModal` with translate mode config
- Source types: URLs, YouTube, PDFs (vault + external), documents, audio
- Sequential processing with per-source progress notices
- Error isolation: failed sources don't block others
- Privacy consent gating before external fetch
- Content chunking for large sources via `chunkContent()` + `getMaxContentChars()`
- Wikilink cleanup after processing (cross-cutting fix for summarize + translate)
- External PDF download via Obsidian `requestUrl` (cross-cutting fix)

**Documentation**: `docs/completed/translate-plan.md`

---

### Obsidian API Upgrade Complete - Ready for Signoff (2026-01-27)

✅ **All Three Phases Implemented and Tested**

| Phase | Feature | Status | Tests |
|-------|---------|--------|-------|
| Phase 1 | SecretStorage | ✅ Complete | 32 tests |
| Phase 2 | SettingGroup | ✅ Complete | No regressions |
| Phase 3 | Bases Service | ✅ Complete | 4 tests |

**Build Status**: 802 tests passing ✅

**Documentation**:
- `docs/API-UPGRADE-REFERENCE.md`: Quick reference for developers (keep)
- `docs/api-plan.md`: Planning document (can archive)
- `docs/api-upgrade-summary.md`: Implementation summary (can archive)
- `docs/usertest.md`: Updated with SecretStorage manual tests

**Test Fix (2026-01-27)**:
- Fixed dashboardService.test.ts: Added `basesService` mock to plugin mock object
- All 802 tests now pass (was 793 before fix)

**Next Steps**:
- Manual testing on Obsidian 1.11+ for SecretStorage verification
- Version bump to 1.0.16
- Deploy to Obsidian vault

---

### SettingGroup Phase 2 Complete (2026-01-27)

✅ **Obsidian 1.11+ SettingGroup Native Integration**
- **Updated File** (40 lines):
  - `src/ui/settings/BaseSettingSection.ts`: Added SettingGroup wrapper with fallback

- **Key Features**:
  - Detects SettingGroup API availability (Obsidian 1.11+)
  - Uses native SettingGroup for h1 headers when available
  - Falls back to custom headers for h2 or older Obsidian versions
  - Zero breaking changes - all existing sections work unchanged
  - Progressive enhancement - native API auto-used when available

- **Test Results**: 802 tests pass ✅ (no new tests added, verified backward compatibility)

**Implementation Details**:
- `isSettingGroupAvailable()`: Safely detects SettingGroup in Obsidian module
- `createNativeSettingGroup()`: Wraps SettingGroup with icon and title
- `createCustomHeader()`: Existing fallback implementation preserved
- `createSectionHeader()`: Router logic selects native vs fallback
- Non-breaking: All existing section classes work without modification

**Gestalt UI Principles Preserved**:
- Proximity: Same grouped settings structure
- Similarity: Same h1/h2 visual hierarchy (native SettingGroup maintains this)
- Common Region: Same section containers
- Continuity: Same logical flow through settings

### Phase 6 Implementation Verified (2026-01-27)

✅ **All 5 Settings Sections Now Using renderApiKeyField()**
- `LLMSettingsSection.ts`: Uses renderApiKeyField() for cloud API key
- `SemanticSearchSettingsSection.ts`: Uses renderApiKeyField() with fallback
- `YouTubeSettingsSection.ts`: Uses renderApiKeyField() for Gemini key
- `PDFSettingsSection.ts`: Uses renderApiKeyField() with provider selection
- `AudioTranscriptionSettingsSection.ts`: Uses renderApiKeyField() for audio keys

**Phase 6 Complete**: All API key fields now unified through renderApiKeyField() helper

### SecretStorage Phase 1 Complete (2026-01-27)

✅ **Obsidian SecretStorage Integration (API v1.11+)**
- **New Files Created** (555 lines total):
  - `src/core/secretIds.ts`: Standard/plugin-specific secret IDs with 10 provider mappings
  - `src/services/secretStorageService.ts`: Full service with 4-step key resolution chain
  - `src/ui/modals/MigrationConfirmModal.ts`: User confirmation with device-specific warnings
  - `tests/mocks/mockSecretStorage.ts`: In-memory mock for CI/CD
  - `tests/secretStorageService.test.ts`: 32 comprehensive tests

- **Files Updated** (6 files):
  - Settings, services, main plugin, UI helpers, i18n (19 strings), CSS styles

- **Key Features**:
  - Cross-plugin key sharing (standard secret IDs)
  - 4-step inheritance chain: plugin → provider → main → fallback
  - User-initiated migration with device-specific warnings
  - Backward compatible (pre-1.11 uses plain-text fallback)

- **Test Results**: 802 tests pass ✅ (32 new SecretStorage + 770 existing)

### Audit Fixes Complete (2026-01-27)

✅ **Command Picker i18n Audit**
- Replaced all hardcoded UI strings with i18n keys
- Added 10 new translation keys (`modals.commandPicker.*`)
- Category names now localized: Create, Enhance, Organize, Search, Analyze, Integrate
- Command names use existing `t.commands.*` keys
- Arrow characters (↑↓, ↵) confirmed as valid Unicode

✅ **New Test Coverage**
- `tests/commandPicker.test.ts`: 12 integration tests for categories and commands
- `tests/sourcePackService.test.ts`: 5 settings-to-SourcePackConfig wiring tests
- **Total: 766 tests across 30 suites** (17 new tests added)

### Summarization Testing Complete (2026-01-26)

✅ **Section 4: Summarization - All Tests Passed**
- URL Summarization: Source detection, summary insertion, metadata
- YouTube Summarization: Gemini-native video processing, transcript saving
- PDF Summarization: Vault and external PDF handling
- Audio Summarization: Transcription via Whisper, transcript saving
- Multi-Source Summarization: Combined sources with oversized handling

**DRY/SOLID Refactoring Applied**:
- `transcribeAudioWithFullWorkflow()`: Unified audio function (chunked >20min, compressed >25MB, direct)
- `summarizePdfWithFullWorkflow()`: Unified PDF function (vault + external handling)
- Both multi-source and standalone handlers now use same encapsulated functions
- Removed ~150 lines of duplicate code

### Manual Testing Started (2026-01-26)

✅ **Pre-Test Checklist Complete**
- Build: `npm run build:quick` passes (3.0 MB, 79ms)
- Deployment: Files deployed to Obsidian plugin folder
- Status: Plugin ready for manual smoke test

**Sections Completed**:
- ✅ Pre-Test
- ✅ Settings UI
- ✅ Command Picker
- ✅ Tagging
- ✅ Summarization

**Next Steps**: Testing Translation → Smart Notes → Meeting Minutes

---

### Hardcoding Remediation Complete (2026-01-26)

### Hardcoding Remediation Complete (2026-01-26)

✅ **All 4 Phases Delivered**

| Phase | Scope | Outcome |
|-------|-------|---------|
| 1. Path Resolution | P0 | Centralized folder helpers with legacy path tolerance |
| 2. Constants | P1 | `SUMMARY_HOOK_MAX_LENGTH`, `CHUNK_TOKEN_LIMIT` unified |
| 3. Provider Registry | P1 | 14 LLM adapters with single-source defaults/endpoints |
| 4. Service Defaults | P1 | Embedding registry, audio transcription registry |

**Key Achievements**:
- **Path drift eliminated**: All folder-sensitive flows honor `pluginFolder` with legacy full-path tolerance
- **Provider registry**: `providerRegistry.ts` drives dropdowns, defaults, endpoints for all 14 adapters
- **Embedding registry**: `embeddingRegistry.ts` with 6 providers, model lists, UI-friendly labels
- **Build separation**: `tsconfig.build.json` for source-only type checking (test types isolated)
- **Test coverage**: 766 tests across 30 suites (87 new tests added during remediation)

### Testing Strategy Complete (2026-01-25)

✅ **All Three Testing Gaps Closed**

| Gap | Tests | Coverage | Status |
|-----|-------|----------|--------|
| MinutesService | 23 | 100% statements, 80.7% branches | ✅ Complete |
| Prompt Modules | 72 | 80.57% module coverage | ✅ Complete |
| RAG/Embeddings | 19 | ~75% RAGService coverage | ✅ Complete |

**Final Test Suite**: 631 tests across 23 test files (~48% overall coverage)

**Key Achievements**:
- MinutesService: Full coverage of chunked/non-chunked paths, language fallback, deduplication
- Prompt Modules: Invariant-based tests (no brittle snapshots) for all 8 prompt builders
- RAGService: Deterministic tests with TestVectorStore mock (no network calls)

See [usertest.md](usertest.md) for manual testing checklist.

### UX/UI Refactoring Complete (2026-01-25)

✅ **All 5 Phases Delivered**

| Phase | Priority | Achievement |
|-------|----------|-------------|
| 1. Command Picker | P0 | Expanded from 13 to 29 commands with category styling |
| 2. i18n Core | P0 | 24 keys added, chatCommands/integrationCommands converted |
| 3. i18n Summarize | P1 | 20 hard-coded notices replaced with plugin.t |
| 4. RAG Options Gating | P1 | RAG settings hidden when vault chat disabled |
| 5. Browser Prompt | P1 | Replaced prompt() with in-modal folder input |

**Metrics**:
- 40 new i18n keys added (with dynamic placeholders)
- 38+ hard-coded notices converted (72% of high-priority areas)
- Command picker coverage: 13 → 29 commands (123% increase)
- All tests passing (631 unit + 17 integration)

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
│   ├── settings/              # 11 settings sections
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
| **Summarization** | URL, PDF, YouTube, Audio | 5 personas, RAG-enhanced, Gemini-native YouTube, 6hr+ audio chunking |
| **Audio Recording** | Record Audio | In-plugin recording, auto-transcribe, mobile-safe, 64kbps |
| **Meeting Minutes** | Create meeting minutes | Persona-based, transcript chunking, Obsidian Tasks |
| **Smart Notes** | Improve, Find resources, Diagrams | AI personas, Mermaid support |
| **Translation** | Note, Selection, Multi-Source | 20+ languages, URL/YouTube/PDF/audio/document sources |
| **Semantic Search** | Search, Index, Related notes | Voy WASM, 5 embedding providers |
| **NotebookLM** | Export, Toggle, Clear, Open folder | Sanitized source packs, modular export |
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
5. **YouTube** - Gemini API key (auto-inherits), model selection
6. **Audio Transcription** - Provider (OpenAI/Groq), API key (auto-inherits)
7. **Semantic Search** - Embeddings, indexing, RAG options
8. **Obsidian Bases** - Structured metadata, migration, dashboards
9. **NotebookLM** - Export settings, sanitisation, module word budget
10. **Mobile** - Provider fallback, vector store guards
11. **Configuration** - Config folder, taxonomy files

---

## Configuration Files

All plugin files under `AI-Organiser/` (configurable):

```
AI-Organiser/
├── Canvas/                   # Investigation, Context, Cluster boards
├── Chats/                    # Exported chat conversations
├── Config/
│   ├── taxonomy.md           # Tagging themes/disciplines
│   ├── excluded-tags.md      # Tags to never suggest
│   ├── writing-personas.md   # Note improvement personas
│   ├── summary-personas.md   # Summarization personas
│   ├── minutes-personas.md   # Meeting minutes personas
│   ├── bases-templates.md    # Obsidian Bases dashboard templates
│   └── dictionaries/         # Terminology dictionaries (syncs across devices)
├── Exports/                  # NotebookLM exports, note exports
├── Flashcards/               # Exported flashcards
├── Meetings/                 # Meeting minutes output
│   └── participants/         # Reusable participant lists
├── NotebookLM/               # NotebookLM source packs
├── Recordings/               # Audio recordings
└── Transcripts/              # Audio/YouTube transcripts
```

---

## Recent Updates (January 2026)

### Document Extraction & Multi-Feature Enhancements (January 24)
- **Centralized Document Extensions**: Single source of truth in `constants.ts`
  - `EXTRACTABLE_DOCUMENT_EXTENSIONS`: docx, xlsx, pptx, txt, rtf
  - `ALL_DOCUMENT_EXTENSIONS`: Includes PDF
  - Used consistently across detection, extraction, and pickers
- **Document Extraction Service Enhancements**:
  - TXT extraction (direct file read)
  - RTF extraction with hex/unicode decode and readability validation
  - External document URL download (HTTPS only) with progress feedback
  - Error handling for network failures and complex RTF formats
- **Minutes Truncation UX** (inline controls following Gestalt proximity):
  - Inline dropdown per oversized document (Truncate/Use Full/Exclude)
  - Bulk "Apply to all" action positioned above document list
  - Settings: `maxDocumentChars` (default 50000), `oversizedDocumentBehavior` (ask/truncate/full)
  - Accessibility: aria-labels, touch-friendly inline warnings
- **Multi-Source Document Support**:
  - Documents section added between PDFs and Audio
  - Vault and external URL document detection
  - Settings: `multiSourceMaxDocumentChars` (100000), `multiSourceOversizedBehavior` (full)
  - Truncation confirmation modal for oversized documents
- **NotebookLM Linked Documents**: Detection and display of linked documents in export preview
- **Pending Integration Enhancement**: Optional "Resolve pending embeds" command
  - Extracts text from embedded documents/PDFs in Pending Integration section
  - Replaces embed syntax with extracted content for review before integration
- **Terminology Dictionary System**: Improve transcription accuracy with reusable dictionaries
  - `DictionaryService` for CRUD operations on terminology dictionaries
  - Dictionaries stored as markdown in `AI-Organiser/Config/dictionaries/` (syncs across devices)
  - Entry categories: person, acronym, term, project, organization
  - LLM-powered extraction from context documents (agendas, presentations)
  - Case-insensitive deduplication when adding entries across meetings
  - Dictionary content injected into prompts for consistent name/term usage
- **i18n**: 84+ new translation strings across EN + ZH-CN
- **SOLID/DRY Refactoring** (Controller Extraction):
  - **DocumentHandlingController**: Extracted document detection, extraction, caching, truncation (23 tests)
  - **DictionaryController**: Extracted dictionary CRUD, term extraction, merging (56 tests)
  - **AudioController**: Extracted audio detection and transcription state (35 tests)
  - **TruncationControls**: Reusable UI components for document truncation (8 tests)
  - Centralized `DEFAULT_MAX_DOCUMENT_CHARS` (50000) and `DEFAULT_MULTI_SOURCE_MAX_DOCUMENT_CHARS` (100000) constants
  - Added `TruncationChoice` and `OversizedBehavior` type aliases
  - Created unified `getTruncationOptions()` for DRY label/tooltip handling
  - Added `MinutesModalDependencies` interface for dependency injection
  - Modal services now support optional DI for testability
  - **No-stubs policy**: All public methods fully implemented with call sites (modal or tests)
  - **631 total tests** (including controller, utility, and prompt invariant tests)
- **Utility Testing Expansion** (238 new tests):
  - `responseParser.test.ts` (40 tests): 4-tier JSON extraction, summary hook sanitization, content type validation
  - `textChunker.test.ts` (30 tests): Transcript chunking, overlap handling, segment-based chunking
  - `sourceDetection.test.ts` (58 tests): URL/YouTube/PDF/audio detection, vault links, section context
  - `frontmatterUtils.test.ts` (45 tests): Summary hook creation, word counting, CJK language detection
  - `dashboardService.test.ts` (23 tests): Filter injection, folder paths, YAML preservation
  - `minutesPrompts.test.ts` (42 tests): Prompt generation, response parsing, JSON repair
  - Fixed `textChunker.ts` bug where `overlapChars: 0` was treated as "use default 400"

### Meeting Minutes & Bug Fixes (January 23)
- **Meeting Minutes Generation**: New feature for structured meeting notes
  - MinutesCreationModal with comprehensive meeting input fields
  - MinutesService with transcript chunking for long meetings (5000 token chunks)
  - Persona-based output styles via `minutes-personas.md` config file
  - Obsidian Tasks format support (`- [ ]` tasks below minutes)
  - Dual output option (internal + public versions)
  - Full i18n support (EN + ZH-CN)
  - New settings section for output folder, timezone, default persona
- **Bug Fixes**:
  - Fixed Enhance actions silently failing (async error handling in all modals)
  - Fixed duplicate References/Pending Integration sections (idempotent detection with case-insensitive matching)
  - Fixed folder suggestions ignoring selected root folder (now respects folder scope)
  - Fixed translation adding unwanted formatting (explicit preserve-only instruction)

### YouTube & Audio Processing (January 23)
- **YouTube**: Switched to Gemini-native video understanding (no more transcript scraping)
  - Gemini processes YouTube URLs directly via native video API
  - Falls back to transcript scraping only if Gemini unavailable
  - Dedicated YouTube settings section with model selection
  - Auto-inherits Gemini API key from main provider settings
- **Audio Transcription**: Now supports 6+ hour recordings with chunked processing
  - Automatic chunking for files > 20 minutes (5-minute segments)
  - Context chaining between chunks for seamless transcription
  - Extended timeouts: FFmpeg (60 min), compress+split (2 hr), API (10 min/chunk)
  - Dedicated Audio Transcription settings section
  - Auto-inherits OpenAI/Groq API key from main provider settings
  - Progress notifications: "Transcribing chunk 4/24 (17%)"

### Multi-Source Summarization (January 22)
- Persona selection in multi-source modal
- Source processing status checklist
- Summary placement fixed (before references, not after)

### Language & UX Audit
- Rewrote all UI text for clarity and brevity
- Applied American English consistently
- Removed support section from settings
- Updated command names for conciseness

### Command Consolidation (Implemented)
- Consolidated 27 commands to 12 using Smart Dispatcher pattern (56% reduction)
- Context-aware detection eliminates "Click Tax"
- Smart dispatchers for Summarize, Translate, Tag, Clear Tags, Enhance

### Mobile Optimization (Implemented)
- Tri-state provider fallback (auto/cloud-only/custom)
- Vector store size guards with lazy loading
- UI adaptations (Tag Network list, Related Notes modal)
- Vault-only file pickers on mobile
- Network hardening (60s timeouts, data warnings)
- Mobile settings section in plugin settings

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

### NotebookLM Integration (New)
- Export Obsidian notes as sanitized source packs for NotebookLM
- 8-step sanitisation pipeline (frontmatter, dataview, callouts, embeds, links, images, plugin noise)
- 3 export modes: auto, modular (split by word budget), single file
- Cycle detection for embedded notes
- Revision management with automatic changelog generation
- Stable anchors with short IDs for NotebookLM citations
- Post-export tag actions (keep/clear/archive)
- Full i18n support (EN/ZH-CN)

### Obsidian Bases Integration (Completed January 2025)
- Structured metadata system (10 clean-name properties: `summary`, `status`, `type`, `processed`, `model`, `source`, `source_url`, `word_count`, `language`, `persona`)
- 4-stage migration wizard with smart content detection
- 10 built-in dashboard templates (.base files) in 2 categories:
  - 5 default templates (Knowledge Base, Research Tracker, etc.)
  - 5 persona templates (Student, Executive, Casual, Researcher, Technical)
- Persona tracking: `persona` written to frontmatter during summarization
- Conditional structured output in summarization
- Complete bilingual support (EN/ZH-CN)
- Settings section with migration and dashboard creation buttons

---

## Build & Test

```bash
npm run dev        # Development (watch mode)
npm run build      # Production build (includes tests)
npm run build:quick # Production build (source type-check only)
npm test           # Run 1108+ unit tests (54+ suites)
npm run test:auto  # Run 17 automated integration tests
```

**Deploy:** Copy `main.js`, `manifest.json`, `styles.css` to Obsidian plugins folder.

**Testing:** See [usertest.md](usertest.md) for manual test checklist.

---

## Known Limitations

1. Interface language change requires Obsidian restart
2. PDF summarization only with Claude/Gemini (multimodal)
3. Audio transcription requires OpenAI or Groq API key (auto-inherits from main provider)
4. Claude/Anthropic has no embeddings API (use Voyage AI)
5. YouTube processing requires Gemini API key (auto-inherits from main provider)
6. Audio chunking requires FFmpeg installed on system

---

## Repository

- **GitHub:** [Lbstrydom/ai-organiser](https://github.com/Lbstrydom/ai-organiser)
- **Author:** L Strydom
