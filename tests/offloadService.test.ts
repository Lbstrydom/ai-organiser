import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
	abortOffload,
	advanceOffload,
	approveRewrite,
	continueOffload,
	prepareRewrite,
	startOffload,
	type OffloadDeps,
	type RemoteListFile,
} from '../src/services/offload/offloadService';
import { JournalStore, newRecord, type OffloadRecord } from '../src/services/offload/offloadJournal';
import { buildCopyPlan, textHash } from '../src/services/offload/offloadPlan';
import { findOccurrences, type ScanTarget } from '../src/services/offload/referenceOccurrences';
import { streamFingerprinter, type NodeDeps } from '../src/services/offload/fingerprint';
import { ok, err, type Result } from '../src/core/result';
import { transformCanvas } from '../src/services/canvas/canvasWritePort';

const node = { fs, path, crypto } as unknown as NodeDeps;
const sha = (d: Buffer | string) => crypto.createHash('sha256').update(d).digest('hex');
const DRIVE = 'DriveFolder_01';
const DATA = Buffer.from('pdf-bytes-'.repeat(1000));
const SRC = 'Projects/Big.pdf';

const TARGET: ScanTarget = { path: SRC, name: 'Big.pdf', resolve: (l) => (l.toLowerCase().endsWith('big.pdf') ? SRC : null) };
const NOTE = 'see ![[Big.pdf]] and [[Big.pdf|the report]]';
const CANVAS = JSON.stringify({ nodes: [{ id: 'n1', type: 'file', file: SRC, x: 0, y: 0, width: 10, height: 10 }], edges: [] });

interface Harness {
	deps: OffloadDeps;
	vault: Map<string, string>;
	present: Set<string>;
	drive: RemoteListFile[];
	store: JournalStore;
	trashed: string[];
	state: { remaining: number; coverage: number; events: number; failWrite: string | null };
	listCalls: { n: number };
	record: OffloadRecord;
	mount: string;
	srcAbs: string;
}

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-svc-')); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function setup(over: { sourceData?: Buffer } = {}): Promise<Harness> {
	const base = path.join(tmp, 'vault');
	const mount = path.join(tmp, 'drive');
	fs.mkdirSync(path.join(base, 'Projects'), { recursive: true });
	fs.mkdirSync(mount, { recursive: true });
	const srcAbs = path.join(base, 'Projects', 'Big.pdf');
	fs.writeFileSync(srcAbs, over.sourceData ?? DATA);

	const vault = new Map<string, string>([['Notes/a.md', NOTE], ['Boards/b.canvas', CANVAS]]);
	const present = new Set<string>([SRC, ...vault.keys()]);
	const drive: RemoteListFile[] = [];
	const trashed: string[] = [];
	const state = { remaining: 0, coverage: 0, events: 0, failWrite: null as string | null };
	const listCalls = { n: 0 };

	const files = new Map<string, string>();
	const store = new JournalStore({
		exists: async (p: string) => files.has(p),
		read: async (p: string) => files.get(p)!,
		write: async (p: string, d: string) => { files.set(p, d); },
		rename: async (a: string, b: string) => { files.set(b, files.get(a)!); files.delete(a); },
		remove: async (p: string) => { files.delete(p); },
	} as never, 'plugin/offload-journal.json');

	const deps: OffloadDeps = {
		now: () => '2026-01-01T00:00:00Z',
		node,
		fingerprint: streamFingerprinter(node),
		store,
		vaultBasePath: base,
		protectedFolders: () => [],
		mountRoot: (id) => (id === 'p1' ? mount : undefined),
		readText: async (p) => vault.get(p) ?? null,
		exists: (p) => present.has(p),
		writeMarkdown: async (p, baseline, next) => {
			if (state.failWrite === p) return err('write-failed');
			if (vault.get(p) !== baseline) return err('baseline-changed');
			vault.set(p, next);
			return ok(undefined);
		},
		writeCanvas: async (p, nodeIds, url, baseline) => {
			if (vault.get(p) !== baseline) return err('referrer-changed');
			const next = transformCanvas(baseline, nodeIds.map((nodeId) => ({ nodeId, url })));
			if (!next.ok) return err(next.error);
			vault.set(p, next.value);
			return ok(undefined);
		},
		trash: async (p) => { present.delete(p); trashed.push(p); fs.rmSync(srcAbs, { force: true }); return ok(undefined); },
		listFolder: async (): Promise<Result<RemoteListFile[]>> => { listCalls.n++; return ok([...drive]); },
		scanReferences: async () => ok({ remaining: state.remaining, coverageFailures: state.coverage }),
		watch: () => ({ stop: () => { const e = state.events; state.events = 0; return e; } }),
	};

	const occ = (p: string, text: string, kind: 'md' | 'canvas') => {
		const r = findOccurrences(p, text, kind, TARGET);
		if (!r.ok) throw new Error(r.error);
		return { path: p, kind, text, occurrences: r.value };
	};
	const plan = await buildCopyPlan({
		opId: 'op1',
		now: 'T',
		source: { path: SRC, size: DATA.length, mtimeMs: 0, sha256: sha(over.sourceData ?? DATA) },
		pair: { id: 'p1', vaultFolder: 'Projects', driveFolderId: DRIVE, placement: 'beside', localMountFolder: mount },
		referrers: [occ('Notes/a.md', NOTE, 'md'), occ('Boards/b.canvas', CANVAS, 'canvas')],
		protectedFolders: [],
	});
	if (!plan.ok) throw new Error(plan.error);
	const record = newRecord(plan.value, 'T');
	await startOffload(deps, record);
	return { deps, vault, present, drive, store, trashed, state, listCalls, record, mount, srcAbs };
}

