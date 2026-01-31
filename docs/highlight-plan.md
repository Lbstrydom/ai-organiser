# Highlight & Chat — Discuss Passages with AI

## Goal

Let users select passages in the current note (both existing `<mark>` highlights AND ephemeral in-modal selections), then have a multi-turn AI conversation focused on those passages. When satisfied, the user can ask the AI to generate a summary or specific output for insertion into the note.

## Review Fixes Applied

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 1 | High | **Paragraph Fallacy** — splitting by double newlines is too brittle for lists, callouts, code blocks, tables | Block-aware parser: track code fences, callouts, list runs, tables as atomic blocks. Never split inside these structures. |
| 2 | High | **Context Window Limits** — 4000 char hard cap is outdated for 128k+ context models | Remove hard cap. Show token estimate in UI (chars/4 heuristic). Let LLM handle context naturally. |
| 3 | High | **Reference Hallucinations** — LLM may produce `[Passage 1]` references that are meaningless when inserted into note | Anti-hallucination instruction in insert prompts: "Write as standalone prose. Do NOT reference passages by number." |
| 4 | Medium | **Hard-Coding Prompts** — prompts inline in modal violate codebase convention | Move all prompts to `src/services/prompts/highlightChatPrompts.ts` |
| 5 | Medium | **Regex vs AST** — code-fence content can contain `==` or `<mark>` that shouldn't be detected as highlights | Code-fence-aware extraction: skip content between ``` fences when detecting highlights |
| 6 | Medium | **Smart Pre-Selection** — editor selection should skip straight to chat, no selection should show full picker | Two entry points: selection present → quick chat (skip picker); no selection → paragraph picker with highlights pre-selected |
| 7 | Low | **Non-Text Elements** — images, embeds, tables need handling in passage display | Show placeholders: `[Image: filename.png]`, `[Embed: note.md]`, `[Table: N rows]` |
| 8 | Low | **State Management** — chat history must survive "Back" navigation | Chat history preserved in class field. "Back" only re-renders selection UI; messages array untouched. |

## User Workflow

### Path A: Editor Selection (Quick Chat)
1. User selects text in the editor
2. Activates "Chat about highlights" command
3. Modal opens directly in **chat phase** with selection as context
4. User asks questions, gets contextual answers
5. "Insert Summary" or "Insert Last Answer" when done

### Path B: No Selection (Paragraph Picker)
1. User activates "Chat about highlights" with no selection
2. Modal opens in **selection phase** showing note split into blocks
3. Existing `<mark>` and `==highlight==` passages are pre-selected
4. User clicks blocks to add/remove focus areas
5. Clicks "Start Chat" to enter chat phase
6. Same chat + insert flow as Path A

## UI Design

### Phase 1: Block Selection (Path B only)
```
+-------------------------------------------+
|  Chat About Highlights                    |
|                                           |
|  Select passages to discuss:              |
|  +-----------------------------------+   |
|  | [x] Paragraph with existing        |   |  <- pre-selected (has <mark>)
|  |     highlight markup shown          |   |
|  | [ ] Normal paragraph text that      |   |  <- click to toggle
|  |     the user can select too         |   |
|  | [x] Another ==highlighted==         |   |  <- pre-selected
|  |     paragraph from the note         |   |
|  | [ ] More content from the note      |   |
|  +-----------------------------------+   |
|  Selected: 2 passages (~1.2k tokens)     |
|                                           |
|           [ Start Chat ]                  |
+-------------------------------------------+
```

