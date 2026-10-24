/**
 * Finds captures in the configured inbox folders. Read-only: it never writes, never calls a provider
 * and reads a note's text only AFTER the note's path passed the exclusion guard.
 *
 * File events are only hints that this should run; the scan itself is the truth. One pass over the
 * in-memory file list filtered by prefix, then text reads for candidates only (mobile-friendly).
 */
import { isInsideOrEqual, normalisePath } from '../../core/protectedPaths';
import { exclusionReason, policyRevisionOf, type SweepPolicy } from '../inboxSweep/sweepGuard';
import { alreadyHandled } from './captureJournal';
import { computeFingerprint } from './enrichmentBlock';
import { classifyByExtension, extensionOf, isKnownUnsupportedMedia, type MediaKind } from './mediaSignature';
import { pathExclusion } from './capturePolicy';
import type { CaptureConfig, CaptureJournal, SkipReason } from './captureTypes';

export interface VaultFileInfo {
    path: string;
    extension: string;
    ctime: number;
    mtime: number;
    size: number;
}

export interface ResolvedAttachments {
    /** Vault paths of files the note embeds or links that exist */
    resolved: string[];
    /** Embedded or linked media names that do not resolve (yet): an attachment may arrive after its note */
    unresolvedMedia: string[];
}

/** The slice of the vault the scanner needs. The production port wraps Obsidian; tests fake it. */
export interface CaptureVaultPort {
    listFiles(): VaultFileInfo[];
    readText(path: string): Promise<string>;
    /**
     * The media a note embeds or links. `text` is omitted for a note that is not being read (a kept-out
     * note): the port then answers from Obsidian's link index alone, so nothing is read.
     */
    resolveAttachments(notePath: string, text?: string): ResolvedAttachments;
    /**
     * sha256 of a file's bytes, cached by (path, size, mtime) so an unchanged file is read once. Called only for
     * attachments that already passed the exclusion guard and the size cap. null = unreadable.
     */
    digestOf(path: string, size: number, mtime: number): Promise<string | null>;
    /** Notes anywhere in the vault that embed or link this file (from the link index; no reads) */
    referrersOf(path: string): string[];
}

export interface ScannedAttachment {
    path: string;
    ext: string;
    kind: MediaKind | null;
    size: number;
    /** sha256 of the bytes (media attachments only) */
    digest?: string;
}

export interface ScannedCapture {
    /** The note path, or the media path of a bare capture */
    id: string;
    notePath: string | null;
    text: string;
    attachments: ScannedAttachment[];
    /** Media referenced but not resolvable yet: the capture must wait */
    missingAttachments: string[];
    fingerprint: string;
    ctime: number;
}

export interface ScanSkip {
    id: string;
    reason: SkipReason;
}

export interface ScanOutcome {
    captures: ScannedCapture[];
    skipped: ScanSkip[];
    /** Notes older than the setup cutoff that were ignored (shown in the confirmation, never listed) */
    olderIgnored: number;
}

export interface ScanDeps {
    config: CaptureConfig;
    /** The BASE sweep policy (never the held-paths one: the capture feature must see its own captures) */
    policy: SweepPolicy;
    journal: CaptureJournal;
    /** Has the inbox sweep already read this note at exactly this text? */
    isSwept(path: string, text: string): Promise<boolean>;
    /** The user chose "Process all existing": ignore the setup cutoff */
    includeExisting?: boolean;
}

