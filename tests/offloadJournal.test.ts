import { describe, it, expect } from 'vitest';
import { JournalStore, canTransition, isTerminal, newRecord, nextStep, transition, JOURNAL_GENERATOR, type OffloadRecord } from '../src/services/offload/offloadJournal';
import type { CopyPlan } from '../src/services/offload/offloadPlan';

const copy: CopyPlan = {
	opId: 'op1',
	createdAt: 'T',
	source: { path: 'Projects/Big.pdf', size: 10, mtimeMs: 1, sha256: 'a'.repeat(64) },
	pairId: 'p1',
	driveFolderId: 'DriveFolder_01',
	destName: 'Big.pdf',
	referrers: [{ path: 'Notes/a.md', kind: 'md', baselineHash: 'h', occurrences: [] }],
};

function makeAdapter(initial: Record<string, string> = {}) {
	const files = new Map(Object.entries(initial));
	let failRename: string | null = null;
	return {
		files,
		failRename(sub: string | null) { failRename = sub; },
		adapter: {
			exists: async (p: string) => files.has(p),
			read: async (p: string) => { if (!files.has(p)) throw new Error('missing'); return files.get(p)!; },
			write: async (p: string, d: string) => { files.set(p, d); },
			rename: async (a: string, b: string) => {
				if (failRename && `${a}>${b}`.includes(failRename)) throw new Error('injected');
				files.set(b, files.get(a)!); files.delete(a);
			},
			remove: async (p: string) => { files.delete(p); },
		},
	};
}

describe('step machine', () => {
	it('moves one step forward at a time', () => {
		expect(nextStep('planned')).toBe('copied');
		expect(nextStep('trashed')).toBe('done');
		expect(nextStep('done')).toBeNull();
		expect(canTransition('planned', 'copied')).toBe(true);
		expect(canTransition('planned', 'remote-captured')).toBe(false);
		expect(canTransition('copied', 'planned')).toBe(false);
	});

	it('allows failure from any live step and abort until the barrier has passed', () => {
		expect(canTransition('verified', 'failed')).toBe(true);
		for (const s of ['planned', 'copied', 'remote-captured', 'rewrite-approved', 'rewriting'] as const) expect(canTransition(s, 'aborted')).toBe(true);
		for (const s of ['verified', 'trash-pending', 'trashed'] as const) expect(canTransition(s, 'aborted')).toBe(false);
	});

	it('treats done, aborted and failed as final', () => {
		for (const s of ['done', 'aborted', 'failed'] as const) {
			expect(isTerminal(s)).toBe(true);
			expect(canTransition(s, 'failed')).toBe(false);
		}
	});

	it('transition returns an error rather than skipping a step', () => {
		const rec = newRecord(copy, 'T0');
		expect(transition(rec, 'rewriting', 'T1')).toEqual({ ok: false, error: 'invalid-transition' });
		const ok = transition(rec, 'copied', 'T1', { placed: { destPath: '/x', destName: 'Big.pdf', sha256: 'a'.repeat(64), size: 10, reused: false } });
		expect(ok.ok && ok.value).toMatchObject({ step: 'copied', updatedAt: 'T1', referrers: { 'Notes/a.md': 'pending' } });
	});
});

