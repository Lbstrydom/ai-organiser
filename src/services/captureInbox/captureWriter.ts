/**
 * The only code that writes anything on behalf of the capture feature. Three actions, each its own
 * explicit consequence:
 *
 *   1. `acceptCapture`        - on Accept: the plugin block + two frontmatter keys in the capture note
 *                               (one `applyNoteEdit` composite, `review:false` because the review modal
 *                               IS the gate), or, for a bare media capture, the companion note.
 *   2. `createOrganisedNote`  - a NEW note in an allowed folder with a back-link. The original is never
 *                               moved, renamed or edited by this action.
 *   3. `skipCapture`          - no write at all; the journal remembers the decision.
 *
 * The original is touched at most once, by insertion only, and only after the user accepted.
 */
import { TFile } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { Result, ok, err } from '../../core/result';
import { assertWritable } from '../../core/protectedPaths';
import { logger } from '../../utils/logger';
import { applyNoteEdit } from '../noteEdit/applyNoteEdit';
import { exclusionReason, type SweepPolicy } from '../inboxSweep/sweepGuard';
import { addAlias, bump, bumpBucket, finish, getEntry, pruneFinished, rekey, upsertEntry } from './captureJournal';
import {
    applyAccept,
    computeFingerprint,
    findCaptureBlock,
    normaliseForFingerprint,
    stripCaptureInsertions,
    type BlockContent,
} from './enrichmentBlock';
import { checkDestination, machineTextExclusion } from './capturePolicy';
import { sanitiseTitle, uniquePath } from './titleSanitiser';
import { readCaptureId } from './frontmatterKey';
import type { CaptureConfig, CaptureEntry, CaptureJournal, CaptureProposal, InsertedSpans } from './captureTypes';

export const ORGANISED_FROM_KEY = 'capture-from';

/** The vault operations the writer needs. The production port wraps Obsidian; tests fake it. */
export interface WriterPort {
    readNote(path: string): Promise<string | null>;
    /** Compare-and-commit edit of an existing note (the note-edit seam). */
    editNote(path: string, baseline: string, recompute: (current: string) => Result<{ content: string }>): Promise<Result<void>>;
    /** Create a new note; refuses to overwrite and refuses a protected folder. Returns the created path. */
    createNote(path: string, content: string): Promise<Result<string>>;
    pathExists(path: string): boolean;
    folderExists(path: string): boolean;
    /** The size of a file now, or null when it is gone. */
    fileSize(path: string): Promise<number | null>;
    /** A note whose frontmatter `key` equals `value` (crash recovery), or null. */
    findNoteByFrontmatter(key: string, value: string): string | null;
}

export interface JournalAccess {
    get(): CaptureJournal;
    /** `durable`: reject when the journal could not be saved (used for write-ahead markers a recovery depends on). */
    mutate(fn: (journal: CaptureJournal) => CaptureJournal, opts?: { durable?: boolean }): Promise<CaptureJournal>;
}

export interface WriterDeps {
    port: WriterPort;
    journal: JournalAccess;
    config(): CaptureConfig;
    /** The BASE sweep policy */
    policy(): SweepPolicy;
    isSwept(path: string, text: string): Promise<boolean>;
    protectedFolders(): readonly string[];
    outputRoots(): readonly string[];
    now(): number;
}

export interface AcceptEdits {
    machineText?: string;
    proposal?: CaptureProposal;
}

/** The id written into the note: stable across renames (the journal id is a path). */
const uidOf = (entry: CaptureEntry): string => entry.uid ?? entry.id;

/** One action at a time per capture: a double click or an overlapping recovery must not race the write. */
const inFlight = new Set<string>();

async function exclusive<T>(id: string, busy: T, work: () => Promise<T>): Promise<T> {
    if (inFlight.has(id)) return busy;
    inFlight.add(id);
    try {
        return await work();
    } finally {
        inFlight.delete(id);
    }
}

const comparable = (text: string): string => normaliseForFingerprint(stripCaptureInsertions(text, { frontmatterCreated: false }));

