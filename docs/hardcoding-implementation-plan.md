# Hard-Coding Remediation Plan (2026-01-25)

This plan fixes the P0 path and settings inconsistencies first, then addresses DRY and maintainability improvements.

## Goals

- Ensure user-configured folders are honored consistently.
- Eliminate path drift caused by duplicated literals and service bypasses.
- Centralize key defaults to reduce future regressions.

## Guardrails

- No destructive git commands.
- Prefer small, reversible changes with tests added in the same phase.
- If any unexpected repo changes appear, stop and ask.

## Phase 0 - Baseline and Safety Net

**Status**: ✅ COMPLETE (2026-01-25)

**Results**:
- All 631 unit tests passing
- All 17 integration tests passing
- Baseline behavior documented in [phase0-baseline.md](phase0-baseline.md)

1. Run the test suite:
   - `npm test`
   - `npm run test:auto`
2. Record baseline behavior for folder-sensitive flows:
   - Custom `pluginFolder`
   - Custom `configFolderPath`
   - Custom `notebooklmExportFolder`

Acceptance criteria:

- Tests are green before refactoring.
- Baseline notes captured in PR description or decision log.

Phase 0 tests (required):

- Run `npm test` and `npm run test:auto`.
- Capture baseline manual behavior using this checklist (concrete expected paths):

| Scenario | Settings | Expected config folder | Expected dictionaries folder | Expected NotebookLM export folder |
| --- | --- | --- | --- | --- |
| Default | `pluginFolder=AI-Organiser`, `configFolderPath=Config`, `notebooklmExportFolder=NotebookLM` | `AI-Organiser/Config` | `AI-Organiser/Config/dictionaries` | `AI-Organiser/NotebookLM` |
| Custom plugin folder | `pluginFolder=MyPlugin`, `configFolderPath=Config`, `notebooklmExportFolder=NotebookLM` | `MyPlugin/Config` | `MyPlugin/Config/dictionaries` | `MyPlugin/NotebookLM` |
| Custom config subfolder | `pluginFolder=MyPlugin`, `configFolderPath=Settings` | `MyPlugin/Settings` | `MyPlugin/Settings/dictionaries` | `MyPlugin/NotebookLM` |
| Legacy full config path | `pluginFolder=MyPlugin`, `configFolderPath=MyPlugin/Config` | `MyPlugin/Config` (preserved, not `MyPlugin/MyPlugin/Config`) | `MyPlugin/Config/dictionaries` | `MyPlugin/NotebookLM` |
| Legacy full NotebookLM path | `pluginFolder=MyPlugin`, `notebooklmExportFolder=MyPlugin/NotebookLM` | `MyPlugin/Config` | `MyPlugin/Config/dictionaries` | `MyPlugin/NotebookLM` (preserved, not double prefixed) |

Manual assertions:

- Creating config files writes to the "Expected config folder" above.
- Opening a dictionary opens from the "Expected dictionaries folder" above.
- NotebookLM "open export folder" opens the "Expected NotebookLM export folder" above.

## Phase 1 - Fix Folder Resolution (P0)

**Status**: ✅ COMPLETE

**Results**:
- Helpers added: `getConfigFolderFullPath`, `getNotebookLMExportFullPath`, `getDictionariesFolderFullPath`
- Regression tests added: `tests/pathUtils.test.ts`, `tests/pathIntegration.test.ts`
- `npm test` (25 suites, 639 tests) passing; `npm run test:auto` (17 checks) passing

### 1A) Centralize Folder Resolution Helpers

Add helpers in `src/core/settings.ts` (or a new `pathUtils.ts`) and use them everywhere:

- `getConfigFolderFullPath(settings)`
- `getNotebookLMExportFullPath(settings)`
- `getDictionariesFolderFullPath(settings)`

Compatibility rule:

- If a value already starts with `${settings.pluginFolder}/`, treat it as a legacy full path and return it unchanged.

### 1B) Remove Service Bypasses

Update commands to use the configured singleton service:

- Replace `new ConfigurationService(plugin.app)` with `plugin.configService`:
  - `src/commands/integrationCommands.ts:78`
  - `src/commands/smartNoteCommands.ts:144`

### 1C) Fix Config Folder Settings UI

Make `configFolderPath` consistently represent a subfolder:

- Update placeholder and fallback:
  - from `AI-Organiser-Config`
  - to `Config`
- When saving, set the service folder using the full-path helper, not the raw subfolder:
  - `src/ui/settings/ConfigurationSettingsSection.ts:1016`

