# Plan: Searchable Chat History + Nested Sub-Projects

- **Date**: 2026-04-07
- **Status**: Draft
- **Author**: Claude + Louis

---

## 1. Current UI Audit

### What exists today

**Conversation persistence**: Conversations are saved as vault `.md` files with frontmatter (tags, mode, project_id, created date) + readable message history + base64-encoded JSON state blob (`<!-- chat-state-b64:... -->`). Organized by mode under `AI Chat/Conversations/{mode}/` or under project folders at `AI Chat/Projects/{slug}/`.

**Project system**: Flat hierarchy. Each project has a `_project.md` with YAML frontmatter + sections for Instructions, Memory, Pinned Files, and Indexed Documents. Projects live at `AI Chat/Projects/{slug}/`. `listProjects()` scans this folder for subdirectories.

**Resume picker**: `ChatResumePickerModal` shows the 5 most recent conversations + all projects. No search, no filtering. Arrow key navigation + Enter to select. Projects show conversation counts.

**Project dropdown**: Menu-based (`Menu` from Obsidian API) triggered from a button in the chat header. Lists all projects flat, with "New project" and "Leave project" options.

### Design language

- Chat messages: `ai-organiser-chat-msg` with user/assistant/system variants
- Mode tabs: `ai-organiser-chat-mode-tab` with active state
- Project badge: `ai-organiser-free-chat-project-badge` (small accent text)
- Attachment pills: `ai-organiser-free-chat-att-pill` (bordered, rounded)
- Resume picker: `ai-organiser-resume-*` classes (section headers, rows, dividers)

### Pain points

1. **No way to find old conversations** — only 5 recent shown, no search
2. **Project list will balloon** — 20+ projects make the dropdown unusable
3. **No conversation preview** — resume picker shows title but no context
4. **No bulk operations** — can't delete/archive multiple conversations
5. **Project creation is modal-deep** — must go through resume picker to create

---

## 2. User Flow & Wireframe

### Feature A: Searchable Chat History

**Entry point**: New "Search chats" icon button in the chat header bar, next to the project dropdown.

```
┌─────────────────────────────────────────────────┐
│ [Free ▾] [Research] [Slides]  [🔍] [📁 Project ▾] │  ← search icon added
├─────────────────────────────────────────────────┤
│                                                 │
│  Search chats modal opens:                      │
│                                                 │
│ ┌─────────────────────────────────────────────┐ │
│ │ 🔍 Search conversations...          [×]     │ │
│ ├─────────────────────────────────────────────┤ │
│ │ Filters: [All modes ▾] [All projects ▾]     │ │
│ │          [Any time ▾]                       │ │
│ ├─────────────────────────────────────────────┤ │
│ │ ┌─────────────────────────────────────────┐ │ │
│ │ │ 📄 Budget planning discussion           │ │ │
│ │ │    free · Work > Q2 · 2d ago · 12 msgs  │ │ │
│ │ │    "...we should allocate 30% to the..." │ │ │
│ │ ├─────────────────────────────────────────┤ │ │
│ │ │ 🔬 Market research: competitor analysis  │ │ │
│ │ │    research · 5d ago · 8 msgs            │ │ │
│ │ │    "...their pricing model is based..." │ │ │
│ │ ├─────────────────────────────────────────┤ │ │
│ │ │ 🎯 Q1 results presentation               │ │ │
│ │ │    slides · Work > Q1 · 1w ago · 3 msgs │ │ │
│ │ │    "...revenue grew 15% driven by..."   │ │ │
│ │ └─────────────────────────────────────────┘ │ │
│ │                                             │ │
│ │ Showing 3 of 47 conversations               │ │
│ └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

**Flow**:
1. User clicks search icon → `ChatSearchModal` opens
2. Type query → debounced 300ms → scans conversation files
3. Results show: icon per mode, title, project breadcrumb, age, message count, excerpt
4. Click result → modal closes, conversation loads in UnifiedChatModal
5. Filter dropdowns for mode (all/free/research/slides/etc.), project, time range

### Feature B: Nested Sub-Projects

**Entry point**: Enhanced project dropdown with tree structure.

```
┌──────────────────────────────────┐
│ 📁 Projects                     │
│ ├── 📁 Work                     │
│ │   ├── 📁 Q1 Planning          │
│ │   │   ├── 📄 Budget (3 chats) │
│ │   │   └── 📄 Timeline (1)     │
│ │   └── 📁 Q2 Planning          │
│ │       └── 📄 Goals (2)        │
│ ├── 📁 Personal                 │
│ │   └── 📄 Reading list (5)     │
│ └── 📄 Quick notes (8)          │
│                                  │
│ ─────────────────────────────── │
│ [+ New project]  [+ New group]  │
└──────────────────────────────────┘
```

**Flow**:
1. User clicks project dropdown → enhanced tree menu appears
2. Groups (folders) expand/collapse inline
3. Click a project → enters that project context
4. "New group" creates a folder-only container (no `_project.md`)
5. "New project" prompts for name + optional parent group
6. Drag-and-drop to rearrange (desktop only, deferred)

**Folder structure**:
```
AI Chat/Projects/
├── work/                          ← group (no _project.md)
│   ├── q1-planning/               ← group
│   │   ├── budget/                ← project
│   │   │   ├── _project.md
│   │   │   └── conversations...
│   │   └── timeline/              ← project
│   │       └── _project.md
│   └── q2-planning/
│       └── goals/
│           └── _project.md
├── personal/                      ← group
│   └── reading-list/
│       └── _project.md
└── quick-notes/                   ← project (root-level)
    └── _project.md