const syncToDrive = (h: Harness): void => {
	h.drive.push({ id: 'RemoteId_1', name: 'Big.pdf', size: DATA.length, sha256Checksum: sha(DATA) });
};

/** Run to the rewrite approval and approve it. */
async function toApproved(h: Harness): Promise<OffloadRecord> {
	syncToDrive(h);
	const adv = await advanceOffload(h.deps, h.record);
	expect(adv.waiting).toBe('rewrite-approval');
	const prep = await prepareRewrite(h.deps, adv.record);
	if (!prep.ok) throw new Error(prep.error);
	const approved = await approveRewrite(h.deps, adv.record, prep.value.plan, prep.value.changed);
	if (!approved.ok) throw new Error(approved.error);
	return approved.value;
}

describe('offload flow', () => {
	it('copies, waits for Drive to sync, rewrites every reference, passes the barrier and trashes', async () => {
		const h = await setup();
		// Drive has not synced yet: the copy exists locally, the operation waits and nothing else happens.
		const early = await advanceOffload(h.deps, h.record);
		expect(early).toMatchObject({ waiting: 'drive-sync', record: { step: 'copied', blocked: 'drive-not-synced' } });
		expect(fs.readFileSync(path.join(h.mount, 'Big.pdf')).equals(DATA)).toBe(true);
		expect(h.vault.get('Notes/a.md')).toBe(NOTE);

		// Resume after it synced.
		syncToDrive(h);
		const adv = await advanceOffload(h.deps, early.record);
		expect(adv).toMatchObject({ waiting: 'rewrite-approval', record: { step: 'remote-captured', remote: { id: 'RemoteId_1' } } });
		expect(h.vault.get('Notes/a.md')).toBe(NOTE); // nothing rewritten before the second approval

		const prep = await prepareRewrite(h.deps, adv.record);
		if (!prep.ok) throw new Error(prep.error);
		expect(prep.value.plan.items.map((i) => i.path).sort()).toEqual(['Boards/b.canvas', 'Notes/a.md']);
		const approved = await approveRewrite(h.deps, adv.record, prep.value.plan, prep.value.changed);
		if (!approved.ok) throw new Error(approved.error);

		const done = await continueOffload(h.deps, approved.value);
		expect(done).toMatchObject({ waiting: 'done', record: { step: 'done' } });
		expect(h.vault.get('Notes/a.md')).toContain('https://drive.google.com/file/d/RemoteId_1/view');
		expect(h.vault.get('Notes/a.md')).not.toContain('![[Big.pdf]]');
		expect(JSON.parse(h.vault.get('Boards/b.canvas')!).nodes[0]).toMatchObject({ id: 'n1', type: 'link' });
		expect(h.trashed).toEqual([SRC]);
		const saved = await h.store.load();
		expect(saved.ok && saved.value[0].step).toBe('done');
	});

	it('holds the copy when the source changed after the plan was approved', async () => {
		const h = await setup();
		fs.writeFileSync(h.srcAbs, Buffer.from('edited after planning'));
		const out = await advanceOffload(h.deps, h.record);
		expect(out).toMatchObject({ waiting: 'blocked', record: { step: 'planned', blocked: 'file-changed' } });
		expect(fs.readdirSync(h.mount)).toEqual([]);
	});

	it('stops with a conflict when Drive lists the file twice', async () => {
		const h = await setup();
		syncToDrive(h);
		syncToDrive(h);
		const out = await advanceOffload(h.deps, h.record);
		expect(out).toMatchObject({ waiting: 'blocked', record: { step: 'copied', blocked: 'remote-ambiguous' } });
	});

	it('does not accept a Drive file whose checksum differs', async () => {
		const h = await setup();
		h.drive.push({ id: 'x', name: 'Big.pdf', size: DATA.length, sha256Checksum: sha('other') });
		expect((await advanceOffload(h.deps, h.record)).waiting).toBe('drive-sync');
	});
});