function companionName(mediaPath: string): { dir: string; base: string } {
    const slash = mediaPath.lastIndexOf('/');
    const name = mediaPath.slice(slash + 1);
    const dot = name.lastIndexOf('.');
    return { dir: slash === -1 ? '' : mediaPath.slice(0, slash), base: dot > 0 ? name.slice(0, dot) : name };
}

/** Put an entry back where the user can see it, with the reason it did not write. */
async function backToReview(deps: WriterDeps, id: string, code: string): Promise<Result<void>> {
    await deps.journal.mutate((j) => {
        const e = getEntry(j, id);
        // Only a write that was still pending goes back; an entry that moved on keeps its state.
        return e && e.state === 'accept_pending_write' ? upsertEntry(j, { ...e, state: 'awaiting_review', updatedAt: deps.now() }) : j;
    });
    return err(code);
}

/**
 * Accept: the one write to the user's note. Order of checks (any failure writes nothing):
 * the entry must await review; the note's fingerprint must equal the journal's; the inbox sweep must
 * not have read it meanwhile; the guard must still allow it; then the atomic edit re-checks that the
 * text is unchanged inside the commit.
 */
export async function acceptCapture(deps: WriterDeps, id: string, edits: AcceptEdits = {}, opts: { recovering?: boolean } = {}): Promise<Result<void>> {
    return exclusive(id, err<void>('capture-busy'), () => acceptLocked(deps, id, edits, opts));
}

async function acceptLocked(deps: WriterDeps, id: string, edits: AcceptEdits, opts: { recovering?: boolean }): Promise<Result<void>> {
    const entry = getEntry(deps.journal.get(), id);
    if (!entry) return err('capture-changed');
    // `accept_pending_write` is only ever resumed by startup recovery, never by a second click.
    if (entry.state !== 'awaiting_review' && !(opts.recovering && entry.state === 'accept_pending_write')) return err('capture-changed');
    const machineText = (edits.machineText ?? entry.text ?? '').slice(0, 60_000);
    const proposal = edits.proposal ?? entry.proposal ?? { title: '', tags: [], folder: null };
    const content: BlockContent = { machineText, proposal, source: entry.source ?? 'note-text' };
    const edited = !!entry.edited || machineText !== (entry.text ?? '') || JSON.stringify(proposal) !== JSON.stringify(entry.proposal ?? null);

    // Write-ahead: from here a crash can be recovered from `accept_pending_write` alone.
    try {
        await deps.journal.mutate((j) => upsertEntry(j, { ...entry, uid: uidOf(entry), state: 'accept_pending_write', text: machineText, proposal, edited, updatedAt: deps.now() }), { durable: true });
    } catch (e) {
        // The intent could not be saved: writing now would leave nothing to recover from.
        logger.error('CaptureInbox', 'Could not save the write-ahead marker', e);
        await deps.journal.mutate((j) => upsertEntry(j, { ...entry, updatedAt: deps.now() }));
        return err('capture-write-failed');
    }

    const policy = deps.policy();
    return entry.hasNote === false
        ? acceptBareMedia(deps, entry, content, policy, edited)
        : acceptNote(deps, entry, content, policy, edited);
}

async function currentAttachments(deps: WriterDeps, entry: CaptureEntry): Promise<{ path: string; size: number }[] | null> {
    const out: { path: string; size: number }[] = [];
    for (const a of entry.attachments ?? []) {
        const size = await deps.port.fileSize(a.path);
        if (size === null) return null;
        out.push({ path: a.path, size });
    }
    return out;
}

