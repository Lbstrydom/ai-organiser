import { describe, it, expect } from 'vitest';
import {
    runStructureChecks,
    computeQualityScore,
    migratePresentationSession,
    classifyReliability,
    MAX_VERSIONS,
    type SlideInfo,
} from '../src/services/chat/presentationTypes';

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeSlides(overrides: Partial<SlideInfo>[] = []): SlideInfo[] {
    const defaults: SlideInfo[] = [
        { index: 0, headingText: 'Title', textLength: 50, hasNotes: false, type: 'title' },
        { index: 1, headingText: 'Content A', textLength: 200, hasNotes: true, type: 'content' },
        { index: 2, headingText: 'Content B', textLength: 180, hasNotes: true, type: 'content' },
        { index: 3, headingText: 'Closing', textLength: 40, hasNotes: false, type: 'closing' },
    ];
    return overrides.length > 0
        ? overrides.map((o, i) => ({ ...defaults[i % defaults.length], ...o, index: i }))
        : defaults;
}

// ── Structure Checks ────────────────────────────────────────────────────────

describe('runStructureChecks', () => {
    it('returns no HIGH findings for well-formed slides', () => {
        const findings = runStructureChecks(makeSlides());
        expect(findings.filter(f => f.severity === 'HIGH')).toHaveLength(0);
    });

    it('flags fewer than 3 slides', () => {
        const findings = runStructureChecks(makeSlides([
            { headingText: 'A', textLength: 100, hasNotes: true, type: 'content' },
        ]));
        expect(findings.some(f => f.issue.includes('fewer than 3'))).toBe(true);
    });

    it('flags empty content slides', () => {
        const findings = runStructureChecks(makeSlides([
            { headingText: 'Title', textLength: 50, hasNotes: false, type: 'title' },
            { headingText: 'Empty', textLength: 10, hasNotes: false, type: 'content' },
            { headingText: 'OK', textLength: 200, hasNotes: true, type: 'content' },
            { headingText: 'End', textLength: 30, hasNotes: false, type: 'closing' },
        ]));
        expect(findings.some(f => f.severity === 'HIGH' && f.issue.includes('empty'))).toBe(true);
    });

    it('flags overloaded slides', () => {
        const findings = runStructureChecks(makeSlides([
            { headingText: 'Dense', textLength: 900, hasNotes: true, type: 'content' },
        ]));
        expect(findings.some(f => f.issue.includes('overloaded'))).toBe(true);
    });

    it('flags duplicate headings', () => {
        const findings = runStructureChecks(makeSlides([
            { headingText: 'Same', textLength: 200, hasNotes: true, type: 'content' },
            { headingText: 'Same', textLength: 200, hasNotes: true, type: 'content' },
            { headingText: 'Different', textLength: 200, hasNotes: true, type: 'content' },
        ]));
        expect(findings.some(f => f.issue.includes('Duplicate'))).toBe(true);
    });

    it('flags missing speaker notes on content slides', () => {
        const findings = runStructureChecks(makeSlides([
            { headingText: 'Title', textLength: 50, hasNotes: false, type: 'title' },
            { headingText: 'No Notes', textLength: 200, hasNotes: false, type: 'content' },
            { headingText: 'End', textLength: 30, hasNotes: false, type: 'closing' },
        ]));
        expect(findings.some(f => f.severity === 'LOW' && f.issue.includes('speaker notes'))).toBe(true);
    });

    it('flags missing heading on content slide', () => {
        const findings = runStructureChecks(makeSlides([
            { headingText: '', textLength: 200, hasNotes: true, type: 'content' },
        ]));
        expect(findings.some(f => f.issue.includes('no heading'))).toBe(true);
    });
});

// ── Quality Score ───────────────────────────────────────────────────────────

