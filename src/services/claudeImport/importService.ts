/**
 * One import run: look at the source folder, copy each new, settled, admitted text file into the vault folder, and say what
 * happened. Everything it touches comes in through `ImportEnv`, so a run can be tested without Obsidian or a disk.
 *
 * Order per file (see docs/features/claude-import.md): observe → settle → size → bounded read → dedup by sha256 → admit →
 * choose a free name → save a write-ahead `pending` record → create the copy (exact bytes) → read it back → record it.
 * The originals are only ever read. A published copy is never deleted, moved or rewritten by the importer.
 *
 * `runImport` never rejects: a failure before any file is handled is `Result.err(code)`; a failure part-way stops the run and
 * is reported as `stoppedBy` alongside what was already done.
 */
import { Result, ok, err } from '../../core/result';
import { checkMountFolder } from '../offload/localMount';
import type { NodeDeps } from '../offload/fingerprint';
import { logger } from '../../utils/logger';
import { checkDestination } from './importGate';
import { emptyLedger, type ImportLedger, type RefusalReason, type RefusedEntry, type SeenEntry } from './importLedger';
import { admit, MAX_READS_PER_RUN, needsRead, observe, readOrder, stability, targetNames } from './importPolicy';
import { listSource, readBounded, type ListedFile } from './sourceFolder';
import type { ImportVaultPort } from './importWriter';
import type { LedgerPort } from './ledgerStore';
import type { HandoffRoute } from './handoffRoute';

export type Trigger = 'manual' | 'background';

/** The settings a run uses, read once when it starts. */
export interface ImportSnapshot {
    sourceFolder: string;
    destination: string;
    maxKB: number;
    stabilitySeconds: number;
}

export interface ImportEnv {
    deps: NodeDeps;
    /** The vault's folder on disk, or null when it cannot be known (then the source cannot be checked against it) */
    vaultBase: string | null;
    /** The vault side: the only writes of a run go through this port */
    notes: ImportVaultPort;
    ledger: LedgerPort;
    settings: ImportSnapshot;
    isProtected: (path: string) => boolean;
    /** The vault's configuration folder (never a destination) */
    configDir?: string;
    /** Classify an admitted text for the hand-back review */
    route: (text: string) => HandoffRoute;
    now: () => number;
    /** False once the run must stop (feature turned off, settings changed, plugin unloading) */
    alive: () => boolean;
    readDeadlineMs?: number;
    maxReads?: number;
}

export interface ImportedItem {
    name: string;
    path: string;
    verified: boolean;
    route: HandoffRoute;
}

export interface RefusedItem {
    name: string;
    reason: RefusalReason;
}

export interface AmbiguousItem {
    hash: string;
    name: string;
    path: string;
}

export interface ImportReport {
    trigger: Trigger;
    finishedAt: number;
    imported: ImportedItem[];
    /** Every listed file that is refused now */
    outstanding: RefusedItem[];
    /** Refused for the first time, or again after it changed */
    newRefusals: RefusedItem[];
    /** Copies whose ownership the plugin cannot prove: the person decides */
    ambiguous: AmbiguousItem[];
    /** Files not ready yet, or left for a later run */
    waiting: number;
    /** The earliest time a settling file is due (ms), or null */
    nextReadyAt: number | null;
    alreadyImported: number;
    /** Files that are not .md or .txt */
    other: number;
    cancelled: boolean;
    /** A failure that stopped the run part-way (a guidance code), or undefined */
    stoppedBy?: string;
}

const MOUNT_CODES: Record<string, string> = {
    'mount-invalid': 'claude-import-source-invalid',
    'mount-missing': 'claude-import-source-missing',
    'mount-inside-vault': 'claude-import-source-inside-vault',
    'mount-vault-unverified': 'claude-import-source-invalid',
};

const clone = (l: ImportLedger): ImportLedger => JSON.parse(JSON.stringify(l)) as ImportLedger;
const sameFile = (r: RefusedEntry, f: ListedFile, maxKB: number): boolean => r.fid === f.fid && r.size === f.size && r.mtimeMs === f.mtimeMs && r.maxKB === maxKB;
const hashOf = (deps: NodeDeps, bytes: Uint8Array): string => deps.crypto.createHash('sha256').update(bytes).digest('hex');

export async function runImport(env: ImportEnv, trigger: Trigger): Promise<Result<ImportReport>> {
    try {
        return await runUnsafe(env, trigger);
    } catch (e) {
        logger.error('ClaudeImport', 'The import run failed', e);
        return err('claude-import-failed');
    }
}

