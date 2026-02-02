# Chat UX Improvements + Minutes Folder Selection

## Four Features

1. **Markdown rendering** in assistant chat messages (ChatWithVault + HighlightChat)
2. **Conversation history** — send previous messages to LLM for follow-up context
3. **Chat export** — save conversations to markdown files with folder confirmation
4. **Minutes folder selection** — editable output folder field in the Minutes modal

## Design Decisions

- **Export only in ChatWithVault** — HighlightChat already has "Insert Summary" / "Insert Answer" as output mechanisms. Adding export there adds complexity for little value.
- **chatExportFolder as subfolder** — stored under pluginFolder, consistent with Canvas/Minutes/Transcripts pattern.
- **Folder edits are one-off** — export confirmation dialog overrides the default for that export only. Does not persist back to settings. Consistent with no other feature persisting modal-level folder changes.

---

## Feature 1: Markdown Rendering in Chat Messages

**Problem**: Assistant responses show raw `**bold**`, `##` headers instead of rendered formatting.

**Fix**: Use `MarkdownRenderer.render()` for assistant messages. User/system stay plain text.

**Lifecycle fix**: Since `renderMessages()` re-renders ALL messages every send, the Component's internal child list would grow unboundedly. Fix: reset the Component at the start of each `renderMessages()` call.

### `src/commands/chatCommands.ts`

- Import `MarkdownRenderer, Component` from obsidian
- Add `private component!: Component` field
- In `renderMessages()`, at the top (before `chatContainer.empty()`):
  ```typescript
  this.component?.unload();
  this.component = new Component();
  this.component.load();
  ```
- For `message.role === 'assistant'`: use `MarkdownRenderer.render(this.app, message.content, contentEl, '', this.component)` instead of `contentEl.textContent`
- In `onClose()`: `this.component?.unload();`

### `src/ui/modals/HighlightChatModal.ts`

- Same Component lifecycle pattern in `renderMessages()`
- Line 264: replace `messageEl.createDiv({ text: message.content })` with:
  ```typescript
  const contentDiv = messageEl.createDiv({ cls: 'ai-organiser-hc-message-content' });
  if (message.role === 'assistant') {
      MarkdownRenderer.render(this.app, message.content, contentDiv, '', this.component!);
  } else {
      contentDiv.textContent = message.content;
  }
  ```
  Using a dedicated wrapper div avoids the CSS issue where `<strong>` role label is a sibling — `p:first-child` won't match otherwise.

### `styles.css`

```css
/* Markdown inside chat assistant bubbles */
.chat-message-assistant .chat-message-content > p:first-child,
.ai-organiser-hc-message-content > p:first-child { margin-top: 0; }
.chat-message-assistant .chat-message-content > p:last-child,
.ai-organiser-hc-message-content > p:last-child { margin-bottom: 0; }
.chat-message-assistant .chat-message-content pre,
.ai-organiser-hc-message-content pre { margin: 8px 0; }
```

**No i18n changes needed.**

---

## Feature 2: Conversation History (Memory)

**Problem**: `handleSend()` only sends the current query. Follow-ups lose context.

### `src/commands/chatCommands.ts`

Add constants:
```typescript
const MAX_HISTORY_MESSAGES = 20;
const MAX_HISTORY_CHARS = 8000;
```

Add method — **excludes the last message** (just-added user query, already in the prompt) to avoid duplication. Same pattern as HighlightChat `this.messages.slice(0, -1)`:
```typescript
private formatConversationHistory(): string {
    const relevant = this.messages
        .filter(m => m.role !== 'system')
        .slice(0, -1)                    // exclude the just-added user query
        .slice(-MAX_HISTORY_MESSAGES);
    if (relevant.length === 0) return '';
    let history = relevant
        .map(m => `${m.role.toUpperCase()}: ${m.content}`)
        .join('\n');
    if (history.length > MAX_HISTORY_CHARS) {
        history = '...' + history.slice(history.length - MAX_HISTORY_CHARS);
    }
    return history;
}
```

In `handleSend()`, inject history into both prompt paths:
```typescript
const conversationHistory = this.formatConversationHistory();
const historySection = conversationHistory
    ? `\n<conversation_history>\n${conversationHistory}\n</conversation_history>\n`
    : '';

// RAG path: append to system prompt
const systemPrompt = 'You are a helpful assistant that answers questions based on the user\'s personal knowledge vault.' + historySection;
prompt = this.ragService.buildRAGPrompt(query, context, systemPrompt);

// Fallback path: append to fallback prompt
prompt = `You are a helpful assistant...${historySection}\n\nUser question: ${query}`;
```

RAG retrieval still uses only the latest query — correct since we search for the new topic.

**No i18n or settings changes needed.**

---

## Feature 3: Chat Export

**Problem**: Conversations lost on modal close.

### `src/core/settings.ts`

- Add `chatExportFolder: string` to `AIOrganiserSettings` (default: `'Chats'`)
- Add to `DEFAULT_SETTINGS`
- Add resolver:
  ```typescript
  export function getChatExportFullPath(settings: AIOrganiserSettings): string {
      return resolvePluginPath(settings, settings.chatExportFolder, 'Chats');
  }
  ```

### i18n

