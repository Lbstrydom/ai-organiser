# Fix Preview Modal + Global LLM Busy Indicator

## Part 1: Fix Summary Preview Modal for ALL Paths

### Problem
`SummaryResultModal` (Insert/Copy/Discard preview) only works for 3 of 5 insert functions. Two paths skip it entirely — the user sees content inserted directly with no preview.

| Function | Has Preview? | Line |
|----------|-------------|------|
| `insertWebSummary` | YES | 3109 |
| `insertAudioSummary` | YES | 2177 |
| `insertYouTubeSummary` | YES | 2492 |
| `insertTextSummary` | **NO** — direct `editor.replaceRange()` | 3165 |
| `insertPdfSummary` | **NO** — direct `editor.replaceRange()` | 3208 |

Plain text summarization (user's scenario): `handleTextSummarization()` → `summarizePlainTextAndInsert()` → `insertTextSummary()` → no preview.

### Fix

Refactor `insertTextSummary` and `insertPdfSummary` to match the pattern of the other 3:
1. Add `showPreview = false` parameter
2. Wrap editor mutations in a `doInsert` closure
3. Call `showSummaryPreviewOrInsert(plugin, output, doInsert, showPreview)`
4. Return `Promise<SummaryResultAction | undefined>`
5. All callers pass `true` and remove duplicate `new Notice(summaryInserted)` calls

### Call sites to update

**`insertTextSummary`** — 4 callers in `summarizePlainTextAndInsert` (line 2767) and `summarizePlainTextInChunks` (lines ~2846, 2854, 2863)

**`insertPdfSummary`** — 2 callers in `handlePdfSummarization` (line 1682) and `handleExternalPdfSummarization` (line 1742). Both must `await` to get the action value, then gate metadata updates.

### "Combined from sections" — i18n key, not concatenation

The chunked paths currently hardcode `summaryInserted + ' (combined from sections)'`. Add a dedicated i18n key instead of string concatenation:

- `types.ts`: `summaryCombinedFromSections: string;`
- `en.ts`: `summaryCombinedFromSections: 'Summary inserted (combined from sections)'`
- `zh-cn.ts`: `summaryCombinedFromSections: '摘要已插入（由多个部分合并）'`

Add optional `noticeMessage` parameter to `showSummaryPreviewOrInsert`:

```typescript
function showSummaryPreviewOrInsert(
    plugin: AIOrganiserPlugin,
    output: string,
    doInsert: () => void,
    showPreview: boolean,
    noticeMessage?: string  // overrides default notice on cursor insert
): Promise<SummaryResultAction> | undefined
```

Chunk-combine callers pass `plugin.t.messages.summaryCombinedFromSections`.

### PDF metadata gating for undefined action

When `showPreview = false`, `showSummaryPreviewOrInsert` returns `undefined` (direct insert). Callers must `await` to get the action. Gate metadata with:

```typescript
const action = await insertPdfSummary(editor, summary, pdfContent, plugin, isInternal, true);
// Only skip metadata if user actively chose NOT to insert (copy/discard)
if (action && action !== 'cursor') return;
```

This ensures metadata is written on both direct insert (`action === undefined`) and preview insert (`action === 'cursor'`), but skipped on copy/discard.

### Dead code to remove

After refactoring, the duplicate `new Notice(plugin.t.messages.summaryInserted)` calls at the non-chunked call sites become dead — `showSummaryPreviewOrInsert` handles it. Remove them.

### DRY fix: repeated title fallback

`plugin.t.commands.summarize || plugin.t.commands.summarizeSmart || 'Summary'` is repeated 4 times (lines 2771, 2850, 2858, 2867). Extract to a local constant at the top of each calling function.

### File
`src/commands/summarizeCommands.ts`

---

## Part 2: Global LLM Busy Indicator

### Problem
No visual feedback when the LLM is processing. User doesn't know if the plugin is working or stuck.

### Design: Status Bar Spinner with Ref Counting

- Status bar item at bottom of Obsidian — always visible, non-blocking
- Small spinning circle + "AI processing..." text
- Ref counting handles concurrent operations (show on first, hide when all complete)
- Single `withBusyIndicator(plugin, operation)` wrapper — DRY/SOLID
- Single Responsibility: `busyIndicator.ts` owns only UI state; LLM logic stays in callers
- Open/Closed: new LLM call sites just wrap with `withBusyIndicator()` — no changes to the indicator itself
- Dependency Inversion: indicator depends on a `busyStatusBarEl` property, not concrete plugin internals

### New file: `src/utils/busyIndicator.ts`

```typescript
showBusy(plugin, message?)    // increment ref, show spinner
hideBusy(plugin)              // decrement ref, hide when 0
withBusyIndicator<T>(plugin, operation, message?)  // wrap async op
resetBusyState()              // cleanup for unload
```

### Anti-flicker for chunked flows

Wrapping every `summarizeTextWithLLM()` call would show/hide per chunk, causing flicker. Instead, wrap at the **higher-level chunk flow** functions:

- `summarizePlainTextInChunks()` — wraps entire chunk loop + combine
- `summarizeInChunks()` — wraps web content chunking
- `summarizeAudioInChunks()` — wraps audio chunking
- `summarizeYouTubeInChunks()` — wraps YouTube chunking

For **non-chunked paths**, wrap the higher-level functions (single LLM call, no flicker risk):
- `summarizeAndInsert()` — web content single-call path
- `summarizePlainTextAndInsert()` — plain text single-call path
- `summarizeAudioAndInsert()` (line 2045) — non-chunked audio path
- `summarizeYouTubeAndInsert()` (line 2343) — non-chunked YouTube path
- `summarizePdfWithFullWorkflow()` (line 3034) — PDF summarization path
- `callSummarizeService()` — multi-source path

### DRY: LLM facade context construction

`{ llmService: plugin.llmService, settings: plugin.settings }` is repeated **14 times** across 7 files. Add a helper to `llmFacade.ts`:

```typescript
export function pluginContext(plugin: { llmService: SummarizableLLMService; settings: { serviceType: 'cloud' | 'local'; cloudServiceType: string } }): LLMFacadeContext {
    return { llmService: plugin.llmService, settings: plugin.settings };
}
```

Replace all 14 occurrences including `getServiceType()` calls in `smartNoteCommands.ts` (3 occurrences at lines 171, 221, 306).

### Plugin changes: `src/main.ts`

- Add `busyStatusBarEl: HTMLElement | null` property
- Initialize `this.addStatusBarItem()` in `onload()` — guard with `if (!Platform.isMobile)` to avoid empty artifacts on mobile
- Reset in `onunload()`
- Wrap `analyzeAndTagNote()` LLM call

### CSS: `styles.css`

```css
.ai-organiser-busy-indicator { display: none; align-items: center; gap: 6px; color: var(--text-accent); }
.ai-organiser-busy-indicator.ai-organiser-busy-active { display: flex; }
.ai-organiser-busy-indicator::before { /* 12px border spinner using existing @keyframes spin */ }
```

### No hardcoding

- Status bar text comes from i18n (`plugin.t.messages.aiProcessing`), not hardcoded English
- CSS uses Obsidian theme variables (`--text-accent`, `--font-ui-smaller`), not hardcoded colours
- "Combined from sections" uses dedicated i18n key, not English concatenation

### i18n

- `types.ts` / `en.ts` / `zh-cn.ts`: Add `aiProcessing` and `summaryCombinedFromSections` to messages

### Complete wrapping inventory

**Summarization flows** (`src/commands/summarizeCommands.ts`):

| Function | Line | Wrap location | Reason |
|----------|------|--------------|--------|
| `summarizeAndInsert()` | 2555 | Around entire function body | Single web content call |
| `summarizePlainTextAndInsert()` | 2746 | Around entire function body | Single plain text call |
| `summarizeAudioAndInsert()` | 2045 | Around entire function body | Single audio call |
| `summarizeYouTubeAndInsert()` | 2343 | Around entire function body | Single YouTube call |
| `summarizePdfWithFullWorkflow()` | 3034 | Around entire function body | PDF pipeline |
| `summarizePlainTextInChunks()` | 2786 | Around entire function body | Multi-chunk, prevents flicker |
| `summarizeInChunks()` | 2668 | Around entire function body | Multi-chunk |
| `summarizeAudioInChunks()` | 2100 | Around entire function body | Multi-chunk |
| `summarizeYouTubeInChunks()` | 2397 | Around entire function body | Multi-chunk |
| `callSummarizeService()` | 1030 | Around entire function body | Multi-source path |

**Other command files:**

| File | Function/Call | Wrap |
|------|--------------|------|
| `translateCommands.ts` | `callLLMForTranslation()` (line 218) | `withBusyIndicator` |
| `smartNoteCommands.ts` | `summarizeText()` calls (lines 189, 239, 320) | `withBusyIndicator` each |
| `flashcardCommands.ts` | `summarizeText()` call (line 187) | `withBusyIndicator` |
| `integrationCommands.ts` | `callLLMForIntegration()` (line 423) | `withBusyIndicator` |
| `chatCommands.ts` | Already has own indicator — add `pluginContext` only | Skip busy wrapping |

**Service/UI files:**

| File | Function/Call | Wrap |
|------|--------------|------|
| `minutesService.ts` | `summarizeText()` call (line 290) | `withBusyIndicator` |
| `MinutesCreationModal.ts` | `handleExtractDictionaryFromDocs()` LLM call (line 1454) | `withBusyIndicator` |
| `ConfigurationSettingsSection.ts` | `suggestionService.*` calls (lines 1230, 1333, 1398, 1581, 1696, 1765) | `withBusyIndicator` at each call site (plugin accessible here) |

**Note on taxonomy wrapping:** `taxonomySuggestionService.ts` has no plugin/busyIndicator access. Wrap at the caller in `ConfigurationSettingsSection.ts` where `plugin` is available and `suggestionService.*` methods are awaited (8 LLM-calling sites: lines 1230, 1333, 1398, 1581, 1696, 1765 plus the 2 `analyzeVaultStructure` calls at 1324/1677 which are sync — skip those).

**Dropped:** `DictionaryController.extractTermsFromContent()` — has no call sites in codebase. No wrapping needed.

**Plugin core:**

| File | Function | Wrap |
|------|----------|------|
| `main.ts` | `analyzeAndTagNote()` LLM call | `withBusyIndicator` |

### Mobile guard

`addStatusBarItem()` may be hidden on mobile. Guard in `main.ts`:

```typescript
if (!Platform.isMobile) {
    this.busyStatusBarEl = this.addStatusBarItem();
    this.busyStatusBarEl.addClass('ai-organiser-busy-indicator');
}
```

`showBusy`/`hideBusy` already null-check `plugin.busyStatusBarEl`, so mobile calls are no-ops.

---

## Dead Code Audit

| Item | Action |
|------|--------|
| Duplicate `new Notice(summaryInserted)` at non-chunked call sites | Remove — `showSummaryPreviewOrInsert` handles it |
| Hardcoded `' (combined from sections)'` concatenation (2x) | Replace with i18n key `summaryCombinedFromSections` |
| Repeated title fallback `plugin.t.commands.summarize \|\| ...` (4x) | Extract to local `const title` |
| Repeated facade context `{ llmService, settings }` (14x across 7 files) | Replace with `pluginContext(plugin)` helper |
| `DictionaryController.extractTermsFromContent()` | No call sites — dead code already, leave as-is (not introduced by this PR) |

No orphaned imports or unused functions expected from this change.

---

## Files to modify

| File | Changes |
|------|---------|
| `src/utils/busyIndicator.ts` | **NEW** — ref-counted busy indicator |
| `src/services/llmFacade.ts` | Add `pluginContext()` helper (DRY) |
| `src/main.ts` | Add `busyStatusBarEl`, init with mobile guard, cleanup, wrap tag LLM call |
| `styles.css` | Status bar spinner CSS |
| `src/i18n/types.ts` | Add `aiProcessing`, `summaryCombinedFromSections` |
| `src/i18n/en.ts` | Add both i18n keys |
| `src/i18n/zh-cn.ts` | Add both i18n keys |
| `src/commands/summarizeCommands.ts` | Fix `insertTextSummary` + `insertPdfSummary` preview; add `noticeMessage` to `showSummaryPreviewOrInsert`; remove dead notices; replace hardcoded "combined" string; extract title const; wrap 10 LLM functions; use `pluginContext` |
| `src/commands/translateCommands.ts` | Wrap `summarizeText` call; use `pluginContext` |
| `src/commands/smartNoteCommands.ts` | Wrap 3 `summarizeText` calls + 3 `getServiceType` calls; use `pluginContext` |
| `src/commands/flashcardCommands.ts` | Wrap `summarizeText` call; use `pluginContext` |
| `src/commands/integrationCommands.ts` | Wrap `callLLMForIntegration`; use `pluginContext` |
| `src/commands/chatCommands.ts` | Use `pluginContext` only (has own indicator) |
| `src/services/minutesService.ts` | Wrap `summarizeText` call; use `pluginContext` |
| `src/ui/modals/MinutesCreationModal.ts` | Wrap `handleExtractDictionaryFromDocs` LLM call |
| `src/ui/settings/ConfigurationSettingsSection.ts` | Wrap 6 `suggestionService.*` LLM calls |

---

## Tests

### New test file: `tests/busyIndicator.test.ts`

**Back-end logic tests (no Obsidian dependency):**

| Test | Asserts |
|------|---------|
| `showBusy` increments refCount and adds CSS class | `classList.add` called with `ai-organiser-busy-active` |
| `hideBusy` decrements refCount, removes class at 0 | `classList.remove` called only when count reaches 0 |
| `hideBusy` does not go below 0 | Call hideBusy 3x with only 1 showBusy — no error, class removed |
| `withBusyIndicator` shows/hides around successful operation | show called before, hide called after |
| `withBusyIndicator` hides on error (finally block) | hide called even when operation throws |
| `withBusyIndicator` returns operation result | Resolves with the wrapped function's return value |
| Concurrent operations: 2 showBusy, 1 hideBusy → still active | Class not removed until second hideBusy |
| `resetBusyState` clears refCount to 0 | After reset, hideBusy does nothing |
| `showBusy` with null statusBarEl is a no-op | No error thrown (mobile guard) |

**Mock approach:** Create mock plugin with `busyStatusBarEl` as `{ setText: vi.fn(), classList: { add: vi.fn(), remove: vi.fn() } }` and mock `t.messages.aiProcessing`.

### New test file: `tests/llmFacade.test.ts`

| Test | Asserts |
|------|---------|
| `pluginContext` returns correct shape | Returns `{ llmService, settings }` from plugin |
| `pluginContext` does not expose extra plugin properties | Only llmService and settings in result |
| `summarizeText` returns error on LLM failure | `{ success: false, error: ... }` |
| `summarizeText` returns content on success | `{ success: true, content: ... }` |

### Existing test updates

| File | Update |
|------|--------|
| `tests/editorUtils.test.ts` | No changes needed |
| `tests/integrationPrompts.test.ts` | No changes needed |

### Integration-level verification (manual + automated)

Tests tie back to front-end by verifying the same functions the UI calls:
- `showSummaryPreviewOrInsert` is tested indirectly via the modal (Obsidian-dependent)
- `withBusyIndicator` is fully unit-testable since it only manipulates DOM classes
- `pluginContext` is pure — trivially testable

---

## Future reuse opportunities (out of scope, noted for v2)

| Opportunity | Description |
|------------|-------------|
| Preview modal for other LLM outputs | Generalize `SummaryResultModal` for translation, smart note, flashcard outputs |
| Busy indicator in settings | Show spinner during "Test Connection" LLM calls |

---

## Implementation sequence

All steps completed 2026-01-29.

1. ~~Create `busyIndicator.ts` + tests~~ DONE
2. ~~Add `pluginContext()` to `llmFacade.ts` + tests~~ DONE
3. ~~Add i18n strings (3 files: `aiProcessing`, `summaryCombinedFromSections`)~~ DONE
4. ~~Add CSS~~ DONE
5. ~~Init status bar in `main.ts` with mobile guard~~ DONE
6. ~~Add `noticeMessage` param to `showSummaryPreviewOrInsert`~~ DONE
7. ~~Refactor `insertTextSummary` + `insertPdfSummary` + update call sites + `await` PDF callers + remove dead notices + replace hardcoded "combined" string + extract title const + gate PDF metadata with `if (action && action !== 'cursor') return;`~~ DONE
8. ~~Replace all 14 `{ llmService, settings }` constructions with `pluginContext(plugin)`~~ DONE
9. ~~Wrap 10 summarization functions in `summarizeCommands.ts`~~ DONE
10. ~~Wrap `summarizeText` calls in translateCommands, smartNoteCommands, flashcardCommands, integrationCommands~~ DONE
11. ~~Wrap `summarizeText` in minutesService, LLM call in MinutesCreationModal~~ DONE
12. ~~Wrap 6 `suggestionService.*` calls in ConfigurationSettingsSection~~ DONE
13. ~~Wrap `analyzeAndTagNote` in `main.ts`~~ DONE
14. ~~Build, test, deploy~~ DONE

### Additional cleanup (done during implementation)

- Fixed `import { describe, it, ... } from 'vitest'` in 10 test files — vitest `globals: true` config made explicit imports cause "No test suite found", masking 158 tests (705 → 863 tests now visible)
- Removed `tests/deprecated/` directory (replacement tests already existed)
- Removed unused `import type AIOrganiserPlugin` from `busyIndicator.ts`
- Fixed pre-existing TS errors in `basesService.test.ts` (`App.plugins` type) and `secretStorageService.test.ts` (`string | undefined` narrowing)

### Build results

- **39 test suites, 863 unit tests** — all passing
- **17/17 automated integration tests** — all passing
- **TypeScript** — compiles cleanly (source + tests)
- **Bundle** — `main.js` 4.6 MB
- **Deployed** to `C:\obsidian\Second Brain\.obsidian\plugins\ai-organiser\`

## Verification

Automated verification complete. Manual testing checklist:

- [ ] Summarize plain text note → preview modal appears
- [ ] Summarize PDF → preview modal appears + spinner during processing
- [ ] Chunked summary → preview shows, notice says translated "combined from sections"
- [ ] Any LLM operation → status bar shows spinning indicator
- [ ] Spinner stays visible during chunked summarization (no flicker)
- [ ] Spinner disappears when LLM completes
- [ ] ESC/discard on preview → no content inserted, metadata not written
- [ ] Copy button → clipboard populated, no content inserted
- [ ] Chinese interface → "AI 处理中..." in status bar, "摘要已插入（由多个部分合并）" for combined
- [ ] Tag generation → spinner shows during analysis
- [ ] Dictionary extraction in Minutes → spinner shows
- [ ] Taxonomy suggestion in Settings → spinner shows
- [ ] Audio/YouTube single-source summarize → spinner shows
- [ ] Discard button in preview modal → red/warning styling
- [ ] Spinner pulses in opacity while spinning (peripheral visibility)
- [ ] Settings → Test Connection → spinner still works (namespaced keyframes)
- [ ] Related Notes sidebar → refresh button spinner still works

---

## Review Rounds

### Review Round 1 (2026-01-29): Spinner scoping + coverage gaps

| Finding | Severity | Fix |
|---------|----------|-----|
| Spinner stays active during preview modal wait | MEDIUM | Scoped `withBusyIndicator` to LLM calls only, preview modal outside |
| Missing busy indicator for `callSummarizeService`, `summarizePdfWithFullWorkflow`, chunked audio | HIGH | Wrapped inner LLM calls directly |
| "Combined from sections" notice only on fallback path | LOW | Always pass `combinedNotice` |

### Review Round 2 (2026-01-30): Remaining coverage gaps

| Finding | Severity | Fix |
|---------|----------|-----|
| `summarizeYouTubeInChunks` unwrapped | HIGH | Wrapped chunk loop + combine, preview outside |
| Traditional web path in `summarizeAndInsert` unwrapped | HIGH | Wrapped `summarizeTextWithLLM` call |

### Review Round 3 (2026-01-30): Full coverage audit

27 `withBusyIndicator` call sites verified across 10 files. 3 apparent gaps confirmed as intentional:
- `chatCommands.ts` (2 calls) — own indicator (disabled button + Notice)
- `DictionaryController.ts` (1 call) — wrapped at higher call site in MinutesCreationModal

### UX Polish (2026-01-30): Affordance, signifier & Gestalt

| Change | Principle | Fix |
|--------|-----------|-----|
| Discard button identical to Copy | Signifier (Norman) | Added `.setWarning()` for red/destructive appearance |
| Spinner hard to see in peripheral vision | Common fate (Gestalt) | Added opacity pulse animation (2s ease-in-out) |
| Duplicate `@keyframes spin` (lines 211 + 1811) | DRY | Namespaced: `ai-organiser-spin`, `ai-organiser-pulse`, `related-notes-spin` |

Considered and rejected:
- Confirmation dialog for Discard — adds friction for low-stakes action
- "Summary ready" Notice between spinner and modal — modal opens synchronously, IS the signal
- Immediate click feedback Notice — spinner appears near-instantly for most paths
