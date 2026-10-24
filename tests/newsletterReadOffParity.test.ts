// @vitest-environment happy-dom
/**
 * Read signal OFF-parity — the byte-identical proof for `newsletterReadMode: 'off'`.
 *
 * The expected values below were captured against the code BEFORE the read signal existed (first
 * commit of the build, on the build's base commit), exactly as the `*Parity` audio tests were. They
 * pin: the recall selection, the brief prompt bytes, and the production boundary of
 * `generateAndInjectBrief` (the prompt handed to the LLM, the note written, what the podcast script
 * receives, and which plugin-data keys exist). With the mode off none of them may move.
 */

import { createHash } from 'node:crypto';

vi.mock('obsidian', () => ({
    normalizePath: (p: string) => p.replace(/\\/g, '/'),
    requestUrl: vi.fn(),
    TFile: class TFile { path = ''; name = ''; basename = ''; parent: { path: string } | null = null; },
}));

const summarizeText = vi.hoisted(() => vi.fn());
vi.mock('../src/services/llmFacade', () => ({ summarizeText, pluginContext: (p: unknown) => p }));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TFile } from 'obsidian';
import { DEFAULT_SETTINGS, getNewsletterOutputFullPath } from '../src/core/settings';
import { selectRecall } from '../src/services/newsletter/newsletterRecall';
import { buildDailyBriefPrompt } from '../src/services/prompts/newsletterPrompts';
import { NewsletterService, getDigestPath } from '../src/services/newsletter/newsletterService';
import { MEMORY_SCHEMA_VERSION, type ConsumptionState, type StoryLedger } from '../src/services/newsletter/newsletterMemoryTypes';
import type { ProcessedNewsletter } from '../src/services/newsletter/newsletterTypes';

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

const MON = '2026-10-19';
const TUE = '2026-10-20';
const WED = '2026-10-21';

function ledger(): StoryLedger {
    const mk = (key: string, title: string, gist: string, rev: number) => ({ key, title, gist, firstRevision: rev, contentRevision: rev });
    return {
        version: MEMORY_SCHEMA_VERSION,
        buckets: {
            [MON]: { revision: 1, updatedAt: 1, audio: {}, stories: [mk('port strike harbour', 'Port strike at the harbour', 'Dockers walked out', 1), mk('rate decision central bank', 'Central bank rate decision', 'Rates held', 1)] },
            [TUE]: { revision: 2, updatedAt: 2, audio: {}, stories: [mk('port strike harbour', 'Port strike at the harbour', 'Dockers talks resume', 2), mk('chip export rules', 'Chip export rules tighten', 'New licence regime', 1)] },
            [WED]: { revision: 1, updatedAt: 3, audio: {}, stories: [mk('storm coast warning', 'Storm warning for the coast', 'Gales expected', 1)] },
        },
    };
}

function consumption(): ConsumptionState {
    return { version: MEMORY_SCHEMA_VERSION, consumed: { [MON]: { firstAt: 1, lastAt: 1, firstVia: 'audio', lastVia: 'audio', revision: 1 } } };
}

describe('read signal OFF parity — pure layer', () => {
    it('selectRecall with no read argument keeps its baseline classification', () => {
        const sel = selectRecall(ledger(), consumption(), WED);
        const shape = {
            heard: sel.heard.map((s) => `${s.bucketDate}:${s.key}`).sort(),
            continuing: sel.continuing.map((s) => `${s.bucketDate}:${s.key}`).sort(),
            unheard: sel.unheard.map((s) => `${s.bucketDate}:${s.key}`).sort(),
        };
        expect(shape).toEqual({
            heard: [`${MON}:rate decision central bank`],
            continuing: [`${TUE}:port strike harbour`],
            unheard: [`${TUE}:chip export rules`, `${WED}:storm coast warning`].sort(),
        });
    });

    it('buildDailyBriefPrompt bytes are pinned for no recall and for a recall', () => {
        expect(sha(buildDailyBriefPrompt({ language: 'English' }))).toBe('aebeeec047db1102');
        expect(sha(buildDailyBriefPrompt({ language: 'English', recall: selectRecall(ledger(), consumption(), WED) }))).toBe('ad12ae082e343763');
    });
});

// ── Production boundary: generateAndInjectBrief with mocked ports ───────────

