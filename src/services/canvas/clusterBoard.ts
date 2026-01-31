import { App, TFile } from 'obsidian';
import { LLMFacadeContext, summarizeText } from '../llmFacade';
import { buildClusterPrompt } from '../prompts/canvasPrompts';
import { tryExtractJson } from '../../utils/responseParser';
import { extractTagsFromCache } from '../../utils/tagUtils';
import { clusteredLayout } from './layouts';
import { buildCanvasNode, generateId, openCanvasFile, writeCanvasFile } from './canvasUtils';
import { CanvasData, CanvasNode, CanvasResult, ClusterDescriptor, NodeDescriptor } from './types';

export interface ClusterBoardOptions {
    tag: string;
    files: TFile[];
    canvasFolder: string;
    openAfterCreate: boolean;
    useLLMClustering: boolean;
    language: string;
}

const CLUSTER_COLORS = ['1', '2', '3', '4', '5', '6'];

const SNIPPET_CHARS = 500;
const MAX_PROMPT_TOKENS = 4000;

function getClusterColor(index: number): string {
    return CLUSTER_COLORS[index % CLUSTER_COLORS.length];
}

export async function buildClusterBoard(
    app: App,
    llmContext: LLMFacadeContext,
    options: ClusterBoardOptions
): Promise<CanvasResult> {
    if (!options.files.length) {
        return { success: false, error: 'No notes with tag', errorCode: 'no-notes-with-tag' };
    }

    const nodeDescriptors: NodeDescriptor[] = options.files.map(file => ({
        id: generateId(),
        label: file.basename,
        type: 'file',
        file: file.path,
        color: '4'
    }));

    let clusters: ClusterDescriptor[] | null = null;
    const maxNotes = computeMaxNotes(SNIPPET_CHARS, MAX_PROMPT_TOKENS);

    if (options.useLLMClustering && options.files.length <= maxNotes) {
        const notes = await Promise.all(
            options.files.map(async file => ({
                title: file.basename,
                snippet: (await app.vault.read(file)).slice(0, SNIPPET_CHARS)
            }))
        );

        const prompt = buildClusterPrompt(options.tag, notes, options.language);
        const response = await summarizeText(llmContext, prompt);
        if (response.success && response.content) {
            clusters = parseClusterResponse(response.content, options.files.length);
        }
    }

    clusters ??= deterministicClustering(app, options.files, options.tag);

    const mappedClusters = remapClusterIds(clusters, nodeDescriptors);

    const { nodes: layoutNodes, groups } = clusteredLayout(
        mappedClusters.map((cluster, index) => ({
            label: cluster.label,
            nodeCount: cluster.nodeIds.length,
            color: cluster.color || getClusterColor(index)
        }))
    );

    const orderedIds = mappedClusters.flatMap(cluster => cluster.nodeIds);
    const canvasNodes: CanvasNode[] = [];

    for (let i = 0; i < orderedIds.length; i++) {
        const nodeId = orderedIds[i];
        const descriptor = nodeDescriptors.find(node => node.id === nodeId);
        const pos = layoutNodes[i];
        if (!descriptor || !pos) continue;
        canvasNodes.push(buildCanvasNode(descriptor, pos.x, pos.y));
    }

    const groupNodes: CanvasNode[] = groups.map((group, index) => ({
        id: generateId(),
        type: 'group',
        x: group.x,
        y: group.y,
        width: group.width,
        height: group.height,
        label: group.label,
        color: group.color || getClusterColor(index)
    }));

    const data: CanvasData = {
        nodes: [...groupNodes, ...canvasNodes],
        edges: []
    };

    const result = await writeCanvasFile(
        app,
        options.canvasFolder,
        `Cluster Board - ${options.tag}`,
        data
    );

    if (result.success && result.filePath && options.openAfterCreate) {
        await openCanvasFile(app, result.filePath);
    }

    return result;
}

