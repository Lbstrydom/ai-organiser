# Menu Cleanup & Integration Enhancement Plan

## Overview

Five changes:
1. **Remove `generate-from-embedded`** — redundant with `smart-summarize`
2. **Enhance Pending Integration** — placement, format, detail dropdowns + auto-tag toggle
3. **Add "Insert at cursor" to Translate Note** — cross-cutting pattern where applicable
4. **DRY: Shared content insertion utility** — `src/utils/editorUtils.ts`
5. **Summary result preview modal** — review before inserting

---

## Part 1: Remove generate-from-embedded

**Status: APPROVED — no changes from v1**

`smart-summarize` already detects embedded PDFs, audio, documents, and YouTube via `MultiSourceModal`. The only gap is image support (multimodal), which is a niche edge case.

### Files to modify

| File | Action |
|------|--------|
| `src/commands/smartNoteCommands.ts` | Remove command block (lines 33-92), `hasTextContent()`, `processSelectedContent()`, `insertGeneratedNote()`, and orphaned imports |
| `src/ui/modals/ContentSelectionModal.ts` | **Delete file** — only consumer was generate-from-embedded |
| `src/ui/modals/CommandPickerModal.ts` | Remove `generate-from-embedded` entry from Create category |
| `src/i18n/types.ts` | Remove `generateFromEmbedded` from commands; remove `contentSelection` interface |
| `src/i18n/en.ts` | Remove `generateFromEmbedded`, `contentSelection` block, and orphaned message keys |
| `src/i18n/zh-cn.ts` | Mirror en.ts removals |
| `tests/commandPicker.test.ts` | Remove from mock translations and assertions |

---

## Part 2: Enhanced Pending Integration

### Review feedback applied

| Feedback | Action taken |
|----------|-------------|
| "Weave" is dangerous — LLM might hallucinate/delete user content | Renamed to **"Merge into sections"**, moved to last in dropdown (not default). Added **"Insert at cursor"** as safest default. |
| Missing "Format" dropdown | Added: Prose / Bullet points / Action items / Table |
| "Length" too simple | Kept but reframed as "Detail level" with clearer labels |
| Auto-link concepts ("Linkify") | **Defer to v2** — requires vault-wide wikilink scanning |
| Save as new note & link ("Atomic") | **Defer to v2** — different UX flow, separate command |

### Strategy Dimensions (3 dropdowns + 1 toggle)

**1. Placement** — where the content goes:

| Value | Label | Behaviour | Safety |
|-------|-------|-----------|--------|
| `cursor` (default) | Insert at cursor | Drop AI-processed content at cursor position. Existing note untouched. | Safest |
| `append` | Add as new section(s) | Append at end of main content with new headings | Safe |
| `callout` | Add as callouts | LLM rewrites note inserting `> [!info]` blocks next to relevant sections. Prompt forbids modifying existing text, but uses `replaceMainContent()` so rewrite risk exists. | Moderate |
| `merge` | Merge into sections | AI rewrites main body to weave in new content by topic. Most powerful but rewrites existing text. | Use with care |

**2. Format** — output structure (NEW):

| Value | Label | Prompt behaviour |
|-------|-------|-----------------|
| `prose` (default) | Prose | Standard paragraph format |
| `bullets` | Bullet points | Organised as bullet lists under headings |
| `tasks` | Action items | Checkbox format: `- [ ] Task description` |
| `table` | Table | Markdown table with columns appropriate to content |

**3. Detail level** (renamed from "Length"):

| Value | Label | Prompt behaviour |
|-------|-------|-----------------|
| `full` (default) | Full detail | Include all new knowledge |
| `concise` | Concise | Key points only, tighten prose |
| `summary` | Summary only | Distil to essential insights before integrating |

**4. Auto-tag toggle** — re-tag note after integration (default off).

### Constants — `src/core/constants.ts`

```typescript
export type PlacementStrategy = 'cursor' | 'append' | 'callout' | 'merge';
export type FormatStrategy = 'prose' | 'bullets' | 'tasks' | 'table';
export type DetailStrategy = 'full' | 'concise' | 'summary';
export const DEFAULT_PLACEMENT_STRATEGY: PlacementStrategy = 'cursor';
export const DEFAULT_FORMAT_STRATEGY: FormatStrategy = 'prose';
export const DEFAULT_DETAIL_STRATEGY: DetailStrategy = 'full';
```

