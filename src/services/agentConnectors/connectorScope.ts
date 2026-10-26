/**
 * The scope document the read-only connector reads at the start of every request, and the publisher
 * that keeps it true to the settings.
 *
 * Revocation is part of the feature: the effective state is "feature on AND its dependency on", and
 * every change to it (or to the scope fields) is published. A move to "off" publishes a tombstone and
 * reads it back before reporting success; a failed publication is remembered (`agentConnectorScopeStale`)
 * so the settings row can say that access may be out of date. A never-enabled installation writes nothing.
 */
import type { DataAdapter } from 'obsidian';
import { Result, ok, err } from '../../core/result';
import { assertWritable, resolveProtectedFolders } from '../../core/protectedPaths';
import type { AIOrganiserSettings } from '../../core/settings';
import { isFeatureEnabled } from '../featureService';
import { sha256Hex } from '../attachmentDuplicateService';
import { planOutput, scopeConfigFromSettings } from '../agentIndex/agentIndexService';
import { CONNECTOR_SCOPE_GENERATOR, CONNECTOR_SCOPE_PATH } from './connectorServerSource';
import { logger } from '../../utils/logger';
import { normaliseShareFolders, sharePolicyRevision } from '../aiWorkspaces/aiShareScope';
import { packFolderPath } from '../aiWorkspaces/packStore';

export { CONNECTOR_SCOPE_PATH, CONNECTOR_SCOPE_GENERATOR };

export interface ScopeDocument {
    generator: typeof CONNECTOR_SCOPE_GENERATOR;
    version: 1;
    revision: string;
    generatedAt: string;
    disabled: boolean;
    includeFolders: string[];
    excludeFolders: string[];
    protectedFolders: string[];
    indexPath: string;
    /**
     * AI sharing (see `aiShareScope.ts`). Present only while `ai-workspaces` is on and either the opt-in is on or packs are served,
     * so a scope document made without AI workspaces is byte-identical to what it always was.
     * `shareFolders` is the allow-list; with `requireOptIn` true the notes the connector serves must also be inside it.
     */
    shareFolders?: string[];
    requireOptIn?: true;
    /** Present while packs may be served: where they live and the share-policy revision they must have been made under */
    packs?: { folder: string; revision: string };
}

type ScopeSettings = Pick<AIOrganiserSettings,
    'featureFlags' | 'protectedFolders' | 'agentIndexOutputPath' | 'aiShareFolders' | 'aiShareRequireOptIn' | 'aiWorkspacePackFolder' | 'agentIndexIncludeFolders' | 'agentIndexExcludeFolders'
    | 'agentIndexIncludeAliases' | 'agentIndexIncludeHeadings' | 'agentIndexFrontmatterKeys' | 'agentIndexExportUnresolvedLinks'>;

const sorted = (list: readonly string[]): string[] => [...new Set(list)].sort();

/** The content the revision covers: everything that decides what the connector may serve. */
async function revisionOf(body: Omit<ScopeDocument, 'revision' | 'generatedAt'>): Promise<string> {
    // The AI sharing fields join the hash only when present, so a scope without them keeps the revision it always had.
    const base: unknown[] = [body.disabled, body.includeFolders, body.excludeFolders, body.protectedFolders, body.indexPath];
    if (body.shareFolders !== undefined || body.requireOptIn !== undefined || body.packs !== undefined) base.push([body.shareFolders ?? null, body.requireOptIn ?? false, body.packs ?? null]);
    const canonical = JSON.stringify(base);
    return (await sha256Hex(new TextEncoder().encode(canonical).buffer)).slice(0, 16);
}

