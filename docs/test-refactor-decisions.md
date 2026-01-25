# Test Refactor Decisions

Date: 2026-01-24

## Open Decisions

None.

## Closed Decisions

### D1: URL validation for non-HTTP(S) schemes
- Question: Should `validateUrl()` accept `file://` and `ftp://` (after normalization) or reject them?
- **Decision: REJECT non-HTTP(S) schemes** (update production + tests)
- Rationale: Current behavior silently converts `file://path` to `https://file//path` which is technically valid but nonsensical. This is a security concern and user confusion. URLs with existing non-HTTP(S) schemes should be explicitly rejected before any normalization.
- Actions taken:
  - [x] Update `src/utils/urlValidator.ts` to detect and reject non-HTTP(S) schemes before prepending `https://`
  - [x] Update `tests/urlValidator.test.ts` to expect rejection for `file://` and `ftp://` inputs
- Closed: 2026-01-24

### D2: Legacy Office formats (.doc/.xls/.ppt)
- Question: Should detection treat legacy formats as documents?
- **Decision: DO NOT SUPPORT legacy formats** (update tests only)
- Rationale: Modern Office formats (docx/xlsx/pptx) are XML-based and extractable reliably via `officeparser`. Legacy binary formats (.doc/.xls/.ppt) are complex, have inconsistent results, and require additional dependencies. Users should convert legacy files to modern formats.
- Actions taken:
  - [x] Production already excludes legacy formats - no change needed
  - [x] Deprecated embedded content detector tests already removed (used replica with legacy support)
  - [x] New production-module tests use production constants (no legacy support)
- Closed: 2026-01-24

### D3: Bare URL trailing punctuation
- Question: Should `detectBareUrls()` strip trailing punctuation (.,;:!?) or preserve it?
- **Decision: STRIP trailing punctuation consistently** (harmonize modules)
- Rationale: `embeddedContentDetector.ts` already strips trailing punctuation (line 166). `sourceDetection.ts` should do the same for consistency. Including trailing periods in URLs causes broken links.
- Current state:
  - `embeddedContentDetector.ts`: Strips trailing punctuation ✓
  - `sourceDetection.ts`: Does NOT strip (documented as limitation)
- Actions taken:
  - [x] Add explicit test coverage for trailing punctuation stripping in `embeddedContentDetector.test.ts`
  - [x] Document the limitation in `sourceDetection.ts` tests (already done - line 59-67)
  - [ ] Future: Consider harmonizing `sourceDetection.ts` to strip trailing punctuation
- Closed: 2026-01-24 (with documented limitation for sourceDetection.ts)

### D4: RAG / Embeddings test scope
- Question: Are RAGService and embedding adapters in-scope for this refactor?
- **Decision: OUT OF SCOPE** (defer to dedicated initiative)
- Rationale: RAG functionality has complex external dependencies (embedding APIs, vector store). Current refactor focuses on core utility modules with clear inputs/outputs. RAG testing requires:
  - Mocking embedding API responses
  - Testing vector similarity calculations
  - Testing cache behavior with time-based TTL
  - Integration testing with actual embedding providers
- Actions taken:
  - [x] Document as out of scope
  - [ ] Future: Create dedicated RAG testing initiative when time permits
- Closed: 2026-01-24

### D5: MinutesCreationModal UI tests
- Question: Should we add integration tests for MinutesCreationModal?
- **Decision: DEFER** (controller coverage is sufficient for now)
- Rationale:
  - **minutes.test.ts was removed** - it only tested mocks (createMockPlugin with mocked getMinutesPersonas), providing zero production coverage
  - **configurationService.test.ts already tests persona loading** - 6 production tests for getMinutesPersonas
  - **Controller tests exist** - AudioController (38 tests), DictionaryController (56 tests), DocumentHandlingController (29 tests) cover the modal's business logic
  - **MinutesCreationModal UI testing requires**:
    - Complex Obsidian Modal mocking (onOpen, contentEl, close lifecycle)
    - DOM manipulation testing (Setting, DropdownComponent, TextComponent)
    - Event simulation (button clicks, form submission)
    - Multiple service coordination (minutes, dictionary, document, audio)
  - The controller architecture specifically enables testing business logic without UI complexity
- Actions taken:
  - [x] Removed minutes.test.ts (tested mocks, redundant)
  - [x] Verified controller tests cover modal's business logic
  - [ ] Future: If modal bugs arise, add targeted modal tests with Obsidian mocks
- Closed: 2026-01-25