### 1D) Fix `collect-all-tags` Pathing

Ensure tags are saved under the resolved config folder:

- Prefer passing the full config folder:
  - `TagUtils.saveAllTags(plugin.app, plugin.configService.getConfigFolder())`
- Update:
  - `src/commands/utilityCommands.ts:12`

### 1E) Fix Dictionary Folder Wiring

Ensure dictionaries live under the config folder:

- Instantiate `DictionaryService` with the resolved config folder:
  - `src/ui/modals/MinutesCreationModal.ts:96`
- Use the service to construct the path when opening a dictionary:
  - `src/ui/modals/MinutesCreationModal.ts:1521`

### 1F) Fix NotebookLM Export Folder Resolution

Treat `notebooklmExportFolder` as a subfolder by default, remove full-path literals in settings, and tolerate legacy full paths:

- Update settings UI to standardize on the subfolder value `NotebookLM` and remove hard-coded `AI-Organiser/NotebookLM` literals:
  - `src/ui/settings/NotebookLMSettingsSection.ts:52`
  - `src/ui/settings/NotebookLMSettingsSection.ts:56`
  - `src/ui/settings/NotebookLMSettingsSection.ts:64`
  - `src/ui/settings/NotebookLMSettingsSection.ts:65`
  - `src/ui/settings/NotebookLMSettingsSection.ts:80`
  - `src/ui/settings/NotebookLMSettingsSection.ts:82`
  - `src/ui/settings/NotebookLMSettingsSection.ts:90`
- Resolve the full path via helper in commands (avoid double-prefix when legacy full paths are present):
  - `src/commands/notebookLMCommands.ts:171`

Note:

- A review suggested this issue was already fixed. The current code still concatenates directly in the command and still uses full-path literals in settings, so this step remains required.

Phase 1 acceptance criteria:

- All folder-sensitive flows honor custom `pluginFolder` and subfolders.
- No double-prefix paths.
- NotebookLM settings follow the subfolder contract.
- Tests added for each fixed path.

Phase 1 tests (required):

- Add unit tests for folder helpers in `tests/pathUtils.test.ts` (new file):
  - Subfolder input -> composed full path
  - Legacy full path input -> preserved path
  - Double-prefixed legacy input (for example, `AI-Organiser/AI-Organiser/Config`) -> normalized to a single prefix (or explicitly documented behavior)
  - Trailing slashes are tolerated (for example, `AI-Organiser/Config/`)
  - Empty or undefined subfolder falls back to the intended default
- Add regression tests for user-visible outcomes in `tests/pathIntegration.test.ts` (new file):
  - Integration and smart note flows resolve personas from `{pluginFolder}/{configFolderPath}/...`
  - `collect-all-tags` writes under the resolved config folder, not vault root
  - Dictionaries resolve under the config folder and open from the same folder
  - NotebookLM export path resolves without double prefix when given legacy full paths
- Run `npm test` and `npm run test:auto`.
- Manual verification:
  - Set `pluginFolder` to a custom value and exercise tagging, dictionaries, and NotebookLM export
  - Set `configFolderPath` to a custom subfolder and create config files

Edge cases to include in tests (as applicable to helper behavior, not filesystem constraints):

- Empty `pluginFolder`
- Empty `configFolderPath` or `notebooklmExportFolder`
- Legacy full paths that do not start with the current `pluginFolder`
- Case variations (document expected behavior; treat as exact string match unless a normalization rule is introduced)

## Phase 2 - Centralize Key Constants (P1)

**Status**: ✅ COMPLETE

**Results**:
- Centralized `SUMMARY_HOOK_MAX_LENGTH` usage in code paths (response parser and summarization commands)
- Introduced shared `CHUNK_TOKEN_LIMIT` in `src/core/constants.ts` and used in minutes and chunking utilities
- Updated tests to reference shared constants (`tests/responseParser.test.ts`, `tests/textChunker.test.ts`, `tests/minutesService.test.ts`)
- `npm test` passing (25 suites, 639 tests)

### 2A) Summary Hook Length

Replace hard-coded `280` usages with `SUMMARY_HOOK_MAX_LENGTH`:

- `src/utils/responseParser.ts:108`
- `src/utils/responseParser.ts:185`
- `src/commands/summarizeCommands.ts:2270`

Implementation note:

- Update truncation math to derive `maxLength - 3` rather than using `277`.

### 2B) Shared Chunk Defaults

