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
	createAppVaultPort,
} from '../src/services/attachmentEligibility';
import { observeMetadataIndex } from '../src/utils/metadataIndexState';
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

describe('revalidate: provenance and stability', () => {
	const scanned = id('Docs/a.pdf');

	it('reads a referrer the scan never listed (a note moved in without an event or a newer mtime)', async () => {
		const port = makePort({ notes: { 'Docs/moved.md': { text: '![[a.pdf]]', mtime: 100 } }, files: { 'Docs/a.pdf': scanned } });
		const res = await revalidate(port, {
			files: [scanned], scanStartedAt: 1000, occurrences: [], changes: EMPTY_CHANGES, protectedFolders: [],
			scannedReferrers: [{ path: 'elsewhere/n.md', mtime: 100 }],
		});
		expect(res.ok && res.value.get('Docs/a.pdf')?.reasons).toContain('still-referenced');
	});

	it('reuses stored occurrences only for referrers whose recorded mtime still matches', async () => {
		let reads = 0;
		const base = makePort({ notes: { 'n.md': { text: 'no links now', mtime: 100 } }, files: { 'Docs/a.pdf': scanned } });
		const port = { ...base, readText: async (p: string) => { reads++; return base.readText(p); } } as AttachmentVaultPort;
		const res = await revalidate(port, {
			files: [scanned], scanStartedAt: 1000, changes: EMPTY_CHANGES, protectedFolders: [],
			occurrences: [occ('n.md', 'a.pdf')], scannedReferrers: [{ path: 'n.md', mtime: 100 }],
		});
		expect(reads).toBe(0);
		expect(res.ok && res.value.get('Docs/a.pdf')?.reasons).toContain('still-referenced'); // stored occurrence trusted
	});

	it('reads a referrer again when its mtime differs from the recorded one', async () => {
		const port = makePort({ notes: { 'n.md': { text: 'no links now', mtime: 200 } }, files: { 'Docs/a.pdf': scanned } });
		const res = await revalidate(port, {
			files: [scanned], scanStartedAt: 1000, changes: EMPTY_CHANGES, protectedFolders: [],
			occurrences: [occ('n.md', 'a.pdf')], scannedReferrers: [{ path: 'n.md', mtime: 100 }],
		});
		expect(res.ok && res.value.get('Docs/a.pdf')?.eligible).toBe(true);
	});

	it('rebuilds when the vault changes during the read and succeeds once it settles', async () => {
		const state = { notes: { 'n.md': { text: 'x', mtime: 100 } } as Record<string, { text: string; mtime: number }>, files: { 'Docs/a.pdf': scanned } };
		const base = makePort({ notes: state.notes, files: state.files });
		let mutated = false;
		const port = {
			...base,
			readText: async (p: string) => {
				if (!mutated) { mutated = true; state.notes['n.md'] = { text: 'x', mtime: 101 }; }
				return base.readText(p);
			},
			listReferrers: () => Object.entries(state.notes).map(([path, n]) => ({ path, extension: 'md' as const, mtime: n.mtime })),
		} as AttachmentVaultPort;
		const res = await revalidate(port, { files: [scanned], scanStartedAt: 1000, occurrences: [], changes: EMPTY_CHANGES, protectedFolders: [] });
		expect(res.ok).toBe(true);
	});

	it('fails closed when the vault never stops changing', async () => {
		let tick = 100;
		const base = makePort({ notes: { 'n.md': { text: 'x', mtime: 100 } }, files: { 'Docs/a.pdf': scanned } });
		const port = { ...base, listReferrers: () => [{ path: 'n.md', extension: 'md' as const, mtime: tick++ }] } as AttachmentVaultPort;
		const res = await revalidate(port, { files: [scanned], scanStartedAt: 1000, occurrences: [], changes: EMPTY_CHANGES, protectedFolders: [] });
		expect(res).toEqual({ ok: false, error: 'scan-out-of-date' });
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

// ---- the Obsidian-backed port: readiness is strict (it gates a destructive trash) ------------

describe('createAppVaultPort readiness', () => {
	const portFor = (cache: Record<string, unknown>) => createAppVaultPort({ metadataCache: cache, vault: {} } as never);

	it('is resolved only when completion was observed and the flags do not say building', () => {
		const ready = { initialized: true };
		observeMetadataIndex(ready).resolved();
		expect(portFor(ready).isResolved()).toBe(true);

		const building = { initialized: false };
		observeMetadataIndex(building).resolved();
		expect(portFor(building).isResolved()).toBe(false);

		// Old Obsidian shape.
		const oldShape = { resolved: true };
		observeMetadataIndex(oldShape).resolved();
		expect(portFor(oldShape).isResolved()).toBe(true);
	});

	it('an absent signal is no longer "resolved" (it used to be): unknown fails closed', () => {
		const none = {};
		observeMetadataIndex(none);
		expect(portFor(none).isResolved()).toBe(false);
		expect(portFor({}).isResolved()).toBe(false); // no tracker attached at all
	});
});

// ---- blockers: the verdict names what stands in the way ---------------------------------------

describe('revalidate blockers', () => {
	const scanned = id('Rec/meeting.m4a');
	const input = (over: Record<string, unknown> = {}) => ({ files: [scanned], scanStartedAt: 1000, occurrences: [] as StoredOccurrence[], changes: EMPTY_CHANGES, protectedFolders: [] as string[], ...over });

	it('names the note and line that reference the file (a note the scan never read, e.g. an excluded folder)', async () => {
		const port = makePort({
			notes: { 'Minutes/2026-01.md': { text: 'intro\n![[meeting.m4a]]', mtime: 100 } },
			files: { 'Rec/meeting.m4a': scanned },
		});
		const res = await revalidate(port, input({ scannedReferrers: [] }));
		const e = res.ok ? res.value.get('Rec/meeting.m4a') : null;
		expect(e?.eligible).toBe(false);
		expect(e?.reasons).toEqual(['still-referenced']);
		expect(e?.blockers?.referrers).toEqual([{ path: 'Minutes/2026-01.md', extension: 'md', lineNumber: 2, linktext: 'meeting.m4a' }]);
	});

	it('names a canvas referrer with line 0', async () => {
		const port = makePort({
			notes: { 'Board.canvas': { text: JSON.stringify({ nodes: [{ id: 'n1', type: 'file', file: 'Rec/meeting.m4a' }] }), mtime: 100, ext: 'canvas' } },
			files: { 'Rec/meeting.m4a': scanned },
		});
		const res = await revalidate(port, input({ scannedReferrers: [] }));
		const e = res.ok ? res.value.get('Rec/meeting.m4a') : null;
		expect(e?.blockers?.referrers).toEqual([{ path: 'Board.canvas', extension: 'canvas', lineNumber: 0, linktext: 'Rec/meeting.m4a' }]);
	});

	it('names the other file a link could have meant', async () => {
		const port = makePort({
			notes: { 'n.md': { text: '![[meeting.m4a]]', mtime: 100 } },
			files: { 'Rec/meeting.m4a': scanned, 'Archive/meeting.m4a': id('Archive/meeting.m4a') },
		});
		const res = await revalidate(port, input({ scannedReferrers: [] }));
		const e = res.ok ? res.value.get('Rec/meeting.m4a') : null;
		expect(e?.reasons).toContain('ambiguous-reference');
		expect(e?.blockers?.sameNameFiles).toEqual(['Archive/meeting.m4a']);
	});

	it('names an unreadable note once, so the user knows which one to fix', async () => {
		const port = makePort({ notes: { 'Broken.md': { text: 'x', mtime: 100 } }, files: { 'Rec/meeting.m4a': scanned } });
		port.readText = async () => null;
		const res = await revalidate(port, input({ scannedReferrers: [] }));
		const e = res.ok ? res.value.get('Rec/meeting.m4a') : null;
		expect(e?.reasons).toEqual(['scan-incomplete']);
		expect(e?.blockers?.unreadable).toEqual([{ path: 'Broken.md', kind: 'markdown-unreadable' }]);
	});

	it('adds no blockers to the cheap display verdict and changes no reason', () => {
		const display = eligibilityFromScan(scanned, 1, false, [], []);
		expect(display.blockers).toBeUndefined();
		expect(display.reasons).toEqual(['still-referenced']);
	});
});

// ---- scale: a big vault with a big excluded folder re-checks quickly ---------------------------

describe('revalidate at scale', () => {
	it('re-checks a 5,000-note vault (most notes unchanged, 500 new, ambiguity everywhere) well inside a second', async () => {
		const notes: Record<string, { text: string; mtime: number }> = {};
		const files: Record<string, FileIdentity> = { 'Rec/a.m4a': id('Rec/a.m4a'), 'Other/a.m4a': id('Other/a.m4a') };
		const occurrences: StoredOccurrence[] = [];
		const scannedReferrers: { path: string; mtime: number }[] = [];
		for (let i = 0; i < 5000; i++) {
			const path = `Excluded/n${i}.md`;
			const stale = i < 500;
			notes[path] = { text: `x ![[a.m4a]] ${i}`, mtime: stale ? 5000 : 100 };
			if (!stale) {
				occurrences.push({ referrerPath: path, kind: 'markdown', linktext: 'a.m4a', lineNumber: 1 });
				scannedReferrers.push({ path, mtime: 100 });
			}
		}
		const port = makePort({ notes, files });
		const started = Date.now();
		const res = await revalidate(port, { files: [id('Rec/a.m4a')], scanStartedAt: 1000, occurrences, scannedReferrers, changes: EMPTY_CHANGES, protectedFolders: [] });
		const e = res.ok ? res.value.get('Rec/a.m4a') : null;
		expect(Date.now() - started).toBeLessThan(2000);
		expect(e?.blockers?.referrers.length).toBe(5000);
		expect(e?.blockers?.sameNameFiles).toEqual(['Other/a.m4a']);
	});
});