### Phase 2: Chat (Both paths)
```
+-------------------------------------------+
|  Chat About Highlights            [Back]  |
|  +-----------------------------------+   |
|  | 2 passages selected (expand)       |   |  <- collapsed summary
|  +-----------------------------------+   |
|  +-----------------------------------+   |
|  | You: What does this mean?          |   |
|  |                                    |   |
|  | AI: Based on the highlighted       |   |
|  | passages, this refers to...        |   |
|  |                                    |   |
|  | You: Can you explain it simpler?   |   |
|  |                                    |   |
|  | AI: Sure, in simple terms...       |   |
|  +-----------------------------------+   |
|  +-----------------------------------+   |
|  | Ask a question...        [Send]    |   |
|  +-----------------------------------+   |
|  [ Insert Summary ] [ Insert Answer ]    |
+-------------------------------------------+
```

## Architecture

### Block-Aware Content Parser (`src/utils/highlightExtractor.ts`)

Replaces naive double-newline splitting with a state-machine parser that respects document structure.

**Block types recognized:**
- **Paragraph**: Consecutive non-empty lines not inside other structures
- **Code fence**: Lines between ``` markers (atomic, never split)
- **Callout**: `> [!type]` blocks (atomic)
- **List run**: Consecutive `- `, `* `, `1. ` lines (atomic group)
- **Table**: Lines starting with `|` (atomic)
- **Heading**: `# ` lines (standalone block, serves as visual separator)

**Algorithm:**
```
state = 'default'
currentBlock = []

for each line:
  if state == 'code-fence' and line matches closing ```:
    close code block, push as single block
  elif line matches opening ```:
    state = 'code-fence', start accumulating
  elif state == 'code-fence':
    accumulate (never split)
  elif line is blank:
    flush currentBlock, push as paragraph
  elif line starts with '> [!':
    start callout block
  elif line starts with list marker and continues list:
    accumulate into list block
  elif line starts with '|':
    accumulate into table block
  else:
    accumulate into paragraph
```

**Interfaces:**
```typescript
export interface ContentBlock {
    text: string;           // Raw text (markup preserved)
    displayText: string;    // Cleaned for UI display (markup stripped, truncated)
    lineStart: number;
    lineEnd: number;
    type: 'paragraph' | 'code' | 'callout' | 'list' | 'table' | 'heading';
    hasHighlight: boolean;  // Contains <mark> or ==text==
}

export function splitIntoBlocks(content: string): ContentBlock[]
export function extractHighlightedPassages(content: string): HighlightedPassage[]
export function stripHighlightMarkup(text: string): string
```

**Code-fence-aware highlight extraction:**
```typescript
// Skip code fences when detecting highlights
// Track fence state: inside ``` → don't match <mark> or ==text==
export function extractHighlightedPassages(content: string): HighlightedPassage[] {
    const passages: HighlightedPassage[] = [];
    let inCodeFence = false;

    for (const [lineNum, line] of content.split('\n').entries()) {
        if (line.trimStart().startsWith('```')) {
            inCodeFence = !inCodeFence;
            continue;
        }
        if (inCodeFence) continue;

        // Match <mark class="ao-highlight...">text</mark>
        // Match ==text==
        // ... accumulate passages
    }
    return passages;
}
```

**Non-text element handling (Finding #7):**
- `![[image.png]]` → display as `[Image: image.png]`
- `![[note.md]]` → display as `[Embed: note.md]`
- Tables → display as `[Table: N rows]` in collapsed view, full in expanded
- Code blocks → display with syntax highlighting class, truncated to 3 lines in list

### Prompt Module (`src/services/prompts/highlightChatPrompts.ts`)

All prompts in dedicated file following codebase convention.

```typescript
/**
 * Build the system context + user question for highlight chat.
 * Selected passages injected as context in every LLM call.
 */
export function buildHighlightChatPrompt(
    question: string,
    selectedPassages: string[],
    noteTitle: string,
    conversationHistory: ChatMessage[]
): string;

/**
 * Build prompt for generating insertable summary.
 * Anti-hallucination: instructs LLM to write standalone prose,
 * never reference passages by number or position.
 */
export function buildInsertSummaryPrompt(
    selectedPassages: string[],
    conversationHistory: ChatMessage[],
    noteTitle: string
): string;

