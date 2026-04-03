import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { MermaidChangeDetector } from '../src/services/mermaidChangeDetector';

let detector: MermaidChangeDetector;

beforeEach(() => {
    detector = new MermaidChangeDetector();
});

// ── captureSnapshot ─────────────────────────────────────────────────────────

describe('captureSnapshot', () => {
    it('stores a snapshot that can be retrieved via hasSnapshot', () => {
        const content = '# Intro\nSome note about architecture patterns.';
        detector.captureSnapshot('fp1', content);
        expect(detector.hasSnapshot('fp1')).toBe(true);
    });

    it('overwrites a previous snapshot for the same fingerprint', () => {
        const contentA = '# Alpha\nOriginal content about dogs and cats.';
        const contentB = '# Beta\nCompletely different content about rockets and planets.';
        detector.captureSnapshot('fp1', contentA);
        // After overwrite, checking staleness against contentB should not be stale
        // because the snapshot now matches contentB
        detector.captureSnapshot('fp1', contentB);
        const result = detector.checkStaleness('fp1', contentB);
        expect(result.isStale).toBe(false);
        expect(result.similarity).toBe(1);
    });
});

// ── checkStaleness ──────────────────────────────────────────────────────────

describe('checkStaleness', () => {
    it('returns not stale with similarity 1 when no snapshot exists', () => {
        const result = detector.checkStaleness('unknown', '# Hello\nWorld');
        expect(result.isStale).toBe(false);
        expect(result.similarity).toBe(1);
    });

    it('returns not stale for identical content', () => {
        const content = '# Project Plan\nWe need to implement the authentication module with OAuth tokens.';
        detector.captureSnapshot('fp1', content);
        const result = detector.checkStaleness('fp1', content);
        expect(result.isStale).toBe(false);
        expect(result.similarity).toBe(1);
    });

    it('detects heading additions as stale', () => {
        const original = '# Introduction\nContent about the project overview and goals.';
        const modified = '# Introduction\n## New Section\nContent about the project overview and goals.';
        detector.captureSnapshot('fp1', original);
        const result = detector.checkStaleness('fp1', modified);
        expect(result.isStale).toBe(true);
    });

    it('detects heading removals as stale', () => {
        const original = '# Introduction\n## Details\nContent about architecture design patterns.';
        const modified = '# Introduction\nContent about architecture design patterns.';
        detector.captureSnapshot('fp1', original);
        const result = detector.checkStaleness('fp1', modified);
        expect(result.isStale).toBe(true);
    });

    it('detects keyword overlap drop when topic changes significantly', () => {
        const original = '# Notes\nThe database migration strategy involves PostgreSQL replication and sharding across multiple nodes with consistent hashing.';
        const modified = '# Notes\nThe frontend redesign strategy involves React components and TypeScript interfaces with Tailwind styling and accessibility compliance.';
        detector.captureSnapshot('fp1', original);
        const result = detector.checkStaleness('fp1', modified);
        expect(result.isStale).toBe(true);
        expect(result.similarity).toBeLessThan(0.70);
    });

    it('returns not stale for minor edits with same headings and high Jaccard', () => {
        const original = '# Architecture\nThe system uses microservices with Docker containers and Kubernetes orchestration for deployment.';
        const modified = '# Architecture\nThe system uses microservices with Docker containers and Kubernetes orchestration for production deployment.';
        detector.captureSnapshot('fp1', original);
        const result = detector.checkStaleness('fp1', modified);
        expect(result.isStale).toBe(false);
        expect(result.similarity).toBeGreaterThanOrEqual(0.70);
    });
});

// ── snooze / isSnoozed ──────────────────────────────────────────────────────

describe('snooze / isSnoozed', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('suppresses staleness for 30 minutes', () => {
        const original = '# Notes\nDatabase migration with PostgreSQL replication and sharding.';
        const modified = '# Redesign\nFrontend architecture using React components and TypeScript interfaces with Tailwind.';
        detector.captureSnapshot('fp1', original);

        detector.snooze('fp1');
        expect(detector.isSnoozed('fp1')).toBe(true);

        // Even though content changed dramatically, staleness is suppressed
        const result = detector.checkStaleness('fp1', modified);
        expect(result.isStale).toBe(false);
        expect(result.similarity).toBe(1);
    });

    it('is no longer snoozed after 30 minutes elapse', () => {
        detector.captureSnapshot('fp1', '# Test\nSome content about testing strategies.');
        detector.snooze('fp1');
        expect(detector.isSnoozed('fp1')).toBe(true);

        // Advance time past snooze duration (30 minutes)
        vi.advanceTimersByTime(30 * 60 * 1000 + 1);

        expect(detector.isSnoozed('fp1')).toBe(false);
    });

    it('creates a placeholder snapshot when snoozing without existing snapshot', () => {
        expect(detector.hasSnapshot('fp-new')).toBe(false);

        detector.snooze('fp-new');

        expect(detector.hasSnapshot('fp-new')).toBe(true);
        expect(detector.isSnoozed('fp-new')).toBe(true);
    });

    it('returns false for isSnoozed on unknown fingerprint', () => {
        expect(detector.isSnoozed('nonexistent')).toBe(false);
    });
});

