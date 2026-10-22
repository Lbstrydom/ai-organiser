/**
 * Cloud inventory service: pairs, connection test, hub notes and refreshes.
 *
 * A hub note is plain Markdown the user owns. The plugin writes only the generated block between
 * its markers, idempotently: the block is re-rendered on every refresh and the note is written only
 * when the rendered block differs from the one in the note (so a hand-edited row is restored even
 * when Drive did not change). A failed or conflicting refresh leaves the note exactly as it was.
 */
import { TFile } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { Result, ok, err } from '../../core/result';
import { assertWritable, normalisePath } from '../../core/protectedPaths';
import { evaluateScriptCompat } from '../../core/setupState';
import type { CloudInventoryPair, CloudInventoryTestResult } from '../../core/settings';
import { logger } from '../../utils/logger';
import { applyNoteEdit } from '../noteEdit/applyNoteEdit';
import { sha256Hex } from '../attachmentDuplicateService';
import { callScript } from '../appsScriptClient';
import { listDriveTree, type ListPage, type TreeListing } from './driveListClient';
import {
    INVENTORY_SCRIPT_MIN_SUPPORTED,
    INVENTORY_SCRIPT_VERSION,
    rootsHashOf,
} from './scriptTemplate';
import {
    canonicalListing,
    findOwnedBlock,
    parseBlockMeta,
    renderBlock,
    replaceBlock,
    type BlockMeta,
    type InventoryListing,
    type RenderLabels,
} from './inventoryBlock';

// ─── Configuration identity ──────────────────────────────────────────────────

/** A stable string that changes whenever the script link or any approved folder changes. */
export function inventoryConfigKey(url: string, pairs: readonly CloudInventoryPair[]): string {
    return JSON.stringify({ url: url.trim(), roots: [...new Set(pairs.map((p) => p.driveFolderId))].sort() });
}

export function approvedRoots(pairs: readonly CloudInventoryPair[]): string[] {
    return [...new Set(pairs.map((p) => p.driveFolderId))];
}

// ─── Hub note placement ──────────────────────────────────────────────────────

function lastSegment(path: string): string {
    const norm = normalisePath(path);
    return norm.slice(norm.lastIndexOf('/') + 1);
}

function parentOf(path: string): string {
    const norm = normalisePath(path);
    const i = norm.lastIndexOf('/');
    return i === -1 ? '' : norm.slice(0, i);
}

const sanitizeName = (name: string): string => name.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Where the hub note goes. `beside` (default) puts it in the parent folder, `inside` in the folder.
 * A protected target folder forces `beside`; the vault root forces `inside`. If the final location
 * is still protected the pair is invalid (`protected-path`).
 */
export function hubNotePath(pair: CloudInventoryPair, protectedFolders: readonly string[]): Result<string> {
    const folder = normalisePath(pair.vaultFolder);
    const title = sanitizeName(pair.label || lastSegment(folder) || 'Vault') || 'Vault';
    const fileName = `${title} — Drive.md`;
    let placement = pair.placement;
    if (folder === '') placement = 'inside';
    else if (!assertWritable(protectedFolders, 'create', `${folder}/${fileName}`).ok) placement = 'beside';
    const dir = placement === 'beside' ? parentOf(folder) : folder;
    const path = dir ? `${dir}/${fileName}` : fileName;
    return assertWritable(protectedFolders, 'create', path).ok ? ok(path) : err('protected-path');
}

// ─── Block building ──────────────────────────────────────────────────────────

export async function contentHashOf(listing: InventoryListing): Promise<string> {
    return sha256Hex(new TextEncoder().encode(canonicalListing(listing)).buffer);
}

/** Render the block for a listing, keeping the existing `listed` time when the content is unchanged. */
export async function buildBlock(opts: {
    pair: CloudInventoryPair;
    listing: InventoryListing;
    existing: BlockMeta | null;
    nowIso: string;
    labels: RenderLabels;
}): Promise<string> {
    const hash = await contentHashOf(opts.listing);
    const meta: BlockMeta = {
        hash,
        status: opts.listing.completeness,
        listed: opts.existing && opts.existing.hash === hash ? opts.existing.listed : opts.nowIso,
    };
    return renderBlock({ pairId: opts.pair.id, folderId: opts.pair.driveFolderId, listing: opts.listing, meta, labels: opts.labels });
}

export function renderLabels(t: AIOrganiserPlugin['t']): RenderLabels {
    const c = t.cloudInventory;
    return {
        notice: c.blockNotice,
        truncated: c.blockTruncated,
        name: c.columnName,
        type: c.columnType,
        size: c.columnSize,
        modified: c.columnModified,
        empty: c.blockEmpty,
    };
}

// ─── Connection ──────────────────────────────────────────────────────────────

export interface ConnectionReport {
    scriptVersion: number;
    rootsHash: string;
    folderName: string | null;
}

