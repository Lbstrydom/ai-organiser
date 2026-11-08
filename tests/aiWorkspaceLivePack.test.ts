import { describe, it, expect } from 'vitest';
import { buildLivePack, buildLiveStub, hasAnyLiveMarker, hasLiveMarker, LIVE_FILE_MAX_BYTES } from '../src/services/aiWorkspaces/livePack';
import { buildWorkspaceInstructions } from '../src/services/aiWorkspaces/workspaceInstructions';
import { isAbsoluteFolder, isLiveFileName, normaliseLive, normaliseRevocations, normaliseWorkspace, readableDestination } from '../src/services/aiWorkspaces/workspaceRecord';
import { normaliseLiveStatus } from '../src/services/aiWorkspaces/liveStatus';
import { migrateOldSettings } from '../src/core/settings';
import type { LinkOccurrence } from '../src/services/aiWorkspaces/linkNeutraliser';

const ID = '3f2b8f4e-1c2d-4e5f-8a6b-7c8d9e0f1a2b';
const POLICY = 'b'.repeat(64);

/** Wikilink occurrences with their real offsets, as Obsidian's cache reports them. */
function wikiCache(text: string): LinkOccurrence[] {
    const out: LinkOccurrence[] = [];
    for (const m of text.matchAll(/!?\[\[([^\]]+)\]\]/g)) {
        out.push({ link: m[1], original: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, embed: m[0].startsWith('!') });
    }
    return out;
}

const note = (path: string, text: string) => ({ path, text });
const base = (over: Partial<Parameters<typeof buildLivePack>[0]> = {}) => ({
    vaultId: 'vault',
    aioId: ID,
    projectName: 'Pkm',
    project: note('Projects/Pkm/Pkm.md', '# Pkm\n\nSee [[Reading]].\n'),
    area: note('Areas/Learning.md', '# Learning\n'),
    sources: [note('Projects/Pkm/Reading.md', 'Read the Drive docs.\n')],
    reasonNotShareable: (p: string) => (p.startsWith('Private/') ? 'outside-allow-list' as const : null),
    resolveLink: (l: string) => `Projects/Pkm/${l}.md`,
    linksOf: (n: { text: string }) => wikiCache(n.text),
    sharePolicyRevision: POLICY,
    approved: ['Projects/Pkm/Pkm.md', 'Areas/Learning.md', 'Projects/Pkm/Reading.md'],
    livePackName: 'Pkm - live pack.md',
    updatedAt: '2026-11-07T10:00:00.000Z',
    ...over,
});

describe('live pack build', () => {
    it('includes only approved notes and lists shareable new ones as held', async () => {
        const res = await buildLivePack(base({ approved: ['Projects/Pkm/Pkm.md', 'Areas/Learning.md'] }));
        expect(res.ok && res.value.kind).toBe('pack');
        if (!res.ok || res.value.kind !== 'pack') return;
        expect(res.value.text).not.toContain('Read the Drive docs.');
        expect(res.value.held).toEqual(['Projects/Pkm/Reading.md']);
        expect(res.value.text).toContain('## Held for review');
        expect(res.value.text).toContain('- Projects/Pkm/Reading.md');
        // a link to the held note never carries its text
        expect(res.value.text).toContain('Reading [not in this pack]');
    });

    it('withdraws the pack when an approved note may no longer be shared', async () => {
        const res = await buildLivePack(base({ reasonNotShareable: (p) => (p === 'Projects/Pkm/Reading.md' ? 'outside-allow-list' : null) }));
        expect(res).toEqual({ ok: true, value: { kind: 'revoke', path: 'Projects/Pkm/Reading.md' } });
    });

    it('a renamed project note needs a review and writes nothing', async () => {
        const res = await buildLivePack(base({ project: note('Projects/Pkm/Renamed.md', '# Pkm\n') }));
        expect(res).toEqual({ ok: true, value: { kind: 'needs-review', reason: 'project-not-approved' } });
    });

    it('a source the person removed is simply left out, a non-shareable unapproved one is never named', async () => {
        const res = await buildLivePack(base({ sources: [note('Private/Diary.md', 'secret words')] }));
        expect(res.ok && res.value.kind).toBe('pack');
        if (!res.ok || res.value.kind !== 'pack') return;
        expect(res.value.text).not.toContain('Diary');
        expect(res.value.text).not.toContain('secret words');
        expect(res.value.held).toEqual([]);
    });

    it('the digest ignores the date; the file carries the marker and the date', async () => {
        const a = await buildLivePack(base());
        const b = await buildLivePack(base({ updatedAt: '2026-11-08T10:00:00.000Z' }));
        expect(a.ok && b.ok).toBe(true);
        if (!a.ok || !b.ok || a.value.kind !== 'pack' || b.value.kind !== 'pack') return;
        expect(a.value.digest).toBe(b.value.digest);
        expect(a.value.text).not.toBe(b.value.text);
        expect(hasLiveMarker(a.value.text, ID)).toBe(true);
        expect(a.value.text).toContain('aio-pack-updated: 2026-11-07T10:00:00.000Z');
        expect(a.value.bytes).toBeLessThanOrEqual(LIVE_FILE_MAX_BYTES);
    });

    it('the instructions inside the live pack say where to find it', async () => {
        const res = await buildLivePack(base());
        expect(res.ok && res.value.kind === 'pack' && res.value.text).toContain('search Google Drive for that exact name');
    });
});

