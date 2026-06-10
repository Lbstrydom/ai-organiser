/**
 * Attachment text indexer (azure-capability-completion-v2 — Cluster A / Phase 1).
 *
 * Pure, Obsidian-free collector: given a note's content + injected seams, it produces
 * the attachment-derived text chunks to append to the note's vector batch. Office-XML
 * documents (docx/xlsx/pptx/txt/rtf/csv/xls) are extracted now; PDFs are deferred to
 * Phase 4 (reason `pdf-deferred-to-phase4`) without losing the host-note linkage.
 *
 * Guarantees:
 *  - per-attachment try/catch + per-file timeout (a bad attachment never fails the note);
 *  - bounded concurrency (large vaults don't open every doc at once);
 *  - per-note cumulative char cap (`maxAttachmentCharsPerNote`) — a WORK cap: once reached,
 *    remaining attachments are reported `cap-reached`, not silently dropped;
 *  - single-flight extraction cache (C9/G4) so one attachment shared by N notes parses once;
 *  - collision-safe chunk ids `${notePath}::att::${hash(path)}#${i}` (M5), stable by path so a
 *    re-index upserts in place; the changed `contentHash` rides the chunk metadata.
 */

import type { Result } from '../../core/result';
import { ok, err } from '../../core/result';
import { SingleFlightCache, ATTACHMENT_EXTRACTOR_VERSION } from './attachmentFingerprint';

/** A local document/PDF attachment linked from a note, resolved to a vault path. */
export interface AttachmentRef {
    /** Display name (basename) for the `**From attachment:**` label. */
    name: string;
    /** Vault path — the stable identity for ids, cache, and lifecycle. */
    path: string;
    /** PDF text is deferred to Phase 4; flagged so it's skipped (not extracted) here. */
    isPdf: boolean;
    /** File size in bytes — the size-admission guard rejects pathologically large files
     *  BEFORE extraction (the only way to truly bound work given a non-abortable extractor). */
    size: number;
}

/** Hard per-file size cap (audit H7/H11): a file above this is never extracted — the
 *  non-cancellable Office extractor means an admission guard is the real work bound. */
export const MAX_ATTACHMENT_FILE_BYTES = 25_000_000; // 25 MB

export interface AttachmentChunk {
    /** Collision-safe, path-stable id: `${notePath}::att::${hash(path)}#${i}`. */
    id: string;
    content: string;
    /** Index of this chunk within the attachment. */
    chunkIndex: number;
    attachment: { name: string; path: string; contentHash: string };
}

export interface AttachmentSkip {
    path: string;
    reason: 'pdf-deferred-to-phase4' | 'extract-failed' | 'timeout' | 'empty' | 'cap-reached' | 'too-large'
        // Phase 4: pdf.js wasn't loaded yet (G1) — NOT cached, re-attempted on a later run.
        | 'needs-retry';
    detail?: string;
}

/** Injected seams — keep the collector Obsidian-free + unit-testable. */
export interface AttachmentExtractionDeps {
    /** Detect local document/PDF attachments referenced by the note's content. */
    detect: (noteContent: string) => AttachmentRef[];
    /** Extract text from an attachment (by path). */
    extractText: (ref: AttachmentRef) => Promise<{ ok: boolean; text?: string; error?: string }>;
    /** Phase 4: page-bounded PDF text extraction (via pdfPageRenderer, C21). Absent → PDFs
     *  stay deferred. `error: 'pdfjs-unavailable'` ⇒ skipped as `needs-retry` (G1), not cached. */
    extractPdfText?: (ref: AttachmentRef, budgetChars: number) => Promise<{ ok: boolean; text?: string; error?: string }>;
    /** Durable content hash for change-detection metadata. */
    contentHash: (ref: AttachmentRef) => Promise<string>;
    /** Sentence-aware chunker. */
    chunk: (text: string) => Promise<string[]>;
    /** Single-flight extraction cache, shared across the indexing pass (C9/G4).
     *  `extractedWithBudget` is set on PDF entries (the C21 bound the extraction ran
     *  under) so a later larger-budget caller can invalidate a truncated entry (H6(i)). */
    cache: SingleFlightCache<{ text: string; contentHash: string; extractedWithBudget?: number }>;
    /** Per-file extraction timeout (ms). Default 30s. */
    timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Bound the AWAIT on `p` to `ms`. Caveat (audit H7/H11): without an abortable extractor
 * (officeparser is not cancellation-aware), the orphaned extraction continues in the
 * background after a timeout — it just isn't awaited, and its result is discarded. The
 * impactful bound is the ADMISSION cap below (we never START extraction once the per-note
 * budget is exhausted), so total work stays bounded; the timeout only caps a single
 * pathological file's wait. Full AbortSignal threading is deferred to the PDF lane (Phase 4),
 * where page-iterating extraction is natively interruptible.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer!: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
    });
    // Promise.race propagates p's own rejection verbatim (we never re-reject it), so the
    // only rejection we author is the timeout Error (satisfies prefer-promise-reject-errors).
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Collect attachment-derived text chunks for a note. Never throws — a failure of an
 * individual attachment becomes a `skipped` entry; the note's own indexing is unaffected.
 *
 * The per-note `maxCharsPerNote` is enforced as an ADMISSION WORK CAP (audit H6/H11): once
 * the running budget is exhausted, further attachments are reported `cap-reached` and are
 * NOT extracted — extraction is the expensive work, so processing is sequential and stops
 * early rather than extracting everything and truncating after.
 */
