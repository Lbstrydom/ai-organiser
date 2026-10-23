import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/minutesUtils', () => ({
    ensureFolderExists: vi.fn().mockResolvedValue(undefined),
    sanitizeFileName: (n: string) => n,
}));

import * as yaml from 'js-yaml';
import {
    generateOpId,
    isValidOpId,
    audioFileName,
    isInsideOutputRoot,
    buildEpisodeNote,
    buildEpisodeFrontmatter,
    parseEpisodeContent,
    episodeFolderPath,
    loadEpisodes,
    findLatestEpisode,
    findEpisodeByOpId,
    isAudioReferenced,
    writeEpisodeNote,
    trashOwnedFile,
    type EpisodeNoteInput,
} from '../src/services/newsletter/catchUp/catchUpEpisode';
import { buildEpisodeName } from '../src/services/newsletter/catchUp/catchUpCoverage';
import { makeCatchUpVault } from './helpers/catchUpVault';

const ROOT = 'AI-Organiser/Newsletter Inbox';
const FOLDER = `${ROOT}/Catch-up`;

function input(over: Partial<EpisodeNoteInput> = {}): EpisodeNoteInput {
    return {
        id: '20261023-081502-a1b2',
        from: '2026-10-21',
        to: '2026-10-23',
        coverage: { '2026-10-21': { kind: 'revision', rev: 3 }, '2026-10-22': { kind: 'whole' }, '2026-10-23': { kind: 'revision', rev: 1 } },
        audio: 'catchup-20261023-081502-a1b2-c3d4e5f6.mp3',
        fingerprint: 'c3d4e5f6',
        minutes: 14.34,
        sources: 9,
        titles: ['Fictional port strike ends', 'Invented chip export rules'],
        script: 'Good morning. Here is what happened.\n\nSecond paragraph of the script.',
        ...over,
    };
}

function episodePath(i: EpisodeNoteInput): string {
    return `${FOLDER}/${buildEpisodeName(i.from, i.to, i.id)}`;
}

describe('operation ids', () => {
    it('are local-time stamped with a 4-hex suffix and pass validation', () => {
        const id = generateOpId(new Date(2026, 9, 23, 8, 15, 2), () => 0.5);
        expect(id).toBe('20261023-081502-8000');
        expect(isValidOpId(id)).toBe(true);
    });

    it('two ids in the same second differ by the random suffix', () => {
        const t = new Date(2026, 9, 23, 8, 15, 2);
        expect(generateOpId(t, () => 0.1)).not.toBe(generateOpId(t, () => 0.9));
    });

    it('rejects ids that could escape a file name', () => {
        for (const bad of ['', '../x', '20261023-081502', 'a/b', '20261023-081502-zzzz', 12 as unknown]) {
            expect(isValidOpId(bad)).toBe(false);
        }
    });

    it('audio file names carry the op id and a short fingerprint', () => {
        expect(audioFileName('20261023-081502-a1b2', 'c3d4e5f6aaaa')).toBe('catchup-20261023-081502-a1b2-c3d4e5f6.mp3');
    });
});

describe('isInsideOutputRoot', () => {
    it('accepts paths under the root and the root itself', () => {
        expect(isInsideOutputRoot(ROOT, `${ROOT}/Catch-up/x.md`)).toBe(true);
        expect(isInsideOutputRoot(ROOT, ROOT)).toBe(true);
        expect(isInsideOutputRoot(`${ROOT}/`, `${ROOT}/a.md`)).toBe(true);
    });

    it('refuses siblings that merely share a prefix, other roots and traversal', () => {
        expect(isInsideOutputRoot(ROOT, `${ROOT}-evil/x.md`)).toBe(false);
        expect(isInsideOutputRoot(ROOT, 'Elsewhere/x.md')).toBe(false);
        expect(isInsideOutputRoot(ROOT, `${ROOT}/../Secret/x.md`)).toBe(false);
        expect(isInsideOutputRoot('', 'x.md')).toBe(false);
    });
});

