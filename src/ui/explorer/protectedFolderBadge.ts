/**
 * Protected-folder shield (explorer badge): the DOM half.
 *
 * Obsidian has no explorer-decoration API, so this tags the file explorer's folder rows
 * (`.nav-folder-title[data-path]`) that belong to a protected root: it adds one class to the row
 * and appends one shield element, drawn by `styles.css`. It reads state lazily through `deps`, so
 * the controller never caches the protected list and has no Obsidian imports (testable in happy-dom).
 *
 * Contract:
 * - Inert when unused: with the toggle off or an empty list there is no MutationObserver, no timer and
 *   no DOM edit, and everything this controller added is removed.
 * - One observer per explorer container. Its callback is incremental and NOT throttled: observer
 *   callbacks run as microtasks before paint, so a freshly expanded protected folder is never painted
 *   without its shield. Only full passes (refresh, layout change) are throttled.
 * - A title is never forgotten without first being cleaned, and `dispose()` removes everything.
 */
import {
    buildBadgeIndex,
    isBadged,
    EXPLORER_FOLDER_TITLE_SELECTOR,
    PROTECTED_FOLDER_CLASS,
    PROTECTED_SHIELD_CLASS,
    type BadgeIndex,
} from '../../core/protectedFolderBadge';
import { logger } from '../../utils/logger';

export interface ProtectedFolderBadgeDeps {
    /** Container elements of every open file explorer (stable across view swaps). */
    getContainers(): readonly HTMLElement[];
    getState(): { enabled: boolean; folders: readonly string[] };
    getTooltip(): string;
}

/** A single observer batch above this size falls back to one full pass over its container. */
const MAX_INCREMENTAL_RECORDS = 500;
/** Full passes are leading + trailing throttled to this window. */
const FULL_PASS_WINDOW_MS = 100;

interface Tracked {
    observer: MutationObserver;
    tagged: Set<HTMLElement>;
}

export class ProtectedFolderBadge {
    private readonly tracked = new Map<HTMLElement, Tracked>();
    private index: BadgeIndex = new Set();
    private tooltip = '';
    private timer: number | null = null;
    private cooling = false;
    private pending = false;
    private disposed = false;

    constructor(private readonly deps: ProtectedFolderBadgeDeps) {}

    /** Re-read the settings and the open explorers. Leading + trailing throttled; a no-op while inert. */
    refresh(): void {
        if (this.disposed) return;
        if (this.cooling) {
            this.pending = true;
            return;
        }
        if (!this.isActive() && this.tracked.size === 0) return; // inert: no pass, no timer
        this.runFullPass();
        this.cooling = true;
        this.timer = window.setTimeout(() => {
            this.timer = null;
            this.cooling = false;
            if (this.pending) {
                this.pending = false;
                this.refresh();
            }
        }, FULL_PASS_WINDOW_MS);
    }

    /** Remove everything this controller added and stop observing. Safe to call twice. */
    dispose(): void {
        this.disposed = true;
        if (this.timer !== null) window.clearTimeout(this.timer);
        this.timer = null;
        this.cooling = false;
        this.pending = false;
        this.teardownAll();
    }

    private isActive(): boolean {
        const state = this.deps.getState();
        return state.enabled && state.folders.length > 0;
    }

    private runFullPass(): void {
        try {
            this.readState();
            if (this.index.size === 0) {
                this.teardownAll();
                return;
            }
            const live = new Set(this.deps.getContainers().filter((c) => c.isConnected));
            for (const container of [...this.tracked.keys()]) {
                if (!live.has(container)) this.retire(container);
            }
            for (const container of live) {
                if (!this.tracked.has(container)) this.observe(container);
                this.fullPass(container);
            }
        } catch (e) {
            this.failClosed(e);
        }
    }

    /**
     * Re-read the live settings. Called at the start of every pass AND every observer batch, so a rename
     * that remaps the list and moves the row in the same moment never repaints with the previous list.
     */
    private readState(): void {
        const state = this.deps.getState();
        this.index = state.enabled ? buildBadgeIndex(state.folders) : new Set();
        this.tooltip = this.deps.getTooltip();
    }

