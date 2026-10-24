// @vitest-environment happy-dom
/**
 * `newsletter-mark-brief-read`: the explicit read signal, driven through the real command with a
 * fake vault and the real plugin-data store.
 */

vi.mock('obsidian', () => ({
    normalizePath: (p: string) => p.replace(/\\/g, '/'),
    requestUrl: vi.fn(),
    Notice: class Notice { static messages: string[] = []; constructor(m: string) { Notice.messages.push(m); } },
    TFile: class TFile { path = ''; name = ''; basename = ''; parent: unknown = null; },
}));
vi.mock('../src/services/llmFacade', () => ({ summarizeText: vi.fn(), pluginContext: (p: unknown) => p }));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Notice, TFile } from 'obsidian';
import { DEFAULT_SETTINGS, getNewsletterOutputFullPath } from '../src/core/settings';
import { getDigestPath } from '../src/services/newsletter/newsletterService';
import { runMarkBriefRead, registerNewsletterCommands } from '../src/commands/newsletterCommands';
import { BRIEF_END_MARKER, BRIEF_START_MARKER, bumpReadGeneration, creditPair } from '../src/services/newsletter/newsletterReadSignal';
import { en } from '../src/i18n/en';

const DAY = '2026-10-20';
const story = { key: 'port-strike-harbour', title: 'Port strike at the harbour', gist: 'Dockers walked out', firstRevision: 1, contentRevision: 1 };
const messages = () => (Notice as unknown as { messages: string[] }).messages;

function setup(over: Record<string, unknown> = {}, opts: { noteText?: string; path?: string; readRejects?: boolean; failSave?: boolean } = {}) {
    const settings = { ...DEFAULT_SETTINGS, featureFlags: { newsletter: true }, newsletterStoryMemory: true, newsletterReadMode: 'explicit', ...over };
    const root = getNewsletterOutputFullPath(settings as never);
    const path = opts.path ?? getDigestPath(root, DAY);
    const file = new TFile();
    file.path = path;
    const text = opts.noteText ?? `# Digest\n\n${BRIEF_START_MARKER}\n## Daily Brief\n\n- **Port strike at the harbour**: Dockers walked out (Sources: A, B)\n\n${BRIEF_END_MARKER}\n`;
    const data: Record<string, unknown> = {
        'newsletter-story-ledger': { version: 1, buckets: { [DAY]: { revision: 1, updatedAt: 1, audio: {}, stories: [story] } } },
    };
    const plugin = {
        app: {
            workspace: { getActiveFile: () => file },
            vault: { cachedRead: vi.fn(async () => { if (opts.readRejects) throw new Error('gone'); return text; }) },
        },
        settings,
        t: en,
        loadData: async () => structuredClone(data),
        saveData: vi.fn(async (d: Record<string, unknown>) => {
            if (opts.failSave) throw new Error('disk full');
            for (const k of Object.keys(data)) delete data[k];
            Object.assign(data, structuredClone(d));
        }),
        addCommand: vi.fn(),
    } as never;
    return { plugin, data };
}

beforeEach(() => { messages().length = 0; });

describe('runMarkBriefRead', () => {
    it('records the read, reports it, and a second run reports it already counted', async () => {
        const { plugin, data } = setup();
        await runMarkBriefRead(plugin);
        expect(messages().at(-1)).toContain('Marked as read: 1 stories');
        expect(data['newsletter-read-briefs']).toBeDefined();
        await runMarkBriefRead(plugin);
        expect(messages().at(-1)).toBe(en.settings.newsletter.briefAlreadyRead);
    });

    it('guides instead of acting when the read mode is off or story memory is off', async () => {
        for (const over of [{ newsletterReadMode: 'off' }, { newsletterStoryMemory: false }]) {
            const { plugin, data } = setup(over);
            await runMarkBriefRead(plugin);
            expect(messages().at(-1)).toContain('Counting briefs as read is turned off');
            expect(data['newsletter-read-briefs']).toBeUndefined();
        }
    });

    it('refuses a note that is not the digest, a brief that does not parse, and an unreadable note', async () => {
        const a = setup({}, { path: 'Elsewhere/Note.md' });
        await runMarkBriefRead(a.plugin);
        expect(messages().at(-1)).toContain('not a newsletter digest');
        const b = setup({}, { noteText: '# Digest only' });
        await runMarkBriefRead(b.plugin);
        expect(messages().at(-1)).toContain('could not be read');
        const c = setup({}, { readRejects: true });
        await runMarkBriefRead(c.plugin);
        expect(messages().at(-1)).toContain('could not be read');
        for (const s of [a, b, c]) expect(s.data['newsletter-read-briefs']).toBeUndefined();
    });

    it('a purge that happens while the note is being read invalidates the mark (generation captured before the await)', async () => {
        const { plugin, data } = setup();
        const read = (plugin as never as { app: { vault: { cachedRead: () => Promise<string> } } }).app.vault;
        const original = read.cachedRead;
        read.cachedRead = async () => { bumpReadGeneration(); return original(); };
        await runMarkBriefRead(plugin);
        expect(data['newsletter-read-briefs']).toBeUndefined();
        expect(messages().at(-1)).toContain('could not be saved');
    });

    it('a failed save is reported with guidance and records nothing', async () => {
        const { plugin, data } = setup({}, { failSave: true });
        await runMarkBriefRead(plugin);
        expect(messages().at(-1)).toContain('could not be saved');
        expect(data['newsletter-read-briefs']).toBeUndefined();
    });

    it('does nothing at all when the newsletter feature is off', async () => {
        const { plugin } = setup({ featureFlags: { newsletter: false } });
        await runMarkBriefRead(plugin);
        expect(messages()).toHaveLength(0);
    });

    it('credits only what the note displays (a stale note earns nothing)', async () => {
        const { plugin, data } = setup({}, { noteText: `${BRIEF_START_MARKER}\n- **Port strike at the harbour**: Talks have resumed (Sources: A)\n${BRIEF_END_MARKER}` });
        await runMarkBriefRead(plugin);
        expect(messages().at(-1)).toContain('does not match what is remembered');
        expect(data['newsletter-read-briefs']).toBeUndefined();
        void creditPair;
    });
});

describe('registration', () => {
    it('registers the command with its icon and name', () => {
        const { plugin } = setup();
        const p = plugin as never as { addCommand: ReturnType<typeof vi.fn> };
        registerNewsletterCommands(plugin);
        const cmd = p.addCommand.mock.calls.map((c) => c[0]).find((c: { id: string }) => c.id === 'newsletter-mark-brief-read');
        expect(cmd.icon).toBe('book-open-check');
        expect(cmd.name).toBe('Mark newsletter brief as read');
    });
});
