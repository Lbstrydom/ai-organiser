/**
 * RAG context merger (plan Phase 7 / C4 / C20) — merges TEXT search results and VISUAL
 * page hits into one ranked evidence list for prompt construction.
 *
 * C4 — dedup is by EVIDENCE IDENTITY, never by host-note `filePath`:
 * `evidenceId = kind:filePath:sourceAttachment.path:page:chunkIndex:modelId`, so two
 * pages of one PDF (or a note's text chunk vs that note's attachment page) never
 * collapse. The host-note `filePath` dedup belongs ONLY to the related-notes DISPLAY
 * path (`RelatedNotesDeduper` in ragService — C20); prompt evidence must not apply it.
 *
 * Budgets (C4): a global item cap + per-host-note and per-attachment caps so one
 * dominant document can't crowd the context window. Pure module — no Obsidian imports.
 */
import type { SearchResult } from './vector/types';
import type { PdfPageRef, VisualHit } from './visualEmbedding/types';

export type RagContextItem =
    | {
        kind: 'text';
        filePath: string;
        /** Chunk position within the file — part of the C4 evidence identity (two chunks
         *  of one note are distinct evidence). */
        chunkIndex: number;
        text: string;
        score: number;
        title: string;
        sourceAttachment?: { name: string; path: string; contentHash: string };
    }
    | {
        kind: 'attachment-page';
        filePath: string;            // host note
        sourceAttachment: { name: string; path: string; contentHash: string };
        page: number;
        chunkIndex: number;
        text: string;                // page text (the DP-1 default payload)
        score: number;
        renderRef: PdfPageRef;       // deferred pointer — materialised at build time only
    };

export interface MergeBudget {
    /** Global evidence cap (defaults below). */
    maxItems: number;
    /** Cap per HOST note across both kinds. */
    maxItemsPerHostNote: number;
    /** Cap per source attachment (pages of one PDF). */
    maxPagesPerAttachment: number;
}

export const DEFAULT_MERGE_BUDGET: MergeBudget = Object.freeze({
    maxItems: 12,
    maxItemsPerHostNote: 4,
    maxPagesPerAttachment: 3,
});

/** The C4 evidence identity. `modelId` participates so mixed-model evidence (after a
 *  backend change mid-session) never aliases. */
export function evidenceIdOf(item: RagContextItem, modelId: string): string {
    const att = item.kind === 'attachment-page'
        ? item.sourceAttachment.path
        : (item.sourceAttachment?.path ?? '');
    const page = item.kind === 'attachment-page' ? item.page : '';
    return `${item.kind}:${item.filePath}:${att}:${page}:${item.chunkIndex}:${modelId}`;
}

export function textResultToItem(r: SearchResult): RagContextItem {
    return {
        kind: 'text',
        filePath: r.document.filePath,
        chunkIndex: r.document.chunkIndex,
        text: r.document.content,
        score: r.score,
        title: r.document.metadata.title,
        sourceAttachment: r.document.metadata.sourceAttachment,
    };
}

export function visualHitToItem(h: VisualHit): RagContextItem {
    return {
        kind: 'attachment-page',
        filePath: h.hostNotePath,
        sourceAttachment: {
            name: basename(h.pdfPath),
            path: h.pdfPath,
            contentHash: '',
        },
        page: h.page,
        chunkIndex: h.page,
        text: h.pageText ?? '',
        score: h.score,
        renderRef: h.renderRef,
    };
}

function basename(path: string): string {
    const i = path.lastIndexOf('/');
    return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * Merge text + visual evidence: convert, evidence-dedup, rank by score, then apply the
 * per-host / per-attachment / global caps in rank order (deterministic).
 */
export function mergeRagContext(
    textResults: SearchResult[],
    visualHits: VisualHit[],
    modelId: string,
    budget: MergeBudget = DEFAULT_MERGE_BUDGET,
): RagContextItem[] {
    const all = [
        ...textResults.map(textResultToItem),
        ...visualHits.map(visualHitToItem),
    ].sort((a, b) => b.score - a.score);

    const seen = new Set<string>();
    const perHost = new Map<string, number>();
    const perAttachment = new Map<string, number>();
    const out: RagContextItem[] = [];

    for (const item of all) {
        if (out.length >= Math.max(0, budget.maxItems)) break;
        const id = evidenceIdOf(item, modelId);
        if (seen.has(id)) continue;

        const hostCount = perHost.get(item.filePath) ?? 0;
        if (hostCount >= budget.maxItemsPerHostNote) continue;

        if (item.kind === 'attachment-page') {
            const attCount = perAttachment.get(item.sourceAttachment.path) ?? 0;
            if (attCount >= budget.maxPagesPerAttachment) continue;
            perAttachment.set(item.sourceAttachment.path, attCount + 1);
        }

        seen.add(id);
        perHost.set(item.filePath, hostCount + 1);
        out.push(item);
    }
    return out;
}
