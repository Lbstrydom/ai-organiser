import { describe, it, expect } from 'vitest';
import { formatElapsed, formatDuration } from '../src/services/progress/elapsed';

describe('formatElapsed', () => {
    it('formats sub-minute as m:ss', () => {
        expect(formatElapsed(0)).toBe('0:00');
        expect(formatElapsed(5_000)).toBe('0:05');
        expect(formatElapsed(42_000)).toBe('0:42');
    });
    it('formats minutes as m:ss', () => {
        expect(formatElapsed(185_000)).toBe('3:05');
        expect(formatElapsed(59 * 60_000 + 59_000)).toBe('59:59');
    });
    it('formats >= 1h as h:mm:ss', () => {
        expect(formatElapsed(3_600_000)).toBe('1:00:00');
        expect(formatElapsed(3_600_000 + 5 * 60_000 + 9_000)).toBe('1:05:09');
    });
    it('clamps non-finite / negative / NaN to 0:00', () => {
        expect(formatElapsed(-1)).toBe('0:00');
        expect(formatElapsed(NaN)).toBe('0:00');
        expect(formatElapsed(Infinity)).toBe('0:00');
        expect(formatElapsed(-Infinity)).toBe('0:00');
    });
    it('formatDuration is a delegating alias (same output)', () => {
        expect(formatDuration).toBe(formatElapsed);
        expect(formatDuration(185_000)).toBe('3:05');
    });
});
