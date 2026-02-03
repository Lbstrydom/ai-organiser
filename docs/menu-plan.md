# Command Picker Restructuring: Context-Based Categories

**Status**: Plan (not yet implemented). This is the source of truth for this work item.

## Design Rationale

Move from **functional grouping** (Create, Enhance, Organize, Discover) to **contextual grouping** (Active Note, Capture, Vault Intelligence, Tools) based on the user's current focus. This applies Gestalt proximity — commands are grouped by where the user's attention is, not what category the tool belongs to.

---

## Final Structure

### A. Active Note (`active-note`, icon: `file-edit`, color: Blue)

Commands that act on the file currently open in the editor.

1. **Connections & Maps** (sub-group, icon: `network`)
   - Map Related Concepts — `build-investigation-canvas`
   - Map Attachments — `build-context-canvas`
   - Find Related — `find-related`
   - Insert Related Notes — `insert-related-notes`
2. **Refine Content** (sub-group, icon: `sparkles`)
   - Auto-Tag Note — `smart-tag`
   - Improve Writing — `enhance-note`
   - Summarize Note — `smart-summarize` *(Intent: consumption/TL;DR of what's in front of me)*
   - Translate — `smart-translate`
   - Clear Tags — `clear-tags`
3. **Pending Integration** (sub-group, icon: `inbox`)
   - Add to Pending — `add-to-pending`
   - Integrate Pending — `integrate-pending`
   - Resolve Embeds — `resolve-embeds`
4. **Export** (sub-group, icon: `file-output`)
   - Export Note — `export-note`
   - Export Flashcards — `export-flashcards`

### B. Capture (`capture`, icon: `plus-circle`, color: Orange)

Bringing new information into the vault from external sources.

1. **Summarize Web / YouTube** — `smart-summarize` *(Intent: creation/ingest from external source)*
2. **Create Meeting Minutes** — `create-meeting-minutes`
3. **Record Voice Note** — `record-audio`

### C. Vault Intelligence (`vault`, icon: `brain`, color: Green)

Exploring and connecting the broader knowledge base.

1. **Chat with AI** — `chat-with-ai`
2. **Semantic Search** — `semantic-search`
3. **Group Notes by Tag** — `build-cluster-canvas`
4. **Visualize Tag Graph** — `show-tag-network`
5. **Create Bases Dashboard** — `create-bases-dashboard`

### D. Tools & Workflows (`tools`, icon: `settings`, color: Gray)

Specialized or bulk operations.

1. **NotebookLM** (sub-group, icon: `book-open`)
   - Export Source Pack — `notebooklm-export`
   - Toggle Selection — `notebooklm-toggle`
   - Clear Selection — `notebooklm-clear`
   - Open Export Folder — `notebooklm-open-folder`
2. **Collect All Tags** — `collect-all-tags`

---

## Command Inventory (27 entries, 26 unique commands)

`smart-summarize` appears in both Active Note ("Summarize Note") and Capture ("Summarize Web/YouTube"). This is intentional — the same command serves two user intents and should be findable where each intent arises.

| Category | Leaf Commands | Count |
|----------|---------------|-------|
| Active Note | investigation, context, find-related, insert-related, smart-tag, enhance, smart-summarize, translate, clear-tags, add-pending, integrate-pending, resolve-embeds, export-note, export-flashcards | 14 |
| Capture | smart-summarize, meeting-minutes, record-audio | 3 |
| Vault | chat, search, cluster-canvas, tag-network, dashboard | 5 |
| Tools | 4x notebooklm, collect-tags | 5 |
| **Total unique** | | **26** |

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| `smart-summarize` in both Active Note + Capture | Same command, two intents. In Active Note = "TL;DR this note". In Capture = "Ingest from URL/YouTube". Users look where their intent is. |
| Pending Integration in Active Note (not Capture) | "Integrate" and "Resolve" operate ON the active note. Only "Add to pending" is inbound, but keeping the group together avoids splitting a workflow. |
| "Refine Content" sub-group | Structural fix for Active Note density. Groups polishing actions (tag, improve, summarize, translate, clear) under one sub-menu instead of 5 top-level items. Respects Gestalt Common Region. |
| Canvas split: Investigation/Context in Active Note, Cluster in Vault | Investigation and Context boards visualize the current note's relationships/attachments. Cluster Board operates on a vault-wide tag — different scope. |
| `brain` icon (not `brain-circuit`) | `brain-circuit` is a newer Lucide icon not reliably in Obsidian's bundled set. |
| `settings` icon for Tools (not `wrench`) | `wrench` is used for the Utilities sub-group inside Active Note — avoids icon collision. |
| All strings through i18n | Bilingual EN/ZH-CN requirement. No hardcoded English labels. |

---

## Implementation Plan

### Files to Modify

| File | Change |
|------|--------|
| `src/i18n/types.ts` | Add new category/group/command keys to `Translations` interface |
| `src/i18n/en.ts` | Add English translations for new keys |
| `src/i18n/zh-cn.ts` | Add Chinese translations for new keys |
| `src/ui/modals/CommandPickerModal.ts` | Rewrite `buildCommandCategories()` |
| `styles.css` | Update `[data-category]` color mappings |
| `tests/commandPicker.test.ts` | Rewrite to match new structure |
| `docs/usertest.md` | Update Command Picker test section |
| `CLAUDE.md` | Update Command Picker category docs |

### Step 1: Update i18n Types (`src/i18n/types.ts`)

Add new keys under `modals.commandPicker`:
```typescript
categoryActiveNote: string;    // "Active Note"
categoryCapture: string;       // "Capture"
categoryVault: string;         // "Vault Intelligence"
categoryTools: string;         // "Tools & Workflows"
groupMaps: string;             // "Connections & Maps"
groupRefine: string;           // "Refine Content"
```

Add new keys under `commands`:
```typescript
mapRelatedConcepts: string;    // "Map Related Concepts"
mapAttachments: string;        // "Map Attachments"
summarizeNote: string;         // "Summarize Note"
summarizeWebYouTube: string;   // "Summarize Web / YouTube"
groupNotesByTag: string;       // "Group Notes by Tag"
visualizeTagGraph: string;     // "Visualize Tag Graph"
```

Remove obsolete keys (cleanup):
```typescript
// Remove: categoryCreate, categoryEnhance, categoryOrganize, categoryDiscover
// Remove: groupAskAI, groupHighlight (already unused)
// Remove: groupFindNotes, groupCanvas (replaced by groupMaps)
// Keep: groupExport, groupPending, groupNotebookLM, groupTags (still used as sub-group names)
```

### Step 2: Add Translations (`src/i18n/en.ts` + `src/i18n/zh-cn.ts`)

**English** — values as listed in Step 1 comments.

**Chinese** — translations needed:
- Active Note → 当前笔记
- Capture → 采集
- Vault Intelligence → 知识库
- Tools & Workflows → 工具与流程
- Connections & Maps → 关联与图谱
- Refine Content → 优化内容
- Map Related Concepts → 映射相关概念
- Map Attachments → 映射附件
- Summarize Note → 总结笔记
- Summarize Web / YouTube → 总结网页/YouTube
- Group Notes by Tag → 按标签分组笔记
- Visualize Tag Graph → 可视化标签图谱

### Step 3: Rewrite `buildCommandCategories` (`src/ui/modals/CommandPickerModal.ts`)

Replace the function body with the structure from the **Final Structure** section above. Key implementation notes:

- `smart-summarize` appears in two places with different `id` values (`summarize-note` in Active Note, `summarize-web` in Capture) but both call `executeCommand('ai-organiser:smart-summarize')`
- **Strict i18n — no fallbacks**: All labels must use `t.commands.*` or `t.modals.commandPicker.*` directly. Do NOT use optional chaining (`t.commands?.x`) or `|| 'English fallback'` patterns. Every key used must exist in the `Translations` interface. Missing keys should fail at compile time, not silently render English.
- Sub-groups use `subCommands` array (existing pattern, no new UI code needed)
- Aliases preserved and expanded for fuzzy search discoverability
- Extract shared alias token arrays where the same aliases appear on multiple commands (e.g., `const CANVAS_ALIASES = ['canvas', 'board', 'visualize']`). This avoids silent drift when alias sets diverge across commands that should share them.

### Step 4: Update CSS (`styles.css`)

Replace `[data-category]` color rules:
```css
[data-category="active-note"] { /* Blue */ }
[data-category="capture"]     { /* Orange */ }
[data-category="vault"]       { /* Green */ }
[data-category="tools"]       { /* Gray/neutral */ }
```

**Full CSS audit required**: Remove ALL stale `[data-category]` selectors — not just `create`/`enhance`/`organize`/`discover`, but also orphaned selectors like `search`, `analyze`, `integrate` that exist in `styles.css` but are never rendered by the picker. After this step, the only `[data-category]` selectors in `styles.css` should be the four listed above.

### Step 5: Rewrite Tests (`tests/commandPicker.test.ts`)

- Update `createMockTranslations()` with all new keys — use properly typed mock (not `as unknown as Translations`) so that missing keys cause compile errors
- Category ID assertions: `['active-note', 'capture', 'vault', 'tools']`
- Active Note: verify 4 sub-groups (maps, refine, pending, export) with correct sub-commands
- Capture: verify 3 commands (summarize-web, meeting-minutes, record-audio)
- Vault: verify 5 commands (chat, search, cluster, tag-network, dashboard)
- Tools: verify notebooklm sub-group (4 sub-commands) + collect-all-tags
- Verify `smart-summarize` callback appears in both Active Note and Capture
- Total leaf command count = 27 entries (26 unique)
- Add exhaustive leaf command test: collect all leaf command IDs recursively from all categories and assert the full set matches the expected 26 unique command IDs (guards against silent drops or additions)

### Step 6: Update Documentation

**`docs/usertest.md`** — Update section 2 (Command Picker):
```markdown
- [ ] Categories visible: Active Note, Capture, Vault Intelligence, Tools & Workflows
- [ ] Active Note has sub-groups: Connections & Maps, Refine Content, Pending Integration, Export
- [ ] Capture has: Summarize Web/YouTube, Create Meeting Minutes, Record Voice Note
- [ ] Vault Intelligence has: Chat with AI, Semantic Search, Group Notes by Tag, Visualize Tag Graph, Create Bases Dashboard
- [ ] Tools has: NotebookLM (sub-group), Collect All Tags
```

**`CLAUDE.md`** — Update Command Picker categories section to reflect new structure.

---

## Review Responses

### Addressed Findings

| Finding | Severity | Response |
|---------|----------|----------|
| Plan not implemented in code | High | Expected — this is a plan document. Added status header. |
| i18n contract missing | High | Expected — plan not yet implemented. Step 1-2 cover this. |
| Stale CSS selectors | High | Valid. Step 4 now requires full audit of ALL `[data-category]` selectors, not just the 4 old ones. |
| DRY/SOLID in picker | Medium | Partially challenged — see note below. Shared alias arrays added to Step 3. |
| Optional chaining fallbacks | Medium | Valid. Step 3 now explicitly bans `?.` and `\|\|` fallback patterns on i18n keys. |
| Tests lock in old architecture | Medium | Expected — Step 5 now also requires typed mocks (no `as unknown`) and exhaustive leaf command test. |
| usertest.md out of sync | Low | Expected — Step 6 covers this. |

### DRY/SOLID Challenge

The `buildCommandCategories` function is a **declarative data definition**, not procedural logic. The "repetition" is intentional structure — each command object is a unique data literal with its own id, name, icon, aliases, and callback. Extracting these into a factory, registry, or builder pattern would add indirection without reducing the actual information content. This is the same pattern as route tables, schema definitions, or test fixtures — flat and explicit is preferable to abstracted and indirect.

What IS worth deduplicating: **shared alias token arrays** where the same search terms should apply to multiple commands (e.g., canvas-related commands sharing `['canvas', 'board']`). This prevents silent alias drift. Added to Step 3.

### Open Questions — Answered

1. **Is menu-plan.md the source of truth?** Yes. This is the active plan for this work item, not backlog. Added status header.
2. **Strict no-fallback i18n?** Yes. All picker labels must exist in the `Translations` interface. No `?.` or `|| 'fallback'`. Missing keys should fail at compile time.
3. **Should root search include leaf subcommands?** It already does. The modal's `getItems()` flattens all categories into a single `CommandItem[]` array, and `getItemText()` includes the category name + command name + aliases. Fuzzy search covers all leaf commands regardless of nesting depth. No change needed.

---

## Verification

1. `npm run build` — type-check passes with new i18n keys
2. `npm test` — all commandPicker tests pass with new structure
3. Manual in Obsidian:
   - 4 categories with correct names, icons, badge colors
   - Fuzzy search finds commands across all categories (e.g., typing "tag" finds Auto-Tag in Active Note and Collect All Tags in Tools)
   - Sub-groups open correctly (Connections & Maps, Refine Content, Pending, Export, NotebookLM)
   - All 26 unique commands execute correctly
   - `smart-summarize` reachable from both Active Note → Refine → Summarize Note AND Capture → Summarize Web/YouTube
   - Chinese locale shows translated category and command names
   - No `undefined` or raw i18n keys visible
