# UX Fix Plan: Export Folder Picker, Highlight Context Menu, Highlight Chat Scoping

**Date:** 2026-02-02
**Status:** Complete

---

## Overview

Three UX improvements addressing user friction:

1. **Export folder picker** — Replace plain text input with vault folder browser dropdown
2. **Highlight right-click menu** — Add editor context menu for highlight/unhighlight
3. **Highlight chat scoping** — Show only highlighted passages by default, not every block in the note

---

## Feature 1: Export Folder Picker

**Problem**: Chat export and minutes output folder prompts are plain text fields. Users must type folder paths manually.

**Solution**: Reuse `FolderScopePickerModal` with enhancements: (a) search-to-create pattern for new folders with safe recursive creation, (b) `confirmButtonText` option, (c) resolved-path preview shown inside the picker before confirm.

### Changes

**`src/ui/modals/FolderScopePickerModal.ts`**:
- Add `confirmButtonText?: string` option (e.g. "Export" instead of "Select")
- Add `allowNewFolder?: boolean` option — when true and search term doesn't match any folder, show a "+ Create: {term}" item at the top of the list
- On click of "Create" item: normalize path (trim, strip leading/trailing slashes), validate no invalid chars, then use `ensureFolderExists()` (recursive creation, already in codebase) instead of raw `vault.createFolder()`, then return path via `onSelect`
- Apply `confirmButtonText` to the select button if provided
- Add resolved-path preview element below the folder list — when a folder is selected or "Create" is highlighted, show the full resolved destination path (e.g. "Export to: AI-Organiser/Chats/MyFolder"). This is inside the picker modal itself (single flow, not a second confirm step). Callers pass an optional `resolvePreview?: (path: string) => string` callback.
- **Default folder handling**: If `defaultFolder` doesn't exist in the vault, prefill the search input with that path and show the "+ Create" affordance automatically
- Add i18n keys: `createFolder`, `exportDestination`

**`src/commands/chatCommands.ts`** — `promptExportFolder()`:
- Replace inline `Modal` with `FolderScopePickerModal`
- Config: `title` from i18n export keys, `allowSkip: false`, `allowNewFolder: true`, `confirmButtonText: t.exportConfirmButton`, `defaultFolder` from `getChatExportFullPath()`
- Pass `resolvePreview: (path) => resolvePluginPath(this.plugin.settings, path, 'Chats')` so the picker shows the resolved destination inline
- Keep promise-based return pattern

**`src/ui/modals/MinutesCreationModal.ts`**:
- Replace plain text `addText` for output folder with a button that opens `FolderScopePickerModal`
- Display selected folder path next to button
- Same `allowNewFolder: true` config with `resolvePreview` callback for consistent UX

### i18n additions

**`types.ts`** — add to `folderScopePicker`:
```typescript
createFolder: string;
exportDestination: string;
```

**`en.ts`**:
```typescript
createFolder: 'Create new folder: "{path}"',
exportDestination: 'Destination: {path}',
```

**`zh-cn.ts`**:
```typescript
createFolder: '创建新文件夹: "{path}"',
exportDestination: '目标路径: {path}',
```

---

## Feature 2: Highlight Right-Click Context Menu

**Problem**: Highlighting requires command palette. Right-click is faster and more discoverable.

**Solution**: Register `editor-menu` event in `registerHighlightCommands()`.

### Changes

**`src/commands/highlightCommands.ts`**:

The `editor-menu` event callback parameters are already typed by Obsidian's API (`Menu`, `Editor`, `MarkdownView | MarkdownFileInfo`), so no explicit `Menu` import is needed — the type is inferred. Add registration inside `registerHighlightCommands()`:

```typescript
plugin.registerEvent(
    plugin.app.workspace.on('editor-menu', (menu, editor, view) => {
        const selection = editor.getSelection();
        if (!selection || selection.trim().length === 0) return;

        // "Highlight" always shown when text is selected (no size guard needed)
        menu.addItem((item) => {
            item.setTitle(plugin.t.commands.highlightSelection || 'Highlight')
                .setIcon('highlighter')
                .onClick(() => {
                    const modal = new HighlightColorModal(
                        plugin.app, plugin.t,
                        (color) => applyHighlight(editor, selection, color)
                    );
                    modal.open();
                });
        });

        // "Remove highlight" only when markup detected
        // Performance guard: skip expensive strip check on huge selections
        if (selection.length <= 5000) {
            // Reuse stripExistingHighlight to detect — DRY with existing logic
            const stripped = stripExistingHighlight(selection);
            if (stripped !== selection) {
                menu.addItem((item) => {
                    item.setTitle(plugin.t.commands.removeHighlight || 'Remove highlight')
                        .setIcon('eraser')
                        .onClick(() => removeHighlight(editor, selection));
                });
            }
        }
    })
);
```

