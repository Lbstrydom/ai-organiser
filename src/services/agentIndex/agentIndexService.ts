/**
 * Agent index service: collects structure from the vault, projects it with the scope rules, and
 * publishes the result without ever leaving a half-written or foreign file behind.
 *
 * - Snapshot protocol: each note is read once (`cachedRead`); its hash AND every exported field come
 *   from those captured bytes. After collecting, every scoped file is stat-ed again and the scope
 *   revision re-checked; any change triggers a retry (3 attempts), then the index is published with
 *   `stale: true` rather than blocking.
 * - Publication is recoverable: tmp file -> rename current to `.aio-prev` -> rename tmp into place ->
 *   delete prev. Every index, tmp and prev file starts with a signed header naming the exact output
 *   path, and the service acts only on files carrying that signature.
 * - Builds are serialised by an in-memory mutex.
 */
import * as yaml from 'js-yaml';
import type { App, DataAdapter, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { Result, ok, err } from '../../core/result';
import { assertWritable, isInsideOrEqual, normalisePath, resolveProtectedFolders } from '../../core/protectedPaths';
import { logger } from '../../utils/logger';
import { nonBodyLines } from '../../utils/markdownRegions';
import { sha256Hex } from '../attachmentDuplicateService';
import {
    canonicalScopeJson,
    includedRecords,
    isSignedFor,
    projectIndex,
    type ProjectionScope,
    type RawLink,
    type RawRecord,
} from './agentIndexProjection';

// ─── Scope ───────────────────────────────────────────────────────────────────

/** The part of the settings that decides what the index contains. */
export interface IndexScopeConfig {
    includeFolders: readonly string[];
    excludeFolders: readonly string[];
    includeAliases: boolean;
    includeHeadings: boolean;
    frontmatterKeys: readonly string[];
    exportUnresolvedLinks: boolean;
}

export function scopeConfigFromSettings(s: AIOrganiserPlugin['settings']): IndexScopeConfig {
    return {
        includeFolders: s.agentIndexIncludeFolders,
        excludeFolders: s.agentIndexExcludeFolders,
        includeAliases: s.agentIndexIncludeAliases,
        includeHeadings: s.agentIndexIncludeHeadings,
        frontmatterKeys: s.agentIndexFrontmatterKeys,
        exportUnresolvedLinks: s.agentIndexExportUnresolvedLinks,
    };
}

/** True when a note belongs in the index: inside an include folder (or any folder when none is set) and outside every exclude folder. */
export function isInIndexScope(path: string, config: IndexScopeConfig): boolean {
    const norm = normalisePath(path);
    if (norm === '' || norm.startsWith('.')) return false; // hidden / system folders
    if (config.excludeFolders.some((f) => normalisePath(f) !== '' && isInsideOrEqual(norm, f))) return false;
    const includes = config.includeFolders.filter((f) => normalisePath(f) !== '');
    return includes.length === 0 || includes.some((f) => isInsideOrEqual(norm, f));
}

export function projectionScope(config: IndexScopeConfig): ProjectionScope {
    return {
        isIncluded: (path) => isInIndexScope(path, config),
        includeAliases: config.includeAliases,
        includeHeadings: config.includeHeadings,
        frontmatterKeys: config.frontmatterKeys,
        exportUnresolvedLinks: config.exportUnresolvedLinks,
    };
}

export async function scopeHashOf(config: IndexScopeConfig): Promise<string> {
    return sha256Hex(new TextEncoder().encode(canonicalScopeJson(config)).buffer);
}

// ─── Parsing (pure) ───────────────────────────────────────────────────────────

export interface ParsedNote {
    tags: string[];
    aliases: string[];
    headings: string[];
    linkTexts: string[];
    frontmatter: Record<string, unknown>;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/;

function asStringList(value: unknown): string[] {
    if (typeof value === 'string') return value.trim() === '' ? [] : [value.trim()];
    if (Array.isArray(value)) return value.filter((v) => typeof v === 'string' || typeof v === 'number').map((v) => String(v).trim()).filter(Boolean);
    return [];
}

/**
 * Parse one note's text. Pure. Only structure is extracted; frontmatter keys are picked from
 * `wantedKeys` and nothing else is kept.
 */
export function parseNote(text: string, wantedKeys: readonly string[]): ParsedNote {
    let fm: Record<string, unknown> = {};
    const match = FRONTMATTER.exec(text);
    if (match) {
        try {
            const parsed = yaml.load(match[1]);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fm = parsed as Record<string, unknown>;
        } catch {
            fm = {}; // malformed frontmatter: treat as none
        }
    }
    const tags = new Set<string>();
    for (const t of asStringList(fm.tags)) tags.add(t.replace(/^#/, ''));
    const aliases = [...asStringList(fm.aliases), ...asStringList(fm.alias)];

    const lines = text.split('\n');
    const skip = nonBodyLines(lines);
    const headings: string[] = [];
    const linkTexts: string[] = [];
    lines.forEach((line, i) => {
        if (skip[i]) return;
        const h = /^(#{1,2})\s+(.+?)\s*#*\s*$/.exec(line);
        if (h) headings.push(h[2].trim());
        const visible = line.replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, '');
        for (const m of visible.matchAll(/(?:^|\s)#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu)) tags.add(m[1]);
        for (const m of visible.matchAll(/(?<!!)\[\[([^\]]+)\]\]/g)) linkTexts.push(m[1].split('|')[0].split('#')[0].trim());
        for (const m of visible.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+\.md)(?:#[^)]*)?\)/g)) {
            try { linkTexts.push(decodeURIComponent(m[1])); } catch { linkTexts.push(m[1]); }
        }
    });

    const frontmatter: Record<string, unknown> = {};
    for (const key of wantedKeys) if (key in fm) frontmatter[key] = fm[key];
    return { tags: [...tags], aliases, headings, linkTexts: linkTexts.filter(Boolean), frontmatter };
}

// ─── Collection ──────────────────────────────────────────────────────────────

const utf8 = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer;

/** Read each scoped note once and build its raw record. Notes that cannot be read are skipped and counted. */
export async function collectRecords(
    app: App,
    files: readonly TFile[],
    config: IndexScopeConfig,
    signal?: AbortSignal,
): Promise<{ records: RawRecord[]; unreadable: number }> {
    const records: RawRecord[] = [];
    let unreadable = 0;
    for (const file of files) {
        if (signal?.aborted) break;
        let text: string;
        const mtimeBefore = file.stat.mtime;
        try {
            text = await app.vault.cachedRead(file);
        } catch {
            unreadable++;
            continue;
        }
        const parsed = parseNote(text, config.frontmatterKeys);
        const links: RawLink[] = parsed.linkTexts.map((linkText) => {
            const target = app.metadataCache.getFirstLinkpathDest(linkText, file.path);
            return { target: target && target.extension === 'md' ? target.path : null, text: linkText };
        });
        records.push({
            path: file.path,
            basename: file.basename,
            folder: file.parent?.path === '/' ? '' : (file.parent?.path ?? ''),
            tags: parsed.tags,
            mtime: file.stat.mtime === mtimeBefore ? mtimeBefore : -1,
            size: file.stat.size,
            sha256: await sha256Hex(utf8(text)),
            links,
            aliases: parsed.aliases,
            headings: parsed.headings,
            frontmatter: parsed.frontmatter,
        });
    }
    return { records, unreadable };
}

function scopedFiles(app: App, config: IndexScopeConfig): TFile[] {
    return app.vault.getMarkdownFiles().filter((f) => isInIndexScope(f.path, config)).sort((a, b) => (a.path < b.path ? -1 : 1));
}

function fingerprint(files: readonly TFile[]): string {
    return files.map((f) => `${f.path}\u0000${f.stat.mtime}\u0000${f.stat.size}`).join('\u0001');
}

// ─── Publication ─────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 3;

let buildChain: Promise<unknown> = Promise.resolve();
/** Builds never overlap: each waits for the previous one. */
function serialised<T>(job: () => Promise<T>): Promise<T> {
    const run = buildChain.then(job);
    buildChain = run.catch(() => undefined);
    return run;
}

async function firstLine(adapter: DataAdapter, path: string): Promise<string | null> {
    try {
        const text = await adapter.read(path);
        const i = text.indexOf('\n');
        return i === -1 ? text : text.slice(0, i);
    } catch {
        return null;
    }
}

async function ensureFolder(adapter: DataAdapter, folder: string): Promise<void> {
    if (!folder) return;
    let current = '';
    for (const part of folder.split('/')) {
        current = current ? `${current}/${part}` : part;
        if (!(await adapter.exists(current))) await adapter.mkdir(current);
    }
}

export interface OutputPlan {
    path: string;
    folder: string;
    prev: string;
    tmpPrefix: string;
}

/** Validate the output path against the vault and the protected folders. */
export function planOutput(rawPath: string, protectedFolders: readonly string[]): Result<OutputPlan> {
    const raw = rawPath.trim();
    // Only a relative vault path is accepted: no drive letters, no leading slash, no `..` segments.
    if (raw === '' || /^([a-zA-Z]:|[\\/])/.test(raw) || raw.split(/[\\/]/).includes('..')) return err('output-path-invalid');
    const path = normalisePath(raw);
    if (path === '' || !path.toLowerCase().endsWith('.jsonl')) return err('output-path-invalid');
    if (resolveProtectedFolders(protectedFolders).length > 0) {
        for (const candidate of [path, `${path}.aio-prev`, `${path}.aio-x.tmp`]) {
            if (!assertWritable(protectedFolders, 'create', candidate).ok) return err('protected-path');
        }
    }
    const slash = path.lastIndexOf('/');
    return ok({ path, folder: slash === -1 ? '' : path.slice(0, slash), prev: `${path}.aio-prev`, tmpPrefix: `${path}.aio-` });
}

/**
 * Put the output location back into a consistent state. Acts only on files signed for this exact
 * path; anything else is left alone and reported. Returns the paths it did not recognise.
 */
export async function recoverPublication(adapter: DataAdapter, plan: OutputPlan, runningBuildId?: string): Promise<{ unrecognised: string[] }> {
    const unrecognised: string[] = [];
    // A folder that does not exist yet has nothing to recover; a listing that fails on an existing
    // folder must not read as "empty", or a foreign file could be missed.
    const folderListing = !plan.folder || (await adapter.exists(plan.folder))
        ? await adapter.list(plan.folder || '/')
        : { files: [] as string[], folders: [] as string[] };
    const siblings = folderListing.files.filter((f) => f.startsWith(plan.tmpPrefix) || f === plan.prev);

    const currentLine = (await adapter.exists(plan.path)) ? await firstLine(adapter, plan.path) : null;
    const currentSigned = currentLine !== null && isSignedFor(currentLine, plan.path);

    for (const file of siblings) {
        const line = await firstLine(adapter, file);
        if (line === null || !isSignedFor(line, plan.path)) {
            unrecognised.push(file);
            continue;
        }
        if (file === plan.prev) {
            if (!(await adapter.exists(plan.path))) {
                await adapter.rename(plan.prev, plan.path); // the build died between the two renames
            } else if (currentSigned) {
                await adapter.remove(plan.prev); // both exist and are ours: the previous one is spent
            }
            continue;
        }
        // A signed temp file from a build that is not running.
        const buildId = file.slice(plan.tmpPrefix.length).replace(/\.tmp$/, '');
        if (buildId !== runningBuildId) await adapter.remove(file);
    }
    return { unrecognised };
}

async function publish(adapter: DataAdapter, plan: OutputPlan, content: string, buildId: string): Promise<Result<void>> {
    const recovered = await recoverPublication(adapter, plan);
    if (recovered.unrecognised.length > 0) return err('output-has-foreign-files');
    if (await adapter.exists(plan.path)) {
        const line = await firstLine(adapter, plan.path);
        if (line === null || !isSignedFor(line, plan.path)) return err('output-not-ours');
    }
    await ensureFolder(adapter, plan.folder);
    const tmp = `${plan.tmpPrefix}${buildId}.tmp`;
    await adapter.write(tmp, content);
    const hadCurrent = await adapter.exists(plan.path);
    try {
        if (hadCurrent) await adapter.rename(plan.path, plan.prev);
        await adapter.rename(tmp, plan.path);
    } catch (e) {
        // Put the previous index back; never leave the location without one.
        try {
            if (hadCurrent && !(await adapter.exists(plan.path)) && (await adapter.exists(plan.prev))) await adapter.rename(plan.prev, plan.path);
            if (await adapter.exists(tmp)) await adapter.remove(tmp);
        } catch {
            // recovery on the next build handles whatever is left
        }
        logger.error('AgentIndex', 'Publishing failed', e);
        return err('write-failed');
    }
    if (hadCurrent) {
        try { await adapter.remove(plan.prev); } catch { /* recovered next time */ }
    }
    return ok(undefined);
}

// ─── Build / check ───────────────────────────────────────────────────────────

export interface BuildSummary {
    path: string;
    notes: number;
    excluded: number;
    stale: boolean;
    unreadable: number;
}

function newBuildId(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Build and publish the index. Never throws. */
export function buildAgentIndex(plugin: AIOrganiserPlugin): Promise<Result<BuildSummary>> {
    return serialised(async () => {
        try {
            const app = plugin.app;
            const snapshot = () => {
                const s = plugin.settings;
                const config = scopeConfigFromSettings(s);
                return {
                    planned: planOutput(s.agentIndexOutputPath, s.protectedFolders),
                    config,
                    key: JSON.stringify([s.agentIndexOutputPath, s.protectedFolders, canonicalScopeJson(config)]),
                };
            };
            const plans = new Map<string, OutputPlan>();
            let snap = snapshot();
            if (!snap.planned.ok) return err(snap.planned.error);

            let records: RawRecord[] = [];
            let unreadable = 0;
            let stale = true;
            for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
                snap = snapshot();
                if (!snap.planned.ok) return err(snap.planned.error);
                plans.set(snap.key, snap.planned.value);
                const files = scopedFiles(app, snap.config);
                const before = fingerprint(files);
                const collected = await collectRecords(app, files, snap.config);
                records = collected.records;
                unreadable = collected.unreadable;
                if (snapshot().key === snap.key && fingerprint(scopedFiles(app, snap.config)) === before) { stale = false; break; }
            }
            if (unreadable > 0) stale = true;
            // Settings that moved during the build mean the content was made for a policy that is gone.
            if (snapshot().key !== snap.key) return err('baseline-changed');
            const plan = plans.get(snap.key);
            if (!plan) return err('output-path-invalid');
            const config = snap.config;

            const buildId = newBuildId();
            const content = projectIndex(records, projectionScope(config), {
                generatedAt: new Date().toISOString(),
                outputPath: plan.path,
                buildId,
                scopeHash: await scopeHashOf(config),
                stale,
            });
            if (snapshot().key !== snap.key) return err('baseline-changed');
            const published = await publish(app.vault.adapter, plan, content, buildId);
            if (!published.ok) return err(published.error);
            const total = app.vault.getMarkdownFiles().length;
            return ok({
                path: plan.path,
                notes: includedRecords(records, projectionScope(config)).length,
                excluded: Math.max(0, total - records.length - unreadable),
                stale,
                unreadable,
            });
        } catch (e) {
            logger.error('AgentIndex', 'Build failed', e);
            return err('write-failed');
        }
    });
}

export interface CheckReport {
    added: string[];
    removed: string[];
    changed: string[];
    fresh: boolean;
    scopeChanged: boolean;
    missing: boolean;
    /** Notes that could not be read; the check cannot vouch for them */
    unreadable: number;
    /** The vault changed while the check was reading it */
    unstable: boolean;
}

interface HeaderFile { path: string; mtime: number; size: number; sha256: string }

/** Compare the published index with the vault right now. Authoritative: re-hashes every scoped note. */
export async function checkAgentIndex(plugin: AIOrganiserPlugin, options: { signal?: AbortSignal } = {}): Promise<Result<CheckReport>> {
    try {
        if (options.signal?.aborted) return err('cancelled');
        const planned = planOutput(plugin.settings.agentIndexOutputPath, plugin.settings.protectedFolders);
        if (!planned.ok) return err(planned.error);
        const adapter = plugin.app.vault.adapter;
        if (!(await adapter.exists(planned.value.path))) {
            return ok({ added: [], removed: [], changed: [], fresh: false, scopeChanged: false, missing: true, unreadable: 0, unstable: false });
        }
        const text = await adapter.read(planned.value.path);
        const newline = text.indexOf('\n');
        const headerLine = newline === -1 ? text : text.slice(0, newline);
        if (!isSignedFor(headerLine, planned.value.path)) return err('output-not-ours');
        const header = JSON.parse(headerLine) as { scopeHash?: string; files?: HeaderFile[] };
        const config = scopeConfigFromSettings(plugin.settings);
        const files = scopedFiles(plugin.app, config);
        const before = fingerprint(files);
        const { records, unreadable } = await collectRecords(plugin.app, files, config, options.signal);
        if (options.signal?.aborted) return err('cancelled');
        const unstable = fingerprint(scopedFiles(plugin.app, config)) !== before;
        const indexed = new Map((header.files ?? []).map((f) => [f.path, f]));
        const now = new Map(records.map((r) => [r.path, r]));
        const added = [...now.keys()].filter((p) => !indexed.has(p)).sort();
        const removed = [...indexed.keys()].filter((p) => !now.has(p)).sort();
        const changed = [...now.keys()].filter((p) => indexed.has(p) && indexed.get(p)!.sha256 !== now.get(p)!.sha256).sort();
        const scopeChanged = header.scopeHash !== (await scopeHashOf(config));
        return ok({ added, removed, changed, fresh: !unstable && unreadable === 0 && !scopeChanged && !added.length && !removed.length && !changed.length, scopeChanged, missing: false, unreadable, unstable });
    } catch (e) {
        logger.error('AgentIndex', 'Check failed', e);
        return err('scan-incomplete');
    }
}