export async function scanInbox(port: CaptureVaultPort, deps: ScanDeps): Promise<ScanOutcome> {
    const { config, policy, journal } = deps;
    const inbox = config.inboxFolders.map(normalisePath).filter((p) => p !== '');
    const outcome: ScanOutcome = { captures: [], skipped: [], olderIgnored: 0 };
    if (inbox.length === 0) return outcome;

    const revision = await policyRevisionOf(policy);
    const files = port.listFiles();
    const info = new Map(files.map((f) => [f.path, f]));
    const inInbox = files.filter((f) => inbox.some((i) => isInsideOrEqual(f.path, i)));
    const notes = inInbox.filter((f) => f.extension.toLowerCase() === 'md').sort((a, b) => a.path.localeCompare(b.path));
    const referenced = new Set<string>();

    const skip = (id: string, reason: SkipReason): void => {
        outcome.skipped.push({ id, reason });
    };
    /** Creation time, falling back to the modification time when the platform gives none. */
    const created = (f: VaultFileInfo): number => (f.ctime > 0 ? f.ctime : f.mtime);
    const tooLarge = (atts: ScannedAttachment[]): boolean => atts.some((a) => a.kind !== null && a.size > config.maxAttachmentBytes);
    // An accepted or organised capture is never offered again, whether it is still a journal entry
    // (kept so the organised note can be created) or already a tombstone.
    const settled = (id: string): boolean => {
        const e = journal.entries[id];
        if (e && (e.state === 'accepted' || e.state === 'organised')) return true;
        const t = journal.tombstones[id];
        return !!t && (t.state === 'accepted' || t.state === 'organised');
    };

    for (const note of notes) {
        const id = note.path;
        // Whatever happens to a note below (accepted, kept out, ignored as old, too large), the media it
        // embeds belongs to it: it must never turn up as a bare capture and be uploaded on its own. The
        // link index answers this without reading the note.
        for (const path of port.resolveAttachments(id).resolved) referenced.add(path);
        if (settled(id)) continue;
        if (pathExclusion(id, policy)) {
            skip(id, 'excluded');
            continue;
        }
        if (!deps.includeExisting && created(note) < config.since && !journal.entries[id]) {
            outcome.olderIgnored++;
            continue;
        }
        const text = await port.readText(id);
        const refs = port.resolveAttachments(id, text);
        for (const path of refs.resolved) referenced.add(path);
        if (exclusionReason(id, text, policy)) {
            skip(id, 'excluded');
            continue;
        }
        const attachments: ScannedAttachment[] = [];
        let excluded = false;
        for (const path of refs.resolved) {
            const kind = classifyByExtension(path);
            // Only media is a capture attachment; an ordinary link to another note is just a link.
            if (kind === null && !isKnownUnsupportedMedia(path)) continue;
            // Judge every attachment (no early exit), so none is left unshielded above.
            if (pathExclusion(path, policy)) excluded = true;
            const meta = info.get(path);
            // A file the snapshot does not list yet is still arriving: the capture waits rather than guessing a size.
            if (!meta) {
                refs.unresolvedMedia.push(path);
                continue;
            }
            attachments.push({ path, ext: extensionOf(path), kind, size: meta.size });
        }
        if (excluded) {
            skip(id, 'excluded');
            continue;
        }
        if (tooLarge(attachments)) {
            skip(id, 'too-large');
            continue;
        }
        const missing = [...refs.unresolvedMedia];
        for (const a of attachments) {
            if (a.kind === null) continue;
            // No digest means the file cannot be read yet: the capture waits (nothing is judged or sent on an unknown identity).
            const digest = await port.digestOf(a.path, a.size, info.get(a.path)?.mtime ?? 0);
            if (digest === null) missing.push(a.path);
            else a.digest = digest;
        }
        const entry = journal.entries[id];
        const fingerprint = await computeFingerprint(text, attachments, entry?.inserted);
        if (alreadyHandled(journal, id, fingerprint, revision)) continue;
        if (!entry && (await deps.isSwept(id, text))) {
            skip(id, 'already-swept');
            continue;
        }
        outcome.captures.push({ id, notePath: id, text, attachments, missingAttachments: missing, fingerprint, ctime: note.ctime });
    }

    for (const file of inInbox) {
        const id = file.path;
        if (file.extension.toLowerCase() === 'md' || referenced.has(id)) continue;
        if (journal.aliases[id] || (journal.entries[id] === undefined && settled(id))) continue;
        const kind = classifyByExtension(id);
        if (kind === null && !isKnownUnsupportedMedia(id)) continue;
        // Media that any note embeds belongs to that note, wherever the note lives and whatever its content:
        // it is not a bare capture (fail closed: a kept-out referrer is never read, so it cannot be judged).
        if (port.referrersOf(id).length > 0) continue;
        if (pathExclusion(id, policy)) {
            skip(id, 'excluded');
            continue;
        }
        if (!deps.includeExisting && created(file) < config.since && !journal.entries[id]) {
            outcome.olderIgnored++;
            continue;
        }
        if (kind === null) {
            skip(id, 'unsupported');
            continue;
        }
        const att: ScannedAttachment = { path: id, ext: extensionOf(id), kind, size: file.size };
        if (tooLarge([att])) {
            skip(id, 'too-large');
            continue;
        }
        const digest = await port.digestOf(id, file.size, file.mtime);
        if (digest === null) continue; // unreadable for now: not offered until it can be read
        att.digest = digest;
        const fingerprint = await computeFingerprint('', [att], journal.entries[id]?.inserted);
        if (alreadyHandled(journal, id, fingerprint, revision)) continue;
        outcome.captures.push({ id, notePath: null, text: '', attachments: [att], missingAttachments: [], fingerprint, ctime: file.ctime });
    }
    return outcome;
}
