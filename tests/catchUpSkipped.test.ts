import { describe, it, expect } from 'vitest';
import { formatDateList, isContiguous } from '../src/services/newsletter/catchUp/catchUpFormat';
import { getTranslations } from '../src/i18n';

const t = getTranslations('en');

describe('date wording that never hides a gap', () => {
    it('lists a handful of dates and counts the rest', () => {
        expect(formatDateList(t, ['2026-10-21', '2026-10-24'])).toBe('2026-10-21, 2026-10-24');
        const many = ['01', '02', '03', '04', '05', '06', '07'].map((d) => `2026-10-${d}`);
        expect(formatDateList(t, many)).toBe('2026-10-01, 2026-10-02, 2026-10-03, 2026-10-04, 2026-10-05 and 2 more');
    });

    it('consecutive days are contiguous, a gap is not, one or zero dates trivially are', () => {
        expect(isContiguous(['2026-10-30', '2026-10-31', '2026-11-01'])).toBe(true);
        expect(isContiguous(['2026-10-21', '2026-10-23'])).toBe(false);
        expect(isContiguous(['2026-10-21'])).toBe(true);
        expect(isContiguous([])).toBe(true);
    });
});
