import { vi } from 'vitest';
import { buildCanvasEdge, buildCanvasNode, generateId, sanitizeCanvasName, serializeCanvas, writeCanvasFile } from '../src/services/canvas/canvasUtils';
import { CanvasData, EdgeDescriptor, NodeDescriptor } from '../src/services/canvas/types';

function createMockApp(existingPaths: Set<string>) {
    const created: string[] = [];

    const vault = {
        getAbstractFileByPath: (path: string) => (existingPaths.has(path) ? ({ path }) : null),
        createFolder: async (path: string) => {
            existingPaths.add(path);
        },
        create: async (path: string, _content: string) => {
            existingPaths.add(path);
            created.push(path);
        }
    } as any;

    return {
        vault,
        workspace: { openLinkText: async () => {} },
        created
    } as any;
}

describe('Canvas Utils', () => {
    it('generateId should return unique ids', () => {
        const ids = new Set<string>();
        for (let i = 0; i < 100; i++) {
            ids.add(generateId());
        }
        expect(ids.size).toBe(100);
    });

    it('buildCanvasNode should map descriptor fields', () => {
        const fileNode = buildCanvasNode({
            id: '1',
            label: 'Note',
            type: 'file',
            file: 'Notes/Note.md'
        } as NodeDescriptor, 0, 0);

        expect(fileNode.type).toBe('file');
        expect(fileNode.file).toBe('Notes/Note.md');

        const textNode = buildCanvasNode({
            id: '2',
            label: 'Missing',
            type: 'text',
            text: 'Missing: file'
        } as NodeDescriptor, 10, 10);

        expect(textNode.type).toBe('text');
        expect(textNode.text).toBe('Missing: file');

        const linkNode = buildCanvasNode({
            id: '3',
            label: 'Link',
            type: 'link',
            url: 'https://example.com'
        } as NodeDescriptor, 20, 20);

        expect(linkNode.type).toBe('link');
        expect(linkNode.url).toBe('https://example.com');
    });

    it('buildCanvasEdge should compute edge sides', () => {
        const edge: EdgeDescriptor = { fromId: 'a', toId: 'b' };
        const positions = new Map<string, { x: number; y: number }>([
            ['a', { x: 0, y: 0 }],
            ['b', { x: 10, y: 0 }]
        ]);

        const canvasEdge = buildCanvasEdge(edge, positions);
        expect(canvasEdge.fromSide).toBe('right');
        expect(canvasEdge.toSide).toBe('left');
    });

    it('serializeCanvas should roundtrip JSON', () => {
        const data: CanvasData = {
            nodes: [],
            edges: []
        };

        const serialized = serializeCanvas(data);
        expect(JSON.parse(serialized)).toEqual(data);
    });

    it('sanitizeCanvasName should remove invalid characters', () => {
        expect(sanitizeCanvasName('My: Note / Title')).toBe('My Note Title');
    });

    it('sanitizeCanvasName should return Canvas for empty string', () => {
        expect(sanitizeCanvasName('')).toBe('Canvas');
    });

    it('sanitizeCanvasName should return Canvas for all-invalid characters', () => {
        expect(sanitizeCanvasName('***')).toBe('Canvas');
    });

    it('buildCanvasNode should use custom width/height from descriptor', () => {
        const node = buildCanvasNode({
            id: '1',
            label: 'Custom',
            type: 'text',
            text: 'Test',
            width: 600,
            height: 300
        } as NodeDescriptor, 0, 0);

        expect(node.width).toBe(600);
        expect(node.height).toBe(300);
    });

    it('buildCanvasNode should propagate color', () => {
        const node = buildCanvasNode({
            id: '1',
            label: 'Colored',
            type: 'file',
            file: 'test.md',
            color: '5'
        } as NodeDescriptor, 0, 0);

        expect(node.color).toBe('5');
    });

    it('buildCanvasEdge should warn and fallback for missing positions', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const edge: EdgeDescriptor = { fromId: 'x', toId: 'y' };
        const positions = new Map<string, { x: number; y: number }>();

        const result = buildCanvasEdge(edge, positions);

        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Missing position'));
        expect(result.fromNode).toBe('x');
        expect(result.toNode).toBe('y');
        warnSpy.mockRestore();
    });

    it('serializeCanvas should produce valid JSON with nodes and edges', () => {
        const data: CanvasData = {
            nodes: [{ id: '1', type: 'text', x: 0, y: 0, width: 400, height: 200, text: 'Hello' }],
            edges: []
        };

        const serialized = serializeCanvas(data);
        const parsed = JSON.parse(serialized);
        expect(parsed.nodes).toHaveLength(1);
        expect(parsed.nodes[0].text).toBe('Hello');
    });

    it('writeCanvasFile should auto-increment when file exists', async () => {
        const existing = new Set<string>(['Canvas/Canvas.canvas']);
        const app = createMockApp(existing);
        const data: CanvasData = { nodes: [], edges: [] };

        const result = await writeCanvasFile(app, 'Canvas', 'Canvas', data);
        expect(result.success).toBe(true);
        expect(result.filePath).toBe('Canvas/Canvas 2.canvas');
    });

    it('writeCanvasFile should succeed when no collision', async () => {
        const existing = new Set<string>();
        const app = createMockApp(existing);
        const data: CanvasData = { nodes: [], edges: [] };

        const result = await writeCanvasFile(app, 'Canvas', 'My Board', data);
        expect(result.success).toBe(true);
        expect(result.filePath).toBe('Canvas/My Board.canvas');
    });

    it('writeCanvasFile should return error on failure', async () => {
        const app = {
            vault: {
                getAbstractFileByPath: () => null,
                createFolder: async () => { throw new Error('disk full'); },
                create: async () => { throw new Error('disk full'); }
            }
        } as any;
        const data: CanvasData = { nodes: [], edges: [] };

        const result = await writeCanvasFile(app, 'Canvas', 'Test', data);
        expect(result.success).toBe(false);
        expect(result.error).toContain('disk full');
    });
});
