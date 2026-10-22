/**
 * The three proposing tasks of the vault upkeep sweep, plus the types they share. Pure of Obsidian:
 * everything the tasks need from the vault comes through `UpkeepEnv`, so they are tested with fakes.
 *
 * A task produces `Proposal`s and never writes a user note. The only automatic write anywhere in
 * the upkeep is the opt-in refresh of the agent-index file (a plugin-owned, signed artefact), which
 * is done through `env.refreshIndex` and only when the execution policy allows it.
 */
import { Result, ok, err } from '../../core/result';

export type TaskName = 'agentIndex' | 'inventories' | 'attachments';

export type Proposal =
    | { kind: 'agent-index-stale'; added: number; removed: number; changed: number; unreadable: number; unstable: boolean }
    | { kind: 'agent-index-refreshed'; path: string }
    | { kind: 'inventory-differs'; pairId: string; hubPath: string }
    | { kind: 'attachment-unreferenced'; path: string; sizeBytes: number }
    | { kind: 'attachment-large'; path: string; sizeBytes: number; referenceCount: number }
    | { kind: 'attachment-duplicate'; paths: string[] }
    | { kind: 'link-suggestion'; attachmentPath: string; notePath: string; evidence: string[] };

export type ProposalKind = Proposal['kind'];

export const PROPOSAL_KINDS: readonly ProposalKind[] = [
    'agent-index-stale', 'agent-index-refreshed', 'inventory-differs', 'attachment-unreferenced',
    'attachment-large', 'attachment-duplicate', 'link-suggestion',
];

/** Cancellation and the deadline, threaded into every task and from there into the operations it starts. */
export interface RunContext {
    signal: AbortSignal;
    /** Absolute time (ms) after which no new work starts */
    deadline: number;
    now(): number;
}

export const isStopped = (ctx: RunContext): boolean => ctx.signal.aborted || ctx.now() >= ctx.deadline;

export interface TaskResult {
    proposals: Proposal[];
    /** Exact totals per kind, before any cap */
    totals: Partial<Record<ProposalKind, number>>;
    /** How many proposals were dropped by the cap */
    omitted: number;
}

export type TaskStatus = 'ok' | 'skipped' | 'failed' | 'cancelled';

export interface TaskOutcome {
    task: TaskName;
    status: TaskStatus;
    /** A guidance code for a skipped or failed task */
    reason?: string;
    counts: Partial<Record<ProposalKind, number>>;
    omitted: number;
}

export interface RunSummary {
    startedAt: string;
    durationMs: number;
    trigger: 'manual' | 'scheduled' | 'preview';
    outcomes: TaskOutcome[];
    totals: Partial<Record<ProposalKind, number>>;
    status: 'ok' | 'partial' | 'failed';
}

// ─── Bounded collection ─────────────────────────────────────────────────────

export const MAX_ITEMS_PER_TASK = 100;
export const MAX_DETAIL_CHARS = 200;
export const MAX_PERSISTED_ITEMS = 200;

const keyOf = (p: Proposal): string => {
    switch (p.kind) {
        case 'attachment-duplicate': return p.paths.join('\u0000');
        case 'inventory-differs': return p.pairId;
        case 'link-suggestion': return `${p.attachmentPath}\u0000${p.notePath}`;
        case 'agent-index-refreshed': return p.path;
        case 'agent-index-stale': return '';
        default: return p.path;
    }
};

/** Cut free text to the detail limit. */
export const clip = (s: string): string => (s.length > MAX_DETAIL_CHARS ? `${s.slice(0, MAX_DETAIL_CHARS - 1)}…` : s);

/**
 * Keep at most `max` proposals in a deterministic order (kind, then key) with exact totals per kind
 * and the number omitted, so truncation never makes a count wrong.
 */
