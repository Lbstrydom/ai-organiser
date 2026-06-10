/**
 * RAG payload builder (plan Phase 7 / DP-1 / C4 / C5 / C18) — converts merged
 * `RagContextItem[]` into provider `ContentPart[]` for the EXISTING `sendMultimodal`
 * path (no new adapter code).
 *
 * THE GATES LIVE HERE, IN CODE (C5/H3 — never copy-only):
 *  1. `allowVisualPageTextInRag === false` → visual (attachment-page) items are OMITTED
 *     ENTIRELY — their page text never reaches the LLM (C18 transmission #2).
 *  2. An item becomes an IMAGE part only when ALL hold: `allowVisualSynthesisImages`
 *     (C5, default false) AND the model is vision-capable AND the synthesis budget
 *     (count + bytes) has room. Otherwise it degrades to page TEXT — deterministic
 *     truncation BEFORE the call, never provider rejection (DP-1).
 *  3. `renderRef` is a deferred pointer: the page image is materialised HERE at build
 *     time via the injected renderer, and a render failure degrades that item to text.
 */
import type { ContentPart, MultimodalCapability } from './adapters/types';
import type { Result } from '../core/result';
import type { PdfPageRef } from './visualEmbedding/types';
import type { RagContextItem } from './ragContextMerger';
import { logger } from '../utils/logger';

export interface VisualSynthesisBudget {
    /** Max image parts per payload. */
    maxImages: number;
    /** Max TOTAL image bytes (decoded base64 estimate) per payload. */
    maxImageBytes: number;
}

export const DEFAULT_SYNTHESIS_BUDGET: VisualSynthesisBudget = Object.freeze({
    maxImages: 4,
    maxImageBytes: 8_000_000,
});

export interface RagPayloadOptions {
    /** C5 — rendered page images → the active vision LLM. Default-false consent. */
    allowVisualSynthesisImages: boolean;
    /** C18 #2 — matching page TEXT → the active LLM. False ⇒ visual items omitted entirely. */
    allowVisualPageTextInRag: boolean;
    /** The ACTIVE model's multimodal capability (adapter-declared). */
    modelCapability: MultimodalCapability;
    budget?: VisualSynthesisBudget;
}

export interface RagPayloadDeps {
    /** Materialise a page image (data URI) from its deferred pointer. */
    renderPage: (ref: PdfPageRef) => Promise<Result<string>>;
}

export interface RagPayloadResult {
    parts: ContentPart[];
    imagesIncluded: number;
    /** attachment-page items that fell back to page text (budget / capability / render-fail). */
    degradedToText: number;
    /** attachment-page items omitted entirely (allowVisualPageTextInRag === false). */
    omittedVisual: number;
}

function isVisionCapable(cap: MultimodalCapability): boolean {
    return cap === 'image' || cap === 'image+document';
}

/** data:image/jpeg;base64,XXXX → { mediaType, data, approxBytes }. Null on a non-image URI. */
export function parseImageDataUrl(dataUrl: string): { mediaType: string; data: string; approxBytes: number } | null {
    const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(dataUrl);
    if (!m) return null;
    const data = m[2];
    return { mediaType: m[1], data, approxBytes: Math.floor(data.length * 0.75) };
}

function textPartFor(item: RagContextItem): ContentPart {
    if (item.kind === 'attachment-page') {
        return {
            type: 'text',
            text: `[From attachment: ${item.sourceAttachment.name}, page ${item.page} (in note ${item.filePath})]\n${item.text || '(no text on page)'}`,
        };
    }
    const att = item.sourceAttachment ? ` (from attachment: ${item.sourceAttachment.name})` : '';
    return { type: 'text', text: `[From note: ${item.filePath}${att}]\n${item.text}` };
}

/**
 * Build provider parts from merged evidence. Items keep their merged rank order; visual
 * hits are considered for image inclusion in that order until the budget exhausts (C4:
 * rank + diversity already applied by the merger's caps), then degrade to page text.
 */
export async function buildRagParts(
    items: RagContextItem[],
    opts: RagPayloadOptions,
    deps: RagPayloadDeps,
): Promise<RagPayloadResult> {
    const budget = opts.budget ?? DEFAULT_SYNTHESIS_BUDGET;
    const parts: ContentPart[] = [];
    let imagesIncluded = 0;
    let imageBytes = 0;
    let degradedToText = 0;
    let omittedVisual = 0;

    const imagesAllowed = opts.allowVisualSynthesisImages && isVisionCapable(opts.modelCapability);

    for (const item of items) {
        if (item.kind === 'text') {
            parts.push(textPartFor(item));
            continue;
        }
        // C18 #2: visual evidence is omitted ENTIRELY when page-text consent is off —
        // not even its text reaches the LLM.
        if (!opts.allowVisualPageTextInRag) {
            omittedVisual++;
            continue;
        }
        if (imagesAllowed && imagesIncluded < budget.maxImages) {
            const rendered = await deps.renderPage(item.renderRef);
            if (rendered.ok) {
                const parsed = parseImageDataUrl(rendered.value);
                if (parsed && imageBytes + parsed.approxBytes <= budget.maxImageBytes) {
                    // Caption first so the model can attribute the image (C4 provenance).
                    parts.push({
                        type: 'text',
                        text: `[Image: ${item.sourceAttachment.name}, page ${item.page} (in note ${item.filePath})]`,
                    });
                    parts.push({ type: 'image', data: parsed.data, mediaType: parsed.mediaType });
                    imagesIncluded++;
                    imageBytes += parsed.approxBytes;
                    continue;
                }
            } else {
                logger.debug('Search', `RAG payload: render failed for ${item.renderRef.pdfPath}#${item.renderRef.page} — degrading to text (${rendered.error})`);
            }
        }
        // Degrade deterministically to page text (DP-1 default path).
        parts.push(textPartFor(item));
        degradedToText++;
    }

    return { parts, imagesIncluded, degradedToText, omittedVisual };
}
