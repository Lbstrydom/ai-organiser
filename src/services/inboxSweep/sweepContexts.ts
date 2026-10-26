/**
 * The contexts the inbox sweep offers (`@home`, `@call`, ...). Pure.
 *
 * The built-in set is the one meeting minutes already use (`VALID_GTD_CONTEXTS`, imported, never copied). The user's own
 * set lives in the `sweepContexts` setting, where `[]` means "use the built-in set": the defaults are never written into
 * settings, so a later change of the built-in set reaches everyone who never customised it, and an unconfigured vault
 * behaves exactly as before. `resolveSweepContexts` is the only place `[]` becomes the built-in set.
 */
import { VALID_GTD_CONTEXTS } from '../validators/constants';

export const DEFAULT_SWEEP_CONTEXTS: readonly string[] = VALID_GTD_CONTEXTS;

/** At most this many contexts are kept (more would crowd the prompt and the dropdown). */
export const MAX_SWEEP_CONTEXTS = 12;

const CONTEXT_PATTERN = /^@[a-z0-9][a-z0-9_-]{0,23}$/;

/**
 * Trim, lower-case, validate, de-duplicate and cap. Absent, empty or all-invalid input returns `[]`, never the defaults.
 * Accepts a string array or one string with one context per line (or comma).
 */
export function normaliseContexts(raw: unknown): string[] {
    const parts = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\n,]+/) : [];
    const out: string[] = [];
    for (const part of parts) {
        if (typeof part !== 'string') continue;
        const c = part.trim().toLowerCase();
        if (!CONTEXT_PATTERN.test(c) || out.includes(c)) continue;
        out.push(c);
        if (out.length >= MAX_SWEEP_CONTEXTS) break;
    }
    return out;
}

/** The lines of `raw` that were dropped, with why: for the live validation under the setting. */
export function contextProblems(raw: string): Array<{ line: string; reason: 'invalid' | 'duplicate' | 'too-many' }> {
    const problems: Array<{ line: string; reason: 'invalid' | 'duplicate' | 'too-many' }> = [];
    const seen: string[] = [];
    for (const line of raw.split(/[\n,]+/)) {
        const c = line.trim().toLowerCase();
        if (c === '') continue;
        if (!CONTEXT_PATTERN.test(c)) problems.push({ line: line.trim(), reason: 'invalid' });
        else if (seen.includes(c)) problems.push({ line: line.trim(), reason: 'duplicate' });
        else if (seen.length >= MAX_SWEEP_CONTEXTS) problems.push({ line: line.trim(), reason: 'too-many' });
        else seen.push(c);
    }
    return problems;
}

/** The set this run uses: the user's, or the built-in one when none is configured. */
export function resolveSweepContexts(settings: { sweepContexts?: unknown }): string[] {
    const own = normaliseContexts(settings.sweepContexts);
    return own.length > 0 ? own : [...DEFAULT_SWEEP_CONTEXTS];
}

export function isKnownContext(list: readonly string[], context: string): boolean {
    return list.includes(context);
}

/** True when `list` is exactly the built-in set (so a record made under it carries no snapshot, and stays byte-identical). */
export function isDefaultContextSet(list: readonly string[]): boolean {
    return list.length === DEFAULT_SWEEP_CONTEXTS.length && list.every((c, i) => c === DEFAULT_SWEEP_CONTEXTS[i]);
}