export function collect(proposals: readonly Proposal[], max = MAX_ITEMS_PER_TASK): TaskResult {
    const totals: Partial<Record<ProposalKind, number>> = {};
    for (const p of proposals) totals[p.kind] = (totals[p.kind] ?? 0) + 1;
    const sorted = [...proposals].sort((a, b) => (a.kind === b.kind ? (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0) : a.kind < b.kind ? -1 : 1));
    const kept = sorted.slice(0, max);
    return { proposals: kept, totals, omitted: sorted.length - kept.length };
}

// ─── What the tasks need from the world ─────────────────────────────────────

export interface IndexCheck {
    added: number;
    removed: number;
    changed: number;
    unreadable: number;
    unstable: boolean;
    scopeChanged: boolean;
    missing: boolean;
    fresh: boolean;
}

export interface InventoryCheck {
    pairId: string;
    hubPath: string;
    changed: boolean;
    /** Set when the listing for this pair failed; a failed pair is never reported as unchanged */
    failed?: string;
}

export interface AttachmentFinding {
    path: string;
    sizeBytes: number;
    referenceCount: number;
    /** Eligible for the existing trash flow by the scan alone (the flow revalidates) */
    unreferenced: boolean;
}

export interface UpkeepEnv {
    checkIndex(ctx: RunContext): Promise<Result<IndexCheck>>;
    refreshIndex(ctx: RunContext): Promise<Result<{ path: string }>>;
    checkInventories(ctx: RunContext): Promise<Result<InventoryCheck[]>>;
    scanAttachments(ctx: RunContext): Promise<Result<{ attachments: AttachmentFinding[]; notes: string[]; duplicates: string[][] }>>;
}

export interface TaskConfig {
    autoRefreshIndex: boolean;
    includeDuplicates: boolean;
    largeBytes: number;
}

// ─── Tasks ──────────────────────────────────────────────────────────────────

export async function runAgentIndexTask(env: UpkeepEnv, config: TaskConfig, allowPublish: boolean, ctx: RunContext): Promise<Result<TaskResult>> {
    const check = await env.checkIndex(ctx);
    if (!check.ok) return err(check.error);
    const c = check.value;
    const stale = !c.fresh;
    if (!stale) return ok(collect([]));
    // The index is a plugin-owned generated artefact: refreshing it is the one opted-in automatic write.
    if (config.autoRefreshIndex && allowPublish && !isStopped(ctx)) {
        const built = await env.refreshIndex(ctx);
        if (!built.ok) return err(built.error);
        return ok(collect([{ kind: 'agent-index-refreshed', path: built.value.path }]));
    }
    return ok(collect([{ kind: 'agent-index-stale', added: c.added, removed: c.removed, changed: c.changed, unreadable: c.unreadable, unstable: c.unstable }]));
}

export async function runInventoriesTask(env: UpkeepEnv, ctx: RunContext): Promise<Result<TaskResult>> {
    const res = await env.checkInventories(ctx);
    if (!res.ok) return err(res.error);
    // One failed pair makes the whole task failed: it cannot vouch for what it could not read.
    const failed = res.value.find((p) => p.failed);
    if (failed) return err(failed.failed ?? 'script-network');
    return ok(collect(res.value.filter((p) => p.changed).map((p): Proposal => ({ kind: 'inventory-differs', pairId: p.pairId, hubPath: p.hubPath }))));
}

export async function runAttachmentsTask(env: UpkeepEnv, config: TaskConfig, ctx: RunContext): Promise<Result<TaskResult>> {
    const scan = await env.scanAttachments(ctx);
    if (!scan.ok) return err(scan.error);
    const proposals: Proposal[] = [];
    for (const a of scan.value.attachments) {
        if (a.unreferenced) proposals.push({ kind: 'attachment-unreferenced', path: a.path, sizeBytes: a.sizeBytes });
        if (a.sizeBytes >= config.largeBytes) proposals.push({ kind: 'attachment-large', path: a.path, sizeBytes: a.sizeBytes, referenceCount: a.referenceCount });
    }
    if (config.includeDuplicates) for (const group of scan.value.duplicates) proposals.push({ kind: 'attachment-duplicate', paths: [...group].sort() });
    const orphans = scan.value.attachments.filter((a) => a.unreferenced).map((a) => a.path);
    const suggestions = await suggestLinks(orphans, scan.value.notes, ctx);
    // A pass that was cut short is a cancelled task, never a finished one with fewer suggestions.
    if (isStopped(ctx)) return err('cancelled');
    proposals.push(...suggestions.items);
    const result = collect(proposals);
    // The suggestions are capped before collection; the totals still count every match.
    if (suggestions.total > 0) {
        result.totals['link-suggestion'] = suggestions.total;
        result.omitted += suggestions.total - suggestions.items.length;
    }
    return ok(result);
}