    private observe(container: HTMLElement): void {
        const entry: Tracked = {
            observer: new MutationObserver((records) => this.onMutations(container, records)),
            tagged: new Set(),
        };
        entry.observer.observe(container, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['data-path'],
        });
        this.tracked.set(container, entry);
    }

    private onMutations(container: HTMLElement, records: MutationRecord[]): void {
        const entry = this.tracked.get(container);
        if (!entry || this.disposed) return;
        try {
            this.readState();
            if (records.length > MAX_INCREMENTAL_RECORDS) {
                this.fullPass(container);
                return;
            }
            for (const record of records) {
                const target = record.target;
                if (!isElement(target)) continue;
                const owner = target.closest(EXPLORER_FOLDER_TITLE_SELECTOR);
                if (owner) this.tagTitle(owner as HTMLElement, entry);
                // A decorated row that lost its data-path no longer matches the selector: clean it.
                else if (record.type === 'attributes' && entry.tagged.has(target as HTMLElement)) this.untag(target as HTMLElement, entry);
                if (record.type !== 'childList') continue;
                record.removedNodes.forEach((node) => {
                    if (!isElement(node)) return;
                    // A row that left the explorer is cleaned now, not at the next full pass.
                    if (node.matches(EXPLORER_FOLDER_TITLE_SELECTOR)) this.untag(node as HTMLElement, entry);
                    node.querySelectorAll<HTMLElement>(EXPLORER_FOLDER_TITLE_SELECTOR).forEach((t) => this.untag(t, entry));
                });
                record.addedNodes.forEach((node) => {
                    if (!isElement(node)) return;
                    if (node.matches(EXPLORER_FOLDER_TITLE_SELECTOR)) this.tagTitle(node as HTMLElement, entry);
                    node.querySelectorAll<HTMLElement>(EXPLORER_FOLDER_TITLE_SELECTOR).forEach((t) => this.tagTitle(t, entry));
                });
            }
            entry.observer.takeRecords(); // drop the records our own edits just produced
        } catch (e) {
            this.failClosed(e);
        }
    }

    /**
     * A failed pass may have stopped half-way. A stale shield on a folder that is no longer protected is a
     * false safety cue, so clear everything; the next refresh or layout change rebuilds from the live state.
     */
    private failClosed(e: unknown): void {
        logger.warn('ProtectedBadge', `Could not update the explorer shield: ${e instanceof Error ? e.message : String(e)}`);
        try {
            this.teardownAll();
        } catch (inner) {
            logger.warn('ProtectedBadge', `Could not clear the explorer shield: ${inner instanceof Error ? inner.message : String(inner)}`);
        }
    }

    private fullPass(container: HTMLElement): void {
        const entry = this.tracked.get(container);
        if (!entry) return;
        const present = new Set<HTMLElement>(Array.from(container.querySelectorAll<HTMLElement>(EXPLORER_FOLDER_TITLE_SELECTOR)));
        for (const title of present) this.tagTitle(title, entry);
        for (const title of [...entry.tagged]) {
            if (!present.has(title)) this.untag(title, entry); // detached or replaced rows: clean before forgetting
        }
        entry.observer.takeRecords();
    }

    /** Idempotent: converge one row on the state the index asks for. */
    private tagTitle(title: HTMLElement, entry: Tracked): void {
        if (isBadged(this.index, title.getAttribute('data-path'))) {
            if (!title.classList.contains(PROTECTED_FOLDER_CLASS)) title.classList.add(PROTECTED_FOLDER_CLASS);
            this.ensureShield(title);
            entry.tagged.add(title);
        } else if (entry.tagged.has(title) || title.classList.contains(PROTECTED_FOLDER_CLASS)) {
            this.untag(title, entry);
        }
    }

    private ensureShield(title: HTMLElement): void {
        const shields = shieldsOf(title);
        let shield = shields[0];
        for (const extra of shields.slice(1)) extra.remove();
        if (!shield) {
            shield = title.ownerDocument.createElement('span');
            shield.className = PROTECTED_SHIELD_CLASS;
            shield.setAttribute('role', 'img');
            title.appendChild(shield);
        }
        if (shield.getAttribute('aria-label') !== this.tooltip) shield.setAttribute('aria-label', this.tooltip);
    }

    private untag(title: HTMLElement, entry: Tracked): void {
        title.classList.remove(PROTECTED_FOLDER_CLASS);
        for (const shield of shieldsOf(title)) shield.remove();
        entry.tagged.delete(title);
    }

    /** Disconnect one container's observer and clean every row it tagged. */
    private retire(container: HTMLElement): void {
        const entry = this.tracked.get(container);
        if (!entry) return;
        entry.observer.disconnect();
        for (const title of [...entry.tagged]) this.untag(title, entry);
        this.tracked.delete(container);
    }

    private teardownAll(): void {
        for (const container of [...this.tracked.keys()]) this.retire(container);
    }
}

function isElement(node: Node): node is Element {
    return node.nodeType === 1;
}

function shieldsOf(title: HTMLElement): HTMLElement[] {
    return Array.from(title.children).filter((c): c is HTMLElement => c.classList.contains(PROTECTED_SHIELD_CLASS));
}
