# Test Refactor Plan (Production-Grade)

Date: 2026-01-24
Related: `docs/test-refactor-audit.md`

## Goals
- Align tests with production behavior while preserving specification intent
- Reduce duplication and improve MECE coverage without losing unique edge cases
- Improve determinism and runtime consistency (ACID-style test properties)
- Increase regression value for critical paths

## Production-Grade Standards
- **Evidence first**: no refactor without a verified mismatch, redundancy, or coverage gap.
- **Decision log**: when tests disagree with production, record an explicit decision (change tests or code).
- **Quarantine over assumptions**: if intent is unclear, mark as skipped with TODO and a decision reference.
- **Coverage guardrails**: record line/branch coverage pre/post; investigate any drop.
- **Parity verification**: before deleting tests, prove replacement tests cover the same behavior.
- **Rollback protocol**: keep deprecated tests in a quarantine folder for a defined window or run old+new in CI until confidence is established.

## Pre-Refactor Checklist (Required)
1. Snapshot coverage (line + branch) and store result in `docs/test-refactor-metrics.md`.
2. Record current failing/passing baseline (`npm test`, `npm run test:auto`).
3. Review `docs/test-refactor-audit.md` and confirm decision points.
4. (Optional but recommended) establish a mutation-testing baseline (e.g., `npm run test:mutate`) if available.

## Coverage Thresholds
- Acceptable line coverage drop: **? 2%** total.
- Any drop > 2% requires a justification entry in `docs/test-refactor-decisions.md`.
- Any branch coverage drop must be justified regardless of size.

## Rollback Protocol
- Keep replaced tests in `tests/deprecated/` for **2 weeks** (or 2 full CI cycles) before deletion.
- Alternatively: run both old and new suites in CI for the same window and compare results.

## Proposed Refactors (Concrete)

### 1) Replace replica tests with production-module tests
**Refactor**
- Replace `tests/documentExtraction.test.ts` mock service with tests against `src/services/documentExtractionService.ts` using mocked Obsidian `App`, `requestUrl`, and dynamic `officeparser` import.
- Replace `tests/embeddedContentDetector.test.ts` with tests that call `src/utils/embeddedContentDetector.ts` directly (including bare URL detection, dedupe, `getExtractableContent`).
- Replace `tests/configurationService.test.ts` persona parsing replica with direct tests of `ConfigurationService` parsing (`minutes/personas`, icon markers, bases templates parsing).
- Replace `tests/dictionaryService.test.ts` mock dictionary service with tests targeting `src/services/dictionaryService.ts` using vault read/write mocks.

**Reason**
- Replica tests are not exercising production paths and drift already exists (see audit).

**Acceptance Criteria**
- Every parsing/extraction behavior asserted in tests is driven by production code paths.
- Helpers may exist, but assertions must exercise production behavior.

---

### 2) Consolidate source-detection tests (without losing history)
**Refactor**
- Quantify overlap first (see audit section).
- Keep files separate if desired for blame/history.
- Remove only **redundant** test cases; preserve distinct edge cases.
- Ensure a single canonical set of assertions for: `detectSourcesFromContent`, `removeProcessedSources`, `hasAnySources`, `getTotalSourceCount`.

**Reason**
- Current overlap is high and increases maintenance without clear additional coverage.

**Acceptance Criteria**
- No duplicate coverage of the same edge cases across both files.
- Unique edge cases are preserved with explicit rationale comments.

---

### 3) Resolve URL validation expectations via decision log
**Refactor**
- Confirm intended behavior for non-HTTP(S) schemes (file/ftp).
- Confirm intended behavior for legacy Office formats (`.doc/.xls/.ppt`).
  - If production should support them, update `src/core/constants.ts` and detection logic.
  - If not, update test expectations to match production.
- Add tests for IPv6 private ranges (`fc00::`, `fe80::`) **after verifying** production checks (audit confirms they exist).
- Add edge test for `.internal`/`.local` domains with mixed case.
- Add decision point for trailing-punctuation stripping in `detectBareUrls()`.

**Reason**
- Tests and production currently disagree (see audit). Requires explicit decision.

**Acceptance Criteria**
- Test expectations match documented intended behavior.
- Decision recorded in `docs/test-refactor-decisions.md`.

---

### 4) Expand DocumentExtraction coverage for new formats
**Refactor**
- Add tests for TXT and RTF extraction paths in `DocumentExtractionService`.
- Add tests for RTF readability guard (garbled content should error).
- Add tests for PDF extraction failure path (?image-based or encrypted? message).
- Add tests for `extractFromUrl`:
  - HTTPS required
  - content-length progress callback
  - officeparser missing error

