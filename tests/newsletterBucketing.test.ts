/**
 * Bucketing tests for the newsletter digest cutoff helper.
 *
 * The user's mental model: cutoff = 08:00 means digest dated D covers
 * wall-clock D 08:00 → (D+1) 08:00. These tests pin that contract at the
 * boundaries (just-before, on-the-hour, just-after) plus mid-batch spans.
 */

import { describe, it, expect } from 'vitest';
import {
    getBucketDateStr,
    getBriefDateStr,
    isBucketClosed,
} from '../src/services/newsletter/newsletterService';

describe('getBucketDateStr — cutoff-aware bucketing', () => {
    it('rolls a 03:00 timestamp into the previous day when cutoff is 08:00', () => {
        const d = new Date(2026, 3, 21, 3, 0, 0); // Apr 21 03:00 local
        expect(getBucketDateStr(d, 8)).toBe('2026-04-20');
    });

    it('buckets a 09:00 timestamp on the same day when cutoff is 08:00', () => {
        const d = new Date(2026, 3, 21, 9, 0, 0); // Apr 21 09:00 local
        expect(getBucketDateStr(d, 8)).toBe('2026-04-21');
    });

    it('treats the cutoff hour exactly as the start of the new day', () => {
        // 08:00 exactly = first message of today's bucket
        const d = new Date(2026, 3, 21, 8, 0, 0);
        expect(getBucketDateStr(d, 8)).toBe('2026-04-21');
    });

    it('07:59 is still yesterday; 08:00 is today (boundary symmetry)', () => {
        const justBefore = new Date(2026, 3, 21, 7, 59, 59);
        const onBoundary = new Date(2026, 3, 21, 8, 0, 0);
        expect(getBucketDateStr(justBefore, 8)).toBe('2026-04-20');
        expect(getBucketDateStr(onBoundary, 8)).toBe('2026-04-21');
    });

    it('handles cutoff of 0 (midnight) — wall-clock calendar day', () => {
        // Every hour is >= 0, so every timestamp buckets into its own calendar day.
        const noon = new Date(2026, 3, 21, 12, 0, 0);
        const midnight = new Date(2026, 3, 21, 0, 0, 0);
        const oneMin = new Date(2026, 3, 21, 0, 1, 0);
        expect(getBucketDateStr(noon, 0)).toBe('2026-04-21');
        expect(getBucketDateStr(midnight, 0)).toBe('2026-04-21');
        expect(getBucketDateStr(oneMin, 0)).toBe('2026-04-21');
    });

    it('handles cutoff of 23 — almost the whole day rolls back', () => {
        const noon = new Date(2026, 3, 21, 12, 0, 0);
        const evening = new Date(2026, 3, 21, 22, 59, 59);
        expect(getBucketDateStr(noon, 23)).toBe('2026-04-20');
        expect(getBucketDateStr(evening, 23)).toBe('2026-04-20');
    });

    it('accepts an ISO-8601 string (what the Apps Script payload uses)', () => {
        const iso = new Date(2026, 3, 21, 3, 0, 0).toISOString();
        expect(getBucketDateStr(iso, 8)).toBe('2026-04-20');
    });

    it('rolls a month boundary correctly (Apr 1 03:00 → Mar 31 bucket)', () => {
        const d = new Date(2026, 3, 1, 3, 0, 0); // Apr 1
        expect(getBucketDateStr(d, 8)).toBe('2026-03-31');
    });

    it('rolls a year boundary correctly (Jan 1 03:00 → Dec 31 prev year)', () => {
        const d = new Date(2026, 0, 1, 3, 0, 0); // Jan 1, 2026
        expect(getBucketDateStr(d, 8)).toBe('2025-12-31');
    });

    it('falls back to "now" bucket for malformed input (defensive)', () => {
        // Deliberate NaN — Date("bogus").getTime() is NaN.
        const result = getBucketDateStr('bogus-date-string', 8);
        // Should parse as a real YYYY-MM-DD — we don't know "now" exactly,
        // but we can at least assert the shape.
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
});

describe('getBriefDateStr — uses local time now()', () => {
    it('returns a YYYY-MM-DD string', () => {
        expect(getBriefDateStr(8)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('is equivalent to getBucketDateStr(new Date(), cutoff)', () => {
        // Snapshot both within the same millisecond window.
        const now = new Date();
        const a = getBriefDateStr(8);
        const b = getBucketDateStr(now, 8);
        expect(a).toBe(b);
    });
});

describe('bucketing a mixed batch (the scenario the user reported)', () => {
    it('splits a single fetch across two buckets when it spans the cutoff', () => {
        // User runs fetch at 09:00 on Apr 21. Gmail returns:
        //  - one email received 06:00 Apr 21 (before cutoff 08:00 → yesterday bucket)
        //  - one email received 08:30 Apr 21 (after cutoff → today bucket)
        const cutoff = 8;
        const earlyMorning = new Date(2026, 3, 21, 6, 0, 0);
        const afterCutoff = new Date(2026, 3, 21, 8, 30, 0);
        expect(getBucketDateStr(earlyMorning, cutoff)).toBe('2026-04-20');
        expect(getBucketDateStr(afterCutoff, cutoff)).toBe('2026-04-21');
    });

    it('the whole batch stays in one bucket when all messages sit the same side of cutoff', () => {
        const cutoff = 8;
        const msgs = [
            new Date(2026, 3, 21, 10, 0, 0),
            new Date(2026, 3, 21, 14, 30, 0),
            new Date(2026, 3, 21, 23, 45, 0),
        ];
        const buckets = new Set(msgs.map(m => getBucketDateStr(m, cutoff)));
        expect(buckets.size).toBe(1);
        expect([...buckets][0]).toBe('2026-04-21');
    });
});

describe('isBucketClosed — audio-podcast generation gate', () => {
    it('returns false while the bucket is still live (same day, before next-day cutoff)', () => {
        // Bucket 2026-04-21 covers Apr 21 08:00 → Apr 22 08:00 (cutoff=8)
        // "Now" is Apr 21 15:00 — bucket is LIVE, new newsletters can still
        // arrive, so audio should NOT be generated yet.
        const now = new Date(2026, 3, 21, 15, 0, 0);
        expect(isBucketClosed('2026-04-21', 8, now)).toBe(false);
    });

    it('returns false at the very instant before cutoff on the next day', () => {
        // One minute before cutoff on Apr 22 — still live
        const now = new Date(2026, 3, 22, 7, 59, 0);
        expect(isBucketClosed('2026-04-21', 8, now)).toBe(false);
    });

    it('returns true exactly at the next-day cutoff', () => {
        // 2026-04-22 08:00 = bucket 2026-04-21 CLOSES
        const now = new Date(2026, 3, 22, 8, 0, 0);
        expect(isBucketClosed('2026-04-21', 8, now)).toBe(true);
    });

    it('returns true for an old closed bucket (backfill scenario)', () => {
        // User runs a manual fetch on Apr 25 that surfaces emails from Apr 20
        // — bucket 2026-04-20 has been closed for days; audio should fire.
        const now = new Date(2026, 3, 25, 12, 0, 0);
        expect(isBucketClosed('2026-04-20', 8, now)).toBe(true);
    });

    it('honours a custom cutoff hour (not just the default)', () => {
        // cutoff = 17 (end-of-business workflow)
        // bucket 2026-04-21 closes at 2026-04-22 17:00
        const before = new Date(2026, 3, 22, 16, 30, 0);
        expect(isBucketClosed('2026-04-21', 17, before)).toBe(false);
        const after = new Date(2026, 3, 22, 17, 0, 0);
        expect(isBucketClosed('2026-04-21', 17, after)).toBe(true);
    });

    it('returns false for a malformed bucket string (defensive)', () => {
        const now = new Date(2026, 3, 25, 12, 0, 0);
        expect(isBucketClosed('not-a-date', 8, now)).toBe(false);
        expect(isBucketClosed('', 8, now)).toBe(false);
    });

    it('handles month/year rollovers', () => {
        // bucket 2025-12-31 closes at 2026-01-01 08:00
        const before = new Date(2026, 0, 1, 7, 0, 0);
        expect(isBucketClosed('2025-12-31', 8, before)).toBe(false);
        const after = new Date(2026, 0, 1, 8, 0, 0);
        expect(isBucketClosed('2025-12-31', 8, after)).toBe(true);
    });
});
