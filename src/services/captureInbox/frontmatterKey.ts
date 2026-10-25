/**
 * Adds and removes the two plugin-owned frontmatter keys (`capture-id`, `capture-status`) as pure
 * INSERTIONS: nothing the user wrote is re-serialised, re-ordered or re-quoted. The strip is the
 * exact inverse, which is what lets a capture's fingerprint ignore the plugin's own write.
 */
import * as yaml from 'js-yaml';
import { Result, ok, err } from '../../core/result';
import { CAPTURE_ID_KEY, CAPTURE_STATUS_KEY } from './captureTypes';

const OPENER = /^---[ \t]*\r?\n/;
const CLOSER_LINE = /^(?:---|\.\.\.)[ \t]*\r?$/;

interface FrontmatterRegion {
    /** Offset just after the opening line */
    bodyStart: number;
    /** Offset of the first character of the closing line */
    closerStart: number;
    /** Offset just past the closing line (including its newline when present) */
    end: number;
}

function findFrontmatter(text: string): FrontmatterRegion | 'unclosed' | null {
    const open = OPENER.exec(text);
    if (!open) return null;
    let at = open[0].length;
    while (at <= text.length) {
        const nl = text.indexOf('\n', at);
        const lineEnd = nl === -1 ? text.length : nl;
        const line = text.slice(at, lineEnd);
        if (CLOSER_LINE.test(line)) {
            return { bodyStart: open[0].length, closerStart: at, end: nl === -1 ? text.length : nl + 1 };
        }
        if (nl === -1) break;
        at = nl + 1;
    }
    return 'unclosed';
}

function eolOf(text: string): string {
    return text.includes('\r\n') ? '\r\n' : '\n';
}

/** A YAML-safe scalar for the id (a vault path may contain `:` or `#`). */
function scalar(value: string): string {
    // YAML types plain scalars: `true`, `null`, `1e3` would stop being strings, so those are quoted too.
    const plain = /^[A-Za-z0-9_][A-Za-z0-9_./ -]*$/.test(value) && !/\s$/.test(value) && !/^(?:true|false|null|yes|no|on|off|y|n|~)$/i.test(value) && !/^[+-]?(?:\d[\d_]*)(?:\.[\d_]*)?(?:e[+-]?\d+)?$/i.test(value) && !/^0[xob]/i.test(value);
    return plain ? value : JSON.stringify(value);
}

const keyLine = (key: string) => new RegExp(`^${key}:.*\\r?$`);

export interface SetKeysResult {
    text: string;
    /** The plugin had to create the frontmatter pair itself */
    frontmatterCreated: boolean;
}

/** Insert the two keys. A frontmatter block that opens but never closes is refused (nothing written). */
export function setCaptureKeys(text: string, keys: { id: string; status: string }): Result<SetKeysResult> {
    const eol = eolOf(text);
    const lines = `${CAPTURE_ID_KEY}: ${scalar(keys.id)}${eol}${CAPTURE_STATUS_KEY}: ${scalar(keys.status)}${eol}`;
    const region = findFrontmatter(text);
    if (region === 'unclosed') return err('frontmatter-unclosed');
    if (region === null) {
        return ok({ text: `---${eol}${lines}---${eol}${text}`, frontmatterCreated: true });
    }
    const body = text.slice(region.bodyStart, region.closerStart);
    // Judged by what the YAML MEANS, not by how its lines look. Two more `key: value` lines can only be appended to a
    // block mapping: flow style ({a: 1}), a list, a plain scalar or a document that does not parse cannot take them.
    let parsed: unknown;
    try {
        parsed = yaml.load(body);
    } catch {
        return err('frontmatter-unclosed');
    }
    if (parsed === null || parsed === undefined) {
        // `~`, `null` or only comments: an empty body can take keys, a body that says null cannot.
        const meaningful = body.split('\n').map((l) => l.trim()).some((l) => l !== '' && !l.startsWith('#'));
        if (meaningful) return err('frontmatter-unclosed');
    } else {
        if (typeof parsed !== 'object' || Array.isArray(parsed)) return err('frontmatter-unclosed');
        const first = body.split('\n').map((l) => l.trim()).find((l) => l !== '' && !l.startsWith('#'));
        if (first !== undefined && first.startsWith('{')) return err('frontmatter-unclosed');
        // The user's own capture keys in ANY spelling (plain, quoted, flow) block the insertion.
        const own = parsed as Record<string, unknown>;
        if (Object.hasOwn(own, CAPTURE_ID_KEY) || Object.hasOwn(own, CAPTURE_STATUS_KEY)) return err('capture-keys-exist');
    }
    const already = body.split('\n').some((l) => keyLine(CAPTURE_ID_KEY).test(l) || keyLine(CAPTURE_STATUS_KEY).test(l));
    if (already) return err('capture-keys-exist');
    return ok({ text: text.slice(0, region.closerStart) + lines + text.slice(region.closerStart), frontmatterCreated: false });
}