// ─── The basic title-word matcher (no model, no embedding, no egress) ───────

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'copy', 'final', 'draft', 'new', 'old', 'scan', 'img', 'image', 'file', 'pdf', 'note', 'notes']);
export const MAX_SUGGESTIONS = 50;
const CHUNK = 200;

/** Lower-case word tokens of a name: split on non-letters and digits, drop tiny tokens and stop words. */
export function tokensOf(name: string): string[] {
    const base = name.replace(/\.[A-Za-z0-9]{1,5}$/, '');
    return [...new Set(base.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 2 && !STOP_WORDS.has(t)))];
}

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, 0));

/**
 * One suggestion per unreferenced attachment: the note that shares at least two title tokens (or the
 * attachment's only token, if it has one of five characters or more). Titles are tokenised once into
 * an inverted index and the work runs in chunks that yield and check the run context, so a large
 * vault neither blocks the interface nor outlives the cap. The shared tokens are the evidence.
 */
export async function suggestLinks(attachmentPaths: readonly string[], notePaths: readonly string[], ctx: RunContext): Promise<{ items: Proposal[]; total: number }> {
    if (isStopped(ctx)) return { items: [], total: 0 };
    const index = new Map<string, number[]>();
    for (let i = 0; i < notePaths.length; i++) {
        const tokens = tokensOf(baseName(notePaths[i]));
        for (const t of tokens) {
            const list = index.get(t);
            if (list) list.push(i);
            else index.set(t, [i]);
        }
        if (i % CHUNK === CHUNK - 1) { await yieldToEventLoop(); if (isStopped(ctx)) return { items: [], total: 0 }; }
    }
    const out: Array<Extract<Proposal, { kind: 'link-suggestion' }> & { score: number }> = [];
    for (let a = 0; a < attachmentPaths.length; a++) {
        // Checked on every path, including the ones that skip an attachment.
        if (a % CHUNK === CHUNK - 1) { await yieldToEventLoop(); if (isStopped(ctx)) break; }
        const tokens = tokensOf(baseName(attachmentPaths[a]));
        if (tokens.length === 0) continue;
        const shared = new Map<number, string[]>();
        let steps = 0;
        for (const t of tokens) for (const n of index.get(t) ?? []) {
            const list = shared.get(n);
            if (list) list.push(t);
            else shared.set(n, [t]);
            // A very common word has a long posting list: yield inside it as well, not only between attachments.
            if (++steps % (CHUNK * 10) === 0) { await yieldToEventLoop(); if (isStopped(ctx)) return { items: [], total: 0 }; }
        }
        let best: { note: number; evidence: string[] } | null = null;
        for (const [n, evidence] of shared) {
            const enough = evidence.length >= 2 || (tokens.length === 1 && evidence[0].length >= 5);
            if (!enough) continue;
            if (!best || evidence.length > best.evidence.length || (evidence.length === best.evidence.length && notePaths[n] < notePaths[best.note])) best = { note: n, evidence };
        }
        if (best) out.push({ kind: 'link-suggestion', attachmentPath: attachmentPaths[a], notePath: notePaths[best.note], evidence: [...best.evidence].sort(), score: best.evidence.length });
    }
    const items = out
        .sort((x, y) => y.score - x.score || (x.attachmentPath < y.attachmentPath ? -1 : 1))
        .slice(0, MAX_SUGGESTIONS)
        .map(({ score: _score, ...proposal }) => proposal);
    return { items, total: out.length };
}