```

**Distinction**: A folder is a **group** if it has NO `_project.md`. It's a **project** if it does. Groups are pure organizational containers.

---

## 3. UX Design Decisions

### Search (Principles: #14 Recognition > Recall, #7 Flexibility, #11 Feedback)

- **Full-text search** across conversation content, not just titles — users remember what they discussed, not what they named the chat (#14)
- **Excerpt highlighting** shows matching text in context — immediate visual feedback (#11)
- **Filters as progressive disclosure** — mode/project/time dropdowns collapsed by default, revealed on demand (#13)
- **Debounced input** at 300ms — responsive without over-querying (#39)
- **Result count** shown — user knows scope of results (#1 Nielsen: visibility of status)

### Sub-projects (Principles: #15 Hick's Law, #9 User Logic, #6 Common Region)

- **Tree structure** matches how users organize work mentally — hierarchical, not flat (#9)
- **Groups reduce choices** — instead of 20 projects, user sees 3-4 top-level groups (#15)
- **Visual indent + icons** create clear containment (#6 Common Region)
- **Groups are just folders** — no metadata, no configuration, minimal overhead (#8 Aesthetic/minimalist)
- **Backward compatible** — existing flat projects become root-level entries, no migration needed

### Accessibility

- Keyboard navigation: Arrow keys for tree, Tab for search filters (#19)
- ARIA tree role on project dropdown, treeitem on each entry (#20)
- Search results use `role="listbox"` with `aria-selected` (#20)
- Focus management: search input focused on modal open, focus returns on close (#22)

---

## 4. Technical Architecture

### Feature A: Chat Search

```
ChatSearchModal (new Modal)
  │
  ├─→ ChatSearchService (new)
  │     ├── searchConversations(query, filters) → SearchResult[]
  │     ├── readConversationContent(path) → string (cached)
  │     └── buildSearchIndex() → in-memory Map (lazy, per-session)
  │
  ├─→ ConversationPersistenceService (existing)
  │     └── listRecent(limit=999) → ConversationSummary[]
  │
  └─→ UnifiedChatModal (callback)
        └── loadConversation(filePath) → restores state
```

**Search strategy**: No vector/embedding search (overkill for local files). Use Obsidian's `vault.cachedRead()` + regex matching. Build a lightweight in-memory index on first search:

1. `listRecent(999)` gets all conversation metadata
2. On first query, lazy-read file content via `cachedRead()`
3. Match against: title, message content, project name
4. Cache file content for duration of modal (cleared on close)
5. Filter by mode, project, date range client-side

### Feature B: Nested Projects

```
ProjectService (modified)
  ├── listProjectTree() → ProjectTreeNode[]     ← NEW
  │     ├── recursively scan Projects/ folder
  │     ├── folders with _project.md → project nodes
  │     └── folders without → group nodes
  │
  ├── createProject(name, parentPath?) → id     ← MODIFIED
  │     └── parentPath enables nesting
  │
  ├── createGroup(name, parentPath?) → path     ← NEW
  │     └── creates folder only, no _project.md
  │
  ├── moveProject(projectId, newParentPath)     ← NEW
  │
  └── listProjects() → ProjectConfig[]          ← UNCHANGED (flat list for compat)

