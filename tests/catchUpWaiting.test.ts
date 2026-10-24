import { describe, it, expect } from 'vitest';
import { deriveWaiting } from '../src/services/newsletter/catchUp/catchUpModalState';
import type { EpisodeMeta } from '../src/services/newsletter/catchUp/catchUpTypes';

const ep = (id: string): EpisodeMeta => ({
    id, from: '2026-10-20', to: '2026-10-21', coverage: { '2026-10-21': { kind: 'whole' } }, audio: `catchup-${id}.mp3`, fingerprint: 'ab', minutes: 10, sources: 3, notePath: `Catch-up/${id}.md`,
});
const smart = { newsletterAudioPodcast: true, newsletterAudioMode: 'smart-daily' };

describe('deriveWaiting: the message is only ever true', () => {
    it('smart daily + an unheard episode + days an automatic run would cover => waiting', () => {
        const w = deriveWaiting({ unheard: [ep('20261022-080000-aaaa')], autoPendingDays: 3 }, smart);
        expect(w).toEqual({ days: 3, episodes: [expect.objectContaining({ id: '20261022-080000-aaaa' })] });
    });

    it('lists every blocker, newest first', () => {
        const w = deriveWaiting({ unheard: [ep('20261020-080000-aaaa'), ep('20261022-080000-cccc'), ep('20261021-080000-bbbb')], autoPendingDays: 1 }, smart);
        expect(w!.episodes.map((e) => e.id)).toEqual(['20261022-080000-cccc', '20261021-080000-bbbb', '20261020-080000-aaaa']);
    });

    it.each([
        ['on demand', { newsletterAudioPodcast: true, newsletterAudioMode: 'on-demand' }],
        ['daily', { newsletterAudioPodcast: true, newsletterAudioMode: 'daily' }],
        ['audio off', { newsletterAudioPodcast: false, newsletterAudioMode: 'smart-daily' }],
        ['a garbage mode (falls back to on demand)', { newsletterAudioPodcast: true, newsletterAudioMode: 'weekly' }],
        ['automatic replacement (nothing waits)', { ...smart, newsletterCatchUpWhenBehind: 'replace' }],
    ])('never waiting in %s', (_n, settings) => {
        expect(deriveWaiting({ unheard: [ep('20261022-080000-aaaa')], autoPendingDays: 2 }, settings)).toBeNull();
    });

    it('nothing is waiting when nothing is unheard', () => {
        expect(deriveWaiting({ unheard: [], autoPendingDays: 2 }, smart)).toBeNull();
    });

    it('nothing is waiting when an automatic run would cover no day (an open day alone is not a wait)', () => {
        expect(deriveWaiting({ unheard: [ep('20261022-080000-aaaa')], autoPendingDays: 0 }, smart)).toBeNull();
    });
});