### Design decisions (from expert review)

- **Highlight always visible**: The >5000 guard only applies to the expensive `stripExistingHighlight` detection for the "Remove highlight" item. The "Highlight" menu item is always shown when text is selected regardless of size.
- **No `Menu` import**: The callback parameter types are inferred by Obsidian's workspace event typing. Avoids unused import issues on strict builds.
- **DRY highlight detection**: Use `stripExistingHighlight(selection) !== selection` instead of a separate regex. This reuses the existing parsing logic and handles all markup forms (mark tags, `==text==`), avoiding the greedy `==.+==` bug and multiline issues.
- **Conditional "Remove highlight"**: Only shown when markup is actually detected.

### i18n

No new keys — reuses `commands.highlightSelection` and `commands.removeHighlight`.

---

## Feature 3: Highlight Chat — Show Only Highlighted Passages

**Problem**: The modal shows every block from the note. Notes with wikilinks, URLs, and chat exports make it look overwhelming. Users see 0 selected on a wall of content.

**Solution**: Default to showing only blocks with `hasHighlight === true`. Add a toggle button with counts. Define explicit selection-state rules for toggling.

### Selection-State Rules

These rules prevent the "hidden-selection bug" where non-highlighted blocks stay silently selected after filtering back.

1. **Default**: `showAllBlocks = false` — only highlighted blocks visible
2. **Toggle to "Show all"**: All blocks become visible. Previously selected highlighted blocks stay selected.
3. **Toggle back to "Highlights only"**: **Auto-deselect any non-highlighted blocks** that were selected while "Show all" was on. This prevents hidden blocks being sent to chat.
4. **Token count and summary always reflect actual selection** (including hidden blocks during transition, cleared on toggle-back).

### Changes

**`src/ui/modals/HighlightChatModal.ts`**:

1. Add field: `private showAllBlocks = false;`

2. In `onOpen()`, after `splitIntoBlocks()`:
   - Check if any blocks have `hasHighlight === true`
   - If **no highlights** AND **no editor selection**: show Notice, close modal, return early

3. In `renderSelectionPhase()`:
   - Filter displayed blocks: `showAllBlocks ? this.blocks : this.blocks.filter(b => b.hasHighlight)`
   - **Always use `originalIndex`** (position in `this.blocks`) for selection tracking, never the loop index of the filtered array
   - Add toggle button (not link — better accessibility/keyboard) with count: "Showing X of Y passages"

4. Toggle handler:
   ```typescript
   this.showAllBlocks = !this.showAllBlocks;
   if (!this.showAllBlocks) {
       // Auto-deselect non-highlighted blocks when filtering back
       for (const idx of [...this.selectedIndices]) {
           if (!this.blocks[idx].hasHighlight) {
               this.selectedIndices.delete(idx);
           }
       }
   }
   this.renderSelectionPhase();
   ```

5. **Rendering with originalIndex** (prevents index-shifting bugs):
   ```typescript
   const displayBlocks = this.showAllBlocks
       ? this.blocks.map((b, i) => ({ block: b, originalIndex: i }))
       : this.blocks
           .map((b, i) => ({ block: b, originalIndex: i }))
           .filter(item => item.block.hasHighlight);

   for (const { block, originalIndex } of displayBlocks) {
       const isSelected = this.selectedIndices.has(originalIndex);
       // ... render using originalIndex for all selection operations
   }
   ```

### i18n additions

**`types.ts`** — add to `highlightChat`:
```typescript
noHighlightsFound: string;
showAllPassages: string;
showHighlightsOnly: string;
showingCount: string;
```

**`en.ts`**:
```typescript
noHighlightsFound: 'No highlights found in this note. Select text first, or add highlights using the Highlight command.',
showAllPassages: 'Show all passages',
showHighlightsOnly: 'Show highlights only',
showingCount: 'Showing {visible} of {total} passages',
```

