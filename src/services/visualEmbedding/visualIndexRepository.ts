/**
 * Visual index repository (plan Phase 6 — D2/C8/C14/C19).
 *
 * Owns the SECOND Voy lane at `.ai-organiser/vector-index-visual` (D2: Cohere v4 dim ≠
 * the text index's — Voy enforces the dim boundary at insert) plus a registry sidecar:
 * `host note → { pdfPath → { cacheKey, contentHash, ids } }`. The registry is BOTH the
 * C9/C13 fingerprint cache (skip-unchanged) AND the C19 scope index.
 *
 * C19 — scoped search is a REPOSITORY-layer contract, PRE-topK: eligible host notes are
 * resolved from the registry FIRST, their page vectors cosine-ranked exactly, then topK
 * applied — an out-of-scope PDF can never crowd an in-scope hit out of the top-k. (This
 * filtered-candidate strategy is exact, strictly stronger than over-fetch+post-filter;
 * visual indexes are small — figure pages only — so brute-force cosine over the eligible
 * subset is cheap.)
 *
 * C8 — identity sidecar `{modelId, backend, dim, createdAt, sourceVersion}` persists
 * beside the index; a mismatch with the live backend on load sets `needsRebuild`, which
 * BLOCKS writes + search until `confirmRebuild()`. v1 rebuild = delete + re-derive (the
 * index is fully re-derivable from vault PDFs via the C23 backfill; an atomic temp-path
 * swap is meaningless for an hours-long paced re-embed — documented deviation from C8's
 * letter, same safety outcome: no mixed-dim state is ever readable).
 *
 * C14 — `deleteAll()` removes the WHOLE visual namespace: Voy index + meta sidecar +
 * registry (the visual cache + diagnostics) + temp rebuild paths.
 */
import type { App } from 'obsidian';
import type { Result } from '../../core/result';
import { ok, err } from '../../core/result';
import { VoyVectorStore } from '../vector/voyVectorStore';
import type { VectorDocument } from '../vector/types';
import { cosineSimilarity } from '../vector/vectorMath';
import { logger } from '../../utils/logger';
import type { VisualBackend, VisualHit, RetrievalScope } from './types';

export const VISUAL_INDEX_PATH = '.ai-organiser/vector-index-visual';
/** Bump when the render/figure-detection pipeline changes shape (invalidates the cache). */
export const VISUAL_SOURCE_VERSION = 1;

export interface VisualIndexIdentity {
    modelId: string;
    backend: VisualBackend;
    dim: number;
}

interface VisualMetaSidecar extends VisualIndexIdentity {
    createdAt: number;
    sourceVersion: number;
}

/** One embedded page ready to persist. */
export interface VisualPageUpsert {
    page: number;
    vector: number[];
    pageText: string;
}

interface PdfRegistryEntry {
    /** Cheap fingerprint cache key (C9/C13: path|size|mtime|salt). */
    cacheKey: string;
    /** Durable content hash (lazy — set when computed). */
    contentHash: string;
    /** Voy document ids for this (host, pdf). */
    ids: string[];
    /** Diagnostics (C7): pages indexed. */
    pages: number[];
}

type HostRegistry = Record<string, Record<string, PdfRegistryEntry>>;

interface RegistrySidecar {
    hosts: HostRegistry;
}

function basename(path: string): string {
    const i = path.lastIndexOf('/');
    return i >= 0 ? path.slice(i + 1) : path;
}

export function visualDocId(hostPath: string, pdfPath: string, page: number): string {
    return `${hostPath}::vis::${encodeURIComponent(pdfPath)}#${page}`;
}

/** The slice of the Voy store the repository uses — injectable so tests avoid real WASM. */
export interface VisualStorePort {
    load(): Promise<void>;
    save(): Promise<void>;
    upsert(docs: VectorDocument[]): Promise<void>;
    remove(ids: string[]): Promise<void>;
    removeFile(filePath: string): Promise<void>;
    getDocumentsByFile(filePath: string): Promise<VectorDocument[]>;
    setEmbeddingMetadata(dims: number, model: string): void;
}

export type VisualStoreFactory = (app: App, dim: number, storagePath: string) => VisualStorePort;

const defaultStoreFactory: VisualStoreFactory = (app, dim, storagePath) => new VoyVectorStore(app, dim, storagePath);

export class VisualIndexRepository {
    private store: VisualStorePort;
    private registry: HostRegistry = {};
    private meta: VisualMetaSidecar | null = null;
    private _needsRebuild = false;
    private loaded = false;

