import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright e2e config — real-browser (Chromium) tests that the unit suite
 * (happy-dom) cannot model: Content-Security-Policy + iframe-sandbox enforcement
 * for the presentation preview (sanitizer Phase 2 / Decision 7).
 *
 * Run with `npm run test:e2e` (requires `npx playwright install chromium`).
 * NOT part of `npm test` — Vitest only globs ".test.ts" files; these e2e specs
 * are ".spec.ts" under tests/e2e/, so the two suites never overlap.
 */
export default defineConfig({
    testDir: './tests/e2e',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: 0,
    reporter: 'list',
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ],
});