**`zh-cn.ts`**:
```typescript
noHighlightsFound: '此笔记中未找到高亮内容。请先选择文本，或使用高亮命令添加高亮。',
showAllPassages: '显示所有段落',
showHighlightsOnly: '仅显示高亮段落',
showingCount: '显示 {visible} / {total} 段',
```

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/commands/highlightCommands.ts` | Add `editor-menu` registration (no new imports needed) |
| `src/ui/modals/HighlightChatModal.ts` | Filter to highlighted blocks, toggle button, auto-deselect, early exit, originalIndex tracking |
| `src/commands/chatCommands.ts` | Replace `promptExportFolder()` with `FolderScopePickerModal` |
| `src/ui/modals/FolderScopePickerModal.ts` | Add `confirmButtonText`, `allowNewFolder` with search-to-create, `resolvePreview`, `ensureFolderExists` for safe creation, default-folder prefill |
| `src/ui/modals/MinutesCreationModal.ts` | Replace output folder text input with folder picker button + `resolvePreview` |
| `src/i18n/types.ts` | 4 highlightChat keys + 2 folderScopePicker keys |
| `src/i18n/en.ts` | English translations |
| `src/i18n/zh-cn.ts` | Chinese translations |

## Implementation Order

1. **Feature 2** (Right-click highlight) — smallest, self-contained, no index risk
2. **Feature 3** (Highlight chat scoping) — highest user impact, careful originalIndex tracking
3. **Feature 1** (Folder picker) — reuses existing component with enhancements

## Expert Review Findings Integrated

| Finding | Severity | Resolution |
|---------|----------|------------|
| >5000 guard hides all context actions | Blocker | Guard only applies to "Remove highlight" detection; "Highlight" always visible |
| `vault.createFolder()` risky for nested/invalid paths | Blocker | Use `ensureFolderExists()` (recursive) + path normalization/validation |
| Resolved path preview should be inside picker, not second step | High | Added `resolvePreview` callback option to `FolderScopePickerModal`; both chatCommands and MinutesCreationModal use same UX |
| Unused `Menu` import may fail strict builds | Medium | No explicit import needed — Obsidian event callback types are inferred |
| Default folder may not exist on first run | Medium | If `defaultFolder` not in vault, prefill search with that path + show "+ Create" affordance |
| Hidden-selection bug on toggle-back | High | Auto-deselect non-highlighted blocks when filtering back to "Highlights only" |
| DRY highlight detection | Medium | Reuse `stripExistingHighlight` instead of separate regex |

## Verification

### Automated
- [x] `npm run build` passes
- [x] `npm test` passes (1028 tests, 51 suites, 0 failures)
- [x] 33 new tests in `tests/uxFixes.test.ts`

### Manual

**Feature 2 — Right-click highlight:**
- [ ] Right-click with selection -> "Highlight" visible, opens color picker, highlights text
- [ ] Right-click highlighted text -> "Remove highlight" also visible
- [ ] Right-click without selection -> no highlight items in menu
- [ ] Right-click on large selection (>5000 chars) -> "Highlight" still visible, "Remove highlight" absent (performance guard)
- [ ] Select text containing `==A== plain ==B==` -> Remove highlight handles both correctly

**Feature 3 — Highlight chat scoping:**
- [ ] Chat about highlights on note WITH highlights -> only highlighted passages shown
- [ ] Toggle "Show all passages" -> full block list, highlighted ones still selected
- [ ] Select a non-highlighted block, toggle back to "Highlights only" -> non-highlighted selection auto-cleared
- [ ] Token count always reflects actual selected passages
- [ ] Chat about highlights with NO highlights and no selection -> notice shown, modal closes
- [ ] Start Chat -> verify correct passage text sent (originalIndex not shifted)
- [ ] Highlight at paragraph #50 -> "Show highlights only" -> Start Chat -> LLM receives paragraph #50 content (not #1)

**Feature 1 — Export folder picker:**
- [ ] Chat export -> folder picker modal with tree view
- [ ] Search folders in picker -> filters correctly
- [ ] Type non-existing folder name -> "+ Create" item appears at top
- [ ] Click Create -> folder created (including nested paths), path returned
- [ ] Resolved path preview shows correct destination inside picker before confirm
- [ ] Select folder -> export saves to chosen folder
- [ ] First run (default folder doesn't exist) -> search prefilled with default, "+ Create" shown
- [ ] Minutes modal -> folder picker for output folder works with same resolved-path preview