    constructor(
        private readonly app: App,
        private identity: VisualIndexIdentity,
        private readonly storagePath: string = VISUAL_INDEX_PATH,
        private readonly storeFactory: VisualStoreFactory = defaultStoreFactory,
    ) {
        this.store = storeFactory(app, identity.dim, storagePath);
    }

    get needsRebuild(): boolean { return this._needsRebuild; }

    /** Load index + sidecars; compare persisted identity to the live backend (C8). */
    async load(): Promise<Result<void>> {
        try {
            const adapter = this.app.vault.adapter;
            const metaPath = `${this.storagePath}/visual-meta.json`;
            const regPath = `${this.storagePath}/visual-registry.json`;

            if (await adapter.exists(metaPath)) {
                try {
                    this.meta = JSON.parse(await adapter.read(metaPath)) as VisualMetaSidecar;
                } catch {
                    // The sidecar EXISTS but is unreadable → the index identity is UNKNOWN.
                    // Fail closed (audit H12): treat as needs-rebuild — proceeding could mix
                    // dims/models. Only a genuinely ABSENT sidecar means "fresh index".
                    this.meta = null;
                    this._needsRebuild = true;
                    logger.warn('Search', 'Visual index meta sidecar unreadable — identity unknown, needs rebuild');
                }
            }
            if (this.meta &&
                (this.meta.modelId !== this.identity.modelId ||
                 this.meta.backend !== this.identity.backend ||
                 this.meta.dim !== this.identity.dim ||
                 this.meta.sourceVersion !== VISUAL_SOURCE_VERSION)) {
                this._needsRebuild = true;
                logger.warn('Search', `Visual index identity mismatch (${this.meta.backend}/${this.meta.modelId}/${this.meta.dim} vs ${this.identity.backend}/${this.identity.modelId}/${this.identity.dim}) — needs rebuild`);
            }

            if (await adapter.exists(regPath)) {
                try {
                    const reg = JSON.parse(await adapter.read(regPath)) as RegistrySidecar;
                    this.registry = reg?.hosts ?? {};
                } catch {
                    // The registry EXISTS but is unreadable (audit R2-H8): it is the
                    // eligibility/cache SSOT — proceeding with {} would strand the store's
                    // vectors (unsearchable) AND force a full re-embed that re-upserts
                    // alongside them. Same fail-closed rule as the meta sidecar.
                    this.registry = {};
                    this._needsRebuild = true;
                    logger.warn('Search', 'Visual index registry sidecar unreadable — needs rebuild');
                }
            }

            if (!this._needsRebuild) {
                await this.store.load();
                this.store.setEmbeddingMetadata(this.identity.dim, this.identity.modelId);
            }
            this.loaded = true;
            return ok(undefined);
        } catch (e) {
            return err(`visual-index-load-failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /** The C9 cache key persisted for (host, pdf) — undefined when never indexed. */
    getCacheEntry(hostPath: string, pdfPath: string): { cacheKey: string; contentHash: string } | undefined {
        const e = this.registry[hostPath]?.[pdfPath];
        return e ? { cacheKey: e.cacheKey, contentHash: e.contentHash } : undefined;
    }

    /** PDFs currently indexed for a host (C24 reconcile input). */
    indexedPdfsOf(hostPath: string): string[] {
        return Object.keys(this.registry[hostPath] ?? {});
    }

    /** All hosts with any indexed PDF (backfill resume / diagnostics). */
    hostCount(): number {
        return Object.keys(this.registry).length;
    }

    /** Replace one (host, pdf)'s pages. Blocked while `needsRebuild` (C8). */
    async upsertPages(
        hostPath: string,
        pdfPath: string,
        cache: { cacheKey: string; contentHash: string },
        pages: VisualPageUpsert[],
    ): Promise<Result<void>> {
        if (this._needsRebuild) return err('needs-rebuild');
        try {
            // Remove the prior generation of this (host, pdf) first (idempotent re-index).
            const prior = this.registry[hostPath]?.[pdfPath];
            if (prior?.ids.length) await this.store.remove(prior.ids);

            const now = Date.now();
            const docs: VectorDocument[] = pages.map((p) => ({
                id: visualDocId(hostPath, pdfPath, p.page),
                filePath: hostPath,
                chunkIndex: p.page,
                content: p.pageText,
                embedding: p.vector,
                metadata: {
                    title: basename(hostPath),
                    createdTime: now,
                    modifiedTime: now,
                    contentHash: cache.contentHash,
                    wordCount: p.pageText ? p.pageText.split(/\s+/).length : 0,
                    tokens: Math.ceil((p.pageText?.length ?? 0) / 4),
                    sourceAttachment: { name: basename(pdfPath), path: pdfPath, contentHash: cache.contentHash },
                },
            }));
            await this.store.upsert(docs);

            this.registry[hostPath] = this.registry[hostPath] ?? {};
            this.registry[hostPath][pdfPath] = {
                cacheKey: cache.cacheKey,
                contentHash: cache.contentHash,
                ids: docs.map((d) => d.id),
                pages: pages.map((p) => p.page),
            };
            if (!this.meta) {
                this.meta = { ...this.identity, createdAt: now, sourceVersion: VISUAL_SOURCE_VERSION };
            }
            await this.save();
            return ok(undefined);
        } catch (e) {
            return err(`visual-upsert-failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /** Record a no-change refresh (mtime drift, same content hash) without re-embedding. */
    async refreshCacheKey(hostPath: string, pdfPath: string, cacheKey: string): Promise<void> {
        const e = this.registry[hostPath]?.[pdfPath];
        if (!e) return;
        e.cacheKey = cacheKey;
        await this.saveRegistry();
    }

    /**
     * C19 scoped vector search — PRE-topK. Eligible hosts resolved from the registry
     * first (folderScope prefix on the HOST note path; `currentFile` excluded), then
     * exact cosine ranking over their page vectors, then topK.
     */
    async searchByVector(vector: number[], scope: RetrievalScope, limit: number): Promise<Result<VisualHit[]>> {
        if (this._needsRebuild) return err('needs-rebuild');
        if (vector.length !== this.identity.dim) return err('dim-mismatch');
        try {
            const folder = scope.folderScope ? scope.folderScope.replace(/\/+$/, '') + '/' : null;
            const eligibleHosts = Object.keys(this.registry).filter((host) => {
                if (scope.currentFile && host === scope.currentFile) return false;
                if (folder && !host.startsWith(folder)) return false;
                return true;
            });

            const hits: VisualHit[] = [];
            for (const host of eligibleHosts) {
                const docs = await this.store.getDocumentsByFile(host);
                for (const doc of docs) {
                    if (!doc.embedding?.length) continue;
                    const att = doc.metadata.sourceAttachment;
                    if (!att) continue;
                    hits.push({
                        hostNotePath: host,
                        pdfPath: att.path,
                        page: doc.chunkIndex,
                        score: cosineSimilarity(vector, doc.embedding),
                        pageText: doc.content || undefined,
                        renderRef: { pdfPath: att.path, page: doc.chunkIndex },
                    });
                }
            }
            hits.sort((a, b) => b.score - a.score);
            return ok(hits.slice(0, Math.max(0, limit)));
        } catch (e) {
            return err(`visual-search-failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /** C24: a host note was deleted — purge all its visual vectors. */
    async purgeByHostNote(hostPath: string): Promise<Result<{ removed: number }>> {
        try {
            const entry = this.registry[hostPath];
            const removed = entry ? Object.values(entry).reduce((a, e) => a + e.ids.length, 0) : 0;
            if (entry) {
                await this.store.removeFile(hostPath);
                delete this.registry[hostPath];
                await this.save();
            }
            return ok({ removed });
        } catch (e) {
            return err(`visual-purge-host-failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /** Purge one (host, pdf) pair — the C24 reconcile primitive (embed removed from note). */
    async purgeForHost(hostPath: string, pdfPath: string): Promise<Result<{ removed: number }>> {
        try {
            const entry = this.registry[hostPath]?.[pdfPath];
            if (!entry) return ok({ removed: 0 });
            await this.store.remove(entry.ids);
            delete this.registry[hostPath][pdfPath];
            if (Object.keys(this.registry[hostPath]).length === 0) delete this.registry[hostPath];
            await this.save();
            return ok({ removed: entry.ids.length });
        } catch (e) {
            return err(`visual-purge-pair-failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /** Purge one PDF's pages across ALL hosts (attachment delete). */
    async purgeByAttachmentPath(pdfPath: string): Promise<Result<{ removed: number }>> {
        try {
            let removed = 0;
            for (const [host, pdfs] of Object.entries(this.registry)) {
                const entry = pdfs[pdfPath];
                if (!entry) continue;
                await this.store.remove(entry.ids);
                removed += entry.ids.length;
                delete pdfs[pdfPath];
                if (Object.keys(pdfs).length === 0) delete this.registry[host];
            }
            if (removed > 0) await this.save();
            return ok({ removed });
        } catch (e) {
            return err(`visual-purge-attachment-failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /** C24: host note renamed — rekey its vectors + registry entry in place. */
    async rekeyHost(oldPath: string, newPath: string): Promise<Result<void>> {
        try {
            const entry = this.registry[oldPath];
            if (!entry) return ok(undefined);
            // Voy doc ids embed the host path — rebuild the docs under the new key.
            const docs = await this.store.getDocumentsByFile(oldPath);
            await this.store.removeFile(oldPath);
            const rekeyed = docs.map((d) => ({
                ...d,
                id: d.metadata.sourceAttachment
                    ? visualDocId(newPath, d.metadata.sourceAttachment.path, d.chunkIndex)
                    : `${newPath}::vis::unknown#${d.chunkIndex}`,
                filePath: newPath,
            }));
            if (rekeyed.length) await this.store.upsert(rekeyed);
            delete this.registry[oldPath];
            this.registry[newPath] = Object.fromEntries(
                Object.entries(entry).map(([pdf, e]) => [pdf, {
                    ...e,
                    ids: e.ids.map((id) => {
                        const m = /::vis::(.+)#(\d+)$/.exec(id);
                        return m ? `${newPath}::vis::${m[1]}#${m[2]}` : id;
                    }),
                }]),
            );
            await this.save();
            return ok(undefined);
        } catch (e) {
            return err(`visual-rekey-failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /** C8: user-confirmed rebuild — wipe everything, adopt the live identity, clear the flag.
     *  The caller (main.ts) then triggers the C23 backfill to re-derive the index. */
    async confirmRebuild(identity: VisualIndexIdentity): Promise<Result<void>> {
        const wiped = await this.deleteAll();
        if (!wiped.ok) return wiped;
        this.identity = identity;
        this.store = this.storeFactory(this.app, identity.dim, this.storagePath);
        this.registry = {};
        this.meta = null;
        this._needsRebuild = false;
        this.loaded = true;
        return ok(undefined);
    }

    /** C14: delete the WHOLE visual namespace — index, sidecars, cache, temp rebuild paths. */
    async deleteAll(): Promise<Result<void>> {
        try {
            const adapter = this.app.vault.adapter;
            // Drop in-memory state WITHOUT saving (dispose() would re-write the files).
            this.registry = {};
            this.meta = null;
            for (const path of [this.storagePath, `${this.storagePath}-rebuild`]) {
                try {
                    if (await adapter.exists(path)) await adapter.rmdir(path, true);
                } catch (e) {
                    logger.warn('Search', `Visual teardown: failed to remove ${path}: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            // Fresh empty store object so any late caller can't resurrect the old data.
            this.store = this.storeFactory(this.app, this.identity.dim, this.storagePath);
            return ok(undefined);
        } catch (e) {
            return err(`visual-delete-failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /**
     * Persist index + both sidecars. NOT transactional, BY DESIGN (audit H21): the
     * registry is the SSOT for "what is indexed", and staleness in EITHER direction
     * self-heals on the next index pass — a lost registry write leaves a stale cacheKey
     * → fingerprint mismatch → re-embed → `upsertPages` removes the prior generation's
     * ids before upserting (idempotent replace); a lost store write leaves registry ids
     * pointing at missing docs → fewer rows returned → the next reconcile re-upserts.
     * No mixed-IDENTITY state is reachable (C8 blocks all writes under needsRebuild),
     * and the whole index is re-derivable from vault PDFs (C23), so a journal layer
     * would be over-engineering.
     */
    async save(): Promise<void> {
        if (this._needsRebuild) return; // never write a mixed-identity state (C8)
        await this.store.save();
        await this.saveMeta();
        await this.saveRegistry();
    }

    /** Save sidecars + release in-memory store WITHOUT deleting files (plugin unload). */
    async dispose(): Promise<void> {
        try {
            if (this.loaded && !this._needsRebuild) await this.save();
        } catch (e) {
            logger.warn('Search', `Visual index save-on-dispose failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    private async saveMeta(): Promise<void> {
        if (!this.meta) return;
        const adapter = this.app.vault.adapter;
        if (!(await adapter.exists(this.storagePath))) await adapter.mkdir(this.storagePath);
        await adapter.write(`${this.storagePath}/visual-meta.json`, JSON.stringify(this.meta));
    }

    private async saveRegistry(): Promise<void> {
        const adapter = this.app.vault.adapter;
        if (!(await adapter.exists(this.storagePath))) await adapter.mkdir(this.storagePath);
        await adapter.write(`${this.storagePath}/visual-registry.json`, JSON.stringify({ hosts: this.registry } satisfies RegistrySidecar));
    }
}