/** The document for the current settings. When the connector is not effectively on it is the tombstone. */
export async function buildScopeDocument(settings: ScopeSettings, now: string): Promise<Result<ScopeDocument>> {
    const enabled = isFeatureEnabled(settings as never, 'agent-connectors');
    let body: Omit<ScopeDocument, 'revision' | 'generatedAt'>;
    if (!enabled) {
        body = { generator: CONNECTOR_SCOPE_GENERATOR, version: 1, disabled: true, includeFolders: [], excludeFolders: [], protectedFolders: [], indexPath: '' };
    } else {
        const plan = planOutput(settings.agentIndexOutputPath, settings.protectedFolders);
        if (!plan.ok) return err(plan.error);
        const config = scopeConfigFromSettings(settings as never);
        body = {
            generator: CONNECTOR_SCOPE_GENERATOR,
            version: 1,
            disabled: false,
            includeFolders: sorted(config.includeFolders),
            excludeFolders: sorted(config.excludeFolders),
            protectedFolders: sorted(resolveProtectedFolders(settings.protectedFolders)),
            indexPath: plan.value.path,
        };
        // AI sharing: only while AI workspaces are on. The allow-list is published for packs, and gates the notes only on opt-in.
        if (isFeatureEnabled(settings as never, 'ai-workspaces')) {
            const optIn = settings.aiShareRequireOptIn === true;
            body.shareFolders = sorted(normaliseShareFolders(settings.aiShareFolders));
            if (optIn) body.requireOptIn = true;
            const folder = packFolderPath(settings.aiWorkspacePackFolder, settings.protectedFolders);
            if (folder.ok) body.packs = { folder: folder.value, revision: await sharePolicyRevision(settings as never, folder.value) };
        }
    }
    return ok({ ...body, revision: await revisionOf(body), generatedAt: now });
}

/** Parse a scope document we wrote. Anything else (foreign JSON, a wrong version) is `null`. */
export function parseScopeDocument(text: string): ScopeDocument | null {
    try {
        const d = JSON.parse(text) as Record<string, unknown> | null;
        if (!d || typeof d !== 'object') return null;
        const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
        if (d.generator !== CONNECTOR_SCOPE_GENERATOR || d.version !== 1 || typeof d.revision !== 'string' || typeof d.generatedAt !== 'string' || typeof d.disabled !== 'boolean') return null;
        if (!strings(d.includeFolders) || !strings(d.excludeFolders) || !strings(d.protectedFolders) || typeof d.indexPath !== 'string') return null;
        if (d.shareFolders !== undefined && !strings(d.shareFolders)) return null;
        if (d.requireOptIn !== undefined && d.requireOptIn !== true) return null;
        // Opting in without an allow-list is not a document we wrote.
        if (d.requireOptIn === true && d.shareFolders === undefined) return null;
        if (d.packs !== undefined) {
            const p = d.packs as Record<string, unknown> | null;
            if (!p || typeof p !== 'object' || typeof p.folder !== 'string' || typeof p.revision !== 'string' || d.shareFolders === undefined) return null;
        }
        return d as unknown as ScopeDocument;
    } catch {
        return null;
    }
}

type PublishAdapter = Pick<DataAdapter, 'exists' | 'read' | 'write' | 'rename' | 'remove' | 'mkdir'>;

export interface PublisherDeps {
    adapter: PublishAdapter;
    settings(): ScopeSettings;
    now(): string;
    /** Remember whether the last publication failed; persisted so a restart still knows */
    setStale(stale: boolean): Promise<void>;
}

export type PublishOutcome = 'unchanged' | 'published' | 'skipped';

const PREV = `${CONNECTOR_SCOPE_PATH}.aio-prev`;
const TMP = (id: string): string => `${CONNECTOR_SCOPE_PATH}.aio-${id}.tmp`;
const FOLDER = CONNECTOR_SCOPE_PATH.slice(0, CONNECTOR_SCOPE_PATH.lastIndexOf('/'));

const sortedList = (list: readonly string[]): string => JSON.stringify([...list].sort());

/** Same permissions, judged from the content itself: a stored revision is a label, not proof. */
function sameScope(a: ScopeDocument, b: ScopeDocument): boolean {
  return a.disabled === b.disabled && a.indexPath === b.indexPath
    && sortedList(a.includeFolders) === sortedList(b.includeFolders)
    && sortedList(a.excludeFolders) === sortedList(b.excludeFolders)
    && sortedList(a.protectedFolders) === sortedList(b.protectedFolders)
    && (a.requireOptIn === true) === (b.requireOptIn === true)
    && JSON.stringify(a.shareFolders === undefined ? null : [...a.shareFolders].sort()) === JSON.stringify(b.shareFolders === undefined ? null : [...b.shareFolders].sort())
    && JSON.stringify(a.packs ?? null) === JSON.stringify(b.packs ?? null);
}

async function readOurs(adapter: PublishAdapter, path: string): Promise<Result<ScopeDocument | null>> {
    if (!(await adapter.exists(path))) return ok(null);
    const doc = parseScopeDocument(await adapter.read(path));
    return doc ? ok(doc) : err('connector-file-not-ours');
}