describe('rewrite and recovery', () => {
	it('skips a referrer edited after the plan and then refuses to trash', async () => {
		const h = await setup();
		syncToDrive(h);
		const adv = await advanceOffload(h.deps, h.record);
		h.vault.set('Notes/a.md', NOTE + ' (edited)');
		const prep = await prepareRewrite(h.deps, adv.record);
		if (!prep.ok) throw new Error(prep.error);
		expect(prep.value.changed).toEqual(['Notes/a.md']);
		const approved = await approveRewrite(h.deps, adv.record, prep.value.plan, prep.value.changed);
		if (!approved.ok) throw new Error(approved.error);
		const out = await continueOffload(h.deps, approved.value);
		expect(out.record.step).toBe('verified');
		expect(out.record.blocked).toBe('barrier-referrer-not-done');
		expect(h.trashed).toEqual([]);
		expect(h.present.has(SRC)).toBe(true);
		expect(h.vault.get('Notes/a.md')).toBe(NOTE + ' (edited)'); // the newer edit is never overwritten
	});

	it('marks a referrer changed between approval and write as a conflict and stops', async () => {
		const h = await setup();
		const approved = await toApproved(h);
		h.vault.set('Notes/a.md', NOTE + ' typed after approval');
		const out = await continueOffload(h.deps, approved);
		expect(out).toMatchObject({ waiting: 'blocked', record: { step: 'rewriting', blocked: 'referrer-conflict', referrers: { 'Notes/a.md': 'conflict', 'Boards/b.canvas': 'done' } } });
		expect(h.trashed).toEqual([]);
	});

	it('resumes after a crash: a referrer that already has its after-text counts as done', async () => {
		const h = await setup();
		const approved = await toApproved(h);
		// Simulate: the note was rewritten, then the process died before the journal recorded it.
		const item = approved.rewrite!.items.find((i) => i.path === 'Notes/a.md')!;
		const after = item.edits.reduceRight((t, e) => t.slice(0, e.start) + e.text + t.slice(e.end), NOTE);
		expect(await textHash(after)).toBe(item.expectedAfterHash);
		h.vault.set('Notes/a.md', after);
		const out = await continueOffload(h.deps, approved);
		expect(out).toMatchObject({ waiting: 'done', record: { step: 'done' } });
		expect(h.trashed).toEqual([SRC]);
	});

	it('a failed write is a conflict, not a silent success', async () => {
		const h = await setup();
		const approved = await toApproved(h);
		h.state.failWrite = 'Notes/a.md';
		const out = await continueOffload(h.deps, approved);
		expect(out.record.referrers['Notes/a.md']).toBe('conflict');
		expect(h.vault.get('Notes/a.md')).toBe(NOTE);
		expect(h.trashed).toEqual([]);
	});
});

