# Implementation Prompt: Command Consolidation

**For:** Development Team
**Project:** AI Organiser Obsidian Plugin
**Task:** Implement Smart Dispatcher Command Consolidation

---

## Context

You are implementing a command consolidation for an Obsidian plugin. The goal is to reduce 27 commands to 12 using the **Smart Dispatcher pattern** - commands that detect context first and only show modals when intent is ambiguous.

**Reference Documents:**
- `docs/command-consolidation-proposal.md` - Full approved proposal with designs
- `docs/STATUS.md` - Current project status and architecture
- `AGENTS.md` - Codebase conventions and patterns (primary reference for AI agents)

---

## Your Task

Implement the command consolidation in 4 phases. Each phase should result in a working build.

---

## Phase 1: Smart Summarize Dispatcher

**Goal:** Replace 5 summarize commands with 1 smart command.

### Step 1.1: Create Content Detection Utility

Create `src/utils/contentDetection.ts`:

```typescript
// Utilities for detecting content type from text/cursor position

export function isYouTubeUrl(text: string): boolean {
    // Match youtube.com/watch, youtu.be, youtube.com/embed
}

export function isPdfLink(text: string): boolean {
    // Match [[file.pdf]], ![[file.pdf]], or URLs ending in .pdf
}

export function isUrl(text: string): boolean {
    // Match http:// or https:// URLs
}

export function extractUrl(text: string): string | null {
    // Extract first URL from text
}

export function extractPdfPath(text: string): string | null {
    // Extract PDF path from [[link]] or ![[embed]]
}
```

### Step 1.2: Create SummarizeSourceModal

Create `src/ui/modals/SummarizeSourceModal.ts`:

- Radio button selection: Note, URL, PDF, YouTube, Audio
- Remember last selection (store in plugin settings)
- On confirm, route to appropriate existing handler

### Step 1.3: Update summarizeCommands.ts

Add smart dispatcher logic:

```typescript
// In registerSummarizeCommands or new smartSummarize function

async executeSmartSummarize(plugin: AIOrganiserPlugin) {
    const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
        new Notice(plugin.t.messages.openNote);
        return;
    }

    const editor = view.editor;
    const selection = editor.getSelection();
    const cursor = editor.getCursor();
    const currentLine = editor.getLine(cursor.line);

    // 1. Check for text selection (>50 chars)
    if (selection && selection.length > 50) {
        // Summarize selection as text
        return this.summarizeText(selection);
    }

    // 2. Check cursor line for YouTube
    if (isYouTubeUrl(currentLine)) {
        const url = extractUrl(currentLine);
        if (url) return this.summarizeYouTube(url);
    }

    // 3. Check cursor line for PDF
    if (isPdfLink(currentLine)) {
        const path = extractPdfPath(currentLine);
        if (path) return this.summarizePdf(path);
    }

    // 4. Check cursor line for any URL
    if (isUrl(currentLine)) {
        const url = extractUrl(currentLine);
        if (url) return this.summarizeUrl(url);
    }

    // 5. Fallback: Show source selection modal
    new SummarizeSourceModal(plugin.app, plugin).open();
}
```

### Step 1.4: Register New Command

Replace individual summarize commands with:

```typescript
plugin.addCommand({
    id: 'smart-summarize',
    name: plugin.t.commands.summarize, // "Summarize"
    icon: 'file-text',
    editorCallback: (editor, view) => executeSmartSummarize(plugin)
});
```

### Step 1.5: Update i18n

Add to `en.ts` and `zh-cn.ts`:

```typescript
commands: {
    summarize: "Summarize",  // New consolidated command
    // Keep old keys for backward compatibility in CommandPicker aliases
}

modals: {
    summarizeSource: {
        title: "Summarize",
        thisNote: "This note",
        pasteUrl: "Paste URL",
        selectPdf: "Select PDF",
        youtubeVideo: "YouTube video",
        audioFile: "Audio file"
    }
}
```

---

## Phase 2: Smart Translate + Enhance Menu

### Step 2.1: Smart Translate

Update `src/commands/translateCommands.ts`:

```typescript
async executeSmartTranslate(plugin: AIOrganiserPlugin) {
    const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
        new Notice(plugin.t.messages.openNote);
        return;
    }

    const editor = view.editor;
    const selection = editor.getSelection();

    if (selection && selection.length > 0) {
        // Has selection - translate selection
        return this.translateSelection(editor, selection);
    }

    // No selection - translate full note
    new Notice(plugin.t.messages.translatingFullNote);
    return this.translateNote(view);
}
```

Register as single command:

```typescript
plugin.addCommand({
    id: 'smart-translate',
    name: plugin.t.commands.translate, // "Translate"
    icon: 'languages',
    editorCallback: (editor, view) => executeSmartTranslate(plugin)
});
```

### Step 2.2: Create EnhanceNoteModal

