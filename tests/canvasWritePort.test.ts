import { describe, it, expect } from 'vitest';
import { transformCanvas, rewriteCanvasNodes } from '../src/services/canvas/canvasWritePort';
import { TFile } from './mocks/obsidian';

const canvas = {
	nodes: [
		{ id: 'f1', type: 'file', file: 'Attachments/a.pdf', x: 10, y: 20, width: 300, height: 400, color: '3', subpath: '#page=2' },
		{ id: 't1', type: 'text', text: 'hello', x: 0, y: 0, width: 100, height: 50 },
		{ id: 'f2', type: 'file', file: 'Attachments/b.pdf', x: 5, y: 5, width: 10, height: 10 },
	],
	edges: [{ id: 'e1', fromNode: 'f1', toNode: 't1', fromSide: 'right', toSide: 'left' }],
};
const text = JSON.stringify(canvas, null, 2);

describe('transformCanvas', () => {
	it('turns only the targeted file node into a link node and keeps its id, position, size and colour', () => {
		const res = transformCanvas(text, [{ nodeId: 'f1', url: 'https://drive.google.com/file/d/X/view' }]);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const out = JSON.parse(res.value);
		expect(out.nodes[0]).toEqual({ id: 'f1', x: 10, y: 20, width: 300, height: 400, color: '3', type: 'link', url: 'https://drive.google.com/file/d/X/view' });
		expect(out.nodes[1]).toEqual(canvas.nodes[1]);
		expect(out.nodes[2]).toEqual(canvas.nodes[2]);
		expect(out.edges).toEqual(canvas.edges); // edges to the node keep working: its id is unchanged
	});

	it('refuses an unreadable canvas, a missing node and a node that is not a file node', () => {
		expect(transformCanvas('nope', [])).toEqual({ ok: false, error: 'canvas-unreadable' });
		expect(transformCanvas('{"nodes":5}', [])).toEqual({ ok: false, error: 'canvas-unreadable' });
		expect(transformCanvas(text, [{ nodeId: 'zz', url: 'u' }])).toEqual({ ok: false, error: 'node-missing' });
		expect(transformCanvas(text, [{ nodeId: 't1', url: 'u' }])).toEqual({ ok: false, error: 'node-missing' });
	});
});

describe('rewriteCanvasNodes', () => {
	function makeApp(initial: string) {
		let current = initial;
		const file = new TFile();
		file.path = 'Boards/b.canvas';
		file.extension = 'canvas';
		const app = {
			vault: {
				getAbstractFileByPath: (p: string) => (p === file.path ? file : null),
				process: async (_f: unknown, fn: (s: string) => string) => { current = fn(current); return current; },
			},
		};
		return { app: app as never, get text() { return current; }, set text(v: string) { current = v; } };
	}
	const edit = [{ nodeId: 'f1', url: 'https://drive.google.com/file/d/X/view' }];

	it('writes the transformed canvas when the baseline still matches', async () => {
		const h = makeApp(text);
		expect(await rewriteCanvasNodes(h.app, 'Boards/b.canvas', edit, text, [])).toEqual({ ok: true, value: undefined });
		expect(JSON.parse(h.text).nodes[0].type).toBe('link');
	});

	it('writes nothing when the canvas changed since the plan', async () => {
		const h = makeApp(text + ' ');
		expect(await rewriteCanvasNodes(h.app, 'Boards/b.canvas', edit, text, [])).toEqual({ ok: false, error: 'referrer-changed' });
		expect(h.text).toBe(text + ' ');
	});

	it('refuses a protected canvas and a missing file before touching anything', async () => {
		const h = makeApp(text);
		expect(await rewriteCanvasNodes(h.app, 'Boards/b.canvas', edit, text, ['Boards'])).toEqual({ ok: false, error: 'protected-path' });
		expect(await rewriteCanvasNodes(h.app, 'Boards/zzz.canvas', edit, text, [])).toEqual({ ok: false, error: 'target-missing' });
		expect(h.text).toBe(text);
	});
});
