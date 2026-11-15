import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/minutesUtils', () => ({
    ensureFolderExists: vi.fn().mockResolvedValue(undefined),
    sanitizeFileName: (n: string) => n,
}));

import { ok, err, type Result } from '../src/core/result';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { __resetChainForTests } from '../src/core/pluginDataStore';
import { buildEpisodeNote, type EpisodeNoteInput } from '../src/services/newsletter/catchUp/catchUpEpisode';
import { buildEpisodeName } from '../src/services/newsletter/catchUp/catchUpCoverage';
import { ackEpisodes } from '../src/services/newsletter/catchUp/catchUpDraft';
import {
    LINK_END, LINK_START, applyLinkBlock, refreshDigestCatchUpLinks, renderLinkBlock, type DigestLinkDeps,
} from '../src/services/newsletter/catchUp/catchUpDigestLink';
import { makeCatchUpVault } from './helpers/catchUpVault';

const ROOT = 'AI-Organiser/Newsletter Inbox';
const FOLDER = `${ROOT}/Catch-up`;
const NOW = new Date(2026, 10, 14, 12, 0, 0);
const TEXT = { label: 'Catch-up audio', stateNew: 'new', stateHeard: 'heard' };
const digestPath = (d: string) => `${ROOT}/Digest — ${d}.md`;
const digest = (d: string) => `---\ntags:\n  - newsletter-digest\n---\n\n# Newsletter Digest — ${d}\n\n<!-- DAILY_BRIEF_START -->\n## Daily Brief\n\nbody\n\n<!-- DAILY_BRIEF_END -->\n\n## Sources\n`;

function plugin(initial: Record<string, unknown> = {}) {
    const state = { stored: structuredClone(initial) as Record<string, unknown> };
    return { loadData: async () => structuredClone(state.stored), saveData: vi.fn(async (d: Record<string, unknown>) => { state.stored = structuredClone(d); }) };
}

const settings = (over: Record<string, unknown> = {}) => ({
    ...DEFAULT_SETTINGS, featureFlags: { newsletter: true }, newsletterAudioPodcast: true, newsletterAudioMode: 'on-demand',
    newsletterCatchUpLookbackDays: 7, newsletterRetentionDays: 30, ...over,
}) as never;

let vault: ReturnType<typeof makeCatchUpVault>;
let p: ReturnType<typeof plugin>;
let writes: string[];
let writeResult: () => Result<void>;

function addEpisode(id: string, from: string, to: string): string {
    const input: EpisodeNoteInput = {
        id, from, to, coverage: { [to]: { kind: 'whole' as const } }, audio: `catchup-${id}-c3d4e5f6.mp3`,
        fingerprint: 'c3d4e5f6', minutes: 10, sources: 2, titles: ['t'], script: 's',
    };
    const path = `${FOLDER}/${buildEpisodeName(from, to, id)}`;
    vault.set(path, buildEpisodeNote(input));
    vault.set(`${FOLDER}/${input.audio}`, new ArrayBuffer(4));
    return path;
}

function deps(over: Partial<DigestLinkDeps> = {}): DigestLinkDeps {
    return {
        app: vault.app as never, plugin: p as never, settings: settings(), now: () => NOW, text: TEXT,
        writeNote: async (path, _b, next) => { writes.push(path); const r = writeResult(); if (r.ok) vault.set(path, next); return r; },
        ...over,
    };
}

beforeEach(() => {
    __resetChainForTests();
    vault = makeCatchUpVault();
    p = plugin();
    writes = [];
    writeResult = () => ok(undefined);
});

