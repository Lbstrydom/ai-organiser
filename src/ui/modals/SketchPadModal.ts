import { Editor, Modal, Notice, Platform, TFile, setIcon } from 'obsidian';
import getStroke from 'perfect-freehand';
import AIOrganiserPlugin from '../../main';
import { getSketchOutputFullPath } from '../../core/settings';
import { insertAtCursor } from '../../utils/editorUtils';
import { withBusyIndicator } from '../../utils/busyIndicator';
import { StrokeManager, type SketchStroke } from '../../services/sketch/strokeManager';
import { buildSketchEmbed, cropCanvasToContent, exportSketchToVault } from '../../services/sketch/sketchExport';
import { VisionService } from '../../services/visionService';

type SketchTool = 'pen' | 'eraser';

const CANVAS_WIDTH = 4096;
const CANVAS_HEIGHT = 3072;
/** CSS display size = half backing for retina-quality rendering */
const CANVAS_CSS_WIDTH = CANVAS_WIDTH / 2;
const CANVAS_CSS_HEIGHT = CANVAS_HEIGHT / 2;

interface ToolButtonRefs {
    undo?: HTMLButtonElement;
    redo?: HTMLButtonElement;
    pen?: HTMLButtonElement;
    eraser?: HTMLButtonElement;
}

export class SketchPadModal extends Modal {
    private canvasEl!: HTMLCanvasElement;
    private ctx!: CanvasRenderingContext2D;
    private strokeManager = new StrokeManager();
    private pointerId: number | null = null;
    private activeTool: SketchTool = 'pen';
    private activeColor: string;
    private activeWidth: number;
    private stylusSeen = false;
    private renderQueued = false;
    private buttonRefs: ToolButtonRefs = {};

    constructor(
        private plugin: AIOrganiserPlugin,
        private editor: Editor
    ) {
        super(plugin.app);
        this.activeColor = plugin.settings.sketchDefaultPenColour;
        this.activeWidth = plugin.settings.sketchDefaultPenWidth;
    }

    onOpen(): void {
        const t = this.plugin.t.sketch;
        this.contentEl.empty();
        this.contentEl.addClass('ai-organiser-sketch-modal');
        if (Platform.isMobile) {
            this.modalEl.addClass('ai-organiser-sketch-mobile');
        }

        const header = this.contentEl.createEl('div', { cls: 'ai-organiser-sketch-toolbar' });
        this.createMainButtons(header);
        this.createStyleButtons(header);

        const canvasWrap = this.contentEl.createEl('div', { cls: 'ai-organiser-sketch-canvas-wrap' });
        this.canvasEl = canvasWrap.createEl('canvas', { cls: 'ai-organiser-sketch-canvas' });
        this.canvasEl.width = CANVAS_WIDTH;
        this.canvasEl.height = CANVAS_HEIGHT;
        this.canvasEl.setCssProps({ '--dynamic-width': `${CANVAS_CSS_WIDTH}px` });
        this.canvasEl.setCssProps({ '--dynamic-height': `${CANVAS_CSS_HEIGHT}px` });
        this.canvasEl.addClass('ai-organiser-touch-none');

        const ctx = this.canvasEl.getContext('2d');
        if (!ctx) {
            new Notice(t.saveFailed || 'Failed to initialize sketch canvas');
            this.close();
            return;
        }
        this.ctx = ctx;
        this.bindPointerEvents();
        this.render();
    }

    onClose(): void {
        if (this.canvasEl) {
            this.canvasEl.removeEventListener('pointerdown', this.onPointerDown);
            this.canvasEl.removeEventListener('pointermove', this.onPointerMove);
            this.canvasEl.removeEventListener('pointerup', this.onPointerUpOrCancel);
            this.canvasEl.removeEventListener('pointercancel', this.onPointerUpOrCancel);
            this.canvasEl.removeEventListener('pointerleave', this.onPointerUpOrCancel);
        }
        this.contentEl.empty();
    }

    private createMainButtons(container: HTMLElement): void {
        const t = this.plugin.t.sketch;
        this.buttonRefs.undo = this.makeButton(container, 'undo-2', t.undo || 'Undo', () => {
            this.strokeManager.undo();
            this.requestRender();
            this.updateButtonStates();
        });
        this.buttonRefs.redo = this.makeButton(container, 'redo-2', t.redo || 'Redo', () => {
            this.strokeManager.redo();
            this.requestRender();
            this.updateButtonStates();
        });

        this.buttonRefs.pen = this.makeButton(container, 'pen-tool', t.pen || 'Pen', () => {
            this.activeTool = 'pen';
            this.updateButtonStates();
        });
        this.buttonRefs.eraser = this.makeButton(container, 'eraser', t.eraser || 'Eraser', () => {
            this.activeTool = 'eraser';
            this.updateButtonStates();
        });

        this.makeButton(container, 'trash-2', t.clear || 'Clear', () => {
            this.strokeManager.clear();
            this.requestRender();
            this.updateButtonStates();
        });
        this.makeButton(container, 'check', t.done || 'Done', () => void this.saveAndClose(false), 'mod-cta');
        this.makeButton(container, 'sparkles', t.doneAndDigitise || 'Done & Digitise', () => void this.saveAndClose(true), 'mod-cta');
        this.updateButtonStates();
    }

