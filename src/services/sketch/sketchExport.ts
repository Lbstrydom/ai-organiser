import { App, TFile, normalizePath } from 'obsidian';
import { ensureFolderExists, getAvailableFilePath } from '../../utils/minutesUtils';

export const SKETCH_EXPORT_MIME = 'image/png';
export const SKETCH_EXPORT_EXT = '.png';

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (!blob) {
                reject(new Error('Failed to export sketch'));
                return;
            }
            resolve(blob);
        }, SKETCH_EXPORT_MIME);
    });
}

/** Crop a canvas to the bounding box of drawn content with padding. */
export function cropCanvasToContent(
    source: HTMLCanvasElement,
    bounds: { minX: number; minY: number; maxX: number; maxY: number },
    padding = 60
): HTMLCanvasElement {
    const sx = Math.max(0, Math.floor(bounds.minX - padding));
    const sy = Math.max(0, Math.floor(bounds.minY - padding));
    const ex = Math.min(source.width, Math.ceil(bounds.maxX + padding));
    const ey = Math.min(source.height, Math.ceil(bounds.maxY + padding));
    const w = ex - sx;
    const h = ey - sy;

    const cropped = document.createElement('canvas');
    cropped.width = w;
    cropped.height = h;
    const ctx = cropped.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(source, sx, sy, w, h, 0, 0, w, h);
    return cropped;
}

export async function exportSketchToVault(
    app: App,
    canvas: HTMLCanvasElement,
    folderPath: string
): Promise<TFile> {
    const targetFolder = normalizePath(folderPath).trim();
    await ensureFolderExists(app.vault, targetFolder);

    const blob = await canvasToBlob(canvas);
    const arrayBuffer = await blob.arrayBuffer();
    const fileName = `sketch-${Date.now()}${SKETCH_EXPORT_EXT}`;
    const filePath = await getAvailableFilePath(app.vault, targetFolder, fileName);

    return app.vault.createBinary(filePath, arrayBuffer);
}

export function buildSketchEmbed(file: TFile): string {
    return `![[${file.path}]]`;
}
