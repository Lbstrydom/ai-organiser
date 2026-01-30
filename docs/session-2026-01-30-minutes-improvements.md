# Session 2026-01-30: Minutes Modal Improvements

## 1. Participants Format — Structured Table (`Name | Title | Company`)

**Problem:** Dictionary person entries were displayed as `Raul (Primary task owner at HLNG)` — unclear structure, hard to edit.

**Fix:** Changed to pipe-separated table format: `Raul Kade | CEO | Hamina LNG`

**Files changed:**

- `src/ui/modals/MinutesCreationModal.ts` — `suggestParticipantsFromDictionary()` now formats entries as `Name | Title | Company`. Added `parsePersonDefinition()` helper that parses free-text definitions using comma, "at", or dash separators to extract title and organisation.

- `src/services/minutesService.ts` — `parseParticipants()` now parses the pipe format into structured `Participant` objects with `name`, `role`, and `organisation` fields (matching the existing `Participant` interface in minutesPrompts.ts).

- `src/services/dictionaryService.ts` — Updated extraction prompt to instruct LLM to format person definitions as `"Title, Organisation"` with an explicit example: `{"term": "Raul Kade", "category": "person", "definition": "CEO, Hamina LNG"}`.

- `src/i18n/en.ts`, `src/i18n/zh-cn.ts`, `src/i18n/types.ts` — Updated `fieldParticipantsDesc` from `"Paste list here. Format: \"Name (Role) - Present/Apologies\""` to `"One per line. Format: Name | Title | Company"`. Also added missing `transcriptAutoLoaded` and `participantsSuggestedFromDictionary` i18n strings from the previous session.

---

## 2. Minutes JSON Parsing — Unclosed Array Bracket Fix

**Problem:** Minutes generation failed with `"Expected ',' or ']' after array element"`. The LLM response was truncated mid-JSON (token limit), and the repair logic at `src/services/prompts/minutesPrompts.ts:479` only closed the root `}` brace — leaving arrays like `"participants": [{...}, {...}` without their closing `]`.

**Fix:** After cutting at the last balanced nested object, the repair now counts unclosed `[` brackets (ignoring those inside strings) and inserts the appropriate number of `]` before the closing `}`.

**File changed:**

- `src/services/prompts/minutesPrompts.ts` — `extractJsonByBraceMatching()` truncated-response repair block (line ~479). Added a character-by-character scan of the partial JSON to count unclosed `[` brackets, then appends `']'.repeat(unclosedCount)` before the final `}`.

---

## 3. Persistent Participant Lists

**Problem:** Same participants attend many meetings. Users had to re-enter or re-populate participants every time.

**Fix:** Added a dropdown to select from saved participant lists, stored as markdown files in `AI-Organiser/Config/participants/`.

**New file:**

- `src/services/participantListService.ts` (~140 lines) — Lightweight CRUD service mirroring the dictionary service pattern. Methods: `listParticipantLists()`, `createParticipantList(name, entries)`, `save(list)`, `getById(id)`. Storage format: YAML frontmatter (name, created, updated) + one participant per line.

**File format example:**

```markdown
---
name: Board Meeting Team
created: 2026-01-30T12:00:00Z
updated: 2026-01-30T12:00:00Z
---

Raul Kade | CEO | Hamina LNG
Liisa Tamm | CFO | Hamina LNG
```

**Files changed:**

- `src/ui/modals/MinutesCreationModal.ts`:
  - Added `ParticipantListService` import, member, and constructor initialisation
  - Added `selectedParticipantListId` and `availableParticipantLists` to `MinutesModalState`
  - Added `loadAvailableParticipantLists()` — called in `onOpen()` alongside dictionary loading
  - Added `loadParticipantListIntoTextarea(listId)` — populates textarea when a list is selected
  - Added `handleCreateNewParticipantList()` — prompts for name, saves current textarea content as a new list (reuses existing `promptForText()` dialog)
  - Added `handleSaveCurrentParticipantList()` — saves to selected list or prompts for name if none selected

- `src/i18n/types.ts`, `src/i18n/en.ts`, `src/i18n/zh-cn.ts` — Added 8 new i18n keys: `participantListSelect`, `participantListNone`, `participantListCreateNew`, `participantListSaveCurrent`, `participantListNamePrompt`, `participantListSaved`, `participantListLoaded`, `participantListCreated`.

---

## 4. Participants Section Layout Fix

**Problem:** The Setting component rendered label, description, and textarea inline — the pipe-separated format was hard to read, especially with long entries.

**Fix:** Replaced `Setting.addTextArea` with a stacked layout: dropdown → "Save as list" button → label → description → full-width monospace textarea.

**Files changed:**

- `src/ui/modals/MinutesCreationModal.ts` — Rewrote `renderParticipantsSection()`:
  - Dropdown: `(None)` | `+ Create new list` | saved lists with entry counts
  - "Save as list" button (`.mod-muted` style)
  - Standalone `<label>` + `<p>` for description (not wrapped in Setting)
  - Standalone `<textarea>` with `minutes-participants-textarea` CSS class

- `styles.css` — Added 3 new CSS classes:
  - `.minutes-participants-textarea`: `width: 100%; font-family: var(--font-monospace); font-size: var(--font-ui-small)`
  - `.minutes-participants-desc`: muted text styling for the description
  - `.minutes-participants-actions`: flex row for the save button

---

## Tests & Build

- All 868 unit tests pass
- All 17 automated integration tests pass
- Production build succeeds (4.6MB)
- Deployed to `C:\obsidian\Second Brain\.obsidian\plugins\ai-organiser\`
