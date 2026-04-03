/**
 * Integration Output Validator Tests
 * Tests preamble stripping, content preservation, format compliance, and length sanity.
 */

import { validateIntegrationOutput, IntegrationValidationOptions } from '../src/services/validators/integrationValidator';
import { INTEGRATION_MIN_LENGTH_RATIO, INTEGRATION_MAX_LENGTH_RATIO } from '../src/services/validators/constants';

/** Helper to build options with sensible defaults */
function opts(overrides: Partial<IntegrationValidationOptions> = {}): IntegrationValidationOptions {
    return {
        placement: 'merge',
        format: 'prose',
        originalContent: '# Introduction\n\nSome content here.',
        pendingContent: 'Pending text to integrate.',
        ...overrides
    };
}

describe('validateIntegrationOutput', () => {

    // ─── Clean Output ─────────────────────────────────────────────────

    describe('clean output', () => {
        it('should return valid with no issues for well-formed output', () => {
            const output = '# Introduction\n\nSome content here.\n\n## New Section\n\nIntegrated pending text.';
            const result = validateIntegrationOutput(output, opts());
            expect(result.valid).toBe(true);
            expect(result.issues).toHaveLength(0);
            expect(result.data).toBe(output);
        });
    });

    // ─── Preamble Detection & Auto-Strip ──────────────────────────────

    describe('preamble stripping', () => {
        const preambles = [
            'Here is the integrated content:\n\n',
            'Here are the merged results:\n\n',
            "I've integrated the pending content into the note.\n\n",
            'I have combined the sections below.\n\n',
            "I've merged everything together.\n\n",
            'Below is the final output:\n\n',
            'Below are the combined sections:\n\n',
            'The following is the integrated document:\n\n',
        ];

        it.each(preambles)('should strip preamble: %s', (preamble) => {
            const body = '# Introduction\n\nContent preserved.';
            const output = preamble + body;
            const result = validateIntegrationOutput(output, opts());

            expect(result.data).toBe(body);
            const preambleIssue = result.issues.find(i => i.autoFixed);
            expect(preambleIssue).toBeDefined();
            expect(preambleIssue!.severity).toBe('info');
            expect(preambleIssue!.field).toBe('output');
        });

        it('should not strip non-preamble text', () => {
            const output = '# Introduction\n\nHere is some content that starts normally.';
            const result = validateIntegrationOutput(output, opts({
                originalContent: '# Introduction\n\nOriginal.',
            }));

            const preambleIssues = result.issues.filter(i => i.autoFixed);
            expect(preambleIssues).toHaveLength(0);
            expect(result.data).toBe(output);
        });
    });

    // ─── Content Preservation ─────────────────────────────────────────

    describe('content preservation', () => {
        it('should report no issue when all headings are preserved', () => {
            const original = '# Title\n\n## Section A\n\nContent.\n\n### Sub B\n\nMore.';
            const output = '# Title\n\n## Section A\n\nContent plus new.\n\n### Sub B\n\nMore integrated.';
            const result = validateIntegrationOutput(output, opts({ originalContent: original }));

            const headingIssues = result.issues.filter(i => i.field === 'content_preservation');
            expect(headingIssues).toHaveLength(0);
        });

        it('should warn when a heading is dropped from output', () => {
            const original = '# Title\n\n## Important Section\n\nContent.\n\n## Another Section\n\nMore.';
            const output = '# Title\n\nAll content merged into one section.';
            const result = validateIntegrationOutput(output, opts({ originalContent: original }));

            const headingIssues = result.issues.filter(
                i => i.field === 'content_preservation' && i.message.includes('Important Section')
            );
            expect(headingIssues.length).toBeGreaterThanOrEqual(1);
            expect(headingIssues[0].severity).toBe('warning');
        });

        it('should match headings case-insensitively and whitespace-normalized', () => {
            const original = '## My  Important   Heading\n\nContent.';
            const output = '## my important heading\n\nContent plus new stuff.';
            const result = validateIntegrationOutput(output, opts({ originalContent: original }));

            const headingIssues = result.issues.filter(
                i => i.field === 'content_preservation' && i.message.includes('Heading')
            );
            expect(headingIssues).toHaveLength(0);
        });

        it('should warn when embedded content markers are significantly reduced', () => {
            const original = '# Note\n\n![[image1.png]]\n![[image2.png]]\n![[image3.png]]\n![[image4.png]]';
            // Output has only 1 of 4 embeds (25% < 50% threshold)
            const output = '# Note\n\n![[image1.png]]\n\nSome rewritten text.';
            const result = validateIntegrationOutput(output, opts({ originalContent: original }));

            const embedIssues = result.issues.filter(
                i => i.field === 'content_preservation' && i.message.includes('embedded content')
            );
            expect(embedIssues.length).toBeGreaterThanOrEqual(1);
        });

        it('should skip content preservation checks for cursor placement', () => {
            const original = '# Title\n\n## Missing Section\n\nContent.';
            const output = 'Just the pending content inserted at cursor.';
            const result = validateIntegrationOutput(output, opts({
                placement: 'cursor',
                originalContent: original
            }));

            const preservationIssues = result.issues.filter(i => i.field === 'content_preservation');
            expect(preservationIssues).toHaveLength(0);
        });

        it('should skip content preservation checks for append placement', () => {
            const original = '# Title\n\n## Missing Section\n\nContent.';
            const output = 'Appended content without original headings.';
            const result = validateIntegrationOutput(output, opts({
                placement: 'append',
                originalContent: original
            }));

            const preservationIssues = result.issues.filter(i => i.field === 'content_preservation');
            expect(preservationIssues).toHaveLength(0);
        });
    });

    // ─── Format Compliance ────────────────────────────────────────────

    describe('format compliance', () => {
        it('should pass when tasks format has checkbox items', () => {
            const output = '# Tasks\n\n- [ ] Review the document\n- [x] Send the email\n- [ ] Follow up';
            const result = validateIntegrationOutput(output, opts({ format: 'tasks' }));

            const formatIssues = result.issues.filter(i => i.field === 'format');
            expect(formatIssues).toHaveLength(0);
        });

        it('should warn when tasks format has no checkbox items', () => {
            const output = '# Introduction\n\nThe tasks are to review the document and send emails.';
            const result = validateIntegrationOutput(output, opts({ format: 'tasks' }));

            const formatIssues = result.issues.filter(i => i.field === 'format');
            expect(formatIssues).toHaveLength(1);
            expect(formatIssues[0].severity).toBe('warning');
            expect(formatIssues[0].message).toContain('- [ ]');
        });

        it('should pass when table format has pipe separators', () => {
            const output = '# Data\n\n| Name | Value |\n|------|-------|\n| A | 1 |';
            const result = validateIntegrationOutput(output, opts({ format: 'table' }));

            const formatIssues = result.issues.filter(i => i.field === 'format');
            expect(formatIssues).toHaveLength(0);
        });

        it('should warn when table format has no pipe separators', () => {
            const output = '# Introduction\n\nThe data shows Name: A, Value: 1.';
            const result = validateIntegrationOutput(output, opts({ format: 'table' }));

            const formatIssues = result.issues.filter(i => i.field === 'format');
            expect(formatIssues).toHaveLength(1);
            expect(formatIssues[0].message).toContain('pipe-separator');
        });

        it('should pass when bullets format has bullet items with -', () => {
            const output = '# Points\n\n- First point\n- Second point\n- Third point';
            const result = validateIntegrationOutput(output, opts({ format: 'bullets' }));

            const formatIssues = result.issues.filter(i => i.field === 'format');
            expect(formatIssues).toHaveLength(0);
        });

        it('should pass when bullets format has bullet items with *', () => {
            const output = '# Points\n\n* First point\n* Second point';
            const result = validateIntegrationOutput(output, opts({ format: 'bullets' }));

            const formatIssues = result.issues.filter(i => i.field === 'format');
            expect(formatIssues).toHaveLength(0);
        });

        it('should warn when bullets format has no bullet items', () => {
            const output = '# Introduction\n\nAll points merged into a single paragraph of prose.';
            const result = validateIntegrationOutput(output, opts({ format: 'bullets' }));

            const formatIssues = result.issues.filter(i => i.field === 'format');
            expect(formatIssues).toHaveLength(1);
            expect(formatIssues[0].message).toContain('bullet');
        });

        it('should not check format for prose', () => {
            const output = '# Introduction\n\nJust a paragraph with no special formatting.';
            const result = validateIntegrationOutput(output, opts({ format: 'prose' }));

            const formatIssues = result.issues.filter(i => i.field === 'format');
            expect(formatIssues).toHaveLength(0);
        });
    });

    // ─── Length Sanity ────────────────────────────────────────────────

    describe('length sanity', () => {
        it('should warn when output is suspiciously short', () => {
            const original = 'A'.repeat(500);
            const pending = 'B'.repeat(500);
            // Total input = 1000 chars. Output at 10% is below INTEGRATION_MIN_LENGTH_RATIO (0.2)
            const output = 'X'.repeat(100);
            const result = validateIntegrationOutput(output, opts({
                placement: 'callout',
                originalContent: original,
                pendingContent: pending
            }));

            const lengthIssues = result.issues.filter(i => i.field === 'length');
            expect(lengthIssues).toHaveLength(1);
            expect(lengthIssues[0].message).toContain('short');
        });

        it('should warn when output is suspiciously long', () => {
            const original = 'A'.repeat(100);
            const pending = 'B'.repeat(100);
            // Total input = 200 chars. Output at 700 chars = 350% > INTEGRATION_MAX_LENGTH_RATIO (3.0)
            const output = 'X'.repeat(700);
            const result = validateIntegrationOutput(output, opts({
                placement: 'merge',
                originalContent: original,
                pendingContent: pending
            }));

            const lengthIssues = result.issues.filter(i => i.field === 'length');
            expect(lengthIssues).toHaveLength(1);
            expect(lengthIssues[0].message).toContain('long');
        });

        it('should not warn when output length is within acceptable range', () => {
            const original = 'A'.repeat(200);
            const pending = 'B'.repeat(200);
            // Total input = 400 chars. Output at 300 = 75% — between 20% and 300%
            const output = 'X'.repeat(300);
            const result = validateIntegrationOutput(output, opts({
                placement: 'merge',
                originalContent: original,
                pendingContent: pending
            }));

            const lengthIssues = result.issues.filter(i => i.field === 'length');
            expect(lengthIssues).toHaveLength(0);
        });

        it('should skip length sanity for cursor placement', () => {
            const original = 'A'.repeat(500);
            const pending = 'B'.repeat(500);
            const output = 'tiny';
            const result = validateIntegrationOutput(output, opts({
                placement: 'cursor',
                originalContent: original,
                pendingContent: pending
            }));

            const lengthIssues = result.issues.filter(i => i.field === 'length');
            expect(lengthIssues).toHaveLength(0);
        });

        it('should skip length sanity for append placement', () => {
            const original = 'A'.repeat(500);
            const pending = 'B'.repeat(500);
            const output = 'tiny';
            const result = validateIntegrationOutput(output, opts({
                placement: 'append',
                originalContent: original,
                pendingContent: pending
            }));

            const lengthIssues = result.issues.filter(i => i.field === 'length');
            expect(lengthIssues).toHaveLength(0);
        });
    });

    // ─── Multiple Issues Accumulated ──────────────────────────────────

    describe('multiple issues', () => {
        it('should accumulate issues from all checks', () => {
            const original = '# Title\n\n## Dropped Heading\n\nhttps://a.com\nhttps://b.com\nhttps://c.com\nhttps://d.com';
            const pending = 'P'.repeat(100);
            // Preamble + missing heading + missing embeds + format mismatch + short output
            const output = "Here is the integrated content:\n\n# Title\n\nShort.";

            const result = validateIntegrationOutput(output, opts({
                placement: 'callout',
                format: 'tasks',
                originalContent: original,
                pendingContent: pending
            }));

            // Expect at least: preamble (info), dropped heading (warning), embed reduction (warning), format (warning), length (warning)
            expect(result.issues.length).toBeGreaterThanOrEqual(4);

            const severities = result.issues.map(i => i.severity);
            expect(severities).toContain('info');     // preamble auto-fix
            expect(severities).toContain('warning');  // at least one warning

            // No errors means still valid
            expect(result.valid).toBe(true);
        });
    });

    // ─── valid Flag ───────────────────────────────────────────────────

    describe('valid flag', () => {
        it('should be true when only warnings and info issues exist', () => {
            // Trigger a warning (tasks format without checkboxes)
            const output = '# Introduction\n\nNo checkboxes here.';
            const result = validateIntegrationOutput(output, opts({ format: 'tasks' }));

            expect(result.valid).toBe(true);
            expect(result.issues.length).toBeGreaterThan(0);
            expect(result.issues.every(i => i.severity !== 'error')).toBe(true);
        });
    });
});
