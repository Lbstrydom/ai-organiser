# Phase 0 Baseline - Folder Resolution Behavior

**Date**: 2026-01-25  
**Test Suite Status**: ✅ All tests passing (631 unit + 17 integration)

## Test Suite Results

### Unit Tests
```
Test Files  23 passed (23)
      Tests  631 passed (631)
   Duration  693ms
```

### Integration Tests
```
Passed: 17
Failed: 0
Total:  17
```

## Expected Folder Resolution Behavior

This baseline documents the **expected** folder resolution behavior across different settings combinations. These scenarios should be verified manually before and after refactoring to ensure no regressions.

### Scenario 1: Default Settings
**Settings:**
- `pluginFolder`: `AI-Organiser`
- `configFolderPath`: `Config`
- `notebooklmExportFolder`: `NotebookLM`

**Expected Paths:**
- Config folder: `AI-Organiser/Config`
- Dictionaries folder: `AI-Organiser/Config/dictionaries`
- NotebookLM export folder: `AI-Organiser/NotebookLM`

**Verification:**
- [ ] Creating config files writes to `AI-Organiser/Config`
- [ ] Opening a dictionary opens from `AI-Organiser/Config/dictionaries`
- [ ] "Open export folder" command opens `AI-Organiser/NotebookLM`

---

### Scenario 2: Custom Plugin Folder
**Settings:**
- `pluginFolder`: `MyPlugin`
- `configFolderPath`: `Config`
- `notebooklmExportFolder`: `NotebookLM`

**Expected Paths:**
- Config folder: `MyPlugin/Config`
- Dictionaries folder: `MyPlugin/Config/dictionaries`
- NotebookLM export folder: `MyPlugin/NotebookLM`

**Verification:**
- [ ] Creating config files writes to `MyPlugin/Config`
- [ ] Opening a dictionary opens from `MyPlugin/Config/dictionaries`
- [ ] "Open export folder" command opens `MyPlugin/NotebookLM`

---

### Scenario 3: Custom Config Subfolder
**Settings:**
- `pluginFolder`: `MyPlugin`
- `configFolderPath`: `Settings`
- `notebooklmExportFolder`: `NotebookLM`

**Expected Paths:**
- Config folder: `MyPlugin/Settings`
- Dictionaries folder: `MyPlugin/Settings/dictionaries`
- NotebookLM export folder: `MyPlugin/NotebookLM`

**Verification:**
- [ ] Creating config files writes to `MyPlugin/Settings`
- [ ] Opening a dictionary opens from `MyPlugin/Settings/dictionaries`
- [ ] "Open export folder" command opens `MyPlugin/NotebookLM`

---

### Scenario 4: Legacy Full Config Path
**Settings:**
- `pluginFolder`: `MyPlugin`
- `configFolderPath`: `MyPlugin/Config` (legacy full path)
- `notebooklmExportFolder`: `NotebookLM`

**Expected Paths:**
- Config folder: `MyPlugin/Config` (preserved, **not** `MyPlugin/MyPlugin/Config`)
- Dictionaries folder: `MyPlugin/Config/dictionaries`
- NotebookLM export folder: `MyPlugin/NotebookLM`

**Verification:**
- [ ] Creating config files writes to `MyPlugin/Config` (no double prefix)
- [ ] Opening a dictionary opens from `MyPlugin/Config/dictionaries`
- [ ] "Open export folder" command opens `MyPlugin/NotebookLM`

---

### Scenario 5: Legacy Full NotebookLM Path
**Settings:**
- `pluginFolder`: `MyPlugin`
- `configFolderPath`: `Config`
- `notebooklmExportFolder`: `MyPlugin/NotebookLM` (legacy full path)

**Expected Paths:**
- Config folder: `MyPlugin/Config`
- Dictionaries folder: `MyPlugin/Config/dictionaries`
- NotebookLM export folder: `MyPlugin/NotebookLM` (preserved, **not** `MyPlugin/MyPlugin/NotebookLM`)

**Verification:**
- [ ] Creating config files writes to `MyPlugin/Config`
- [ ] Opening a dictionary opens from `MyPlugin/Config/dictionaries`
- [ ] "Open export folder" command opens `MyPlugin/NotebookLM` (no double prefix)

---

## Known Issues (Pre-Refactoring)

Based on the implementation plan, the following issues are expected in the current codebase:

### P0 Path Issues
1. **Service Bypasses**: Commands create new `ConfigurationService` instances instead of using the singleton:
   - `src/commands/integrationCommands.ts:78`
   - `src/commands/smartNoteCommands.ts:144`

2. **Config Folder Settings UI**: Uses `AI-Organiser-Config` as placeholder instead of `Config`
   - `src/ui/settings/ConfigurationSettingsSection.ts:1016`

3. **Tag Collection Path**: May not respect custom config folder
   - `src/commands/utilityCommands.ts:12`

4. **Dictionary Folder Wiring**: May not consistently resolve under config folder
   - `src/ui/modals/MinutesCreationModal.ts:96`
   - `src/ui/modals/MinutesCreationModal.ts:1521`

5. **NotebookLM Export Folder**: Hard-coded `AI-Organiser/NotebookLM` literals in settings:
   - `src/ui/settings/NotebookLMSettingsSection.ts:52,56,64,65,80,82,90`
   - `src/commands/notebookLMCommands.ts:171`

### P1 Constants Issues
1. **Summary Hook Length**: Hard-coded `280` in multiple files:
   - `src/utils/responseParser.ts:108,185`
   - `src/commands/summarizeCommands.ts:2270`

2. **Chunk Defaults**: Hard-coded in two places:
   - `src/services/minutesService.ts:55`
   - `src/utils/textChunker.ts:16`

### P2 Provider Registry
1. **Provider DRY**: Provider lists duplicated across settings sections:
   - `src/ui/settings/LLMSettingsSection.ts:64`
   - `src/ui/settings/MobileSettingsSection.ts:118`

---

## Manual Verification Checklist

To establish baseline behavior, manually verify the following in the current codebase:

### Config Files
- [ ] Create a new summary persona via settings
- [ ] Verify it's written to the correct config folder path
- [ ] Change `pluginFolder` setting
- [ ] Create another persona, verify new path

### Dictionaries
- [ ] Open Minutes modal
- [ ] Create a new dictionary
- [ ] Verify it's saved in `{pluginFolder}/{configFolderPath}/dictionaries`
- [ ] Change `configFolderPath` setting
- [ ] Create another dictionary, verify new path

### NotebookLM
- [ ] Export a NotebookLM source pack
- [ ] Verify it's saved in `{pluginFolder}/NotebookLM` (or custom setting)
- [ ] Run "Open Export Folder" command
- [ ] Verify it opens the correct folder

### Tag Collection
- [ ] Run "Collect All Tags" command
- [ ] Verify `all-tags.md` is saved in the correct config folder

---

## Next Steps

After verifying the baseline behavior:

1. Proceed to Phase 1: Fix folder resolution helpers
2. Add unit tests for path helpers
3. Add integration tests for user-visible outcomes
4. Re-verify all scenarios in this checklist post-refactoring
5. Document any behavior changes (if approved)

---

## Notes

- This baseline was captured **before** any refactoring
- All test suites are passing
- Manual verification checklist should be completed to document actual vs. expected behavior
- Any discrepancies between expected and actual should be noted before refactoring begins
