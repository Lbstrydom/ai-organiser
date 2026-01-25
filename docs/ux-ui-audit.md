# UX/UI Audit Report and Plan

Date: 2026-01-25
Scope: Settings UX, command execution UX (sparkles ribbon and command picker), and core modals/views

## Executive Summary

There are three sign-off blockers, and one of the prior blockers is not valid on the current repo state:

- Command picker coverage is incomplete for major features.
- Command picker category styling is non-functional.
- i18n drift is large and material (50+ user-facing strings bypass translations).
- Encoding problems are NOT present (verified UTF-8 codepoints).

## Corrections From Review

### Encoding issues: not a real blocker

I rechecked the previously flagged lines using explicit UTF-8 decoding and codepoint inspection.

Examples now confirm correct Unicode codepoints:

- `src/ui/modals/CommandPickerModal.ts:45` uses U+2191 and U+2193
- `src/ui/settings/LLMSettingsSection.ts:401` uses U+2022
- `src/ui/settings/SemanticSearchSettingsSection.ts:146` uses U+2022
- `src/ui/settings/InterfaceSettingsSection.ts:101` uses U+1F4A1
- `src/ui/settings/NotebookLMSettingsSection.ts:30` uses U+2192

Action: Remove encoding fixes from the plan.

## Key Findings (Prioritized)

### P0 - Sign-off Blockers

#### 1) Command picker coverage gap (main affordance is incomplete)

Evidence:

- The repo registers 33 commands via `addCommand(...)`.
- The command picker exposes 13 direct commands.
- Coverage is about 39 percent (13 of 33).
- Measurement method: count `executeCommand('ai-organiser:...')` in `CommandPickerModal.ts`.
  - Note: some picker items are umbrella flows (for example, enhance-note), so
    direct command count is a conservative coverage measure.
  - Picker categories are hard-coded: `src/ui/modals/CommandPickerModal.ts:135`
  - Picker executes a narrow set of commands: `src/ui/modals/CommandPickerModal.ts:163`

Missing high-value capabilities from the sparkles entry point include:

- NotebookLM: `src/commands/notebookLMCommands.ts:21`
- Bases migration: `src/commands/migrationCommands.ts:16`
- Dashboards: `src/commands/dashboardCommands.ts:16`
- Integration workflow: `src/commands/integrationCommands.ts:30`
- Highlights: `src/commands/highlightCommands.ts:13`
- Additional chat flows: `src/commands/chatCommands.ts:279`
- Related notes insertion: `src/commands/chatCommands.ts:354`

Impact:

- The primary affordance (sparkles) does not afford the full product.
- Entire features remain effectively hidden to many users.

#### 2) Command picker category styling is non-functional

Category signifiers exist in CSS but never activate.

Evidence:

- CSS expects `data-category` on the suggestion element: `styles.css:1411`
- The picker never sets `data-category` during render: `src/ui/modals/CommandPickerModal.ts:66`
- CSS targets legacy categories that do not match current categories:
  - CSS targets `tagging`, `summarize`, `smart-notes`, `translate`, `utilities`: `styles.css:1411`
  - Current categories are `create`, `enhance`, `organize`, `search`, `analyze`: `src/ui/modals/CommandPickerModal.ts:142`

Impact:

- Gestalt grouping is weakened because badges do not differentiate visually.

#### 3) i18n drift is large and material

The audit previously understated the scope. A direct scan shows a large number of untranslated notices.

Measured evidence:

- There are 53 occurrences of `new Notice('...')` across `src/ui` and `src/commands`.
- Top offenders by count of hard-coded notices:
  - `src/commands/chatCommands.ts` (15)
  - `src/ui/settings/ConfigurationSettingsSection.ts` (12)
  - `src/commands/integrationCommands.ts` (10)
  - `src/commands/summarizeCommands.ts` (10)

There are also hard-coded view strings outside Notice calls, for example:

- Tag Network view labels: `src/ui/views/TagNetworkView.ts:47`
- Related Notes view notices: `src/ui/views/RelatedNotesView.ts:404`
- Detected badge: `src/ui/modals/SummarizeSourceModal.ts:111`

Impact:

- Localization is inconsistent and unreliable in core flows.
- This undercuts the bilingual product promise.

### P1 - Clarity and Flow Issues

#### 4) RAG options are not gated by vault chat enablement

This one is a concrete mismatch between configuration and visibility.

Evidence:

- Vault chat has a toggle: `src/ui/settings/SemanticSearchSettingsSection.ts:303`
- RAG options remain visible even when vault chat is disabled: `src/ui/settings/SemanticSearchSettingsSection.ts:314`

Impact:

- Users are asked to configure disabled functionality.

#### 5) Dashboard folder selection uses `prompt()`

Evidence:

- Browser prompt is used for folder selection: `src/ui/modals/DashboardCreationModal.ts:54`

Impact:

- Inconsistent with the rest of the UI and weak on validation and guidance.

### P2 - Decision Points and DRY Improvements

These are plausible improvements but not all are clear defects. Treat them as explicit product decisions:

- Whether master toggles should hide dependent settings beyond RAG.
  - Summarization master toggle: `src/ui/settings/SummarizationSettingsSection.ts:33`
  - Bases master toggle: `src/ui/settings/BasesSettingsSection.ts:15`
- Reducing inline styles in settings for consistency.
  - Examples: `src/ui/settings/LLMSettingsSection.ts:236`, `src/ui/settings/InterfaceSettingsSection.ts:93`

## What Is Working Well

These patterns are strong and should be preserved:

- Minutes modal sequencing is dependency-first and purpose-aligned: `src/ui/modals/MinutesCreationModal.ts:157`
- Multi-source flow has clear grouping and ordering: `src/ui/modals/MultiSourceModal.ts:170`
- Scope card modals have good affordances and signifiers: `src/ui/modals/TagScopeModal.ts:69`
- Semantic search master gating is correctly implemented at the section level: `src/ui/settings/SemanticSearchSettingsSection.ts:46`

## Proposed Plan (Production-Grade)

The plan focuses on removing broken affordances first, then clarifying flow, then polishing.

### Phase 1 - Command picker completeness and signifiers (P0)

Files:

- `src/ui/modals/CommandPickerModal.ts`
- `styles.css`

Tasks:

1) Expand command coverage to include major feature areas

Minimum additions:

- NotebookLM: export, toggle selection, clear selection, open export folder
  - `src/commands/notebookLMCommands.ts:21`
- Bases and migration: upgrade metadata, upgrade folder metadata, create dashboard
  - `src/commands/migrationCommands.ts:16`
  - `src/commands/dashboardCommands.ts:16`
- Integration workflow: add to pending, integrate pending, resolve pending embeds
  - `src/commands/integrationCommands.ts:30`
- Highlights: highlight selection and remove highlight
  - `src/commands/highlightCommands.ts:13`
- Chat helpers: ask about current note and insert related notes
  - `src/commands/chatCommands.ts:279`
  - `src/commands/chatCommands.ts:354`

2) Make category styling functional

- Include a stable category id on each item.
- Set `data-category` during suggestion rendering.
- Update CSS selectors to match the actual category model.

Acceptance criteria:

- Sparkles menu exposes all major capabilities.
- Category badges have distinct, reliable visual signifiers.

### Phase 2 - i18n drift reduction (P0)

Files:

- `src/i18n/types.ts`
- `src/i18n/en.ts`
- `src/i18n/zh-cn.ts`
- Primary offenders:
  - `src/commands/chatCommands.ts`
  - `src/commands/integrationCommands.ts`
  - `src/commands/summarizeCommands.ts`
  - `src/ui/views/TagNetworkView.ts`
  - `src/ui/views/RelatedNotesView.ts`
  - `src/ui/settings/SemanticSearchSettingsSection.ts`
  - `src/ui/settings/ConfigurationSettingsSection.ts`

Tasks:

1) Add missing translation keys in a structured way

- Add new keys under existing sections rather than creating fragmented buckets.
- Keep keys tied to user-visible outcomes (for example, "semanticSearchDisabled").

2) Replace hard-coded notices and labels

- Replace `new Notice('...')` with `new Notice(plugin.t...)`.
- Replace hard-coded view strings with `plugin.t`-backed strings.

Autotranslation guidance:

- It is reasonable to auto-translate ZH-CN as a first pass.
- Production-grade standard: mark auto-translated strings for review and avoid shipping unreviewed changes when the meaning is subtle.

Acceptance criteria:

- No hard-coded English notices remain in core flows.
- Chinese UI is functionally complete even if tone review is deferred.

### Phase 3 - Gate RAG options behind vault chat (P1)

Files:

- `src/ui/settings/SemanticSearchSettingsSection.ts`

Tasks:

- Only show `ragContextChunks` and `ragIncludeMetadata` when vault chat is enabled.
- When vault chat is disabled, show a short explanation message instead of the controls.

Acceptance criteria:

- Users are not asked to configure disabled RAG features.

### Phase 4 - Replace `prompt()` with structured input (P1)

Files:

- `src/ui/modals/DashboardCreationModal.ts`

Tasks:

- Replace browser `prompt()` with an in-modal input row.
- Pre-populate the field with the current folder path.
- Validate folder existence and create when appropriate, with clear feedback.

Acceptance criteria:

- No browser prompt appears.
- Folder selection behaves consistently with other modals.

## Guardrails and Verification

To prevent the same issues from recurring, add lightweight checks:

1) Command picker coverage check

- Compare `addCommand(...)` ids to picker ids.
- Maintain an explicit allowlist for intentionally hidden commands.
- Fail the check when coverage regresses.

2) i18n drift check for notices

- Flag `new Notice('...')` patterns in `src/ui` and `src/commands`.
- Allow exceptions via a documented allowlist.

3) Manual verification checklist

- Sparkles picker exposes NotebookLM, Bases, integration, highlights, and chat helpers.
- Category badges differ by workflow category.
- Switching to ZH-CN eliminates English notices in the most common flows.
- Disabling vault chat hides RAG controls.
- Dashboard creation does not use a browser prompt.
