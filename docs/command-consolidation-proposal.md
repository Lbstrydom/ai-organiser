# Command Consolidation Proposal v2

**Date:** January 22, 2026
**Status:** Approved for Implementation
**Approach:** Smart Dispatcher Pattern

---

## Executive Summary

The plugin currently has **27+ commands**. Using the Smart Dispatcher pattern (context-aware routing), we consolidate to **6 primary commands** while maintaining 100% feature parity and eliminating the "Click Tax" for power users.

---

## Design Principles

### Smart Dispatcher Pattern
Instead of dumb modal selectors, commands **detect context first** and only show a modal when intent is ambiguous.

**Benefits:**
- No "Click Tax" - users who know what they want get instant action
- Discoverability preserved - new users see options when needed
- No hotkey loss - single hotkey handles multiple scenarios intelligently

---

## Approved Command Structure

### 1. Summarize (5 → 1 command)

**Command:** `AI Organiser: Summarize`

**Smart Logic Flow:**
```
User triggers Summarize →
├── Has text selection (>50 chars)? → Summarize selection
├── Cursor on YouTube URL? → Summarize YouTube
├── Cursor on PDF link? → Summarize PDF
├── Cursor on any URL? → Summarize URL
└── Else → Open source modal (Note/URL/PDF/YouTube/Audio)
```

**Implementation:**
```typescript
async executeSmartSummarize() {
    const editor = this.app.workspace.activeEditor?.editor;
    const selection = editor?.getSelection();
    const currentLine = editor?.getLine(editor.getCursor().line);

    // 1. Explicit user selection
    if (selection && selection.length > 50) {
        return this.summarizeSelection(selection);
    }

    // 2. Cursor on specific content
    if (isYouTubeUrl(currentLine)) {
        return this.summarizeYouTube(extractUrl(currentLine));
    }
    if (isPdfUrl(currentLine) || isPdfEmbed(currentLine)) {
        return this.summarizePdf(extractPath(currentLine));
    }
    if (isUrl(currentLine)) {
        return this.summarizeUrl(extractUrl(currentLine));
    }

    // 3. Fallback: Open modal
    new SummarizeSourceModal(this.app, this.plugin).open();
}
```

**Modal Design (fallback only):**
```
┌─────────────────────────┐
│  Summarize              │
├─────────────────────────┤
│  ○ This note            │
│  ○ Paste URL            │
│  ○ Select PDF           │
│  ○ YouTube video        │
│  ○ Audio file           │
├─────────────────────────┤
│  [Cancel]    [Continue] │
└─────────────────────────┘
```

---

### 2. Translate (2 → 1 command)

**Command:** `AI Organiser: Translate`

**Smart Logic Flow:**
```
User triggers Translate →
├── Has text selection? → Translate selection
└── Else → Translate full note (with notice)
```

**Implementation:**
```typescript
async executeSmartTranslate() {
    const editor = this.app.workspace.activeEditor?.editor;
    const selection = editor?.getSelection();

    if (selection && selection.length > 0) {
        return this.translateSelection(selection);
    }

    // No selection - translate full note
    new Notice('Translating full note...');
    return this.translateNote();
}
```

---

### 3. Tag (6 → 1 command)

**Command:** `AI Organiser: Tag`

**Smart Logic Flow:**
```
User triggers Tag →
└── Open scope modal (defaults to "This note" for instant Enter)
```

**Modal Design:**
```
┌─────────────────────────┐
│  Tag Notes              │
├─────────────────────────┤
│  ● This note  ← default │
│  ○ Current folder       │
│  ○ Entire vault         │
├─────────────────────────┤
│  [Cancel]    [Tag]      │
└─────────────────────────┘
```

**Clear Tags:** Separate command `AI Organiser: Clear Tags` with same modal pattern.

---

### 4. Enhance / AI Assistant (4 → 1 command)

**Command:** `AI Organiser: Enhance`

**Modal Design (action menu):**
```
┌─────────────────────────┐
│  Enhance Note           │
├─────────────────────────┤
│  ✨ Improve writing     │
│  📊 Generate diagram    │
│  🔍 Find resources      │
│  📝 Export flashcards   │
├─────────────────────────┤
│  [Cancel]               │
└─────────────────────────┘
```

This creates a cohesive "AI Assistant" feel, similar to Notion AI's `/` menu.

---

### 5. Semantic Search (4 → 2 commands)

**Keep top-level (daily use):**
- `AI Organiser: Find Related` → Direct action, no modal
- `AI Organiser: Semantic Search` → Opens search modal

**Consolidate maintenance (rare use):**
- `AI Organiser: Manage Index` → Modal with Build/Update/Clear

**Modal Design (maintenance only):**
```
┌─────────────────────────┐
│  Manage Index           │
├─────────────────────────┤
│  [📚 Build Full Index]  │
│  [🔄 Update Index    ]  │
│  [🗑️ Clear Index     ]  │
├─────────────────────────┤
│  [Close]                │
└─────────────────────────┘
```

