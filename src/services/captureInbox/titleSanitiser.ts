/**
 * File-name safety for titles that came from a model or from the user. A title becomes a file name,
 * so it is stripped of anything a file system, Obsidian links or a path traversal could read as
 * structure. Pure.
 */

const RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;
const MAX_TITLE_CHARS = 80;

// Control characters, zero-width and bidi-override characters: invisible, and never part of a file name.
// eslint-disable-next-line no-control-regex
const INVISIBLE = new RegExp('[\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]', 'g');

function clean(raw: unknown): string {
    const text = typeof raw === 'string' ? raw : '';
    const stripped = text
        .replace(INVISIBLE, ' ')
        .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return [...stripped].slice(0, MAX_TITLE_CHARS).join('').replace(/^[.\s-]+|[.\s]+$/g, '').trim();
}

const usable = (t: string): boolean => t !== '' && !RESERVED.test(t);

/** A usable file-name title, or `fallback` when nothing is left. Never returns an empty string. */
export function sanitiseTitle(raw: unknown, fallback = 'Capture'): string {
    const t = clean(raw);
    if (usable(t)) return t;
    const f = clean(fallback);
    return usable(f) ? f : 'Capture';
}

/** `Title.md`, then `Title_2.md`, `Title_3.md`... until `exists` says the path is free. Never overwrites. */
export function uniquePath(folder: string, title: string, extension: string, exists: (path: string) => boolean): string {
    const dir = folder.replace(/\/+$/, '');
    const prefix = dir === '' ? '' : `${dir}/`;
    const first = `${prefix}${title}.${extension}`;
    if (!exists(first)) return first;
    for (let n = 2; n < 10_000; n++) {
        const candidate = `${prefix}${title}_${n}.${extension}`;
        if (!exists(candidate)) return candidate;
    }
    return `${prefix}${title}_${Date.now()}.${extension}`;
}