/** Ping the script. Maps version and roots mismatches to the same codes the wizard shows. */
export async function testConnection(opts: {
    url: string;
    secret: string;
    roots: readonly string[];
    folderId?: string;
    transport?: Parameters<typeof callScript>[0]['transport'];
}): Promise<Result<ConnectionReport>> {
    const res = await callScript<{ scriptVersion?: number; rootsHash?: string; folder?: { name?: string } | null }>({
        url: opts.url,
        secret: opts.secret,
        body: { op: 'ping', folderId: opts.folderId ?? null },
        transport: opts.transport,
        maxAttempts: 2,
    });
    if (!res.ok) return err(res.error);
    const report = {
        scriptVersion: typeof res.value.scriptVersion === 'number' ? res.value.scriptVersion : 0,
        rootsHash: typeof res.value.rootsHash === 'string' ? res.value.rootsHash : '',
    };
    const compat = evaluateScriptCompat({ scriptVersion: report.scriptVersion, configHash: report.rootsHash }, {
        minSupported: INVENTORY_SCRIPT_MIN_SUPPORTED,
        current: INVENTORY_SCRIPT_VERSION,
        configHash: await rootsHashOf(opts.roots),
    });
    if (compat === 'incompatible' || compat === 'config-mismatch') return err('script-outdated');
    if (opts.folderId && !res.value.folder) return err('script-not-approved');
    return ok({ ...report, folderName: res.value.folder?.name ?? null });
}

/** Record a test result against the configuration it tested. */
export function toTestResult(configKey: string, report: ConnectionReport | null, nowIso: string): CloudInventoryTestResult {
    return report
        ? { ok: true, configHash: configKey, at: nowIso, scriptVersion: report.scriptVersion, rootsHash: report.rootsHash }
        : { ok: false, configHash: configKey, at: nowIso };
}

const isText = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** Decode one `list` answer. A missing or mistyped collection is a bad response, never an empty folder. */
export function decodeListPage(value: unknown): Result<ListPage> {
    const body = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
    const { files, folders, nextPageToken } = body;
    if (!Array.isArray(files) || !Array.isArray(folders)) return err('script-bad-response');
    if (nextPageToken !== undefined && nextPageToken !== null && !isText(nextPageToken)) return err('script-bad-response');
    const outFiles: ListPage['files'] = [];
    for (const raw of files) {
        const f = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
        if (!isText(f.id) || typeof f.name !== 'string' || typeof f.mimeType !== 'string') return err('script-bad-response');
        outFiles.push({
            id: f.id,
            name: f.name,
            mimeType: f.mimeType,
            size: typeof f.size === 'number' || typeof f.size === 'string' ? f.size : undefined,
            modifiedTime: typeof f.modifiedTime === 'string' ? f.modifiedTime : undefined,
            md5Checksum: typeof f.md5Checksum === 'string' ? f.md5Checksum : undefined,
            sha256Checksum: typeof f.sha256Checksum === 'string' ? f.sha256Checksum : undefined,
        });
    }
    const outFolders: ListPage['folders'] = [];
    for (const raw of folders) {
        const f = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
        if (!isText(f.id) || typeof f.name !== 'string') return err('script-bad-response');
        outFolders.push({ id: f.id, name: f.name });
    }
    return ok({ files: outFiles, folders: outFolders, nextPageToken: isText(nextPageToken) ? nextPageToken : null });
}

export function makeFetchPage(url: string, secret: string, signal?: AbortSignal) {
    return async (folderId: string, pageToken: string | null): Promise<Result<ListPage>> => {
        const res = await callScript<unknown>({
            url,
            secret,
            body: { op: 'list', folderId, pageToken },
            signal,
        });
        if (!res.ok) return err(res.error);
        return decodeListPage(res.value);
    };
}

// ─── Refresh ─────────────────────────────────────────────────────────────────

export type RefreshState = 'created' | 'updated' | 'unchanged' | 'declined';

export interface RefreshOutcome {
    pairId: string;
    path: string;
    state: RefreshState;
    status: TreeListing['status'];
}

export interface RefreshDeps {
    list: (pair: CloudInventoryPair) => Promise<TreeListing>;
    /** Asked when the hub note exists but has no block for this pair yet */
    confirmAppend?: (path: string) => Promise<boolean>;
    now?: () => Date;
}