export async function collectAttachmentChunks(
    notePath: string,
    noteContent: string,
    maxCharsPerNote: number,
    deps: AttachmentExtractionDeps,
): Promise<Result<{ chunks: AttachmentChunk[]; skipped: AttachmentSkip[] }>> {
    // The Result contract must hold even when an INJECTED collaborator throws outside
    // the per-attachment isolation (e.g. detect on malformed content) — audit R2-H2.
    try {
        return await collectAttachmentChunksInner(notePath, noteContent, maxCharsPerNote, deps);
    } catch (e) {
        return err(`attachment-collect-failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}

async function collectAttachmentChunksInner(
    notePath: string,
    noteContent: string,
    maxCharsPerNote: number,
    deps: AttachmentExtractionDeps,
): Promise<Result<{ chunks: AttachmentChunk[]; skipped: AttachmentSkip[] }>> {
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const refs = deps.detect(noteContent);
    const skipped: AttachmentSkip[] = [];
    const chunks: AttachmentChunk[] = [];
    let budget = Math.max(0, maxCharsPerNote);
    // Dedupe repeated refs to the SAME vault path (audit R2-H6): a note embedding one
    // attachment twice must emit its chunks once — ids would collide on upsert anyway,
    // but double emission double-charges the per-note budget.
    const seenPaths = new Set<string>();

    for (const ref of refs) {
        if (seenPaths.has(ref.path)) continue;
        seenPaths.add(ref.path);
        // Phase 4: PDFs are extracted (page-bounded, C21) when the renderer seam is wired;
        // otherwise they stay deferred (graceful — e.g. pdf.js unavailable at build time).
        if (ref.isPdf && !deps.extractPdfText) { skipped.push({ path: ref.path, reason: 'pdf-deferred-to-phase4' }); continue; }
        // Size-admission guard: never extract a pathologically large file (the extractor is
        // not cancellable, so this is the real work bound — audit H7/H11).
        if (ref.size > MAX_ATTACHMENT_FILE_BYTES) { skipped.push({ path: ref.path, reason: 'too-large' }); continue; }
        // Admission cap: do NOT extract once the per-note budget is exhausted.
        if (budget <= 0) { skipped.push({ path: ref.path, reason: 'cap-reached' }); continue; }

        // Distinct cache key + extractor per lane (office vs page-bounded PDF) so a shared
        // attachment is parsed once (C9/G4); the cache evicts rejections → G1 retry.
        const cacheKey = ref.isPdf ? `${ref.path}|pdf|${ATTACHMENT_EXTRACTOR_VERSION}` : `${ref.path}|${ATTACHMENT_EXTRACTOR_VERSION}`;
        const budgetSnapshot = budget;
        const runExtraction = async (): Promise<{ text: string; contentHash: string; extractedWithBudget?: number }> => {
            const res = ref.isPdf
                ? await deps.extractPdfText!(ref, budgetSnapshot)
                : await deps.extractText(ref);
            if (!res.ok || !res.text) throw new Error(res.error || 'extract-failed');
            const hash = await deps.contentHash(ref);
            // Record the bound a PDF extraction ran under so a later, larger-budget
            // caller can detect a possibly-truncated entry (audit H6(i)).
            return ref.isPdf
                ? { text: res.text, contentHash: hash, extractedWithBudget: budgetSnapshot }
                : { text: res.text, contentHash: hash };
        };
        let extracted: { text: string; contentHash: string; extractedWithBudget?: number };
        try {
            extracted = await withTimeout(deps.cache.get(cacheKey, runExtraction), timeoutMs);
            // Budget-poisoning guard (audit H6(i), deliberated MEDIUM): a PDF entry cached
            // under a SMALLER budget that actually HIT that bound may be truncated — a
            // later caller with more budget must re-extract, not inherit the truncation.
            // (text shorter than its bound ⇒ the budget wasn't binding ⇒ entry is complete
            // w.r.t. the char cap and safe to share at any budget.)
            if (ref.isPdf
                && extracted.extractedWithBudget !== undefined
                && extracted.extractedWithBudget < budgetSnapshot
                && extracted.text.length >= extracted.extractedWithBudget) {
                deps.cache.delete(cacheKey);
                extracted = await withTimeout(deps.cache.get(cacheKey, runExtraction), timeoutMs);
            }
        } catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            const reason = detail === 'timeout' ? 'timeout'
                : detail === 'pdfjs-unavailable' ? 'needs-retry'   // G1: re-attempt later (cache evicted)
                : 'extract-failed';
            skipped.push({ path: ref.path, reason, detail });
            continue;
        }

        const trimmed = extracted.text.trim();
        if (!trimmed) { skipped.push({ path: ref.path, reason: 'empty' }); continue; }

        // Work bound (audit R2-M4): never chunk more text than the remaining budget can
        // emit — chunking megabytes for a near-exhausted budget is wasted CPU. A small
        // overshoot pad keeps the last chunk's sentence boundary natural.
        const bounded = trimmed.length > budget + 2000 ? trimmed.slice(0, budget + 2000) : trimmed;
        const pieces = await deps.chunk(bounded);
        // Collision-free, path-stable id base (audit H5/M17): the encoded vault path IS the
        // identity — no hash, so two distinct attachments can never share an id. The `#${i}`
        // suffix is unambiguous because encodeURIComponent escapes any literal '#'.
        const idBase = `${notePath}::att::${encodeURIComponent(ref.path)}`;
        let emitted = 0;
        let cappedHere = false;
        for (const content of pieces) {
            if (content.length > budget) { cappedHere = true; break; }
            budget -= content.length;
            chunks.push({
                id: `${idBase}#${emitted}`,
                content,
                chunkIndex: emitted,
                attachment: { name: ref.name, path: ref.path, contentHash: extracted.contentHash },
            });
            emitted++;
        }
        if (cappedHere && emitted === 0) skipped.push({ path: ref.path, reason: 'cap-reached' });
    }

    return ok({ chunks, skipped });
}