describe('JournalStore', () => {
	const PATH = 'plugin/offload-journal.json';

	it('starts empty, round-trips records and lists unfinished ones', async () => {
		const h = makeAdapter();
		const store = new JournalStore(h.adapter as never, PATH);
		expect(await store.load()).toEqual({ ok: true, value: [] });
		const a = newRecord(copy, 'T');
		const done: OffloadRecord = { ...newRecord({ ...copy, opId: 'op2' }, 'T'), step: 'done' };
		expect((await store.put(a)).ok).toBe(true);
		expect((await store.put(done)).ok).toBe(true);
		const loaded = await store.load();
		expect(loaded.ok && loaded.value.map((r) => r.opId).sort()).toEqual(['op1', 'op2']);
		const open = await store.unfinished();
		expect(open.ok && open.value.map((r) => r.opId)).toEqual(['op1']);
		expect(h.files.has(`${PATH}.aio-prev`)).toBe(false);
	});

	it('does not lose an update when two operations save at the same time', async () => {
		const h = makeAdapter();
		const store = new JournalStore(h.adapter as never, PATH);
		const a = newRecord(copy, 'T');
		const b = newRecord({ ...copy, opId: 'op2' }, 'T');
		const c = newRecord({ ...copy, opId: 'op3' }, 'T');
		const results = await Promise.all([store.put(a), store.put(b), store.put(c)]);
		expect(results.every((r) => r.ok)).toBe(true);
		const all = await store.load();
		expect(all.ok && all.value.map((r) => r.opId).sort()).toEqual(['op1', 'op2', 'op3']);
	});

	it('serialises plain saves too, so two writers never share a temporary file', async () => {
		const h = makeAdapter();
		const store = new JournalStore(h.adapter as never, PATH);
		const a = newRecord(copy, 'T');
		const b = newRecord({ ...copy, opId: 'op2' }, 'T');
		const [x, y] = await Promise.all([store.save([a]), store.save([a, b])]);
		expect(x.ok && y.ok).toBe(true);
		const all = await store.load();
		expect(all.ok && all.value.map((r) => r.opId)).toEqual(['op1', 'op2']); // the later save won, whole
	});

	it('leaves an unrelated file in the previous-version slot alone', async () => {
		const h = makeAdapter();
		const store = new JournalStore(h.adapter as never, PATH);
		await store.put(newRecord(copy, 'T'));
		h.files.set(`${PATH}.aio-prev`, 'something the user keeps here');
		expect(await store.put(newRecord({ ...copy, opId: 'op2' }, 'T'))).toEqual({ ok: false, error: 'journal-not-ours' });
		expect(h.files.get(`${PATH}.aio-prev`)).toBe('something the user keeps here');
	});

	it('replaces a record by id', async () => {
		const h = makeAdapter();
		const store = new JournalStore(h.adapter as never, PATH);
		await store.put(newRecord(copy, 'T'));
		const moved = transition(newRecord(copy, 'T'), 'failed', 'T2', { blocked: 'x' });
		if (!moved.ok) throw new Error('t');
		await store.put(moved.value);
		const all = await store.load();
		expect(all.ok && all.value).toHaveLength(1);
		expect(all.ok && all.value[0].step).toBe('failed');
	});

	it('never touches a file at the journal path that is not ours', async () => {
		const h = makeAdapter({ [PATH]: 'something the user wrote' });
		const store = new JournalStore(h.adapter as never, PATH);
		expect(await store.load()).toEqual({ ok: false, error: 'journal-not-ours' });
		expect(await store.put(newRecord(copy, 'T'))).toEqual({ ok: false, error: 'journal-not-ours' });
		expect(h.files.get(PATH)).toBe('something the user wrote');
	});

	it('rejects a tampered journal', async () => {
		const h = makeAdapter();
		const store = new JournalStore(h.adapter as never, PATH);
		await store.put(newRecord(copy, 'T'));
		const file = JSON.parse(h.files.get(PATH)!);
		file.records[0].step = 'done';
		h.files.set(PATH, JSON.stringify(file));
		expect(await store.load()).toEqual({ ok: false, error: 'journal-not-ours' });
		expect(file.generator).toBe(JOURNAL_GENERATOR);
	});

	it('recovers from a crash between the two renames', async () => {
		const h = makeAdapter();
		const store = new JournalStore(h.adapter as never, PATH);
		await store.put(newRecord(copy, 'T'));
		h.files.set(`${PATH}.aio-prev`, h.files.get(PATH)!);
		h.files.delete(PATH);
		const loaded = await store.load();
		expect(loaded.ok && loaded.value).toHaveLength(1);
		expect(h.files.has(PATH)).toBe(true);
	});

	it('puts the previous journal back when publishing fails', async () => {
		const h = makeAdapter();
		const store = new JournalStore(h.adapter as never, PATH);
		await store.put(newRecord(copy, 'T'));
		h.failRename('.tmp>');
		const failed = await store.put(newRecord({ ...copy, opId: 'op9' }, 'T'));
		expect(failed).toEqual({ ok: false, error: 'write-failed' });
		h.failRename(null);
		const loaded = await store.load();
		expect(loaded.ok && loaded.value.map((r) => r.opId)).toEqual(['op1']);
	});
});
