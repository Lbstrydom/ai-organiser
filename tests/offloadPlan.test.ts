import { describe, it, expect } from 'vitest';
import { buildCopyPlan, buildRewritePlan, matchRemote, offloadablePairs, suggestPair, textHash } from '../src/services/offload/offloadPlan';
import { findOccurrences, type ScanTarget } from '../src/services/offload/referenceOccurrences';
import type { CloudInventoryPair } from '../src/core/settings';

const ID = 'DriveFolder_01';
const pair = (over: Partial<CloudInventoryPair> = {}): CloudInventoryPair => ({ id: 'p1', vaultFolder: 'Projects', driveFolderId: ID, placement: 'beside', localMountFolder: '/mnt/drive/Projects', ...over });

describe('pair choice', () => {
	it('only pairs with a local Drive folder can receive a file', () => {
		expect(offloadablePairs([pair(), pair({ id: 'p2', localMountFolder: undefined }), pair({ id: 'p3', localMountFolder: '  ' })]).map((p) => p.id)).toEqual(['p1']);
	});

	it('suggests the single usable pair, else the most specific folder, else asks', () => {
		expect(suggestPair([pair()], 'Anywhere/x.pdf')?.id).toBe('p1');
		const many = [pair({ id: 'a', vaultFolder: 'Projects' }), pair({ id: 'b', vaultFolder: 'Projects/Garden' }), pair({ id: 'c', vaultFolder: 'Areas' })];
		expect(suggestPair(many, 'Projects/Garden/x.pdf')?.id).toBe('b');
		expect(suggestPair(many, 'Projects/Other/x.pdf')?.id).toBe('a');
		expect(suggestPair(many, 'Elsewhere/x.pdf')).toBeNull();
		expect(suggestPair([pair({ id: 'a' }), pair({ id: 'b' })], 'Projects/x.pdf')).toBeNull(); // two equal candidates: the user chooses
	});
});

const TARGET: ScanTarget = { path: 'Projects/Big.pdf', name: 'Big.pdf', resolve: (l) => (l.toLowerCase().endsWith('big.pdf') ? 'Projects/Big.pdf' : null) };
const source = { path: 'Projects/Big.pdf', size: 1000, mtimeMs: 5, sha256: 'a'.repeat(64) };

function referrer(path: string, text: string, kind: 'md' | 'canvas' = 'md') {
	const res = findOccurrences(path, text, kind === 'md' ? 'md' : 'canvas', TARGET);
	if (!res.ok) throw new Error(res.error);
	return { path, kind, text, occurrences: res.value };
}

describe('buildCopyPlan', () => {
	const base = { opId: 'op1', now: 'T', source, pair: pair(), protectedFolders: [] as string[] };

	it('records the referrers with hashes and spans, and skips notes with no reference', async () => {
		const plan = await buildCopyPlan({ ...base, referrers: [referrer('Notes/a.md', 'see ![[Big.pdf]]'), referrer('Notes/b.md', 'nothing')] });
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.value.referrers.map((r) => r.path)).toEqual(['Notes/a.md']);
		expect(plan.value.referrers[0].baselineHash).toBe(await textHash('see ![[Big.pdf]]'));
		expect(plan.value).toMatchObject({ opId: 'op1', pairId: 'p1', driveFolderId: ID, destName: 'Big.pdf' });
	});

	it('refuses an unsupported reference, a protected source and a protected referrer', async () => {
		expect(await buildCopyPlan({ ...base, referrers: [referrer('Notes/a.md', '<embed src="Big.pdf">')] })).toEqual({ ok: false, error: 'unsupported-reference' });
		expect(await buildCopyPlan({ ...base, protectedFolders: ['Projects'], referrers: [] })).toEqual({ ok: false, error: 'protected-path' });
		expect(await buildCopyPlan({ ...base, protectedFolders: ['Notes'], referrers: [referrer('Notes/a.md', '![[Big.pdf]]')] })).toEqual({ ok: false, error: 'protected-path' });
	});
});

describe('matchRemote', () => {
	const expected = { name: 'Big.pdf', size: 1000, sha256: 'a'.repeat(64) };
	const file = (over: Record<string, unknown> = {}) => ({ id: 'f1', name: 'Big.pdf', size: 1000, sha256Checksum: 'A'.repeat(64), ...over });

	it('needs name, size and sha256 to agree', () => {
		expect(matchRemote([file()], expected, ID)).toMatchObject({ state: 'one', remote: { id: 'f1', parent: ID } });
		expect(matchRemote([file({ name: 'other.pdf' })], expected, ID)).toEqual({ state: 'none' });
		expect(matchRemote([file({ size: 999 })], expected, ID)).toEqual({ state: 'none' });
		expect(matchRemote([file({ sha256Checksum: 'b'.repeat(64) })], expected, ID)).toEqual({ state: 'none' });
		expect(matchRemote([file({ sha256Checksum: undefined })], expected, ID)).toEqual({ state: 'none' }); // a file with no checksum is never matched
	});

	it('reports more than one match as a conflict', () => {
		expect(matchRemote([file(), file({ id: 'f2' })], expected, ID)).toEqual({ state: 'many' });
	});
});

describe('buildRewritePlan', () => {
	const remote = { id: 'RemoteId_1', name: 'Big.pdf', size: 1000, sha256: 'a'.repeat(64), parent: ID };

	async function copyPlan(text: string) {
		const res = await buildCopyPlan({ opId: 'op1', now: 'T', source, pair: pair(), protectedFolders: [], referrers: [referrer('Notes/a.md', text)] });
		if (!res.ok) throw new Error(res.error);
		return res.value;
	}

	it('computes the exact after text and its hash with the real link', async () => {
		const text = 'intro ![[Big.pdf]] outro';
		const res = await buildRewritePlan(await copyPlan(text), remote, new Map([['Notes/a.md', text]]));
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const item = res.value.plan.items[0];
		expect(item.edits[0].text).toContain('https://drive.google.com/file/d/RemoteId_1/view');
		expect(item.preview[0].before).toBe('![[Big.pdf]]');
		expect(item.expectedAfterHash).toBe(await textHash(`intro ${item.edits[0].text} outro`));
		expect(res.value.changed).toEqual([]);
	});

	it('drops a referrer whose text changed since the plan, and one that vanished', async () => {
		const text = 'intro ![[Big.pdf]]';
		const plan = await copyPlan(text);
		const changed = await buildRewritePlan(plan, remote, new Map([['Notes/a.md', text + ' edited']]));
		expect(changed.ok && changed.value).toMatchObject({ plan: { items: [] }, changed: ['Notes/a.md'] });
		const gone = await buildRewritePlan(plan, remote, new Map());
		expect(gone.ok && gone.value.changed).toEqual(['Notes/a.md']);
	});

	it('plans a canvas file node as a link node', async () => {
		const canvas = JSON.stringify({ nodes: [{ id: 'n1', type: 'file', file: 'Projects/Big.pdf', x: 0, y: 0, width: 1, height: 1 }], edges: [] });
		const res = await buildCopyPlan({ opId: 'op2', now: 'T', source, pair: pair(), protectedFolders: [], referrers: [referrer('Boards/b.canvas', canvas, 'canvas')] });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const rewrite = await buildRewritePlan(res.value, remote, new Map([['Boards/b.canvas', canvas]]));
		expect(rewrite.ok && rewrite.value.plan.items[0]).toMatchObject({ kind: 'canvas', nodeIds: ['n1'] });
		expect(rewrite.ok && rewrite.value.plan.items[0].expectedAfterHash).toMatch(/^[0-9a-f]{64}$/);
	});
});
