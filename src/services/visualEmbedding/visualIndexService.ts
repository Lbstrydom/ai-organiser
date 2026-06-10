/**
 * Visual index service (plan Phase 6) — the indexing lane orchestrator:
 * note → linked PDFs → figure pages (C7) → visual queue → second Voy lane.
 *
 * Lifecycle surfaces:
 *  - `AttachmentConsumer` (C12/C16): registered on the SAME lifecycle coordinator as the
 *    text lane; self-gates on `isEnabled()` (the visual-search feature flag).
 *  - HOST-NOTE lifecycle (C24): `noteModified` reconciles the note's current embedded-PDF
 *    set against the indexed set (purges de-linked PDFs, indexes new ones); `noteDeleted`
 *    purges; `noteRenamed` rekeys. Without this, deleting a note or removing an
 *    `![[deck.pdf]]` embed would orphan vectors into RAG.
 *  - C23 backfill: `backfillVault()` walks existing PDF-bearing notes so pre-existing PDFs
 *    become retrievable without an edit event. Bounded by the C9 cache (unchanged PDFs
 *    skip) + the per-attachment page cap (G3); paced by the cap-1 queue, which also
 *    yields to foreground work.
 *
 * C25 — queued `VisualPageTask`s hold POINTERS only; the injected queue backend (built in
 * `main.ts`) opens a pooled handle (CA1), renders the ≤batch pages, embeds, and discards.
 * C9 — skip-unchanged via the repository registry: cheap (size/mtime) cache-key prefilter,
 * lazy content hash for changed candidates (sync/copy mtime drift refreshes the key
 * without re-embedding).
 */
import type { App, TFile } from 'obsidian';
import { TFile as ObsidianTFile } from 'obsidian';
import type { Result } from '../../core/result';
import { ok, err } from '../../core/result';
import { logger } from '../../utils/logger';
import type { AttachmentChangeEvent, AttachmentConsumer } from '../attachmentLifecycleCoordinator';
import type { GenericEmbeddingQueue } from '../vector/embeddingQueue';
import { fingerprintOf, fingerprintCacheKey, computeAttachmentContentHash } from '../vector/attachmentFingerprint';
import type { PdfHandlePool } from '../pdf/pdfHandlePool';
import type { VisualIndexRepository, VisualIndexIdentity } from './visualIndexRepository';
import { VISUAL_SOURCE_VERSION } from './visualIndexRepository';
import type { VisualPageTask } from './types';

export interface VisualIndexServiceDeps {
    app: App;
    repository: VisualIndexRepository;
    queue: GenericEmbeddingQueue<VisualPageTask>;
    pool: PdfHandlePool;
    /** Feature self-gate (C12) — read live, never cached. */
    isEnabled: () => boolean;
    /** Live identity of the selected backend (cache-key salt component). */
    getIdentity: () => VisualIndexIdentity;
    /** G3 page cap per attachment (live from settings). */
    getMaxPagesPerAttachment: () => number;
}

/** Queue key for one (host, pdf) batch — supersede granularity. */
function batchKey(hostPath: string, pdfPath: string): string {
    return `${hostPath}::vis::${pdfPath}`;
}

export class VisualIndexService implements AttachmentConsumer {
    private backfillRunning = false;
    private backfillCancelled = false;

    constructor(private readonly deps: VisualIndexServiceDeps) {}

    // ── AttachmentConsumer (C12/C16) ─────────────────────────────────────────

