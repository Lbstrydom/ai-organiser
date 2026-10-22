/**
 * The offload journal: one record per operation, persisted so an interrupted offload can resume.
 *
 * Steps (a step's intent is recorded before its side effect and its outcome after; every step is
 * idempotent and recovery is decided from observable postconditions, never from the journal alone):
 *
 *   planned -> copied -> remote-captured -> rewrite-approved -> rewriting -> verified
 *           -> trash-pending -> trashed -> done            (or aborted / failed)
 *
 * The file is signed and written with temp-and-rename, like the agent index: a file at the journal
 * path that is not ours is never read as ours and never touched.
 */
import type { DataAdapter } from 'obsidian';
import { Result, ok, err } from '../../core/result';
import { sha256Hex } from '../attachmentDuplicateService';
import type { ReferrerStatus } from './commitBarrier';
import type { CopyPlan, RemoteIdentity, RewritePlan } from './offloadPlan';

export const JOURNAL_GENERATOR = 'ai-organiser/offload-journal';

export const STEPS = ['planned', 'copied', 'remote-captured', 'rewrite-approved', 'rewriting', 'verified', 'trash-pending', 'trashed', 'done'] as const;
export type ForwardStep = (typeof STEPS)[number];
export type OffloadStep = ForwardStep | 'aborted' | 'failed';

export interface OffloadRecord {
    opId: string;
    step: OffloadStep;
    updatedAt: string;
    copy: CopyPlan;
    /** Where the copy was placed in the Drive for desktop folder (absolute) and under what name */
    placed?: { destPath: string; destName: string; sha256: string; size: number; reused: boolean };
    remote?: RemoteIdentity;
    rewrite?: RewritePlan;
    /** Status of each approved referrer */
    referrers: Record<string, ReferrerStatus>;
    /** Why the operation is waiting or stopped, as a stable code */
    blocked?: string;
}

export function isTerminal(step: OffloadStep): boolean {
    return step === 'done' || step === 'aborted' || step === 'failed';
}

/** The step after `step`, or null at the end. */
export function nextStep(step: OffloadStep): ForwardStep | null {
    const i = STEPS.indexOf(step as ForwardStep);
    return i === -1 || i === STEPS.length - 1 ? null : STEPS[i + 1];
}

/** Moves allowed by the step machine: one step forward, `failed` from anywhere live, `aborted` only before any rewrite. */
export function canTransition(from: OffloadStep, to: OffloadStep): boolean {
    if (isTerminal(from)) return false;
    if (to === 'failed') return true;
    if (to === 'aborted') return from === 'planned' || from === 'copied' || from === 'remote-captured' || from === 'rewrite-approved';
    if (to === from) return true;
    return nextStep(from) === to;
}

/** A new record at `planned`. */
export function newRecord(copy: CopyPlan, now: string): OffloadRecord {
    const referrers: Record<string, ReferrerStatus> = {};
    for (const r of copy.referrers) referrers[r.path] = 'pending';
    return { opId: copy.opId, step: 'planned', updatedAt: now, copy, referrers };
}

/** Move a record to `to`, or return the stable error `invalid-transition`. */
export function transition(record: OffloadRecord, to: OffloadStep, now: string, patch: Partial<OffloadRecord> = {}): Result<OffloadRecord> {
    if (!canTransition(record.step, to)) return err('invalid-transition');
    return ok({ ...record, ...patch, step: to, updatedAt: now, blocked: patch.blocked });
}

// ─── Persistence ────────────────────────────────────────────────────────────

interface JournalFile {
    generator: string;
    path: string;
    version: 1;
    signature: string;
    records: OffloadRecord[];
}

async function sign(path: string, records: readonly OffloadRecord[]): Promise<string> {
    return sha256Hex(new TextEncoder().encode(`${JOURNAL_GENERATOR}\u0000${path}\u0000${JSON.stringify(records)}`).buffer);
}

