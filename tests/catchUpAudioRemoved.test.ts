import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/minutesUtils', () => ({
    ensureFolderExists: vi.fn().mockResolvedValue(undefined),
    sanitizeFileName: (n: string) => n,
}));

import { DEFAULT_SETTINGS } from '../src/core/settings';
import { __resetChainForTests } from '../src/core/pluginDataStore';
import {
    buildEpisodeNote,
    parseEpisodeContent,
    loadEpisodes,
    findLatestEpisode,
    findEpisodeByOpId,
    markAudioRemovedText,
    ownNoteIsReferenceFree,
    type EpisodeNoteInput,
} from '../src/services/newsletter/catchUp/catchUpEpisode';
import {
    buildEpisodeName,
    deriveCoverage,
    newestCoveredDate,
    unheardEpisodes,
} from '../src/services/newsletter/catchUp/catchUpCoverage';
import { buildCatchUpSnapshot } from '../src/services/newsletter/catchUp/catchUpSelection';
import { markCatchUpAudioPlayed } from '../src/services/newsletter/catchUp/catchUpListen';
import { loadAcks } from '../src/services/newsletter/catchUp/catchUpDraft';
import { makeCatchUpVault } from './helpers/catchUpVault';

const ROOT = 'AI-Organiser/Newsletter Inbox';
const FOLDER = `${ROOT}/Catch-up`;
const NOW = new Date(2026, 9, 23, 12, 0, 0);
const DATE = '2026-11-30';
const REMOVED = `Audio removed on ${DATE}`;

function input(over: Partial<EpisodeNoteInput> = {}): EpisodeNoteInput {
    return {
        id: '20261022-081500-a1b2',
        from: '2026-10-20',
        to: '2026-10-21',
        coverage: { '2026-10-20': { kind: 'revision', rev: 2 }, '2026-10-21': { kind: 'revision', rev: 2 } },
        audio: 'catchup-20261022-081500-a1b2-c3d4e5f6.mp3',
        fingerprint: 'c3d4e5f6',
        minutes: 12,
        sources: 4,
        titles: ['Fictional port strike ends'],
        script: 'Good morning. Here is what happened.\n\nSecond paragraph.',
        ...over,
    };
}

const notePath = (i: EpisodeNoteInput) => `${FOLDER}/${buildEpisodeName(i.from, i.to, i.id)}`;

function removedNote(over: Partial<EpisodeNoteInput> = {}): string {
    const i = input(over);
    const res = markAudioRemovedText(buildEpisodeNote(i), i.audio, DATE, REMOVED);
    if (!res.ok) throw new Error(res.error);
    return res.value;
}

describe('the audio removed state keeps the note as the coverage record', () => {
    let vault: ReturnType<typeof makeCatchUpVault>;
    beforeEach(() => { vault = makeCatchUpVault(); });

    it('parses the marker and still validates the note', () => {
        const meta = parseEpisodeContent(removedNote(), 'p.md')!;
        expect(meta.audioRemoved).toBe(DATE);
        expect(meta.audio).toBe(input().audio);
        expect(meta.coverage).toEqual(input().coverage);
    });

    it('ignores a marker that is not a date, and tolerates an unquoted YAML timestamp', () => {
        const base = buildEpisodeNote(input());
        const bad = base.replace('catchup_sources: 4', 'catchup_sources: 4\ncatchup_audio_removed: soon');
        expect(parseEpisodeContent(bad, 'p')!.audioRemoved).toBeUndefined();
        const bare = base.replace('catchup_sources: 4', `catchup_sources: 4\ncatchup_audio_removed: ${DATE}`);
        expect(parseEpisodeContent(bare, 'p')!.audioRemoved).toBe(DATE);
    });

    it('an episode whose audio is gone WITH the marker keeps covering and is not offered for regeneration', async () => {
        const i = input();
        vault.set(notePath(i), removedNote());
        const { episodes, missingAudio } = await loadEpisodes(vault.app as never, ROOT, '2026-10-17');
        expect(episodes.map((e) => e.id)).toEqual([i.id]);
        expect(missingAudio).toEqual([]);
    });

    it('a marked episode whose audio still exists is also an episode', async () => {
        const i = input();
        vault.set(notePath(i), removedNote());
        vault.set(`${FOLDER}/${i.audio}`, new ArrayBuffer(4));
        const { episodes, missingAudio } = await loadEpisodes(vault.app as never, ROOT, '2026-10-17');
        expect(episodes).toHaveLength(1);
        expect(missingAudio).toEqual([]);
    });

    it('an unmarked episode with a vanished file is still offered for regeneration (unchanged)', async () => {
        const i = input();
        vault.set(notePath(i), buildEpisodeNote(i));
        const { episodes, missingAudio } = await loadEpisodes(vault.app as never, ROOT, '2026-10-17');
        expect(episodes).toEqual([]);
        expect(missingAudio).toHaveLength(1);
    });

    it('findEpisodeByOpId and the latest-episode lookup still resolve it', async () => {
        const i = input();
        vault.set(notePath(i), removedNote());
        expect((await findEpisodeByOpId(vault.app as never, ROOT, i.id))?.audioRemoved).toBe(DATE);
        expect((await findLatestEpisode(vault.app as never, ROOT))?.id).toBe(i.id);
    });
});

