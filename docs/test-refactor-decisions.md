# Test Refactor Decisions

Date: 2026-01-24

## Open Decisions

### D1: URL validation for non-HTTP(S) schemes
- Question: Should `validateUrl()` accept `file://` and `ftp://` (after normalization) or reject them?
- Current production behavior: Rejects non-HTTP(S) schemes.
- Current tests: Expect `file://` and `ftp://` to be valid after prefixing.
- Decision: PENDING
- Actions:
  - If accept: update `src/utils/urlValidator.ts` and add tests.
  - If reject: update `tests/urlValidator.test.ts` expectations.

### D2: Legacy Office formats (.doc/.xls/.ppt)
- Question: Should detection treat legacy formats as documents?
- Current production behavior: NOT included in `EXTRACTABLE_DOCUMENT_EXTENSIONS`.
- Current tests: Treat legacy formats as documents in embedded detection replica.
- Decision: PENDING
- Actions:
  - If support: update `src/core/constants.ts` and detection logic, add extraction coverage if needed.
  - If not: update tests to align with production.

### D3: Bare URL trailing punctuation
- Question: Should `detectBareUrls()` strip trailing punctuation (.,;:!?) or preserve it?
- Current production behavior: Strips trailing punctuation.
- Current tests: No direct coverage in embedded content detector suite.
- Decision: PENDING
- Actions:
  - If change: update production + add explicit tests.
  - If keep: add tests to lock behavior.

### D4: RAG / Embeddings test scope
- Question: Are RAGService and embedding adapters in-scope for this refactor?
- Decision: PENDING
- Actions:
  - If in-scope: add tests for `getRelatedNotes`, `retrieveContext`, cache TTL/eviction, embedding adapters.
  - If out-of-scope: document rationale and defer.

## Closed Decisions
- None yet.