    async onAttachmentChanged(ev: AttachmentChangeEvent): Promise<Result<void>> {
        if (!this.deps.isEnabled()) return ok(undefined);
        try {
            if (ev.kind === 'delete') {
                const r = await this.deps.repository.purgeByAttachmentPath(ev.path);
                return r.ok ? ok(undefined) : err(r.error);
            }
            if (ev.kind === 'rename' && ev.oldPath) {
                // Old ids/registry key the old pdf path — purge, then re-index hosts.
                await this.deps.repository.purgeByAttachmentPath(ev.oldPath);
            }
            if (!ev.path.toLowerCase().endsWith('.pdf')) return ok(undefined);
            for (const host of ev.hosts) {
                await this.indexHostNote(host);
            }
            return ok(undefined);
        } catch (e) {
            return err(`visual-attachment-event-failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    async purgeByAttachmentPath(path: string): Promise<Result<{ removed: number }>> {
        if (!this.deps.isEnabled()) return ok({ removed: 0 });
        return this.deps.repository.purgeByAttachmentPath(path);
    }

    // ── Host-note lifecycle (C24) ────────────────────────────────────────────

    async noteDeleted(hostPath: string): Promise<Result<{ removed: number }>> {
        if (!this.deps.isEnabled()) return ok({ removed: 0 });
        this.removePendingFor(hostPath);
        return this.deps.repository.purgeByHostNote(hostPath);
    }

    async noteRenamed(oldPath: string, newPath: string): Promise<Result<void>> {
        if (!this.deps.isEnabled()) return ok(undefined);
        // Drop batches still queued under the OLD host key (audit H10) — their persist
        // callbacks capture the old path and would write under a stale key after rekey.
        this.removePendingFor(oldPath);
        const rekeyed = await this.deps.repository.rekeyHost(oldPath, newPath);
        if (!rekeyed.ok) return rekeyed;
        // Re-index under the new key so anything dropped above re-enqueues fresh.
        return this.indexHostNote(newPath);
    }

    async noteModified(hostPath: string): Promise<Result<void>> {
        if (!this.deps.isEnabled()) return ok(undefined);
        return this.indexHostNote(hostPath);
    }

    // ── Indexing pipeline ────────────────────────────────────────────────────

    /**
     * Index (or reconcile, C24) one host note: purge vectors for de-linked PDFs, then
     * fingerprint-gate + enqueue figure pages for each currently-linked PDF. Never throws.
     */
    async indexHostNote(hostPath: string): Promise<Result<void>> {
        if (!this.deps.isEnabled()) return ok(undefined);
        if (this.deps.repository.needsRebuild) return err('needs-rebuild');
        try {
            const { app, repository } = this.deps;
            const hostFile = app.vault.getAbstractFileByPath(hostPath);
            if (!(hostFile instanceof ObsidianTFile)) {
                // Host vanished between capture and dispatch — purge its vectors.
                await repository.purgeByHostNote(hostPath);
                return ok(undefined);
            }

            const linkedPdfs = this.linkedPdfPathsOf(hostPath);

            // C24 reconcile: indexed-but-no-longer-linked PDFs lose their vectors.
            for (const indexed of repository.indexedPdfsOf(hostPath)) {
                if (!linkedPdfs.includes(indexed)) {
                    const purged = await repository.purgeForHost(hostPath, indexed);
                    if (!purged.ok) logger.warn('Search', `Visual reconcile purge failed for ${indexed}: ${purged.error}`);
                }
            }

            for (const pdfPath of linkedPdfs) {
                const pdfFile = app.vault.getAbstractFileByPath(pdfPath);
                if (!(pdfFile instanceof ObsidianTFile)) continue;
                await this.indexPdfForHost(hostPath, pdfFile);
            }
            return ok(undefined);
        } catch (e) {
            return err(`visual-index-note-failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /**
     * C23 on-enable backfill: walk every markdown note with a linked PDF. Sequential —
     * the cap-1 queue paces embedding; the C9 cache makes re-runs cheap (resume = re-run).
     */
    async backfillVault(): Promise<Result<{ notes: number }>> {
        if (!this.deps.isEnabled()) return ok({ notes: 0 });
        if (this.backfillRunning) return err('backfill-already-running');
        this.backfillRunning = true;
        this.backfillCancelled = false;
        try {
            const files = this.deps.app.vault.getMarkdownFiles();
            let notes = 0;
            for (const f of files) {
                if (this.backfillCancelled || !this.deps.isEnabled()) break;
                if (this.linkedPdfPathsOf(f.path).length === 0) continue;
                await this.indexHostNote(f.path);
                notes++;
            }
            logger.debug('Search', `Visual backfill complete: ${notes} PDF-bearing notes processed`);
            return ok({ notes });
        } catch (e) {
            return err(`visual-backfill-failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            this.backfillRunning = false;
        }
    }

    /** Cancel a running backfill (teardown). */
    cancelBackfill(): void {
        this.backfillCancelled = true;
    }

    get isBackfillRunning(): boolean { return this.backfillRunning; }

    // ── Internals ────────────────────────────────────────────────────────────

    /** EMBEDDED .pdf targets of a host note. EMBEDS ONLY (audit H3): `![[deck.pdf]]` is
     *  the consent surface named in C18/C24 — a plain `[[deck.pdf]]` mention must NOT
     *  transmit that PDF's page images to the embedding backend. Resolved via the
     *  metadata cache (an unresolved embed has no file to render). */
    private linkedPdfPathsOf(hostPath: string): string[] {
        const { app } = this.deps;
        const hostFile = app.vault.getAbstractFileByPath(hostPath);
        if (!(hostFile instanceof ObsidianTFile)) return [];
        const embeds = app.metadataCache.getFileCache(hostFile)?.embeds ?? [];
        const out = new Set<string>();
        for (const e of embeds) {
            const linkpath = e.link.split('#')[0]; // strip subpath/page fragments
            const target = app.metadataCache.getFirstLinkpathDest(linkpath, hostPath);
            if (target && target.path.toLowerCase().endsWith('.pdf')) out.add(target.path);
        }
        return [...out];
    }

    /** Fingerprint-gate one (host, pdf), then detect figure pages + enqueue pointer tasks. */
    private async indexPdfForHost(hostPath: string, pdfFile: TFile): Promise<void> {
        const { repository, pool, queue, app } = this.deps;
        const identity = this.deps.getIdentity();
        const salt = `vis|${identity.backend}|${identity.modelId}|${identity.dim}|v${VISUAL_SOURCE_VERSION}`;
        const fp = fingerprintOf(pdfFile);
        const cacheKey = fingerprintCacheKey(fp, salt);

        const cached = repository.getCacheEntry(hostPath, pdfFile.path);
        if (cached?.cacheKey === cacheKey) return; // unchanged (cheap prefilter, C9)

        // Changed candidate — lazy content hash (C13): a sync/copy that altered mtime but
        // not bytes refreshes the cache key WITHOUT re-rendering/re-embedding.
        let contentHash: string;
        try {
            contentHash = await computeAttachmentContentHash(app, pdfFile);
        } catch (e) {
            logger.warn('Search', `Visual index: hash failed for ${pdfFile.path}: ${e instanceof Error ? e.message : String(e)}`);
            return;
        }
        if (cached && cached.contentHash === contentHash) {
            await repository.refreshCacheKey(hostPath, pdfFile.path, cacheKey);
            return;
        }

        // Detect figure pages + capture page text (the DP-1 payload) with ONE pooled handle.
        const lease = await pool.lease(pdfFile);
        if (!lease.ok) {
            // `pdfjs-unavailable` is needs-retry (G1): do NOT record the cache key, so a
            // later run (after pdf.js loads) re-attempts this PDF.
            logger.warn('Search', `Visual index: cannot open ${pdfFile.path}: ${lease.error}`);
            return;
        }
        let tasks: VisualPageTask[];
        try {
            const detect = await lease.value.handle.detectFigurePages(this.deps.getMaxPagesPerAttachment());
            if (detect.capped) {
                logger.debug('Search', `Visual index: ${pdfFile.path} figure pages capped at ${this.deps.getMaxPagesPerAttachment()} (visual-pages-capped)`);
            }
            tasks = [];
            for (const fig of detect.pages) {
                const pageText = await lease.value.handle.getPageText(fig.page);
                tasks.push({
                    hostNotePath: hostPath,
                    pdfPath: pdfFile.path,
                    pageNumber: fig.page,
                    contentHash,
                    pageText: pageText || undefined,
                });
            }
        } catch (e) {
            logger.warn('Search', `Visual index: figure scan failed for ${pdfFile.path}: ${e instanceof Error ? e.message : String(e)}`);
            return;
        } finally {
            lease.value.release();
        }

        if (tasks.length === 0) {
            // No figure pages — record the cache entry so we don't rescan every event.
            await repository.upsertPages(hostPath, pdfFile.path, { cacheKey, contentHash }, []);
            return;
        }

        // Enqueue pointer tasks (C25); the backend renders + embeds lazily per batch.
        void queue.enqueueKeyed(batchKey(hostPath, pdfFile.path), tasks, async (vectors) => {
            // Liveness re-check (audit H18): the host may have been deleted/renamed or
            // the embed removed while this batch waited in the paced queue — persisting
            // then would resurrect purged vectors under a stale key.
            const hostStillExists = app.vault.getAbstractFileByPath(hostPath) instanceof ObsidianTFile;
            if (!hostStillExists || !this.linkedPdfPathsOf(hostPath).includes(pdfFile.path)) {
                logger.debug('Search', `Visual index: skipping persist for ${hostPath} → ${pdfFile.path} (no longer linked)`);
                return;
            }
            const pages = tasks.map((t, i) => ({
                page: t.pageNumber,
                vector: vectors[i] ?? [],
                pageText: t.pageText ?? '',
            })).filter((p) => p.vector.length > 0);
            if (pages.length === 0) {
                logger.warn('Search', `Visual index: all embeddings empty for ${pdfFile.path} — not persisted`);
                return;
            }
            const r = await repository.upsertPages(hostPath, pdfFile.path, { cacheKey, contentHash }, pages);
            if (!r.ok) logger.warn('Search', `Visual index: persist failed for ${pdfFile.path}: ${r.error}`);
        });
    }

    /** Drop pending queue batches for a host (note delete). Best-effort: removes batches
     *  for currently-indexed pdfs; a pending batch for a brand-new pdf settles as a no-op
     *  when its onBatchSuccess persists into a purged host. */
    private removePendingFor(hostPath: string): void {
        for (const pdf of this.deps.repository.indexedPdfsOf(hostPath)) {
            this.deps.queue.removePath(batchKey(hostPath, pdf));
        }
    }
}
