import { describe, it, expect } from 'vitest';
import { analyseDuplicates, groupBySize, sha256Hex } from '../src/services/attachmentDuplicateService';

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

function port(contents: Record<string, string>, failing: string[] = []) {
	const reads: string[] = [];
	return {
		reads,
		readBinary: async (path: string) => {
			reads.push(path);
			if (failing.includes(path)) throw new Error('nope');
			return enc(contents[path]);
		},
	};
}

describe('sha256Hex', () => {
	it('matches the known digest of "abc"', async () => {
		expect(await sha256Hex(enc('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
	});
});

describe('groupBySize', () => {
	it('keeps only sizes shared by two or more files', () => {
		const groups = groupBySize([
			{ path: 'a', size: 1 }, { path: 'b', size: 1 }, { path: 'c', size: 2 },
		]);
		expect([...groups.keys()]).toEqual([1]);
	});
});

describe('analyseDuplicates', () => {
	const files = [
		{ path: 'a.pdf', size: 3 }, { path: 'b.pdf', size: 3 }, { path: 'c.pdf', size: 3 },
		{ path: 'solo.pdf', size: 9 },
		{ path: 'big1.bin', size: 100 }, { path: 'big2.bin', size: 100 },
	];
	const contents = { 'a.pdf': 'xyz', 'b.pdf': 'xyz', 'c.pdf': 'abc', 'solo.pdf': 'unique!!!', 'big1.bin': 'x', 'big2.bin': 'x' };

	it('finds byte-identical files and never reads a file with a unique size', async () => {
		const p = port(contents);
		const res = await analyseDuplicates(files, p, { maxBytes: 50 });
		expect(res.groups).toEqual([{ hash: await sha256Hex(enc('xyz')), size: 3, paths: ['a.pdf', 'b.pdf'] }]);
		expect(p.reads).not.toContain('solo.pdf');
		expect(res.cancelled).toBe(false);
	});

	it('does not hash a file over the cap and labels it not analysed', async () => {
		const p = port(contents);
		const res = await analyseDuplicates(files, p, { maxBytes: 50 });
		expect(res.notAnalysed).toEqual(expect.arrayContaining([
			{ path: 'big1.bin', reason: 'over-cap' }, { path: 'big2.bin', reason: 'over-cap' },
		]));
		expect(p.reads).not.toContain('big1.bin');
	});

	it('labels an unreadable file and carries on', async () => {
		const p = port(contents, ['a.pdf']);
		const res = await analyseDuplicates(files, p, { maxBytes: 50 });
		expect(res.notAnalysed).toContainEqual({ path: 'a.pdf', reason: 'read-failed' });
		expect(res.groups).toEqual([]); // b.pdf and c.pdf differ
	});

	it('reports progress and respects the concurrency limit', async () => {
		let active = 0;
		let peak = 0;
		const slow = {
			readBinary: async (path: string) => {
				active++;
				peak = Math.max(peak, active);
				await new Promise((r) => setTimeout(r, 5));
				active--;
				return enc(contents[path as keyof typeof contents]);
			},
		};
		const seen: number[] = [];
		await analyseDuplicates(files, slow, { maxBytes: 50, concurrency: 2, onProgress: (done) => seen.push(done) });
		expect(peak).toBeLessThanOrEqual(2);
		expect(seen[seen.length - 1]).toBe(3);
	});

	it('stops between files when cancelled and labels the partial result', async () => {
		const ctl = new AbortController();
		const p = {
			readBinary: async (path: string) => {
				ctl.abort(); // cancel after the first read starts
				return enc(contents[path as keyof typeof contents]);
			},
		};
		const res = await analyseDuplicates(files, p, { maxBytes: 50, concurrency: 1, signal: ctl.signal });
		expect(res.cancelled).toBe(true);
		expect(res.analysed).toBeLessThan(3);
	});

	it('handles an empty input', async () => {
		expect(await analyseDuplicates([], port({}), { maxBytes: 10 })).toEqual({ groups: [], notAnalysed: [], analysed: 0, cancelled: false });
	});
});
