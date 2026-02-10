# Critical Review: Simplify Personas & Add Practical Note Styles (v3)

**Reviewer date:** 2026-02-10
**Reviewed against:** Codebase at HEAD on main branch
**Scope:** Persona plan completeness, user coverage, interface logic, effectiveness, DRY/SOLID compliance, implementation detail sufficiency

---

## Phase Summary & Completion Checklist

> Teams should tick each item as completed. Phases are ordered by dependency.

- [x] **Phase 1 — Delete Dead Code & Clean Slate**
  - [x] Delete `src/services/prompts/summaryPersonas.ts`
  - [x] Update `tests/promptInvariants.test.ts` imports (lines 38-41)
  - [x] Update `tests/configurationService.test.ts` if it references old persona IDs
  - [x] Add `personaSchemaVersion` to `AIOrganiserSettings` interface and `DEFAULT_SETTINGS`
  - [x] Implement marker-based config file migration in `configurationService.ts` + `main.ts` `onload()` (adopted recommendation #5: version comment marker instead of hashing)
  - [x] Test: old default files overwritten, custom files backed up as `.v1-defaults.md`
- [x] **Phase 2 — New Summary Personas**
  - [x] Replace `DEFAULT_SUMMARY_PERSONAS` in `configurationService.ts:174`
  - [x] Write full prompts for all 5 personas (brief, study, business-operator, feynman, learning-insight)
  - [x] Rewrite `generateSummaryPersonasFileContent()` for new personas
  - [x] Write `summary-personas.md` config file content
  - [x] Test: personas load correctly, dropdown shows 5 options
- [x] **Phase 3 — Study Dual-Output Schema Extension**
  - [x] Add `companion_content?: string` to `StructuredSummaryResponse` in `structuredPrompts.ts:11`
  - [x] Add `includeCompanion?: boolean` to `StructuredSummaryOptions` in `structuredPrompts.ts:28`
  - [x] Update `buildStructuredSummaryPrompt()` to conditionally include companion JSON field
  - [x] Update `isValidStructuredResponse()` in `responseParser.ts` to pass through `companion_content`
  - [x] Define `STUDY_COMPANION_DELIMITER` constant for traditional path
  - [x] Update `buildSummaryPrompt()` in `summaryPrompts.ts` for traditional companion
  - [x] Test: JSON parsing with/without companion_content, delimiter parsing
- [x] **Phase 4 — Companion in All Pipelines**
  - [x] Create `processCompanionOutput()` + `shouldIncludeCompanion()` shared utility (`src/utils/companionUtils.ts`)
  - [x] Wire into `summarizeAndInsert()` (URL pipeline, both structured and traditional paths)
  - [x] Wire into `summarizeInChunks()` (URL chunked pipeline)
  - [x] Wire into `handleYouTubeSummarization()`, `summarizeYouTubeAndInsert()`, `summarizeYouTubeInChunks()`
  - [x] Wire into `handlePdfSummarization()` + `handleExternalPdfSummarization()` (PDF pipeline)
  - [x] Wire into `summarizeAudioAndInsert()` + `summarizeAudioInChunks()` (audio pipeline)
  - [x] Wire into multi-source synthesis (`handleMultiSourceResult` + `buildSynthesisPrompt`)
  - [x] Wire into `summarizePlainTextAndInsert()` + `summarizePlainTextInChunks()` (plain text)
  - [x] Add structured fallback safety net (delimiter leak in body_content)
  - [x] Add i18n strings (types.ts, en.ts, zh-cn.ts)
  - [x] Thread `includeCompanion` from all callers (defaults undefined until Phase 5)
  - [x] Test: 15 tests in `tests/companionUtils.test.ts` (companion file creation, collision handling, empty no-op, shouldIncludeCompanion predicate, fallback safety)
- [x] **Phase 5 — Companion UI Toggle**
  - [x] Add `enableStudyCompanion` to `AIOrganiserSettings` and `DEFAULT_SETTINGS`
  - [x] Add conditional toggle to `UrlInputModal.ts`
  - [x] Add conditional toggle to `YouTubeInputModal.ts`
  - [x] Add conditional toggle to `MultiSourceModal.ts`
  - [x] Add conditional toggle to PDF/Audio persona selection
  - [x] Test: toggle visibility conditional on study persona, state flows through
- [x] **Phase 6 — Writing Personas Mirror**
  - [x] Replace `DEFAULT_PERSONAS` (writing, 6 current) in `configurationService.ts:87` with 5 new
  - [x] Rewrite `generatePersonasFileContent()` for new writing personas
  - [x] Bump `CURRENT_PERSONA_SCHEMA_VERSION` to 3 for config file migration
  - [x] Test: writing personas load, invariants (count, IDs, kebab-case, icons, mirror summary IDs)
- [ ] **Phase 7 — Minutes: 2 Personas + GTD**
  - [ ] Replace `DEFAULT_MINUTES_PERSONAS` in `configurationService.ts:373` with 2 new
  - [ ] Define `GTDProcessing`, `GTDAction`, `GTDWaitingItem` interfaces in `minutesPrompts.ts`
  - [ ] Add optional `gtd_processing` to `MinutesJSON` interface
  - [ ] Extend `renderMinutesFromJson()` in `minutesUtils.ts` for GTD sections
  - [ ] Add `useGTD: boolean` parameter to `buildMinutesSystemPrompt()`
  - [ ] Update `buildConsolidationPrompt()` to pass `useGTD` through
  - [ ] Update `MinutesService.generateMinutes()` to accept and pass `useGTD`
  - [ ] Add `minutesGTDOverlay` to `AIOrganiserSettings` and `DEFAULT_SETTINGS`
  - [ ] Add GTD toggle to `MinutesCreationModal.ts`
  - [ ] Rewrite `generateMinutesPersonasFileContent()` for 2 personas
  - [ ] Write `minutes-personas.md` config file content
  - [ ] Test: GTD rendering, prompt injection, persona counts
- [ ] **Phase 8 — Settings Migration & Hardcoded Fallbacks**
  - [x] Export `DEFAULT_SUMMARY_PERSONA_ID = 'brief'` from `settings.ts` (pulled forward — reviewer finding #1)
  - [x] Replace hardcoded `'student'` in `settings.ts`, `SummarizationSettingsSection.ts`, `MultiSourceModal.ts` (pulled forward)
  - [x] Update `constants.ts` comment referencing old persona names (pulled forward)
  - [ ] Add `student` -> `brief` migration in `main.ts loadSettings()` (for existing users with stored `'student'`)
  - [ ] Add `corporate-minutes` -> `internal` migration in `main.ts loadSettings()`
  - [ ] Test: migration runs, old settings map to new IDs
- [ ] **Phase 9 — i18n & Settings UI**
  - [ ] Add/update persona names/descriptions in `en.ts`
  - [ ] Add/update persona names/descriptions in `zh-cn.ts`
  - [ ] Add companion toggle labels
  - [ ] Add GTD overlay labels
  - [ ] Remove retired persona references
  - [ ] Update `SummarizationSettingsSection.ts` dropdown (5 options)
  - [ ] Update `MinutesSettingsSection.ts` dropdown (2 options)
  - [ ] Test: UI renders correctly in both languages
- [ ] **Phase 10 — Tests**
  - [ ] Delete/rewrite `summaryPersonas` test imports in `promptInvariants.test.ts`
  - [ ] Update `configurationService.test.ts` persona counts
  - [ ] Update `minutesPrompts.test.ts` for `useGTD` parameter
  - [ ] Update `minutesService.test.ts` for `useGTD` passthrough
  - [ ] Update `minutesAutoFill.test.ts` (references `corporate-minutes`)
  - [ ] Add companion schema tests
  - [ ] Add companion file creation tests
  - [ ] Add traditional companion delimiter tests
  - [ ] Add GTD schema rendering tests
  - [ ] Add GTD prompt injection tests
  - [ ] Add settings migration tests
  - [ ] Add config file migration tests
  - [ ] Run full suite: `npm test` passes
- [ ] **Phase 11 — Documentation**
  - [ ] Update `CLAUDE.md` persona system description
  - [ ] Update `AGENTS.md` persona system description
  - [ ] Update `docs/usertest.md` with new test checklist
  - [ ] Create `docs/retired-personas.md`
  - [ ] Run `npm run build` — clean build

---

## Part 1: Persona Coverage Review (User Needs Analysis)

### Are 5 summary personas sufficient for non-specialist users?

The proposed 5 personas (Brief, Study, Business Operator, Feynman, Learning & Insight) cover the major user intents well, but there are gaps and overlaps worth discussing.

**What's well covered:**
- **Quick consumption** (Brief) — the most common use case
- **Academic study** (Study) — strong for students and researchers
- **Business context** (Business Operator) — replaces Executive, more practical
- **Learning from scratch** (Feynman) — excellent for unfamiliar topics

**Critical gap: the "Casual Reader" replacement is missing.** The current `casual` persona serves a real need — people who want an accessible, non-academic, non-business summary. The plan drops it entirely. "Feynman" is close but is pedagogically structured (three audience layers), which is quite different from "give me the gist in plain language." Consider whether "Brief" absorbs this need sufficiently. If Brief is styled as Smart Brevity (journalistic, punchy), it may — but the plan should explicitly state this and the Brief prompt should be written to be accessible to casual readers, not just journalists.

**Overlap concern: Study vs Learning & Insight.** These two personas serve similar audiences (people who want to learn from content). The distinction is:
- Study = structured academic reference notes
- Learning & Insight = practical application ("how to apply", "gotchas", "cheat sheet")

This distinction is subtle. A non-specialist user choosing between "Study" and "Learning & Insight" will be confused. **Recommendation:** Either (a) merge them into one persona with a toggle for "academic vs practical" emphasis, or (b) make the names/descriptions much more distinct. Renaming "Learning & Insight" to something like "Practical Playbook" or "Action Guide" would create clearer differentiation.

**Missing persona: Plain Summary / General.** There is no "just summarise this normally without a strong opinion about structure." Every persona imposes a specific template. Some users just want a clean, well-written summary without Feynman layers or BLUF structure. The old `casual` persona partially served this. Consider adding a "General" or "Standard" persona that simply produces good markdown without opinionated structure. Alternatively, make "Brief" the general-purpose option and ensure its prompt doesn't impose too rigid a template.

### Can users edit personas later?

Yes — the existing infrastructure (`summary-personas.md`, `writing-personas.md`, `minutes-personas.md` config files) already supports user customisation. The plan correctly preserves this. The marker-based migration (adopted from recommendation #5 — version comment line instead of hashing) is a sensible approach to overwriting defaults while respecting custom edits.

**However, the plan should explicitly document** how a user adds a specialist persona (e.g., "Legal Brief", "Medical SOAP Notes") after migration. A brief section in the persona config file header explaining the format would help. Currently the generated config files have instructions — ensure the new versions do too.

---

## Part 2: Interface Logic Review

### Companion output (Phases 3-5) — Schema extension vs delimiter

The plan's analysis is correct: the structured path (`enableStructuredMetadata`) demands JSON, so a delimiter would break parsing. The `companion_content` JSON field is the right approach.

**Issues found:**

1. **The plan references line numbers that may shift.** Instead of referencing `structuredPrompts.ts:46`, `responseParser.ts:46`, etc., the plan should reference function/interface names. Line numbers will drift during implementation of earlier phases.

2. **`isValidStructuredResponse()` needs explicit handling.** The plan says "Extract companion_content from parsed JSON if present" in `parseStructuredResponse()`, but the actual validation is in `isValidStructuredResponse()` (responseParser.ts:97). This function currently only checks `summary_hook` and `body_content` as required fields. The plan must specify: add `companion_content` passthrough in `isValidStructuredResponse()` — don't reject it, don't coerce it, just leave it if present. Currently, `isValidStructuredResponse()` mutates the object (lines 111-122) but doesn't strip unknown fields, so companion_content would survive. **This should be stated explicitly** since it's a critical correctness requirement.

3. **Traditional path delimiter: the plan defines `STUDY_COMPANION_DELIMITER` but doesn't specify its value.** State it explicitly, e.g., `<<AIO_STUDY_COMPANION_END>>` mirroring `MINUTES_JSON_DELIMITER = '<<AIO_MINUTES_JSON_END>>'`.

4. **Prompt bloat concern.** Adding companion instructions to every structured prompt (even when companion is not requested) wastes tokens. The plan says "When false, schema remains as-is (no companion field)" — good. But verify that `buildStructuredSummaryPrompt()` only adds the companion JSON field and instructions when `includeCompanion: true`. This is stated but should be emphasised as a hard requirement.

### Companion file creation (Phase 4)

5. **`processCompanionOutput()` location.** The plan suggests `summarizeCommands.ts` or `src/utils/companionUtils.ts`. Given SOLID (Single Responsibility), a new `companionUtils.ts` is better — `summarizeCommands.ts` is already 3000+ lines. **Recommendation: use `src/utils/companionUtils.ts`.**

6. **The plan doesn't specify companion file content structure.** What frontmatter (if any) does the companion note get? Should it have a backlink to the parent note? Should it have `type: companion` metadata? These are UX decisions that need to be specified for implementation. Minimal recommendation:
   ```yaml
   ---
   companion_to: "[[Original Note]]"
   ---
   ```

7. **YouTube pipeline specifics are thin.** The plan says "YouTube uses traditional prompts only (Gemini)." This is correct (YouTube goes through Gemini's native video API, not the structured path). But it needs to specify: where exactly in `handleYouTubeSummarization()` to inject the delimiter instructions into the Gemini prompt, and how to split the response. The function is complex (~300 lines) — the plan should identify the specific LLM call point and response handling point.

### GTD overlay (Phase 7)

8. **`buildMinutesSystemPrompt()` signature change is breaking.** Currently the signature is `buildMinutesSystemPrompt(outputLanguage: string, personaInstructions: string)`. Adding `useGTD: boolean` as a third parameter changes every call site:
   - `minutesService.ts:83` — direct call
   - `minutesPrompts.ts:372` — called from `buildConsolidationPrompt()`

   The plan mentions both but should specify: **use an options object** instead of a third positional boolean to avoid future breaking changes:
   ```typescript
   interface MinutesPromptOptions {
       outputLanguage: string;
       personaInstructions: string;
       useGTD?: boolean;
   }
   ```
   This is more SOLID (Open-Closed Principle) and prevents another signature change if future overlays are added.

9. **GTD JSON schema position in the prompt.** The plan says "add gtd_processing to the JSON schema section" of the system prompt. But the current MinutesJSON schema in the prompt (minutesPrompts.ts:210-265) is already very long. Adding GTD fields will push the prompt further into context window limits, especially for chunked transcripts. **The plan should specify**: only inject GTD schema when `useGTD: true`, matching the companion pattern (conditional injection to avoid token waste).

10. **`renderMinutesFromJson()` signature.** Currently `renderMinutesFromJson(json: MinutesJSON, detailLevel: MinutesDetailLevel)`. The GTD section should render regardless of `detailLevel` (it's an overlay, not a detail level). The plan says "Only render if json.gtd_processing exists and is non-empty" — good, but explicitly state it ignores `detailLevel`.

### Companion UI toggle (Phase 5)

11. **Conditional visibility complexity.** The plan says the toggle should "show only when selected persona is study" and "re-renders on persona dropdown change." This requires:
    - Each modal to watch its persona dropdown for changes
    - Toggle element to be added/removed dynamically

    **Implementation detail needed:** Specify whether to use `display: none` CSS toggling or DOM add/remove. CSS toggling is simpler and avoids re-render issues. The modals already use Obsidian's `Setting` API which doesn't natively support show/hide — the team needs to know to use `settingEl.style.display = 'none'` or `toggleClass()`.

12. **PDF/Audio modals.** The plan says "these use PersonaSelectModal or inline persona selection." There is no `PersonaSelectModal` in the codebase — PDF summarization is triggered from `handlePdfSummarization()` which receives `personaPrompt` as a parameter, selected upstream in the URL/smart summarize flow. The plan needs to trace the actual flow: the persona is selected in the initial command modal (UrlInputModal, SmartSummarizeModal, etc.), not at the PDF level. So the companion toggle needs to be in those upstream modals, not in a "PDF modal."

---

## Part 3: Effectiveness of Proposed Personas

### Summary personas

**Brief:** Well-conceived. Smart Brevity style is proven effective. Renaming from "Smart Brevity" avoids trademark issues. The prompt should include: (1) lede, (2) "why it matters", (3) "go deeper" bullets, (4) bottom line. **The plan describes this structure but doesn't include the actual prompt text** — a coding team cannot implement without the full prompt. See detailed specification gap below.

**Study:** The "Big Picture table, concept-by-concept deep dives (Logic/Evidence/Why), comparison tables, exam checklist" structure is ambitious. This will produce very long output for complex content. Consider adding a word count target or section count limit to the prompt to prevent runaway output.

**Business Operator:** Good replacement for Executive. The "Unknowns & Confidence (3 tiers: Verified/Assumptions/Missing)" section is excellent and differentiates from Brief. The BLUF + Options & Trade-offs pattern is standard consulting output.

**Feynman:** Three-audience layered explanation is creative but risky. LLMs may produce three full summaries (3x the output length) rather than progressively layered content. The prompt must be very specific about format: use `> [!note]` callouts or tabbed sections, not three sequential walls of text. **Mermaid and KaTeX instructions are good** but need a fallback for models that don't know Mermaid syntax. Add: "If you cannot generate valid Mermaid syntax, describe the diagram in text."

**Learning & Insight:** "What I knew vs what's new" table is a nice touch for personal knowledge management. "Practice exercises" may not apply to all content types (e.g., summarising a news article). The prompt should say "Include practice exercises only when the content is instructional or educational."

### Minutes personas

**Reducing from 5 to 2 is aggressive but defensible.** The removed personas (action-register-only, client-mom-short, technical-review) served niche needs:
- Action-register-only → users can achieve this with `minutesDetailLevel: 'concise'`
- Client-mom-short → users can achieve this with `outputAudience: 'external'`
- Technical-review → genuinely niche, reasonable to drop

**Naming concern: "Internal" vs "Board / External".** These names suggest audience, not format — which conflicts with the existing `meetingContext` and `outputAudience` dropdowns. The plan acknowledges this (Decision: "Personas control structure/tone only") but then names one "Internal" and the other "Board / External." This **will** confuse users. **Strongly recommend renaming:**
- "Internal" → "Standard" (concise, action-oriented)
- "Board / External" → "Governance" (formal, resolutions, fiduciary)

The plan itself notes this as a possibility ("consider 'Standard' instead of 'Internal' if naming confusion is a risk") — it IS a risk, make the call now.

### Writing personas

Mirroring summary names is a sound decision for consistency. However, the writing persona prompts serve a different purpose — they rewrite existing note content rather than summarising external content. The plan's style descriptions (Brief → "BLUF, short bullets", Study → "Hierarchical, tables-over-prose") are appropriate for rewriting. **No gaps here.**

---

## Part 4: DRY & SOLID Compliance

### DRY Issues

1. **`summaryPersonas.ts` duplication is correctly identified.** The plan to delete it is right — `DEFAULT_SUMMARY_PERSONAS` in `configurationService.ts` is the runtime source of truth, and `summaryPersonas.ts` is a dead copy. However, the plan should note: `configurationService.ts` exports a `Persona` interface, while `summaryPersonas.ts` exports a `SummaryPersona` interface. They are structurally identical. The tests import `SummaryPersona` type and `BUILTIN_PERSONAS` from the dead file. When rewriting tests, import `Persona` from `configurationService.ts` and `DEFAULT_SUMMARY_PERSONAS` to replace `BUILTIN_PERSONAS`.

2. **`DEFAULT_SUMMARY_PERSONA_ID` constant — correct DRY fix.** Currently `'student'` appears in 3 places. Exporting a constant from `settings.ts` is the right approach. **But also update** `src/core/constants.ts:38` which has a comment referencing `'student'`.

3. **Companion processing DRY.** The plan correctly proposes `processCompanionOutput()` as a shared function — good. But it should also extract the "is this the study persona and is companion enabled?" check into a shared predicate:
   ```typescript
   function shouldIncludeCompanion(personaId: string | undefined, settings: AIOrganiserSettings): boolean
   ```
   This avoids duplicating the condition in 5+ pipeline locations.

4. **Minutes persona ID similarly needs a constant:** `DEFAULT_MINUTES_PERSONA_ID = 'internal'` (replacing hardcoded `'corporate-minutes'` in `settings.ts:223` and `minutesAutoFill.test.ts:16`).

### SOLID Issues

5. **Single Responsibility (SRP).** The plan puts `processCompanionOutput()` in `summarizeCommands.ts`. This file is already 3000+ lines and handles all summarisation commands. Adding companion file creation violates SRP. **Move to `src/utils/companionUtils.ts`** as noted above.

6. **Open-Closed Principle (OCP).** The `buildMinutesSystemPrompt()` signature change (adding `useGTD`) violates OCP — it modifies an existing interface. Using an options object (see point 8 above) is more extensible.

7. **Interface Segregation (ISP).** The `MinutesGenerationInput` interface will gain a `useGTD` field. This is fine — it's an optional boolean and doesn't force callers to provide it.

8. **Dependency Inversion (DIP).** The plan correctly follows the existing DI pattern in `MinutesCreationModal` (injecting services). Companion creation should similarly be injectable for testability — `processCompanionOutput()` should accept `vault` as a parameter rather than importing it globally.

---

## Part 5: Implementation Detail Gaps

These are areas where a coding team would be stuck or would have to make unguided decisions.

### Critical gaps

**Gap 1: Full persona prompt text is missing.** The plan provides structure descriptions (e.g., "Brief: Scannable summary — what happened, why it matters, what's next") but not the actual prompt text that goes into the `prompt` field of each persona. The current personas have 20-40 line prompts each. A team cannot implement without these. **The plan must include the complete prompt text for all 12 personas** (5 summary + 5 writing + 2 minutes), or reference a separate document containing them.

**Gap 2: ~~`forceOverwritePersonas()` implementation detail~~ — RESOLVED.** Implemented as `migratePersonaConfigFiles(oldVersion)` on `ConfigurationService`, using the marker-based approach (recommendation #5 below) instead of hashing. Each generated config file includes `<!-- AI Organiser Persona Config v{N} — Do not edit this line -->` at the top. On migration: if old marker found → overwrite; if marker missing (user customised) → backup to `.v{old}-defaults.md` then overwrite. Called from `main.ts` `onload()` when `settings.personaSchemaVersion < CURRENT_PERSONA_SCHEMA_VERSION`. Test coverage added in `configurationService.test.ts`.

**Gap 3: `MinutesGenerationInput` threading of `useGTD`.** The plan says to update `generateMinutes()` in `minutesService.ts` to accept `useGTD`, but doesn't trace the full call chain:
1. `MinutesCreationModal` → sets `state.useGTD`
2. `MinutesCreationModal.onSubmit()` → builds `MinutesGenerationInput` → needs `useGTD` field
3. `MinutesService.generateMinutes()` → receives `useGTD`
4. `generateMinutes()` → calls `buildMinutesSystemPrompt()` with `useGTD`
5. For chunked path: `generateMinutesChunked()` also needs to pass `useGTD` to `buildConsolidationPrompt()`

The plan should specify all 5 touch points.

**Gap 4: YouTube companion injection point.** `handleYouTubeSummarization()` uses Gemini's native video API, which means the prompt goes through a different path than the standard LLM call. The plan says "append companion delimiter instructions to prompt" but doesn't specify which prompt string variable in the function, or how to split the Gemini response. Provide the specific variable name and the exact split logic.

**Gap 5: Multi-source companion handling.** The multi-source pipeline processes multiple sources sequentially, each producing individual summaries, then optionally synthesises them (line ~932). If the study persona is selected:
- Does each per-source summary get a companion? (Probably not — too many files)
- Does only the final synthesis get a companion? (More likely)
- The plan says "After combined output assembled, split companion content if present" — but the synthesis call uses `callSummarizeService()` which returns plain text. Where do companion instructions get injected into the synthesis prompt?

**Recommendation:** Companion output should only be generated for the final synthesis, not per-source. Inject companion instructions into the synthesis prompt at line ~932.

### Minor gaps

**Gap 6: Config file paths.** The plan references `summary-personas.md`, `writing-personas.md`, `minutes-personas.md` but the actual paths in the codebase are retrieved from `getConfigPaths()` in `configurationService.ts`. The plan should reference these programmatic paths, not assumed filenames.

**Gap 7: `SummarizationSettingsSection.ts` companion toggle.** The plan says to add the toggle here, but the companion toggle should also appear in the individual modal UIs (UrlInputModal, YouTubeInputModal). Having it ONLY in settings means it can't be toggled per-invocation. Having it BOTH in settings (as default) and in modals (as override) is the better UX. The plan says Phase 5 adds it to modals — good — but Phase 9 also adds it to settings. **Clarify the relationship:** settings = persistent default, modal = per-invocation override (like how persona selection currently works).

**Gap 8: Error handling for companion creation.** What happens if the companion file creation fails (e.g., file system error, vault locked)? The plan says `processCompanionOutput()` creates via `vault.create()` but doesn't specify error handling. Recommend: catch errors, show a Notice ("Companion note could not be created"), but don't fail the main summary insertion.

**Gap 9: GTD toggle wiring in `MinutesCreationModal.ts`.** The plan says "Add GTD toggle alongside dualOutput and obsidianTasks toggles (~L388-L401). Wire state.useGTD through to the minutes service." The modal currently has a complex form state. The plan should specify:
- Add `useGTD: boolean` to the modal's state object
- Add a `Setting` toggle in the options section
- Pass `useGTD` in the `MinutesGenerationInput` when calling the service

**Gap 10: `tests/minutesAutoFill.test.ts` is not mentioned.** This file references `'corporate-minutes'` (line 16) and needs updating to `'internal'`. Add it to the Phase 10 test update list.

---

## Part 6: Ordering & Dependency Issues

### Phase ordering is mostly correct but has one issue:

**Phase 8 (Settings Migration) should come BEFORE Phase 2 (New Personas).** Reason: if you replace `DEFAULT_SUMMARY_PERSONAS` (Phase 2) before adding the migration (Phase 8), there's a window where `DEFAULT_SETTINGS.defaultSummaryPersona` is `'student'` but `DEFAULT_SUMMARY_PERSONAS` no longer has a `'student'` entry. This would cause the dropdown to show no default. **Recommended order:**

1. Phase 1 (Delete dead code) — independent
2. Phase 8 (Settings migration + `DEFAULT_SUMMARY_PERSONA_ID` constant) — set the constant to `'brief'`
3. Phase 2 (New Summary Personas) — now safe because the default ID is `'brief'`
4. Phase 6 (Writing Personas) — independent of 3-5
5. Phase 7 (Minutes + GTD) — independent of 3-5
6. Phase 3 (Companion schema) — depends on Phase 2 for Study persona
7. Phase 4 (Companion pipelines) — depends on Phase 3
8. Phase 5 (Companion UI) — depends on Phase 4
9. Phase 9 (i18n) — depends on all persona phases
10. Phase 10 (Tests) — depends on all implementation phases
11. Phase 11 (Documentation) — last

---

## Part 7: Additional Recommendations

### 1. Persona editability guidance
Add a `## Custom Personas` section at the top of each generated persona config file explaining the format. Example:
```markdown
<!--
To add a custom persona, copy an existing block and modify it.
Each persona needs: ## Name, **Description**, and a prompt starting with **Role:**.
Your custom personas are preserved across plugin updates.
-->
```

### 2. Consider a "General" 6th summary persona
As noted above, there's no "just summarise it" option. If you add one, make it the default instead of Brief. Brief implies a specific short format; General would be the safe default for users who haven't thought about persona choice.

### 3. Companion file naming
The plan says `{activeFileName} - Companion.md`. Consider using `{activeFileName} (Study Companion).md` to make the relationship clearer in file listings. Also consider: what if the user runs Study twice on the same note? The `getAvailableFilePath()` collision handling will create `(2)` suffixes, but consider whether the old companion should be overwritten instead.

### 4. GTD horizon-of-focus — value validation
The plan defines `horizon_of_focus: string` with values like "Runway/10K/20K/30K/40K/50K" but doesn't validate the LLM output. Add validation in `renderMinutesFromJson()` to handle unknown/malformed values gracefully (just render whatever string the LLM provides).

### 5. Config file overwrite — simpler alternative to hashing ✅ ADOPTED
~~Instead of hashing, consider adding a comment line at the top of generated config files.~~
**Implemented** as `personaVersionMarker(version)` in `configurationService.ts`. Each generated config file includes `<!-- AI Organiser Persona Config v{N} — Do not edit this line -->`. On migration: old marker present → overwrite; marker missing → backup + overwrite. See `migratePersonaConfigFiles()` for full implementation.

### 6. `buildMinutesSystemPrompt` — use options object pattern
As noted in point 8, the current positional parameters pattern will keep breaking as features are added. Convert to an options object now:
```typescript
interface MinutesSystemPromptOptions {
    outputLanguage: string;
    personaInstructions: string;
    useGTD?: boolean;
    detailLevel?: MinutesDetailLevel;  // future-proofing
}
```

### 7. Test coverage for persona prompt quality
Consider adding invariant tests for the new personas similar to the existing `promptInvariants.test.ts` pattern:
- Each persona prompt > 200 chars
- Each persona prompt contains a role/audience instruction
- Each persona prompt contains an output template section
- No persona prompt contains placeholder text like "[TODO]" or "TBD"

---

## Part 8: Summary of Required Plan Amendments

| # | Issue | Severity | Action Required |
|---|-------|----------|-----------------|
| 1 | Full persona prompt texts missing | **Critical** | Write all 12 persona prompts (5 summary + 5 writing + 2 minutes) |
| 2 | Hash-based migration needs specifics | **High** | Specify algorithm, storage, mobile fallback, or use comment-line approach |
| 3 | Phase ordering: Phase 8 before Phase 2 | **High** | Reorder to avoid broken default state |
| 4 | Minutes persona naming ("Internal") | **High** | Rename to "Standard" / "Governance" |
| 5 | Study vs Learning & Insight overlap | **Medium** | Improve naming or merge |
| 6 | No "General/Standard" summary persona | **Medium** | Consider adding, or explicitly document Brief as default |
| 7 | Companion file frontmatter undefined | **Medium** | Specify companion note structure |
| 8 | YouTube companion injection point | **Medium** | Specify exact function location and variable |
| 9 | Multi-source companion: per-source vs synthesis | **Medium** | Clarify: synthesis only |
| 10 | `buildMinutesSystemPrompt` options object | **Medium** | Use options object pattern |
| 11 | `minutesAutoFill.test.ts` not listed | **Low** | Add to Phase 10 |
| 12 | `processCompanionOutput()` location | **Low** | Use `companionUtils.ts`, not `summarizeCommands.ts` |
| 13 | Companion toggle: settings vs modal relationship | **Low** | Document: settings = default, modal = override |
| 14 | Error handling for companion creation | **Low** | Specify: catch, Notice, don't fail main operation |
| 15 | `constants.ts:38` comment references 'student' | **Low** | Add to Phase 8 cleanup list |
