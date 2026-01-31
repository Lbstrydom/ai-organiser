import { App, TFile } from 'obsidian';
import { detectEmbeddedContent, DetectedContent } from '../../utils/embeddedContentDetector';
import { adaptiveLayout } from './layouts';
import { buildCanvasEdge, buildCanvasNode, generateId, openCanvasFile, writeCanvasFile } from './canvasUtils';
import { CanvasData, CanvasResult, EdgeDescriptor, NodeDescriptor } from './types';

export interface ContextBoardOptions {
    file: TFile;
    content: string;
    canvasFolder: string;
    openAfterCreate: boolean;
}

export async function buildContextBoard(app: App, options: ContextBoardOptions): Promise<CanvasResult> {
    const detection = detectEmbeddedContent(app, options.content, options.file);
    const sources = detection.items.filter(item => item.type !== 'image');

    if (!sources.length) {
        return { success: false, error: 'No sources detected' };
    }

    const nodes: NodeDescriptor[] = [];
    const centerId = generateId();

    nodes.push({
        id: centerId,
        label: options.file.basename,
        type: 'file',
        file: options.file.path,
        color: '5'
    });

    for (const item of sources) {
        const node = mapContentTypeToNode(item);
        nodes.push({
            ...node,
            id: generateId()
        });
    }

    const layout = adaptiveLayout(nodes.length, 0);
    const positions = new Map<string, { x: number; y: number }>();
    const canvasNodes = nodes.map((desc, index) => {
        const pos = layout[index];
        positions.set(desc.id, { x: pos.x, y: pos.y });
        return buildCanvasNode(desc, pos.x, pos.y);
    });

    const edges: EdgeDescriptor[] = nodes.slice(1).map(node => ({
        fromId: centerId,
        toId: node.id
    }));

    const canvasEdges = edges.map(edge => buildCanvasEdge(edge, positions));

    const data: CanvasData = {
        nodes: canvasNodes,
        edges: canvasEdges
    };

    const result = await writeCanvasFile(
        app,
        options.canvasFolder,
        `Context Board - ${options.file.basename}`,
        data
    );

    if (result.success && result.filePath && options.openAfterCreate) {
        await openCanvasFile(app, result.filePath);
    }

    return result;
}

export function mapContentTypeToNode(item: DetectedContent): NodeDescriptor {
    switch (item.type) {
        case 'youtube':
            return {
                id: '',
                label: item.displayName,
                type: 'link',
                url: item.url,
                color: '6'
            };
        case 'pdf':
            return buildFileOrMissingNode(item, '4');
        case 'web-link':
            return {
                id: '',
                label: item.displayName,
                type: 'link',
                url: item.url,
                color: '3'
            };
        case 'internal-link':
            return buildFileOrMissingNode(item, '5');
        case 'audio':
            return buildFileOrMissingNode(item, '2');
        case 'document':
            return buildFileOrMissingNode(item, '4');
        default:
            return buildMissingNode(item);
    }
}

function buildMissingNode(item: DetectedContent): NodeDescriptor {
    return {
        id: '',
        label: item.displayName,
        type: 'text',
        text: `Missing: ${item.displayName}`,
        color: '1'
    };
}

function buildFileOrMissingNode(item: DetectedContent, color: string): NodeDescriptor {
    if (item.resolvedFile) {
        return {
            id: '',
            label: item.displayName,
            type: 'file',
            file: item.resolvedFile.path,
            color
        };
    }

    return buildMissingNode(item);
}
