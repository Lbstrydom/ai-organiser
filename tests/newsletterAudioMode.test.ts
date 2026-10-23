import { describe, it, expect } from 'vitest';
import {
    getAudioMode,
    isDailyAudioEnabled,
    isCatchUpEnabled,
    isAutomaticAudioMode,
    isAudioMode,
    deriveAudioMode,
    DEFAULT_AUDIO_MODE,
} from '../src/services/newsletter/newsletterAudioMode';

describe('newsletterAudioMode', () => {
    it('defaults to on-demand', () => {
        expect(DEFAULT_AUDIO_MODE).toBe('on-demand');
        expect(getAudioMode({})).toBe('on-demand');
    });

    it('falls back to the DEFAULT (never daily) on an unrecognised value', () => {
        expect(getAudioMode({ newsletterAudioMode: 'weekly' })).toBe('on-demand');
        expect(getAudioMode({ newsletterAudioMode: 42 })).toBe('on-demand');
        expect(getAudioMode({ newsletterAudioMode: null })).toBe('on-demand');
    });

    it('isAudioMode accepts exactly the three modes', () => {
        for (const m of ['on-demand', 'smart-daily', 'daily']) expect(isAudioMode(m)).toBe(true);
        for (const m of ['', 'Daily', 'off', undefined, 1]) expect(isAudioMode(m)).toBe(false);
    });

    describe('legacy daily gate keeps the old truth table', () => {
        // The pre-feature gate was `settings.newsletterAudioPodcast`. For a `daily` install the
        // new predicate must agree on EVERY value of it.
        it.each([true, false])('daily mode, newsletterAudioPodcast=%s', (flag) => {
            expect(isDailyAudioEnabled({ newsletterAudioPodcast: flag, newsletterAudioMode: 'daily' })).toBe(flag);
        });

        it('a missing flag is off', () => {
            expect(isDailyAudioEnabled({ newsletterAudioMode: 'daily' })).toBe(false);
        });

        it.each(['on-demand', 'smart-daily'] as const)('never runs the daily pipeline in %s', (mode) => {
            expect(isDailyAudioEnabled({ newsletterAudioPodcast: true, newsletterAudioMode: mode })).toBe(false);
        });
    });

    describe('catch-up availability', () => {
        it('needs the master toggle', () => {
            expect(isCatchUpEnabled({ newsletterAudioPodcast: false, newsletterAudioMode: 'on-demand' })).toBe(false);
            expect(isCatchUpEnabled({ newsletterAudioPodcast: true, newsletterAudioMode: 'on-demand' })).toBe(true);
            expect(isCatchUpEnabled({ newsletterAudioPodcast: true, newsletterAudioMode: 'smart-daily' })).toBe(true);
        });

        it('is unavailable in daily mode', () => {
            expect(isCatchUpEnabled({ newsletterAudioPodcast: true, newsletterAudioMode: 'daily' })).toBe(false);
        });

        it('daily and catch-up are mutually exclusive for every input', () => {
            for (const flag of [true, false, undefined]) {
                for (const mode of ['on-demand', 'smart-daily', 'daily', 'junk', undefined]) {
                    const s = { newsletterAudioPodcast: flag, newsletterAudioMode: mode };
                    expect(isDailyAudioEnabled(s) && isCatchUpEnabled(s)).toBe(false);
                }
            }
        });
    });

    it('only daily and smart-daily are automatic', () => {
        expect(isAutomaticAudioMode({ newsletterAudioPodcast: true, newsletterAudioMode: 'on-demand' })).toBe(false);
        expect(isAutomaticAudioMode({ newsletterAudioPodcast: true, newsletterAudioMode: 'smart-daily' })).toBe(true);
        expect(isAutomaticAudioMode({ newsletterAudioPodcast: true, newsletterAudioMode: 'daily' })).toBe(true);
        expect(isAutomaticAudioMode({ newsletterAudioPodcast: false, newsletterAudioMode: 'daily' })).toBe(false);
    });

    describe('deriveAudioMode', () => {
        it('keeps an install that had audio on on daily', () => {
            expect(deriveAudioMode({ newsletterAudioPodcast: true })).toBe('daily');
        });
        it('gives everyone else the default', () => {
            expect(deriveAudioMode({ newsletterAudioPodcast: false })).toBe('on-demand');
            expect(deriveAudioMode({})).toBe('on-demand');
        });
        it('never overwrites a valid stored mode', () => {
            expect(deriveAudioMode({ newsletterAudioMode: 'smart-daily', newsletterAudioPodcast: true })).toBe('smart-daily');
            expect(deriveAudioMode({ newsletterAudioMode: 'on-demand', newsletterAudioPodcast: true })).toBe('on-demand');
        });
        it('re-derives from the flag when the stored mode is garbage', () => {
            expect(deriveAudioMode({ newsletterAudioMode: 'bogus', newsletterAudioPodcast: true })).toBe('daily');
            expect(deriveAudioMode({ newsletterAudioMode: 7, newsletterAudioPodcast: false })).toBe('on-demand');
        });
    });
});