    private createStyleButtons(container: HTMLElement): void {
        const colorBar = container.createEl('div', { cls: 'ai-organiser-sketch-style-row' });
        // UX-10: extended from 3 → 6 colours so colour-coding workflows
        // (done / question / insight) have the staple palette available.
        const colors = ['#000000', '#2563eb', '#dc2626', '#16a34a', '#ca8a04', '#9333ea'];
        for (const color of colors) {
            const btn = colorBar.createEl('button', { cls: 'ai-organiser-sketch-color ai-organiser-color-swatch' });
            btn.setCssProps({ '--swatch-color': color });
            btn.title = color;
            if (color.toLowerCase() === this.activeColor.toLowerCase()) {
                btn.addClass('is-active');
            }
            btn.onclick = () => {
                this.activeColor = color;
                this.activeTool = 'pen';
                colorBar.querySelectorAll('.ai-organiser-sketch-color').forEach((el) => el.classList.remove('is-active'));
                btn.classList.add('is-active');
                this.updateButtonStates();
            };
        }

        const widthBar = container.createEl('div', { cls: 'ai-organiser-sketch-style-row' });
        const t2 = this.plugin.t.sketch;
        const widthLabels: Record<number, string> = {
            2: t2.thin || 'Thin',
            3: t2.medium || 'Med',
            5: t2.thick || 'Thick'
        };
        const widths = [2, 3, 5];
        for (const width of widths) {
            const btn = widthBar.createEl('button', {
                cls: 'ai-organiser-sketch-width',
                text: widthLabels[width]
            });
            if (width === this.activeWidth) {
                btn.addClass('is-active');
            }
            btn.onclick = () => {
                this.activeWidth = width;
                this.activeTool = 'pen';
                widthBar.querySelectorAll('.ai-organiser-sketch-width').forEach((el) => el.classList.remove('is-active'));
                btn.classList.add('is-active');
                this.updateButtonStates();
            };
        }
    }

    private makeButton(
        container: HTMLElement,
        icon: string,
        label: string,
        onClick: () => void,
        cls?: string
    ): HTMLButtonElement {
        const btn = container.createEl('button', { cls: `ai-organiser-sketch-btn ${cls || ''}`.trim() });
        const iconEl = btn.createEl('span', { cls: 'ai-organiser-sketch-btn-icon' });
        setIcon(iconEl, icon);
        btn.createEl('span', { text: label });
        btn.onclick = onClick;
        return btn;
    }

    private updateButtonStates(): void {
        this.buttonRefs.undo?.classList.toggle('is-disabled', !this.strokeManager.canUndo());
        this.buttonRefs.redo?.classList.toggle('is-disabled', !this.strokeManager.canRedo());
        this.buttonRefs.pen?.classList.toggle('is-active', this.activeTool === 'pen');
        this.buttonRefs.eraser?.classList.toggle('is-active', this.activeTool === 'eraser');
    }

    private bindPointerEvents(): void {
        this.canvasEl.addEventListener('pointerdown', this.onPointerDown);
        this.canvasEl.addEventListener('pointermove', this.onPointerMove);
        this.canvasEl.addEventListener('pointerup', this.onPointerUpOrCancel);
        this.canvasEl.addEventListener('pointercancel', this.onPointerUpOrCancel);
        this.canvasEl.addEventListener('pointerleave', this.onPointerUpOrCancel);
    }

    private onPointerDown = (event: PointerEvent): void => {
        if (event.pointerType === 'pen' && !this.stylusSeen) {
            this.stylusSeen = true;
            // Stylus detected: let touch gestures scroll the canvas wrapper instead of drawing
            this.canvasEl.addClass('ai-organiser-sketch-canvas-stylus');
        }
        if (this.stylusSeen && event.pointerType === 'touch') {
            return;
        }
        if (event.pointerType === 'mouse' && event.button !== 0) {
            return;
        }

        event.preventDefault();
        this.pointerId = event.pointerId;
        this.canvasEl.setPointerCapture?.(event.pointerId);
        const point = this.getCanvasPoint(event);

        if (this.activeTool === 'eraser') {
            this.strokeManager.eraseAt(point.x, point.y, this.activeWidth * 6);
        } else {
            this.strokeManager.startStroke(
                point.x,
                point.y,
                point.pressure,
                this.activeColor,
                this.activeWidth
            );
        }
        this.requestRender();
        this.updateButtonStates();
    };

