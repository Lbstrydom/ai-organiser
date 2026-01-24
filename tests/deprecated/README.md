# Deprecated Tests

**Scheduled for deletion: 2026-02-07** (2 weeks from 2026-01-24)

These tests have been replaced by production-module tests that exercise the actual production code rather than replica implementations.

## Replacement mapping

| Deprecated File | Replaced By |
|-----------------|-------------|
| `embeddedContentDetector.deprecated.ts` | `tests/embeddedContentDetector.test.ts` (production module tests) |
| `documentExtraction.deprecated.ts` | `tests/documentExtractionService.test.ts` |

## Why deprecated

These tests used replica implementations that could drift from production behavior:
- Replica parsing logic that duplicated production code
- Test-only helper functions that weren't exercised in production
- Extension lists that could diverge from `src/core/constants.ts`

## Rollback protocol

If issues are discovered with the new production-module tests:
1. Re-enable deprecated tests by moving back to `tests/`
2. Compare behavior discrepancies
3. Update production-module tests to cover missing edge cases
4. Document decision in `docs/test-refactor-decisions.md`
