/**
 * Adds and removes the two plugin-owned frontmatter keys (`capture-id`, `capture-status`) as pure
 * INSERTIONS: nothing the user wrote is re-serialised, re-ordered or re-quoted. The strip is the
 * exact inverse, which is what lets a capture's fingerprint ignore the plugin's own write.
 */
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
    return /^[A-Za-z0-9_][A-Za-z0-9_./ -]*$/.test(value) && !/\s$/.test(value) ? value : JSON.stringify(value);
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
    // Only a block mapping can take two more `key: value` lines: flow style ({a: 1}), a list or a scalar cannot.
    const first = body.split('\n').map((l) => l.trim()).find((l) => l !== '' && !l.startsWith('#'));
    if (first !== undefined && (first.startsWith('{') || first.startsWith('[') || first.startsWith('- ') || first === '-')) return err('frontmatter-unclosed');
    const already = body.split('\n').some((l) => keyLine(CAPTURE_ID_KEY).test(l) || keyLine(CAPTURE_STATUS_KEY).test(l));
    if (already) return err('capture-keys-exist');
    return ok({ text: text.slice(0, region.closerStart) + lines + text.slice(region.closerStart), frontmatterCreated: false });
}

/** Read the capture id from the frontmatter, if any. */
export function readCaptureId(text: string): string | null {
    const region = findFrontmatter(text);
    if (region === null || region === 'unclosed') return null;
    for (const line of text.slice(region.bodyStart, region.closerStart).split('\n')) {
        const m = /^capture-id:\s*(.*?)\r?$/.exec(line);
        if (!m) continue;
        const raw = m[1];
        if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replaceAll("''", "'") || null;
        if (raw.startsWith('"')) {
            try {
                const parsed: unknown = JSON.parse(raw);
                return typeof parsed === 'string' ? parsed : null;
            } catch {
                return null;
            }
        }
        return raw || null;
    }
    return null;
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