/** Settle pending records left by an interrupted run. Returns whether anything changed. */
async function recoverPending(env: ImportEnv, ledger: ImportLedger): Promise<boolean> {
    let changed = false;
    for (const [hash, p] of Object.entries(ledger.pending)) {
        if (p.ambiguous) continue;
        const bytes = await env.notes.fileBytes(p.path);
        if (bytes === 'none') {
            delete ledger.pending[hash];
        } else if (bytes !== 'other' && hashOf(env.deps, bytes) === hash) {
            ledger.imported[hash] = { name: p.name, path: p.path, at: p.at, verified: true };
            delete ledger.pending[hash];
        } else {
            ledger.pending[hash] = { ...p, ambiguous: true };
        }
        changed = true;
    }
    return changed;
}

async function runUnsafe(env: ImportEnv, trigger: Trigger): Promise<Result<ImportReport>> {
    const { deps, settings } = env;
    const manual = trigger === 'manual';
    const cap = Math.max(1, Math.round(settings.maxKB)) * 1024;
    const windowMs = Math.max(0, settings.stabilitySeconds) * 1000;

    const dest = checkDestination(settings.destination, env.isProtected, env.configDir);
    if (!dest.ok) return err(dest.error);
    if (settings.sourceFolder.trim() === '') return err('claude-import-no-source');
    if (env.vaultBase === null) return err('claude-import-source-invalid');
    const root = await checkMountFolder(deps, settings.sourceFolder, env.vaultBase);
    if (!root.ok) return err(MOUNT_CODES[root.error] ?? 'claude-import-source-invalid');

    const ledger = clone(env.ledger.get());
    if (await recoverPending(env, ledger)) {
        const saved = await env.ledger.save(clone(ledger));
        if (!saved.ok) return err(saved.error);
    }

    const listing = await listSource(deps, root.value);
    if (!listing.ok) return err(listing.error);

    const now = env.now();
    const report: ImportReport = {
        trigger, finishedAt: now, imported: [], outstanding: [], newRefusals: [], ambiguous: [], waiting: 0, nextReadyAt: null,
        alreadyImported: 0, other: listing.value.other, cancelled: false,
    };
    const seen: Record<string, SeenEntry> = {};
    const refused: Record<string, RefusedEntry> = {};
    const refuse = (file: ListedFile, reason: RefusalReason): void => {
        const prev = ledger.refused[file.name];
        const rec: RefusedEntry = { fid: file.fid, size: file.size, mtimeMs: file.mtimeMs, reason, maxKB: settings.maxKB };
        refused[file.name] = rec;
        report.outstanding.push({ name: file.name, reason });
        if (!prev || !sameFile(prev, file, settings.maxKB) || prev.reason !== reason) report.newRefusals.push({ name: file.name, reason });
    };
    const wait = (readyAt?: number): void => {
        report.waiting++;
        if (readyAt !== undefined && (report.nextReadyAt === null || readyAt < report.nextReadyAt)) report.nextReadyAt = readyAt;
    };

    for (const file of listing.value.unsafe) {
        seen[file.name] = observe(ledger.seen[file.name], file, now);
        refuse(file, 'unsupported-name');
    }

    // Decide, without reading, what each listed file needs this run.
    const toRead: Array<{ name: string; entry: SeenEntry; file: ListedFile }> = [];
    for (const file of listing.value.candidates) {
        const entry = observe(ledger.seen[file.name], file, now);
        seen[file.name] = entry;
        const prevRefusal = ledger.refused[file.name];
        if (file.size > cap) { refuse(file, 'too-large'); continue; }
        const settle = stability(entry, now, windowMs, manual);
        if (!settle.ready) { wait(settle.readyAt); continue; }
        const due = needsRead(entry, now, manual);
        if (!due && entry.hash !== undefined && ledger.imported[entry.hash]) { report.alreadyImported++; continue; }
        if (!due && prevRefusal && sameFile(prevRefusal, file, settings.maxKB)) { refuse(file, prevRefusal.reason); continue; }
        toRead.push({ name: file.name, entry, file });
    }

    const picks = readOrder(toRead, env.maxReads ?? MAX_READS_PER_RUN);
    for (const left of toRead.length - picks.length > 0 ? toRead.filter((t) => !picks.includes(t)) : []) {
        // Not read this run: a refusal it had still stands, otherwise it waits its turn.
        const prev = ledger.refused[left.name];
        if (prev && sameFile(prev, left.file, settings.maxKB)) refuse(left.file, prev.reason);
        else wait();
    }

    let folderReady = false;
    let stalled = false;
    for (const pick of picks) {
        if (!env.alive()) { report.cancelled = true; break; }
        // A read that did not answer may still be running: start no other this run, so stalled reads cannot pile up.
        if (stalled) { wait(); continue; }
        const { entry, file } = pick;
        entry.attemptedAt = env.now();
        const read = await readBounded(deps, root.value, file, cap, env.readDeadlineMs);
        if (read.kind === 'too-large') { refuse(file, 'too-large'); continue; }
        if (read.kind === 'timeout') stalled = true;
        if (read.kind !== 'read') { wait(); continue; }
        entry.hash = read.sha256;
        entry.hashedAt = env.now();
        const sha = read.sha256;
        if (ledger.imported[sha]) { report.alreadyImported++; continue; }
        if (ledger.pending[sha]) continue; // ambiguous: listed below, the person decides
        const admission = admit(read.bytes);
        if (!admission.ok) { refuse(file, admission.reason); continue; }

        if (!folderReady) {
            if (!env.alive()) { report.cancelled = true; break; }
            const made = await env.notes.ensureFolder(dest.value);
            if (!made.ok) { report.stoppedBy = made.error; break; }
            folderReady = true;
        }

        // A free name, or a copy of exactly these bytes already there (an import whose record was not saved).
        let target: string | null = null;
        let existing: string | null = null;
        for (const name of targetNames(file.name, sha)) {
            const path = `${dest.value}/${name}`;
            const there = await env.notes.fileBytes(path);
            if (there === 'none') { target = path; break; }
            if (there !== 'other' && hashOf(deps, there) === sha) { existing = path; break; }
        }
        const at = new Date(env.now()).toISOString();
        if (existing !== null) {
            if (!env.alive()) { report.cancelled = true; break; }
            ledger.imported[sha] = { name: file.name, path: existing, at, verified: true };
            const saved = await env.ledger.save(clone(ledger));
            if (!saved.ok) { report.stoppedBy = saved.error; break; }
            report.imported.push({ name: file.name, path: existing, verified: true, route: env.route(admission.text) });
            continue;
        }
        if (target === null) { refuse(file, 'name-taken'); continue; }

        // Write-ahead: the intent is on disk before the copy exists, or the copy is not made.
        if (!env.alive()) { report.cancelled = true; break; }
        ledger.pending[sha] = { name: file.name, path: target, at };
        const intent = await env.ledger.save(clone(ledger));
        if (!intent.ok) { delete ledger.pending[sha]; report.stoppedBy = intent.error; break; }
        if (!env.alive()) {
            delete ledger.pending[sha];
            await env.ledger.save(clone(ledger));
            report.cancelled = true;
            break;
        }
        const created = await env.notes.createBinary(target, read.bytes);
        if (!created.ok) {
            delete ledger.pending[sha];
            const dropped = await env.ledger.save(clone(ledger));
            if (created.error === 'claude-import-destination-protected') { report.stoppedBy = created.error; break; }
            if (!dropped.ok) { report.stoppedBy = dropped.error; break; }
            wait(); // the name was taken in between, or the create failed: the next run chooses again
            continue;
        }
        const back = await env.notes.fileBytes(target);
        const verified = back !== 'none' && back !== 'other' && hashOf(deps, back) === sha;
        delete ledger.pending[sha];
        ledger.imported[sha] = { name: file.name, path: target, at, verified };
        const recorded = await env.ledger.save(clone(ledger));
        report.imported.push({ name: file.name, path: target, verified, route: env.route(admission.text) });
        if (!recorded.ok) { report.stoppedBy = recorded.error; break; }
    }

    // Observations and refusals follow the complete listing of this run: names no longer there are dropped.
    if (!report.stoppedBy && !report.cancelled) {
        ledger.seen = seen;
        ledger.refused = refused;
    } else {
        // A stopped run keeps what it learned about the files it saw and forgets nothing it did not see.
        ledger.seen = { ...ledger.seen, ...seen };
        ledger.refused = { ...ledger.refused, ...refused };
    }
    for (const [hash, p] of Object.entries(ledger.pending)) if (p.ambiguous) report.ambiguous.push({ hash, name: p.name, path: p.path });
    report.finishedAt = env.now();
    if (env.alive()) {
        const final = await env.ledger.save(clone(ledger));
        if (!final.ok) logger.warn('ClaudeImport', 'Observations of this run were not saved; the next run looks again');
    }
    return ok(report);
}

/** The person's answer for an ambiguous copy: it is the import, or import a fresh copy on the next run. */
export async function resolveAmbiguous(ledger: LedgerPort, hash: string, choice: 'is-import' | 'fresh-copy', nowIso: string): Promise<Result<void>> {
    try {
        const next = clone(ledger.get() ?? emptyLedger());
        const p = next.pending[hash];
        if (!p || !p.ambiguous) return ok(undefined);
        delete next.pending[hash];
        if (choice === 'is-import') next.imported[hash] = { name: p.name, path: p.path, at: nowIso, verified: false };
        return await ledger.save(next);
    } catch (e) {
        logger.error('ClaudeImport', 'Could not record the choice', e);
        return err('claude-import-ledger-unsaved');
    }
}
