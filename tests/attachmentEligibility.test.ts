import { describe, it, expect } from 'vitest';
import {
	computeEligibility,
	eligibilityFromScan,
	revalidate,
	ChangeLog,
	EMPTY_CHANGES,
	type AttachmentVaultPort,
	type FileIdentity,
	type ReferrerInfo,
	type EligibilityInput,
} from '../src/services/attachmentEligibility';
import { buildCandidateIndex, type StoredOccurrence } from '../src/services/embedScanService';

const id = (path: string, size = 100, mtime = 500): FileIdentity => ({ path, size, mtime });

describe('computeEligibility', () => {
	const base: EligibilityInput = { scanned: id('a.pdf'), current: id('a.pdf'), referenceCount: 0, ambiguous: false, coverageFailures: [], protectedFolders: [] };

	it('is eligible with no references, no ambiguity, no failures and an unchanged file', () => {
		expect(computeEligibility(base)).toEqual({ eligible: true, reasons: [], referenceCount: 0 });
	});

	it('blocks on each reason independently', () => {
		const cases: Array<[Partial<EligibilityInput>, string]> = [
			[{ referenceCount: 2 }, 'still-referenced'],
			[{ ambiguous: true }, 'ambiguous-reference'],
			[{ coverageFailures: [{ path: 'c.canvas', kind: 'canvas-unreadable' }] }, 'canvas-unreadable'],
			[{ coverageFailures: [{ path: 'n.md', kind: 'markdown-unreadable' }] }, 'scan-incomplete'],
			[{ current: id('a.pdf', 999) }, 'file-changed'],
			[{ current: id('a.pdf', 100, 501) }, 'file-changed'],
			[{ current: null }, 'target-missing'],
			[{ protectedFolders: ['Docs'], scanned: id('Docs/a.pdf'), current: id('Docs/a.pdf') }, 'protected-path'],
		];
		for (const [over, reason] of cases) {
			const res = computeEligibility({ ...base, ...over });
			expect(res.eligible, reason).toBe(false);
			expect(res.reasons, reason).toContain(reason);
		}
	});

	it('collects several reasons at once', () => {
		const res = computeEligibility({ ...base, referenceCount: 1, ambiguous: true });
		expect(res.reasons).toEqual(['still-referenced', 'ambiguous-reference']);
		expect(res.referenceCount).toBe(1);
	});

	it('eligibilityFromScan treats the scanned file as current', () => {
		expect(eligibilityFromScan(id('a.pdf'), 0, false, [], []).eligible).toBe(true);
		expect(eligibilityFromScan(id('a.pdf'), 3, false, [], []).reasons).toEqual(['still-referenced']);
	});
});

// ---- revalidation against a fake port -------------------------------------

interface FakeVault {
	notes: Record<string, { text: string; mtime: number; ext?: 'md' | 'canvas' }>;
	files: Record<string, FileIdentity>;
	resolved?: boolean;
	becomesResolved?: boolean;
}

function makePort(v: FakeVault): AttachmentVaultPort {
	const allPaths = [...Object.keys(v.notes), ...Object.keys(v.files)];
	const candidates = buildCandidateIndex(allPaths);
	return {
		isResolved: () => v.resolved !== false,
		waitResolved: async () => v.becomesResolved === true,
		listReferrers: (): ReferrerInfo[] =>
			Object.entries(v.notes).map(([path, n]) => ({ path, extension: n.ext ?? 'md', mtime: n.mtime })),
		readText: async (path) => (v.notes[path] ? v.notes[path].text : null),
		resolveLink: (linktext, sourcePath) => {
			// relative to the referrer's folder first, then anywhere by tail
			const dir = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1) : '';
			if (v.files[dir + linktext]) return dir + linktext;
			if (v.files[linktext]) return linktext;
			return candidates(linktext).find((p) => v.files[p]) ?? null;
		},
		candidatesFor: (l) => candidates(l),
		identity: (path) => v.files[path] ?? null,
	};
}