async function acceptNote(deps: WriterDeps, entry: CaptureEntry, content: BlockContent, policy: SweepPolicy, edited: boolean): Promise<Result<void>> {
    const id = entry.id;
    const current = await deps.port.readNote(id);
    if (current === null) return backToReview(deps, id, 'capture-changed');
    const attachments = await currentAttachments(deps, entry);
    if (!attachments || (await computeFingerprint(current, attachments, entry.inserted)) !== entry.fingerprint) {
        return backToReview(deps, id, 'capture-changed');
    }
    if (await deps.isSwept(id, current)) return backToReview(deps, id, 'capture-swept');
    const excluded = exclusionReason(id, current, policy) ?? machineTextExclusion(id, content.machineText, policy);
    if (excluded) {
        await deps.journal.mutate((j) => finish(bumpBucket(j, 'skipped', 'excluded'), id, 'skipped', deps.now()));
        return err('capture-changed');
    }
    // Predict the insertion now so a crash between the write and the journal update can still strip it.
    const uid = uidOf(entry);
    const predicted = applyAccept(current, uid, content);
    if (!predicted.ok) return backToReview(deps, id, predicted.error);
    // `null` = this capture's block is already in the note (a recovered write): nothing to insert.
    if (predicted.value.inserted) {
        const spans = predicted.value.inserted;
        await deps.journal.mutate((j) => upsertEntry(j, { ...getEntry(j, id)!, inserted: spans }));
    }

    let actual: InsertedSpans | null = predicted.value.inserted;
    const written = predicted.value.inserted === null ? ok<void>(undefined) : await deps.port.editNote(id, current, (live) => {
        if (comparable(live) !== comparable(current)) return err('capture-changed');
        const w = applyAccept(live, uid, content);
        if (!w.ok) return w;
        actual = w.value.inserted;
        return ok({ content: w.value.text });
    });
    if (!written.ok) {
        logger.warn('CaptureInbox', `Accept write refused for ${id}: ${written.error}`);
        return backToReview(deps, id, written.error === 'capture-changed' ? 'capture-changed' : written.error === 'protected-path' ? 'capture-write-failed' : written.error);
    }
    await deps.journal.mutate((j) => {
        const e = getEntry(j, id);
        const next = e ? upsertEntry(j, { ...e, state: 'accepted', inserted: actual ?? e.inserted, updatedAt: deps.now() }) : j;
        return pruneFinished(bump(next, edited ? 'acceptedEdited' : 'acceptedUnchanged'), deps.now());
    });
    return ok(undefined);
}

async function acceptBareMedia(deps: WriterDeps, entry: CaptureEntry, content: BlockContent, policy: SweepPolicy, edited: boolean): Promise<Result<void>> {
    const id = entry.id;
    const attachments = await currentAttachments(deps, entry);
    if (!attachments || (await computeFingerprint('', attachments, undefined)) !== entry.fingerprint) {
        return backToReview(deps, id, 'capture-changed');
    }
    const excluded = machineTextExclusion(id, content.machineText, policy);
    if (excluded) {
        await deps.journal.mutate((j) => finish(bumpBucket(j, 'skipped', 'excluded'), id, 'skipped', deps.now()));
        return err('capture-changed');
    }
    // Crash recovery: a companion for this capture may already exist. A file that merely sits at the
    // journalled path is adopted only when it carries THIS capture's id.
    const uid = uidOf(entry);
    let companion: string | null = null;
    if (entry.companionPath && deps.port.pathExists(entry.companionPath)) {
        const there = await deps.port.readNote(entry.companionPath);
        if (there !== null && readCaptureId(there) === uid) companion = entry.companionPath;
    }
    companion ??= deps.port.findNoteByFrontmatter('capture-id', uid);
    if (!companion) {
        const { dir, base } = companionName(id);
        const target = uniquePath(dir, `${base} (capture)`, 'md', (p) => deps.port.pathExists(p));
        await deps.journal.mutate((j) => upsertEntry(j, { ...getEntry(j, id)!, companionPath: target }));
        const body = applyAccept(`![[${id}]]\n`, uid, content);
        if (!body.ok) return backToReview(deps, id, body.error);
        const created = await deps.port.createNote(target, body.value.text);
        if (!created.ok) {
            logger.warn('CaptureInbox', `Companion create refused for ${id}: ${created.error}`);
            return backToReview(deps, id, created.error === 'protected-path' ? 'capture-write-failed' : created.error);
        }
        companion = created.value;
    }
    await finishBareAccept(deps, id, companion, edited ? 'edited' : 'unchanged');
    return ok(undefined);
}