// ── clearSnapshot ───────────────────────────────────────────────────────────

describe('clearSnapshot', () => {
    it('removes stored snapshot data', () => {
        detector.captureSnapshot('fp1', '# Heading\nContent about software engineering.');
        expect(detector.hasSnapshot('fp1')).toBe(true);

        detector.clearSnapshot('fp1');
        expect(detector.hasSnapshot('fp1')).toBe(false);
    });

    it('does not throw when clearing nonexistent fingerprint', () => {
        expect(() => detector.clearSnapshot('nonexistent')).not.toThrow();
    });
});

// ── hasSnapshot ─────────────────────────────────────────────────────────────

describe('hasSnapshot', () => {
    it('returns false for unknown fingerprint', () => {
        expect(detector.hasSnapshot('unknown')).toBe(false);
    });

    it('returns true after capture', () => {
        detector.captureSnapshot('fp1', 'content');
        expect(detector.hasSnapshot('fp1')).toBe(true);
    });

    it('returns false after clear', () => {
        detector.captureSnapshot('fp1', 'content');
        detector.clearSnapshot('fp1');
        expect(detector.hasSnapshot('fp1')).toBe(false);
    });
});

// ── Word set processing ─────────────────────────────────────────────────────

describe('word set processing', () => {
    it('excludes stop words and short words from similarity', () => {
        // "the", "and", "is", "a" are stop words; "of" is stop; "go" is <= 2 chars
        const content = 'The architecture is a good example of design and go.';
        detector.captureSnapshot('fp1', content);

        // Same meaning but with different stop words — should remain similar
        const modified = 'An architecture was the good example for design or go.';
        const result = detector.checkStaleness('fp1', modified);
        // "architecture", "good", "example", "design" survive in both
        expect(result.similarity).toBe(1);
        expect(result.isStale).toBe(false);
    });

    it('strips frontmatter before building word set', () => {
        const withFrontmatter = '---\ntitle: My Note\ntags: [alpha, beta]\n---\n# Heading\nContent about testing strategies.';
        const withoutFrontmatter = '# Heading\nContent about testing strategies.';
        detector.captureSnapshot('fp1', withFrontmatter);
        const result = detector.checkStaleness('fp1', withoutFrontmatter);
        // Frontmatter words like "title", "tags", "alpha", "beta" should not affect similarity
        expect(result.similarity).toBe(1);
        expect(result.isStale).toBe(false);
    });

    it('strips code blocks before building word set', () => {
        const withCode = '# API\nThe service layer handles requests.\n```typescript\nconst handler = new RequestHandler();\n```';
        const withoutCode = '# API\nThe service layer handles requests.';
        detector.captureSnapshot('fp1', withCode);
        const result = detector.checkStaleness('fp1', withoutCode);
        // Code block words should not affect similarity
        expect(result.similarity).toBe(1);
        expect(result.isStale).toBe(false);
    });

    it('strips inline code before building word set', () => {
        const withInline = '# Notes\nUse `requestHandler` for the service layer architecture.';
        const withoutInline = '# Notes\nUse the service layer architecture.';
        detector.captureSnapshot('fp1', withInline);
        const result = detector.checkStaleness('fp1', withoutInline);
        // "requesthandler" from inline code should not appear in word set
        expect(result.similarity).toBe(1);
        expect(result.isStale).toBe(false);
    });
});

// ── Empty content edge cases ────────────────────────────────────────────────

describe('empty content edge cases', () => {
    it('handles empty content for capture and check', () => {
        detector.captureSnapshot('fp1', '');
        const result = detector.checkStaleness('fp1', '');
        expect(result.isStale).toBe(false);
        expect(result.similarity).toBe(1);
    });

    it('handles transition from empty to non-empty content', () => {
        detector.captureSnapshot('fp1', '');
        const result = detector.checkStaleness('fp1', '# New Heading\nSignificant content about quantum computing research.');
        // Headings changed (empty → non-empty) so it should be stale
        expect(result.isStale).toBe(true);
    });

    it('handles transition from non-empty to empty content', () => {
        detector.captureSnapshot('fp1', '# Heading\nContent about machine learning algorithms.');
        const result = detector.checkStaleness('fp1', '');
        expect(result.isStale).toBe(true);
    });
});
