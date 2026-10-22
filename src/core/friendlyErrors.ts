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
    'trash-failed',
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

/** The single string a Notice shows: what happened, then what to do. */
export function formatGuidance(entry: GuidanceEntry): string {
    return `${entry.message} ${entry.nextStep}`.trim();
}