**`src/i18n/types.ts`** — add to `modals.chatWithVault`:
```typescript
exportButton: string;
exportTitle: string;
exportFolderLabel: string;
exportConfirmButton: string;
exportSuccess: string;
exportEmpty: string;
```

Add to `settings.semanticSearch`:
```typescript
chatExportFolder: string;
chatExportFolderDesc: string;
```

**`en.ts`** + **`zh-cn.ts`** — corresponding translations.

### `src/commands/chatCommands.ts`

Add "Export Chat" button next to Clear in `onOpen()`.

`handleExport()`:
1. Check non-system messages exist (show Notice if empty)
2. Call `promptExportFolder()` — small modal with editable text field pre-filled with `getChatExportFullPath()`
3. Use `ensureFolderExists()` from `minutesUtils.ts` for safe folder creation
4. Use `getAvailableFilePath()` from `minutesUtils.ts` for collision-safe filenames
5. Generate filename: `Chat-YYYY-MM-DD-HHmm.md`
6. Format:
   ```markdown
   # Chat with Vault — {date}

   **You** ({time}):

   {content}

   ---

   **Assistant** ({time}):

   {content}

   Sources: [[note1]], [[note2]]

   ---
   ```
7. Write file, show Notice with path

`promptExportFolder()`:
- Small modal: text field + Export/Cancel buttons
- Returns `Promise<string | null>`
- One-off override, does NOT persist to settings

### `src/ui/settings/SemanticSearchSettingsSection.ts`

Add text field for `chatExportFolder` in RAG subsection near vault chat toggle. Same pattern as `canvasOutputFolder` in CanvasSettingsSection.

---

## Feature 4: Minutes Folder Selection

**Problem**: Minutes go directly to configured folder with no confirmation.

### `src/ui/modals/MinutesCreationModal.ts`

Add `outputFolder` to `this.state`:
```typescript
outputFolder: getMinutesOutputFullPath(this.plugin.settings),
```

Add output folder field in form (near bottom, before submit). Use **dedicated i18n keys** (not settings keys, since `settings.minutes.outputFolder` is a plain string, not `{ name, description }`):

```typescript
new Setting(container)
    .setName(t?.outputFolderLabel || 'Output folder')
    .addText(text => text
        .setValue(this.state.outputFolder)
        .onChange(v => { this.state.outputFolder = v.trim(); }));
```

In `handleSubmit()` line 523:
```typescript
outputFolder: this.state.outputFolder || getMinutesOutputFullPath(this.plugin.settings),
```

### i18n

**`types.ts`** — add to `minutes` modal translations (wherever the minutes modal i18n keys live):
```typescript
outputFolderLabel: string;
```

**`en.ts`**: `outputFolderLabel: 'Output folder'`
**`zh-cn.ts`**: `outputFolderLabel: '输出文件夹'`

---

## Tests

### New tests in `tests/pathUtils.test.ts` (extend existing)
- `getChatExportFullPath()` — returns correct path under pluginFolder

### New test file `tests/chatExport.test.ts`
- `formatConversationHistory()` — excludes system messages, excludes last message, respects MAX_HISTORY_CHARS truncation, returns empty string when no history
- Export markdown formatting — correct structure, timestamps, sources as wikilinks

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/commands/chatCommands.ts` | Component lifecycle, markdown rendering, conversation history, export button + handler |
| `src/ui/modals/HighlightChatModal.ts` | Component lifecycle, markdown rendering with content wrapper div |
| `src/core/settings.ts` | `chatExportFolder` setting + default + resolver |
| `src/i18n/types.ts` | Chat export keys, minutes outputFolderLabel, semanticSearch chatExportFolder |
| `src/i18n/en.ts` | English translations |
| `src/i18n/zh-cn.ts` | Chinese translations |
| `styles.css` | Markdown margin fixes for chat bubbles |
| `src/ui/settings/SemanticSearchSettingsSection.ts` | Chat export folder text field |
| `src/ui/modals/MinutesCreationModal.ts` | outputFolder state field, editable text field, use in handleSubmit |
| `tests/pathUtils.test.ts` | getChatExportFullPath test |
| `tests/chatExport.test.ts` | New: history formatting + export formatting tests |

## Implementation Order

1. Feature 1 (Markdown rendering) — self-contained
2. Feature 2 (Conversation history) — same file, no deps
3. Feature 3 (Chat export) — settings + i18n + tests
4. Feature 4 (Minutes folder) — independent

## Verification

### Automated
- `npm run build` passes
- New tests for path helper, history formatting, export formatting

### Manual
- [ ] Send query returning markdown — assistant renders headers/bold/lists/code properly
- [ ] User messages stay plain text, system messages stay italic
- [ ] Close and reopen modal — no memory leaks from Component lifecycle
- [ ] Ask follow-up question — LLM references prior answer
- [ ] Ask 3-4 questions — conversation stays coherent
- [ ] Click Export Chat with no messages — shows "no messages" notice
- [ ] Export chat — folder confirm modal with default path
- [ ] Change folder, export — file in correct location with collision-safe name
- [ ] Export again same minute — gets ` (2)` suffix
- [ ] Open exported file — proper markdown with timestamps and wikilink sources
- [ ] Minutes modal — output folder field visible with default
- [ ] Change minutes folder, generate — file goes to new folder
- [ ] HighlightChat — assistant markdown renders, user stays plain text