/**
 * The journal half of a bare-media Accept: the entry becomes the companion note's entry (so the scanner
 * settles the companion instead of offering it as a new capture). Shared by the normal path and by crash
 * recovery. `count: 'none'` is for recovery, where the outcome was already counted or cannot be known.
 */
export async function finishBareAccept(deps: WriterDeps, id: string, companionPath: string, count: 'edited' | 'unchanged' | 'none'): Promise<void> {
    await deps.journal.mutate((j) => {
        const e = getEntry(j, id);
        if (!e) return j;
        let next = upsertEntry(j, { ...e, state: 'accepted', companionPath, inserted: { separatorAdded: false, frontmatterCreated: true }, updatedAt: deps.now() });
        next = rekey(next, id, companionPath);
        next = addAlias(next, id, companionPath);
        if (count !== 'none') next = bump(next, count === 'edited' ? 'acceptedEdited' : 'acceptedUnchanged');
        return pruneFinished(next, deps.now());
    });
}

export interface OrganiseEdits {
    title?: string;
    tags?: string[];
    folder?: string | null;
}

function yamlList(items: readonly string[]): string {
    return `[${items.map((t) => JSON.stringify(t)).join(', ')}]`;
}

/** The text of the organised note: what the user wrote, then the accepted machine text. */
export function organisedBody(entry: CaptureEntry): string {
    return [entry.noteText?.trim(), entry.text?.trim()].filter((p): p is string => !!p).join('\n\n');
}

/**
 * Create the organised note. Idempotent: the intent is journalled first, a crash or a double click
 * finds the note by `capture-from`, and an existing file is never overwritten.
 */
export async function createOrganisedNote(deps: WriterDeps, id: string, edits: OrganiseEdits = {}): Promise<Result<string>> {
    return exclusive(id, err<string>('capture-busy'), () => organiseLocked(deps, id, edits));
}

async function organiseLocked(deps: WriterDeps, id: string, edits: OrganiseEdits): Promise<Result<string>> {
    const entry = getEntry(deps.journal.get(), id);
    if (!entry || (entry.state !== 'accepted' && entry.state !== 'organised')) return err('capture-changed');
    if (entry.organise?.createdPath && deps.port.pathExists(entry.organise.createdPath)) return ok(entry.organise.createdPath);
    const existing = deps.port.findNoteByFrontmatter(ORGANISED_FROM_KEY, uidOf(entry));
    if (existing) {
        await deps.journal.mutate((j) => upsertEntry(j, { ...getEntry(j, entry.id)!, state: 'organised', organise: { targetPath: existing, createdPath: existing }, updatedAt: deps.now() }));
        return ok(existing);
    }

    const folder = edits.folder !== undefined ? edits.folder : entry.proposal?.folder ?? null;
    if (!folder) return err('capture-destination-refused');
    const decision = checkDestination(folder, deps.config().destinationRoot, {
        protectedFolders: deps.protectedFolders(),
        outputRoots: deps.outputRoots(),
        inboxFolders: deps.config().inboxFolders,
        exists: (f) => deps.port.folderExists(f),
    });
    if (!decision.ok) return err('capture-destination-refused');

    const title = sanitiseTitle(edits.title ?? entry.proposal?.title, 'Capture');
    const tags = edits.tags ?? entry.proposal?.tags ?? [];
    const target = uniquePath(decision.folder, title, 'md', (p) => deps.port.pathExists(p));
    const guard = assertWritable({ protectedFolders: deps.protectedFolders() }, 'create', target);
    if (!guard.ok) return err('capture-destination-refused');

    const source = entry.hasNote === false ? entry.companionPath ?? entry.id : entry.id;
    const note = [
        '---',
        `${ORGANISED_FROM_KEY}: ${JSON.stringify(uidOf(entry))}`,
        ...(tags.length > 0 ? [`tags: ${yamlList(tags)}`] : []),
        '---',
        '',
        organisedBody(entry),
        '',
        `Source: [[${source}]]`,
        '',
    ].join('\n');

    // Intent first: a crash after the create but before the journal update is recovered by `capture-from`.
    await deps.journal.mutate((j) => upsertEntry(j, { ...getEntry(j, entry.id)!, organise: { targetPath: target }, updatedAt: deps.now() }));
    const created = await deps.port.createNote(target, note);
    if (!created.ok) return err('capture-write-failed');
    await deps.journal.mutate((j) => {
        const e = getEntry(j, entry.id);
        return e ? pruneFinished(upsertEntry(j, { ...e, state: 'organised', organise: { targetPath: target, createdPath: created.value }, updatedAt: deps.now() }), deps.now()) : j;
    });
    return ok(created.value);
}