export function deterministicClustering(app: App, files: TFile[], tag: string): ClusterDescriptor[] {
    const byFolder = new Map<string, number[]>();

    files.forEach((file, index) => {
        const folderName = file.parent?.name || 'Root';
        if (!byFolder.has(folderName)) {
            byFolder.set(folderName, []);
        }
        byFolder.get(folderName)!.push(index);
    });

    if (byFolder.size > 1) {
        return Array.from(byFolder.entries()).map(([label, indexes], i) => ({
            label,
            nodeIds: indexes.map(String),
            color: getClusterColor(i)
        }));
    }

    const subtagGroups = groupBySubtag(app, files, tag);
    if (subtagGroups && subtagGroups.size > 1) {
        return Array.from(subtagGroups.entries()).map(([label, indexes], i) => ({
            label,
            nodeIds: indexes.map(String),
            color: getClusterColor(i)
        }));
    }

    const indexes = files.map((_, index) => index);
    const chunkSize = 6;
    const clusters: ClusterDescriptor[] = [];
    for (let i = 0; i < indexes.length; i += chunkSize) {
        const chunk = indexes.slice(i, i + chunkSize);
        clusters.push({
            label: `Group ${clusters.length + 1}`,
            nodeIds: chunk.map(String),
            color: getClusterColor(clusters.length)
        });
    }

    return clusters;
}

export function computeMaxNotes(snippetChars: number, maxPromptTokens: number): number {
    const overhead = 50;
    const tokensPerNote = snippetChars / 4 + overhead;
    return Math.max(1, Math.floor(maxPromptTokens / tokensPerNote));
}

export function parseClusterResponse(response: string, noteCount: number): ClusterDescriptor[] | null {
    if (!response?.trim()) return null;

    const parsed = tryExtractJson(response);
    const clustersValue = (parsed as { clusters?: unknown } | null)?.clusters;
    if (!Array.isArray(clustersValue)) return null;

    const clusters: ClusterDescriptor[] = [];

    for (const cluster of clustersValue) {
        if (!cluster || typeof cluster !== 'object') continue;
        const clusterObj = cluster as Record<string, unknown>;
        const label = typeof clusterObj.label === 'string' ? clusterObj.label.trim() : '';
        const indexes = extractIndexes(clusterObj, noteCount);
        if (!label || indexes.length === 0) continue;
        clusters.push({ label, nodeIds: indexes.map(String) });
    }

    return clusters.length ? clusters : null;
}

function extractIndexes(cluster: Record<string, unknown>, noteCount: number): number[] {
    const candidates = cluster.noteIndexes || cluster.notes || cluster.indices;
    if (!Array.isArray(candidates)) return [];

    const indexes = candidates
        .map((value: any) => typeof value === 'number' ? value : Number(value))
        .filter((value: number) => Number.isFinite(value) && value >= 0 && value < noteCount);

    return Array.from(new Set(indexes));
}

function remapClusterIds(clusters: ClusterDescriptor[], nodes: NodeDescriptor[]): ClusterDescriptor[] {
    const mapped: ClusterDescriptor[] = [];
    const assigned = new Set<number>();

    for (const cluster of clusters) {
        const indexes = cluster.nodeIds
            .map(Number)
            .filter(index => Number.isFinite(index) && index >= 0 && index < nodes.length);

        indexes.forEach(index => assigned.add(index));

        mapped.push({
            label: cluster.label,
            nodeIds: indexes.map(index => nodes[index].id),
            color: cluster.color
        });
    }

    const missing = nodes
        .map((_, index) => index)
        .filter(index => !assigned.has(index));

    if (missing.length > 0) {
        mapped.push({
            label: 'Other',
            nodeIds: missing.map(index => nodes[index].id)
        });
    }

    return mapped;
}

function groupBySubtag(app: App, files: TFile[], tag: string): Map<string, number[]> | null {
    const groups = new Map<string, number[]>();

    files.forEach((file, index) => {
        const cache = app.metadataCache.getFileCache(file);
        const tags = extractTagsFromCache(cache);
        const subtag = tags
            .map((value: string) => value.startsWith('#') ? value.substring(1) : value)
            .find((value: string) => value.startsWith(`${tag}/`));

        if (subtag) {
            const label = subtag.substring(tag.length + 1) || tag;
            if (!groups.has(label)) groups.set(label, []);
            groups.get(label)!.push(index);
        }
    });

    return groups.size ? groups : null;
}
