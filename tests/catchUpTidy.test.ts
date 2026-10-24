import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/minutesUtils', () => ({
    ensureFolderExists: vi.fn().mockResolvedValue(undefined),
    sanitizeFileName: (n: string) => n,
}));

import { ok, err, type Result } from '../src/core/result';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { __resetChainForTests } from '../src/core/pluginDataStore';
import { runExclusive, __resetCatchUpLockForTests } from '../src/services/newsletter/catchUp/catchUpService';
import { buildCatchUpSnapshot, embeddedDailyAudioNames, tidyPlanOf } from '../src/services/newsletter/catchUp/catchUpSelection';
import { buildEpisodeNote, type EpisodeNoteInput } from '../src/services/newsletter/catchUp/catchUpEpisode';
import { buildEpisodeName } from '../src/services/newsletter/catchUp/catchUpCoverage';
import { generatedEmbedLines } from '../src/services/newsletter/catchUp/catchUpDailyEmbed';
import { replaceDailyEmbedText, runDailyAudioTidy, type TidyDeps } from '../src/services/newsletter/catchUp/catchUpTidy';
import type { TidyFile } from '../src/services/newsletter/catchUp/catchUpTypes';
import { makeCatchUpVault } from './helpers/catchUpVault';

const ROOT = 'AI-Organiser/Newsletter Inbox';
const FOLDER = `${ROOT}/Catch-up`;
const NOW = new Date(2026, 9, 24, 12, 0, 0);
const EP_ID = '20261024-100000-aaaa';
const REMOVED = (d: string) => `Audio removed on ${d}`;

const brief = (n: string) => `### Fixtures\n\n- **Story ${n} alpha**: Synthetic summary alpha for fixture ${n}. (Sources: Fixture A)\n- **Story ${n} beta**: Synthetic summary beta for fixture ${n}. (Sources: Fixture B)\n`;
const audioName = (d: string, fp = 'abcd1234', ext = 'mp3') => `brief-${d}-${fp}.${ext}`;
const digest = (d: string, names: string[] = [audioName(d)], text = brief(d.slice(-2))) =>
    `# Newsletter Digest — ${d}\n\n${names.map((n) => `🎧 **Listen:** ![[${n}]]`).join('\n')}\n\n<!-- DAILY_BRIEF_START -->\n## Daily Brief\n\n${text}\n<!-- DAILY_BRIEF_END -->\n\n## Sources\n\n- [[${d}/Fixture 1|Fixture 1]]\n`;

const DAYS = ['2026-10-21', '2026-10-22', '2026-10-23'];

function ledger(audio: Record<string, Record<string, number>> = {}) {
    const buckets: Record<string, unknown> = {};
    for (const d of DAYS) {
        buckets[d] = { revision: 2, updatedAt: 1, audio: audio[d] ?? {}, stories: [{ key: `s ${d}`, title: `Story ${d.slice(-2)} alpha`, gist: 'g', firstRevision: 1, contentRevision: 1 }] };
    }
    return { 'newsletter-story-ledger': { version: 1, buckets } };
}

function makePlugin(initial: Record<string, unknown>) {
    const state = { stored: structuredClone(initial) as Record<string, unknown> };
    return { state, loadData: async () => structuredClone(state.stored), saveData: vi.fn(async (d: Record<string, unknown>) => { state.stored = structuredClone(d); }) };
}

const settings = (over: Record<string, unknown> = {}) => ({
    ...DEFAULT_SETTINGS,
    featureFlags: { newsletter: true },
    newsletterAudioPodcast: true,
    newsletterAudioMode: 'on-demand',
    newsletterStoryMemory: true,
    newsletterCatchUpLookbackDays: 7,
    newsletterRetentionDays: 30,
    ...over,
}) as never;

let vault: ReturnType<typeof makeCatchUpVault>;
let plugin: ReturnType<typeof makePlugin>;
let writes: Array<{ path: string; baseline: string; next: string }>;
let writeResult: () => Result<void>;