describe('commit barrier in the flow', () => {
	it('does not trash while a reference remains', async () => {
		const h = await setup();
		const approved = await toApproved(h);
		h.state.remaining = 1;
		const out = await continueOffload(h.deps, approved);
		expect(out.record).toMatchObject({ step: 'verified', blocked: 'barrier-still-referenced' });
		expect(h.trashed).toEqual([]);
		// Fixed by the user: resume and it completes.
		h.state.remaining = 0;
		expect((await continueOffload(h.deps, out.record)).waiting).toBe('done');
		expect(h.trashed).toEqual([SRC]);
	});

	it('does not trash after a scan coverage failure', async () => {
		const h = await setup();
		const approved = await toApproved(h);
		h.state.coverage = 1;
		expect((await continueOffload(h.deps, approved)).record.blocked).toBe('barrier-scan-incomplete');
		expect(h.trashed).toEqual([]);
	});

	it('does not trash when the Drive copy disappears before the end', async () => {
		const h = await setup();
		const approved = await toApproved(h);
		h.drive.length = 0;
		expect((await continueOffload(h.deps, approved)).record.blocked).toBe('barrier-remote-mismatch');
		expect(h.trashed).toEqual([]);
	});

	it('does not trash when the source changed after the copy', async () => {
		const h = await setup();
		const approved = await toApproved(h);
		fs.writeFileSync(h.srcAbs, Buffer.from('changed'));
		expect((await continueOffload(h.deps, approved)).record.blocked).toBe('barrier-source-changed');
		expect(h.trashed).toEqual([]);
	});

	it('re-runs the check after a vault event, and gives up if the vault keeps changing', async () => {
		const h = await setup();
		const approved = await toApproved(h);
		let calls = 0;
		h.deps.watch = () => ({ stop: () => (++calls === 1 ? 1 : 0) });
		expect((await continueOffload(h.deps, approved)).waiting).toBe('done');
		expect(calls).toBe(2);

		// A vault that never settles: the check gives up and nothing is trashed.
		const h2 = await setup();
		const approved2 = await toApproved(h2);
		h2.deps.watch = () => ({ stop: () => 1 });
		expect((await continueOffload(h2.deps, approved2)).record.blocked).toBe('barrier-vault-changed');
		expect(h2.trashed).toEqual([]);
	});

	it('refuses to trash a protected source', async () => {
		const h = await setup();
		const approved = await toApproved(h);
		h.deps.protectedFolders = () => ['Projects'];
		expect((await continueOffload(h.deps, approved)).record.blocked).toBe('barrier-protected');
		expect(h.trashed).toEqual([]);
	});

	it('completes the trash step when the source is already gone after trash-pending was recorded', async () => {
		const h = await setup();
		const approved = await toApproved(h);
		const verified = await continueOffload({ ...h.deps, scanReferences: async () => ok({ remaining: 1, coverageFailures: 0 }) }, approved);
		expect(verified.record.step).toBe('verified');
		const pending: OffloadRecord = { ...verified.record, step: 'trash-pending', blocked: undefined };
		h.present.delete(SRC);
		const out = await continueOffload(h.deps, pending);
		expect(out).toMatchObject({ waiting: 'done', record: { step: 'done' } });
		expect(h.trashed).toEqual([]);
	});

	it('fails when the source disappears before trash-pending', async () => {
		const h = await setup();
		const approved = await toApproved(h);
		h.present.delete(SRC);
		expect((await continueOffload(h.deps, approved)).record).toMatchObject({ step: 'failed', blocked: 'source-missing' });
	});
});

describe('abort', () => {
	it('is allowed up to the rewrite approval and keeps the copy', async () => {
		const h = await setup();
		syncToDrive(h);
		const adv = await advanceOffload(h.deps, h.record);
		const aborted = await abortOffload(h.deps, adv.record);
		expect(aborted.ok && aborted.value.step).toBe('aborted');
		expect(fs.existsSync(path.join(h.mount, 'Big.pdf'))).toBe(true);
		expect(h.present.has(SRC)).toBe(true);
	});

	it('is refused once references are being rewritten', async () => {
		const h = await setup();
		const approved = await toApproved(h);
		const out = await continueOffload(h.deps, approved);
		const verified = out.record.step === 'done' ? { ...out.record, step: 'rewriting' as const } : out.record;
		expect(await abortOffload(h.deps, verified)).toEqual({ ok: false, error: 'invalid-transition' });
	});
});
