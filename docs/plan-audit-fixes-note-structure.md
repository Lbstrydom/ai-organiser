# Plan: Audit Fixes + Universal Note Structure

## Overview

This plan addresses two categories of issues:
1. **Audit findings** from `docs/repo-audit-ux-ui.md` (semantic search issues)
2. **Universal note structure** - ensuring References/Pending Integration sections exist after ANY plugin interaction

---

## Part 1: Audit Fixes

### 1.1 Semantic Search Settings Re-render (HIGH)

**Problem:** `SemanticSearchSettingsSection.display()` is called from onChange handlers without clearing `containerEl` first, causing duplicate UI blocks.

**Files:**
- `src/ui/settings/SemanticSearchSettingsSection.ts`

**Fix:**
- Add `this.containerEl.empty()` at the start of `display()` method
- This matches the pattern used in `AIOrganiserSettingTab.ts:28`

### 1.2 Disabling Semantic Search Doesn't Stop Background Work (HIGH)

**Problem:** When semantic search is disabled, only `plugin.vectorStore = null` is set, but event listeners remain active.

**Files:**
- `src/ui/settings/SemanticSearchSettingsSection.ts` (toggle handler)
- `src/services/vector/vectorStoreService.ts` (add dispose method)
- `src/main.ts` (call dispose on disable)

**Fix:**
1. Add `dispose()` method to `VectorStoreService` that:
   - Unregisters all file event listeners
   - Clears any pending operations
2. Update the toggle handler to call `vectorStoreService.dispose()` before nullifying
3. Store listener references so they can be removed

### 1.3 Event Listeners Not Registered for Cleanup (MEDIUM)

**Problem:** `vectorStoreService.ts` and `eventHandlers.ts` use `.on()` directly instead of `plugin.registerEvent()`.

**Files:**
- `src/services/vector/vectorStoreService.ts`
- `src/utils/eventHandlers.ts`

**Fix:**
- Pass `plugin` reference to these services
- Use `plugin.registerEvent(this.app.vault.on(...))` pattern
- OR: Store listener references and manually unregister in dispose()

### 1.4 Similarity Score is Placeholder (MEDIUM)

**Problem:** `voyVectorStore.ts` returns hardcoded `0.9` score, making all results show "90% excellent".

**Files:**
- `src/ui/views/RelatedNotesView.ts`

**Fix (User Decision):** Show "Related" badge instead of fake percentage
- Remove percentage display (`90%`)
- Remove color-coded score classes (`score-excellent`, `score-good`, `score-fair`)
- Show simple "Related" text badge
- Keep the list ordering (Voy still returns results in relevance order)

---

## Part 2: Universal Note Structure

### Problem

Notes grow organically. Users need a consistent place to add new inputs for later integration. Currently only some commands add the References/Pending Integration sections.

### User Decision

- **ALL plugin interactions** should ensure the structure exists (including tag-only commands)
- Add a **settings toggle** to disable this behavior for users who don't want it
- Always **check if sections already exist** before adding (don't duplicate)

### Commands Missing `ensureStandardStructure()`:

| Command | File | Priority |
|---------|------|----------|
| translate-selection | translateCommands.ts | High |
| generate-from-embedded | smartNoteCommands.ts | High |
| find-resources | smartNoteCommands.ts | Medium |
| generate-mermaid-diagram | smartNoteCommands.ts | Medium |
| ask-about-current-note | chatCommands.ts | High |
| insert-related-notes | chatCommands.ts | Medium |
| All summarize-* commands | summarizeCommands.ts | Medium |
| generate-tags-* commands | generateCommands.ts | High |
| clear-tags-* commands | clearCommands.ts | High |

### Fix Strategy

1. **Add setting:** `autoEnsureNoteStructure` (default: true) in settings
2. **Add setting UI** in appropriate settings section
3. **Add helper function** that checks setting before calling `ensureStandardStructure()`
4. **Update all commands** to call this helper at the end

```typescript
// Helper in noteStructure.ts
export function ensureNoteStructureIfEnabled(
    editor: Editor,
    settings: AIOrganiserSettings
): void {
    if (settings.autoEnsureNoteStructure) {
        ensureStandardStructure(editor);
    }
}
```

The existing `ensureStandardStructure()` already checks if sections exist before adding.

**Files to modify:**
- `src/core/settings.ts` - Add new setting
- `src/ui/settings/` - Add toggle UI
- `src/utils/noteStructure.ts` - Add helper function
- `src/commands/translateCommands.ts`
- `src/commands/smartNoteCommands.ts`
- `src/commands/chatCommands.ts`
- `src/commands/summarizeCommands.ts`
- `src/commands/generateCommands.ts`
- `src/commands/clearCommands.ts`

---

## Implementation Order

1. **Quick wins (low risk):**
   - 1.1 Settings re-render fix (single line change)
   - 1.4 Honest similarity labeling

2. **Core fixes:**
   - Part 2 - Add `ensureStandardStructure()` to all note-modifying commands

3. **Complex fixes (higher risk):**
   - 1.2 + 1.3 Event listener cleanup (requires careful testing)

---

## Verification

1. **Settings re-render:** Toggle semantic search on/off 5 times, verify no duplicate UI
2. **Disable cleanup:** Disable semantic search, verify no console indexing activity
3. **Similarity display:** Open Related Notes, verify shows "Related" not "90%"
4. **Note structure:** Run each command, verify References/Pending sections appear

---

## User Decisions

1. **Tag commands:** Yes, ALL plugin interactions should ensure structure (with settings toggle to disable)
2. **Similarity score:** Show "Related" badge instead of fake percentage