function deps(over: Partial<TidyDeps> = {}): TidyDeps {
    return {
        app: vault.app as never, plugin: plugin as never, settings: settings(), now: () => NOW,
        writeNote: async (path, baseline, next) => { writes.push({ path, baseline, next }); const r = writeResult(); if (r.ok) vault.set(path, next); return r; },
        removedLine: REMOVED,
        ...over,
    };
}

/** The episode note that covers the given days (the committed record the tidy re-reads). */
function addEpisode(coverageDays = DAYS, kind: 'revision' | 'whole' = 'revision'): void {
    const input: EpisodeNoteInput = {
        id: EP_ID, from: coverageDays[0], to: coverageDays.at(-1)!,
        coverage: Object.fromEntries(coverageDays.map((d) => [d, kind === 'revision' ? { kind: 'revision' as const, rev: 2 } : { kind: 'whole' as const }])),
        audio: `catchup-${EP_ID}-c3d4e5f6.mp3`, fingerprint: 'c3d4e5f6', minutes: 10, sources: 4, titles: ['t'], script: 'script',
    };
    vault.set(`${FOLDER}/${buildEpisodeName(input.from, input.to, input.id)}`, buildEpisodeNote(input));
    vault.set(`${FOLDER}/${input.audio}`, new ArrayBuffer(4));
}

/** Daily audio + embed for each day; returns the consented files exactly as the preview would. */
async function seed(days = DAYS, mutate?: (d: string) => void): Promise<TidyFile[]> {
    for (const d of days) {
        vault.set(`${ROOT}/Digest — ${d}.md`, digest(d));
        vault.set(`${ROOT}/${d}/${audioName(d)}`, new ArrayBuffer(8));
        mutate?.(d);
    }
    const snap = await buildCatchUpSnapshot({ app: vault.app as never, plugin: plugin as never, settings: settings(), now: NOW, forceDates: days });
    return snap.tidy?.files ?? [];
}

beforeEach(() => {
    __resetChainForTests();
    __resetCatchUpLockForTests();
    vault = makeCatchUpVault();
    plugin = makePlugin(ledger());
    writes = [];
    writeResult = () => ok(undefined);
});

const trashed = () => vault.app.fileManager.trashFile.mock.calls.map((c) => (c[0] as { path: string }).path);