describe('computeQualityScore', () => {
    it('returns 100 for no findings and no violations', () => {
        const result = computeQualityScore([], 0);
        expect(result.totalScore).toBe(100);
        expect(result.structureScore).toBe(50);
        expect(result.auditScore).toBe(50);
    });

    it('deducts structure score by severity', () => {
        const result = computeQualityScore([
            { issue: 'X', suggestion: 'Y', severity: 'HIGH' },
        ], 0);
        expect(result.structureScore).toBe(40); // 50 - 10
    });

    it('deducts audit score by violation count', () => {
        const result = computeQualityScore([], 3);
        expect(result.auditScore).toBe(26); // 50 - 3*8
    });

    it('floors scores at 0', () => {
        const result = computeQualityScore(
            Array(10).fill({ issue: 'X', suggestion: 'Y', severity: 'HIGH' }),
            10,
        );
        expect(result.structureScore).toBe(0);
        expect(result.auditScore).toBe(0);
        expect(result.totalScore).toBe(0);
    });
});

// ── Session Migration ───────────────────────────────────────────────────────

describe('migratePresentationSession', () => {
    it('migrates valid session', () => {
        const session = {
            schemaVersion: 1,
            html: '<div class="deck"><section class="slide">hi</section></div>',
            versions: [],
            conversation: [],
            brandEnabled: true,
            createdAt: '2026-01-01',
            lastActiveAt: '2026-01-02',
        };
        const result = migratePresentationSession(session);
        expect(result).not.toBeNull();
        expect(result!.html).toContain('deck');
        expect(result!.brandEnabled).toBe(true);
    });

    it('returns null for wrong schema version', () => {
        expect(migratePresentationSession({ schemaVersion: 2, html: '<div>' })).toBeNull();
    });

    it('returns null for missing html', () => {
        expect(migratePresentationSession({ schemaVersion: 1 })).toBeNull();
    });

    it('returns null for empty html', () => {
        expect(migratePresentationSession({ schemaVersion: 1, html: '' })).toBeNull();
    });

    it('returns null for non-object', () => {
        expect(migratePresentationSession(null)).toBeNull();
        expect(migratePresentationSession('string')).toBeNull();
    });

    it('defaults brandEnabled to false', () => {
        const result = migratePresentationSession({ schemaVersion: 1, html: '<div>x</div>' });
        expect(result!.brandEnabled).toBe(false);
    });
});

// ── Reliability Classification ──────────────────────────────────────────────

describe('classifyReliability', () => {
    const base = { rejectionCount: 0, hasDeckRoot: true, hasSlides: true };

    it('returns ok when clean', () => {
        expect(classifyReliability(base)).toBe('ok');
    });

    it('returns warning for 1 rejection', () => {
        expect(classifyReliability({ ...base, rejectionCount: 1 })).toBe('warning');
    });

    it('returns warning for 10 rejections', () => {
        expect(classifyReliability({ ...base, rejectionCount: 10 })).toBe('warning');
    });

    it('returns structurally-damaged for >10 rejections', () => {
        expect(classifyReliability({ ...base, rejectionCount: 11 })).toBe('structurally-damaged');
    });

    it('returns structurally-damaged when deck root missing', () => {
        expect(classifyReliability({ ...base, hasDeckRoot: false })).toBe('structurally-damaged');
    });

    it('returns structurally-damaged when slides missing', () => {
        expect(classifyReliability({ ...base, hasSlides: false })).toBe('structurally-damaged');
    });

    it('returns unreliable for >50 rejections', () => {
        expect(classifyReliability({ ...base, rejectionCount: 51 })).toBe('unreliable');
    });

    it('returns unreliable on parse timeout', () => {
        expect(classifyReliability({ ...base, parseTimedOut: true })).toBe('unreliable');
    });

    it('parse timeout takes precedence over missing structure', () => {
        expect(classifyReliability({ ...base, hasDeckRoot: false, parseTimedOut: true })).toBe('unreliable');
    });
});

// ── Constants ───────────────────────────────────────────────────────────────

describe('MAX_VERSIONS', () => {
    it('is 20', () => {
        expect(MAX_VERSIONS).toBe(20);
    });
});
