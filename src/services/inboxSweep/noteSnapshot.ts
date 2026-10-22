/**
 * A note as captured for the inbox sweep: read once, with its tags and properties parsed from the
 * SAME bytes (never from the metadata cache, which can be ahead of or behind the file). The guard
 * judges this snapshot; the prompt is built only from what the guard let through.
 */
import * as yaml from 'js-yaml';
import { sha256Hex } from '../attachmentDuplicateService';

export interface NoteSnapshot {
    path: string;
    text: string;
    contentHash: string;
    /** Lower-case tags without `#`, from frontmatter and inline */
    tags: string[];
    /** Frontmatter properties flattened to `key -> [string values]` (lower-case key) */
    properties: Record<string, string[]>;
    /** Hash of the exclusion settings and protected folders this snapshot was judged against */
    policyRevision: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/;

function flatten(value: unknown): string[] {
    if (value === null || value === undefined) return [];
    if (Array.isArray(value)) return value.flatMap(flatten);
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? [String(value)] : [];
}

export function normaliseTag(tag: string): string {
    return tag.trim().replace(/^#/, '').toLowerCase();
}

/** Parse tags and properties out of note text. Pure; malformed frontmatter yields none (and the guard treats the note as readable). */
export function parseSnapshotMetadata(text: string): { tags: string[]; properties: Record<string, string[]>; frontmatterOk: boolean } {
    const tags = new Set<string>();
    const properties: Record<string, string[]> = {};
    let frontmatterOk = true;
    const match = FRONTMATTER.exec(text);
    let body = text;
    if (match) {
        body = text.slice(match[0].length);
        try {
            const parsed = yaml.load(match[1]);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
                    const values = flatten(value);
                    properties[key.toLowerCase()] = values;
                    if (key.toLowerCase() === 'tags' || key.toLowerCase() === 'tag') for (const v of values) for (const part of v.split(/[\s,]+/)) if (part) tags.add(normaliseTag(part));
                }
            } else if (parsed !== undefined && parsed !== null) {
                frontmatterOk = false;
            }
        } catch {
            frontmatterOk = false;
        }
    }
    for (const m of body.matchAll(/(?:^|\s)#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu)) tags.add(normaliseTag(m[1]));
    return { tags: [...tags], properties, frontmatterOk };
}

/** Build a snapshot from text that was read once. */
export async function buildSnapshot(path: string, text: string, policyRevision: string): Promise<NoteSnapshot> {
    const meta = parseSnapshotMetadata(text);
    return {
        path,
        text,
        contentHash: await sha256Hex(new TextEncoder().encode(text).buffer),
        tags: meta.tags,
        properties: meta.properties,
        policyRevision,
    };
}
