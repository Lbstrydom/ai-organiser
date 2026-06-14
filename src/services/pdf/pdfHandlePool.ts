/**
 * Ref-counted PDF handle pool (CA1 — Gemini R3 G1).
 *
 * C25's per-batch render and C9's single-flight sharing would otherwise interact badly
 * with C6's dispose-on-every-path: sequential embed batches re-parse a large PDF every
 * batch, and one lane's `dispose()` can destroy a `PDFDocumentProxy` still in use by the
 * other lane. The pool fixes both: consumers `lease()` a reference, `release()` decrements,
 * and `PDFDocumentProxy.destroy()` fires only when the ref-count hits 0 AND a short TTL
 * (default 8s) expires — amortizing sequential batches while protecting concurrent
 * text/visual consumers.
 *
 * Keyed by vault path + mtime (a re-saved PDF must not serve the stale parse).
 */
import type { TFile } from 'obsidian';
import type { Result } from '../../core/result';
import { ok, err } from '../../core/result';
import { loadPdf, type PdfHandle, type PdfRendererDeps } from './pdfPageRenderer';

export const PDF_HANDLE_TTL_MS = 8_000;

export interface PdfLease {
    readonly handle: PdfHandle;
    /** Idempotent. */
    release(): void;
}

interface PoolEntry {
    key: string;
    handle: PdfHandle | null;        // null while loading
    loading: Promise<Result<PdfHandle>> | null;
    refs: number;
    destroyTimer: ReturnType<typeof setTimeout> | null;
}

type ScheduleFn = (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
type CancelFn = (handle: ReturnType<typeof setTimeout>) => void;

export class PdfHandlePool {
    private readonly entries = new Map<string, PoolEntry>();
    private readonly schedule: ScheduleFn;
    private readonly cancel: CancelFn;
    private disposed = false;

    constructor(
        private readonly deps: PdfRendererDeps,
        private readonly ttlMs: number = PDF_HANDLE_TTL_MS,
        timers?: { schedule: ScheduleFn; cancel: CancelFn },
    ) {
        this.schedule = timers?.schedule ?? ((fn, ms) => setTimeout(fn, ms));
        this.cancel = timers?.cancel ?? ((h) => clearTimeout(h));
    }

    /** Lease a shared handle for `file`. Single-flight: concurrent leases for the same
     *  (path, mtime) await one parse (C9/G4). Errors are NOT cached — a failed load
     *  re-attempts on the next lease. */
    async lease(file: TFile): Promise<Result<PdfLease>> {
        if (this.disposed) return err('pool-disposed');
        const key = `${file.path}|${file.stat?.mtime ?? 0}`;
        let entry = this.entries.get(key);
        if (!entry) {
            entry = { key, handle: null, loading: null, refs: 0, destroyTimer: null };
            this.entries.set(key, entry);
        }

        // Cancel a pending TTL destroy — a new lease revives the entry.
        if (entry.destroyTimer !== null) {
            this.cancel(entry.destroyTimer);
            entry.destroyTimer = null;
        }

        entry.refs++;
        try {
            if (!entry.handle) {
                if (!entry.loading) entry.loading = loadPdf(file, this.deps);
                const r = await entry.loading;
                entry.loading = null;
                if (!r.ok) {
                    entry.refs--;
                    if (entry.refs <= 0) this.entries.delete(key);
                    return r;
                }
                // Another waiter may have set it while we awaited; keep the first.
                if (!entry.handle) entry.handle = r.value;
                else if (r.value !== entry.handle) r.value.dispose();
            }
        } catch (e) {
            entry.refs--;
            entry.loading = null;
            if (entry.refs <= 0) this.entries.delete(key);
            return err(`pdf-load-failed: ${e instanceof Error ? e.message : String(e)}`);
        }

        const handle = entry.handle;
        let released = false;
        return ok({
            handle,
            release: () => {
                if (released) return;
                released = true;
                this.releaseEntry(entry);
            },
        });
    }

    /** Destroy everything immediately (teardown / unload). Safe with live leases —
     *  pdf.js destroy on an in-use proxy degrades to a failed render, never a leak. */
    disposeAll(): void {
        this.disposed = true;
        for (const entry of this.entries.values()) {
            if (entry.destroyTimer !== null) this.cancel(entry.destroyTimer);
            entry.handle?.dispose();
        }
        this.entries.clear();
    }

    /** Live entry count (tests). */
    get size(): number { return this.entries.size; }

    private releaseEntry(entry: PoolEntry): void {
        entry.refs--;
        if (entry.refs > 0 || !entry.handle) return;
        // Last ref gone — destroy after the TTL unless a new lease revives it.
        entry.destroyTimer = this.schedule(() => {
            entry.destroyTimer = null;
            if (entry.refs <= 0) {
                entry.handle?.dispose();
                this.entries.delete(entry.key);
            }
        }, this.ttlMs);
    }
}
