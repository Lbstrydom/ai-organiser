/**
 * Attachment content fingerprint + single-flight extraction cache
 * (azure-capability-completion-v2 — C9/C13, Cluster A / Phase 1).
 *
 * One fingerprint helper feeds BOTH the Phase-1 text-extraction cache and the
 * Phase-6 visual cache (resolves the prior Phase-1/Phase-6 cache-key inconsistency):
 *   { vaultPath, size, mtime, contentHash } + a version salt where output depends on it
 *   (`extractorVersion` for text, `renderVersion`/`modelId`/`dim` for the visual lane).
 *
 * `contentHash` is computed LAZILY (only for changed candidates) because size+mtime
 * is a cheap prefilter but NOT sufficient across Obsidian Sync / file copies (which can
 * preserve mtime). The cheap key (path|size|mtime|salt) drives the in-pass single-flight
 * cache; contentHash is the durable identity stored in the chunk metadata so a re-index
 * detects a genuine content change.
 *
 * G4 — single-flight: the cache stores in-flight PROMISES, not just completed results,
 * so concurrent requests for the same fingerprint (e.g. one attachment shared by several
 * host notes during a backfill) AWAIT the existing promise instead of re-parsing/re-hashing
 * the same large file in parallel.
 */

import type { App, TFile } from 'obsidian';
import { sha256Hex } from '../tts/fingerprint';

/** Bump when the text-extraction output format changes (busts the text cache). */
export const ATTACHMENT_EXTRACTOR_VERSION = 1;

export interface AttachmentContentFingerprint {
    vaultPath: string;
    size: number;
    mtime: number;
}

/** Build the cheap (path|size|mtime) fingerprint from a vault file's stat. */
export function fingerprintOf(file: TFile): AttachmentContentFingerprint {
    return { vaultPath: file.path, size: file.stat?.size ?? 0, mtime: file.stat?.mtime ?? 0 };
}

/** The in-pass single-flight cache key — cheap prefilter + a version salt so a format
 *  bump invalidates without a content re-hash. */
export function fingerprintCacheKey(fp: AttachmentContentFingerprint, salt: string | number): string {
    return `${fp.vaultPath}|${fp.size}|${fp.mtime}|${salt}`;
}

/**
 * Compute the durable content SIGNATURE for a fingerprint — an APPROXIMATE identity, by
 * design, NOT a full-content hash (audit R2-H5, accepted trade-off): it SHA-256s the byte
 * length + mtime + sampled head/tail bytes, so it stays O(1)-ish for very large files. An
 * interior edit that preserves length AND mtime AND the sampled regions is not detected
 * until any metadata changes. Lazy — call ONLY for a changed candidate, never on every
 * prefilter hit.
 */
export async function computeAttachmentContentHash(app: App, file: TFile): Promise<string> {
    const bytes = await app.vault.readBinary(file);
    // Hash a compact byte-summary, not a giant base64 string: length-prefixed parts of
    // (size, mtime, a sampled-byte digest) keep this O(1)-ish for very large files while
    // still distinguishing edits. We sample head+tail+length so two same-size files with
    // different content hash differently without reading-then-encoding the whole blob.
    const view = new Uint8Array(bytes);
    const sample = sampleBytes(view);
    return sha256Hex([String(view.length), String(file.stat?.mtime ?? 0), sample]);
}

/** Deterministic head+tail byte sample as a hex string — bounds hashing cost for large
 *  files while staying sensitive to edits at either end (and to length changes). */
function sampleBytes(view: Uint8Array): string {
    const N = 4096;
    const take = (start: number, len: number): string => {
        let s = '';
        const end = Math.min(start + len, view.length);
        for (let i = start; i < end; i++) s += view[i].toString(16).padStart(2, '0');
        return s;
    };
    if (view.length <= 2 * N) return take(0, view.length);
    return `${take(0, N)}|${take(view.length - N, N)}`;
}

/**
 * Single-flight async cache: concurrent calls for the same key share ONE in-flight
 * promise. A rejected promise is evicted so a later call can retry. Bounded by a simple
 * insertion-order cap (oldest evicted) — the cache is per-indexing-pass scoped, so it
 * never needs to be large.
 */
export class SingleFlightCache<T> {
    private readonly map = new Map<string, Promise<T>>();
    constructor(private readonly maxEntries = 256) {}

    get(key: string, factory: () => Promise<T>): Promise<T> {
        const existing = this.map.get(key);
        if (existing) return existing;
        const p = factory().catch((e: unknown) => {
            // Evict on failure so the next request retries instead of re-throwing a stale rejection.
            if (this.map.get(key) === p) this.map.delete(key);
            throw e;
        });
        this.map.set(key, p);
        this.evictIfNeeded();
        return p;
    }

    clear(): void {
        this.map.clear();
    }

    /** Evict one entry (budget-insufficiency invalidation — audit H6(i)). */
    delete(key: string): void {
        this.map.delete(key);
    }

    private evictIfNeeded(): void {
        while (this.map.size > this.maxEntries) {
            const oldest = this.map.keys().next().value;
            if (oldest === undefined) break;
            this.map.delete(oldest);
        }
    }
}
