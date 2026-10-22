/**
 * Scan → eligibility, end to end on a synthetic vault: the rule the results modal applies when
 * it decides which rows can be selected for the trash.
 */
import { describe, it, expect } from 'vitest';
import { scanNotes, type EmbedScanResult } from '../src/services/embedScanService';
import { eligibilityFromScan } from '../src/services/attachmentEligibility';
import { makeFakeApp } from './helpers/fakeVault';

const canvas = (file: string) => JSON.stringify({ nodes: [{ id: 'n1', type: 'file', file }] });

async function scan(specs: Record<string, string | { size?: number; text?: string; unreadable?: boolean }>): Promise<{ result: EmbedScanResult; v: ReturnType<typeof makeFakeApp> }> {
	const v = makeFakeApp(specs);
	const referrers = [...v.files.values()].filter((f) => f.extension === 'md' || f.extension === 'canvas');
	const result = await scanNotes(v.app as never, referrers as never, { includeOrphans: true });
	return { result, v };
}

function eligibilityOf(result: EmbedScanResult, v: ReturnType<typeof makeFakeApp>, path: string, protectedFolders: string[] = []) {
	const file = v.files.get(path)!;
	const target = result.targets.find((t) => t.file?.path === path);
	return eligibilityFromScan(
		{ path, size: file.stat.size, mtime: file.stat.mtime },
		target?.references.length ?? 0,
		(result.ambiguousPaths ?? []).includes(path),
		result.coverageFailures ?? [],
		protectedFolders,
	);
}

describe('trash eligibility from a scan', () => {
	it('allows an unreferenced attachment', async () => {
		const { result, v } = await scan({ 'Docs/orphan.pdf': { size: 100 }, 'n.md': 'nothing here' });
		expect(result.possiblyOrphaned.map((f) => f.path)).toEqual(['Docs/orphan.pdf']);
		expect(eligibilityOf(result, v, 'Docs/orphan.pdf').eligible).toBe(true);
	});

	it('blocks an attachment referenced only by a canvas file node', async () => {
		const { result, v } = await scan({ 'Docs/a.pdf': { size: 100 }, 'Board.canvas': canvas('Docs/a.pdf') });
		const e = eligibilityOf(result, v, 'Docs/a.pdf');
		expect(e.eligible).toBe(false);
		expect(e.reasons).toContain('still-referenced');
		expect(result.possiblyOrphaned).toEqual([]);
	});

	it('blocks an attachment referenced by a note, with the right count', async () => {
		const { result, v } = await scan({ 'Docs/a.pdf': { size: 100 }, 'one.md': '![[a.pdf]]', 'two.md': '[[a.pdf]] and ![[a.pdf]]' });
		const e = eligibilityOf(result, v, 'Docs/a.pdf');
		expect(e.eligible).toBe(false);
		expect(e.referenceCount).toBe(3);
	});

	it('blocks everything when a canvas cannot be parsed (it might reference anything)', async () => {
		const { result, v } = await scan({ 'Docs/orphan.pdf': { size: 100 }, 'Bad.canvas': '{oops' });
		const e = eligibilityOf(result, v, 'Docs/orphan.pdf');
		expect(e.eligible).toBe(false);
		expect(e.reasons).toContain('canvas-unreadable');
	});

	it('blocks everything when a note cannot be read', async () => {
		const { result, v } = await scan({ 'Docs/orphan.pdf': { size: 100 }, 'broken.md': { unreadable: true } });
		const e = eligibilityOf(result, v, 'Docs/orphan.pdf');
		expect(e.reasons).toContain('scan-incomplete');
	});

	it('blocks same-named files that one link cannot tell apart', async () => {
		const { result, v } = await scan({ 'A/scan.pdf': { size: 10 }, 'B/scan.pdf': { size: 20 }, 'n.md': '![[scan.pdf]]' });
		expect(eligibilityOf(result, v, 'A/scan.pdf').reasons).toContain('ambiguous-reference');
		expect(eligibilityOf(result, v, 'B/scan.pdf').reasons).toContain('ambiguous-reference');
	});

	it('blocks an unreferenced attachment inside a protected folder', async () => {
		const { result, v } = await scan({ 'Courses/Live/orphan.pdf': { size: 100 }, 'n.md': 'x' });
		const e = eligibilityOf(result, v, 'Courses/Live/orphan.pdf', ['Courses/Live']);
		expect(e.eligible).toBe(false);
		expect(e.reasons).toEqual(['protected-path']);
	});
});
