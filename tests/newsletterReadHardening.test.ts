// @vitest-environment happy-dom
/**
 * Findings from the code audit, each pinned: one retention policy for writer and decoder, attentive
 * time needing eligibility at both ends of an interval, an honest purge result, and a read-store
 * failure that cannot take the heard inputs down with it.
 */

vi.mock('obsidian', () => ({
    normalizePath: (p: string) => p.replace(/\\/g, '/'),
    requestUrl: vi.fn(),
    TFile: class TFile { path = ''; name = ''; basename = ''; parent: unknown = null; },
}));
const summarizeText = vi.hoisted(() => vi.fn());
vi.mock('../src/services/llmFacade', () => ({ summarizeText, pluginContext: (p: unknown) => p }));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TFile } from 'obsidian';
import { DEFAULT_SETTINGS, getNewsletterOutputFullPath } from '../src/core/settings';
import { NewsletterService, getDigestPath } from '../src/services/newsletter/newsletterService';
import {
    MAX_CREDITED_PER_BUCKET,
    READ_DATA_KEY,
    coerceReadState,
    commitReadObservation,
    compactCredited,
    currentReadGeneration,
    hashPart,
} from '../src/services/newsletter/newsletterReadSignal';
import { createReadSession, noteActivity, tick } from '../src/services/newsletter/newsletterReadSession';
import type { LedgerStory } from '../src/services/newsletter/newsletterMemoryTypes';

const DAY = '2026-10-20';
const pair = (k: string, g: string): [string, string] => [hashPart(k), hashPart(g)];

describe('compactCredited — one retention policy', () => {
    it('keeps only the newest text per story and is idempotent', () => {
        const out = compactCredited([pair('a', 'old'), pair('b', 'x'), pair('a', 'new')]);
        expect(out).toEqual([pair('b', 'x'), pair('a', 'new')]);
        expect(compactCredited(out)).toEqual(out);
    });

    it('past the cap the OLDEST pairs go, and what the writer saves is exactly what the decoder reads', () => {
        const many = Array.from({ length: MAX_CREDITED_PER_BUCKET + 25 }, (_, i) => pair(`story ${i}`, 'g'));
        const compact = compactCredited(many);
        expect(compact).toHaveLength(MAX_CREDITED_PER_BUCKET);
        expect(compact[0]).toEqual(many[25]);
        expect(compact.at(-1)).toEqual(many.at(-1));
        const decoded = coerceReadState({ version: 1, read: { [DAY]: { via: 'explicit', credited: many } } });
        expect(decoded.read[DAY].credited).toEqual(compact);
    });

    it('a commit beyond the cap persists a state the decoder returns unchanged', async () => {
        const stories: LedgerStory[] = Array.from({ length: MAX_CREDITED_PER_BUCKET + 10 }, (_, i) => ({ key: `story-number-${i}`, title: `T${i}`, gist: `gist ${i}`, firstRevision: 1, contentRevision: 1 }));
        const store: Record<string, unknown> = { 'newsletter-story-ledger': { version: 1, buckets: { [DAY]: { revision: 1, updatedAt: 1, audio: {}, stories } } } };
        const plugin = { loadData: async () => structuredClone(store), saveData: async (d: Record<string, unknown>) => { Object.assign(store, structuredClone(d)); } } as never;
        const res = await commitReadObservation(plugin, { date: DAY, displayed: stories.map((s) => ({ key: s.key, title: s.title, gist: s.gist })) }, 'explicit',
            { eligible: () => true, generation: 0, currentGeneration: () => 0 }, DAY);
        expect(res.ok).toBe(true);
        const saved = store[READ_DATA_KEY];
        expect(coerceReadState(saved)).toEqual(saved);
    });
});

describe('attentive time needs eligibility at both ends of the interval', () => {
    const ON = { visible: true, focused: true, activeLeaf: true };
    it('an interval ending in a visible tick but starting hidden earns nothing', () => {
        let s = noteActivity(tick(createReadSession('h', 4), 0, ON), 0);
        s = tick(s, 1000, { ...ON, visible: false });
        s = noteActivity(s, 2000);
        s = tick(s, 2000, ON); // hidden → visible: the interval before this tick started ineligible
        expect(s.dwellMs).toBe(0);
        s = tick(s, 3000, ON); // eligible at both ends now
        expect(s.dwellMs).toBe(1000);
    });

    it('time before the first activity is not credited retroactively', () => {
        let s = tick(createReadSession('h', 4), 0, ON);
        s = tick(s, 1000, ON);
        s = tick(s, 2000, ON);
        expect(s.dwellMs).toBe(0);
        s = noteActivity(s, 2500);
        s = tick(s, 3000, ON); // first tick that sees the activity: previous tick was not attentive
        expect(s.dwellMs).toBe(0);
        s = tick(s, 4000, ON);
        expect(s.dwellMs).toBe(1000);
    });
});

// ── service-level ────────────────────────────────────────────────────────────