describe('replaceDailyEmbedText (pure)', () => {
    const NAME = audioName('2026-10-21');
    it('replaces the generated embed line with one plain line and keeps everything else byte for byte', () => {
        const before = digest('2026-10-21');
        const r = replaceDailyEmbedText(before, [NAME], REMOVED('2026-10-24'));
        expect(r).toEqual({ ok: true, value: before.replace(`🎧 **Listen:** ![[${NAME}]]`, '🎧 **Listen:** Audio removed on 2026-10-24') });
    });

    it('handles the wav extension, and one generated line naming either of several candidate files', () => {
        const wav = audioName('2026-10-21', 'ffff0000', 'wav');
        const r = replaceDailyEmbedText(digest('2026-10-21', [wav]), [NAME, wav], REMOVED('x')) as { ok: true; value: string };
        expect(r.ok).toBe(true);
        expect(r.value.match(/Audio removed on x/g)).toHaveLength(1);
        expect(r.value).not.toContain('brief-');
    });

    it('fails closed unless there is EXACTLY ONE generated listen line (a copied or second line is not ours to judge)', () => {
        const wav = audioName('2026-10-21', 'ffff0000', 'wav');
        expect(replaceDailyEmbedText(digest('2026-10-21', [NAME, wav]), [NAME, wav], 'gone')).toEqual({ ok: false, error: 'unclassified-reference' });
        expect(replaceDailyEmbedText(digest('2026-10-21', [NAME, NAME]), [NAME], 'gone')).toEqual({ ok: false, error: 'unclassified-reference' });
    });

    it('a folder-qualified embed names some other file and is neither rewritten nor offered', () => {
        const qualified = digest('2026-10-21').replace(`![[${NAME}]]`, `![[Elsewhere/${NAME}]]`);
        expect(replaceDailyEmbedText(qualified, [NAME], 'gone')).toEqual({ ok: false, error: 'unclassified-reference' });
        expect(embeddedDailyAudioNames(qualified).size).toBe(0);
    });

    it('keeps CRLF line endings', () => {
        const before = digest('2026-10-21').replaceAll('\n', '\r\n');
        const r = replaceDailyEmbedText(before, [NAME], 'gone') as { ok: true; value: string };
        expect(r.value).toContain('🎧 **Listen:** gone\r\n');
    });

    it('fails closed when the name is mentioned anywhere else (second embed, link, code, brief text)', () => {
        const fail = { ok: false, error: 'unclassified-reference' };
        expect(replaceDailyEmbedText(digest('2026-10-21') + `\nSee ![[${NAME}]] again.\n`, [NAME], 'gone')).toEqual(fail);
        expect(replaceDailyEmbedText(digest('2026-10-21') + `\n\`${NAME}\`\n`, [NAME], 'gone')).toEqual(fail);
        expect(replaceDailyEmbedText(digest('2026-10-21', [NAME], `Mentions ${NAME} here.\n`), [NAME], 'gone')).toEqual(fail);
        expect(replaceDailyEmbedText(digest('2026-10-21').replace(`![[${NAME}]]`, `![[${NAME}|Listen]]`), [NAME], 'gone')).toEqual(fail);
    });

    it('does nothing when no generated embed exists, and never touches an unrelated recording', () => {
        expect(replaceDailyEmbedText('# Title\n\nno embed\n', [NAME], 'gone')).toEqual({ ok: false, error: 'unclassified-reference' });
        // A listen line for some OTHER recording is a second generated line: not ours to judge, so nothing is rewritten.
        const other = audioName('2026-10-21', 'ffff0000');
        expect(replaceDailyEmbedText(digest('2026-10-21', [NAME, other]), [NAME], 'gone')).toEqual({ ok: false, error: 'unclassified-reference' });
        // And the single line must name a consented file.
        expect(replaceDailyEmbedText(digest('2026-10-21', [other]), [NAME], 'gone')).toEqual({ ok: false, error: 'unclassified-reference' });
    });
});

describe('generatedEmbedLines (what counts as the plugin embed)', () => {
    const L = (n: string) => `🎧 **Listen:** ![[${n}]]`;
    const NAME = audioName('2026-10-21');
    const FENCE = '`'.repeat(3);
    /** Lines joined with a trailing newline: keeps the fixtures readable without escapes. */
    const T = (...lines: string[]): string => lines.join('\n') + '\n';

    it('finds the line the plugin writes, with its offsets', () => {
        const text = T('# T', '', L(NAME), '', 'body');
        const [line] = generatedEmbedLines(text);
        expect(line.name).toBe(NAME);
        expect(text.slice(line.start, line.end)).toBe(L(NAME) + '\n');
    });

    it('ignores fenced code (backtick and tilde), quotations, deep indentation and aliased or qualified links', () => {
        for (const text of [
            T('# T', '', FENCE, L(NAME), FENCE),
            T('# T', '', '~~~md', L(NAME), '~~~'),
            T('# T', '', '> ' + L(NAME)),
            T('# T', '', '    ' + L(NAME)),
            T('# T', '', `🎧 **Listen:** ![[${NAME}|Play]]`),
            T('# T', '', `🎧 **Listen:** ![[Other/${NAME}]]`),
        ]) expect(generatedEmbedLines(text)).toEqual([]);
    });

    it('ignores fences opened behind a list marker, and HTML comments (single and multi-line)', () => {
        for (const text of [
            T('- ' + FENCE, '  ' + L(NAME), '  ' + FENCE),
            T('1. ' + FENCE + 'md', L(NAME), FENCE),
            T('<!--', L(NAME), '-->'),
            T('<!-- an example', L(NAME)),
        ]) expect(generatedEmbedLines(text)).toEqual([]);
        expect(generatedEmbedLines(T('<!-- one line -->', L(NAME)))).toHaveLength(1);
    });

    it('a line after a closed fence counts again, and an unclosed fence hides the rest', () => {
        expect(generatedEmbedLines(T(FENCE, 'x', FENCE, L(NAME)))).toHaveLength(1);
        expect(generatedEmbedLines(T(FENCE, L(NAME)))).toEqual([]);
    });

    it('a fenced example is never rewritten as if it were the embed', () => {
        const only = T('# T', '', FENCE, L(NAME), FENCE);
        expect(replaceDailyEmbedText(only, [NAME], 'gone')).toEqual({ ok: false, error: 'unclassified-reference' });
        expect(embeddedDailyAudioNames(only).size).toBe(0);
    });
});