describe('episode note content', () => {
    it('round-trips through the parser with full fidelity', () => {
        const i = input();
        const meta = parseEpisodeContent(buildEpisodeNote(i), 'p.md')!;
        expect(meta.id).toBe(i.id);
        expect(meta.from).toBe('2026-10-21');
        expect(meta.to).toBe('2026-10-23');
        expect(meta.coverage).toEqual(i.coverage);
        expect(meta.audio).toBe(i.audio);
        expect(meta.fingerprint).toBe('c3d4e5f6');
        expect(meta.minutes).toBe(14.3);
        expect(meta.sources).toBe(9);
    });

    it('writes whole as a string and revisions as positive integers, sorted by date', () => {
        const fm = buildEpisodeFrontmatter(input());
        expect(Object.keys(fm.catchup_coverage as object)).toEqual(['2026-10-21', '2026-10-22', '2026-10-23']);
        expect(fm.catchup_coverage).toEqual({ '2026-10-21': 3, '2026-10-22': 'whole', '2026-10-23': 1 });
    });

    it('embeds the audio, lists covered stories and quotes the transcript line by line', () => {
        const note = buildEpisodeNote(input());
        expect(note).toContain('🎧 **Listen:** ![[catchup-20261023-081502-a1b2-c3d4e5f6.mp3]]');
        expect(note).toContain('## Covered stories');
        expect(note).toContain('- Fictional port strike ends');
        expect(note).toContain('> [!note]- Transcript\n> Good morning. Here is what happened.\n> \n> Second paragraph of the script.');
        expect(note.match(/\[\[/g)).toHaveLength(1); // the audio embed is the only wikilink
    });

    it('titles collapse to one line so a hostile title cannot inject structure', () => {
        const note = buildEpisodeNote(input({ titles: ['Line one\n## injected heading\n---'] }));
        expect(note).toContain('- Line one ## injected heading ---');
        expect(note).not.toMatch(/^## injected heading/m);
    });

    it('a transcript line that looks like frontmatter or a heading stays inside the quote', () => {
        const note = buildEpisodeNote(input({ script: '---\naio_type: newsletter-catchup\n# Not a heading' }));
        const afterFm = note.slice(note.indexOf('\n---\n', 4) + 5);
        expect(afterFm).not.toMatch(/^aio_type:/m);
        expect(afterFm).toContain('> ---\n> aio_type: newsletter-catchup\n> # Not a heading');
    });

    it('the frontmatter block is valid YAML even for awkward ids', () => {
        const note = buildEpisodeNote(input());
        const fm = /^---\n([\s\S]*?)\n---/.exec(note)![1];
        expect(() => yaml.load(fm)).not.toThrow();
    });

    it('a single-day episode heading is a plain date', () => {
        const note = buildEpisodeNote(input({ from: '2026-10-23', to: '2026-10-23' }));
        expect(note).toContain('# Newsletter catch-up — 2026-10-23\n');
    });

    it('garbage and non-episode notes parse to null', () => {
        expect(parseEpisodeContent('no frontmatter', 'p')).toBeNull();
        expect(parseEpisodeContent('---\n: : :\n---\nx', 'p')).toBeNull();
        expect(parseEpisodeContent('---\ntitle: hello\n---\nx', 'p')).toBeNull();
    });
});

describe('loading episodes from the vault', () => {
    let vault: ReturnType<typeof makeCatchUpVault>;
    beforeEach(() => { vault = makeCatchUpVault(); });

    function addEpisode(i: EpisodeNoteInput, withAudio = true): void {
        vault.set(episodePath(i), buildEpisodeNote(i));
        if (withAudio) vault.set(`${FOLDER}/${i.audio}`, new ArrayBuffer(8));
    }

    it('returns an episode that parses and has its audio', async () => {
        addEpisode(input());
        const { episodes, missingAudio } = await loadEpisodes(vault.app as never, ROOT, '2026-10-17');
        expect(episodes.map((e) => e.id)).toEqual(['20261023-081502-a1b2']);
        expect(missingAudio).toEqual([]);
    });

    it('an episode whose audio was deleted is offered for regeneration and covers nothing', async () => {
        addEpisode(input(), false);
        const { episodes, missingAudio } = await loadEpisodes(vault.app as never, ROOT, '2026-10-17');
        expect(episodes).toEqual([]);
        expect(missingAudio.map((e) => e.id)).toEqual(['20261023-081502-a1b2']);
    });

    it('ignores non-episode files and malformed episodes', async () => {
        addEpisode(input());
        vault.set(`${FOLDER}/notes.md`, 'just a note');
        vault.set(`${FOLDER}/Catch-up 2026-10-22 bad1.md`, '---\naio_type: newsletter-catchup\n---\nno coverage');
        const { episodes } = await loadEpisodes(vault.app as never, ROOT, '2026-10-17');
        expect(episodes).toHaveLength(1);
    });

    it('works with a cold metadata cache by reading the file', async () => {
        addEpisode(input());
        vault.cache.enabled = false;
        const { episodes } = await loadEpisodes(vault.app as never, ROOT, '2026-10-17');
        expect(episodes).toHaveLength(1);
        expect(vault.app.vault.cachedRead).toHaveBeenCalled();
    });

    it('uses the metadata cache without reading file contents when it is warm', async () => {
        addEpisode(input());
        await loadEpisodes(vault.app as never, ROOT, '2026-10-17');
        expect(vault.app.vault.cachedRead).not.toHaveBeenCalled();
    });

    it('is bounded: 500 old episodes cost no reads and no audio checks', async () => {
        for (let n = 0; n < 500; n++) {
            const day = `2025-${String((n % 12) + 1).padStart(2, '0')}-${String((n % 27) + 1).padStart(2, '0')}`;
            const i = input({ id: `20250101-0000${String(n % 10)}${String(n).padStart(1, '0')}-${(n % 0xffff).toString(16).padStart(4, '0')}`.slice(0, 20), from: day, to: day });
            vault.set(episodePath(i), buildEpisodeNote(i));
        }
        addEpisode(input());
        vault.app.metadataCache.getFileCache.mockClear();
        const spy = vi.spyOn(vault.app.vault, 'getAbstractFileByPath');
        const { episodes } = await loadEpisodes(vault.app as never, ROOT, '2026-10-17');
        expect(episodes).toHaveLength(1);
        // One cache lookup for the in-window episode, none for the 500 out-of-window notes.
        expect(vault.app.metadataCache.getFileCache).toHaveBeenCalledTimes(1);
        // The folder lookup, plus one existence check for the in-window audio.
        expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
    });

    it('finds the latest episode regardless of the window', async () => {
        addEpisode(input({ id: '20260101-000000-aaaa', from: '2026-01-01', to: '2026-01-02' }));
        addEpisode(input({ id: '20260301-000000-bbbb', from: '2026-03-01', to: '2026-03-05' }));
        const latest = await findLatestEpisode(vault.app as never, ROOT);
        expect(latest?.id).toBe('20260301-000000-bbbb');
    });

    it('finds an episode by operation id and by audio reference', async () => {
        addEpisode(input());
        expect((await findEpisodeByOpId(vault.app as never, ROOT, '20261023-081502-a1b2'))?.audio).toBe(input().audio);
        expect(await findEpisodeByOpId(vault.app as never, ROOT, '20261023-081502-ffff')).toBeNull();
        expect(await isAudioReferenced(vault.app as never, ROOT, input().audio)).toBe(true);
        expect(await isAudioReferenced(vault.app as never, ROOT, 'catchup-other.mp3')).toBe(false);
    });
});

describe('writing the episode note (the commit point)', () => {
    it('creates the note inside the Catch-up folder', async () => {
        const vault = makeCatchUpVault();
        const res = await writeEpisodeNote(vault.app as never, ROOT, input());
        expect(res.created).toBe(true);
        expect(res.path).toBe(episodePath(input()));
        expect(vault.exists(res.path)).toBe(true);
        expect(episodeFolderPath(ROOT)).toBe(FOLDER);
    });

    it('is idempotent by operation id: a second commit is success, not a collision', async () => {
        const vault = makeCatchUpVault();
        await writeEpisodeNote(vault.app as never, ROOT, input());
        const again = await writeEpisodeNote(vault.app as never, ROOT, input());
        expect(again.created).toBe(false);
        expect(vault.app.vault.create).toHaveBeenCalledTimes(1);
    });

    it('refuses to write outside the output root', async () => {
        const vault = makeCatchUpVault();
        await expect(writeEpisodeNote(vault.app as never, '../Escape', input())).rejects.toThrow(/outside the newsletter output folder/);
        expect(vault.app.vault.create).not.toHaveBeenCalled();
    });
});

describe('trashing owned files', () => {
    it('trashes a file inside the root through the file manager', async () => {
        const vault = makeCatchUpVault({ [`${FOLDER}/a.mp3`]: new ArrayBuffer(4) });
        expect(await trashOwnedFile(vault.app as never, ROOT, `${FOLDER}/a.mp3`)).toBe(true);
        expect(vault.app.fileManager.trashFile).toHaveBeenCalledTimes(1);
        expect(vault.exists(`${FOLDER}/a.mp3`)).toBe(false);
    });

    it('refuses a path outside the root and never touches the file manager', async () => {
        const vault = makeCatchUpVault({ 'Elsewhere/a.mp3': new ArrayBuffer(4) });
        await expect(trashOwnedFile(vault.app as never, ROOT, 'Elsewhere/a.mp3')).rejects.toThrow(/outside/);
        await expect(trashOwnedFile(vault.app as never, ROOT, `${ROOT}/../Elsewhere/a.mp3`)).rejects.toThrow(/outside/);
        expect(vault.app.fileManager.trashFile).not.toHaveBeenCalled();
    });

    it('a missing file is a quiet false', async () => {
        const vault = makeCatchUpVault();
        expect(await trashOwnedFile(vault.app as never, ROOT, `${FOLDER}/none.mp3`)).toBe(false);
    });
});
