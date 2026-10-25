/**
 * File-name safety for titles that came from a model or from the user. A title becomes a file name,
 * so it is stripped of anything a file system, Obsidian links or a path traversal could read as
 * structure. Pure.
 */

const RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;
const MAX_TITLE_CHARS = 80;
const MAX_TITLE_BYTES = 180;

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
    let chars = [...stripped].slice(0, MAX_TITLE_CHARS);
    // A file name is limited in bytes, not characters: 80 emoji are 320 bytes.
    while (chars.length > 0 && new TextEncoder().encode(chars.join('')).length > MAX_TITLE_BYTES) chars = chars.slice(0, -1);
    return chars.join('').replace(/^[.\s-]+|[.\s]+$/g, '').trim();
}

/**
 * Words for a fallback title (used when tagging gives none): the user's own first words with links reduced to their names,
 * URLs dropped and a clock time kept (14:30 becomes 14.30, a colon cannot be in a file name). `strippedText` is the prompt
 * text, used only when the note has no words of its own (a bare media capture).
 */
export function titleSeed(noteBody: string, strippedText: string): string {
    const own = noteBody
        .replace(/!\[\[[^\]\n]{0,300}\]\]/g, ' ')
        .replace(/\[\[([^\]|\n]{0,300})(?:\|([^\]\n]{0,300}))?\]\]/g, (_m, target: string, alias?: string) => alias ?? target.split('#')[0])
        .replace(/!?\[([^\]\n]{0,300})\]\([^)\n]{0,500}\)/g, '$1')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/\b(\d{1,2}):(\d{2})(?::\d{2})?\b/g, '$1.$2')
        .replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, ' ')
        .replace(/^#+\s*/gm, '');
    const words = (own.trim() !== '' ? own : strippedText).split(/\s+/).filter(Boolean);
    return words.slice(0, 6).join(' ');
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