Centralize shared chunk defaults:

- Promote `CHUNK_TOKEN_LIMIT` to `src/core/constants.ts`
- Use it in:
  - `src/services/minutesService.ts:55`
  - `src/utils/textChunker.ts:16`

Phase 2 acceptance criteria:

- No remaining hard-coded summary hook limits outside constants.
- Shared chunk defaults live in one place.

Phase 2 tests (required):

- First audit existing tests for hard-coded values that should reference constants:
  - `tests/responseParser.test.ts` currently hard-codes `280` and `281`
  - `tests/textChunker.test.ts` currently hard-codes the default `6000`
- Update tests to import and use the shared constants once introduced:
  - Summary hook truncation respects `SUMMARY_HOOK_MAX_LENGTH`
  - Chunking defaults use the shared chunk token limit constant
- Run `npm test` and `npm run test:auto`.

## Phase 3 - Provider Registry DRY-Up (P1/P2)

**Status**: ✅ COMPLETE

**Results**:
- Introduced `src/services/adapters/providerRegistry.ts` with `ALL_ADAPTERS`, `PROVIDER_DEFAULT_MODEL`, `PROVIDER_ENDPOINT`, and `buildProviderOptions()`
- Refactored `LLMSettingsSection` to source provider options, endpoints, and default models from the registry (including endpoint/model placeholders)
- Refactored `MobileSettingsSection` to use registry for provider options and fallback model placeholder
- Added `tests/providerRegistry.test.ts` covering adapters, defaults, endpoints, and option building
- `npm test` passing (26 suites, 643 tests)

Create a provider registry that drives:

- Dropdown options
- Default models
- Placeholder hints
- Default endpoints

Suggested shape:

- `src/services/adapters/providerRegistry.ts`
  - `ALL_ADAPTERS: AdapterType[]`
  - `PROVIDER_DEFAULT_MODEL: Record<AdapterType, string>`
  - `PROVIDER_ENDPOINT: Record<AdapterType, string>`

Apply it to:

- `src/ui/settings/LLMSettingsSection.ts:64`
- `src/ui/settings/MobileSettingsSection.ts:118`
- Maps and switches in `LLMSettingsSection.ts`

Phase 3 acceptance criteria:

- Provider additions require changes in one place.
- Both settings sections reflect identical provider sets automatically.

Phase 3 tests (required):

- Add registry-focused tests in `tests/providerRegistry.test.ts` (new file):
  - All providers in `AdapterType` appear in the registry
  - Provider defaults (model and endpoint) come from the registry
  - Provider options derived from the registry are identical for LLM and Mobile settings
- Avoid heavy Obsidian UI coupling in tests:
  - Prefer testing pure registry helpers and option builders
  - Only add UI-level tests if a pure helper cannot cover the behavior
- Run `npm test` and `npm run test:auto`.

## Testing Approach (Integrated per Phase)

Testing is integrated into each phase above. A separate test plan is not required for this effort.

Cross-phase expectations:

- Every code change should ship with tests in the same phase/PR.
- Run `npm test` and `npm run test:auto` after each phase.
- Any path-related bug fix should include at least one regression test that would fail without the fix.

## Test File Organization

Use these files to keep tests focused and discoverable:

| Phase | Test file | Purpose |
| --- | --- | --- |
| 1A, 1F | `tests/pathUtils.test.ts` (new) | Path helper behavior and legacy tolerance edge cases |
| 1B-1E | `tests/pathIntegration.test.ts` (new) | Outcome-focused path resolution across commands and services |
| 2A | `tests/responseParser.test.ts` (update) | Replace hard-coded `280` with `SUMMARY_HOOK_MAX_LENGTH` |
| 2B | `tests/textChunker.test.ts` (update) | Replace hard-coded `6000` with shared chunk token limit constant |
| 3 | `tests/providerRegistry.test.ts` (new) | Registry completeness and default consistency |

## Rollout Strategy

Recommended order:

1. Phase 1 (P0 path issues)
2. Phase 2 (constants centralization)
3. Phase 3 (provider registry DRY-up)

Phase 3 should be deferred if Phase 1 reveals migration edge cases that need additional decisions.

## Open Decisions for Review

1. Confirm: `configFolderPath` should remain a subfolder under `pluginFolder`.
2. Confirm: `notebooklmExportFolder` should remain a subfolder under `pluginFolder`, with legacy full-path tolerance.

If either decision changes, the helper signatures and migration behavior should be adjusted before implementation.