### Integration command changes — `src/commands/integrationCommands.ts`

**`IntegrationConfirmModal`** (lines 456-541):
- Add fields: `selectedPlacement`, `selectedFormat`, `selectedDetail`, `autoTag`
- Update `onConfirm` signature: `(persona, placement, format, detail, autoTag)`
- In `onOpen()`, after persona selector, add 3 dropdowns + 1 toggle using `new Setting().addDropdown()`
- Dropdown options built from i18n keys (no hardcoded labels)
- **Merge warning**: When `merge` is selected in the Placement dropdown, show `placementMergeWarn` text as the dropdown's `desc` (Obsidian `Setting.setDesc()`). Update desc dynamically on dropdown change.

**`integrate-pending-content` command** (lines 62-125):
- Receive all params from modal callback
- **Guard change**: Existing code blocks when `mainContent` is empty. For `cursor`/`append` placements, only `pendingContent` is required (main content not used). Branch the guard: `cursor`/`append` require only pending content; `callout`/`merge` require both.
- **If `placement === 'cursor'`**: Use `insertAtCursor(editor, response.content)` — no `replaceMainContent()`, no rewrite
- **If `placement === 'append'`**: Use `appendAsNewSections(editor, response.content)`
- **If `placement === 'callout'` or `'merge'`**: Use `replaceMainContent()` with strategy-aware prompt
- After success + `autoTag`: call `plugin.analyzeAndTagNote()`
- Clear pending section after all placements

**`buildIntegrationPrompt()`** (lines 410-451):
- Add `placement`, `format`, `detail` parameters
- Build prompt dynamically from helper functions:
  - `getPlacementInstructions(placement)` — how to position content
  - `getFormatInstructions(format)` — output structure
  - `getDetailInstructions(detail)` — verbosity level
