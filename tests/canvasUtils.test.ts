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

    it('writeCanvasFile should auto-increment when file exists', async () => {
        const existing = new Set<string>(['Canvas/Canvas.canvas']);
        const app = createMockApp(existing);
        const data: CanvasData = { nodes: [], edges: [] };

        const result = await writeCanvasFile(app, 'Canvas', 'Canvas', data);
        expect(result.success).toBe(true);
        expect(result.filePath).toBe('Canvas/Canvas 2.canvas');
    });
});
