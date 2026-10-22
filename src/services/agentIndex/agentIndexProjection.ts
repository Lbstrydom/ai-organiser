/**
 * Agent index projection: pure, deterministic, and scope-safe.
 *
 * The index is a JSONL inventory of notes for AI coding agents (Claude Code, Cursor, ...). It
 * carries structure, never body text, and never anything about a note the user excluded:
 *
 *  - Excluded notes do not appear as records or in the header's file list.
 *  - A link to an excluded note becomes `{ "excluded": true }`; the target's path and name are not
 *    written anywhere.
 *  - Links to notes that do not exist are omitted by default (their text could name a sensitive
 *    future note); an opt-in exports the link text.
 *  - Free-text fields (aliases, headings, allow-listed frontmatter keys) are opt-in and come only
 *    from included notes.
 *
 * The same input always produces the same bytes: records are sorted by path and every list is
 * sorted and de-duplicated.
 */

export const AGENT_INDEX_GENERATOR = 'ai-organiser/agent-index';
export const AGENT_INDEX_SCHEMA_VERSION = 1;

/** A link found in a note, with its resolved target (null when the target does not exist). */
export interface RawLink {
    /** Vault path of the target note, or null when it does not resolve */
    target: string | null;
    /** The link text as written (used only when exporting unresolved links is opted in) */
    text: string;
}

/** Everything collected about one note, before the scope rules are applied. */
export interface RawRecord {
    path: string;
    basename: string;
    folder: string;
    tags: string[];
    mtime: number;
    size: number;
    sha256: string;
    links: RawLink[];
    aliases: string[];
    headings: string[];
    /** Frontmatter keys the user allow-listed, already picked (other keys are never collected) */
    frontmatter: Record<string, unknown>;
}

export interface ProjectionScope {
    /** True for notes that may appear in the index */
    isIncluded(path: string): boolean;
    includeAliases: boolean;
    includeHeadings: boolean;
    /** Allow-listed frontmatter keys (the keys already collected are filtered again here) */
    frontmatterKeys: readonly string[];
    exportUnresolvedLinks: boolean;
}

export interface ProjectionHeader {
    generatedAt: string;
    outputPath: string;
    buildId: string;
    scopeHash: string;
    stale: boolean;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedUnique = (items: readonly string[]): string[] => [...new Set(items)].sort(compare);

/** Keep a frontmatter value only if it is a plain scalar or a list of scalars. */
function cleanValue(value: unknown): unknown {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
        const items = value.filter((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean');
        return items.length > 0 ? items : undefined;
    }
    return undefined;
}

/** The note records the index will contain, in output order. */
export function includedRecords(records: readonly RawRecord[], scope: ProjectionScope): RawRecord[] {
    return records.filter((r) => scope.isIncluded(r.path)).sort((a, b) => compare(a.path, b.path));
}

function projectLinks(record: RawRecord, scope: ProjectionScope): unknown[] {
    const seen = new Set<string>();
    const out: { key: string; value: unknown }[] = [];
    for (const link of record.links) {
        let key: string;
        let value: unknown;
        if (link.target === null) {
            if (!scope.exportUnresolvedLinks) continue;
            key = `u:${link.text}`;
            value = { unresolved: link.text };
        } else if (scope.isIncluded(link.target)) {
            key = `p:${link.target}`;
            value = { to: link.target };
        } else {
            key = 'x';
            value = { excluded: true };
        }
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ key, value });
    }
    return out.sort((a, b) => compare(a.key, b.key)).map((o) => o.value);
}

function projectRecord(record: RawRecord, scope: ProjectionScope): Record<string, unknown> {
    const out: Record<string, unknown> = {
        type: 'note',
        path: record.path,
        basename: record.basename,
        folder: record.folder,
        tags: sortedUnique(record.tags),
        mtime: record.mtime,
        size: record.size,
        sha256: record.sha256,
        links: projectLinks(record, scope),
    };
    if (scope.includeAliases) out.aliases = sortedUnique(record.aliases);
    if (scope.includeHeadings) out.headings = record.headings.slice();
    if (scope.frontmatterKeys.length > 0) {
        const fm: Record<string, unknown> = {};
        for (const key of [...scope.frontmatterKeys].sort(compare)) {
            if (!(key in record.frontmatter)) continue;
            const value = cleanValue(record.frontmatter[key]);
            if (value !== undefined) fm[key] = value;
        }
        out.frontmatter = fm;
    }
    return out;
}

/** Build the whole JSONL text: a header line, then one line per included note. */
export function projectIndex(
    records: readonly RawRecord[],
    scope: ProjectionScope,
    header: ProjectionHeader,
): string {
    const included = includedRecords(records, scope);
    const headerLine = {
        type: 'header',
        schemaVersion: AGENT_INDEX_SCHEMA_VERSION,
        generator: AGENT_INDEX_GENERATOR,
        outputPath: header.outputPath,
        buildId: header.buildId,
        generatedAt: header.generatedAt,
        scopeHash: header.scopeHash,
        stale: header.stale,
        files: included.map((r) => ({ path: r.path, mtime: r.mtime, size: r.size, sha256: r.sha256 })),
    };
    return [headerLine, ...included.map((r) => projectRecord(r, scope))].map((l) => JSON.stringify(l)).join('\n') + '\n';
}

/** The signature carried by the first line of every index, temp and previous file. */
export interface IndexSignature {
    generator: string;
    outputPath: string;
    buildId: string;
}

/** Read the signature from a file's first line, or null when it is not one of ours. */
export function parseSignature(firstLine: string): IndexSignature | null {
    try {
        const parsed: unknown = JSON.parse(firstLine);
        if (!parsed || typeof parsed !== 'object') return null;
        const p = parsed as Record<string, unknown>;
        if (p.generator !== AGENT_INDEX_GENERATOR || typeof p.outputPath !== 'string' || typeof p.buildId !== 'string') return null;
        return { generator: p.generator, outputPath: p.outputPath, buildId: p.buildId };
    } catch {
        return null;
    }
}

/** True when `firstLine` is a signature for exactly this output path. */
export function isSignedFor(firstLine: string, outputPath: string): boolean {
    const sig = parseSignature(firstLine);
    return sig !== null && sig.outputPath === outputPath;
}

/** Canonical JSON of everything that decides what the index contains; hashed into `scopeHash`. */
export function canonicalScopeJson(config: {
    includeFolders: readonly string[];
    excludeFolders: readonly string[];
    includeAliases: boolean;
    includeHeadings: boolean;
    frontmatterKeys: readonly string[];
    exportUnresolvedLinks: boolean;
}): string {
    return JSON.stringify({
        includeFolders: sortedUnique(config.includeFolders.map((f) => f.toLowerCase())),
        excludeFolders: sortedUnique(config.excludeFolders.map((f) => f.toLowerCase())),
        includeAliases: config.includeAliases,
        includeHeadings: config.includeHeadings,
        frontmatterKeys: sortedUnique(config.frontmatterKeys),
        exportUnresolvedLinks: config.exportUnresolvedLinks,
    });
}
