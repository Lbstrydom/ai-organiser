// @vitest-environment happy-dom
/**
 * Catch-up audio is READ-BLIND (decision 3, behind `READ_AFFECTS_AUDIO_RECALL`).
 *
 * Drives the real catch-up orchestration path (`createCatchUpPorts(...).generateScript`) with a
 * mocked LLM and a plugin-data store that carries a populated read store, and compares the prompt
 * with the one built from the same data WITHOUT the read store. They must be byte-identical, and
 * marking a brief read must never move the heard store or any catch-up coverage/ack.
 */

const summarizeText = vi.hoisted(() => vi.fn());
vi.mock('../src/services/llmFacade', () => ({ summarizeText, pluginContext: (p: unknown) => p }));
vi.mock('../src/services/azure/endpointResolver', () => ({ isAzureMode: () => false }));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { createCatchUpPorts } from '../src/services/newsletter/catchUp/catchUpRuntime';
import type { CatchUpPlan } from '../src/services/newsletter/catchUp/catchUpTypes';
import { NewsletterService } from '../src/services/newsletter/newsletterService';
import { creditPair, currentReadGeneration } from '../src/services/newsletter/newsletterReadSignal';

const READ_DAY = '2026-10-17';
const HEARD_DAY = '2026-10-18';
const PENDING_DAY = '2026-10-22';

const readStory = { key: 'read only tale', title: 'Read only tale', gist: 'Seen in the written brief', firstRevision: 1, contentRevision: 1 };

function baseData(withRead: boolean): Record<string, unknown> {
    const data: Record<string, unknown> = {
        'newsletter-story-ledger': {
            version: 1,
            buckets: {
                [READ_DAY]: { revision: 1, updatedAt: 1, audio: {}, stories: [readStory] },
                [HEARD_DAY]: { revision: 1, updatedAt: 1, audio: {}, stories: [{ key: 'old tale', title: 'Old tale', gist: 'Told before', firstRevision: 1, contentRevision: 1 }] },
                [PENDING_DAY]: { revision: 1, updatedAt: 1, audio: {}, stories: [{ key: 'pending tale', title: 'Pending tale', gist: 'Not told', firstRevision: 1, contentRevision: 1 }] },
            },
        },
        'newsletter-consumed-briefs': {
            version: 1,
            consumed: { [HEARD_DAY]: { firstAt: 1, lastAt: 1, firstVia: 'audio', lastVia: 'audio', revision: 1 } },
        },
    };
    if (withRead) {
        data['newsletter-read-briefs'] = { version: 1, read: { [READ_DAY]: { via: 'explicit', credited: [creditPair(readStory)] } } };
    }
    return data;
}

function plugin(withRead: boolean, mode: 'off' | 'explicit' | 'read-through') {
    const data = baseData(withRead);
    return {
        app: {},
        settings: {
            ...DEFAULT_SETTINGS,
            featureFlags: { newsletter: true },
            newsletterStoryMemory: true,
            newsletterReadMode: mode,
            serviceType: 'cloud',
            cloudServiceType: 'openai',
            newsletterPreferredLanguage: 'en',
        },
        loadData: async () => structuredClone(data),
        saveData: vi.fn(),
    } as never;
}

const plan = (): CatchUpPlan => ({
    entries: [
        { date: PENDING_DAY, kind: 'full', coverage: { kind: 'revision', rev: 1 }, text: '- **Pending tale**: A synthetic story long enough to be kept as a source block.', newsletters: 2, titles: ['Pending tale'] },
    ],
    unresolved: [], noStoredDates: [], windowDates: [PENDING_DAY],
    length: { capMinutes: 15, wordBudget: 1950 },
    from: PENDING_DAY, to: PENDING_DAY, createdAt: 1, planHash: 'abcd1234',
});

beforeEach(() => {
    summarizeText.mockReset();
    summarizeText.mockResolvedValue({ success: true, content: 'A spoken script.' });
});

describe('catch-up recall ignores the read store', () => {
    it('the catch-up prompt is byte-identical with and without a populated read store, in every read mode', async () => {
        const prompts: string[] = [];
        for (const [withRead, mode] of [[false, 'off'], [true, 'off'], [true, 'explicit'], [true, 'read-through']] as const) {
            summarizeText.mockClear();
            const res = await createCatchUpPorts(plugin(withRead, mode)).generateScript(plan());
            expect(res.ok).toBe(true);
            prompts.push(summarizeText.mock.calls[0][1] as string);
        }
        expect(new Set(prompts).size).toBe(1);
        // The read-only story is still treated as unheard by audio.
        expect(prompts[0]).toContain('[THEY_MISSED_THESE_ENTIRELY]');
        expect(prompts[0]).toContain(`[${READ_DAY}] Read only tale`);
        expect(prompts[0]).not.toContain(`[ALREADY_TOLD_THEM_ON_A_PREVIOUS_DAY]\n[${READ_DAY}]`);
    });
});

describe('marking a brief read moves nothing else', () => {
    it('leaves the heard store, the ledger and every catch-up key untouched', async () => {
        const data = baseData(false);
        data['newsletter-catchup-draft'] = { version: 1, marker: 'draft' };
        data['newsletter-catchup-acks'] = { version: 1, marker: 'acks' };
        const before = structuredClone(data);
        const p = {
            app: {},
            settings: { ...DEFAULT_SETTINGS, featureFlags: { newsletter: true }, newsletterStoryMemory: true, newsletterReadMode: 'explicit' },
            loadData: async () => structuredClone(data),
            saveData: vi.fn(async (d: Record<string, unknown>) => { for (const k of Object.keys(data)) delete data[k]; Object.assign(data, structuredClone(d)); }),
        } as never;
        const res = await new NewsletterService(p).markBriefRead(
            { date: READ_DAY, displayed: [{ key: readStory.key, title: readStory.title, gist: readStory.gist }] },
            'explicit',
            currentReadGeneration(),
        );
        expect(res).toEqual({ ok: true, value: { kind: 'credited', stories: 1, newly: 1 } });
        for (const key of Object.keys(before)) expect(data[key]).toEqual(before[key]);
        expect(Object.keys(data).sort()).toEqual([...Object.keys(before), 'newsletter-read-briefs'].sort());
    });
});