---

### 6. Utilities (Keep separate)

These remain individual commands:
- `AI Organiser: Tag Network` → Opens visualization
- `AI Organiser: Export Tags` → Saves to file
- `AI Organiser: Chat with Vault` → Opens chat modal

---

## Final Command List

| # | Command | Type | Consolidates |
|---|---------|------|--------------|
| 1 | **Summarize** | Smart Dispatcher | URL, PDF, YouTube, Audio, Smart |
| 2 | **Translate** | Smart Dispatcher | Note, Selection |
| 3 | **Tag** | Scope Modal | Note, Folder, Vault |
| 4 | **Clear Tags** | Scope Modal | Note, Folder, Vault |
| 5 | **Enhance** | Action Menu | Improve, Diagram, Resources, Flashcards |
| 6 | **Find Related** | Direct | - |
| 7 | **Semantic Search** | Modal | - |
| 8 | **Manage Index** | Action Modal | Build, Update, Clear |
| 9 | **Tag Network** | Direct | - |
| 10 | **Export Tags** | Direct | - |
| 11 | **Chat with Vault** | Modal | - |
| 12 | **Commands** | Picker | All commands |

**Total: 12 commands** (down from 27) - **56% reduction**

---

## Decisions Made

| Question | Decision | Rationale |
|----------|----------|-----------|
| Smart Dispatcher for Summarize | **YES** | Highest-value UX improvement |
| Hidden hotkeyable commands | **NO** | Technical debt; dispatcher handles this |
| "Don't ask again" setting | **SKIP** | Modal remembers last option instead |
| Translate consolidation | **YES** | Zero ambiguity with selection detection |
| Smart Notes → Enhance menu | **YES** | Creates cohesive "AI Assistant" feel |

---

## Implementation Plan

### Phase 1: Smart Dispatchers (High Impact)

1. **Create `SmartSummarizeCommand`**
   - Add URL detection utilities
   - Implement context detection logic
   - Create fallback `SummarizeSourceModal`
   - Deprecate individual summarize commands

2. **Create `SmartTranslateCommand`**
   - Selection detection
   - Auto-translate note when no selection

### Phase 2: Action Menus

3. **Create `EnhanceNoteModal`**
   - Action menu UI (Improve/Diagram/Resources/Flashcards)
   - Route to existing implementations

4. **Create `ManageIndexModal`**
   - Build/Update/Clear actions
   - Deprecate individual index commands

### Phase 3: Scope Modals

5. **Create `TagScopeModal`**
   - Note/Folder/Vault scope selection
   - Default to "This note"
   - Deprecate individual tag commands

6. **Create `ClearTagsScopeModal`**
   - Same pattern as TagScopeModal

### Phase 4: Cleanup

7. **Update Command Registration**
   - Register new consolidated commands
   - Remove deprecated commands
   - Update CommandPickerModal categories

8. **Update i18n**
   - New command names
   - Modal labels and descriptions

---

## Files to Create/Modify

### New Files
- `src/ui/modals/SummarizeSourceModal.ts`
- `src/ui/modals/EnhanceNoteModal.ts`
- `src/ui/modals/ManageIndexModal.ts`
- `src/ui/modals/TagScopeModal.ts`
- `src/ui/modals/ClearTagsScopeModal.ts`
- `src/utils/contentDetection.ts` (URL/content type detection)

### Modified Files
- `src/commands/summarizeCommands.ts` - Smart dispatcher logic
- `src/commands/translateCommands.ts` - Selection detection
- `src/commands/generateCommands.ts` - Scope modal routing
- `src/commands/clearCommands.ts` - Scope modal routing
- `src/commands/smartNoteCommands.ts` - Route through Enhance modal
- `src/commands/index.ts` - Updated command registration
- `src/ui/modals/CommandPickerModal.ts` - Updated categories
- `src/i18n/en.ts` - New strings
- `src/i18n/zh-cn.ts` - New strings

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| User muscle memory | Same hotkeys work; behavior is smarter |
| Command palette search | Ensure aliases match old command names |
| Edge cases in detection | Fallback modal always available |
| Regression bugs | Test each original flow through new dispatcher |

---

## Metrics

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| Top-level commands | 27 | 12 | **-56%** |
| Click steps (common flows) | 2-3 | 1 | **-50%** |
| Feature parity | 100% | 100% | No loss |
| New modals | 0 | 5 | +5 |

---

## Approval

- [x] Smart Dispatcher pattern approved
- [x] Summarize consolidation approved
- [x] Translate consolidation approved
- [x] Enhance menu consolidation approved
- [x] Semantic search split approved (Keep search top-level)
- [x] No hidden commands (deprecated)
- [x] No "don't ask again" setting (modal remembers instead)

**Ready for implementation.**