/**
 * Keeps the scope file true to the settings. One publication at a time; never throws. The caller
 * runs `sync()` after every settings save, at start-up, and whenever the feature or its dependency flips.
 */
export class ScopePublisher {
    private chain: Promise<unknown> = Promise.resolve();

    constructor(private readonly deps: PublisherDeps) {}

    sync(): Promise<Result<PublishOutcome>> {
        const run = this.chain.then(() => this.syncNow(), () => this.syncNow());
        this.chain = run.catch(() => undefined);
        return run;
    }

    private async syncNow(): Promise<Result<PublishOutcome>> {
        const { adapter } = this.deps;
        try {
            const wanted = await buildScopeDocument(this.deps.settings(), this.deps.now());
            if (!wanted.ok) {
                // An enabled connector whose settings cannot be published is a failure the person must see.
                await this.deps.setStale(true);
                return err('connector-scope-write-failed');
            }
            // Put an interrupted earlier publication right first, but never bring back permissions the
            // settings no longer grant: when the wanted state is "off", the backup is not restored.
            if (!wanted.value.disabled && assertWritable(this.deps.settings().protectedFolders, 'modify', CONNECTOR_SCOPE_PATH).ok && !(await adapter.exists(CONNECTOR_SCOPE_PATH)) && (await adapter.exists(PREV))) {
                // Restored only when it grants exactly what is wanted now; anything wider or different is left for the publish below.
                const backup = parseScopeDocument(await adapter.read(PREV));
                if (backup && sameScope(backup, wanted.value)) await adapter.rename(PREV, CONNECTOR_SCOPE_PATH);
            }
            const current = await readOurs(adapter, CONNECTOR_SCOPE_PATH);
            if (!current.ok) {
                // A foreign file: never overwritten, and never silently ignored.
                await this.deps.setStale(true);
                return err(current.error);
            }
            if (current.value === null && wanted.value.disabled) {
                await this.deps.setStale(false);
                return ok('skipped'); // never enabled: nothing to revoke, nothing written
            }
            if (current.value && sameScope(current.value, wanted.value)) {
                await this.deps.setStale(false);
                return ok('unchanged');
            }
            const published = await this.publish(wanted.value);
            if (!published.ok) {
                await this.deps.setStale(true);
                return err(published.error);
            }
            await this.deps.setStale(false);
            return ok('published');
        } catch (e) {
            logger.error('Connector', 'Scope publication failed', e);
            try { await this.deps.setStale(true); } catch { /* the flag is best effort here */ }
            return err('connector-scope-write-failed');
        }
    }

    private async publish(doc: ScopeDocument): Promise<Result<void>> {
        const { adapter } = this.deps;
        if (!assertWritable(this.deps.settings().protectedFolders, 'create', CONNECTOR_SCOPE_PATH).ok) return err('connector-scope-write-failed');
        if (!(await adapter.exists(FOLDER))) await adapter.mkdir(FOLDER);
        // The backup slot is only ever cleared when what is in it is ours.
        if (await adapter.exists(PREV)) {
            if (!parseScopeDocument(await adapter.read(PREV))) return err('connector-file-not-ours');
            await adapter.remove(PREV);
        }
        const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        const tmp = TMP(id);
        await adapter.write(tmp, JSON.stringify(doc));
        const had = await adapter.exists(CONNECTOR_SCOPE_PATH);
        try {
            if (had) await adapter.rename(CONNECTOR_SCOPE_PATH, PREV);
            await adapter.rename(tmp, CONNECTOR_SCOPE_PATH);
        } catch (e) {
            try {
                if (had && !(await adapter.exists(CONNECTOR_SCOPE_PATH)) && (await adapter.exists(PREV))) await adapter.rename(PREV, CONNECTOR_SCOPE_PATH);
                if (await adapter.exists(tmp)) await adapter.remove(tmp);
            } catch { /* the next sync recovers whatever is left */ }
            logger.error('Connector', 'Scope swap failed', e);
            return err('connector-scope-write-failed');
        }
        if (had) { try { await adapter.remove(PREV); } catch { /* recovered next time */ } }
        // Read it back: success means the very next request will see exactly this.
        const back = parseScopeDocument(await adapter.read(CONNECTOR_SCOPE_PATH));
        return back && back.revision === doc.revision && back.disabled === doc.disabled ? ok(undefined) : err('connector-scope-write-failed');
    }
}