ProjectTreeNode (new type):
  ├── type: 'project' | 'group'
  ├── name: string
  ├── path: string
  ├── children: ProjectTreeNode[]
  ├── project?: ProjectConfig (if type=project)
  └── conversationCount?: number
```

**Backward compatibility**: `listProjects()` continues to return a flat list (used by resume picker, prompt building, etc.). New `listProjectTree()` returns hierarchical structure for the dropdown UI. Existing root-level projects work unchanged.

---

## 5. State Map

### ChatSearchModal

| State | Visual |
|-------|--------|
| Empty (no query) | "Search your conversations" hint text, recent 5 shown |
| Loading | "Searching..." with subtle spinner in input |
| Results | Result cards with excerpts, count badge |
| No results | "No conversations found" with suggestion to try different terms |
| Error | "Could not search: {reason}" |
| Filtered | Active filter pills shown, count updated |

### Project Tree Dropdown

| State | Visual |
|-------|--------|
| Empty (no projects) | "No projects yet" with "Create project" button |
| Collapsed groups | Group names with chevron, project counts |
| Expanded group | Children visible, indented |
| Active project | Bold name, check icon |
| Loading | Brief spinner during project scan |

---

## 6. File-Level Plan

### New Files

| File | Purpose | Key exports |
|------|---------|-------------|
| `src/services/chat/chatSearchService.ts` | Search engine for conversation files | `ChatSearchService`, `SearchResult`, `SearchFilters` |
| `src/ui/modals/ChatSearchModal.ts` | Search UI modal | `ChatSearchModal` |
| `tests/chatSearchService.test.ts` | Search logic tests | ~20 tests |
| `tests/projectTree.test.ts` | Tree building + nesting tests | ~15 tests |

### Modified Files

| File | Changes |
|------|---------|
| `src/services/chat/projectService.ts` | Add `listProjectTree()`, `createGroup()`, `moveProject()`, modify `createProject()` for `parentPath` |
| `src/ui/modals/UnifiedChatModal.ts` | Add search button in header, replace flat project menu with tree |
| `src/ui/modals/ChatResumePickerModal.ts` | Use tree structure for project section |
| `src/i18n/en.ts` | ~25 new strings for search UI + project tree |
| `src/i18n/zh-cn.ts` | Chinese translations |
| `styles.css` | Search modal + tree dropdown styles |

---

## 7. Risk & Trade-off Register

| Risk | Mitigation | Severity |
|------|-----------|----------|
| Full-text search slow on 1000+ conversations | Lazy loading + content caching + abort on new query | MEDIUM |
| Deep nesting confuses users | Limit to 3 levels (group > group > project) | LOW |
| Group vs project distinction unclear | Different icons (folder vs briefcase), tooltip explains | LOW |
| Mobile: tree dropdown too deep | Collapse to breadcrumb-style on mobile | MEDIUM |
| Existing projects don't break | `listProjects()` unchanged, tree is additive | NONE |
| Base64 state blob slows search | Search readable content only, skip state blob | LOW |

### Deliberate deferrals

- **Drag-and-drop reordering** — complex touch handling, defer
- **Conversation export** — export search results as notes, defer
- **Semantic search** — embedding-based search across conversations, defer (could use existing RAG)
- **Conversation tags/labels** — manual categorization, defer
- **Bulk delete/archive** — multi-select operations, defer

---

## 8. Testing Strategy

### Unit tests

| Test file | Coverage | Count |
|-----------|----------|-------|
| `chatSearchService.test.ts` | Query matching, excerpt extraction, filter application, date range, caching, empty results | ~20 |
| `projectTree.test.ts` | Tree building from folder structure, group vs project detection, nesting depth limit, backward compat with flat projects, createGroup, moveProject | ~15 |

### Manual testing checklist

- [ ] Search by keyword across 50+ conversations — results appear within 500ms
- [ ] Filter by mode (free/research/slides) — only matching mode shown
- [ ] Filter by project — breadcrumb shows in results
- [ ] Filter by time range (past week/month/all) — correct filtering
- [ ] Click search result — conversation loads correctly in chat modal
- [ ] Create nested project: Work > Q2 > Budget — folder structure correct
- [ ] Create group, then project inside it — both appear in tree
- [ ] Existing flat projects show at root level — no migration needed
- [ ] Mobile: search modal works with touch, tree collapses appropriately
- [ ] Keyboard: Tab through filters, Arrow through results, Enter to select

### Accessibility

- [ ] Search input has `aria-label="Search conversations"`
- [ ] Results use `role="listbox"`, items use `role="option"`
- [ ] Tree uses `role="tree"`, items use `role="treeitem"`
- [ ] Focus moves to search input on modal open
- [ ] Screen reader announces result count on search

---

## 9. Implementation Order

```
Phase 1: Chat Search Service + Modal     ← Biggest user value
  ├── ChatSearchService (query, filter, cache)
  ├── ChatSearchModal (UI, debounce, results)
  └── Wire into UnifiedChatModal header

