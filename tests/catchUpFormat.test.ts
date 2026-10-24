import { describe, it, expect } from 'vitest';
import { formatDates, formatEpisodeDone, formatPendingSummary, lookbackClampNote } from '../src/services/newsletter/catchUp/catchUpFormat';
import { getTranslations } from '../src/i18n';

const t = getTranslations('en');

describe('catch-up wording', () => {
    it('a very short episode is never "about 0 min"', () => {
        expect(formatEpisodeDone(t, 0, '2 days')).toBe('Episode ready — under a minute covering 2 days.');
        expect(formatEpisodeDone(t, 0.4, '2 days')).toBe('Episode ready — under a minute covering 2 days.');
        expect(formatEpisodeDone(t, 1, '2 days')).toBe('Episode ready — about 1 min covering 2 days.');
        expect(formatEpisodeDone(t, 14.2, '2 days')).toBe('Episode ready — about 14 min covering 2 days.');
    });

    it('a retention period shorter than the window is said, with the days actually covered', () => {
        expect(lookbackClampNote(t, 14, 7)).toBe('Your retention setting keeps only 7 days of newsletters, so a catch-up covers at most 7 days.');
        expect(lookbackClampNote(t, 7, 30)).toBeNull();
        expect(lookbackClampNote(t, 14, 0)).toBeNull(); // 0 = keep forever
        expect(lookbackClampNote(t, 7, 7)).toBeNull();
    });

    it('singular and plural summaries read as lower-case counts', () => {
        expect(formatPendingSummary(t, 1, 1)).toBe('1 day · 1 newsletter');
        expect(formatPendingSummary(t, 3, 12)).toBe('3 days · 12 newsletters');
    });

    it('a few dates are listed, many are a range', () => {
        expect(formatDates(t, ['2026-10-21', '2026-10-22'])).toBe('2026-10-21, 2026-10-22');
        expect(formatDates(t, ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'])).toBe('2026-10-01 – 2026-10-05');
        // Scattered dates are never turned into a range that would claim the gaps.
        expect(formatDates(t, ['2026-10-01', '2026-10-03', '2026-10-05', '2026-10-07', '2026-10-09'])).toBe('2026-10-01, 2026-10-03, 2026-10-05, 2026-10-07, 2026-10-09');
    });
});
