/**
 * Attachment lifecycle coordinator (azure-capability-completion-v2 — C10/C12/C16,
 * Cluster A / Phase 1).
 *
 * The SINGLE ingress for attachment (non-markdown) vault events (C16). `main.ts` routes
 * modify/delete/rename of non-markdown files here; the direct
 * `main.ts → vectorStoreService.onAttachmentChanged` path does NOT exist. Phase 1 registers
 * the TEXT consumer (gated `indexAttachmentText`); Phase 6 registers the VISUAL consumer
 * (gated `visual-search`) on the SAME coordinator — so attachment events reach the visual
 * index even when text indexing is off (C12).
 *
 * Capture-order (C10) lives here: affected HOST NOTES are captured BEFORE metadata loss and
 * from BOTH link maps (`resolvedLinks` AND `unresolvedLinks`) for BOTH `oldPath` and the new
 * path — because Obsidian often moves a deleted/renamed target into `unresolvedLinks`
 * *before* the vault event fires, so a resolved-only scan orphans the host's vectors. No
 * custom persisted reverse index — the native metadata cache suffices when read at the right
 * moment across both maps.
 *
 * Injected `MetadataLinkSource` keeps the capture logic Obsidian-free + unit-testable.
 */

import type { Result } from '../core/result';
import { logger } from '../utils/logger';

export type AttachmentChangeKind = 'modify' | 'delete' | 'rename';

export interface AttachmentChangeEvent {
    /** Current attachment vault path (the new path on rename). */
    path: string;
    kind: AttachmentChangeKind;
    /** Previous path (rename only). */
    oldPath?: string;
    /** Host note paths (markdown) that reference this attachment — captured at event time. */
    hosts: string[];
}

/** A registered index lane (text in Phase 1, visual in Phase 6). Each SELF-GATES on its
 *  own feature flag — the coordinator dispatches unconditionally. */
export interface AttachmentConsumer {
    onAttachmentChanged(ev: AttachmentChangeEvent): Promise<Result<void>>;
    purgeByAttachmentPath(path: string): Promise<Result<{ removed: number }>>;
}

/** The two native Obsidian link maps, injected so the coordinator stays testable.
 *  Shapes mirror `metadataCache.resolvedLinks` / `.unresolvedLinks`:
 *  `Record<sourceNotePath, Record<target, count>>` — resolved targets are vault paths,
 *  unresolved targets are raw link text. */
export interface MetadataLinkSource {
    resolvedLinks: Record<string, Record<string, number>>;
    unresolvedLinks: Record<string, Record<string, number>>;
}

function basename(path: string): string {
    const i = path.lastIndexOf('/');
    return i >= 0 ? path.slice(i + 1) : path;
}

/** True when an unresolved link text plausibly refers to `target` (exact path, or basename
 *  match — Obsidian stores short-form links by basename). */
function unresolvedMatches(linkText: string, target: string): boolean {
    if (!linkText || !target) return false;
    if (linkText === target) return true;
    const lt = linkText.toLowerCase();
    const tgt = target.toLowerCase();
    if (lt === tgt) return true;
    return basename(lt) === basename(tgt);
}

/**
 * Pure host-capture (C10): host notes referencing `path` (and `oldPath`), scanned across
 * BOTH link maps. Deduped, markdown sources only. Shared by the coordinator AND
 * `vectorStoreService.purgeByAttachmentPath` so the resolved+unresolved scan lives once.
 */
export function captureAttachmentHosts(links: MetadataLinkSource, path: string, oldPath?: string): string[] {
    const targets = [path, ...(oldPath ? [oldPath] : [])];
    const hosts = new Set<string>();

    for (const [source, outbound] of Object.entries(links.resolvedLinks ?? {})) {
        if (!source.toLowerCase().endsWith('.md')) continue;
        for (const tgt of Object.keys(outbound)) {
            if (targets.some(t => t.toLowerCase() === tgt.toLowerCase())) { hosts.add(source); break; }
        }
    }
    for (const [source, outbound] of Object.entries(links.unresolvedLinks ?? {})) {
        if (!source.toLowerCase().endsWith('.md')) continue;
        for (const linkText of Object.keys(outbound)) {
            if (targets.some(t => unresolvedMatches(linkText, t))) { hosts.add(source); break; }
        }
    }
    return [...hosts];
}

export class AttachmentLifecycleCoordinator {
    private readonly consumers: AttachmentConsumer[] = [];

    /** @param getLinks reads the CURRENT link maps at dispatch time (never cached). */
    constructor(private readonly getLinks: () => MetadataLinkSource) {}

    register(consumer: AttachmentConsumer): void {
        this.consumers.push(consumer);
    }

    /** Unregister a consumer (CA3): `teardownFeature('visual-search')` MUST unregister the
     *  visual consumer BEFORE disposing it, else post-teardown vault edits dispatch to a
     *  dead service. Identity-based; unknown consumers are a no-op. */
    unregister(consumer: AttachmentConsumer): void {
        const i = this.consumers.indexOf(consumer);
        if (i >= 0) this.consumers.splice(i, 1);
    }

    /** True once at least one consumer is registered (lets `main.ts` skip wiring when off). */
    get hasConsumers(): boolean {
        return this.consumers.length > 0;
    }

    /** Host notes referencing `path` (and `oldPath`), captured at THIS moment. Test seam. */
    captureHosts(path: string, oldPath?: string): string[] {
        return captureAttachmentHosts(this.getLinks(), path, oldPath);
    }

    /**
     * Handle one attachment vault event: capture hosts (at THIS moment) then dispatch to every
     * registered consumer. Per-consumer isolation — one lane's failure never blocks the other
     * or the event loop. Never throws.
     */
    async handleChange(kind: AttachmentChangeKind, path: string, oldPath?: string): Promise<void> {
        const hosts = this.captureHosts(path, oldPath);
        const ev: AttachmentChangeEvent = { path, kind, oldPath, hosts };
        // Snapshot (audit R2-M5): register/unregister during an in-flight dispatch
        // (e.g. teardown mid-event) must not skip or double-dispatch a consumer.
        for (const consumer of [...this.consumers]) {
            try {
                const r = await consumer.onAttachmentChanged(ev);
                if (!r.ok) logger.warn('Attachment', `consumer rejected ${kind} ${path}: ${r.error}`);
            } catch (e) {
                logger.warn('Attachment', `consumer threw on ${kind} ${path}`, e);
            }
        }
    }
}
