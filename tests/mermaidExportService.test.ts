/**
 * MermaidExportService tests
 *
 * Covers: .mermaid file export, SVG extraction, canvas creation/append.
 * Mocks: obsidian (App, Notice, TFile, normalizePath), canvasUtils (generateId, writeCanvasFile).
 */

// ── Module-level mocks (hoisted by vitest) ──

const mockGenerateId = vi.fn().mockReturnValue('mock-id-0001');
const mockWriteCanvasFile = vi.fn().mockResolvedValue({ success: true, filePath: 'Canvas/diagram.canvas' });

vi.mock('obsidian', async () => {
    const actual = await vi.importActual('./mocks/obsidian');
    return { ...actual };
});

vi.mock('../src/services/canvas/canvasUtils', () => ({
    generateId: (...args: unknown[]) => mockGenerateId(...args),
    writeCanvasFile: (...args: unknown[]) => mockWriteCanvasFile(...args),
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MermaidExportService } from '../src/services/mermaidExportService';
import { App, TFile, Notice, mockNotices, clearMockNotices } from './mocks/obsidian';

// ── Helpers ──

function makePlugin(overrides?: Partial<{ pluginFolder: string; canvasOutputFolder: string }>) {
    return {
        settings: {
            pluginFolder: overrides?.pluginFolder ?? 'AI-Organiser',
            canvasOutputFolder: overrides?.canvasOutputFolder ?? 'Canvas',
        },
        t: {
            modals: {
                mermaidChat: {
                    exportSavedMermaid: 'Saved as .mermaid',
                    exportSavedSVG: 'Saved as SVG',
                    exportSavedPNG: 'Saved as PNG',
                    exportSavedCanvas: 'Added to canvas',
                    exportFailed: 'Export failed',
                },
            },
        },
    } as any;
}

function makeApp(overrides?: {
    getAbstractFileByPath?: (path: string) => any;
    read?: (file: TFile) => Promise<string>;
}) {
    const app = new App();
    app.vault.create = vi.fn().mockResolvedValue(new TFile());
    app.vault.createBinary = vi.fn().mockResolvedValue(new TFile());
    app.vault.modify = vi.fn().mockResolvedValue(undefined);
    app.vault.createFolder = vi.fn().mockResolvedValue(undefined);
    app.vault.getAbstractFileByPath = overrides?.getAbstractFileByPath ?? vi.fn().mockReturnValue(null);
    app.vault.read = overrides?.read ?? vi.fn().mockResolvedValue('{}');
    app.workspace.openLinkText = vi.fn().mockResolvedValue(undefined);
    return app;
}

// ── Setup ──

beforeEach(() => {
    clearMockNotices();
    mockGenerateId.mockReset().mockReturnValue('mock-id-0001');
    mockWriteCanvasFile.mockReset().mockResolvedValue({ success: true, filePath: 'Canvas/diagram.canvas' });
});

// ── exportMermaidFile ──────────────────────────────────────────────────────

describe('exportMermaidFile', () => {
    it('calls vault.create with .mermaid extension', async () => {
        const app = makeApp();
        const svc = new MermaidExportService(app, makePlugin());

        await svc.exportMermaidFile('flowchart TD\n  A-->B', 'my-diagram');

        expect(app.vault.create).toHaveBeenCalledOnce();
        const path = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(path).toMatch(/\.mermaid$/);
    });

    it('saves the raw mermaid code as file content', async () => {
        const app = makeApp();
        const svc = new MermaidExportService(app, makePlugin());
        const code = 'graph LR\n  X-->Y';

        await svc.exportMermaidFile(code, 'test');

        const content = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
        expect(content).toBe(code);
    });

    it('includes baseName in the output path', async () => {
        const app = makeApp();
        const svc = new MermaidExportService(app, makePlugin());

        await svc.exportMermaidFile('graph TD', 'flow-chart');

        const path = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(path).toContain('flow-chart.mermaid');
    });

    it('uses Diagrams subfolder under plugin folder', async () => {
        const app = makeApp();
        const svc = new MermaidExportService(app, makePlugin({ pluginFolder: 'MyPlugin' }));

        await svc.exportMermaidFile('graph TD', 'test');

        const path = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(path).toMatch(/^MyPlugin\/Diagrams\//);
    });
});

// ── exportSVG ──────────────────────────────────────────────────────────────

describe('exportSVG', () => {
    it('shows failure notice when previewEl is null', async () => {
        const app = makeApp();
        const svc = new MermaidExportService(app, makePlugin());

        await svc.exportSVG(null, 'test');

        expect(mockNotices).toContain('Export failed');
        expect(app.vault.create).not.toHaveBeenCalled();
    });

    it('shows failure notice when previewEl has no SVG child', async () => {
        const app = makeApp();
        const svc = new MermaidExportService(app, makePlugin());
        const el = { querySelector: () => null } as unknown as HTMLElement;

        await svc.exportSVG(el, 'test');

        expect(mockNotices).toContain('Export failed');
        expect(app.vault.create).not.toHaveBeenCalled();
    });

    it('injects <title> into SVG string when altText is provided', async () => {
        const app = makeApp();
        const svc = new MermaidExportService(app, makePlugin());

        // Create a minimal mock SVG element and XMLSerializer
        const fakeSvg = {};
        const el = { querySelector: () => fakeSvg } as unknown as HTMLElement;

        // Mock XMLSerializer globally for this test
        const originalXMLSerializer = globalThis.XMLSerializer;
        globalThis.XMLSerializer = class {
            serializeToString() {
                return '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
            }
        } as any;

        try {
            await svc.exportSVG(el, 'test', 'My diagram description');

            const content = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
            expect(content).toContain('<title>My diagram description</title>');
        } finally {
            globalThis.XMLSerializer = originalXMLSerializer;
        }
    });
});

// ── exportToCanvas ─────────────────────────────────────────────────────────

describe('exportToCanvas', () => {
    it('creates CanvasData with text node containing mermaid fence', async () => {
        const app = makeApp();
        const svc = new MermaidExportService(app, makePlugin());
        const code = 'flowchart TD\n  A-->B';

        await svc.exportToCanvas(code, null, 'test');

        expect(mockWriteCanvasFile).toHaveBeenCalledOnce();
        const canvasData = mockWriteCanvasFile.mock.calls[0][3];
        const textNode = canvasData.nodes.find((n: any) => n.type === 'text');
        expect(textNode).toBeDefined();
        expect(textNode.text).toBe('```mermaid\nflowchart TD\n  A-->B\n```');
    });

    it('creates canvas with correct structure (nodes array and edges array)', async () => {
        const app = makeApp();
        const svc = new MermaidExportService(app, makePlugin());

        await svc.exportToCanvas('graph TD', null, 'test');

        const canvasData = mockWriteCanvasFile.mock.calls[0][3];
        expect(canvasData).toHaveProperty('nodes');
        expect(canvasData).toHaveProperty('edges');
        expect(Array.isArray(canvasData.nodes)).toBe(true);
        expect(Array.isArray(canvasData.edges)).toBe(true);
    });

    it('includes source file as linked node when provided', async () => {
        const app = makeApp();
        const svc = new MermaidExportService(app, makePlugin());
        const sourceFile = new TFile();
        sourceFile.path = 'Notes/source-note.md';

        // Return distinct IDs for source node, text node, and edge
        let idCounter = 0;
        mockGenerateId.mockImplementation(() => `id-${idCounter++}`);

        await svc.exportToCanvas('graph TD', sourceFile, 'test');

        const canvasData = mockWriteCanvasFile.mock.calls[0][3];
        const fileNode = canvasData.nodes.find((n: any) => n.type === 'file');
        expect(fileNode).toBeDefined();
        expect(fileNode.file).toBe('Notes/source-note.md');
        // Should have an edge connecting source to text node
        expect(canvasData.edges.length).toBe(1);
        expect(canvasData.edges[0].fromSide).toBe('right');
        expect(canvasData.edges[0].toSide).toBe('left');
    });

    it('uses CANVAS_NODE_WIDTH (600) and CANVAS_NODE_HEIGHT (400) for node dimensions', async () => {
        const app = makeApp();
        const svc = new MermaidExportService(app, makePlugin());

        await svc.exportToCanvas('graph TD', null, 'test');

        const canvasData = mockWriteCanvasFile.mock.calls[0][3];
        const textNode = canvasData.nodes.find((n: any) => n.type === 'text');
        expect(textNode.width).toBe(600);
        expect(textNode.height).toBe(400);
    });
});

// ── appendToCanvas ─────────────────────────────────────────────────────────

describe('appendToCanvas', () => {
    it('reads existing canvas JSON and adds a new text node', async () => {
        const existingCanvas = JSON.stringify({
            nodes: [
                { id: 'existing-1', type: 'text', x: 0, y: 0, width: 600, height: 400, text: 'old' },
            ],
            edges: [],
        });
        const app = makeApp({ read: vi.fn().mockResolvedValue(existingCanvas) });
        const svc = new MermaidExportService(app, makePlugin());
        const canvasFile = new TFile();
        canvasFile.path = 'Canvas/test.canvas';

        await svc.appendToCanvas('graph LR\n  X-->Y', canvasFile);

        expect(app.vault.modify).toHaveBeenCalledOnce();
        const savedContent = JSON.parse((app.vault.modify as ReturnType<typeof vi.fn>).mock.calls[0][1]);
        expect(savedContent.nodes).toHaveLength(2);
        const newNode = savedContent.nodes[1];
        expect(newNode.type).toBe('text');
        expect(newNode.text).toBe('```mermaid\ngraph LR\n  X-->Y\n```');
    });

    it('positions new node at maxRight + 60 (NODE_GAP)', async () => {
        const existingCanvas = JSON.stringify({
            nodes: [
                { id: 'n1', type: 'text', x: 100, y: 0, width: 600, height: 400, text: 'first' },
            ],
            edges: [],
        });
        const app = makeApp({ read: vi.fn().mockResolvedValue(existingCanvas) });
        const svc = new MermaidExportService(app, makePlugin());
        const canvasFile = new TFile();
        canvasFile.path = 'Canvas/test.canvas';

        await svc.appendToCanvas('graph TD', canvasFile);

        const savedContent = JSON.parse((app.vault.modify as ReturnType<typeof vi.fn>).mock.calls[0][1]);
        const newNode = savedContent.nodes[1];
        // maxRight = 100 (x) + 600 (width) = 700, new x = 700 + 60 = 760
        expect(newNode.x).toBe(760);
    });

    it('positions first node correctly when canvas has multiple existing nodes', async () => {
        const existingCanvas = JSON.stringify({
            nodes: [
                { id: 'n1', type: 'text', x: 0, y: 0, width: 600, height: 400, text: 'a' },
                { id: 'n2', type: 'text', x: 700, y: 0, width: 600, height: 400, text: 'b' },
            ],
            edges: [],
        });
        const app = makeApp({ read: vi.fn().mockResolvedValue(existingCanvas) });
        const svc = new MermaidExportService(app, makePlugin());
        const canvasFile = new TFile();
        canvasFile.path = 'Canvas/test.canvas';

        await svc.appendToCanvas('graph TD', canvasFile);

        const savedContent = JSON.parse((app.vault.modify as ReturnType<typeof vi.fn>).mock.calls[0][1]);
        const newNode = savedContent.nodes[2];
        // maxRight = max(0+600, 700+600) = 1300, new x = 1300 + 60 = 1360
        expect(newNode.x).toBe(1360);
    });

    it('handles empty canvas (no existing nodes) gracefully', async () => {
        const existingCanvas = JSON.stringify({
            nodes: [],
            edges: [],
        });
        const app = makeApp({ read: vi.fn().mockResolvedValue(existingCanvas) });
        const svc = new MermaidExportService(app, makePlugin());
        const canvasFile = new TFile();
        canvasFile.path = 'Canvas/test.canvas';

        await svc.appendToCanvas('graph TD', canvasFile);

        expect(app.vault.modify).toHaveBeenCalledOnce();
        const savedContent = JSON.parse((app.vault.modify as ReturnType<typeof vi.fn>).mock.calls[0][1]);
        expect(savedContent.nodes).toHaveLength(1);
        const newNode = savedContent.nodes[0];
        // maxRight starts at 0, so x = 0 + 60 = 60
        expect(newNode.x).toBe(60);
        expect(newNode.width).toBe(600);
        expect(newNode.height).toBe(400);
    });
});