async function parseSigned(path: string, text: string): Promise<OffloadRecord[] | null> {
    try {
        const file = JSON.parse(text) as Partial<JournalFile>;
        if (file.generator !== JOURNAL_GENERATOR || file.path !== path || !Array.isArray(file.records) || typeof file.signature !== 'string') return null;
        return (await sign(path, file.records)) === file.signature ? file.records : null;
    } catch {
        return null;
    }
}

/** Reads and writes the journal at a fixed path through the vault adapter. */
export class JournalStore {
    /** Read-modify-write cycles run one at a time, so two operations can never overwrite each other's update. */
    private chain: Promise<unknown> = Promise.resolve();

    constructor(private readonly adapter: DataAdapter, private readonly path: string) {}

    private serialised<T>(job: () => Promise<T>): Promise<T> {
        const run = this.chain.then(job, job);
        this.chain = run.catch(() => undefined);
        return run;
    }

    private get prev(): string { return `${this.path}.aio-prev`; }

    private tmp(id: string): string { return `${this.path}.aio-${id}.tmp`; }

    /** Every record. A missing journal is empty; a file that is not ours is `journal-not-ours`. */
    async load(): Promise<Result<OffloadRecord[]>> {
        try {
            if (await this.adapter.exists(this.path)) {
                const records = await parseSigned(this.path, await this.adapter.read(this.path));
                if (records) return ok(records);
                // An unreadable or look-alike journal: an interrupted write may have left a signed copy.
                if (await this.adapter.exists(this.prev)) {
                    const old = await parseSigned(this.path, await this.adapter.read(this.prev));
                    if (old) return ok(old);
                }
                return err('journal-not-ours');
            }
            if (await this.adapter.exists(this.prev)) {
                const old = await parseSigned(this.path, await this.adapter.read(this.prev));
                if (old) {
                    await this.adapter.rename(this.prev, this.path); // died between the two renames
                    return ok(old);
                }
                return err('journal-not-ours');
            }
            return ok([]);
        } catch {
            return err('write-failed');
        }
    }

    /** Replace the journal with `records` (temp file, then rename). */
    async save(records: readonly OffloadRecord[]): Promise<Result<void>> {
        try {
            if (await this.adapter.exists(this.path)) {
                // Never replace something that is not our journal.
                if (!(await parseSigned(this.path, await this.adapter.read(this.path)))) return err('journal-not-ours');
            }
            // The previous-version slot is ours only if it carries our signature; a stray file there is left alone.
            if (await this.adapter.exists(this.prev)) {
                if (!(await parseSigned(this.path, await this.adapter.read(this.prev)))) return err('journal-not-ours');
                await this.adapter.remove(this.prev);
            }
            const body: JournalFile = { generator: JOURNAL_GENERATOR, path: this.path, version: 1, signature: await sign(this.path, records), records: [...records] };
            const tmp = this.tmp(Date.now().toString(36));
            await this.adapter.write(tmp, JSON.stringify(body));
            const had = await this.adapter.exists(this.path);
            try {
                if (had) await this.adapter.rename(this.path, this.prev);
                await this.adapter.rename(tmp, this.path);
            } catch {
                if (had && !(await this.adapter.exists(this.path)) && (await this.adapter.exists(this.prev))) await this.adapter.rename(this.prev, this.path);
                if (await this.adapter.exists(tmp)) await this.adapter.remove(tmp);
                return err('write-failed');
            }
            if (had) await this.adapter.remove(this.prev).catch(() => undefined);
            return ok(undefined);
        } catch {
            return err('write-failed');
        }
    }

    /** Insert or replace one record. */
    put(record: OffloadRecord): Promise<Result<void>> {
        return this.serialised(async () => {
            const all = await this.load();
            if (!all.ok) return err(all.error);
            const next = all.value.filter((r) => r.opId !== record.opId);
            next.push(record);
            return this.save(next);
        });
    }

    /** Records that are neither finished nor abandoned. */
    async unfinished(): Promise<Result<OffloadRecord[]>> {
        const all = await this.load();
        return all.ok ? ok(all.value.filter((r) => !isTerminal(r.step))) : err(all.error);
    }
}
