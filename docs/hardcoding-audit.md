# Hard-Coding Audit (2026-01-25)

## Executive Summary

The most important hard-coding problems are not style issues; they are path and settings inconsistencies that can cause user configuration to be ignored. The highest-risk items are all about folder resolution and service bypasses.

Top priorities:

1. Config folder plumbing is inconsistent and bypassed in multiple commands.
2. Tag collection likely writes to the wrong directory.
3. Dictionary paths are wired to the plugin root instead of the config folder.
4. NotebookLM export folder can be double-prefixed, and the settings UI hard-codes a full path in multiple places.

These are P0 because they can break expected behavior when users customize folders.

## Scope and Method

- Repository scan using `rg` plus targeted file review.
- Focus: places where literals override settings, duplicate registries, or encode assumptions that should be computed.
- No code changes performed as part of this audit.

## Findings (Ordered by Severity)

### P0 - Config Folder Resolution Is Ambiguous and Bypassed

Evidence:

- `configFolderPath` is documented as a subfolder under the plugin folder: `src/core/settings.ts:92`.
- The plugin composes the full path at runtime: `src/main.ts:212`.
- The settings UI stores what looks like a full folder and sets it directly on the service:
  - `src/ui/settings/ConfigurationSettingsSection.ts:1015`
  - `src/ui/settings/ConfigurationSettingsSection.ts:1016`
- Some commands bypass the configured service and fall back to the default folder:
  - `src/commands/integrationCommands.ts:78`
  - `src/commands/smartNoteCommands.ts:144`
  - `src/services/configurationService.ts:447`

Impact:

- User-configured paths can be ignored in some flows.
- Behavior can differ by command even within the same session.

Recommendation:

- Make `configFolderPath` consistently represent a subfolder (for example, `Config`).
- Always resolve the full path via a single helper and use `plugin.configService`.

### P0 - `collect-all-tags` Likely Writes to the Wrong Place

Evidence:

- Command passes a subfolder-like value: `src/commands/utilityCommands.ts:12`.
- `saveAllTags` treats that value as a full path: `src/utils/tagUtils.ts:422`.

Impact:

- Tags may be saved to `Config/...` at vault root instead of `AI-Organiser/Config/...`.

Recommendation:

- Pass the full resolved config path (for example, from `plugin.configService.getConfigFolder()`).

### P0 - Dictionary Paths Do Not Use the Config Folder

Evidence:

- `DictionaryService` expects a config folder: `src/services/dictionaryService.ts:38`.
- The modal injects the plugin root instead: `src/ui/modals/MinutesCreationModal.ts:96`.
- Dictionary file opening bypasses the service and uses a hard-coded root path: `src/ui/modals/MinutesCreationModal.ts:1521`.

Impact:

- Dictionaries can be stored or opened from the wrong location, especially if the config folder is customized.

Recommendation:

- Instantiate `DictionaryService` with the resolved config folder.
- Use `dictionaryService.getDictionariesFolder()` when constructing paths.

### P0 - NotebookLM Export Folder Can Be Double-Prefixed

Evidence:

- Settings define the export folder as a subfolder: `src/core/settings.ts:226`.
- The shared helper is simple concatenation and does not guard legacy full paths: `src/core/settings.ts:241`.
- The settings UI uses full-path fallbacks and options:
  - `src/ui/settings/NotebookLMSettingsSection.ts:52`
  - `src/ui/settings/NotebookLMSettingsSection.ts:64`
  - `src/ui/settings/NotebookLMSettingsSection.ts:90`
- The command concatenates `pluginFolder` with the configured value:
  - `src/commands/notebookLMCommands.ts:171`

Impact:

- If the setting contains `AI-Organiser/NotebookLM`, the command can resolve to `AI-Organiser/AI-Organiser/NotebookLM`.

Recommendation:

- Treat `notebooklmExportFolder` as a subfolder by default.
- Resolve the full path in one helper that can also tolerate legacy full-path values.

Note on review feedback:

- A review suggested this issue was already fixed via `getPluginSubfolderPath()`. That is not true in the current codebase. The helper does not perform prefix detection (`src/core/settings.ts:241`), and the command still concatenates directly (`src/commands/notebookLMCommands.ts:171`).

## P1 - DRY and Consistency Opportunities

### Summary Hook Length Is Hard-Coded in Multiple Places

Evidence:

- Constant exists: `src/core/constants.ts:46`.
- Hard-coded values remain:
  - `src/utils/responseParser.ts:108`
  - `src/utils/responseParser.ts:185`
  - `src/commands/summarizeCommands.ts:2270`

Impact:

- Easy for behavior to drift away from the intended limit.

Recommendation:

- Import and use `SUMMARY_HOOK_MAX_LENGTH` everywhere.

### Provider Registries Are Duplicated Across Settings Sections

Evidence:

- Provider options duplicated:
  - `src/ui/settings/LLMSettingsSection.ts:64`
  - `src/ui/settings/MobileSettingsSection.ts:118`
- Default models and endpoints are encoded in multiple maps and switches:
  - `src/ui/settings/LLMSettingsSection.ts:115`
  - `src/ui/settings/LLMSettingsSection.ts:133`

Impact:

- Provider additions or changes are easy to miss in one of the copies.

Recommendation:

- Create a single provider registry that drives options, defaults, and placeholders, and use `AdapterType` as the source of truth.

### Plugin Folder Fallback Literals Are Repeated

Evidence:

- `AI-Organiser` is repeated as a fallback:
  - `src/commands/summarizeCommands.ts:110`
  - `src/commands/flashcardCommands.ts:146`
  - `src/services/vector/vectorStoreService.ts:141`

Impact:

- Minor drift risk; encourages future copy/paste.

Recommendation:

- Use `DEFAULT_PLUGIN_FOLDER` or a shared path helper.

### NotebookLM Settings Hard-Code a Full Path

Evidence:

- The full path `AI-Organiser/NotebookLM` is hard-coded repeatedly in the settings UI:
  - `src/ui/settings/NotebookLMSettingsSection.ts:52`
  - `src/ui/settings/NotebookLMSettingsSection.ts:56`
  - `src/ui/settings/NotebookLMSettingsSection.ts:64`
  - `src/ui/settings/NotebookLMSettingsSection.ts:65`
  - `src/ui/settings/NotebookLMSettingsSection.ts:80`
  - `src/ui/settings/NotebookLMSettingsSection.ts:82`
  - `src/ui/settings/NotebookLMSettingsSection.ts:90`

Impact:

- This conflicts with the stated contract that `notebooklmExportFolder` is a subfolder under `pluginFolder`.
- It increases the risk of double-prefix paths and makes future changes harder.

Recommendation:

- Standardize on a subfolder value (for example, `NotebookLM`) and compute the full path through a helper.

### Config Folder Naming Is Inconsistent

Evidence:

- The settings UI uses `AI-Organiser-Config` as a fallback:
  - `src/ui/settings/ConfigurationSettingsSection.ts:1015`
- Defaults and comments suggest the subfolder should be `Config`:
  - `src/core/settings.ts:193`

Impact:

- Confusing for users and can create unexpected folders.

Recommendation:

- Standardize on `Config` as the subfolder and compute full paths consistently.

### Chunk and Cache Defaults Are Not Centralized

Evidence:

- Minutes chunk token limit: `src/services/minutesService.ts:55`.
- Text chunker default: `src/utils/textChunker.ts:16`.
- Search cache defaults live only in the class constructor:
  - `src/services/vector/vectorStoreService.ts:30`

Impact:

- Default behavior is harder to reason about and update safely.

Recommendation:

- Move shared defaults into `src/core/constants.ts` and reference them.

## Decision Points to Confirm Before Implementation

1. Should `configFolderPath` remain a subfolder under `pluginFolder` (recommended), or become a fully-qualified path?
2. Should `notebooklmExportFolder` remain a subfolder under `pluginFolder` (recommended), while tolerating legacy full paths?

Both decisions strongly affect migration and backward compatibility details in the implementation plan.