describe('the consented list (what the checkbox shows)', () => {
    it('embeddedDailyAudioNames reads only generated listen lines', () => {
        expect([...embeddedDailyAudioNames(digest('2026-10-21', [audioName('2026-10-21'), audioName('2026-10-21', 'ffff0000', 'wav'), `Folder/${audioName('2026-10-21', 'eeee0000')}`]))]).toEqual([audioName('2026-10-21'), audioName('2026-10-21', 'ffff0000', 'wav')]);
        expect(embeddedDailyAudioNames(`Some text ![[${audioName('2026-10-21')}]]`).size).toBe(0);
    });

    it('lists only embedded recordings of days narrated in FULL, with identity and totals', async () => {
        const files = await seed();
        expect(files.map((f) => f.name)).toEqual(DAYS.map((d) => audioName(d)));
        expect(tidyPlanOf(files)).toMatchObject({ days: DAYS, bytes: files.reduce((n, f) => n + f.bytes, 0) });
        expect(tidyPlanOf([])).toBeNull();
    });

    it('a recording that is not embedded in the digest is not offered', async () => {
        const files = await seed(DAYS, (d) => { if (d === '2026-10-22') vault.set(`${ROOT}/Digest — ${d}.md`, digest(d, [])); });
        expect(files.map((f) => f.date)).toEqual(['2026-10-21', '2026-10-23']);
    });

    it('a delta day is not offered (an earlier recording covered the rest of it)', async () => {
        // The 22nd was heard at revision 1 and has moved to revision 2: its entry is a delta, not a full day.
        vault.set(`${ROOT}/Digest — 2026-10-22.md`, digest('2026-10-22'));
        vault.set(`${ROOT}/2026-10-22/${audioName('2026-10-22')}`, new ArrayBuffer(8));
        const withLate = ledger({ '2026-10-22': { [audioName('2026-10-22')]: 1 } });
        (withLate['newsletter-story-ledger'].buckets['2026-10-22'] as { stories: unknown[] }).stories.push({ key: 'late', title: 'Late story', gist: 'g', firstRevision: 2, contentRevision: 2 });
        plugin.state.stored = {
            ...withLate,
            'newsletter-consumed-briefs': { version: 1, consumed: { '2026-10-22': { firstAt: 1, lastAt: 1, firstVia: 'audio', lastVia: 'audio', revision: 1 } } },
        };
        const snap = await buildCatchUpSnapshot({ app: vault.app as never, plugin: plugin as never, settings: settings(), now: NOW });
        expect(snap.plan!.entries.find((e) => e.date === '2026-10-22')!.kind).toBe('delta');
        expect(snap.tidy?.days ?? []).not.toContain('2026-10-22');
    });
});

