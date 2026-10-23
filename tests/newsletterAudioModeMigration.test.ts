import { describe, it, expect } from 'vitest';
import { migrateOldSettings, migrateNewsletterAudioSettings, DEFAULT_SETTINGS } from '../src/core/settings';

describe('newsletter audio settings migration', () => {
    it('a brand-new install (no stored settings) gets on-demand from the defaults', () => {
        expect(migrateOldSettings(null)).toBeNull();
        expect(DEFAULT_SETTINGS.newsletterAudioMode).toBe('on-demand');
        expect(DEFAULT_SETTINGS.newsletterAudioPodcast).toBe(false);
    });

    it('an install that had audio ON stays on daily (existing behaviour preserved)', () => {
        const out = migrateOldSettings({ newsletterAudioPodcast: true })!;
        expect(out.newsletterAudioMode).toBe('daily');
        expect(out.newsletterAudioPodcast).toBe(true);
    });

    it('an install that had audio OFF takes the default and stays off', () => {
        const out = migrateOldSettings({ newsletterAudioPodcast: false })!;
        expect(out.newsletterAudioMode).toBe('on-demand');
        expect(out.newsletterAudioPodcast).toBe(false);
    });

    it('an empty stored object takes the default', () => {
        expect(migrateOldSettings({})!.newsletterAudioMode).toBe('on-demand');
    });

    it('is idempotent and never overwrites a valid mode', () => {
        const once = migrateOldSettings({ newsletterAudioPodcast: true })!;
        const twice = migrateOldSettings({ ...once })!;
        expect(twice.newsletterAudioMode).toBe('daily');
        const chosen = migrateOldSettings({ newsletterAudioPodcast: true, newsletterAudioMode: 'smart-daily' })!;
        expect(chosen.newsletterAudioMode).toBe('smart-daily');
        expect(migrateOldSettings({ ...chosen })!.newsletterAudioMode).toBe('smart-daily');
    });

    it('a user who switched an old daily install to on-demand is not flipped back', () => {
        const out = migrateOldSettings({ newsletterAudioPodcast: true, newsletterAudioMode: 'on-demand' })!;
        expect(out.newsletterAudioMode).toBe('on-demand');
    });

    it('repairs a garbage stored mode from the audio flag', () => {
        expect(migrateOldSettings({ newsletterAudioPodcast: true, newsletterAudioMode: 'weekly' })!.newsletterAudioMode).toBe('daily');
        expect(migrateOldSettings({ newsletterAudioPodcast: false, newsletterAudioMode: 'weekly' })!.newsletterAudioMode).toBe('on-demand');
    });

    describe('catch-up limits', () => {
        it('fills defaults', () => {
            const out = migrateOldSettings({})!;
            expect(out.newsletterCatchUpLookbackDays).toBe(7);
            expect(out.newsletterCatchUpMaxMins).toBe(20);
            expect(out.newsletterCatchUpStatusBar).toBe(true);
            expect(out.newsletterAudioModeNoticeShown).toBe(false);
        });

        it('clamps out-of-range and non-numeric values', () => {
            const out: Record<string, unknown> = { newsletterCatchUpLookbackDays: 99, newsletterCatchUpMaxMins: 1 };
            migrateNewsletterAudioSettings(out);
            expect(out.newsletterCatchUpLookbackDays).toBe(14);
            expect(out.newsletterCatchUpMaxMins).toBe(5);

            const bad: Record<string, unknown> = { newsletterCatchUpLookbackDays: 'x', newsletterCatchUpMaxMins: {} };
            migrateNewsletterAudioSettings(bad);
            expect(bad.newsletterCatchUpLookbackDays).toBe(7);
            expect(bad.newsletterCatchUpMaxMins).toBe(20);
        });

        it('keeps a deliberate status-bar opt-out and a shown notice', () => {
            const out: Record<string, unknown> = { newsletterCatchUpStatusBar: false, newsletterAudioModeNoticeShown: true };
            migrateNewsletterAudioSettings(out);
            expect(out.newsletterCatchUpStatusBar).toBe(false);
            expect(out.newsletterAudioModeNoticeShown).toBe(true);
        });
    });
});