Phase 2: Project Tree Structure           ← Enables nesting
  ├── listProjectTree() recursive scanner
  ├── ProjectTreeNode type
  ├── createGroup(), createProject(parentPath)
  └── Tree rendering in project dropdown

Phase 3: Integration + Polish             ← Connects both features
  ├── Search filters include project tree (breadcrumbs)
  ├── Resume picker uses tree structure
  ├── Mobile adaptations
  └── i18n complete
```

Estimated: ~35 new tests, 4 new files, 6 modified files, ~25 i18n strings.

---

## 10. Audit Remediation (GPT-5.4 Round 1)

**Verdict**: SIGNIFICANT_GAPS — H:6 M:5 L:0. All accepted.

### [H1] Project identity must be UUID, not folder path

Move operations update `folderPath` in `_project.md` but `id` (UUID) remains primary key. All references (conversation `project_id`, persistence cache keys, resume picker) use UUID. `findProject()` scans by UUID matching in `_project.md` frontmatter, not by path.

### [H2] Persistence service must handle nested project paths

`buildFilePath()` already uses `state.projectFolderPath` when set. The fix is ensuring `loadProjectContext()` passes the resolved nested path. `listRecent(projectId)` filters by `project_id` frontmatter, not folder path — works regardless of nesting depth.

### [H3] Replace `listRecent(999)` with proper `listAll()`

Add `listAll(filters?)` to `ConversationPersistenceService` that scans the full `Conversations/` + `Projects/` tree. Returns an async generator or paginated results for large vaults. The search service calls this instead of abusing `listRecent()`.

### [H4] All new service functions return `Result<T>`

`ChatSearchService.search()` → `Result<SearchResult[]>`
`ProjectService.createGroup()` → `Result<string>`
`ProjectService.moveProject()` → `Result<void>`
`ProjectService.listProjectTree()` → `Result<ProjectTreeNode[]>`

### [H5] Replace `Menu` with custom `ProjectTreeModal`

A custom modal (not Obsidian's `Menu`) renders the tree with expand/collapse, ARIA tree roles, keyboard navigation (ArrowUp/Down/Left/Right for tree), and mobile-friendly touch targets.

### [H6] Proper conversation content parser for search

Add `extractSearchableContent(fileContent)` that strips frontmatter, strips the `<!-- chat-state-b64:... -->` blob, and returns only the readable message text. Search operates on this cleaned content, not raw file bytes.

### [M8] Validation on create/move

`createGroup()` and `createProject()` check for sibling name collisions (case-insensitive). `moveProject()` validates no circular nesting and target exists. Return `err('Name already exists')` on collision.

### [M9] Depth limit enforced in create/move

```typescript
const MAX_PROJECT_DEPTH = 3;
function getDepth(path: string, rootPath: string): number {
    return path.replace(rootPath, '').split('/').filter(Boolean).length;
}
```
`createGroup()` and `createProject()` check depth before creating. `moveProject()` checks depth of target + subtree.

### [M10] Safe excerpt rendering

Search results use `createEl('mark')` for highlighted matches, not `innerHTML`. The excerpt builder returns an array of `{ text: string, highlight: boolean }` segments that are rendered via safe DOM methods.
