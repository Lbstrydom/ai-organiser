/**
 * Generic frontmatter helpers for plugin-owned keys, as pure INSERTIONS: nothing the user wrote is re-serialised,
 * re-ordered or re-quoted (the same discipline as `captureInbox/frontmatterKey.ts`, which is specific to the capture keys).
 * Judged by what the YAML MEANS: scalar, list, flow-style, null-like and unparseable frontmatter cannot take more keys.
 */
import * as yaml from 'js-yaml';
import { Result, ok, err } from '../core/result';

const OPENER = /^---[ \t]*\r?\n/;
const CLOSER_LINE = /^(?:---|\.\.\.)[ \t]*\r?$/;

interface Region { bodyStart: number; closerStart: number; end: number }

function findFrontmatter(text: string): Region | 'unclosed' | null {
    const open = OPENER.exec(text);
    if (!open) return null;
    let at = open[0].length;
    while (at <= text.length) {
        const nl = text.indexOf('\n', at);
        const lineEnd = nl === -1 ? text.length : nl;
        if (CLOSER_LINE.test(text.slice(at, lineEnd))) return { bodyStart: open[0].length, closerStart: at, end: nl === -1 ? text.length : nl + 1 };
        if (nl === -1) break;
        at = nl + 1;
    }
    return 'unclosed';
}

const eolOf = (text: string): string => (text.includes('\r\n') ? '\r\n' : '\n');

/** A YAML-safe scalar: anything YAML would type as a non-string, or that holds `:`/`#`, is quoted. */
export function yamlScalar(value: string): string {
    const plain = /^[A-Za-z0-9_][A-Za-z0-9_./ -]*$/.test(value) && !/\s$/.test(value)
        && !/^(?:true|false|null|yes|no|on|off|y|n|~)$/i.test(value)
        && !/^[+-]?(?:\d[\d_]*)(?:\.[\d_]*)?(?:e[+-]?\d+)?$/i.test(value)
        && !/^0[xob]/i.test(value);
    return plain ? value : JSON.stringify(value);
}

/** The frontmatter as a plain record, or null when the note has none, it is unreadable, or it is not a mapping. */
export function readFrontmatterRecord(text: string): Record<string, unknown> | null {
    const region = findFrontmatter(text);
    if (region === null || region === 'unclosed') return null;
    try {
        const parsed: unknown = yaml.load(text.slice(region.bodyStart, region.closerStart));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

export interface InsertKeysResult {
    text: string;
    /** The frontmatter pair was created by this insertion */
    frontmatterCreated: boolean;
}

/**
 * Append `key: value` lines (string values) at the end of the frontmatter, creating the pair when the note has none.
 * Refuses, writing nothing, when a frontmatter block never closes or cannot take more keys (`frontmatter-unreadable`), or
 * when any of the keys is already there in any spelling (`frontmatter-key-exists`).
 */
export function insertFrontmatterKeys(text: string, entries: ReadonlyArray<readonly [string, string]>): Result<InsertKeysResult> {
    const eol = eolOf(text);
    const lines = entries.map(([key, value]) => `${key}: ${yamlScalar(value)}${eol}`).join('');
    const region = findFrontmatter(text);
    if (region === 'unclosed') return err('frontmatter-unreadable');
    if (region === null) return ok({ text: `---${eol}${lines}---${eol}${text}`, frontmatterCreated: true });
    const body = text.slice(region.bodyStart, region.closerStart);
    let parsed: unknown;
    try {
        parsed = yaml.load(body);
    } catch {
        return err('frontmatter-unreadable');
    }
    if (parsed === null || parsed === undefined) {
        const meaningful = body.split('\n').map((l) => l.trim()).some((l) => l !== '' && !l.startsWith('#'));
        if (meaningful) return err('frontmatter-unreadable');
    } else {
        if (typeof parsed !== 'object' || Array.isArray(parsed)) return err('frontmatter-unreadable');
        const first = body.split('\n').map((l) => l.trim()).find((l) => l !== '' && !l.startsWith('#'));
        if (first !== undefined && first.startsWith('{')) return err('frontmatter-unreadable');
        const own = parsed as Record<string, unknown>;
        if (entries.some(([key]) => Object.hasOwn(own, key))) return err('frontmatter-key-exists');
    }
    const lineHas = (line: string, key: string): boolean => new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`).test(line.replace(/\r$/, ''));
    if (body.split('\n').some((l) => entries.some(([key]) => lineHas(l, key)))) return err('frontmatter-key-exists');
    return ok({ text: text.slice(0, region.closerStart) + lines + text.slice(region.closerStart), frontmatterCreated: false });
}
