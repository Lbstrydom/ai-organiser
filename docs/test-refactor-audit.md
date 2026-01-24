# Test Refactor Audit (Replica vs Production)

Date: 2026-01-24
Scope: Compare existing tests to production implementations to identify concrete drift, missing coverage, and ambiguous expectations.

## Summary
- Confirmed production/test drift in multiple areas (URL validation, embedded content detection, document extensions).
- Some tests validate mock/replica logic that does not exercise production paths.
- Several production behaviors are untested (bare URL detection, TXT/RTF extraction, extractFromUrl edge cases).

## Findings (Concrete Mismatches)

### 1) URL validation: non-HTTP(S) schemes
**Test**: `tests/urlValidator.test.ts`
- Tests claim `file://` and `ftp://` inputs become valid after prepending `https://`.
  - Lines 120?131: ?should add https to file:// making it a valid https URL? and ?ftp://? equivalent.

**Production**: `src/utils/urlValidator.ts`
- `validateUrl()` rejects any protocol other than `http:` or `https:`.
  - `if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { valid: false, error: 'Only HTTP and HTTPS URLs are allowed' }`.

**Impact**: Tests encode behavior that production does not implement. This can mask real regressions or encode a bug as expected behavior.

---

### 2) Embedded document extensions (legacy formats)
**Test**: `tests/embeddedContentDetector.test.ts`
- Replica logic treats `.doc`, `.xls`, `.ppt` as ?document?.
  - Local constant `DOCUMENT_EXTENSIONS` includes legacy Office formats.

**Production**: `src/utils/embeddedContentDetector.ts` + `src/core/constants.ts`
- Production uses `EXTRACTABLE_DOCUMENT_EXTENSIONS = ['docx', 'xlsx', 'pptx', 'txt', 'rtf']` plus `.pdf`.
- Legacy `.doc/.xls/.ppt` are NOT included.

**Impact**: Tests accept detections that production will classify as `internal-link` (or non-document), causing false confidence.

---

### 3) Missing coverage of production bare-URL detection
**Test**: `tests/embeddedContentDetector.test.ts`
- Replica detector only handles markdown and wiki link syntax; no bare URL coverage.

**Production**: `src/utils/embeddedContentDetector.ts`
- `detectBareUrls()` detects raw `http/https` URLs, strips trailing punctuation, and classifies them.

**Impact**: Production behavior could regress without test signal; replica tests can?t catch this.

---

### 4) Document extraction formats in tests vs production
**Test**: `tests/documentExtraction.test.ts`
- Mock service supports only `docx/xlsx/pptx/pdf`.

**Production**: `src/services/documentExtractionService.ts`
- Supports `txt` and `rtf` explicitly, plus `.pdf`.

**Impact**: Tests are stale relative to production; newly added branches are untested.

---

## Overlap Quantification (Source Detection Tests)
**Files**: `tests/multiSource.test.ts`, `tests/sourceDetection.test.ts`

**Counts (by test cases)**:
- `multiSource.test.ts`: 25 tests total.
- `sourceDetection.test.ts`: 58 tests total.
- Exact overlap by test name: 2 tests
  - ?should return 0 for empty sources?
  - ?should return true when sources exist?

**Functional overlap (by targeted production functions)**:
- 18/25 tests in `multiSource.test.ts` exercise the same production functions already covered in `sourceDetection.test.ts`:
  - `detectSourcesFromContent` (9 tests)
  - `getTotalSourceCount` (2 tests)
  - `hasAnySources` (2 tests)
  - `removeProcessedSources` (5 tests)

**Impact**: Low name-level overlap but high functional overlap (~72% of `multiSource.test.ts`).

---

## Findings (Replica Tests That Don?t Exercise Production)

### 5) ConfigurationService persona parsing
**Test**: `tests/configurationService.test.ts`
- Defines a local `parsePersonasContent` and tests that logic directly.

**Production**: `src/services/configurationService.ts`
- Contains its own parsing logic for personas and Bases templates.

**Impact**: Tests pass even if production parsing regresses. This is a spec test, not a regression test for the actual implementation.

---

### 6) DictionaryService parsing logic
**Test**: `tests/dictionaryService.test.ts`
- Tests a `MockDictionaryService` implementation, not the production `DictionaryService`.

**Production**: `src/services/dictionaryService.ts`
- Implements parsing, persistence, and extraction behavior via vault APIs.

**Impact**: No direct coverage of production parsing and I/O behavior.

---

## Non-Mismatch but Risky Assumptions

### 7) Source detection overlap (duplication without drift)
- `tests/multiSource.test.ts` and `tests/sourceDetection.test.ts` both cover `detectSourcesFromContent`, `removeProcessedSources`, `getTotalSourceCount`, and `hasAnySources`.
- Not a mismatch, but increases maintenance and can conceal subtle expectation differences.

---

## Flakiness & Determinism Risk Notes
**Observed potential flake risk (no CI data in repo)**:
- `tests/audioController.test.ts`: uses real `setTimeout` to check intermediate state.
- `tests/documentHandlingController.test.ts`: uses real `setTimeout` to check in-progress extraction.

**Impact**: Time-based tests can be flaky under CI load; recommended to migrate to fake timers.

---

## Decision Points to Confirm
- Should `validateUrl()` accept or reject non-HTTP(S) schemes? (If accept, production change required; if reject, test update required.)
- Should legacy `.doc/.xls/.ppt` be recognized as documents? (If yes, update constants; if no, update tests.)
- Should `detectBareUrls()` strip trailing punctuation (.,;:!?) or preserve it? (If behavior should differ, update production + tests.)

---

## Verification Notes
- IPv6 private range checks **are implemented** in production: `src/utils/urlValidator.ts` includes `fc00:` and `fe80:` patterns in `PRIVATE_IP_RANGES`.

---

## Recommendations
- Treat items 1?4 as immediate drift issues.
- Convert replica tests in items 5?6 to production-module tests.
- Preserve redundant tests only if they cover distinct edge cases; otherwise, consolidate or clearly annotate.

## Decision Points to Confirm
- See the Decision Points section above (moved and expanded).