    private onPointerMove = (event: PointerEvent): void => {
        if (this.pointerId === null || event.pointerId !== this.pointerId) return;
        if (event.buttons === 0 && event.pointerType !== 'pen') return;
        if (this.stylusSeen && event.pointerType === 'touch') return;
        event.preventDefault();

        const point = this.getCanvasPoint(event);
        if (this.activeTool === 'eraser') {
            this.strokeManager.eraseAt(point.x, point.y, this.activeWidth * 6);
        } else {
            this.strokeManager.addPoint(point.x, point.y, point.pressure);
        }
        this.requestRender();
    };

    private onPointerUpOrCancel = (event: PointerEvent): void => {
        if (this.pointerId === null || event.pointerId !== this.pointerId) return;
        event.preventDefault();

        if (this.activeTool === 'pen') {
            this.strokeManager.commitStroke();
        }
        this.pointerId = null;
        this.requestRender();
        this.updateButtonStates();
    };

    private getCanvasPoint(event: PointerEvent): { x: number; y: number; pressure: number } {
        const rect = this.canvasEl.getBoundingClientRect();
        const scaleX = this.canvasEl.width / rect.width;
        const scaleY = this.canvasEl.height / rect.height;
        const x = (event.clientX - rect.left) * scaleX;
        const y = (event.clientY - rect.top) * scaleY;
        const pressure = event.pressure && event.pressure > 0 ? event.pressure : 0.5;
        return { x, y, pressure };
    }

    private requestRender(): void {
        if (this.renderQueued) return;
        this.renderQueued = true;
        requestAnimationFrame(() => {
            this.renderQueued = false;
            this.render();
        });
    }

    private render(): void {
        this.ctx.fillStyle = '#ffffff';
        this.ctx.fillRect(0, 0, this.canvasEl.width, this.canvasEl.height);

        for (const stroke of this.strokeManager.getStrokes()) {
            this.renderStroke(stroke);
        }
        const current = this.strokeManager.getCurrentStroke();
        if (current) {
            this.renderStroke(current);
        }
    }

    private renderStroke(stroke: SketchStroke): void {
        const points = stroke.points;
        if (points.length === 0) return;

        const inputPoints = points.map(p => [p.x, p.y, p.pressure] as [number, number, number]);
        const outlinePoints = getStroke(inputPoints, {
            size: stroke.width * 3,
            thinning: 0.5,
            smoothing: 0.5,
            streamline: 0.5,
            simulatePressure: false
        });

        if (outlinePoints.length < 2) return;

        this.ctx.fillStyle = stroke.color;
        this.ctx.beginPath();
        this.ctx.moveTo(outlinePoints[0][0], outlinePoints[0][1]);
        for (let i = 1; i < outlinePoints.length; i++) {
            this.ctx.lineTo(outlinePoints[i][0], outlinePoints[i][1]);
        }
        this.ctx.closePath();
        this.ctx.fill();
    }

    private async saveAndClose(forceDigitise: boolean): Promise<void> {
        const t = this.plugin.t.sketch;
        if (!this.strokeManager.hasContent()) {
            new Notice(t.noContent || 'Draw something before saving');
            return;
        }

        try {
            const bounds = this.strokeManager.getContentBounds();
            const exportCanvas = bounds
                ? cropCanvasToContent(this.canvasEl, bounds)
                : this.canvasEl;
            const file = await exportSketchToVault(
                this.plugin.app,
                exportCanvas,
                getSketchOutputFullPath(this.plugin.settings)
            );
            insertAtCursor(this.editor, buildSketchEmbed(file));
            new Notice(t.saved || 'Sketch saved');
            this.close();

            if (forceDigitise || this.plugin.settings.sketchAutoDigitise) {
                await withBusyIndicator(this.plugin, async () => {
                    const visionService = new VisionService(this.plugin);
                    const digitiseResult = await visionService.digitise(file);
                    const imageDataUrl = await this.loadImageDataUrl(file);
                    const { VisionPreviewModal } = await import('./VisionPreviewModal');
                    new VisionPreviewModal(this.plugin, digitiseResult, imageDataUrl, (action) => {
                        if (action === 'insert') {
                            new Notice(this.plugin.t.digitisation?.inserted || 'Digitised content inserted');
                        } else if (action === 'copy') {
                            new Notice(this.plugin.t.digitisation?.copied || 'Copied to clipboard');
                        }
                    }).open();
                }, this.plugin.t.digitisation?.digitising || 'Digitising image...');
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            new Notice(`${t.saveFailed || 'Failed to save sketch'}: ${message}`);
        }
    }

    private async loadImageDataUrl(file: TFile): Promise<string> {
        const arrayBuffer = await this.app.vault.readBinary(file);
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        for (const byte of bytes) {
            binary += String.fromCodePoint(byte);
        }
        return `data:image/png;base64,${btoa(binary)}`;
    }
}