/** Read the capture id from the frontmatter, if any. */
export function readCaptureId(text: string): string | null {
    const region = findFrontmatter(text);
    if (region === null || region === 'unclosed') return null;
    try {
        const parsed: unknown = yaml.load(text.slice(region.bodyStart, region.closerStart));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        const value = (parsed as Record<string, unknown>)[CAPTURE_ID_KEY];
        if (typeof value === 'string') return value === '' ? null : value;
        return typeof value === 'number' ? String(value) : null;
    } catch {
        return null;
    }
}

/** The plugin's own `capture-status` value, or null when the note has none. */
export function readCaptureStatus(text: string): string | null {
    const region = findFrontmatter(text);
    if (region === null || region === 'unclosed') return null;
    try {
        const parsed: unknown = yaml.load(text.slice(region.bodyStart, region.closerStart));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        const value = (parsed as Record<string, unknown>)[CAPTURE_STATUS_KEY];
        return typeof value === 'string' ? value : null;
    } catch {
        return null;
    }
}

/**
 * Change the value of the plugin's own `capture-status` line and nothing else (same line, same ending). Refused when the
 * note has no such line: it never adds a key, so it cannot touch a note the plugin did not write to.
 */
export function setCaptureStatus(text: string, status: string): Result<string> {
    const region = findFrontmatter(text);
    if (region === null || region === 'unclosed') return err('capture-status-missing');
    const body = text.slice(region.bodyStart, region.closerStart);
    let replaced = false;
    const lines = (body.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((l) => {
        const bare = l.replace(/\r?\n$/, '');
        if (replaced || !keyLine(CAPTURE_STATUS_KEY).test(bare)) return l;
        replaced = true;
        // Only the value is replaced: an inline comment or spacing the user added after it stays.
        const parts = /^(capture-status:)([ \t]*)("[^"]*"|'[^']*'|[^\s#]+)?(.*)$/.exec(bare);
        if (!parts) return `${CAPTURE_STATUS_KEY}: ${scalar(status)}${l.slice(bare.length)}`;
        const [, key, gap, value, rest] = parts;
        // An empty value followed by a comment keeps the comment, separated by a space.
        const tail = value === undefined && rest !== '' ? ` ${rest}` : rest;
        return `${key}${gap === '' ? ' ' : gap}${scalar(status)}${tail}${l.slice(bare.length)}`;
    });
    if (!replaced) return err('capture-status-missing');
    const next = text.slice(0, region.bodyStart) + lines.join('') + text.slice(region.closerStart);
    // The line is rewritten only if that changes the value and nothing else (a multi-line value would not survive a one-line rewrite).
    try {
        const before = yaml.load(body) as Record<string, unknown> | null;
        const after = yaml.load(lines.join('')) as Record<string, unknown> | null;
        if (!before || !after || after[CAPTURE_STATUS_KEY] !== status) return err('capture-status-missing');
        // Same keys, in the same order: nothing was folded into or out of the status value.
        if (Object.keys(before).join('\u0000') !== Object.keys(after).join('\u0000')) return err('capture-status-missing');
    } catch {
        return err('capture-status-missing');
    }
    return ok(next);
}

/** The exact inverse of {@link setCaptureKeys}. */
export function stripCaptureKeys(text: string, opts: { frontmatterCreated: boolean }): string {
    const region = findFrontmatter(text);
    if (region === null || region === 'unclosed') return text;
    const body = text.slice(region.bodyStart, region.closerStart);
    const kept = (body.match(/[^\n]*\n|[^\n]+$/g) ?? []).filter((l) => !keyLine(CAPTURE_ID_KEY).test(l.replace(/\n$/, '')) && !keyLine(CAPTURE_STATUS_KEY).test(l.replace(/\n$/, '')));
    const newBody = kept.join('');
    if (opts.frontmatterCreated && newBody.trim() === '') {
        return text.slice(0, 0) + text.slice(region.end);
    }
    return text.slice(0, region.bodyStart) + newBody + text.slice(region.closerStart);
}