/** Decide what the hub note should contain, without writing. */
export async function planPair(
    plugin: AIOrganiserPlugin,
    pair: CloudInventoryPair,
    listing: TreeListing,
    nowIso: string,
): Promise<Result<{ path: string; next: string | null; current: string | null; block: string }>> {
    const pathRes = hubNotePath(pair, plugin.settings.protectedFolders);
    if (!pathRes.ok) return err(pathRes.error);
    const path = pathRes.value;
    const file = plugin.app.vault.getAbstractFileByPath(path);
    const current = file instanceof TFile ? await plugin.app.vault.read(file) : null;
    const found = current === null ? ok(null) : findOwnedBlock(current, pair.id, pair.driveFolderId);
    if (!found.ok) return err(found.error);
    const block = await buildBlock({
        pair,
        listing: { files: listing.files, completeness: listing.status === 'truncated' ? 'truncated' : 'complete' },
        existing: found.value ? parseBlockMeta(found.value.text) : null,
        nowIso,
        labels: renderLabels(plugin.t),
    });
    const base = current ?? `# ${sanitizeName(pair.label || lastSegment(normalisePath(pair.vaultFolder)) || 'Drive')}\n`;
    const next = replaceBlock(base, block, pair.id, pair.driveFolderId);
    if (!next.ok) return err(next.error);
    return ok({ path, next: next.value, current, block });
}

/**
 * Refresh one pair. A `failed` listing writes nothing; a `truncated` one is published with its
 * status shown; a marker conflict writes nothing and names the note through the error.
 */
export async function refreshPair(plugin: AIOrganiserPlugin, pair: CloudInventoryPair, deps: RefreshDeps): Promise<Result<RefreshOutcome>> {
    try {
        const listing = await deps.list(pair);
        if (listing.status === 'failed') return err(listing.error ?? 'script-drive-error');
        const planned = await planPair(plugin, pair, listing, (deps.now?.() ?? new Date()).toISOString());
        if (!planned.ok) return err(planned.error);
        const { path, next, current } = planned.value;
        if (next === null) return err('write-failed');
        const base: RefreshOutcome = { pairId: pair.id, path, state: 'unchanged', status: listing.status };

        if (current === null) {
            if (!assertWritable(plugin.settings.protectedFolders, 'create', path).ok) return err('protected-path');
            const slash = path.lastIndexOf('/');
            if (slash > 0 && !plugin.app.vault.getAbstractFileByPath(path.slice(0, slash))) {
                await plugin.app.vault.createFolder(path.slice(0, slash));
            }
            await plugin.app.vault.create(path, next);
            return ok({ ...base, state: 'created' });
        }
        if (next === current) return ok(base); // byte-identical: nothing to write

        const hasBlock = findOwnedBlock(current, pair.id, pair.driveFolderId);
        let appendAgreed = false;
        if (hasBlock.ok && hasBlock.value === null) {
            appendAgreed = deps.confirmAppend ? await deps.confirmAppend(path) : false;
            if (!appendAgreed) return ok({ ...base, state: 'declined' });
        }
        const written = await applyNoteEdit(plugin, {
            kind: 'composite',
            filePath: path,
            baseline: current,
            recompute: (latest) => {
                // The note may have changed while the user was asked: consent covers appending a
                // block to the note they saw, and a block that now exists or vanished is a new case.
                const now = findOwnedBlock(latest, pair.id, pair.driveFolderId);
                if (!now.ok) return err(now.error);
                if ((now.value === null) !== appendAgreed) return err('baseline-changed');
                const replaced = replaceBlock(latest, planned.value.block, pair.id, pair.driveFolderId);
                return replaced.ok ? ok({ content: replaced.value }) : err(replaced.error);
            },
        }, { review: false });
        if (!written.ok) return err(written.error);
        return ok({ ...base, state: 'updated' });
    } catch (e) {
        logger.error('CloudInventory', 'Refresh failed', e);
        return err('write-failed');
    }
}

export interface CheckOutcome {
    pairId: string;
    path: string;
    changed: boolean;
    status: TreeListing['status'];
}

/** Compare Drive with the note without writing anything. */
export async function checkPair(plugin: AIOrganiserPlugin, pair: CloudInventoryPair, deps: RefreshDeps): Promise<Result<CheckOutcome>> {
    try {
        const listing = await deps.list(pair);
        if (listing.status === 'failed') return err(listing.error ?? 'script-drive-error');
        const planned = await planPair(plugin, pair, listing, (deps.now?.() ?? new Date()).toISOString());
        if (!planned.ok) return err(planned.error);
        return ok({ pairId: pair.id, path: planned.value.path, changed: planned.value.next !== planned.value.current, status: listing.status });
    } catch (e) {
        logger.error('CloudInventory', 'Check failed', e);
        return err('script-network');
    }
}

/** Build the live listing function from the settings and the stored secret. */
export function makeLister(plugin: AIOrganiserPlugin, secret: string, signal?: AbortSignal): RefreshDeps['list'] {
    const s = plugin.settings;
    return (pair) =>
        listDriveTree({
            rootFolderId: pair.driveFolderId,
            fetchPage: makeFetchPage(s.cloudInventoryScriptUrl, secret, signal),
            limits: { maxFolders: s.cloudInventoryMaxFolders, maxFiles: s.cloudInventoryMaxFiles, deadlineMs: s.cloudInventoryDeadlineMinutes * 60_000 },
            signal,
        });
}
