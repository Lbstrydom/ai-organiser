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
import { ok } from '../../core/result';
import { SingleFlightCache, ATTACHMENT_EXTRACTOR_VERSION } from './attachmentFingerprint';

/** A local document/PDF attachment linked from a note, resolved to a vault path. */
export interface AttachmentRef {
    /** Display name (basename) for the `**From attachment:**` label. */
    name: string;
    /** Vault path — the stable identity for ids, cache, and lifecycle. */
    path: string;
    /** PDF text is deferred to Phase 4; flagged so it's skipped (not extracted) here. */
    isPdf: boolean;
}

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
    reason: 'pdf-deferred-to-phase4' | 'extract-failed' | 'timeout' | 'empty' | 'cap-reached';
    detail?: string;
}

/** Injected seams — keep the collector Obsidian-free + unit-testable. */
export interface AttachmentExtractionDeps {
    /** Detect local document/PDF attachments referenced by the note's content. */
    detect: (noteContent: string) => AttachmentRef[];
    /** Extract text from an attachment (by path). */
    extractText: (ref: AttachmentRef) => Promise<{ ok: boolean; text?: string; error?: string }>;
    /** Durable content hash for change-detection metadata. */
    contentHash: (ref: AttachmentRef) => Promise<string>;
    /** Sentence-aware chunker. */
    chunk: (text: string) => Promise<string[]>;
    /** Single-flight extraction cache, shared across the indexing pass (C9/G4). */
    cache: SingleFlightCache<{ text: string; contentHash: string }>;
    /** Per-file extraction timeout (ms). Default 30s. */
    timeoutMs?: number;
    /** Max attachments extracted in parallel. Default 3. */
    concurrency?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CONCURRENCY = 3;

/** Deterministic, sync FNV-1a hash of the attachment path → short hex id component. */
function pathHash(path: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < path.length; i++) {
        h ^= path.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer!: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
    });
    // Promise.race propagates p's own rejection verbatim (we never re-reject it), so the
    // only rejection we author is the timeout Error (satisfies prefer-promise-reject-errors).
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** Run `worker` over `items` with a bounded concurrency pool, preserving input order. */
async function mapBounded<I, O>(items: I[], limit: number, worker: (item: I, index: number) => Promise<O>): Promise<O[]> {
    const out: O[] = new Array(items.length);
    let next = 0;
    const run = async (): Promise<void> => {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            out[i] = await worker(items[i], i);
        }
    };
    const pool = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run);
    await Promise.all(pool);
    return out;
}

/** One attachment's extraction result (collected before the cap is applied). */
interface ExtractedAttachment {
    ref: AttachmentRef;
    chunks: string[];
    contentHash: string;
    skip?: AttachmentSkip;
}

/**
 * Collect attachment-derived text chunks for a note. Never throws — a failure of an
 * individual attachment becomes a `skipped` entry; the note's own indexing is unaffected.
 */
export async function collectAttachmentChunks(
    notePath: string,
    noteContent: string,
    maxCharsPerNote: number,
    deps: AttachmentExtractionDeps,
): Promise<Result<{ chunks: AttachmentChunk[]; skipped: AttachmentSkip[] }>> {
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
    const refs = deps.detect(noteContent);
    const skipped: AttachmentSkip[] = [];

    const extractable: AttachmentRef[] = [];
    for (const ref of refs) {
        if (ref.isPdf) {
            skipped.push({ path: ref.path, reason: 'pdf-deferred-to-phase4' });
        } else {
            extractable.push(ref);
        }
    }

    // Extract (bounded + cached + per-file timeout), isolated per attachment.
    const extracted = await mapBounded<AttachmentRef, ExtractedAttachment>(extractable, concurrency, async (ref) => {
        try {
            const { text, contentHash } = await withTimeout(
                deps.cache.get(`${ref.path}|${ATTACHMENT_EXTRACTOR_VERSION}`, async () => {
                    const res = await deps.extractText(ref);
                    if (!res.ok || !res.text) throw new Error(res.error || 'extract-failed');
                    const hash = await deps.contentHash(ref);
                    return { text: res.text, contentHash: hash };
                }),
                timeoutMs,
            );
            const trimmed = text.trim();
            if (!trimmed) return { ref, chunks: [], contentHash, skip: { path: ref.path, reason: 'empty' } };
            const chunks = await deps.chunk(trimmed);
            return { ref, chunks, contentHash };
        } catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            const reason: AttachmentSkip['reason'] = detail === 'timeout' ? 'timeout' : 'extract-failed';
            return { ref, chunks: [], contentHash: '', skip: { path: ref.path, reason, detail } };
        }
    });

    // Assemble chunks under the per-note WORK cap (in detection order). Once the cap is
    // reached, remaining attachments are reported `cap-reached` rather than dropped silently.
    const chunks: AttachmentChunk[] = [];
    let charBudget = Math.max(0, maxCharsPerNote);
    let capped = false;
    for (const item of extracted) {
        if (item.skip) { skipped.push(item.skip); continue; }
        if (capped) { skipped.push({ path: item.ref.path, reason: 'cap-reached' }); continue; }
        const idBase = `${notePath}::att::${pathHash(item.ref.path)}`;
        let emitted = 0;
        for (let i = 0; i < item.chunks.length; i++) {
            const content = item.chunks[i];
            if (content.length > charBudget) { capped = true; break; }
            charBudget -= content.length;
            chunks.push({
                id: `${idBase}#${emitted}`,
                content,
                chunkIndex: emitted,
                attachment: { name: item.ref.name, path: item.ref.path, contentHash: item.contentHash },
            });
            emitted++;
        }
        if (capped && emitted === 0) skipped.push({ path: item.ref.path, reason: 'cap-reached' });
    }

    return ok({ chunks, skipped });
}
