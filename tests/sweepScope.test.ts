import { describe, it, expect } from 'vitest';
import { runSweep, estimateSweep, type SweepDeps } from '../src/services/inboxSweep/sweepService';
import { hasSourceLink, sweepSkipReason } from '../src/services/inboxSweep/sweepScope';
import { DEFAULT_SETTINGS, migrateOldSettings } from '../src/core/settings';
import { ok } from '../src/core/result';

const policy = { excludedFolders: [], excludedTags: [], excludedProperties: [], excludedTerms: [], protectedFolders: [], maxNoteChars: 100000 };
const CLIPPED = '---\ntitle: "Some article"\nsource: "https://example.com/post"\n---\nArticle body. Call Sam on Friday.\n';
const SUMMARISED = '---\nsource: url\nsource_url: https://example.com/a\n---\nSummary.\n';
const MINE = '# Meeting\n\nCall Sam on Friday.\n';
const TEXTS: Record<string, string> = {
    'Inbox/Web Reader/a.md': MINE,
    'Inbox/clip.md': CLIPPED,
    'Inbox/sum.md': SUMMARISED,
    'Inbox/meeting.md': MINE,
};
const EMPTY = JSON.stringify({ gtd_processing: { next_actions: [], waiting_for: [], projects: [], someday_maybe: [] } });

function deps(prompts: string[], scope?: SweepDeps['scope']): SweepDeps {
    return {
        candidates: () => Object.keys(TEXTS),
        readText: async (p) => TEXTS[p] ?? null,
        complete: async (prompt) => { prompts.push(prompt); return ok(EMPTY); },
        policy: () => policy,
        ledger: () => ({}),
        ...(scope ? { scope } : {}),
    };
}

describe('hasSourceLink', () => {
    it('finds a web link in source or source_url, quoted or not', () => {
        expect(hasSourceLink(CLIPPED)).toBe(true);
        expect(hasSourceLink(SUMMARISED)).toBe(true);
        expect(hasSourceLink("---\nsource: 'http://x.org'\n---\n")).toBe(true);
    });
    it('ignores a non-link source, nested keys, body text and missing frontmatter', () => {
        expect(hasSourceLink('---\nsource: audio\n---\nbody')).toBe(false);
        expect(hasSourceLink('---\nmeta:\n  source: https://x.org\n---\n')).toBe(false);
        expect(hasSourceLink('# Note\nsource: https://x.org\n')).toBe(false);
        expect(hasSourceLink('---\nsources: https://x.org\n---\n')).toBe(false);
        expect(hasSourceLink(MINE)).toBe(false);
    });
});

describe('sweepSkipReason', () => {
    it('skips a folder and everything below it, case-insensitively, and nothing else', () => {
        const scope = { skipFolders: ['inbox/web reader'], skipSourceLinked: false };
        expect(sweepSkipReason('Inbox/Web Reader/a.md', MINE, scope)).toBe('skip-folder');
        expect(sweepSkipReason('Inbox/Web Reader Notes/a.md', MINE, scope)).toBeNull();
        expect(sweepSkipReason('Inbox/clip.md', CLIPPED, scope)).toBeNull();
    });
    it('skips a source-linked note only while the switch is on', () => {
        expect(sweepSkipReason('Inbox/clip.md', CLIPPED, { skipFolders: [], skipSourceLinked: true })).toBe('source-link');
        expect(sweepSkipReason('Inbox/clip.md', CLIPPED, { skipFolders: [], skipSourceLinked: false })).toBeNull();
        expect(sweepSkipReason('Inbox/clip.md', CLIPPED, undefined)).toBeNull();
    });
});

describe('the sweep leaves reading to the capture inbox', () => {
    it('skipped notes never reach the model and are counted; your own notes are still swept', async () => {
        const prompts: string[] = [];
        const res = await runSweep(deps(prompts, () => ({ skipFolders: ['Inbox/Web Reader'], skipSourceLinked: true })), { maxNotes: 10, maxChars: 12000 });
        if (!res.ok) throw new Error('run');
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).not.toContain('Article body');
        expect(res.value.notes.map((n) => n.path)).toEqual(['Inbox/meeting.md']);
        expect(res.value.skippedReading).toBe(3);
        const est = await estimateSweep(deps([], () => ({ skipFolders: ['Inbox/Web Reader'], skipSourceLinked: true })), { maxNotes: 10, maxChars: 12000 });
        expect(est.ok && est.value.notes).toBe(1);
    });

    it('off (no scope, or the defaults) the sweep reads every note exactly as before', async () => {
        for (const scope of [undefined, () => ({ skipFolders: DEFAULT_SETTINGS.sweepSkipFolders, skipSourceLinked: DEFAULT_SETTINGS.sweepSkipSourceLinked })]) {
            const prompts: string[] = [];
            const res = await runSweep(deps(prompts, scope), { maxNotes: 10, maxChars: 12000 });
            if (!res.ok) throw new Error('run');
            expect(prompts).toHaveLength(4);
            expect(res.value.skippedReading).toBeUndefined();
        }
    });
});

describe('settings', () => {
    it('defaults are off and empty, and a stored value is normalised idempotently', () => {
        expect(DEFAULT_SETTINGS.sweepSkipFolders).toEqual([]);
        expect(DEFAULT_SETTINGS.sweepSkipSourceLinked).toBe(false);
        const once = migrateOldSettings({ sweepSkipFolders: [' Clippings ', 3, ''], sweepSkipSourceLinked: 'yes' } as Record<string, unknown>);
        expect(once?.sweepSkipFolders).toEqual(['Clippings']);
        expect(once?.sweepSkipSourceLinked).toBe(false);
        const twice = migrateOldSettings({ ...once } as Record<string, unknown>);
        expect(twice?.sweepSkipFolders).toEqual(['Clippings']);
    });
});
