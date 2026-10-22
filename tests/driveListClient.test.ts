import { describe, it, expect, vi } from 'vitest';
import { listDriveTree, type ListPage } from '../src/services/cloudInventory/driveListClient';
import { ok, err, type Result } from '../src/core/result';

// The walker idles with window.setTimeout (Obsidian popout-window safe); node has no window.
vi.stubGlobal('window', globalThis);

type Tree = Record<string, { files?: string[]; folders?: Array<[string, string]>; pages?: number }>;

/** A fake Drive: folder id -> files and subfolders, optionally split across pages. */
function fakeFetch(tree: Tree, log: string[] = []) {
	return async (folderId: string, token: string | null): Promise<Result<ListPage>> => {
		log.push(`${folderId}:${token ?? ''}`);
		const node = tree[folderId];
		if (!node) return err('script-not-approved');
		const page = token ? Number(token) : 0;
		const pages = node.pages ?? 1;
		const files = page === 0 ? (node.files ?? []) : [];
		const folders = page === 0 ? (node.folders ?? []) : [];
		return ok({
			files: files.map((n) => ({ id: `${folderId}/${n}`, name: n, mimeType: 'application/pdf', size: '10', modifiedTime: '2026-01-01T00:00:00Z' })),
			folders: folders.map(([id, name]) => ({ id, name })),
			nextPageToken: page + 1 < pages ? String(page + 1) : null,
		});
	};
}

const limits = { maxFolders: 300, maxFiles: 3000, deadlineMs: 60_000 };

describe('listDriveTree', () => {
	const tree: Tree = {
		root: { files: ['a.pdf'], folders: [['f1', 'Sub'], ['f2', 'Other']] },
		f1: { files: ['b.pdf'], folders: [['f3', 'Deep']] },
		f2: { files: [] },
		f3: { files: ['c.pdf'] },
	};

	it('walks the whole tree and records each file\'s folder path', async () => {
		const res = await listDriveTree({ rootFolderId: 'root', fetchPage: fakeFetch(tree), limits });
		expect(res.status).toBe('complete');
		expect(res.files.map((f) => `${f.path}|${f.name}`).sort()).toEqual(['Sub/Deep|c.pdf', 'Sub|b.pdf', '|a.pdf']);
		expect(res.files[0].size).toBe(10);
		expect(res.foldersVisited).toBe(4);
	});

	it('follows page tokens', async () => {
		const log: string[] = [];
		const res = await listDriveTree({ rootFolderId: 'root', fetchPage: fakeFetch({ root: { files: ['a.pdf'], pages: 3 } }, log), limits });
		expect(res.status).toBe('complete');
		expect(log).toEqual(['root:', 'root:1', 'root:2']);
	});

	it('does not loop on a cycle of folders', async () => {
		const res = await listDriveTree({ rootFolderId: 'a', fetchPage: fakeFetch({ a: { folders: [['b', 'B']] }, b: { folders: [['a', 'A']] } }), limits });
		expect(res.status).toBe('complete');
		expect(res.foldersVisited).toBe(2);
	});

	it('aborts a folder whose page token repeats instead of looping forever', async () => {
		let calls = 0;
		const fetchPage = async (): Promise<Result<ListPage>> => { calls++; return ok({ files: [], folders: [], nextPageToken: 'same' }); };
		const res = await listDriveTree({ rootFolderId: 'r', fetchPage, limits });
		expect(calls).toBeLessThan(5);
		expect(res.status).toBe('truncated'); // an unfinished folder is never reported as complete
	});

	it('turns a rejecting request into a failed listing instead of throwing', async () => {
		const fetchPage = async (): Promise<Result<ListPage>> => { throw new Error('boom'); };
		const res = await listDriveTree({ rootFolderId: 'root', fetchPage, limits });
		expect(res).toMatchObject({ status: 'failed', error: 'script-network', files: [] });
	});

	it('stops requesting once the file budget is spent', async () => {
		const log: string[] = [];
		const wide: Tree = { root: { files: ['a.pdf', 'b.pdf'], folders: Array.from({ length: 6 }, (_, i) => [`c${i}`, `C${i}`] as [string, string]) } };
		for (let i = 0; i < 6; i++) wide[`c${i}`] = { files: ['x.pdf'] };
		const res = await listDriveTree({ rootFolderId: 'root', fetchPage: fakeFetch(wide, log), limits: { ...limits, maxFiles: 2 } });
		expect(res.status).toBe('truncated');
		expect(log).toEqual(['root:']);
	});

	it('does not wait for an in-flight request past the deadline', async () => {
		const fetchPage = () => new Promise<Result<ListPage>>(() => { /* never answers */ });
		const res = await listDriveTree({ rootFolderId: 'root', fetchPage, limits: { ...limits, deadlineMs: 20 } });
		expect(res.status).toBe('truncated');
	});

	it('marks the listing truncated when the folder limit is hit, never complete', async () => {
		const res = await listDriveTree({ rootFolderId: 'root', fetchPage: fakeFetch(tree), limits: { ...limits, maxFolders: 2 } });
		expect(res.status).toBe('truncated');
		expect(res.foldersVisited).toBeLessThanOrEqual(2);
	});

	it('marks the listing truncated when the file limit is hit', async () => {
		const res = await listDriveTree({ rootFolderId: 'root', fetchPage: fakeFetch(tree), limits: { ...limits, maxFiles: 1 } });
		expect(res.status).toBe('truncated');
		expect(res.files).toHaveLength(1);
	});

	it('marks the listing truncated at the deadline', async () => {
		let t = 0;
		const res = await listDriveTree({ rootFolderId: 'root', fetchPage: fakeFetch(tree), limits: { ...limits, deadlineMs: 5 }, now: () => (t += 3) });
		expect(res.status).toBe('truncated');
	});

	it('fails with the error code and returns no files when a request fails', async () => {
		const fetchPage = async (id: string): Promise<Result<ListPage>> => (id === 'f1' ? err('script-drive-error') : fakeFetch(tree)(id, null));
		const res = await listDriveTree({ rootFolderId: 'root', fetchPage, limits });
		expect(res).toMatchObject({ status: 'failed', error: 'script-drive-error', files: [] });
	});

	it('reports cancellation as a failed listing with no files', async () => {
		const ctl = new AbortController();
		const fetchPage = async (id: string, token: string | null): Promise<Result<ListPage>> => { ctl.abort(); return fakeFetch(tree)(id, token); };
		const res = await listDriveTree({ rootFolderId: 'root', fetchPage, limits, signal: ctl.signal });
		expect(res).toMatchObject({ status: 'failed', error: 'cancelled', files: [] });
	});

	it('never has more than two requests in flight', async () => {
		let active = 0;
		let peak = 0;
		const wide: Tree = { root: { folders: Array.from({ length: 8 }, (_, i) => [`c${i}`, `C${i}`] as [string, string]) } };
		for (let i = 0; i < 8; i++) wide[`c${i}`] = { files: ['x.pdf'] };
		const inner = fakeFetch(wide);
		const fetchPage = async (id: string, token: string | null) => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 2)); active--; return inner(id, token); };
		const res = await listDriveTree({ rootFolderId: 'root', fetchPage, limits });
		expect(res.status).toBe('complete');
		expect(res.files).toHaveLength(8);
		expect(peak).toBeLessThanOrEqual(2);
	});

	it('reports progress', async () => {
		const seen: number[] = [];
		await listDriveTree({ rootFolderId: 'root', fetchPage: fakeFetch(tree), limits, onProgress: (folders) => seen.push(folders) });
		expect(seen[seen.length - 1]).toBe(4);
	});
});