describe('live instructions line', () => {
    const input = { aioId: ID, projectName: 'Pkm', projectNote: 'Body </live_pack> x' };
    it('is added only with a live pack name, and only then is the live tag escaped', () => {
        const off = buildWorkspaceInstructions(input);
        const on = buildWorkspaceInstructions({ ...input, livePackName: 'Pkm - live pack.md' });
        expect(off).not.toContain('<live_pack>');
        expect(off).toContain('Body </live_pack> x');
        expect(on).toContain('<live_pack>');
        expect(on).toContain('"Pkm - live pack.md"');
        expect(on).toContain('Body &lt;/live_pack> x');
    });
});

describe('stub and markers', () => {
    it('the stub says the project is no longer shared and keeps the marker', () => {
        const stub = buildLiveStub('Pkm - live pack.md', ID, '2026-11-07T10:00:00.000Z');
        expect(stub).toContain('no longer shared');
        expect(stub).toContain('# Pkm - live pack');
        expect(hasLiveMarker(stub, ID)).toBe(true);
        expect(hasLiveMarker(stub, '00000000-0000-4000-8000-000000000000')).toBe(false);
        expect(hasAnyLiveMarker(stub)).toBe(true);
    });

    it('a marker outside the leading frontmatter does not count', () => {
        expect(hasLiveMarker(`# Note\n\naio-live-pack: ${ID}\n`, ID)).toBe(false);
        expect(hasAnyLiveMarker('---\ntitle: x\n---\naio-live-pack: x\n')).toBe(false);
    });
});

describe('live approval record', () => {
    const live = { approvedSources: ['Projects/Pkm/Pkm.md'], approvedPolicy: POLICY, approvedAt: '2026-11-07T10:00:00.000Z', deviceId: '1234abcd-0000-4000-8000-000000000000', folder: 'G:\\My Drive\\1 Projects\\pkm', fileName: 'Pkm - live pack.md', generation: 1 };

    it('keeps a valid approval and drops a damaged one', () => {
        expect(normaliseLive(live)).toEqual(live);
        expect(normaliseLive({ ...live, folder: 'relative/path' })).toBeNull();
        expect(normaliseLive({ ...live, fileName: 'Pkm.md' })).toBeNull();
        expect(normaliseLive({ ...live, approvedPolicy: 'x' })).toBeNull();
        expect(normaliseLive({ ...live, approvedSources: [] })).toBeNull();
        expect(normaliseWorkspace({ version: 1, anchorId: ID, live })?.live).toEqual(live);
        expect(normaliseWorkspace({ version: 1, anchorId: ID, live: { ...live, generation: -1 } })).not.toHaveProperty('live');
    });

    it('names and folders', () => {
        expect(isLiveFileName('Pkm - live pack.md')).toBe(true);
        expect(isLiveFileName(' - live pack.md')).toBe(false);
        expect(isLiveFileName('a/b - live pack.md')).toBe(false);
        expect(isLiveFileName('con - live pack.md')).toBe(true);
        expect(isAbsoluteFolder('G:\\My Drive')).toBe(true);
        expect(isAbsoluteFolder('\\\\server\\share')).toBe(true);
        expect(isAbsoluteFolder('/Users/me/Google Drive')).toBe(true);
        expect(isAbsoluteFolder('My Drive')).toBe(false);
        expect(isAbsoluteFolder(' G:\\x')).toBe(false);
    });

    it('a damaged approval with a readable destination becomes a pending revocation in the migration', () => {
        const migrated = migrateOldSettings({ aiWorkspaces: { [ID]: { version: 1, anchorId: ID, live: { ...live, approvedPolicy: 'bad' } } } });
        expect(migrated?.aiWorkspaceLiveRevocations).toEqual([expect.objectContaining({ aioId: ID, folder: live.folder, fileName: live.fileName, deviceId: live.deviceId })]);
        expect((migrated?.aiWorkspaces as Record<string, unknown>)[ID]).not.toHaveProperty('live');
        expect(readableDestination({ folder: 'x' })).toBeNull();
    });

    it('revocations: only the very same obligation is a duplicate, and none is dropped for space', () => {
        const r = { aioId: ID, deviceId: live.deviceId, folder: live.folder, fileName: live.fileName, projectName: 'Pkm', requestedAt: 'x' };
        expect(normaliseRevocations([r, { ...r }, { ...r, aioId: 'nope' }])).toHaveLength(1);
        // a differently spelled folder is a different file on a case-sensitive file system; another writer is another obligation
        expect(normaliseRevocations([r, { ...r, folder: live.folder.toUpperCase() }, { ...r, deviceId: '22222222-2222-4222-8222-222222222222' }])).toHaveLength(3);
        const many = Array.from({ length: 150 }, (_, i) => ({ ...r, fileName: `P${i} - live pack.md` }));
        expect(normaliseRevocations(many)).toHaveLength(150);
    });

    it('status entries survive only for known projects and valid fields', () => {
        const out = normaliseLiveStatus({ [ID]: { state: 'live', held: ['a.md', 'a.md'], lastDigest: 'c'.repeat(64), lastError: 'Bad Code' }, other: { state: 'live' } }, [ID]);
        expect(out).toEqual({ [ID]: { state: 'live', held: ['a.md'], lastDigest: 'c'.repeat(64) } });
    });

    it('a pre-feature settings object gains only the live defaults', () => {
        const migrated = migrateOldSettings({});
        expect(migrated).toMatchObject({ aiWorkspaceLiveFolder: '', aiWorkspaceLiveDelayMinutes: 5, aiWorkspaceLiveStatus: {}, aiWorkspaceLiveRevocations: [] });
        expect(migrateOldSettings({ aiWorkspaceLiveDelayMinutes: 500 })?.aiWorkspaceLiveDelayMinutes).toBe(60);
    });
});