- For `cursor` and `append` placements, the prompt only processes pending content (no main content needed in prompt since we're not rewriting)
- For `callout` and `merge`, include both main and pending content

**Prompt helpers** — `src/services/prompts/integrationPrompts.ts` (new file):

Prompt instruction helpers belong in the prompts directory per codebase convention, not inline in the command file.

```typescript
export function getPlacementInstructions(placement: PlacementStrategy): string {
    switch (placement) {
        case 'cursor':
            return `Process the pending content into a well-structured section ready for insertion.
- Do NOT reference or include the main note content
- Create a self-contained block that can be dropped into any position
- Use appropriate headings if the content covers multiple topics`;
        case 'append':
            return `Organise the pending content as new section(s) with clear headings.
- Do NOT modify or reference existing note content
- Create well-titled sections for distinct topics
- Each section should be self-contained`;
        case 'callout':
            return `Rewrite the existing note, inserting the pending content as CALLOUT BLOCKS next to relevant sections.
- Use Obsidian callout syntax: > [!info] Title
- Place each callout after the most relevant paragraph or section
- Do NOT modify existing text — only insert callouts between sections`;
        case 'merge':
            return `Rewrite the existing note, integrating pending content INTO relevant sections by topic.
- Merge new information where it logically belongs
- Create new sections only for entirely new topics
- Remove redundancy — don't repeat existing information
- Maintain coherent narrative and logical flow`;
    }
}

export function getFormatInstructions(format: FormatStrategy): string {
    switch (format) {
        case 'prose':
            return `Write in standard prose paragraphs.`;
        case 'bullets':
            return `Format as bullet-point lists organised under headings. Use sub-bullets for details.`;
        case 'tasks':
            return `Format as action items using Obsidian checkbox syntax: - [ ] Task description. Group related tasks under headings.`;
        case 'table':
            return `Format as markdown tables with columns appropriate to the content. Add a heading above each table.`;
    }
}

export function getDetailInstructions(detail: DetailStrategy): string {
    switch (detail) {
        case 'full':
            return `Include all relevant new information, details, and examples.`;
        case 'concise':
            return `Include only key points and essential insights. Tighten prose, omit supporting examples.`;
        case 'summary':
            return `Distil the pending content to its core insights before integrating. Discard verbose explanations and secondary details.`;
    }
}
```

### i18n additions

**`src/i18n/types.ts`** — extend `integrationConfirm`:
```typescript
placementLabel: string;
placementDesc: string;
placementCursor: string;
placementAppend: string;
placementCallout: string;
placementMerge: string;
placementMergeWarn: string;
formatLabel: string;
formatDesc: string;
formatProse: string;
formatBullets: string;
formatTasks: string;
formatTable: string;
detailLabel: string;
detailDesc: string;
detailFull: string;
detailConcise: string;
detailSummary: string;
autoTagLabel: string;
autoTagDesc: string;
```

**`src/i18n/en.ts`**:
```typescript
placementLabel: "Placement",
placementDesc: "Where to put the integrated content",
placementCursor: "Insert at cursor",
placementAppend: "Add as new section(s)",
placementCallout: "Add as inline callouts",
placementMerge: "Merge into existing sections",
placementMergeWarn: "Rewrites note body — use with care",
formatLabel: "Format",
formatDesc: "How the output should be structured",
formatProse: "Prose",
formatBullets: "Bullet points",
formatTasks: "Action items",
formatTable: "Table",
detailLabel: "Detail level",
detailDesc: "How much detail to include from pending content",
detailFull: "Full detail",
detailConcise: "Concise",
detailSummary: "Summary only",
autoTagLabel: "Re-tag note after integration",
autoTagDesc: "Run AI tagging on the updated note",
```

**`src/i18n/zh-cn.ts`**:
```typescript
placementLabel: "放置方式",
placementDesc: "将整合内容放在哪里",
placementCursor: "插入到光标处",
placementAppend: "添加为新章节",
placementCallout: "添加为行内标注",
placementMerge: "融入现有章节",
placementMergeWarn: "会重写笔记正文——请谨慎使用",
formatLabel: "格式",
formatDesc: "输出内容的结构方式",
formatProse: "散文",
formatBullets: "要点列表",
formatTasks: "待办事项",
formatTable: "表格",
detailLabel: "详细程度",
detailDesc: "从待处理内容中包含多少细节",
detailFull: "完整详情",
detailConcise: "简洁",
detailSummary: "仅摘要",
autoTagLabel: "整合后重新标记",
autoTagDesc: "对更新的笔记运行 AI 标记",
```

---

## Part 3: Insert at cursor for Translate Note

### Codebase analysis — where "insert at cursor" applies

Current commands that use `replaceMainContent()` (i.e. overwrite the note body):

| Command | File | Current behaviour | Insert-at-cursor useful? |
|---------|------|-------------------|-------------------------|
| Translate note | `translateCommands.ts` | Replaces entire body with translation | **Yes** — user may want translation alongside original for comparison |
| Improve note | `smartNoteCommands.ts` | Replaces body with improved version | **No** — the purpose is to replace |
| Integrate pending | `integrationCommands.ts` | Replaces body with merged content | **Yes** — handled in Part 2 above |

Summarize, Diagram, Chat, and Related Notes already insert at cursor. No changes needed.

### Changes for Translate Note

**`src/ui/modals/TranslateModal.ts`**:
- Add a toggle: "Insert at cursor" (default off — current behaviour is replace)
- Pass boolean through callback

**`src/commands/translateCommands.ts`** — `translateNote()`:
- If `insertAtCursor`: use `editor.replaceRange(response.content, editor.getCursor())`
- Else: use existing `replaceMainContent()` behaviour

**i18n additions** (in translate section):
- EN: `insertAtCursor: "Insert at cursor"`, `insertAtCursorDesc: "Add translation at cursor instead of replacing note"`
- ZH: `insertAtCursor: "插入到光标处"`, `insertAtCursorDesc: "在光标处添加翻译而不是替换笔记"`
- types.ts: add to translate modal interface

---

## Part 4: DRY — Shared content insertion utility

### Problem

`editor.replaceRange(content, editor.getCursor())` with `\n\n` padding is duplicated across 8+ call sites in `summarizeCommands.ts`, `smartNoteCommands.ts`, `chatCommands.ts`, `translateCommands.ts`, and now `integrationCommands.ts`.

### Solution — `src/utils/editorUtils.ts`

```typescript
import { Editor } from 'obsidian';

/**
 * Insert content at the editor cursor with consistent padding.
 */
export function insertAtCursor(editor: Editor, content: string): void {
    const cursor = editor.getCursor();
    const padded = `\n\n${content}\n`;
    editor.replaceRange(padded, cursor);
}

/**
 * Append content as new section(s) at end of main content,
 * before the earliest of References/Pending Integration sections.
 */
export function appendAsNewSections(editor: Editor, content: string): void {
    const fullText = editor.getValue();
    const refMatch = fullText.match(/\n## References\b/);
    const pendMatch = fullText.match(/\n## Pending Integration\b/);
    // Insert before whichever section appears first
    const positions = [refMatch?.index, pendMatch?.index].filter((i): i is number => i != null);
    const insertPos = positions.length > 0 ? Math.min(...positions) : fullText.length;
    const padded = `\n\n${content}\n`;
    editor.replaceRange(padded, editor.offsetToPos(insertPos));
}
```

### Consumers to refactor (opportunistic)

Only **new code** in this PR will use `editorUtils`. Existing call sites are refactored opportunistically — not required for this PR to avoid scope creep.

| Consumer | Current pattern | New call |
|----------|----------------|----------|
| `integrationCommands.ts` (cursor placement) | `editor.replaceRange(...)` | `insertAtCursor(editor, content)` |
| `integrationCommands.ts` (append placement) | manual position calc | `appendAsNewSections(editor, content)` |
| `translateCommands.ts` (insert-at-cursor) | `editor.replaceRange(...)` | `insertAtCursor(editor, content)` |

---

## Part 5: Summary result preview modal

### Problem

Currently, all summary commands (`insertWebSummary`, `insertAudioSummary`, `insertYouTubeSummary`) insert directly at the cursor with a toast notice ("Summary added"). The user has no chance to review the output before it lands in their note.

### Solution — `src/ui/modals/SummaryResultModal.ts` (new file)

A lightweight preview modal that shows the generated summary and lets the user choose how to apply it.

```typescript
export class SummaryResultModal extends Modal {
    private content: string;
    private onInsert: (action: 'cursor' | 'copy' | 'discard') => void;

    constructor(app: App, plugin: AIOrganiserPlugin, content: string,
                onInsert: (action: 'cursor' | 'copy' | 'discard') => void) { ... }

    onOpen(): void {
        // Title: "Summary Result"
        // Scrollable preview area with rendered markdown
        // Three buttons:
        //   - "Insert at cursor" (primary, mod-cta)
        //   - "Copy to clipboard"
        //   - "Discard"
    }
}
```

### Integration

Wrap existing insert calls in `summarizeCommands.ts`:

```typescript
// Before (direct insert):
insertWebSummary(editor, content, webContent, plugin);
new Notice(plugin.t.messages.summaryInserted);

// After (preview first):
new SummaryResultModal(plugin.app, plugin, content, (action) => {
    if (action === 'cursor') {
        insertWebSummary(editor, content, webContent, plugin);
        new Notice(plugin.t.messages.summaryInserted);
    } else if (action === 'copy') {
        navigator.clipboard.writeText(content);
        new Notice(plugin.t.messages.copiedToClipboard);
    }
}).open();
```

Apply to all three insert functions:
- `insertWebSummary` (line ~3114)
- `insertAudioSummary` (line ~2175)
- `insertYouTubeSummary` (line ~2490)

### i18n additions

**`src/i18n/types.ts`** — new `summaryResult` interface:
```typescript
summaryResult: {
    title: string;
    insertAtCursor: string;
    copyToClipboard: string;
    discard: string;
};
```

**EN**: `title: "Summary Result"`, `insertAtCursor: "Insert at cursor"`, `copyToClipboard: "Copy to clipboard"`, `discard: "Discard"`

**ZH**: `title: "摘要结果"`, `insertAtCursor: "插入到光标处"`, `copyToClipboard: "复制到剪贴板"`, `discard: "丢弃"`

---

## Features deferred to v2

| Feature | Rationale |
|---------|-----------|
| Meeting Minutes insert-at-cursor | Minutes creates a **new file** — insert-at-cursor doesn't apply |
| Summary results modal insert button | **Moved to v1** — see Part 5 |
| Auto-link concepts (Linkify) | Requires vault-wide wikilink scanning; separate feature |
| Save as new note & link (Atomic) | Different UX flow; deserves its own command |
| Selective integration (pick items) | Pending content is free-form markdown, not parseable items |
| Preview/diff before applying | Heavy UI; user has Ctrl+Z undo |

---

## Test Coverage

### New tests — `tests/integrationPrompts.test.ts`

| Test | Asserts |
|------|---------|
| `getPlacementInstructions('cursor')` | Contains "self-contained", does NOT contain "rewrite" |
| `getPlacementInstructions('merge')` | Contains "rewrite", "integrate" |
| `getFormatInstructions('tasks')` | Contains `- [ ]` checkbox syntax |
| `getFormatInstructions('table')` | Contains "table" |
| `getDetailInstructions('summary')` | Contains "distil" or "core insights" |
| `buildIntegrationPrompt()` with cursor | Does NOT include main content in prompt |
| `buildIntegrationPrompt()` with merge | Includes both main and pending content |

### New tests — `tests/editorUtils.test.ts`

| Test | Asserts |
|------|---------|
| `insertAtCursor()` | Calls `editor.replaceRange` with padded content at cursor |
| `appendAsNewSections()` | Inserts before `## References` when present |
| `appendAsNewSections()` | Inserts at end when no References section |
| `appendAsNewSections()` | Inserts before earliest section when Pending appears before References |

### Updated tests — `tests/commandPicker.test.ts`

| Test | Asserts |
|------|---------|
| Command list | `generate-from-embedded` absent from Create category |

## Implementation Sequence

1. Remove `generate-from-embedded` (Part 1) — clean deletion
2. Create `src/utils/editorUtils.ts` — shared insertion utility (Part 4)
3. Create `src/services/prompts/integrationPrompts.ts` — prompt helpers
4. Add constants — types + defaults in `constants.ts`
5. Add i18n keys — `types.ts`, `en.ts`, `zh-cn.ts` (integration + translate + summary result)
6. Update `IntegrationConfirmModal` — 3 dropdowns + toggle
7. Update `buildIntegrationPrompt()` — import prompt helpers, add strategy params
8. Update command handler — branch on placement using `editorUtils`
9. Update `TranslateModal` + `translateNote()` — insert-at-cursor toggle using `editorUtils`
10. Create `SummaryResultModal` — preview modal with insert/copy/discard (Part 5)
11. Wrap summary insert calls — `insertWebSummary`, `insertAudioSummary`, `insertYouTubeSummary`
12. Write/update tests — integration prompts, editor utils, command picker
13. Build, deploy, manual test

## Review decisions

| Question | Decision | Rationale |
|----------|----------|-----------|
| Persist placement/format/detail defaults in settings? | **No — per-modal state only** | Right choice varies per note; fresh defaults each time |
| Explicit confirmation for callout placement? | **No — Ctrl+Z is sufficient** | Callout is already opt-in via dropdown; extra confirmation adds friction |

---

## Verification

1. `npm run build` — all tests pass, bundle produced
2. Deploy to `C:\obsidian\Second Brain\.obsidian\plugins\ai-organiser\`
3. Manual verification:
   - `generate-from-embedded` gone from command palette and sparkles picker
   - `smart-summarize` still detects embedded content
   - Integration modal shows Placement, Format, Detail dropdowns + Auto-tag toggle
   - **Placement: cursor** — content appears at cursor, note body untouched
   - **Placement: append** — new section at bottom of main content
   - **Placement: callout** — `> [!info]` blocks next to relevant sections
   - **Placement: merge** — AI rewrites body to integrate (warning shown)
   - **Format: tasks** — output uses `- [ ]` checkbox syntax
   - **Detail: summary** — output is condensed vs full detail
   - Translate note: toggle inserts translation at cursor instead of replacing
   - Summary result: preview modal appears after summarization with Insert/Copy/Discard
   - Both EN and ZH interfaces correct