/** The user rejects or skips a capture: nothing is written; the decision is remembered. */
export async function skipCapture(deps: WriterDeps, id: string): Promise<Result<void>> {
    return exclusive(id, err<void>('capture-busy'), () => skipLocked(deps, id));
}

async function skipLocked(deps: WriterDeps, id: string): Promise<Result<void>> {
    const entry = getEntry(deps.journal.get(), id);
    if (!entry) return err('capture-changed');
    if (entry.state !== 'awaiting_review' && entry.state !== 'failed') return err('capture-changed');
    await deps.journal.mutate((j) => finish(bump(j, 'rejected'), entry.id, 'skipped_by_user', deps.now()));
    return ok(undefined);
}

/** Startup recovery: re-run only the writes that were in flight at the crash (reconcile decided which). */
export async function retryPendingWrites(deps: WriterDeps, ids: readonly string[]): Promise<void> {
    for (const id of ids) {
        const result = await acceptCapture(deps, id, {}, { recovering: true });
        if (!result.ok) logger.warn('CaptureInbox', `Recovery write for ${id} not applied: ${result.error}`);
    }
}

/** True when the capture note already carries a plugin block for this capture (reconcile's probe). */
export function noteHasBlockFor(text: string, id: string): boolean {
    const block = findCaptureBlock(text);
    return block.ok && block.value !== null && readCaptureId(text) === id;
}

// ── Production port ──────────────────────────────────────────────────────────────────────────

/** The Obsidian-backed port. Every create asserts writability first; the edit goes through the seam. */
export function createWriterPort(plugin: AIOrganiserPlugin): WriterPort {
    const { app } = plugin;
    return {
        async readNote(path) {
            const file = app.vault.getAbstractFileByPath(path);
            return file instanceof TFile ? app.vault.read(file) : null;
        },
        async editNote(path, baseline, recompute) {
            return applyNoteEdit(plugin, { kind: 'composite', filePath: path, baseline, recompute: (c) => recompute(c) }, { review: false });
        },
        async createNote(path, content) {
            const allowed = assertWritable(plugin.settings, 'create', path);
            if (!allowed.ok) return err('protected-path');
            if (app.vault.getAbstractFileByPath(path)) return err('capture-write-failed');
            try {
                const file = await app.vault.create(path, content);
                return ok(file.path);
            } catch (e) {
                logger.warn('CaptureInbox', `vault.create failed for ${path}`, e);
                return err('capture-write-failed');
            }
        },
        pathExists: (path) => app.vault.getAbstractFileByPath(path) !== null,
        folderExists: (path) => {
            const f = app.vault.getAbstractFileByPath(path);
            return f !== null && !(f instanceof TFile);
        },
        async fileSize(path) {
            const stat = await app.vault.adapter.stat(path);
            return stat ? stat.size : null;
        },
        findNoteByFrontmatter(key, value) {
            for (const file of app.vault.getMarkdownFiles()) {
                const fm = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
                if (fm && fm[key] === value) return file.path;
            }
            return null;
        },
    };
}