describe('applyLinkBlock (pure)', () => {
    const block = renderLinkBlock({ from: '2026-11-10', to: '2026-11-12', notePath: `${FOLDER}/Catch-up x.md` }, false, TEXT);

    it('inserts directly under the H1, leaving everything else byte-identical', () => {
        const src = digest('2026-11-14');
        const out = applyLinkBlock(src, block, true);
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.value.replace(`\n${block}\n`, '')).toBe(src);
        expect(out.value.indexOf(LINK_START)).toBeGreaterThan(out.value.indexOf('# Newsletter Digest'));
        expect(out.value.indexOf(LINK_START)).toBeLessThan(out.value.indexOf('DAILY_BRIEF_START'));
        expect(block).toContain('[[AI-Organiser/Newsletter Inbox/Catch-up/Catch-up x|Catch-up 2026-11-10 to 2026-11-12]] · new');
    });

    it('replaces an existing block in place and is idempotent', () => {
        const once = applyLinkBlock(digest('2026-11-14'), block, true);
        if (!once.ok) throw new Error('x');
        const heard = renderLinkBlock({ from: '2026-11-10', to: '2026-11-12', notePath: `${FOLDER}/Catch-up x.md` }, true, TEXT);
        const upd = applyLinkBlock(once.value, heard, false);
        expect(upd.ok && upd.value).toContain('· heard');
        expect(upd.ok && upd.value.split(LINK_START).length).toBe(2);
        const again = applyLinkBlock(once.value, block, true);
        expect(again.ok && again.value).toBe(once.value);
    });

    it('update-only mode leaves a digest without a block alone', () => {
        const src = digest('2026-11-14');
        const out = applyLinkBlock(src, block, false);
        expect(out.ok && out.value).toBe(src);
    });

    it('refuses malformed marker pairs', () => {
        for (const bad of [`${LINK_START}\nx`, `${LINK_END}\n${LINK_START}`, `${LINK_START}${LINK_END}${LINK_START}${LINK_END}`]) {
            expect(applyLinkBlock(`# T\n${bad}\n`, block, true).ok).toBe(false);
        }
    });

    it('a shorter fence marker does not close a longer fence', () => {
        const out = applyLinkBlock(['````', '```', '# inside', '````', '# Real', ''].join('\n'), block, true);
        expect(out.ok && out.value.indexOf(LINK_START)).toBeGreaterThan(out.ok ? out.value.indexOf('# Real') : 0);
    });

    it('ignores an H1-looking line inside a code fence and handles a missing H1', () => {
        const out = applyLinkBlock('---\na: 1\n---\n```\n# not a title\n```\ntext\n', block, true);
        expect(out.ok && out.value.startsWith('---\na: 1\n---\n')).toBe(true);
        expect(out.ok && out.value.indexOf(LINK_START)).toBeLessThan(out.ok ? out.value.indexOf('```') : 0);
    });
});

