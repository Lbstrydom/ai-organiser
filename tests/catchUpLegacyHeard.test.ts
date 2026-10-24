import { describe, it, expect } from 'vitest';
import { legacyHeard } from '../src/services/newsletter/catchUp/catchUpCoverage';

const rev = (n: number) => ({ kind: 'revision', rev: n }) as const;
const whole = { kind: 'whole' } as const;

describe('legacyHeard: a daily audio is coverage only as far as it was HEARD', () => {
    it('no daily audio provenance at all -> nothing', () => {
        expect(legacyHeard(null, 3, true)).toBeNull();
    });

    it('story memory off: there is no listening evidence, so nothing is covered', () => {
        expect(legacyHeard(rev(2), 2, false)).toBeNull();
        expect(legacyHeard(whole, 2, false)).toBeNull();
    });

    it.each([null, 0, -1, 1.5, Number.NaN])('an unusable watermark (%s) is no evidence', (c) => {
        expect(legacyHeard(rev(2), c as number | null, true)).toBeNull();
        expect(legacyHeard(whole, c as number | null, true)).toBeNull();
    });

    it('known narrated revision r, heard to c: covers min(r, c)', () => {
        expect(legacyHeard(rev(3), 5, true)).toEqual(rev(3));
        expect(legacyHeard(rev(3), 2, true)).toEqual(rev(2));
        expect(legacyHeard(rev(3), 3, true)).toEqual(rev(3));
    });

    it('provenance gone: covers exactly what the watermark proves, never "whole"', () => {
        expect(legacyHeard(whole, 1, true)).toEqual(rev(1));
        expect(legacyHeard(whole, 4, true)).toEqual(rev(4));
    });
});