function makeVault() {
    const files = new Map<string, { content: string; tfile: TFile }>();
    const mk = (path: string): TFile => {
        const t = new TFile();
        t.path = path;
        t.name = path.split('/').pop() ?? path;
        t.basename = t.name.replace(/\.md$/, '');
        t.parent = { path: path.slice(0, path.lastIndexOf('/')) } as never;
        return t;
    };
    const put = (path: string, content: string) => files.set(path, { content, tfile: mk(path) });
    return {
        files,
        put,
        getAbstractFileByPath: (p: string) => files.get(p)?.tfile ?? null,
        cachedRead: vi.fn(async (f: { path: string }) => files.get(f.path)?.content ?? ''),
        read: vi.fn(async (f: { path: string }) => files.get(f.path)?.content ?? ''),
        modify: vi.fn(async (f: { path: string }, content: string) => { put(f.path, content); }),
        create: vi.fn(async (p: string, content: string) => { put(p, content); return files.get(p)!.tfile; }),
    };
}

const BRIEF = [
    '### Business',
    '- **Central bank rate decision**: Rates held for a third month. (Sources: Alpha, Beta)',
    '- **Port strike at the harbour**: Talks resume after two days. (Sources: Alpha, Beta)',
].join('\n');

function setup(settingsOver: Record<string, unknown> = {}) {
    const vault = makeVault();
    const settings = {
        ...DEFAULT_SETTINGS,
        featureFlags: { newsletter: true },
        newsletterStoryMemory: true,
        ...settingsOver,
    };
    const root = getNewsletterOutputFullPath(settings);
    const digestPath = getDigestPath(root, WED);
    const items = ['Alpha', 'Beta'].map((name) => `${root}/${WED}/${name}.md`);
    vault.put(digestPath, `# Digest — ${WED}\n\n${items.map((p) => `- [[${WED}/${p.split('/').pop()!.replace(/\.md$/, '')}|x]]`).join('\n')}\n`);
    const saved: Array<Record<string, unknown>> = [];
    const data: Record<string, unknown> = {
        'newsletter-story-ledger': ledger(),
        'newsletter-consumed-briefs': consumption(),
    };
    const loadData = vi.fn(async () => structuredClone(data));
    const saveData = vi.fn(async (d: Record<string, unknown>) => { saved.push(structuredClone(d)); Object.assign(data, d); });
    const plugin = { app: { vault, workspace: {}, metadataCache: { getFileCache: () => null } }, settings, loadData, saveData } as never;
    const batch: ProcessedNewsletter[] = items.map((p, i) => ({
        id: `m${i}`, from: 'x', subject: `s${i}`, date: WED, senderName: i === 0 ? 'Alpha' : 'Beta', markdown: '',
        triage: `Triage text number ${i} about the central bank holding rates and the harbour port strike talks resuming in full.`, llmFailed: false, keyLinks: [], _resolvedPath: p,
    }));
    return { vault, plugin, batch, digestPath, saved, loadData };
}

describe('read signal OFF parity — generateAndInjectBrief boundary', () => {
    beforeEach(() => {
        summarizeText.mockReset();
        summarizeText.mockResolvedValue({ success: true, content: BRIEF });
    });

    it('hands the baseline prompt to the LLM, writes the baseline note and persists only the baseline keys', async () => {
        const { vault, plugin, batch, digestPath, saved } = setup();
        const service = new NewsletterService(plugin);
        await (service as unknown as { generateAndInjectBrief(d: string, b: ProcessedNewsletter[]): Promise<void> }).generateAndInjectBrief(WED, batch);

        expect(summarizeText).toHaveBeenCalledTimes(1);
        const prompt = summarizeText.mock.calls[0][1] as string;
        expect(prompt).toContain('<story_memory>');
        expect(sha(prompt)).toBe('dbfa7e20b36c143e');

        const note = vault.files.get(digestPath)!.content;
        expect(sha(note)).toBe('0aced97fa6340412');

        const keys = [...new Set(saved.flatMap((d) => Object.keys(d)))].sort();
        expect(keys).toEqual(['newsletter-consumed-briefs', 'newsletter-story-ledger']);
        expect(keys).not.toContain('newsletter-read-briefs');
    });
});
