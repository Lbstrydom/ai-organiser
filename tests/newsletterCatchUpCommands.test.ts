/**
 * The catch-up commands and their guards: what runs in which mode, and that the legacy daily
 * commands behave exactly as before for a daily install.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const notices = vi.hoisted(() => [] as string[]);
vi.mock('obsidian', () => ({
    Notice: class { constructor(msg: string) { notices.push(msg); } },
    TFile: class { path = ''; },
    Platform: { isMobile: false },
    normalizePath: (p: string) => p,
}));

const service = vi.hoisted(() => ({
    regenerateAudioForToday: vi.fn(),
    markCaughtUp: vi.fn(),
    loadSeenIds: vi.fn(),
    fetchAndProcess: vi.fn(),
}));
vi.mock('../src/services/newsletter/newsletterService', () => ({
    NewsletterService: class { regenerateAudioForToday = service.regenerateAudioForToday; markCaughtUp = service.markCaughtUp; loadSeenIds = service.loadSeenIds; fetchAndProcess = service.fetchAndProcess; },
    getBriefDateStr: () => '2026-10-23',
    extractDigestDate: () => null,
    getBucketDateStr: () => '2026-10-23',
}));

vi.mock('../src/services/progress', () => ({
    withProgress: async (_o: unknown, op: (r: unknown) => Promise<unknown>) => {
        try { return { ok: true, value: await op({ setPhase: vi.fn() }) }; } catch (e) { return { ok: false, error: String(e) }; }
    },
}));

const ack = vi.hoisted(() => vi.fn(async () => 2));
const markListened = vi.hoisted(() => vi.fn(async () => ({ ok: true, value: { acked: true, buckets: 0 } })));
vi.mock('../src/services/newsletter/catchUp/catchUpListen', () => ({ ackAllInWindowEpisodes: ack, markEpisodeListened: markListened }));

const readEpisode = vi.hoisted(() => vi.fn());
vi.mock('../src/services/newsletter/catchUp/catchUpEpisode', () => ({ readEpisode }));

const runAutoCatchUp = vi.hoisted(() => vi.fn());
vi.mock('../src/services/newsletter/catchUp/catchUpService', () => ({ runAutoCatchUp }));
vi.mock('../src/services/newsletter/catchUp/catchUpRuntime', () => ({ createCatchUpPorts: () => ({ marker: 'ports' }) }));

const modalOpen = vi.hoisted(() => vi.fn());
vi.mock('../src/ui/modals/NewsletterCatchUpModal', () => ({
    NewsletterCatchUpModal: class { constructor(public plugin: unknown) {} open = modalOpen; },
}));

import { TFile } from 'obsidian';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { getTranslations } from '../src/i18n';
import {
    runRegenerateAudio,
    runMarkCaughtUp,
    runMarkCatchUpListened,
    runSmartDailyAfterFetch,
    openCatchUpWindow,
    registerNewsletterCommands,
} from '../src/commands/newsletterCommands';

const t = getTranslations('en');

function plugin(over: Record<string, unknown> = {}, active: unknown = null) {
    const commands: Array<{ id: string; name: string; icon: string; callback: () => void }> = [];
    const p = {
        app: { workspace: { getActiveFile: () => active } },
        t,
        settings: {
            ...DEFAULT_SETTINGS,
            featureFlags: { newsletter: true },
            newsletterAudioPodcast: true,
            newsletterAudioMode: 'on-demand',
            newsletterStoryMemory: true,
            ...over,
        },
        addCommand: (c: { id: string; name: string; icon: string; callback: () => void }) => commands.push(c),
        refreshCatchUpStatus: vi.fn(),
        commands,
    };
    return p as never as typeof p & Parameters<typeof runRegenerateAudio>[0];
}

beforeEach(() => {
    notices.length = 0;
    for (const f of Object.values(service)) f.mockReset();
    ack.mockClear(); markListened.mockClear(); readEpisode.mockReset(); runAutoCatchUp.mockReset(); modalOpen.mockClear();
    service.regenerateAudioForToday.mockResolvedValue({ ok: true, value: { path: 'x/' } });
    service.markCaughtUp.mockResolvedValue({ kind: 'ok', buckets: 1, stories: 2, through: '2026-10-23' });
});

describe('Regenerate audio for today (the daily pipeline)', () => {
    it('a daily install is unchanged: it still regenerates', async () => {
        await runRegenerateAudio(plugin({ newsletterAudioMode: 'daily' }));
        expect(service.regenerateAudioForToday).toHaveBeenCalledTimes(1);
        expect(notices.some((n) => n.includes('Audio regenerated'))).toBe(true);
    });

    it.each(['on-demand', 'smart-daily'])('in %s mode it explains instead of making a daily recording', async (mode) => {
        await runRegenerateAudio(plugin({ newsletterAudioMode: mode }));
        expect(service.regenerateAudioForToday).not.toHaveBeenCalled();
        expect(notices.join(' ')).toContain('set to make a new audio every day');
    });

    it('audio off keeps its original message, in every mode', async () => {
        await runRegenerateAudio(plugin({ newsletterAudioPodcast: false, newsletterAudioMode: 'on-demand' }));
        expect(service.regenerateAudioForToday).not.toHaveBeenCalled();
        expect(notices.join(' ')).toContain('Audio podcast is off');
    });

    it('the feature gate still comes first', async () => {
        await runRegenerateAudio(plugin({ featureFlags: { newsletter: false }, newsletterAudioMode: 'daily' }));
        expect(service.regenerateAudioForToday).not.toHaveBeenCalled();
    });
});

describe('Mark caught up', () => {
    it('also marks the catch-up episodes heard when catch-up is available', async () => {
        const p = plugin();
        await runMarkCaughtUp(p);
        expect(ack).toHaveBeenCalledTimes(1);
        expect(p.refreshCatchUpStatus).toHaveBeenCalled();
    });

    it('passes the same caught-up target boundary to the episode acknowledgement', async () => {
        await runMarkCaughtUp(plugin());
        const through = (ack.mock.calls[0] as unknown[])[1];
        expect(through).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('works with story memory OFF: the episodes are still acknowledged', async () => {
        service.markCaughtUp.mockResolvedValue({ kind: 'disabled' });
        await runMarkCaughtUp(plugin({ newsletterStoryMemory: false }));
        expect(ack).toHaveBeenCalledTimes(1);
    });

    it('a daily install is unchanged: no episode acknowledgement', async () => {
        await runMarkCaughtUp(plugin({ newsletterAudioMode: 'daily' }));
        expect(ack).not.toHaveBeenCalled();
        expect(service.markCaughtUp).toHaveBeenCalledTimes(1);
    });

    it('an acknowledgement failure never breaks the existing flow', async () => {
        ack.mockRejectedValueOnce(new Error('boom'));
        await runMarkCaughtUp(plugin());
        expect(notices.some((n) => n.includes('Caught up through'))).toBe(true);
    });
});

describe('Mark newsletter catch-up listened', () => {
    it('does nothing when the newsletter feature is disabled', async () => {
        await runMarkCatchUpListened(plugin({ featureFlags: { newsletter: false } }, new TFile()));
        expect(readEpisode).not.toHaveBeenCalled();
        expect(markListened).not.toHaveBeenCalled();
        expect(notices).toEqual([]);
    });

    it('asks for an episode note when the active file is not one', async () => {
        await runMarkCatchUpListened(plugin({}, null));
        expect(notices).toContain(t.modals.newsletterCatchUp.notAnEpisode);
        expect(markListened).not.toHaveBeenCalled();
    });

    it('marks the active episode note', async () => {
        const file = new TFile();
        readEpisode.mockResolvedValue({ id: 'e1', to: '2026-10-22', coverage: {} });
        const p = plugin({}, file);
        await runMarkCatchUpListened(p);
        expect(markListened).toHaveBeenCalledTimes(1);
        expect(notices).toContain('Marked as listened.');
        expect(p.refreshCatchUpStatus).toHaveBeenCalled();
    });

    it('a failure shows guidance, not an error string', async () => {
        readEpisode.mockResolvedValue({ id: 'e1', to: '2026-10-22', coverage: {} });
        markListened.mockResolvedValueOnce({ ok: false, error: 'EACCES: raw detail' } as never);
        await runMarkCatchUpListened(plugin({}, new TFile()));
        expect(notices.join(' ')).not.toContain('EACCES');
    });
});

describe('Smart daily after a fetch', () => {
    it.each([
        ['on-demand', { newsletterAudioMode: 'on-demand' }],
        ['daily', { newsletterAudioMode: 'daily' }],
        ['audio off', { newsletterAudioMode: 'smart-daily', newsletterAudioPodcast: false }],
        ['feature off', { newsletterAudioMode: 'smart-daily', featureFlags: { newsletter: false } }],
    ])('does nothing and costs nothing in %s', async (_n, over) => {
        await runSmartDailyAfterFetch(plugin(over));
        expect(runAutoCatchUp).not.toHaveBeenCalled();
    });

    it('runs the admission-guarded automatic catch-up in smart-daily mode and announces an episode', async () => {
        runAutoCatchUp.mockResolvedValue({ ok: true, value: { from: '2026-10-21', to: '2026-10-22' } });
        const p = plugin({ newsletterAudioMode: 'smart-daily' });
        await runSmartDailyAfterFetch(p);
        expect(runAutoCatchUp).toHaveBeenCalledTimes(1);
        expect(notices).toContain('Your newsletter audio for 2026-10-21 → 2026-10-22 is ready.');
        expect(p.refreshCatchUpStatus).toHaveBeenCalled();
    });

    it('a skipped run (admission said no) is silent', async () => {
        runAutoCatchUp.mockResolvedValue({ ok: true, value: null });
        await runSmartDailyAfterFetch(plugin({ newsletterAudioMode: 'smart-daily' }));
        expect(notices).toEqual([]);
    });

    it('a failure shows guidance and never throws into the fetch', async () => {
        runAutoCatchUp.mockResolvedValue({ ok: false, error: 'catchup-script-too-long' });
        await expect(runSmartDailyAfterFetch(plugin({ newsletterAudioMode: 'smart-daily' }))).resolves.toBeUndefined();
        expect(notices.join(' ')).toContain('longer than your limit');
        expect(notices.join(' ')).not.toContain('catchup-script-too-long');
    });

    it('an unexpected exception is contained', async () => {
        runAutoCatchUp.mockRejectedValue(new Error('unexpected'));
        await expect(runSmartDailyAfterFetch(plugin({ newsletterAudioMode: 'smart-daily' }))).resolves.toBeUndefined();
    });
});

describe('opening the window', () => {
    it('opens the modal when the feature is on', async () => {
        await openCatchUpWindow(plugin());
        expect(modalOpen).toHaveBeenCalledTimes(1);
    });

    it('explains when the newsletter feature is off', async () => {
        await openCatchUpWindow(plugin({ featureFlags: { newsletter: false } }));
        expect(modalOpen).not.toHaveBeenCalled();
    });
});

describe('registration', () => {
    it('adds the two catch-up commands beside the existing three, with icons', () => {
        const p = plugin();
        registerNewsletterCommands(p);
        const byId = Object.fromEntries(p.commands.map((c) => [c.id, c]));
        expect(Object.keys(byId).sort()).toEqual([
            'newsletter-audio',
            'newsletter-fetch',
            'newsletter-mark-catchup-listened',
            'newsletter-mark-caught-up',
            'newsletter-regenerate-audio',
        ]);
        expect(byId['newsletter-audio'].name).toBe('Newsletter audio');
        expect(byId['newsletter-audio'].icon).toBe('headphones');
        expect(byId['newsletter-mark-catchup-listened'].icon).toBe('check-circle-2');
    });

    it('the Newsletter audio command opens the window', async () => {
        const p = plugin();
        registerNewsletterCommands(p);
        p.commands.find((c) => c.id === 'newsletter-audio')!.callback();
        await vi.waitFor(() => expect(modalOpen).toHaveBeenCalled());
    });
});

describe('Mark caught up reports partial success as partial', () => {
    it('says so when the episodes could not be marked, in addition to the normal notice', async () => {
        ack.mockRejectedValueOnce(new Error('disk full'));
        await runMarkCaughtUp(plugin());
        expect(notices.some((n) => n.includes('Caught up through'))).toBe(true);
        expect(notices).toContain(t.modals.newsletterCatchUp.ackFailed);
        expect(notices.join(' ')).not.toContain('disk full');
    });

    it('stays quiet about episodes when they were marked', async () => {
        await runMarkCaughtUp(plugin());
        expect(notices).not.toContain(t.modals.newsletterCatchUp.ackFailed);
    });
});
