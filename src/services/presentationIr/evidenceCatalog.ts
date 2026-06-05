/**
 * Evidence catalog builder (plan §4) — turns the deck's resolved sources (notes,
 * web-search results, the active note) into a flat list of `EvidenceSpan`s the
 * storyboard generator cites and the grounding self-check verifies against.
 *
 * v1 ranking is **number-bearing-first** under a TPM-aware char budget: paragraphs
 * that contain a digit are the groundable evidence (a deck's claims are numeric),
 * so they're kept ahead of prose until the budget fills. Full embedding-based
 * retrieval-ranking (plan §4's richer form) is a later refinement — this baseline
 * is deterministic, dependency-free, and unit-testable, and never fabricates: a
 * span's `text` is a verbatim slice of a real source.
 */
import type { EvidenceSpan } from './consultantStoryboard';

export interface CatalogOptions {
    /** TPM-aware total character budget for the catalog (default 40 000). */
    maxTotalChars?: number;
    /** Max spans emitted (default 60). */
    maxSpans?: number;
    /** Max characters per span (longer paragraphs are truncated, default 600). */
    maxSpanChars?: number;
}

const DEFAULTS = { maxTotalChars: 40_000, maxSpans: 60, maxSpanChars: 600 };
const HAS_DIGIT = /\d/;

export interface CatalogSourceInput {
    ref: string;
    content: string;
}

interface Candidate { ref: string; text: string; hasNumber: boolean; order: number; }

function splitParagraphs(content: string, maxSpanChars: number): string[] {
    return content
        .split(/\n\s*\n+/)
        .map((p) => p.replace(/\s+/g, ' ').trim())
        .filter((p) => p.length > 0)
        .map((p) => (p.length > maxSpanChars ? p.slice(0, maxSpanChars).trim() : p));
}

/**
 * Build the evidence catalog. Pure. Number-bearing paragraphs are emitted first
 * (stable within their rank), then prose, until the span/char budget fills.
 * Ids are short + stable (`e1`, `e2`, …) to keep the generator prompt compact.
 */
export function buildEvidenceCatalog(sources: readonly CatalogSourceInput[], options: CatalogOptions = {}): EvidenceSpan[] {
    const maxTotalChars = options.maxTotalChars ?? DEFAULTS.maxTotalChars;
    const maxSpans = options.maxSpans ?? DEFAULTS.maxSpans;
    const maxSpanChars = options.maxSpanChars ?? DEFAULTS.maxSpanChars;

    const candidates: Candidate[] = [];
    let order = 0;
    for (const src of sources) {
        if (!src || typeof src.content !== 'string') continue;
        const ref = src.ref || 'source';
        for (const text of splitParagraphs(src.content, maxSpanChars)) {
            candidates.push({ ref, text, hasNumber: HAS_DIGIT.test(text), order: order++ });
        }
    }
    // Number-bearing first; ties keep document order (stable).
    candidates.sort((a, b) => (a.hasNumber === b.hasNumber ? a.order - b.order : a.hasNumber ? -1 : 1));

    const out: EvidenceSpan[] = [];
    let usedChars = 0;
    for (const c of candidates) {
        if (out.length >= maxSpans) break;
        if (usedChars + c.text.length > maxTotalChars && out.length > 0) break;
        out.push({ id: `e${out.length + 1}`, source_ref: c.ref, text: c.text });
        usedChars += c.text.length;
    }
    return out;
}
