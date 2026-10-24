/**
 * Shared vocabulary of the capture inbox (the "clarify" step before the inbox sweep).
 * Pure types and constants only: nothing here touches Obsidian, the network or the vault.
 */

/** Per-capture lifecycle. Everything before `accepted` is "held": the inbox sweep must not read it. */
export type CaptureState =
    | 'new'
    | 'waiting_for_stable'
    | 'ready'
    | 'processing'
    | 'awaiting_review'
    | 'accept_pending_write'
    | 'accepted'
    | 'organised'
    | 'failed'
    | 'skipped'
    | 'skipped_by_user';

/** The stage a job is in (written ahead of each provider call so a crash can be recovered). */
export type CaptureStage = 'stability' | 'read' | 'transcribe' | 'digitise' | 'classify' | 'write' | 'organise';

/** Why a capture was set aside. Stable codes: they are shown to the user through guidance text. */
export type SkipReason =
    | 'excluded'
    | 'too-large'
    | 'unsupported'
    | 'invalid-media'
    | 'already-swept'
    | 'already-captured'
    | 'older-than-setup'
    | 'nothing-to-process'
    | 'digitisation-off'
    | 'attachment-missing';

/** Where the readable text of a capture came from. */
export type CaptureSource = 'note-text' | 'transcript' | 'digitised' | 'mixed';

export interface CaptureProposal {
    title: string;
    tags: string[];
    /** A folder from the allowed list (index validated locally); null = no destination proposed */
    folder: string | null;
}

/** What the capture feature wrote into the original, so the insertion can be stripped exactly. */
export interface InsertedSpans {
    /** The block was appended after a separator the plugin added (whitespace only) */
    separatorAdded: boolean;
    /** The plugin created the frontmatter pair itself (the note had none) */
    frontmatterCreated: boolean;
}

export interface CaptureAttachmentRef {
    path: string;
    size: number;
    kind: 'audio' | 'image';
}

/** One observation of a file for the stability window. */
export interface FileObservation {
    size: number;
    mtime: number;
    /** Epoch ms at which this was observed */
    at: number;
}

export interface CaptureEntry {
    /** Identity: the capture note path (or the media path until a companion note exists) */
    id: string;
    state: CaptureState;
    /** Stable id written to the note's `capture-id` (the journal id is a path, which renames change) */
    uid?: string;
    stage?: CaptureStage;
    /** sha256 over the note (plugin block and keys removed, whitespace-normalised) + attachment sizes */
    fingerprint: string;
    /** Processing version the entry was produced under */
    processingVersion: number;
    attempts: number;
    retriable?: boolean;
    skipReason?: SkipReason;
    failedStage?: CaptureStage;
    /** A short, one-line reason for a failure (never the capture's content) */
    errorText?: string;
    source?: CaptureSource;
    /** Held machine text (transcript / digitised), until the user accepts (at most MAX_HELD_CHARS) */
    text?: string;
    /** The text the user wrote in the note (held for the review and for the organised note; at most MAX_HELD_CHARS) */
    noteText?: string;
    proposal?: CaptureProposal;
    inserted?: InsertedSpans;
    /** The attachments this capture was judged with (path, size, kind) */
    attachments?: CaptureAttachmentRef[];
    /** False for a bare media capture: Accept creates the companion note */
    hasNote?: boolean;
    /** Journalled before the companion note is created, so a crash can find it by `capture-id` */
    companionPath?: string;
    /** The user edited the machine text or the proposal in the review */
    edited?: boolean;
    /** "Transcribe the audio anyway": transcribe even though the note already has text */
    forceTranscribe?: boolean;
    /** Edited while it was awaiting review: it waits for an explicit "Process again" (it spends money) */
    needsConfirm?: boolean;
    /** Last-seen observations of the note and its attachments, keyed by path */
    observed?: Record<string, FileObservation>;
    /** The organise intent: journalled before the new note is created */
    organise?: { targetPath: string; createdPath?: string };
    createdAt: number;
    updatedAt: number;
}

/** A compact record kept for a finished capture so it is not re-processed or re-charged. */
export interface CaptureTombstone {
    id: string;
    fingerprintHash: string;
    /** Policy revision a guard-skip was judged under: a changed policy re-offers the capture */
    policyRevision?: string;
    state: 'accepted' | 'organised' | 'skipped' | 'skipped_by_user';
    at: number;
}

export interface CaptureCounters {
    processed: number;
    acceptedUnchanged: number;
    acceptedEdited: number;
    rejected: number;
    failed: Record<string, number>;
    skipped: Record<string, number>;
}

export interface CaptureJournal {
    version: 1;
    entries: Record<string, CaptureEntry>;
    tombstones: Record<string, CaptureTombstone>;
    /** media path -> companion note path */
    aliases: Record<string, string>;
    counters: CaptureCounters;
}

/** Everything the processor and runtime read from settings, as a plain object (no Plugin needed). */
export interface CaptureConfig {
    inboxFolders: readonly string[];
    destinationRoot: string;
    /** Epoch ms of setup completion: only captures created after this are picked up automatically */
    since: number;
    onOpen: boolean;
    onOpenMaxPerRun: number;
    maxPerRun: number;
    maxAttachmentBytes: number;
    minWords: number;
    digitiseImages: boolean;
    maxImagesPerCapture: number;
    maxTextChars: number;
    stabilityMs: number;
    requireMarker: boolean;
}

export const PROCESSING_VERSION = 1;
export const MAX_ATTEMPTS = 3;
/** Processing stops when this many captures await review. */
export const MAX_AWAITING_REVIEW = 20;
/** The most machine text kept in one journal entry. */
export const MAX_HELD_CHARS = 50_000;
export const CAPTURE_ID_KEY = 'capture-id';
export const CAPTURE_STATUS_KEY = 'capture-status';
export const CAPTURE_STATUS_ACCEPTED = 'accepted-text';
export const CAPTURE_BLOCK_START = '<!-- aio:capture -->';
export const CAPTURE_BLOCK_END = '<!-- /aio:capture -->';

/** Stable error codes the capture feature returns; every one needs an entry in GUIDANCE_CODES (Phase 6 test). */
export const CAPTURE_ERROR_CODES = [
    'capture-changed',
    'capture-swept',
    'capture-marker-conflict',
    'capture-frontmatter-unreadable',
    'capture-write-failed',
    'capture-no-folders',
    'capture-keepout-required',
    'capture-destination-refused',
    'capture-busy',
    'capture-inbox-invalid',
    'capture-no-provider',
] as const;
export type CaptureErrorCode = (typeof CAPTURE_ERROR_CODES)[number];

export function emptyCounters(): CaptureCounters {
    return { processed: 0, acceptedUnchanged: 0, acceptedEdited: 0, rejected: 0, failed: {}, skipped: {} };
}

export function emptyJournal(): CaptureJournal {
    return { version: 1, entries: {}, tombstones: {}, aliases: {}, counters: emptyCounters() };
}
