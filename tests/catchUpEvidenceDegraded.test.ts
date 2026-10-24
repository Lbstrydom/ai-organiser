import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/minutesUtils', () => ({
    ensureFolderExists: vi.fn().mockResolvedValue(undefined),
    sanitizeFileName: (n: string) => n,
}));

const failing = vi.hoisted(() => ({ on: false }));
vi.mock('../src/services/newsletter/newsletterConsumption', async (importOriginal) => {
    const real = await importOriginal<typeof import('../src/services/newsletter/newsletterConsumption')>();
    return {
        ...real,
        loadConsumption: vi.fn(async (...a: Parameters<typeof real.loadConsumption>) => {
            if (failing.on) throw new Error('disk');
            return real.loadConsumption(...a);
        }),
    };
});

import { DEFAULT_SETTINGS } from '../src/core/settings';
import { buildCatchUpSnapshot } from '../src/services/newsletter/catchUp/catchUpSelection';
import { makeCatchUpVault } from './helpers/catchUpVault';

const ROOT = 'AI-Organiser/Newsletter Inbox';
const brief = '### Fixtures\n\n- **Story alpha**: Synthetic summary alpha for the fixture day. (Sources: Fixture A)\n';
const digest = (d: string) => `# Newsletter Digest — ${d}\n\n<!-- DAILY_BRIEF_START -->\n## Daily Brief\n\n${brief}\n<!-- DAILY_BRIEF_END -->\n`;

let vault: ReturnType<typeof makeCatchUpVault>;
const NOW = new Date(2026, 9, 23, 12, 0, 0);
const settings = { ...DEFAULT_SETTINGS, featureFlags: { newsletter: true }, newsletterAudioPodcast: true, newsletterStoryMemory: true, newsletterCatchUpLookbackDays: 7, newsletterRetentionDays: 30 } as never;
const plugin = { loadData: async () => ({}), saveData: vi.fn() } as never;

beforeEach(() => {
    failing.on = false;
    vault = makeCatchUpVault();
    for (const d of ['2026-10-21', '2026-10-22', '2026-10-23']) vault.set(`${ROOT}/Digest — ${d}.md`, digest(d));
    vault.set(`${ROOT}/2026-10-21/brief-2026-10-21-abcd1234.mp3`, new ArrayBuffer(4));
});

describe('an unreadable listening history', () => {
    it('is flagged, and the daily-audio day is offered rather than hidden', async () => {
        failing.on = true;
        const s = await buildCatchUpSnapshot({ app: vault.app as never, plugin, settings, now: NOW }, 'manual');
        expect(s.evidenceDegraded).toBe(true);
        expect(s.plan!.entries.map((e) => e.date)).toContain('2026-10-21');
    });

    it('is not flagged when the history simply has no records', async () => {
        const s = await buildCatchUpSnapshot({ app: vault.app as never, plugin, settings, now: NOW }, 'manual');
        expect(s.evidenceDegraded).toBe(false);
    });

    it('is not flagged when story memory is off (nothing is read)', async () => {
        failing.on = true;
        const s = await buildCatchUpSnapshot({ app: vault.app as never, plugin, settings: { ...(settings as object), newsletterStoryMemory: false } as never, now: NOW }, 'manual');
        expect(s.evidenceDegraded).toBe(false);
    });
});