/**
 * Build prompt for generating insertable answer from last exchange.
 */
export function buildInsertAnswerPrompt(
    lastQuestion: string,
    lastAnswer: string,
    selectedPassages: string[],
    noteTitle: string
): string;
```

**Chat prompt structure:**
```xml
<task>
You are helping the user understand specific passages from their note "{noteTitle}".
Answer based primarily on the highlighted passages below.
Reference broader context when relevant, but keep focus on the highlighted content.
</task>

<highlighted_passages>
{passages with clean numbering for LLM reference only}
</highlighted_passages>

<conversation_history>
{prior messages if any}
</conversation_history>

<question>
{user's question}
</question>
```

**Insert summary prompt (anti-hallucination, Finding #3):**
```xml
<task>
Based on the conversation about passages from "{noteTitle}",
write a concise, well-structured section suitable for inserting into the note.

CRITICAL: Write as standalone prose. Do NOT reference "Passage 1", "the highlighted text",
or any positional references. The reader has no knowledge of the conversation or passage numbering.
Use markdown formatting. Be concise.
</task>
```

### HighlightChatModal (`src/ui/modals/HighlightChatModal.ts`)

**Constructor:**
```typescript
interface HighlightChatOptions {
    noteContent: string;
    noteTitle: string;
    filePath: string;
    editorSelection?: string;   // If present, skip to chat phase (Path A)
}
```

**State:**
```typescript
private phase: 'select' | 'chat' = 'select';
private blocks: ContentBlock[] = [];
private selectedIndices: Set<number> = new Set();
private messages: ChatMessage[] = [];        // Preserved across phase switches (Finding #8)
private isProcessing: boolean = false;
```

**Smart entry (Finding #6):**
```typescript
onOpen() {
    if (this.options.editorSelection?.trim()) {
        // Path A: editor selection → skip directly to chat
        this.selectedPassageTexts = [this.options.editorSelection];
        this.phase = 'chat';
        this.renderChatPhase();
    } else {
        // Path B: no selection → show block picker
        this.blocks = splitIntoBlocks(this.options.noteContent);
        this.preSelectHighlightedBlocks();
        this.phase = 'select';
        this.renderSelectionPhase();
    }
}
```

**Selection phase rendering** (MultiSourceModal checkbox pattern):
- Scrollable list of content blocks with checkboxes
- Blocks with highlights get accent border + pre-checked
- Click anywhere on row to toggle
- Token estimate shown: `Selected: N passages (~Xk tokens)` (chars/4 heuristic, Finding #2)
- "Start Chat" button disabled if nothing selected

**Chat phase:**
- Collapsed passage summary at top (expandable)
- Scrollable chat container (ChatWithVaultModal pattern)
- TextArea input with Enter to send, Shift+Enter for newline
- "Back" button returns to selection (preserves messages, Finding #8)
- "Insert Summary" and "Insert Last Answer" buttons at bottom

**LLM calls** — use existing facade:
```typescript
const prompt = buildHighlightChatPrompt(question, selectedTexts, this.noteTitle, this.messages);
const response = await summarizeText(pluginContext(this.plugin), prompt);
```

**Insert at cursor:**
```typescript
const editor = this.app.workspace.activeEditor?.editor;
if (!editor) {
    new Notice(t.highlightChat?.noEditor || 'No active editor');
    return;
}
editor.replaceSelection(generatedText);
```

**No RAG dependency** — works without semantic search. Context comes from note content directly.

### Command Registration (`src/commands/chatCommands.ts`)

```typescript
plugin.addCommand({
    id: 'chat-about-highlights',
    name: plugin.t.commands.chatAboutHighlights || 'Chat about highlights',
    icon: 'message-square-quote',
    editorCallback: async (editor, view) => {
        const file = view.file;
        if (!file) return;
        const content = editor.getValue();
        if (!content.trim()) {
            new Notice(plugin.t.highlightChat?.noContent || 'Note is empty');
            return;
        }
        const selection = editor.getSelection();
        new HighlightChatModal(plugin.app, plugin, {
            noteContent: content,
            noteTitle: file.basename,
            filePath: file.path,
            editorSelection: selection || undefined,  // Path A vs Path B
        }).open();
    }
});
```

### Command Picker (`CommandPickerModal.ts`)

Add to Discover > Ask AI group (3rd sub-command):
```typescript
{
    id: 'chat-about-highlights',
    name: t.commands.chatAboutHighlights,
    icon: 'message-square-quote',
    aliases: ['highlight', 'chat', 'discuss', 'passages', 'selected', 'focus'],
    callback: () => executeCommand('ai-organiser:chat-about-highlights')
}
```

## Files to Create

| File | Purpose |
|------|---------|
| `src/ui/modals/HighlightChatModal.ts` | Two-phase modal: block selection -> chat -> insert |
| `src/utils/highlightExtractor.ts` | Block-aware parser + highlight extraction (testable utility) |
| `src/services/prompts/highlightChatPrompts.ts` | All LLM prompts for highlight chat |

## Files to Modify

| File | Change |
|------|--------|
| `src/commands/chatCommands.ts` | Register `chat-about-highlights` command |
| `src/ui/modals/CommandPickerModal.ts` | Add to Discover > Ask AI group |
| `src/i18n/types.ts` | Add `highlightChat` i18n section + `chatAboutHighlights` command |
| `src/i18n/en.ts` | English strings |
| `src/i18n/zh-cn.ts` | Chinese strings |
| `styles.css` | Modal styles for selection + chat phases |
| `tests/commandPicker.test.ts` | Update Ask AI group assertion (3 sub-commands) |
| `tests/highlightExtractor.test.ts` | Unit tests for block parser + highlight extraction |

## i18n Keys

```typescript
// In commands section:
chatAboutHighlights: string;    // "Chat about highlights"

// New section:
highlightChat: {
    title: string;                  // "Chat About Highlights"
    selectPassages: string;         // "Select passages to discuss:"
    selected: string;               // "Selected: {count} passages (~{tokens}k tokens)"
    noPassagesSelected: string;     // "Select at least one passage"
    startChat: string;              // "Start Chat"
    back: string;                   // "Back to selection"
    placeholder: string;            // "Ask a question about the selected passages..."
    send: string;                   // "Send"
    thinking: string;               // "Thinking..."
    insertSummary: string;          // "Insert Summary"
    insertSummaryDesc: string;      // "AI distills the conversation into a clean note section"
    insertAnswer: string;           // "Insert Last Answer"
    insertAnswerDesc: string;       // "Insert only the last AI response"
    noContent: string;              // "Note is empty"
    noEditor: string;               // "No active editor for insertion"
    summaryInserted: string;        // "Summary inserted into note"
    answerInserted: string;         // "Answer inserted into note"
    passagesSummary: string;        // "{count} passages selected"
    errorOccurred: string;          // "Error: {error}"
};
```

## CSS Styles

```css
/* Selection phase */
.ai-organiser-hc-container { max-height: 60vh; overflow-y: auto; }
.ai-organiser-hc-block {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 8px 12px; cursor: pointer; border-radius: 4px;
    border-bottom: 1px solid var(--background-modifier-border);
}
.ai-organiser-hc-block:hover { background: var(--background-modifier-hover); }
.ai-organiser-hc-block-highlighted { border-left: 3px solid var(--text-accent); }
.ai-organiser-hc-block-text {
    flex: 1; font-size: 0.9em; color: var(--text-normal);
    line-height: 1.4; word-break: break-word;
}
.ai-organiser-hc-block-code { font-family: var(--font-monospace); font-size: 0.85em; }
.ai-organiser-hc-block-type {
    font-size: 0.75em; color: var(--text-faint); text-transform: uppercase;
    min-width: 50px;
}
.ai-organiser-hc-selection-count { text-align: center; color: var(--text-muted); padding: 8px 0; }

/* Chat phase */
.ai-organiser-hc-chat-container {
    max-height: 40vh; overflow-y: auto; padding: 8px;
    border: 1px solid var(--background-modifier-border); border-radius: 6px;
    margin-bottom: 8px;
}
.ai-organiser-hc-message { padding: 8px 12px; margin-bottom: 8px; border-radius: 6px; }
.ai-organiser-hc-message-user { background: var(--background-modifier-hover); text-align: right; }
.ai-organiser-hc-message-assistant { background: var(--background-secondary); }
.ai-organiser-hc-input-row { display: flex; gap: 8px; margin-bottom: 8px; }
.ai-organiser-hc-input { flex: 1; }
.ai-organiser-hc-actions { display: flex; gap: 8px; justify-content: center; padding: 8px 0; }
.ai-organiser-hc-passage-summary {
    background: var(--background-secondary); padding: 8px 12px;
    border-radius: 4px; font-size: 0.85em; color: var(--text-muted);
    margin-bottom: 8px; cursor: pointer;
}
```

## Edge Cases

- **No highlights in note**: All blocks unselected by default. User must manually select at least one.
- **Empty note**: Show notice, don't open modal.
- **No active editor for insertion**: Disable insert buttons with tooltip.
- **Code blocks containing `==` or `<mark>`**: Code-fence-aware parser skips highlight detection inside fences (Finding #5).
- **No LLM configured**: Fails with standard error from facade.
- **Frontmatter**: Stripped from block list (not selectable).
- **Mobile**: Single-column layout works naturally. Touch targets adequate (full row is clickable).
- **"Back" navigation**: Chat messages preserved in class field. Only UI re-renders (Finding #8).
- **Very long note**: Block list is scrollable. Only selected block texts sent to LLM. Token estimate displayed (Finding #2).
- **Editor selection with no highlights**: Path A — selection becomes sole context for chat. No block picker shown.

## Test Plan

### Unit Tests (`tests/highlightExtractor.test.ts`)
- `splitIntoBlocks()`: paragraph, code fence, callout, list, table, heading
- Code fence not split in middle
- Callout treated as atomic block
- List run grouped as single block
- `extractHighlightedPassages()`: `<mark>` tags, `==text==` syntax
- Highlights inside code fences NOT detected (Finding #5)
- `stripHighlightMarkup()`: removes tags, preserves content
- Non-text placeholders: images, embeds, tables

### Integration Tests (`tests/commandPicker.test.ts`)
- Ask AI group has 3 sub-commands (was 2)
- `chat-about-highlights` present in group

### Manual Testing
1. Open note with existing highlights -> command -> highlights pre-selected
2. Open note without highlights -> all blocks unselected -> select manually
3. Select text in editor -> command -> skip to chat (Path A)
4. Start chat -> ask question -> get contextual answer
5. Multi-turn: ask follow-up -> AI uses conversation history
6. "Insert Summary" -> standalone prose inserted (no `[Passage 1]` references)
7. "Insert Last Answer" -> last AI response inserted
8. "Back" -> returns to selection (chat history preserved)
9. Command picker: Discover > Ask AI > shows 3 commands
10. Code block with `==text==` inside -> NOT detected as highlight
11. Mobile: modal renders, touch selection works

## Verification

```bash
npm run build    # type-check + tests + i18n parity
```

Then deploy and test manually per checklist above.

## Progress

- ✅ Implementation complete (feature, prompts, command, UI, tests).
- ✅ Build + automated tests passed on 2026-01-31.
- ✅ Dual audit refactor complete on 2026-01-31 (12 findings: DRY, SOLID, dead code, UX/Gestalt).
- ✅ 878 tests passing (40 suites) + 17 integration tests.
- ⏳ Manual QA pending (see Manual Testing checklist above).
