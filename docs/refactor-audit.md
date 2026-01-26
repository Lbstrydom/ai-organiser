# Refactor Audit (DRY/SOLID/Encapsulation + Hardcoding)

Date: 2026-01-26
Scope: `src/commands`, `src/services`, `src/ui`, `src/utils`, `src/core`, `src/i18n`
Method: static inspection for duplication, interface leaks, cross-layer coupling, and hard-coded values/strings.

Summary
- Critical: 1
- High: 2
- Medium: 4
- Low: 2

## Findings

### F1 (Critical) — LLM call branching is duplicated across commands
Evidence
- `src/commands/translateCommands.ts:122` (translateWithLLM)
- `src/commands/integrationCommands.ts:374` (callLLMForIntegration)
- `src/commands/flashcardCommands.ts:177` (callLLMForFlashcards)
- `src/commands/smartNoteCommands.ts:277`, `:415`, `:485`, `:581` (multiple summarizeText branches)
- `src/commands/summarizeCommands.ts:1108`, `:3064` (summarize branches)

Impact
- Violates DRY and DIP; changes to request flow, logging, or error handling need to be repeated in many places.
- Increases risk of inconsistent behavior between features.

Recommendation
- Add a single, typed entry point for summarization (e.g., `LLMFacade.summarizeText`) and use it everywhere.
- Encapsulate local vs cloud routing inside that helper/facade.

### F2 (High) — LLM interface does not declare summarization methods
Evidence
- `src/services/types.ts:55` (LLMService lacks summarizeText/analyzeMultipleContent)
- `src/commands/chatCommands.ts:137` uses `as any` to call summarizeText
- `src/services/minutesService.ts:291` uses `typeof service.summarizeText`

Impact
- Breaks interface substitutability (LSP) and forces runtime checks and casts.
- Makes it hard to centralize LLM behavior safely.

Recommendation
- Make `summarizeText` optional (`summarizeText?`) OR introduce a separate `SummarizableLLMService` interface (ISP).
- Keep return types aligned with `CloudLLMService`/`LocalLLMService`.

### F3 (High) — Privacy notice gating duplicated in multiple commands
Evidence
- `src/commands/smartNoteCommands.ts:257`, `:342`, `:465`, `:565` plus local `showPrivacyNotice` at `:649`
- `src/commands/summarizeCommands.ts:1614`, `:1721`, `:1765`, `:1827`, `:1982`, `:2357` plus local `showPrivacyNotice` at `:2650`

Impact
- Cross-cutting logic is duplicated and easy to drift.
- Harder to adjust policy (e.g., provider list, notice copy, or once-per-session behavior).

Recommendation
- Centralize to `ensurePrivacyConsent(plugin, provider)` in `src/services/privacyNotice.ts` or a new helper.
- Remove per-file `showPrivacyNotice` duplicates.

### F4 (Medium) — Error handling patterns are repeated and inconsistent
Evidence
- `src/commands/translateCommands.ts` (translateNote/translateSelection)
- `src/commands/flashcardCommands.ts` (generateAndExportFlashcards)
- `src/commands/integrationCommands.ts` (integrate pending content)
- `src/commands/smartNoteCommands.ts` (multiple try/catch blocks)

Impact
- Repeated Notice formatting, differing error strings, and inconsistent i18n usage.

Recommendation
- Add a small wrapper (e.g., `executeWithNotice`) that standardizes error handling and optional Notice texts.

### F5 (Medium) — Hard-coded UI strings remain in command/modals
Evidence
- `src/commands/integrationCommands.ts:27`, `:60`, `:145`, `:169`, `:203` (command names)
- `src/commands/chatCommands.ts:43`, `:52`, `:94` (modal title and copy)
- Quick modal button/label strings in `src/commands/integrationCommands.ts` (e.g., “Add”, “Cancel”, modal titles)

Impact
- Inconsistent i18n coverage and user experience; violates encapsulation of translations.

Recommendation
- Prioritize removing fallback literals that bypass i18n (fallback strings are the actual hardcoding).
- Move those fallbacks into `src/i18n/types.ts`, `src/i18n/en.ts`, `src/i18n/zh-cn.ts`.
- Keep `plugin.t` as the primary source and avoid literal defaults in UI paths.

### F6 (Medium) — Hard-coded extension lists and magic numbers
Evidence
- `src/commands/integrationCommands.ts:356` (inline image/audio/video arrays)
- `src/utils/embeddedContentDetector.ts:29` (IMAGE_EXTENSIONS/AUDIO_EXTENSIONS defined locally)
- `src/commands/smartNoteCommands.ts:317` (min content length 50 chars)
- `src/commands/smartNoteCommands.ts:624` (2000-char snippet for search terms)

Impact
- Duplicates domain rules, making future changes error-prone.

Recommendation
- Move the existing image/audio extension constants from `embeddedContentDetector.ts` to `src/core/constants.ts`, then import everywhere.
- Replace inline arrays in `integrationCommands.ts` with those shared constants.
- Centralize thresholds in `src/core/constants.ts` (`MIN_TEXT_CONTENT_CHARS`, `SEARCH_TERM_SNIPPET_CHARS`).

### F7 (Low) — Service capability checks are scattered
Evidence
- `src/commands/smartNoteCommands.ts` computes `serviceType` repeatedly and checks `serviceSupportsMultimodal` alongside privacy logic.

Impact
- Encapsulation leak: command layer owns capability logic.

Recommendation
- Expose capabilities via a single helper (e.g., `getServiceCapabilities(plugin)`), used by commands.

### F8 (Low) — Minutes modal still mixes orchestration + rendering
Evidence
- `src/ui/modals/MinutesCreationModal.ts` remains large with multiple rendering sections and orchestration.

Impact
- Harder to test and evolve, though not as urgent as LLM/DRY issues.

Recommendation
- Consider extracting sections into render helpers or dedicated view components after core refactors.

## Not Found
- `docs/hardcoding-implementation-plan.md` and `docs/refactoring-plan.md` are not present in this repo; audit is based on current source state.

## Existing Consolidation to Leverage (Prior Art)
- Unified workflow helpers already exist (e.g., `transcribeAudioWithFullWorkflow`, `summarizePdfWithFullWorkflow`). These are good patterns to follow when extracting new shared flows.
- Provider registries already centralize provider defaults/endpoints (`src/services/adapters/providerRegistry.ts`), so refactors should avoid re-implementing that logic.

## Risk Notes
- Most changes are structural; behavior should remain identical if helpers preserve existing flow.
- i18n changes must keep EN/ZH key parity (automated tests will catch mismatches).