Create `src/ui/modals/EnhanceNoteModal.ts`:

```typescript
import { App, Modal, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';

interface EnhanceAction {
    id: string;
    icon: string;
    label: string;
    description: string;
    callback: () => void;
}

export class EnhanceNoteModal extends Modal {
    private plugin: AIOrganiserPlugin;

    constructor(app: App, plugin: AIOrganiserPlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('enhance-note-modal');

        contentEl.createEl('h2', { text: this.plugin.t.modals.enhance.title });

        const actions: EnhanceAction[] = [
            {
                id: 'improve',
                icon: '✨',
                label: this.plugin.t.modals.enhance.improve,
                description: this.plugin.t.modals.enhance.improveDesc,
                callback: () => this.executeAction('improve')
            },
            {
                id: 'diagram',
                icon: '📊',
                label: this.plugin.t.modals.enhance.diagram,
                description: this.plugin.t.modals.enhance.diagramDesc,
                callback: () => this.executeAction('diagram')
            },
            {
                id: 'resources',
                icon: '🔍',
                label: this.plugin.t.modals.enhance.resources,
                description: this.plugin.t.modals.enhance.resourcesDesc,
                callback: () => this.executeAction('resources')
            },
            {
                id: 'flashcards',
                icon: '📝',
                label: this.plugin.t.modals.enhance.flashcards,
                description: this.plugin.t.modals.enhance.flashcardsDesc,
                callback: () => this.executeAction('flashcards')
            }
        ];

        const actionsContainer = contentEl.createDiv({ cls: 'enhance-actions' });

        for (const action of actions) {
            const actionEl = actionsContainer.createDiv({ cls: 'enhance-action' });
            actionEl.createSpan({ text: action.icon, cls: 'enhance-icon' });

            const textEl = actionEl.createDiv({ cls: 'enhance-text' });
            textEl.createSpan({ text: action.label, cls: 'enhance-label' });
            textEl.createSpan({ text: action.description, cls: 'enhance-desc' });

            actionEl.addEventListener('click', () => {
                this.close();
                action.callback();
            });
        }
    }

    private executeAction(action: string) {
        // Route to existing command implementations
        switch (action) {
            case 'improve':
                // Call existing improveNote logic
                break;
            case 'diagram':
                // Call existing generateDiagram logic
                break;
            case 'resources':
                // Call existing findResources logic
                break;
            case 'flashcards':
                // Call existing exportFlashcards logic
                break;
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}
```

Register command:

```typescript
plugin.addCommand({
    id: 'enhance-note',
    name: plugin.t.commands.enhance, // "Enhance"
    icon: 'sparkles',
    callback: () => new EnhanceNoteModal(plugin.app, plugin).open()
});
```

---

## Phase 3: Scope Modals (Tag/Clear)

### Step 3.1: Create TagScopeModal

Create `src/ui/modals/TagScopeModal.ts`:

```typescript
import { App, Modal, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';

type TagScope = 'note' | 'folder' | 'vault';

export class TagScopeModal extends Modal {
    private plugin: AIOrganiserPlugin;
    private selectedScope: TagScope = 'note';
    private onConfirm: (scope: TagScope) => void;

    constructor(app: App, plugin: AIOrganiserPlugin, onConfirm: (scope: TagScope) => void) {
        super(app);
        this.plugin = plugin;
        this.onConfirm = onConfirm;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('tag-scope-modal');

        contentEl.createEl('h2', { text: this.plugin.t.modals.tagScope.title });

        // Radio buttons
        const options: { value: TagScope; label: string }[] = [
            { value: 'note', label: this.plugin.t.modals.tagScope.thisNote },
            { value: 'folder', label: this.plugin.t.modals.tagScope.currentFolder },
            { value: 'vault', label: this.plugin.t.modals.tagScope.entireVault }
        ];

        const radioGroup = contentEl.createDiv({ cls: 'scope-radio-group' });

        for (const option of options) {
            const radioEl = radioGroup.createDiv({ cls: 'scope-radio-option' });
            const input = radioEl.createEl('input', {
                type: 'radio',
                attr: { name: 'scope', value: option.value }
            });
            if (option.value === 'note') input.checked = true;

            radioEl.createEl('label', { text: option.label });

            input.addEventListener('change', () => {
                this.selectedScope = option.value;
            });
        }

        // Buttons
        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

        new Setting(buttonContainer)
            .addButton(btn => btn
                .setButtonText(this.plugin.t.modals.cancel)
                .onClick(() => this.close()))
            .addButton(btn => btn
                .setButtonText(this.plugin.t.modals.tagScope.tagButton)
                .setCta()
                .onClick(() => {
                    this.close();
                    this.onConfirm(this.selectedScope);
                }));
    }

    onClose() {
        this.contentEl.empty();
    }
}
```

### Step 3.2: Update generateCommands.ts

