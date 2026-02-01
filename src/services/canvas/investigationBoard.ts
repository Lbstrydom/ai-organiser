import { App, TFile } from 'obsidian';
import { RAGService } from '../ragService';
import { LLMFacadeContext, summarizeText } from '../llmFacade';
import { buildEdgeLabelPrompt } from '../prompts/canvasPrompts';
import { tryParseJson, tryParseJsonFromFence } from '../../utils/responseParser';
import { adaptiveLayout } from './layouts';
import { buildCanvasEdge, buildCanvasNode, generateId, openCanvasFile, writeCanvasFile } from './canvasUtils';
import { CanvasData, CanvasResult, EdgeDescriptor, NodeDescriptor } from './types';

/** Score threshold for "closely related" classification (high confidence). */
const SCORE_THRESHOLD_HIGH = 0.8;
/** Score threshold for "related" classification (medium confidence). */
const SCORE_THRESHOLD_MEDIUM = 0.6;
/** Maximum characters to use for edge label snippet context. */
const EDGE_SNIPPET_CHARS = 500;

export interface EdgeLabelStrings {
    closelyRelated: string;
    related: string;
    looselyRelated: string;
}

export interface InvestigationOptions {
    file: TFile;
    content: string;
    maxRelated: number;
    enableEdgeLabels: boolean;
    canvasFolder: string;
    openAfterCreate: boolean;
    language: string;
    edgeLabelStrings?: EdgeLabelStrings;
}

export async function buildInvestigationBoard(
    app: App,
    ragService: RAGService,
    llmContext: LLMFacadeContext,
    options: InvestigationOptions
): Promise<CanvasResult> {
    const relatedNotes = await ragService.getRelatedNotes(
        options.file,
        options.content,
        options.maxRelated
    );

    if (!relatedNotes.length) {
        return { success: false, error: 'No related notes found', errorCode: 'no-related-notes' };
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

    relatedNotes.forEach(result => {
        const id = generateId();
        const title = result.document.metadata?.title || result.document.filePath.split('/').pop() || 'Untitled';
        const color = result.score >= SCORE_THRESHOLD_HIGH ? '6' : '4';
        nodes.push({
            id,
            label: title,
            type: 'file',
            file: result.document.filePath,
            color
        });
    });

    const layout = adaptiveLayout(nodes.length, 0);
    const positions = new Map<string, { x: number; y: number }>();
    const canvasNodes = nodes.map((desc, index) => {
        const pos = layout[index];
        positions.set(desc.id, { x: pos.x, y: pos.y });
        return buildCanvasNode(desc, pos.x, pos.y);
    });

    const edges: EdgeDescriptor[] = [];
    const labelStrings = options.edgeLabelStrings ?? DEFAULT_EDGE_LABELS;
    const fallbackLabels = relatedNotes.map(result => getFallbackEdgeLabel(result.score, labelStrings));
    let edgeLabels: (string | undefined)[] = fallbackLabels;

    if (options.enableEdgeLabels) {
        const fromSnippet = options.content.slice(0, EDGE_SNIPPET_CHARS);
        const pairs = relatedNotes.map((result, index) => ({
            fromTitle: options.file.basename,
            fromSnippet,
            toTitle: result.document.metadata?.title || result.document.filePath.split('/').pop() || 'Untitled',
            toSnippet: result.document.content.slice(0, EDGE_SNIPPET_CHARS),
            pairIndex: index
        }));

        const prompt = buildEdgeLabelPrompt(pairs, options.language);
        const response = await summarizeText(llmContext, prompt);
        if (response.success && response.content) {
            const parsed = parseEdgeLabelResponse(response.content, pairs.length);
            if (parsed.some(Boolean)) {
                edgeLabels = parsed.map((label, idx) => label || fallbackLabels[idx]);
            }
        }
    }

    for (let i = 1; i < nodes.length; i++) {
        edges.push({
            fromId: centerId,
            toId: nodes[i].id,
            label: edgeLabels[i - 1]
        });
    }

    const canvasEdges = edges.map(edge => buildCanvasEdge(edge, positions));

    const data: CanvasData = {
        nodes: canvasNodes,
        edges: canvasEdges
    };

    const result = await writeCanvasFile(
        app,
        options.canvasFolder,
        `Investigation Board - ${options.file.basename}`,
        data
    );

    if (result.success && result.filePath && options.openAfterCreate) {
        await openCanvasFile(app, result.filePath);
    }

    return result;
}

export function parseEdgeLabelResponse(response: string, pairCount: number): (string | undefined)[] {
    const empty = () => Array.from({ length: pairCount }, () => undefined as string | undefined);

    if (!response?.trim()) return empty();

    // Tier 1 & 2: Direct JSON / code fence
    const parsed = tryParseJson(response) ?? tryParseJsonFromFence(response);
    if (parsed) {
        const labels = extractLabelArray(parsed, pairCount);
        if (labels) return labels;
    }

    // Tier 3: Regex fallback for "label": "..." patterns
    const regex = /"label"\s*:\s*"([^"]+)"/g;
    const extracted: string[] = [];
    let match: RegExpExecArray | null = null;
    while ((match = regex.exec(response)) !== null) {
        extracted.push(match[1]);
    }

    if (extracted.length > 0) {
        return Array.from({ length: pairCount }, (_, i) => extracted[i]);
    }

    return empty();
}

const DEFAULT_EDGE_LABELS: EdgeLabelStrings = {
    closelyRelated: 'Closely related',
    related: 'Related',
    looselyRelated: 'Loosely related'
};

export function getFallbackEdgeLabel(score: number, strings: EdgeLabelStrings = DEFAULT_EDGE_LABELS): string {
    if (score >= SCORE_THRESHOLD_HIGH) return strings.closelyRelated;
    if (score >= SCORE_THRESHOLD_MEDIUM) return strings.related;
    return strings.looselyRelated;
}

function extractLabelArray(parsed: any, pairCount: number): (string | undefined)[] | null {
    const labels = parsed?.labels;
    if (!Array.isArray(labels)) return null;

    const output = Array.from({ length: pairCount }, () => undefined as string | undefined);
    for (const item of labels) {
        if (!item || typeof item !== 'object') continue;
        const index = typeof item.pairIndex === 'number' ? item.pairIndex : Number(item.pairIndex);
        if (Number.isNaN(index) || index < 0 || index >= pairCount) continue;
        if (typeof item.label === 'string') {
            output[index] = item.label;
        }
    }

    return output;
}