describe('coverage, pending and unheard with a removed episode', () => {
    it('deriveCoverage still counts it and unheardEpisodes never lists it', () => {
        const meta = parseEpisodeContent(removedNote(), 'p.md')!;
        expect(deriveCoverage([meta])).toEqual(input().coverage);
        expect(unheardEpisodes([meta], {}, '2026-10-17')).toEqual([]);
    });

    it('newestCoveredDate is the latest of to and the coverage keys', () => {
        const rev = { kind: 'revision', rev: 1 } as const;
        expect(newestCoveredDate({ to: '2026-10-22', coverage: { '2026-10-20': rev, '2026-10-23': rev } })).toBe('2026-10-23');
        expect(newestCoveredDate({ to: '2026-10-22', coverage: { '2026-10-20': rev } })).toBe('2026-10-22');
    });

    it('the pending days are identical before and after the audio is removed', async () => {
        const brief = (n: string) => `### Fixtures\n\n- **Story ${n} alpha**: Synthetic summary alpha for fixture ${n}. (Sources: Fixture A)\n- **Story ${n} beta**: Synthetic summary beta for fixture ${n}. (Sources: Fixture B)\n`;
        const digest = (date: string, text: string) => `# Newsletter Digest — ${date}\n\n<!-- DAILY_BRIEF_START -->\n## Daily Brief\n\n${text}\n<!-- DAILY_BRIEF_END -->\n\n## Sources\n\n- [[${date}/Fixture 1|Fixture 1]]\n`;
        const build = async (v: ReturnType<typeof makeCatchUpVault>) => buildCatchUpSnapshot({
            app: v.app as never,
            plugin: { loadData: async () => ({ 'newsletter-story-ledger': undefined }), saveData: vi.fn() } as never,
            settings: { ...DEFAULT_SETTINGS, featureFlags: { newsletter: true }, newsletterAudioPodcast: true, newsletterStoryMemory: false, newsletterCatchUpLookbackDays: 7, newsletterRetentionDays: 30 } as never,
            now: NOW,
        }, 'manual');

        const live = makeCatchUpVault();
        const marked = makeCatchUpVault();
        for (const v of [live, marked]) {
            for (const d of ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']) v.set(`${ROOT}/Digest — ${d}.md`, digest(d, brief(d.slice(-2))));
        }
        const i = input({ coverage: { '2026-10-20': { kind: 'whole' }, '2026-10-21': { kind: 'whole' } } });
        live.set(notePath(i), buildEpisodeNote(i));
        live.set(`${FOLDER}/${i.audio}`, new ArrayBuffer(4));
        marked.set(notePath(i), removedNote({ coverage: i.coverage }));

        const before = await build(live);
        const after = await build(marked);
        expect(after.pending.entries.map((e) => e.date)).toEqual(before.pending.entries.map((e) => e.date));
        expect(after.pending.entries.map((e) => e.date)).toEqual(['2026-10-22']); // today is still open with story memory off
        expect(after.missingAudio).toEqual([]);
        expect(after.unheard).toEqual([]);
        expect(after.plan?.planHash).toBe(before.plan?.planHash);
    });
});

describe('listen detection still works for a note whose audio was removed', () => {
    beforeEach(() => { __resetChainForTests(); });

    it('a replay of the (still-present) file marks the episode heard', async () => {
        const vault = makeCatchUpVault();
        const i = input();
        vault.set(notePath(i), removedNote());
        vault.set(`${FOLDER}/${i.audio}`, new ArrayBuffer(4));
        const state = { stored: {} as Record<string, unknown> };
        const plugin = {
            loadData: async () => structuredClone(state.stored),
            saveData: async (d: Record<string, unknown>) => { state.stored = structuredClone(d); },
        };
        const settings = { ...DEFAULT_SETTINGS, featureFlags: { newsletter: true }, newsletterStoryMemory: false } as never;
        const r = await markCatchUpAudioPlayed(
            { app: vault.app as never, plugin: plugin as never, settings, now: NOW },
            { sourcePath: notePath(i), audioSrc: `${FOLDER}/${i.audio}` },
        );
        expect(r).toEqual({ ok: true, value: true });
        expect(Object.keys(await loadAcks(plugin as never))).toEqual([i.id]);
    });
});

describe('markAudioRemovedText', () => {
    const NAME = input().audio;
    const run = (content: string) => markAudioRemovedText(content, NAME, DATE, REMOVED);
    const okText = (content: string) => { const r = run(content); if (!r.ok) throw new Error(r.error); return r.value; };

    it('inserts the quoted marker as the last frontmatter line and rewrites only the listen line', () => {
        const before = buildEpisodeNote(input());
        const after = okText(before);
        expect(after).toContain(`catchup_sources: 4\ncatchup_audio_removed: '${DATE}'\n---\n`);
        expect(after).toContain(`🎧 **Listen:** ${REMOVED}\n`);
        expect(after).not.toContain('![[');
        const restored = after.replace(`catchup_audio_removed: '${DATE}'\n`, '').replace(REMOVED, `![[${NAME}]]`);
        expect(restored).toBe(before);
    });

    it('keeps the frontmatter identity line catchup_audio untouched', () => {
        expect(okText(buildEpisodeNote(input()))).toContain(`catchup_audio: ${NAME}\n`);
    });

    it.each([
        ['alias', `![[${NAME}|Listen]]`],
        ['heading', `![[${NAME}#t=10]]`],
        ['folder-qualified', `![[Catch-up/${NAME}]]`],
        ['plain link', `[[${NAME}]]`],
        ['markdown embed', `![Listen](${NAME})`],
        ['markdown link with a folder', `[Listen](Catch-up/${NAME})`],
    ])('rewrites a %s on the listen line', (_label, ref) => {
        const note = buildEpisodeNote(input()).replace(`![[${NAME}]]`, ref);
        const after = okText(note);
        expect(after).toContain(`🎧 **Listen:** ${REMOVED}\n`);
        expect(ownNoteIsReferenceFree(after, NAME)).toBe(true);
    });

    it('uses the frontmatter\'s own line ending: LF frontmatter with CRLF in the body, and the reverse', () => {
        const lfFm = buildEpisodeNote(input()).replace('Second paragraph.', 'Second paragraph.\r\nCRLF tail.');
        const a = okText(lfFm);
        expect(a).toContain(`catchup_sources: 4\ncatchup_audio_removed: '${DATE}'\n---\n`);
        expect(parseEpisodeContent(a, 'p')!.audioRemoved).toBe(DATE);
        const crlfFm = buildEpisodeNote(input()).replaceAll('\n', '\r\n').replace('Second paragraph.', 'Second paragraph.\nLF tail.');
        const b = okText(crlfFm);
        expect(b).toContain(`catchup_sources: 4\r\ncatchup_audio_removed: '${DATE}'\r\n---`);
        expect(parseEpisodeContent(b, 'p')!.audioRemoved).toBe(DATE);
    });

    it('two references on the listen line, or one inside an inline code span, fail closed before any rewrite', () => {
        const two = buildEpisodeNote(input()).replace(`![[${NAME}]]`, `![[${NAME}]] and [[${NAME}]]`);
        expect(run(two)).toEqual({ ok: false, error: 'unclassified-reference' });
        const code = buildEpisodeNote(input()).replace(`![[${NAME}]]`, '`![[' + NAME + ']]`');
        expect(run(code)).toEqual({ ok: false, error: 'unclassified-reference' });
    });

    it('a listen-looking line inside a fenced block is not the listen line', () => {
        const fenced = buildEpisodeNote(input()).replace('# Newsletter', '```\n🎧 **Listen:** ![[' + NAME + ']]\n```\n\n# Newsletter');
        // The fenced reference is NOT rewritten, so the verification fails closed.
        expect(run(fenced)).toEqual({ ok: false, error: 'unclassified-reference' });
    });

    it('fence tracking honours run length and character (CommonMark)', () => {
        const listen = '🎧 **Listen:** ![[' + NAME + ']]';
        const base = buildEpisodeNote(input()).replace(`![[${NAME}]]`, 'gone');
        const inside = (block: string) => base.replace('# Newsletter', `${block}\n\n# Newsletter`);
        // A shorter fence line cannot close a longer fence: the reference stays inside the code block.
        expect(run(inside('````text\n```\n' + listen + '\n````'))).toEqual({ ok: false, error: 'unclassified-reference' });
        // A different fence character cannot close it either.
        expect(run(inside('```\n~~~\n' + listen + '\n```'))).toEqual({ ok: false, error: 'unclassified-reference' });
        // A closing-looking line with a suffix does not close.
        expect(run(inside('```\n``` not a close\n' + listen + '\n```'))).toEqual({ ok: false, error: 'unclassified-reference' });
        // A tilde fence closed properly ends: a listen line after it is the real one.
        const closed = base.replace('# Newsletter', '~~~\ncode\n~~~\n\n# Newsletter');
        expect(run(closed).ok).toBe(true);
        // An info string containing a backtick is not a fence opener.
        const notFence = buildEpisodeNote(input()).replace('# Newsletter', '``` a`b\n\n# Newsletter');
        const r = run(notFence);
        expect(r.ok).toBe(true);
    });

    it('a closing fence followed by a non-breaking space does not close; tabs and spaces do', () => {
        const listen = '🎧 **Listen:** ![[' + NAME + ']]';
        const base = buildEpisodeNote(input()).replace(`![[${NAME}]]`, 'gone');
        const inside = (close: string) => base.replace('# Newsletter', '```\n' + listen + '\n' + close + '\n\n# Newsletter');
        expect(run(inside('``` '))).toEqual({ ok: false, error: 'unclassified-reference' });
        expect(run(inside('```\f'))).toEqual({ ok: false, error: 'unclassified-reference' });
        // Properly closed (space/tab suffix): the block ends, but the reference inside it was never the listen line.
        expect(run(inside('``` \t'))).toEqual({ ok: false, error: 'unclassified-reference' });
    });

    it('only the exact generated listen shape is rewritten', () => {
        for (const line of [`🎧 Listen now ![[${NAME}]]`, `🎧 **Listen:** ![[${NAME}]] (best on headphones)`, `🎧 **Listen:** see ![[${NAME}]]`]) {
            const note = buildEpisodeNote(input()).replace(`🎧 **Listen:** ![[${NAME}]]`, line);
            expect(run(note)).toEqual({ ok: false, error: 'unclassified-reference' });
        }
    });

    it('a same-named file in another folder, or at a URL, is not this episode\'s file and is never rewritten', () => {
        for (const ref of [`![[Archive/${NAME}]]`, `![[Elsewhere/Catch-up/${NAME}]]`, `![Listen](https://example.invalid/${NAME})`, `![Listen](Archive/${NAME})`]) {
            const note = buildEpisodeNote(input()).replace(`![[${NAME}]]`, ref);
            expect(run(note)).toEqual({ ok: false, error: 'unclassified-reference' });
        }
    });

    it('the vault-qualified episode folder is accepted when the caller names it', () => {
        const folder = 'AI-Organiser/Newsletter Inbox/Catch-up';
        const note = buildEpisodeNote(input()).replace(`![[${NAME}]]`, `![[${folder}/${NAME}]]`);
        expect(markAudioRemovedText(note, NAME, DATE, REMOVED).ok).toBe(false); // not named: rejected
        const named = markAudioRemovedText(note, NAME, DATE, REMOVED, folder);
        expect(named.ok).toBe(true);
        expect(named.ok && named.value).toContain(`🎧 **Listen:** ${REMOVED}`);
    });

    it('a generated-shaped line inside a multi-line inline code span is not the listen line', () => {
        const listen = '🎧 **Listen:** ![[' + NAME + ']]';
        const base = buildEpisodeNote(input()).replace(`![[${NAME}]]`, 'gone');
        const spanned = base.replace('# Newsletter', 'Example: `start of a span\n' + listen + '\nend of the span`\n\n# Newsletter');
        expect(run(spanned)).toEqual({ ok: false, error: 'unclassified-reference' });
        // A blank line ends a span, so a stray backtick does not hide a later real listen line.
        const stray = buildEpisodeNote(input()).replace('# Newsletter', 'a stray ` tick\n\n# Newsletter');
        expect(run(stray).ok).toBe(true);
    });

    it('preserves CRLF line endings', () => {
        const after = okText(buildEpisodeNote(input()).replaceAll('\n', '\r\n'));
        expect(after).toContain(`catchup_sources: 4\r\ncatchup_audio_removed: '${DATE}'\r\n---`);
        expect(after.replaceAll('\r\n', '')).not.toContain('\n');
    });

    it.each([['LF', '\n'], ['CRLF', '\r\n']])('is idempotent for the same date and refuses a different marker date (%s)', (_label, eol) => {
        const once = okText(buildEpisodeNote(input()).replaceAll('\n', eol));
        expect(okText(once)).toBe(once);
        expect(run(once.replace(DATE, '2026-11-01'))).toEqual({ ok: false, error: 'marker-conflict' });
    });

    it('fails closed when the name still appears anywhere else', () => {
        const withFence = buildEpisodeNote(input()).replace('## Covered stories', '```\n![[' + NAME + ']]\n```\n\n## Covered stories');
        expect(run(withFence)).toEqual({ ok: false, error: 'unclassified-reference' });
        const inline = buildEpisodeNote(input()).replace('## Covered stories', 'Try `[[' + NAME + ']]`\n\n## Covered stories');
        expect(run(inline)).toEqual({ ok: false, error: 'unclassified-reference' });
        expect(run(buildEpisodeNote(input({ script: `see ![[${NAME}]]` })))).toEqual({ ok: false, error: 'unclassified-reference' });
        const second = buildEpisodeNote(input()).replace('## Covered stories', `Again ![[${NAME}]]\n\n## Covered stories`);
        expect(run(second)).toEqual({ ok: false, error: 'unclassified-reference' });
    });

    it('fails closed on a frontmatter field that links the audio', () => {
        const related = buildEpisodeNote(input()).replace('catchup_sources: 4', `catchup_sources: 4\nrelated: "[[${NAME}]]"`);
        expect(run(related)).toEqual({ ok: false, error: 'unclassified-reference' });
    });

    it('without a listen line but with a reference it fails closed; with no body reference only the marker is added', () => {
        const noListen = buildEpisodeNote(input()).replace('🎧 **Listen:** ', 'Play: ');
        expect(run(noListen)).toEqual({ ok: false, error: 'unclassified-reference' });
        const noRef = buildEpisodeNote(input()).replace(`![[${NAME}]]`, 'gone');
        const after = okText(noRef);
        expect(after).toContain(`catchup_audio_removed: '${DATE}'`);
        expect(after).toContain('🎧 **Listen:** gone');
    });

    it('refuses a note without frontmatter', () => {
        expect(run('no frontmatter')).toEqual({ ok: false, error: 'no-frontmatter' });
    });

    it('matches case-insensitively', () => {
        const note = buildEpisodeNote(input()).replace(`![[${NAME}]]`, `![[${NAME.toUpperCase()}]]`);
        expect(okText(note)).toContain(`🎧 **Listen:** ${REMOVED}`);
    });
});

describe('ownNoteIsReferenceFree', () => {
    const NAME = input().audio;
    it('exempts only the identity line', () => {
        const note = buildEpisodeNote(input());
        expect(ownNoteIsReferenceFree(note, NAME)).toBe(false);
        expect(ownNoteIsReferenceFree(note.replace(`![[${NAME}]]`, 'x'), NAME)).toBe(true);
        expect(ownNoteIsReferenceFree(note.replace(`![[${NAME}]]`, `x ${NAME}`), NAME)).toBe(false);
        const forged = note.replace(`![[${NAME}]]`, 'x').replace('catchup_sources: 4', `catchup_sources: 4\ncatchup_audio_note: ${NAME}`);
        expect(ownNoteIsReferenceFree(forged, NAME)).toBe(false);
    });
});