**Reason**
- Production branches exist without tests; drift already identified.

**Acceptance Criteria**
- All new branches in `DocumentExtractionService` are exercised.

---

### 5) Add controller-level tests for missing branches (value-based)
**Refactor**
- `DocumentHandlingController`:
  - `detectFromContent` with resolved files
  - duplicate URL normalization (trailing slash, casing)
  - default truncation choice when `oversizedDocumentBehavior` = `full`, `truncate`, `ask`
  - ?already processing? error only if surfaced to users (otherwise defer)
- `AudioController`:
  - chunk preparation failure path
  - chunked transcription failure path
  - `transcribeAll` skips items with existing `error`

**Reason**
- Current tests cover happy path but miss key user-visible or reliability paths.

**User-Visible Outcome Definition**
- A Notice shown to the user
- A modal validation error message
- An error state displayed in UI (e.g., inline warning text)
- A state that blocks or alters a user action (e.g., buttons disabled, items skipped)

**Acceptance Criteria**
- Each added test is tied to a user-visible outcome or critical error path per the definition above.

---

### 6) Make async tests deterministic
**Refactor**
- Replace real timers (`setTimeout`) in `tests/audioController.test.ts` and `tests/documentHandlingController.test.ts` with Vitest fake timers.
- Avoid time-based assertions by controlling resolution using `vi.runAllTimersAsync()`.

**Reason**
- Eliminates flaky timing behavior and speeds up test runs (ACID consistency).

**Acceptance Criteria**
- No tests rely on real-time delays for correctness.

---

### 7) Preserve automated-tests.js unique checks (move to CI scripts)
**Refactor**
- Move `tests/automated-tests.js` to `scripts/automated-tests.js` (or `ci/`).
- Preserve checks that are not covered by Vitest:
  - i18n parity (EN/ZH structure)
  - Bases template syntax validation (filters vs filter)
  - Filter injection logic
  - Settings defaults
  - Command registration presence
- Remove only checks that are directly duplicated with strong unit tests.

**Reason**
- Automated script provides unique value not covered by unit tests; relocation clarifies purpose.

**Acceptance Criteria**
- `npm test` runs only Vitest suites.
- `npm run test:auto` or CI runs the script with all preserved checks intact.

---

### 8) Scope RAG/Embedding coverage explicitly
**Refactor**
- Decide whether RAG tests are **in-scope** for this refactor.
- If in-scope, add tests for:
  - `RAGService.getRelatedNotes()`
  - `RAGService.retrieveContext()`
  - Cache behavior (TTL and eviction)
  - Embedding service adapters
- If out-of-scope, document why and when they will be addressed.

**Reason**
- RAG is a major feature and current plan doesn?t mention it; this must be explicit.

**Acceptance Criteria**
- RAG/embedding coverage is either added or explicitly deferred in a decision log.

---

## File-Level Actions (Proposed)
- Create new test: `tests/documentExtractionService.test.ts` (production module)
- Replace content of:
  - `tests/documentExtraction.test.ts`
  - `tests/embeddedContentDetector.test.ts`
  - `tests/configurationService.test.ts`
  - `tests/dictionaryService.test.ts`
- De-duplicate overlapping cases between `tests/multiSource.test.ts` and `tests/sourceDetection.test.ts`
- Update `tests/urlValidator.test.ts` after decision log entry
- Update `tests/audioController.test.ts` and `tests/documentHandlingController.test.ts` to use fake timers
- Move `tests/automated-tests.js` to `scripts/automated-tests.js` and preserve unique checks

## Verification Protocol (Before Deleting or Replacing Tests)
1. Run old tests + new tests together; confirm equivalent outcomes.
2. If behavior differs, log decision and quarantine contested cases.
3. Compare coverage snapshots; investigate any drop beyond defined threshold.

## Sequencing (Evidence-Based)
1. Create decision log + coverage snapshot (+ mutation baseline if available)
2. Resolve URL/legacy-format decisions early (highest-risk disagreement)
3. De-duplicate source detection assertions (no file merges required)
4. Convert embedded content detector tests to production module
5. Convert document extraction tests to production module
6. Update controller tests for missing branches
7. Replace dictionary/config parsing tests with production module tests
8. Move/trim automated-tests.js
9. (If in-scope) add RAG/embedding tests

## Expected Outcomes
- Tests that reflect production behavior and documented intent
- Reduced drift and fewer false positives/negatives
- Deterministic, stable test runs with explicit coverage guardrails
- Clearer MECE coverage of core logic
