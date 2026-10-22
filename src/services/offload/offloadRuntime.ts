/**
 * Offload runtime: connects the (pure, tested) offload service to a live Obsidian vault.
 *
 * Desktop only. Nothing here decides policy: it reads the vault, builds the copy plan from typed
 * occurrences, and hands the service the ports it needs (note writes through `applyNoteEdit`,
 * canvas writes through the canvas write port, the trash through Obsidian's file manager).
 */
import { FileSystemAdapter, Platform, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { Result, ok, err } from '../../core/result';
import { PLUGIN_SECRET_IDS } from '../../core/secretIds';
import { assertWritable } from '../../core/protectedPaths';
import { isFeatureEnabled } from '../featureService';
import { applyNoteEdit } from '../noteEdit/applyNoteEdit';
import { rewriteCanvasNodes } from '../canvas/canvasWritePort';
import { createAppVaultPort, revalidate, EMPTY_CHANGES, type AttachmentVaultPort } from '../attachmentEligibility';
import { validateScriptUrl } from '../appsScriptClient';
import { makeFetchPage } from '../cloudInventory/cloudInventoryService';
import type { CloudInventoryPair } from '../../core/settings';
import { logger } from '../../utils/logger';
import { nodeDeps, streamFingerprinter, type NodeDeps } from './fingerprint';
import { JournalStore, newRecord, type OffloadRecord } from './offloadJournal';
import { buildCopyPlan, offloadablePairs, type PlannedReferrer } from './offloadPlan';
import { findOccurrences, type Occurrence, type ScanTarget } from './referenceOccurrences';
import type { OffloadDeps, RemoteListFile } from './offloadService';

/** Where the journal lives: the plugin's own folder. */
export function journalPath(plugin: AIOrganiserPlugin): string {
    return `${plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`}/offload-journal.json`;
}

/**
 * One store per adapter and path: the store serialises its read-modify-write cycles, so every caller
 * has to share the same instance for two operations never to overwrite each other's update.
 */
const stores = new WeakMap<object, Map<string, JournalStore>>();

export function journalStore(plugin: AIOrganiserPlugin): JournalStore {
    const adapter = plugin.app.vault.adapter;
    const path = journalPath(plugin);
    let byPath = stores.get(adapter);
    if (!byPath) { byPath = new Map(); stores.set(adapter, byPath); }
    let store = byPath.get(path);
    if (!store) { store = new JournalStore(adapter, path); byPath.set(path, store); }
    return store;
}

/** True when offload can be offered at all: feature on, desktop, Node available, and a local Drive folder is set. */
export function isOffloadAvailable(plugin: AIOrganiserPlugin): boolean {
    return Platform.isDesktopApp
        && isFeatureEnabled(plugin.settings, 'cloud-offload')
        && offloadablePairs(plugin.settings.cloudInventoryPairs).length > 0
        && nodeDeps() !== null;
}

export function basePath(plugin: AIOrganiserPlugin): string | null {
    const adapter = plugin.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
}

/** One-folder listing through the user's own Apps Script (shared client, secret from the secret store). */
async function listFolder(plugin: AIOrganiserPlugin, folderId: string): Promise<Result<RemoteListFile[]>> {
    const url = validateScriptUrl(plugin.settings.cloudInventoryScriptUrl);
    if (!url.ok) return err(url.error);
    let secret: string | null = null;
    try {
        secret = await plugin.secretStorageService.getSecret(PLUGIN_SECRET_IDS.CLOUD_INVENTORY);
    } catch {
        secret = null;
    }
    if (!secret) return err('no-secret');
    const fetchPage = makeFetchPage(url.value, secret);
    const out: RemoteListFile[] = [];
    let token: string | null = null;
    for (let page = 0; page < 100; page++) {
        const res = await fetchPage(folderId, token);
        if (!res.ok) return err(res.error);
        for (const f of res.value.files) {
            const size = f.size === undefined ? null : Number(f.size);
            out.push({ id: f.id, name: f.name, size: size !== null && Number.isFinite(size) ? size : null, sha256Checksum: f.sha256Checksum });
        }
        token = res.value.nextPageToken;
        if (!token) return ok(out);
    }
    return err('script-bad-response'); // a listing this long without an end is not trusted
}

/** The ports the offload service needs, over the live vault. Null when Node is unavailable. */
export function createOffloadDeps(plugin: AIOrganiserPlugin, options: { signal?: AbortSignal; onProgress?: (bytes: number) => void } = {}): OffloadDeps | null {
    const node: NodeDeps | null = nodeDeps();
    const base = basePath(plugin);
    if (!node || !base) return null;
    const app = plugin.app;
    const settings = plugin.settings;
    return {
        now: () => new Date().toISOString(),
        node,
        fingerprint: streamFingerprinter(node),
        store: journalStore(plugin),
        vaultBasePath: base,
        protectedFolders: () => plugin.settings.protectedFolders,
        mountRoot: (pairId) => settings.cloudInventoryPairs.find((p) => p.id === pairId)?.localMountFolder?.trim() || undefined,
        readText: async (path) => {
            const file = app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) return null;
            try {
                return await app.vault.read(file);
            } catch {
                return null;
            }
        },
        exists: (path) => app.vault.getAbstractFileByPath(path) instanceof TFile,
        writeMarkdown: async (path, baseline, next) => {
            const res = await applyNoteEdit(plugin, { kind: 'full-replace', filePath: path, baseline, nextContent: next }, { review: false });
            return res.ok ? ok(undefined) : err(res.error);
        },
        writeCanvas: (path, nodeIds, url, baseline) => {
            const url2 = url;
            return rewriteCanvasNodes(app, path, nodeIds.map((nodeId) => ({ nodeId, url: url2 })), baseline, plugin.settings.protectedFolders);
        },
        trash: async (path, expected) => {
            const allowed = assertWritable(plugin.settings.protectedFolders, 'delete', path);
            if (!allowed.ok) return err(allowed.error);
            const file = app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) return err('target-missing');
            // The deletion boundary re-checks the identity the barrier verified.
            if (file.stat.size !== expected.size) return err('file-changed');
            try {
                await app.fileManager.trashFile(file);
                return ok(undefined);
            } catch (e) {
                logger.error('Offload', 'Trash failed', e);
                return err('trash-failed');
            }
        },
        listFolder: (folderId) => listFolder(plugin, folderId),
        scanReferences: async (sourcePath) => {
            const file = app.vault.getAbstractFileByPath(sourcePath);
            if (!(file instanceof TFile)) return err('target-missing');
            const identity = { path: file.path, size: file.stat.size, mtime: file.stat.mtime };
            const res = await revalidate(createAppVaultPort(app), {
                files: [identity],
                scanStartedAt: Date.now(),
                occurrences: [],
                changes: EMPTY_CHANGES,
                protectedFolders: [],
            });
            if (!res.ok) return ok({ remaining: 0, coverageFailures: 1 });
            const e = res.value.get(sourcePath);
            if (!e) return ok({ remaining: 0, coverageFailures: 1 });
            const unreadable = e.reasons.includes('canvas-unreadable') || e.reasons.includes('scan-incomplete');
            return ok({ remaining: e.referenceCount + (e.reasons.includes('ambiguous-reference') ? 1 : 0), coverageFailures: unreadable ? 1 : 0 });
        },
        watch: () => {
            let events = 0;
            const count = (path: string): void => { if (!path.startsWith('.')) events++; };
            const refs = [
                app.vault.on('create', (f) => count(f.path)),
                app.vault.on('modify', (f) => count(f.path)),
                app.vault.on('delete', (f) => count(f.path)),
                app.vault.on('rename', (f, old) => { count(f.path); count(old); }),
            ];
            return { stop: () => { for (const r of refs) app.vault.offref(r); return events; } };
        },
        options: { signal: options.signal, onProgress: options.onProgress },
    };
}

function newOpId(): string {
    return `op${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export interface OffloadPreview {
    record: OffloadRecord;
    /** Referrers with at least one occurrence, for the plan modal */
    referrers: PlannedReferrer[];
}

/**
 * Read the vault and build the copy plan for `file`. Nothing is written. Refuses, with a stable
 * code, when the reference graph cannot be trusted (index not ready, ambiguous links, an unreadable
 * canvas or note) or when a reference cannot be rewritten.
 */
export async function planOffload(plugin: AIOrganiserPlugin, file: TFile, pair: CloudInventoryPair): Promise<Result<OffloadPreview>> {
    const deps = createOffloadDeps(plugin);
    if (!deps) return err('mount-invalid');
    const app = plugin.app;
    const port: AttachmentVaultPort = createAppVaultPort(app);
    if (!port.isResolved() && !(await port.waitResolved(5000))) return err('metadata-not-ready');
    if (port.candidatesFor(file.name).length > 1) return err('ambiguous-reference');

    const target: ScanTarget = {
        path: file.path,
        name: file.name,
        resolve: (linktext, from) => port.resolveLink(linktext, from),
    };
    const referrers: Array<{ path: string; kind: 'md' | 'canvas'; text: string; occurrences: Occurrence[] }> = [];
    for (const r of port.listReferrers()) {
        const text = await port.readText(r.path);
        if (text === null) return err('scan-incomplete');
        const found = findOccurrences(r.path, text, r.extension, target);
        if (!found.ok) return err(found.error);
        if (found.value.length > 0) referrers.push({ path: r.path, kind: r.extension === 'canvas' ? 'canvas' : 'md', text, occurrences: found.value });
    }

    const abs = deps.node.path.join(deps.vaultBasePath, ...file.path.split('/'));
    const finger = await deps.fingerprint(abs);
    if (!finger.ok) return err(finger.error);
    const plan = await buildCopyPlan({
        opId: newOpId(),
        now: new Date().toISOString(),
        source: { path: file.path, size: finger.value.size, mtimeMs: finger.value.mtimeMs, sha256: finger.value.sha256 },
        pair,
        referrers,
        protectedFolders: plugin.settings.protectedFolders,
    });
    if (!plan.ok) return err(plan.error);
    return ok({ record: newRecord(plan.value, new Date().toISOString()), referrers: plan.value.referrers });
}
