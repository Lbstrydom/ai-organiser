# UX/UI Refactoring Plan

Date: 2026-01-25
Source of truth: `docs/ux-ui-audit.md`

## Status Update

**Phase 1 (P0): ✅ COMPLETED**
- Command picker expanded from 13 to 29 commands
- Category styling implemented with data-category attributes
- All tests passing (631 unit + 17 integration)
- Deployed to Obsidian vault
- Date Completed: 2026-01-25

**Phase 2 (P0): ✅ COMPLETED**
- Added 24 new i18n keys to types.ts, en.ts, zh-cn.ts with dynamic placeholders
- Hard-coded notices replaced in:
  - `src/commands/chatCommands.ts`: 7 notices → plugin.t strings
  - `src/commands/integrationCommands.ts`: 9 notices → plugin.t strings
  - `src/ui/views/RelatedNotesView.ts`: 2 notices → plugin.t strings
- Fixed ChatWithVaultModal class method scope (this.plugin.t)
- All tests passing (631 unit + 17 integration)
- Deployed to Obsidian vault
- Date Completed: 2026-01-25
- **Remaining Work**: ~20 hard-coded notices in `src/commands/summarizeCommands.ts` can be addressed as part of Phase 3 work or in a targeted update

## Purpose

This plan replaces the older controller-extraction completion report so that
`docs/refactoring-plan.md` now tracks the active UX/UI refactor work only.

The previous completion report has been archived at:
- `docs/completed/minutes-controller-refactor-completion.md`

## Current Baseline (verified)

- Commands registered: 33 (`addCommand(...)` across `src/commands/`)
- Commands exposed in sparkles picker: 13 direct commands
  - Measured by counting `executeCommand('ai-organiser:...')` in
    `src/ui/modals/CommandPickerModal.ts`
- Hard-coded notices: 53 occurrences of `new Notice('...')` in `src/ui` and
  `src/commands`

Notes:
- Picker coverage is a conservative metric because some picker items are umbrella
  flows (for example, `enhance-note`).

## Scope

In scope (from the audit):
1) Command picker coverage and category signifiers (P0)
2) i18n drift reduction (P0)
3) RAG options gating (P1)
4) Replace browser `prompt()` in dashboard creation (P1)

Out of scope:
- New feature development unrelated to the audit findings
- Large redesigns that change established workflows without evidence

## Guardrails (production-grade)

- Evidence first: tie changes to audit findings and code references.
- No regressions: run `npm test` and `npm run test:auto` after each phase.
- i18n discipline: no new `new Notice('...')` in `src/ui` or `src/commands`.
- Mobile-safe: avoid browser prompts and desktop-only assumptions.
- DRY: centralize repeated UI text and signifier styles.

## Phase 1: Command Picker Expansion and Category Styling (P0)

Files:
- `src/ui/modals/CommandPickerModal.ts`
- `styles.css`

Tasks:
- Expand picker coverage to include major feature areas:
  - NotebookLM: export, toggle selection, clear selection, open export folder
  - Bases/migration: upgrade metadata, upgrade folder metadata, create dashboard
  - Integration: add-to-pending, integrate-pending, resolve pending embeds
  - Highlights: highlight selection, remove highlight
  - Chat helpers: ask about current note, insert related notes
- Make category styling functional:
  - Include a stable category id on each item
  - Set `data-category` in `renderSuggestion(...)`
  - Update CSS selectors to match actual categories:
    `create`, `enhance`, `organize`, `search`, `analyze`

Acceptance criteria:
- Sparkles picker exposes all major capabilities from the audit.
- Category badges show distinct visual signifiers per category.

## Phase 2: i18n Drift Fix (P0)

Files:
- `src/i18n/types.ts`
- `src/i18n/en.ts`
- `src/i18n/zh-cn.ts`
- Primary offenders:
  - `src/commands/chatCommands.ts`
  - `src/commands/integrationCommands.ts`
  - `src/commands/summarizeCommands.ts` (moved to Phase 3)
  - `src/ui/views/TagNetworkView.ts`
  - `src/ui/views/RelatedNotesView.ts`
  - `src/ui/settings/SemanticSearchSettingsSection.ts`
  - `src/ui/settings/ConfigurationSettingsSection.ts`

Tasks:
- Add missing translation keys in a structured way.
- Replace hard-coded notices and view strings with `plugin.t` strings.
- Keep keys MECE and tied to user-visible outcomes.
- Translation approach:
  - Auto-translate ZH-CN as a first pass is acceptable.
  - Mark machine translations for review where meaning is subtle.

Acceptance criteria:
- No hard-coded English notices remain in core command flows.
- i18n parity checks continue to pass.

**Phase 3 (P1): ✅ COMPLETED**
- Replaced 20 hard-coded notices in `src/commands/summarizeCommands.ts` with i18n keys
- Added 15 new i18n keys with dynamic placeholders ({count}, {error}, {title}, etc.)
- All hard-coded notices in summarization workflow now use plugin.t
- All tests passing (631 unit + 17 integration)
- Deployed to Obsidian vault
- Date Completed: 2026-01-25

## Phase 4: Gate RAG Options Behind Vault Chat (P1)

File:
- `src/ui/settings/SemanticSearchSettingsSection.ts`

Tasks:
- Show `ragContextChunks` and `ragIncludeMetadata` only when
  `enableVaultChat` is true.
- When vault chat is disabled, show a short explanatory message instead of the
  controls.

Acceptance criteria:
- Users cannot configure RAG options for a disabled feature.

## Phase 5: Replace Browser prompt() in Dashboard Creation (P1)

File:
- `src/ui/modals/DashboardCreationModal.ts`

Tasks:
- Replace `prompt()` with an in-modal input row.
- Pre-populate with the current folder path.
- Validate folder existence and create when appropriate.
- Provide user feedback via translated notices.

Acceptance criteria:
- No browser prompt appears.
- Folder selection follows established modal patterns.

## Verification Checklist

After each phase:
- Run: `npm test`
- Run: `npm run test:auto`
- Manually verify the relevant UX:
  - Sparkles picker shows the expected commands
  - Category badges display distinct colors
  - Switching to ZH-CN removes English notices in updated flows
  - Disabling vault chat hides RAG controls
  - Dashboard creation uses in-modal folder entry (no prompt)

Before release:
- Run: `npm run build`
- Deploy and verify in Obsidian per `AGENTS.md`

## Suggested Follow-ups (lightweight guardrails)

- Add a script that flags `new Notice('...')` in `src/ui` and `src/commands`.
- Add a script that compares registered commands to picker commands with an
  allowlist for intentionally hidden commands.
