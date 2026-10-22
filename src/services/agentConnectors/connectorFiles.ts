/**
 * Save the connector files into the chosen folder. They are plugin-owned output: created if absent,
 * replaced only when they carry the plugin's marker (the first line of the server file, the archive
 * comment of the bundle), never when something else is at that path. Written through the vault adapter
 * because the vault index does not track a `.mcpb` or `.cjs` file.
 *
 * Both targets are checked before anything is written, so a foreign file at the second path cannot
 * leave the first already replaced. A replacement is staged under a unique name, the current file is
 * moved aside (only into a slot that is empty or ours), and put back if the swap fails.
 */
import type AIOrganiserPlugin from '../../main';
import { Result, ok, err } from '../../core/result';
import { assertWritable } from '../../core/protectedPaths';
import { logger } from '../../utils/logger';
import {
    buildConnectorBundle,
    buildServerFileText,
    CONNECTOR_BUNDLE_FILE,
    CONNECTOR_SERVER_FILE,
    isOwnBundle,
    isOwnServerFile,
} from './connectorBundle';
import { connectorFolderPath } from './connectorRuntime';

export interface ConnectorFilePaths {
    bundle: string;
    server: string;
}

let writing: Promise<unknown> = Promise.resolve();
/** Saving never overlaps itself. */
function serialised<T>(job: () => Promise<T>): Promise<T> {
    const run = writing.then(job, job);
    writing = run.catch(() => undefined);
    return run;
}

async function ensureFolder(plugin: AIOrganiserPlugin, folder: string): Promise<void> {
    const adapter = plugin.app.vault.adapter;
    if (!assertWritable(plugin.settings.protectedFolders, 'create', `${folder}/x`).ok) throw new Error('protected');
    let current = '';
    for (const part of folder.split('/')) {
        current = current ? `${current}/${part}` : part;
        if (!(await adapter.exists(current))) await adapter.mkdir(current);
    }
}

type OwnerCheck = (path: string) => Promise<boolean>;

interface Target {
    path: string;
    write(target: string): Promise<void>;
    isOurs: OwnerCheck;
}

const uniqueSuffix = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** `ok(true)` when the path holds one of our files, `ok(false)` when it is empty, `err` when it is someone else's. */
async function checkTarget(plugin: AIOrganiserPlugin, target: Target): Promise<Result<boolean>> {
    const adapter = plugin.app.vault.adapter;
    if (!assertWritable(plugin.settings.protectedFolders, 'create', target.path).ok) return err('protected-path');
    if (!(await adapter.exists(target.path))) return ok(false);
    return (await target.isOurs(target.path)) ? ok(true) : err('connector-file-not-ours');
}

async function publishTarget(plugin: AIOrganiserPlugin, target: Target): Promise<Result<void>> {
    const adapter = plugin.app.vault.adapter;
    const prev = `${target.path}.aio-prev`;
    const tmp = `${target.path}.aio-${uniqueSuffix()}.tmp`;
    let movedAside = false;
    try {
        const first = await checkTarget(plugin, target);
        if (!first.ok) return err(first.error);
        // The backup slot is cleared only when what is in it is ours.
        if (await adapter.exists(prev)) {
            if (!(await target.isOurs(prev))) return err('connector-file-not-ours');
            await adapter.remove(prev);
        }
        await target.write(tmp);
        // Checked again right before the swap: the write took time.
        const again = await checkTarget(plugin, target);
        if (!again.ok) throw new Error(again.error);
        if (again.value) { await adapter.rename(target.path, prev); movedAside = true; }
        await adapter.rename(tmp, target.path);
        if (movedAside) { try { await adapter.remove(prev); } catch { /* cleared by the next save */ } }
        return ok(undefined);
    } catch (e) {
        try {
            if (movedAside && !(await adapter.exists(target.path)) && (await adapter.exists(prev))) await adapter.rename(prev, target.path);
            if (await adapter.exists(tmp)) await adapter.remove(tmp);
        } catch { /* the next save sees what is left and does not trust any of it */ }
        if (e instanceof Error && (e.message === 'protected-path' || e.message === 'connector-file-not-ours')) return err(e.message);
        logger.error('Connector', 'Could not save a connector file', e);
        return err('write-failed');
    }
}

/** Create or refresh the bundle and the standalone server in the connector folder. Never throws. */
export function saveConnectorFiles(plugin: AIOrganiserPlugin, pluginVersion: string): Promise<Result<ConnectorFilePaths>> {
    return serialised(async () => {
        try {
            const s = plugin.settings;
            const folder = connectorFolderPath(s.agentConnectorFolder, s.protectedFolders);
            if (!folder.ok) return err(folder.error);
            const adapter = plugin.app.vault.adapter;
            const bundlePath = `${folder.value}/${CONNECTOR_BUNDLE_FILE}`;
            const serverPath = `${folder.value}/${CONNECTOR_SERVER_FILE}`;
            if (!assertWritable(s.protectedFolders, 'create', [bundlePath, serverPath]).ok) return err('protected-path');

            const bundleBytes = buildConnectorBundle(pluginVersion);
            const bundleBuffer = bundleBytes.buffer.slice(bundleBytes.byteOffset, bundleBytes.byteOffset + bundleBytes.byteLength) as ArrayBuffer;
            const targets: Target[] = [
                { path: bundlePath, write: (t) => adapter.writeBinary(t, bundleBuffer), isOurs: async (p) => isOwnBundle(new Uint8Array(await adapter.readBinary(p))) },
                { path: serverPath, write: (t) => adapter.write(t, buildServerFileText()), isOurs: async (p) => isOwnServerFile(await adapter.read(p)) },
            ];

            // Nothing is written until every target is known to be free or ours.
            for (const target of targets) {
                const check = await checkTarget(plugin, target);
                if (!check.ok) return err(check.error);
            }
            try {
                await ensureFolder(plugin, folder.value);
            } catch (e) {
                return err(e instanceof Error && e.message === 'protected' ? 'protected-path' : 'write-failed');
            }
            for (const target of targets) {
                const res = await publishTarget(plugin, target);
                if (!res.ok) return err(res.error);
            }
            return ok({ bundle: bundlePath, server: serverPath });
        } catch (e) {
            logger.error('Connector', 'Saving connector files failed', e);
            return err('write-failed');
        }
    });
}