describe('refreshDigestCatchUpLinks', () => {
    it('links today and the episode\'s last day, then flips to heard when acked', async () => {
        const note = addEpisode('20261113-100000-aaaa', '2026-11-10', '2026-11-12');
        for (const d of ['2026-11-12', '2026-11-13', '2026-11-14']) vault.set(digestPath(d), digest(d));
        expect(await refreshDigestCatchUpLinks(deps())).toBe(2);
        expect(vault.text(digestPath('2026-11-14'))).toContain(`[[${note.replace(/\.md$/, '')}|Catch-up 2026-11-10 to 2026-11-12]] · new`);
        expect(vault.text(digestPath('2026-11-12'))).toContain(LINK_START);
        expect(vault.text(digestPath('2026-11-13'))).not.toContain(LINK_START);

        await ackEpisodes(p as never, [{ id: '20261113-100000-aaaa', to: '2026-11-12' }], '2026-11-14', 7);
        expect(await refreshDigestCatchUpLinks(deps())).toBe(2);
        expect(vault.text(digestPath('2026-11-14'))).toContain('· heard');
        expect(vault.text(digestPath('2026-11-12'))).toContain('· heard');
        expect(vault.text(digestPath('2026-11-13'))).not.toContain(LINK_START);
        // Idempotent: nothing left to write.
        expect(await refreshDigestCatchUpLinks(deps())).toBe(0);
    });

    it('a newer episode replaces the link in place', async () => {
        addEpisode('20261113-100000-aaaa', '2026-11-10', '2026-11-12');
        vault.set(digestPath('2026-11-14'), digest('2026-11-14'));
        await refreshDigestCatchUpLinks(deps());
        const newer = addEpisode('20261114-090000-bbbb', '2026-11-13', '2026-11-14');
        await refreshDigestCatchUpLinks(deps());
        const text = vault.text(digestPath('2026-11-14'));
        expect(text.split(LINK_START).length).toBe(2);
        expect(text).toContain(`[[${newer.replace(/\.md$/, '')}|Catch-up 2026-11-13 to 2026-11-14]] · new`);
        expect(text).not.toContain('2026-11-10');
    });

    it('also links a digest created later for an explicit date', async () => {
        addEpisode('20261113-100000-aaaa', '2026-11-10', '2026-11-12');
        vault.set(digestPath('2026-11-13'), digest('2026-11-13'));
        await refreshDigestCatchUpLinks(deps(), ['2026-11-13']);
        expect(vault.text(digestPath('2026-11-13'))).toContain(LINK_START);
    });

    it('a protected digest or a failed write never throws and is skipped', async () => {
        addEpisode('20261113-100000-aaaa', '2026-11-10', '2026-11-12');
        vault.set(digestPath('2026-11-14'), digest('2026-11-14'));
        const before = vault.text(digestPath('2026-11-14'));
        expect(await refreshDigestCatchUpLinks(deps({ settings: settings({ protectedFolders: [ROOT] }) }))).toBe(0);
        expect(writes).toEqual([]);
        writeResult = () => err('boom');
        expect(await refreshDigestCatchUpLinks(deps())).toBe(0);
        expect(vault.text(digestPath('2026-11-14'))).toBe(before);
        expect(await refreshDigestCatchUpLinks(deps({ writeNote: async () => { throw new Error('x'); } }))).toBe(0);
    });

    it('is a byte-identical no-op when audio is off or the mode is daily (no read, no write)', async () => {
        addEpisode('20261113-100000-aaaa', '2026-11-10', '2026-11-12');
        vault.set(digestPath('2026-11-14'), digest('2026-11-14'));
        const before = vault.text(digestPath('2026-11-14'));
        vault.app.vault.read.mockClear();
        for (const over of [{ newsletterAudioPodcast: false }, { newsletterAudioMode: 'daily' }, { featureFlags: { newsletter: false } }]) {
            expect(await refreshDigestCatchUpLinks(deps({ settings: settings(over) }))).toBe(0);
        }
        expect(writes).toEqual([]);
        expect(vault.app.vault.read).not.toHaveBeenCalled();
        expect(vault.text(digestPath('2026-11-14'))).toBe(before);
    });

    it('one failing digest does not stop the others, and the writer gets the pre-write text as baseline', async () => {
        addEpisode('20261113-100000-aaaa', '2026-11-10', '2026-11-12');
        vault.set(digestPath('2026-11-12'), digest('2026-11-12'));
        vault.set(digestPath('2026-11-14'), digest('2026-11-14'));
        const baselines: Record<string, string> = {};
        const written = await refreshDigestCatchUpLinks(deps({
            writeNote: async (path, baseline, next) => {
                baselines[path] = baseline;
                if (path === digestPath('2026-11-12')) throw new Error('boom');
                vault.set(path, next);
                return ok(undefined);
            },
        }));
        expect(written).toBe(1);
        expect(baselines[digestPath('2026-11-14')]).toBe(digest('2026-11-14'));
        expect(vault.text(digestPath('2026-11-14'))).toContain(LINK_START);
    });

    it('does nothing when there is no episode', async () => {
        vault.set(digestPath('2026-11-14'), digest('2026-11-14'));
        expect(await refreshDigestCatchUpLinks(deps())).toBe(0);
    });
});