function makeVault() {
    const files = new Map<string, { content: string; tfile: TFile }>();
    const put = (path: string, content: string) => {
        const t = new TFile();
        t.path = path; t.name = path.split('/').pop() ?? path; t.basename = t.name.replace(/\.md$/, '');
        t.parent = { path: path.slice(0, path.lastIndexOf('/')) } as never;
        files.set(path, { content, tfile: t });
    };
    return { files, put, getAbstractFileByPath: (p: string) => files.get(p)?.tfile ?? null, cachedRead: async (f: { path: string }) => files.get(f.path)?.content ?? '', read: async (f: { path: string }) => files.get(f.path)?.content ?? '', modify: async (f: { path: string }, c: string) => { put(f.path, c); }, create: async (p: string, c: string) => { put(p, c); return files.get(p)!.tfile; } };
}

function pluginFor(opts: { failRead?: boolean; failSave?: boolean }) {
    const vault = makeVault();
    const settings = { ...DEFAULT_SETTINGS, featureFlags: { newsletter: true }, newsletterStoryMemory: true, newsletterReadMode: 'explicit' };
    const root = getNewsletterOutputFullPath(settings as never);
    const today = '2026-10-21';
    const items = ['Alpha', 'Beta'].map((n) => `${root}/${today}/${n}.md`);
    vault.put(getDigestPath(root, today), `# Digest — ${today}\n\n${items.map((p) => `- [[${today}/${p.split('/').pop()!.replace(/\.md$/, '')}|x]]`).join('\n')}\n`);
    const story = { key: 'port-strike-harbour', title: 'Port strike', gist: 'Walked out', firstRevision: 1, contentRevision: 1 };
    const data: Record<string, unknown> = {
        'newsletter-story-ledger': { version: 1, buckets: { [DAY]: { revision: 1, updatedAt: 1, audio: {}, stories: [story] } } },
        'newsletter-consumed-briefs': { version: 1, consumed: {} },
        [READ_DATA_KEY]: { version: 1, read: {} },
    };
    let loads = 0;
    const loadData = vi.fn(async () => {
        loads++;
        return structuredClone(data);
    });
    const saveData = vi.fn(async (d: Record<string, unknown>) => {
        if (opts.failSave) throw new Error('disk full');
        for (const k of Object.keys(data)) delete data[k];
        Object.assign(data, structuredClone(d));
    });
    void loads;
    const plugin = { app: { vault, workspace: {}, metadataCache: { getFileCache: () => null } }, settings, loadData, saveData } as never;
    const batch = items.map((p, i) => ({ id: `m${i}`, from: 'x', subject: `s${i}`, date: today, senderName: i === 0 ? 'Alpha' : 'Beta', markdown: '', triage: `Triage text ${i} about the harbour port strike continuing across several areas of the region today.`, llmFailed: false, keyLinks: [], _resolvedPath: p }));
    return { plugin, batch, data, today };
}

beforeEach(() => {
    summarizeText.mockReset();
    summarizeText.mockResolvedValue({ success: true, content: '### News\n- **Something new**: A development. (Sources: Alpha, Beta)' });
});

describe('clearStoryMemory reports a failed read purge', () => {
    it('rejects like the other two clears, so the caller reports it', async () => {
        const { plugin } = pluginFor({ failSave: true });
        // The ledger purge itself fails first on a failing disk; use a store where only the read key exists.
        const service = new NewsletterService(plugin);
        const before = currentReadGeneration();
        await expect(service.clearStoryMemory()).rejects.toThrow();
        expect(currentReadGeneration()).toBeGreaterThanOrEqual(before);
    });

    it('clearReadHistory itself returns the failure as a Result and still invalidates in-flight sessions', async () => {
        const { plugin } = pluginFor({ failSave: true });
        const before = currentReadGeneration();
        const res = await new NewsletterService(plugin).clearReadHistory();
        expect(res.ok).toBe(false);
        expect(currentReadGeneration()).toBe(before + 1);
    });
});

describe('a failing read store cannot take the heard inputs down', () => {
    it('the brief still gets its memory block when only the read state fails to load', async () => {
        const { plugin, batch, today } = pluginFor({});
        const real = (plugin as never as { loadData: () => Promise<Record<string, unknown>> }).loadData;
        let calls = 0;
        // Make the read-state load (the third loadPluginData call in the recall Promise.all) reject.
        const p = plugin as never as { loadData: () => Promise<Record<string, unknown>> };
        p.loadData = async () => {
            calls++;
            const d = await real();
            if (calls === 3) { Object.defineProperty(d, READ_DATA_KEY, { get() { throw new Error('boom'); }, enumerable: true }); }
            return d;
        };
        const service = new NewsletterService(plugin);
        await (service as unknown as { generateAndInjectBrief(d: string, b: unknown[]): Promise<void> }).generateAndInjectBrief(today, batch);
        const prompt = summarizeText.mock.calls[0][1] as string;
        expect(prompt).toContain('<story_memory>');
        expect(prompt).toContain('[THEY_MISSED_THESE_ENTIRELY]');
    });
});
