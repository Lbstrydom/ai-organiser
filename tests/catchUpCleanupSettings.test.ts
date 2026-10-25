import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, migrateOldSettings, migrateNewsletterAudioSettings } from '../src/core/settings';
import { normaliseCleanupDays, CATCHUP_CLEANUP_MAX_DAYS } from '../src/services/newsletter/catchUp/catchUpTypes';
import { shouldSweepOnTick } from '../src/services/newsletter/catchUp/catchUpCleanup';
import { getTranslations } from '../src/i18n';

describe('the cleanup setting', () => {
    it('defaults to off', () => {
        expect(DEFAULT_SETTINGS.newsletterCatchUpAudioCleanupDays).toBe(0);
        expect(CATCHUP_CLEANUP_MAX_DAYS).toBe(28);
    });

    it('a fresh or older install migrates to off', () => {
        expect(migrateOldSettings({})!.newsletterCatchUpAudioCleanupDays).toBe(0);
        expect(migrateOldSettings({ newsletterAudioPodcast: true })!.newsletterCatchUpAudioCleanupDays).toBe(0);
    });

    it.each([
        [undefined, 0], [null, 0], ['', 0], ['   ', 0], ['abc', 0], [{}, 0], [[], 0], [NaN, 0], [Infinity, 0], [-5, 0], [0, 0], [0.99, 0],
        [true, 0], [false, 0], [[14], 0], [['14'], 0], [{ valueOf: () => 14 }, 0], ['21', 0], ['14', 0],
        [1, 1], [14, 14], [14.9, 14], [28, 28], [29, 28], [9999, 28],
    ])('migrates %j to %j', (raw, expected) => {
        const out: Record<string, unknown> = { newsletterCatchUpAudioCleanupDays: raw };
        migrateNewsletterAudioSettings(out);
        expect(out.newsletterCatchUpAudioCleanupDays).toBe(expected);
        expect(normaliseCleanupDays(raw)).toBe(expected);
    });

    it('is idempotent and leaves the neighbouring catch-up settings alone', () => {
        const once = migrateOldSettings({ newsletterCatchUpAudioCleanupDays: 30, newsletterCatchUpLookbackDays: 9 })!;
        expect(once.newsletterCatchUpAudioCleanupDays).toBe(28);
        expect(once.newsletterCatchUpLookbackDays).toBe(9);
        const twice = migrateOldSettings({ ...once })!;
        expect(twice.newsletterCatchUpAudioCleanupDays).toBe(28);
    });
});

describe('shouldSweepOnTick', () => {
    const base = { days: 14, today: '2026-11-30', lastCompletedDate: '2026-11-30', retryPending: 0 as number | 'unknown' };

    it('off never sweeps', () => {
        expect(shouldSweepOnTick({ ...base, days: 0, lastCompletedDate: null, retryPending: 'unknown' })).toBe(false);
    });

    it('a quiet same-day tick does nothing, even with episodes that only wait for tomorrow (retryPending 0)', () => {
        expect(shouldSweepOnTick(base)).toBe(false);
    });

    it('a new calendar day, a never-completed sweep, or a retryable hold-up (or not yet known) sweeps', () => {
        expect(shouldSweepOnTick({ ...base, today: '2026-12-01' })).toBe(true);
        expect(shouldSweepOnTick({ ...base, lastCompletedDate: null })).toBe(true);
        expect(shouldSweepOnTick({ ...base, retryPending: 2 })).toBe(true);
        expect(shouldSweepOnTick({ ...base, retryPending: 'unknown' })).toBe(true);
    });
});

describe('cleanup strings', () => {
    const m = getTranslations('en').settings.newsletter.catchUp;

    it('exist, carry their placeholders, and say what stays and what goes', () => {
        expect(m.cleanupDays).toBe('Remove audio of listened catch-up episodes after (days)');
        expect(m.cleanupDaysDesc).toMatch(/trash/);
        expect(m.cleanupDaysDesc).toMatch(/note and transcript stay/);
        expect(m.cleanupDaysDesc).toMatch(/never touched/);
        expect(m.cleanupNotice).toContain('{count}');
        expect(m.audioRemovedLine).toContain('{date}');
        expect(m.audioRemovedLine.replace('{date}', '2026-11-30')).toBe('Audio removed on 2026-11-30');
        expect(m.cleanupOff).toBe('Off');
    });
});