const occ = (referrerPath: string, linktext: string, kind: 'markdown' | 'canvas' = 'markdown'): StoredOccurrence => ({ referrerPath, kind, linktext, lineNumber: 1 });

describe('revalidate', () => {
	const scanned = id('Docs/a.pdf');

	it('fails closed when the link index is not ready and does not become ready', async () => {
		const port = makePort({ notes: {}, files: { 'Docs/a.pdf': scanned }, resolved: false });
		const res = await revalidate(port, { files: [scanned], scanStartedAt: 1000, occurrences: [], changes: EMPTY_CHANGES, protectedFolders: [], waitMs: 1 });
		expect(res).toEqual({ ok: false, error: 'metadata-not-ready' });
	});

	it('proceeds when the index settles within the wait', async () => {
		const port = makePort({ notes: {}, files: { 'Docs/a.pdf': scanned }, resolved: false, becomesResolved: true });
		const res = await revalidate(port, { files: [scanned], scanStartedAt: 1000, occurrences: [], changes: EMPTY_CHANGES, protectedFolders: [], waitMs: 1 });
		expect(res.ok).toBe(true);
	});

	it('keeps a file eligible when nothing references it', async () => {
		const port = makePort({ notes: { 'n.md': { text: 'hello', mtime: 500 } }, files: { 'Docs/a.pdf': scanned } });
		const res = await revalidate(port, { files: [scanned], scanStartedAt: 1000, occurrences: [], changes: EMPTY_CHANGES, protectedFolders: [] });
		expect(res.ok && res.value.get('Docs/a.pdf')?.eligible).toBe(true);
	});

	it('catches a reference added after the scan started (newer mtime) even with no event', async () => {
		const port = makePort({
			notes: { 'n.md': { text: 'now links ![[a.pdf]]', mtime: 2000 } },
			files: { 'Docs/a.pdf': scanned },
		});
		const res = await revalidate(port, { files: [scanned], scanStartedAt: 1000, occurrences: [], changes: EMPTY_CHANGES, protectedFolders: [] });
		const e = res.ok ? res.value.get('Docs/a.pdf') : null;
		expect(e?.eligible).toBe(false);
		expect(e?.reasons).toContain('still-referenced');
	});

	it('catches a reference in a note that was created or renamed since (event-recorded, old mtime)', async () => {
		const port = makePort({
			notes: { 'moved.md': { text: '![[a.pdf]]', mtime: 100 } },
			files: { 'Docs/a.pdf': scanned },
		});
		const changes = new ChangeLog();
		changes.recordRename('old.md', 'moved.md');
		const res = await revalidate(port, { files: [scanned], scanStartedAt: 1000, occurrences: [], changes: changes.snapshot(), protectedFolders: [] });
		expect(res.ok && res.value.get('Docs/a.pdf')?.reasons).toContain('still-referenced');
	});

	it('re-resolves stored occurrences against the referrer current path (a moved folder re-targets a relative link)', async () => {
		// At scan time 'Inbox/n.md' linked "a.pdf" and it resolved to some OTHER file, so a.pdf looked unreferenced.
		// The note then moved next to Docs/a.pdf WITHOUT its mtime changing and without a recorded event.
		const port = makePort({
			notes: { 'Docs/n.md': { text: '![[a.pdf]]', mtime: 100 } },
			files: { 'Docs/a.pdf': scanned },
		});
		const stored = [occ('Docs/n.md', 'a.pdf')];
		const res = await revalidate(port, { files: [scanned], scanStartedAt: 1000, occurrences: stored, changes: EMPTY_CHANGES, protectedFolders: [] });
		expect(res.ok && res.value.get('Docs/a.pdf')?.reasons).toContain('still-referenced');
	});

	it('drops stored occurrences whose referrer no longer exists', async () => {
		const port = makePort({ notes: {}, files: { 'Docs/a.pdf': scanned } });
		const res = await revalidate(port, { files: [scanned], scanStartedAt: 1000, occurrences: [occ('gone.md', 'a.pdf')], changes: EMPTY_CHANGES, protectedFolders: [] });
		expect(res.ok && res.value.get('Docs/a.pdf')?.eligible).toBe(true);
	});

	it('blocks everything when a referrer is unreadable now', async () => {
		const port = makePort({ notes: { 'n.md': { text: '', mtime: 5000 } }, files: { 'Docs/a.pdf': scanned } });
		const broken = { ...port, readText: async () => null } as AttachmentVaultPort;
		const res = await revalidate(broken, { files: [scanned], scanStartedAt: 1000, occurrences: [], changes: EMPTY_CHANGES, protectedFolders: [] });
		expect(res.ok && res.value.get('Docs/a.pdf')?.reasons).toContain('scan-incomplete');
	});

	it('retries referrers the scan could not read, and blocks on an unparseable canvas', async () => {
		const port = makePort({ notes: { 'Board.canvas': { text: '{oops', mtime: 100, ext: 'canvas' } }, files: { 'Docs/a.pdf': scanned } });
		const res = await revalidate(port, {
			files: [scanned], scanStartedAt: 1000, occurrences: [], changes: EMPTY_CHANGES, protectedFolders: [],
			priorFailures: [{ path: 'Board.canvas', kind: 'canvas-unreadable' }],
		});
		expect(res.ok && res.value.get('Docs/a.pdf')?.reasons).toContain('canvas-unreadable');
	});

	it('finds a canvas file node by its vault path', async () => {
		const text = JSON.stringify({ nodes: [{ id: 'n', type: 'file', file: 'Docs/a.pdf' }] });
		const port = makePort({ notes: { 'Board.canvas': { text, mtime: 5000, ext: 'canvas' } }, files: { 'Docs/a.pdf': scanned } });
		const res = await revalidate(port, { files: [scanned], scanStartedAt: 1000, occurrences: [], changes: EMPTY_CHANGES, protectedFolders: [] });
		expect(res.ok && res.value.get('Docs/a.pdf')?.reasons).toContain('still-referenced');
	});

	it('treats same-named files as ambiguous and blocks them all', async () => {
		const a = id('A/scan.pdf');
		const b = id('B/scan.pdf');
		const port = makePort({ notes: { 'n.md': { text: '![[scan.pdf]]', mtime: 5000 } }, files: { 'A/scan.pdf': a, 'B/scan.pdf': b } });
		const res = await revalidate(port, { files: [a, b], scanStartedAt: 1000, occurrences: [], changes: EMPTY_CHANGES, protectedFolders: [] });
		expect(res.ok && res.value.get('A/scan.pdf')?.reasons).toContain('ambiguous-reference');
		expect(res.ok && res.value.get('B/scan.pdf')?.reasons).toContain('ambiguous-reference');
	});

	it('flags a file that changed or vanished since the scan, and a protected one', async () => {
		const port = makePort({ notes: {}, files: { 'Docs/a.pdf': id('Docs/a.pdf', 100, 999) } });
		const res = await revalidate(port, { files: [scanned, id('Docs/gone.pdf')], scanStartedAt: 1000, occurrences: [], changes: EMPTY_CHANGES, protectedFolders: ['Docs'] });
		const a = res.ok ? res.value.get('Docs/a.pdf') : null;
		expect(a?.reasons).toEqual(expect.arrayContaining(['file-changed', 'protected-path']));
		expect(res.ok && res.value.get('Docs/gone.pdf')?.reasons).toContain('target-missing');
	});
});

describe('ChangeLog', () => {
	it('records a rename as a new path and a deleted old path', () => {
		const log = new ChangeLog();
		expect(log.isEmpty).toBe(true);
		log.recordRename('a.md', 'b.md');
		log.recordCreate('c.md');
		log.recordModify('d.md');
		log.recordDelete('e.md');
		const snap = log.snapshot();
		expect([...snap.renamed]).toEqual(['b.md']);
		expect([...snap.deleted].sort()).toEqual(['a.md', 'e.md']);
		expect(log.isEmpty).toBe(false);
	});
});
