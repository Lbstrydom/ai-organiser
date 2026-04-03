/**
 * MermaidExportService
 * Handles export of Mermaid diagrams from the chat modal.
 *
 * Export targets:
 *  - .mermaid text file (vault)
 *  - SVG file (extracted from rendered DOM)
 *  - PNG file (SVG → Canvas API → blob)
 *  - Obsidian Canvas node (new .canvas file with a text node)
 */

import { App, Notice, normalizePath, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { generateId, writeCanvasFile } from './canvas/canvasUtils';
import type { CanvasData } from './canvas/types';

const CANVAS_NODE_WIDTH = 600;
const CANVAS_NODE_HEIGHT = 400;

export class MermaidExportService {
    constructor(
        private readonly app: App,
        private readonly plugin: AIOrganiserPlugin,
    ) {}

    // ── .mermaid file ────────────────────────────────────────────────────────────

    /**
     * Save the raw mermaid code as a .mermaid text file in the vault.
     */
    async exportMermaidFile(code: string, baseName: string = 'diagram'): Promise<void> {
        const t = this.plugin.t.modals.mermaidChat;
        try {
            const folder = this.getOutputFolder();
            await this.ensureFolder(folder);
            const path = normalizePath(`${folder}/${baseName}.mermaid`);
            const safePath = await this.getAvailablePath(path, '.mermaid');
            await this.app.vault.create(safePath, code);
            new Notice(t.exportSavedMermaid);
        } catch {
            new Notice(t.exportFailed);
        }
    }

    // ── SVG ──────────────────────────────────────────────────────────────────

    /**
     * Extract the rendered SVG element from an Obsidian preview container
     * and save it to the vault.
     *
     * NOTE: `mermaidChatExportTheme` setting is not yet applied here because
     * the SVG is extracted from Obsidian's built-in MarkdownRenderer, which
     * uses Obsidian's own theme. Applying a custom Mermaid theme would require
     * CDN-based rendering (planned in §4.3.1 of the Mermaid chat plan).
     */
    async exportSVG(
        previewEl: HTMLElement | null,
        baseName: string = 'diagram',
        altText?: string,
    ): Promise<void> {
        const t = this.plugin.t.modals.mermaidChat;
        try {
            const svgEl = previewEl ? this.extractSVGElement(previewEl) : null;
            if (!svgEl) {
                new Notice(t.exportFailed);
                return;
            }
            let svgContent = this.svgToString(svgEl);
            // §4.3.5 Inject <title> as first child of <svg> for accessibility
            if (altText) {
                const escaped = altText
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;');
                const insertAt = svgContent.indexOf('>') + 1;
                svgContent = svgContent.slice(0, insertAt) +
                    `<title>${escaped}</title>` +
                    svgContent.slice(insertAt);
            }
            const folder = this.getOutputFolder();
            await this.ensureFolder(folder);
            const path = normalizePath(`${folder}/${baseName}.svg`);
            const safePath = await this.getAvailablePath(path, '.svg');
            await this.app.vault.create(safePath, svgContent);
            new Notice(t.exportSavedSVG);
        } catch {
            new Notice(t.exportFailed);
        }
    }

    // ── PNG ──────────────────────────────────────────────────────────────────

    /**
     * Convert the rendered SVG to PNG and save to vault.
     * Scale controls the pixel density (default 2 for retina).
     */
    async exportPNG(
        previewEl: HTMLElement | null,
        scale: number = 2,
        baseName: string = 'diagram',
        altText?: string,
    ): Promise<void> {
        const t = this.plugin.t.modals.mermaidChat;
        try {
            const svgEl = previewEl ? this.extractSVGElement(previewEl) : null;
            if (!svgEl) {
                new Notice(t.exportFailed);
                return;
            }
            const blob = await this.svgToPngBlob(svgEl, scale);
            if (!blob) {
                new Notice(t.exportFailed);
                return;
            }
            const buffer = await blob.arrayBuffer();
            const folder = this.getOutputFolder();
            await this.ensureFolder(folder);
            const path = normalizePath(`${folder}/${baseName}.png`);
            const safePath = await this.getAvailablePath(path, '.png');
            await this.app.vault.createBinary(safePath, buffer);
            // §4.3.5 Save alt-text as companion sidecar file
            if (altText) {
                const altPath = safePath.replace(/\.png$/, '.alt.txt');
                await this.app.vault.create(altPath, altText);
            }
            new Notice(t.exportSavedPNG);
        } catch {
            new Notice(t.exportFailed);
        }
    }

    // ── Canvas ───────────────────────────────────────────────────────────────

    /**
     * Create a new .canvas file with the diagram as a text node.
     * Uses the text type with a fenced mermaid code block so Obsidian renders it.
     */
    async exportToCanvas(
        code: string,
        sourceFile: TFile | null,
        baseName: string = 'diagram',
    ): Promise<void> {
        const t = this.plugin.t.modals.mermaidChat;
        try {
            const nodeId = generateId();
            const nodeText = '```mermaid\n' + code + '\n```';

            const canvasData: CanvasData = {
                nodes: [
                    {
                        id: nodeId,
                        type: 'text',
                        x: 0,
                        y: 0,
                        width: CANVAS_NODE_WIDTH,
                        height: CANVAS_NODE_HEIGHT,
                        text: nodeText,
                    },
                ],
                edges: [],
            };

            // Optionally link the source note as a file node to the left
            if (sourceFile) {
                const sourceId = generateId();
                canvasData.nodes.unshift({
                    id: sourceId,
                    type: 'file',
                    file: sourceFile.path,
                    x: -(CANVAS_NODE_WIDTH + 80),
                    y: 0,
                    width: CANVAS_NODE_WIDTH,
                    height: CANVAS_NODE_HEIGHT,
                });
                canvasData.edges.push({
                    id: generateId(),
                    fromNode: sourceId,
                    toNode: nodeId,
                    fromSide: 'right',
                    toSide: 'left',
                });
            }

            const canvasFolder = this.getCanvasFolder();
            const result = await writeCanvasFile(this.app, canvasFolder, baseName, canvasData);
            if (result.success) {
                new Notice(t.exportSavedCanvas);
                if (result.filePath) {
                    await this.app.workspace.openLinkText(result.filePath, '', false);
                }
            } else {
                new Notice(t.exportFailed);
            }
        } catch {
            new Notice(t.exportFailed);
        }
    }

    /**
     * Append a Mermaid diagram as a new text node to an existing Canvas file.
     * Positions the node to the right of existing content.
     */
    async appendToCanvas(code: string, canvasFile: TFile): Promise<void> {
        const t = this.plugin.t.modals.mermaidChat;
        try {
            const raw = await this.app.vault.read(canvasFile);
            const canvasData: CanvasData = JSON.parse(raw);

            // Find rightmost node edge to position the new node beside it
            let maxRight = 0;
            for (const node of canvasData.nodes) {
                const right = (node.x ?? 0) + (node.width ?? CANVAS_NODE_WIDTH);
                if (right > maxRight) maxRight = right;
            }

            const nodeId = generateId();
            const nodeText = '```mermaid\n' + code + '\n```';
            canvasData.nodes.push({
                id: nodeId,
                type: 'text',
                x: maxRight + 60, // NODE_GAP
                y: 0,
                width: CANVAS_NODE_WIDTH,
                height: CANVAS_NODE_HEIGHT,
                text: nodeText,
            });

            await this.app.vault.modify(canvasFile, JSON.stringify(canvasData, null, '\t'));
            new Notice(t.exportSavedCanvas);
            await this.app.workspace.openLinkText(canvasFile.path, '', false);
        } catch {
            new Notice(t.exportFailed);
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private extractSVGElement(previewEl: HTMLElement): SVGSVGElement | null {
        return previewEl.querySelector<SVGSVGElement>('svg') ?? null;
    }

    private svgToString(svgEl: SVGSVGElement): string {
        const serializer = new XMLSerializer();
        return serializer.serializeToString(svgEl);
    }

    private async svgToPngBlob(svgEl: SVGSVGElement, scale: number): Promise<Blob | null> {
        return new Promise((resolve) => {
            try {
                const bbox = svgEl.getBoundingClientRect();
                const width = Math.max(bbox.width || 400, 100) * scale;
                const height = Math.max(bbox.height || 300, 100) * scale;

                const svgString = this.svgToString(svgEl);
                const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
                const url = URL.createObjectURL(blob);

                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    if (!ctx) {
                        URL.revokeObjectURL(url);
                        resolve(null);
                        return;
                    }
                    ctx.drawImage(img, 0, 0, width, height);
                    URL.revokeObjectURL(url);
                    canvas.toBlob((pngBlob) => resolve(pngBlob), 'image/png');
                };
                img.onerror = () => {
                    URL.revokeObjectURL(url);
                    resolve(null);
                };
                img.src = url;
            } catch {
                resolve(null);
            }
        });
    }

    private getOutputFolder(): string {
        const base = this.plugin.settings.pluginFolder || 'AI-Organiser';
        return normalizePath(`${base}/Diagrams`);
    }

    private getCanvasFolder(): string {
        const base = this.plugin.settings.pluginFolder || 'AI-Organiser';
        const canvasSub = this.plugin.settings.canvasOutputFolder || 'Canvas';
        return normalizePath(`${base}/${canvasSub}`);
    }

    private async ensureFolder(folderPath: string): Promise<void> {
        const parts = folderPath.split('/').filter(Boolean);
        let current = '';
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            if (!this.app.vault.getAbstractFileByPath(current)) {
                try {
                    await this.app.vault.createFolder(current);
                } catch (e) {
                    if (e instanceof Error && !e.message.includes('already exists')) throw e;
                }
            }
        }
    }

    private async getAvailablePath(initialPath: string, ext: string): Promise<string> {
        if (!this.app.vault.getAbstractFileByPath(initialPath)) return initialPath;
        const withoutExt = initialPath.slice(0, initialPath.length - ext.length);
        for (let i = 2; i <= 999; i++) {
            const candidate = `${withoutExt} ${i}${ext}`;
            if (!this.app.vault.getAbstractFileByPath(candidate)) return candidate;
        }
        return initialPath;
    }
}