```typescript
plugin.addCommand({
    id: 'smart-tag',
    name: plugin.t.commands.tag, // "Tag"
    icon: 'tag',
    callback: () => {
        new TagScopeModal(plugin.app, plugin, async (scope) => {
            switch (scope) {
                case 'note':
                    await tagCurrentNote(plugin);
                    break;
                case 'folder':
                    await tagFolder(plugin);
                    break;
                case 'vault':
                    await tagVault(plugin);
                    break;
            }
        }).open();
    }
});
```

### Step 3.3: Create ClearTagsScopeModal

Same pattern as TagScopeModal, but for clearing tags.

---

## Phase 4: Index Management + Cleanup

### Step 4.1: Create ManageIndexModal

Create `src/ui/modals/ManageIndexModal.ts`:

```typescript
// Button-based modal with Build/Update/Clear actions
// Each button calls existing index management functions
```

### Step 4.2: Update Command Registration

In `src/commands/index.ts`, update to register only the new consolidated commands:

**Keep these commands:**
- `smart-summarize`
- `smart-translate`
- `smart-tag`
- `clear-tags`
- `enhance-note`
- `find-related` (existing, keep as-is)
- `semantic-search` (existing, keep as-is)
- `manage-index` (new)
- `tag-network` (existing, keep as-is)
- `export-tags` (existing, keep as-is)
- `chat-with-vault` (existing, keep as-is)
- `open-command-picker` (existing, keep as-is)

**Remove these commands:**
- Individual summarize commands (url, pdf, youtube, audio)
- Individual translate commands (note, selection)
- Individual tag scope commands (note, folder, vault)
- Individual clear commands (note, folder, vault)
- Individual smart note commands (improve, diagram, resources)
- Individual index commands (build, update, clear)

### Step 4.3: Update CommandPickerModal

Update `src/ui/modals/CommandPickerModal.ts`:
- Update command list to show new consolidated commands
- Add aliases so searching "youtube" still finds "Summarize"
- Update categories

### Step 4.4: Update i18n Files

Add all new translation keys to both `en.ts` and `zh-cn.ts`.

---

## Testing Checklist

After each phase, verify:

### Phase 1 (Summarize)
- [ ] `Cmd+P` → "Summarize" shows single command
- [ ] With cursor on YouTube URL → auto-summarizes YouTube
- [ ] With cursor on PDF embed → auto-summarizes PDF
- [ ] With cursor on regular URL → auto-summarizes URL
- [ ] With text selection → summarizes selection
- [ ] With no context → shows source modal
- [ ] Modal remembers last selection

### Phase 2 (Translate + Enhance)
- [ ] "Translate" with selection → translates selection
- [ ] "Translate" without selection → translates full note
- [ ] "Enhance" opens action menu
- [ ] Each enhance action works correctly

### Phase 3 (Tag/Clear)
- [ ] "Tag" opens scope modal
- [ ] Scope modal defaults to "This note"
- [ ] Each scope works correctly
- [ ] "Clear Tags" follows same pattern

### Phase 4 (Index + Cleanup)
- [ ] "Manage Index" shows build/update/clear options
- [ ] Old command IDs no longer appear in command palette
- [ ] Searching old command names still finds new commands
- [ ] Build succeeds with no TypeScript errors

---

## Code Conventions

Follow existing patterns in the codebase:

1. **Modal naming:** `[Feature]Modal.ts` in `src/ui/modals/`
2. **i18n access:** `this.plugin.t.section.key`
3. **Settings access:** `this.plugin.settings.propertyName`
4. **Notices:** `new Notice(this.plugin.t.messages.key)`
5. **CSS classes:** `ai-organiser-*` prefix

---

## Files Summary

### Create (6 files)
- `src/utils/contentDetection.ts`
- `src/ui/modals/SummarizeSourceModal.ts`
- `src/ui/modals/EnhanceNoteModal.ts`
- `src/ui/modals/TagScopeModal.ts`
- `src/ui/modals/ClearTagsScopeModal.ts`
- `src/ui/modals/ManageIndexModal.ts`

### Modify (8 files)
- `src/commands/summarizeCommands.ts`
- `src/commands/translateCommands.ts`
- `src/commands/generateCommands.ts`
- `src/commands/clearCommands.ts`
- `src/commands/index.ts`
- `src/ui/modals/CommandPickerModal.ts`
- `src/i18n/en.ts`
- `src/i18n/zh-cn.ts`

---

## Success Criteria

1. **Command count:** 27 → 12 commands in palette
2. **Click reduction:** Common flows complete in 1 click (smart detection)
3. **Zero feature loss:** All original functionality accessible
4. **Clean build:** `npm run build` succeeds
5. **Tests pass:** `npm test` passes (if applicable)

---

## Questions?

Reference the proposal document for detailed modal designs and logic flows:
`docs/command-consolidation-proposal.md`
