/**
 * Friendly errors: every failure a user can see names what happened AND what to do next.
 *
 * Services return stable machine codes (`Result.err('protected-path')`). This module is the
 * one place those codes are turned into a two-part message ("what happened" + "what to do").
 * The wording lives in i18n (`t.guidance`), so the compiler forces an entry for every code
 * in `GUIDANCE_CODES`. A code with no entry would show the generic fallback, never a raw
 * code or exception text.
 */
import type { Translations } from '../i18n/types';

/**
 * Closed list of codes that carry guidance. Later features append their codes here; the
 * `Translations` type then requires an English entry for each one.
 */
export const GUIDANCE_CODES = [
    // Note-edit write seam
    'protected-path',
    'output-overlap',
    'target-missing',
    'empty-output',
    'baseline-changed',
    'range-invalid',
    'write-failed',
    'rejected',
    // Guided setup
    'invalid-state',
    'validation-failed',
    // Attachment helper (Find embeds)
    'scan-incomplete',
    'canvas-unreadable',
    'still-referenced',
    'ambiguous-reference',
    'scan-out-of-date',
    'metadata-not-ready',
    'file-changed',
    'not-linkable',
    'link-failed',
    'link-changed',
    'link-not-removable',
    'link-removal-off',
    'unlink-failed',
    'trash-failed',
    // Agent index
    'output-path-invalid',
    'output-has-foreign-files',
    'output-not-ours',
    // Cloud inventory and Apps Script
    'script-invalid-endpoint',
    'script-login-page',
    'script-auth',
    'script-not-approved',
    'script-bad-request',
    'script-drive-error',
    'script-network',
    'script-bad-response',
    'script-outdated',
    'marker-conflict',
    'drive-link-invalid',
    'no-secret',
    // Inbox sweep and Google Tasks
    'sweep-keepout-required',
    'sweep-property-invalid',
    'sweep-no-folders',
    'sweep-report-invalid',
    'sweep-report-conflict',
    'sweep-no-provider',
    'sweep-run-failed',
    'sweep-capture-loading',
    // Capture inbox
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
    'capture-source-excluded',
    'capture-journal-corrupt',
    'capture-tagging-failed',
    'project-not-found',
    'duplicate-project-id',
    'project-id-invalid',
    'project-already-adopted',
    'project-role-conflict',
    'project-frontmatter-unreadable',
    'project-adopt-failed',
    'script-capability-missing',
    'ai-share-empty',
    'pack-over-budget',
    'pack-preview-stale',
    'pack-folder-missing',
    'pack-folder-invalid',
    'pack-write-failed',
    'workspace-block-conflict',
    'workspace-chat-url-invalid',
    'operation-store-unreadable',
    'operation-store-unwritable',
    'operation-not-owner',
    'operation-not-found',
    'operation-not-loaded',
    'operation-invalid',
    'operation-takeover-too-soon',
    'operation-takeover-unconfirmed',
    'operation-not-takeover',
    'tasks-script-lists-outdated',
    'tasks-list-not-approved',
    'tasks-due-missing',
    'tasks-readback-off',
    'tasks-no-list',
    'tasks-not-ready',
    'script-tasks-off',
    // Vault upkeep
    'upkeep-running',
    'upkeep-feature-off',
    'upkeep-no-tasks',
    'upkeep-report-invalid',
    'upkeep-report-not-ours',
    'upkeep-task-failed',
    'upkeep-task-unavailable',
    // Agent connectors
    'connector-folder-missing',
    'connector-folder-invalid',
    'connector-scope-write-failed',
    'connector-test-failed',
    'connector-feature-off',
    'connector-file-not-ours',
    'connector-needs-desktop',
    'connector-node-missing',
    'connector-vault-path-unavailable',
    'export-nothing-in-scope',
    // Agent instructions
    'instructions-path-invalid',
    'instructions-conflict',
    // Drive offload
    'mount-invalid',
    'mount-missing',
    'mount-slow',
    'mount-inside-vault',
    'mount-vault-unverified',
    'name-invalid',
    'dest-conflict',
    'copy-failed',
    'read-failed',
    'unsupported-reference',
    'referrer-changed',
    'drive-not-synced',
    'remote-ambiguous',
    'source-missing',
    'journal-not-ours',
    'invalid-transition',
    'referrer-conflict',
    'node-missing',
    'cancelled',
    'barrier-referrer-not-done',
    'barrier-remote-mismatch',
    'barrier-source-changed',
    'barrier-protected',
    'barrier-still-referenced',
    'barrier-scan-incomplete',
    'barrier-vault-changed',
    // Newsletter catch-up audio
    'catchup-nothing-pending',
    'catchup-audio-off',
    'catchup-wrong-mode',
    'catchup-no-tts',
    'catchup-script-failed',
    'catchup-script-too-long',
    'catchup-tts-failed',
    'catchup-save-failed',
    'catchup-busy',
    'catchup-changed',
    'catchup-unresolved',
    'catchup-too-much',
    'catchup-output-protected',
    'catchup-daily-only',
    'catchup-replace-unsafe',
    'catchup-replace-partial',
    // Newsletter read signal
    'read-signal-off',
    'read-not-digest',
    'read-unparsable',
    'read-no-match',
    'read-save-failed',
] as const;

export type GuidanceCode = (typeof GUIDANCE_CODES)[number];

/** The two sentences shown for a code. */
export interface GuidanceEntry {
    /** What happened, in plain words. */
    message: string;
    /** What the user can do about it. */
    nextStep: string;
}

const KNOWN: ReadonlySet<string> = new Set(GUIDANCE_CODES);

/** True when the code has dedicated guidance. */
export function isGuidanceCode(code: string): code is GuidanceCode {
    return KNOWN.has(code);
}

/** Resolve a code (known or not) to its guidance. Unknown codes get the generic fallback. */
export function describeError(t: Translations, code: string): GuidanceEntry {
    return isGuidanceCode(code) ? t.guidance[code] : t.guidance.unknown;
}

/**
 * The same guidance for a message shown inside a guided setup window. Some next steps end with "If you are not in the setup,
 * choose Set up ...": true on a Notice, absurd inside the setup, so that sentence is dropped there.
 */
export function formatGuidanceInSetup(entry: GuidanceEntry): string {
    return `${entry.message} ${entry.nextStep.replace(/\s*If you are not in the setup, [^.]*\./, '')}`.trim();
}

/** The single string a Notice shows: what happened, then what to do. */
export function formatGuidance(entry: GuidanceEntry): string {
    return `${entry.message} ${entry.nextStep}`.trim();
}
