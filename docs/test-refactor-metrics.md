# Test Refactor Metrics

Date: 2026-01-24

## Baseline (Recorded 2026-01-24)
- npm test: **591 tests passing** (21 test files)
- npm run test:auto: 22 automated integration tests
- npm run test:coverage: Recorded below
- Mutation testing: Not configured (deferred)

## Coverage Snapshot (Baseline)

| Metric | Coverage |
|--------|----------|
| Statements | 29.78% |
| Branches | 26.84% |
| Functions | 30.47% |
| Lines | 30.09% |

### Key File Coverage

| File | Lines | Branches | Notes |
|------|-------|----------|-------|
| `urlValidator.ts` | 96.77% | 95% | Well covered |
| `textChunker.ts` | 98.18% | 100% | Well covered |
| `responseParser.ts` | 98.46% | 93.33% | Well covered |
| `sourceDetection.ts` | 96.77% | 75% | Good coverage |
| `embeddedContentDetector.ts` | 64.4% | 46.91% | Needs improvement |
| `frontmatterUtils.ts` | 44.28% | 54.54% | Partial coverage |
| `tagUtils.ts` | 22.69% | 28.08% | Low coverage |
| `documentExtractionService.ts` | 77.27% | 65.21% | Good coverage |
| `minutesPrompts.ts` | 88.52% | 86.11% | Good coverage |

### Uncovered Production Modules (0% coverage)
- `configurationService.ts` (replica tests only)
- `dictionaryService.ts` (replica tests only)
- `minutesService.ts`
- `tagPrompts.ts`
- `noteStructure.ts`
- `tagOperations.ts`
- `languageUtils.ts`
- Various UI modules (expected)

## Post-Refactor Snapshot (2026-01-24)
- npm test: **639 tests passing** (+48 tests from baseline)
- npm run test:auto: 22 automated integration tests

| Metric | Baseline | Post-Refactor | Delta |
|--------|----------|---------------|-------|
| Statements | 29.78% | 36.20% | **+6.42%** |
| Branches | 26.84% | 32.64% | **+5.80%** |
| Functions | 30.47% | 36.84% | **+6.37%** |
| Lines | 30.09% | 36.41% | **+6.32%** |

### Key File Coverage Changes

| File | Baseline | Post-Refactor | Notes |
|------|----------|---------------|-------|
| `urlValidator.ts` | 96.77% | 97.22% | +0.45%, security tests added |
| `configurationService.ts` | 0% | 41.00% | **+41%**, production-module tests added |
| `dictionaryService.ts` | 0% | 77.27% | **+77%**, production-module tests added |
| `minutesPrompts.ts` | 88.52% | 88.52% | Unchanged |
| `textChunker.ts` | 98.18% | 98.18% | Unchanged |
| `responseParser.ts` | 98.46% | 98.46% | Unchanged |

### Uncovered Production Modules (Still 0%)
- `minutesService.ts` - Complex LLM integration, out of scope for unit tests
- `tagPrompts.ts` - Prompt templates, low value for unit tests
- `noteStructure.ts` - Obsidian integration heavy
- `tagOperations.ts` - Requires vault mocking

## Notes
- Acceptable line coverage delta: ≤ 2%.
- Any branch coverage drop requires justification in `docs/test-refactor-decisions.md`.
- Low overall coverage (29.78%) is expected since many modules are UI/integration code not unit tested.
- Focus on high-coverage for utility and service modules that CAN be unit tested.
