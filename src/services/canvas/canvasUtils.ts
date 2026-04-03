import { App, normalizePath } from 'obsidian';
import { CanvasData, CanvasEdge, CanvasNode, EdgeDescriptor, NodeDescriptor, CanvasResult } from './types';
import { DEFAULT_NODE_HEIGHT, DEFAULT_NODE_WIDTH, computeEdgeSides } from './layouts';
import { logger } from '../../utils/logger';

/**
 * Generate a unique ID for canvas nodes and edges.
 * Produces 16-character lowercase hexadecimal strings to match
 * Obsidian's native canvas ID convention.
 *
 * Note: JSON Canvas 1.0 spec only requires unique strings — this
 * format choice is for consistency with Obsidian-generated canvases.
 *
 * Falls back to base36 timestamp+random if Web Crypto API is unavailable.
 *
 * @see https://jsoncanvas.org/spec/1.0/
 * @see https://github.com/kepano/obsidian-skills (json-canvas skill)
 */
export function generateId(): string {
    if (typeof globalThis.crypto?.getRandomValues === 'function') {
        const bytes = new Uint8Array(8);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    }
    // Fallback for environments without Web Crypto API
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function buildCanvasNode(desc: NodeDescriptor, x: number, y: number): CanvasNode {
    const width = desc.width ?? DEFAULT_NODE_WIDTH;
    const height = desc.height ?? DEFAULT_NODE_HEIGHT;

    const base: CanvasNode = {
        id: desc.id,
        type: desc.type,
        x,
        y,
        width,
        height,
        color: desc.color
    };

    if (desc.type === 'file') {
        return { ...base, file: desc.file };
    }

    if (desc.type === 'link') {
        return { ...base, url: desc.url };
    }

    return { ...base, text: desc.text ?? desc.label };
}

export function buildCanvasEdge(
    desc: EdgeDescriptor,
    positions: Map<string, { x: number; y: number }>
): CanvasEdge {
    const origin = { x: 0, y: 0 };
    const fromPos = positions.get(desc.fromId);
    const toPos = positions.get(desc.toId);
    if (!fromPos || !toPos) {
        logger.warn('Canvas', `Missing position for edge: ${desc.fromId} -> ${desc.toId}`);
    }
    const sides = computeEdgeSides(fromPos ?? origin, toPos ?? origin);

    return {
        id: generateId(),
        fromNode: desc.fromId,
        toNode: desc.toId,
        fromSide: sides.fromSide,
        toSide: sides.toSide,
        label: desc.label,
        color: desc.color
    };
}

export function serializeCanvas(data: CanvasData): string {
    return JSON.stringify(data, null, 2);
}

export function sanitizeCanvasName(name: string): string {
    const sanitized = name
        .replaceAll(/[\\/:*?"<>|]/g, ' ')
        .replaceAll(/\s+/g, ' ')
        .trim();
    return sanitized || 'Canvas';
}

export async function writeCanvasFile(
    app: App,
    folder: string,
    name: string,
    data: CanvasData
): Promise<CanvasResult> {
    try {
        const vault = app.vault;
        const baseName = ensureCanvasExtension(sanitizeCanvasName(name));
        const folderPath = normalizeFolderPath(folder);

        if (folderPath) {
            await ensureFolderExists(app, folderPath);
        }

        const filePath = getAvailableCanvasPath(vault, folderPath, baseName);
        await vault.create(filePath, serializeCanvas(data));
        return { success: true, filePath };
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: message };
    }
}

export async function openCanvasFile(app: App, path: string): Promise<void> {
    await app.workspace.openLinkText(path, '', false);
}

async function ensureFolderExists(app: App, folderPath: string): Promise<void> {
    const normalized = normalizePath(folderPath);
    const parts = normalized.split('/').filter(Boolean);
    let current = '';

    for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        const existing = app.vault.getAbstractFileByPath(current);
        if (!existing) {
            try {
                await app.vault.createFolder(current);
            } catch (e) {
                if (e instanceof Error && !e.message.includes('Folder already exists')) {
                    throw e;
                }
            }
        }
    }
}

function normalizeFolderPath(folder: string): string {
    let trimmed = normalizePath(folder || '');
    while (trimmed.startsWith('/')) {
        trimmed = trimmed.slice(1);
    }
    while (trimmed.endsWith('/')) {
        trimmed = trimmed.slice(0, -1);
    }
    return trimmed;
}

function ensureCanvasExtension(name: string): string {
    return name.endsWith('.canvas') ? name : `${name}.canvas`;
}

function getAvailableCanvasPath(
    vault: App['vault'],
    folderPath: string,
    baseName: string
): string {
    const basePath = folderPath ? `${folderPath}/${baseName}` : baseName;
    if (!vault.getAbstractFileByPath(basePath)) {
        return basePath;
    }

    const extensionIndex = baseName.lastIndexOf('.');
    const stem = extensionIndex > -1 ? baseName.substring(0, extensionIndex) : baseName;
    const extension = extensionIndex > -1 ? baseName.substring(extensionIndex) : '';
    const MAX_COUNTER = 999;
    let counter = 2;

    while (counter <= MAX_COUNTER) {
        const candidate = folderPath
            ? `${folderPath}/${stem} ${counter}${extension}`
            : `${stem} ${counter}${extension}`;
        if (!vault.getAbstractFileByPath(candidate)) {
            return candidate;
        }
        counter++;
    }

    // Fallback: use the last candidate even if it exists (should never happen in practice)
    return folderPath
        ? `${folderPath}/${stem} ${MAX_COUNTER}${extension}`
        : `${stem} ${MAX_COUNTER}${extension}`;
}