describe('runDailyAudioTidy', () => {
    it('rewrites each digest FIRST, then trashes that day audio, and keeps the written brief', async () => {
        const files = await seed();
        addEpisode();
        const res = await runDailyAudioTidy(deps(), { files, episodeId: EP_ID });
        expect(res.ok).toBe(true);
        const report = (res as { value: { kind: 'done'; report: { removedFiles: number; daysDone: string[]; skipped: unknown[] } } }).value.report;
        expect(report).toMatchObject({ removedFiles: 3, daysDone: DAYS, skipped: [] });
        for (const d of DAYS) {
            const text = vault.text(`${ROOT}/Digest — ${d}.md`);
            expect(text).toContain('🎧 **Listen:** Audio removed on 2026-10-24');
            expect(text).not.toContain('brief-');
            expect(text).toContain('<!-- DAILY_BRIEF_START -->');
            expect(text).toContain(`Story ${d.slice(-2)} alpha`);
        }
        expect(writes.map((w) => w.path)).toEqual(DAYS.map((d) => `${ROOT}/Digest — ${d}.md`));
        // Note first, trash second: for every day the write precedes the trash of that day's audio.
        expect(trashed()).toEqual(DAYS.map((d) => `${ROOT}/${d}/${audioName(d)}`));
        expect(writes.every((w) => w.baseline.includes('![[brief-'))).toBe(true);
    });

    it('never touches a daily audio outside a covered day, nor one that was not consented to', async () => {
        const files = await seed();
        addEpisode(['2026-10-21', '2026-10-22']); // the 23rd is NOT covered by the committed episode
        // A recording that appeared after consent, in a covered day.
        vault.set(`${ROOT}/2026-10-21/${audioName('2026-10-21', 'ffff0000')}`, new ArrayBuffer(8));
        const res = await runDailyAudioTidy(deps(), { files, episodeId: EP_ID });
        const report = (res as { value: { report: { daysDone: string[]; skipped: Array<{ name: string; reason: string }> } } }).value.report;
        expect(report.daysDone).toEqual(['2026-10-21', '2026-10-22']);
        expect(report.skipped).toEqual([{ name: audioName('2026-10-23'), reason: 'not-covered' }]);
        expect(trashed()).not.toContain(`${ROOT}/2026-10-23/${audioName('2026-10-23')}`);
        expect(trashed()).not.toContain(`${ROOT}/2026-10-21/${audioName('2026-10-21', 'ffff0000')}`);
        expect(vault.exists(`${ROOT}/2026-10-21/${audioName('2026-10-21', 'ffff0000')}`)).toBe(true);
    });

    it('skips a day whose audio changed after consent, or whose brief advanced while the episode was made', async () => {
        const files = await seed();
        addEpisode();
        const f = vault.app.vault.getAbstractFileByPath(`${ROOT}/2026-10-21/${audioName('2026-10-21')}`) as { stat?: unknown };
        f.stat = { size: 99, mtime: 5 };
        vault.set(`${ROOT}/Digest — 2026-10-22.md`, digest('2026-10-22', undefined, `${brief('22')}\n- **Late story**: added while generating. (Sources: Fixture C)\n`));
        const res = await runDailyAudioTidy(deps(), { files, episodeId: EP_ID });
        const report = (res as { value: { report: { daysDone: string[]; skipped: Array<{ reason: string }> } } }).value.report;
        expect(report.daysDone).toEqual(['2026-10-23']);
        expect(report.skipped.map((s) => s.reason)).toEqual(['changed-since-consent', 'changed-since-consent']);
        expect(trashed()).toEqual([`${ROOT}/2026-10-23/${audioName('2026-10-23')}`]);
    });

    it('skips a recording that narrated a newer revision than the committed episode covers', async () => {
        const files = (await seed()).map((f) => (f.date === '2026-10-21' ? { ...f, narratedRev: 3 } : f));
        addEpisode(); // covers revision 2
        const res = await runDailyAudioTidy(deps(), { files, episodeId: EP_ID });
        const report = (res as { value: { report: { daysDone: string[]; skipped: Array<{ reason: string }> } } }).value.report;
        expect(report.skipped).toEqual([{ name: audioName('2026-10-21'), reason: 'changed-since-consent' }]);
        expect(report.daysDone).toEqual(['2026-10-22', '2026-10-23']);
    });

    it('works with story memory off (episode coverage is whole)', async () => {
        const files = await seed();
        addEpisode(DAYS, 'whole');
        const res = await runDailyAudioTidy(deps({ settings: settings({ newsletterStoryMemory: false }) }), { files, episodeId: EP_ID });
        expect((res as { value: { report: { daysDone: string[] } } }).value.report.daysDone).toEqual(DAYS);
    });

    it('a recording any other note links to stays', async () => {
        const files = await seed();
        addEpisode();
        vault.app.metadataCache.resolvedLinks['Journal/Today.md'] = { [`${ROOT}/2026-10-22/${audioName('2026-10-22')}`]: 1 };
        vault.app.metadataCache.resolvedLinks[`${ROOT}/Digest — 2026-10-21.md`] = { [`${ROOT}/2026-10-21/${audioName('2026-10-21')}`]: 1 };
        const res = await runDailyAudioTidy(deps(), { files, episodeId: EP_ID });
        const report = (res as { value: { report: { daysDone: string[]; skipped: Array<{ reason: string }> } } }).value.report;
        expect(report.skipped).toEqual([{ name: audioName('2026-10-22'), reason: 'linked-elsewhere' }]);
        expect(report.daysDone).toEqual(['2026-10-21', '2026-10-23']);
    });

    it('protected folders are honoured (the digest, or the audio)', async () => {
        const files = await seed();
        addEpisode();
        const res = await runDailyAudioTidy(deps({ settings: settings({ protectedFolders: [`${ROOT}/2026-10-22`] }) }), { files, episodeId: EP_ID });
        const report = (res as { value: { report: { daysDone: string[]; skipped: Array<{ reason: string }> } } }).value.report;
        expect(report.skipped).toEqual([{ name: audioName('2026-10-22'), reason: 'protected' }]);
        expect(report.daysDone).toEqual(['2026-10-21', '2026-10-23']);
        const digestProtected = await runDailyAudioTidy(deps({ settings: settings({ protectedFolders: [ROOT] }) }), { files, episodeId: EP_ID });
        expect((digestProtected as { value: { report: { removedFiles: number } } }).value.report.removedFiles).toBe(0);
    });

    it('a change that lands while the digest is being written stops the trash (judged again just before it)', async () => {
        const files = await seed();
        addEpisode();
        const writeNote: TidyDeps['writeNote'] = async (path, _baseline, next) => {
            vault.set(path, next);
            vault.emit('vault', 'modify', { path: `${ROOT}/Somewhere.md` });
            return ok(undefined);
        };
        const res = await runDailyAudioTidy(deps({ writeNote }), { files, episodeId: EP_ID });
        const report = (res as { value: { report: { removedFiles: number; halted: string | null; skipped: Array<{ reason: string }> } } }).value.report;
        expect(report.removedFiles).toBe(0);
        expect(report.halted).toBe('changed-during-tidy');
        expect(trashed()).toEqual([]);
    });

    it('an audio file replaced while the digest is being written is not trashed', async () => {
        const files = await seed();
        addEpisode();
        const writeNote: TidyDeps['writeNote'] = async (path, _baseline, next) => {
            vault.set(path, next);
            const f = vault.app.vault.getAbstractFileByPath(`${ROOT}/2026-10-21/${audioName('2026-10-21')}`) as { stat?: unknown };
            f.stat = { size: 1, mtime: 2 };
            return ok(undefined);
        };
        const res = await runDailyAudioTidy(deps({ writeNote }), { files: files.filter((f) => f.date === '2026-10-21'), episodeId: EP_ID });
        const report = (res as { value: { report: { removedFiles: number; skipped: Array<{ reason: string }> } } }).value.report;
        expect(report.removedFiles).toBe(0);
        expect(report.skipped).toEqual([{ name: audioName('2026-10-21'), reason: 'changed-since-consent' }]);
    });

    it('a failed digest edit leaves the audio and stops (the vault state is unknown)', async () => {
        const files = await seed();
        addEpisode();
        writeResult = () => err('baseline-changed');
        const res = await runDailyAudioTidy(deps(), { files, episodeId: EP_ID });
        const report = (res as { value: { report: { removedFiles: number; halted: string | null; skipped: unknown[] } } }).value.report;
        expect(report.removedFiles).toBe(0);
        expect(report.halted).toBe('changed-during-tidy');
        expect(trashed()).toEqual([]);
        expect(report.skipped).toHaveLength(3);
    });

    it('a failed trash leaves an inert file with no embed, and says so', async () => {
        const files = await seed();
        addEpisode();
        vault.app.fileManager.trashFile.mockRejectedValue(new Error('locked'));
        const res = await runDailyAudioTidy(deps(), { files, episodeId: EP_ID });
        const report = (res as { value: { report: { daysDone: string[]; skipped: Array<{ reason: string }> } } }).value.report;
        expect(report.daysDone).toEqual([]);
        expect(report.skipped.every((s) => s.reason === 'trash-failed')).toBe(true);
        expect(vault.text(`${ROOT}/Digest — 2026-10-21.md`)).not.toContain('brief-');
    });

    it('a foreign vault change while it runs stops that day and every later one', async () => {
        const files = await seed();
        addEpisode();
        let first = true;
        const writeNote: TidyDeps['writeNote'] = async (path, baseline, next) => {
            vault.set(path, next);
            if (first) { first = false; vault.emit('vault', 'modify', { path: `${ROOT}/Elsewhere.md` }); }
            return ok(undefined);
        };
        const res = await runDailyAudioTidy(deps({ writeNote }), { files, episodeId: EP_ID });
        const report = (res as { value: { report: { daysDone: string[]; halted: string | null } } }).value.report;
        expect(report.daysDone).toEqual([]);
        expect(report.halted).toBe('changed-during-tidy');
        expect(trashed()).toEqual([]);
        expect(vault.listeners()).toBe(0);
    });

    it('does nothing until the link index is ready, and when the episode is not committed', async () => {
        const files = await seed();
        addEpisode();
        const notReady = await runDailyAudioTidy(deps({ waitForIndex: async () => ({ outcome: 'timeout', state: 'building' }) }), { files, episodeId: EP_ID });
        expect(notReady).toEqual({ ok: true, value: { kind: 'skipped', reason: 'index-not-ready' } });
        const missing = await runDailyAudioTidy(deps(), { files, episodeId: '20990101-000000-ffff' });
        expect(missing).toEqual({ ok: true, value: { kind: 'skipped', reason: 'episode-missing' } });
        expect(trashed()).toEqual([]);
        expect(writes).toEqual([]);
    });

    it('is off outside the catch-up modes and with nothing consented, without reading the vault', async () => {
        const files = await seed();
        vault.app.vault.read.mockClear();
        expect(await runDailyAudioTidy(deps({ settings: settings({ newsletterAudioMode: 'daily' }) }), { files, episodeId: EP_ID })).toEqual({ ok: true, value: { kind: 'skipped', reason: 'off' } });
        expect(await runDailyAudioTidy(deps(), { files: [], episodeId: EP_ID })).toEqual({ ok: true, value: { kind: 'skipped', reason: 'off' } });
        expect(vault.app.vault.read).not.toHaveBeenCalled();
    });

    it('shares the single-flight lock: it reports busy while an episode is being made', async () => {
        const files = await seed();
        addEpisode();
        let release: () => void = () => undefined;
        const gate = new Promise<void>((r) => { release = r; });
        const holding = runExclusive(async () => { await gate; return ok(undefined); });
        const res = await runDailyAudioTidy(deps(), { files, episodeId: EP_ID });
        expect(res).toEqual({ ok: true, value: { kind: 'skipped', reason: 'busy' } });
        release();
        await holding;
    });

    it('never throws: a hostile vault becomes an error result', async () => {
        const files = await seed();
        addEpisode();
        const res = await runDailyAudioTidy(deps({ waitForIndex: async () => { throw new Error('boom'); } }), { files, episodeId: EP_ID });
        expect(res.ok).toBe(false);
    });

    it('no permanent deletion anywhere', async () => {
        const files = await seed();
        addEpisode();
        await runDailyAudioTidy(deps(), { files, episodeId: EP_ID });
        expect((vault.app.vault as unknown as Record<string, unknown>)['delete']).toBeUndefined();
        expect(vault.app.fileManager.trashFile).toHaveBeenCalledTimes(3);
    });
});
