/**
 * Save the connector files into the chosen folder. They are plugin-owned output: created if absent,
 * replaced only when they carry the plugin's marker (the first line of the server file, the archive
 * comment of the bundle), never when something else is at that path. Written through the vault adapter
 * because the vault index does not track a `.mcpb` or `.cjs` file.
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

async function replaceOrCreate(
    plugin: AIOrganiserPlugin,
    path: string,
    write: (target: string) => Promise<void>,
    isOurs: () => Promise<boolean>,
): Promise<Result<void>> {
    const adapter = plugin.app.vault.adapter;
    if (!assertWritable(plugin.settings.protectedFolders, 'create', path).ok) return err('protected-path');
    if ((await adapter.exists(path)) && !(await isOurs())) return err('connector-file-not-ours');
    const tmp = `${path}.aio-tmp`;
    try {
        await write(tmp);
        // The check is made again right before the swap: the folder step and the write took time.
        if (!assertWritable(plugin.settings.protectedFolders, 'modify', path).ok) throw new Error('protected');
        if ((await adapter.exists(path)) && !(await isOurs())) throw new Error('foreign');
        if (await adapter.exists(path)) await adapter.remove(path);
        await adapter.rename(tmp, path);
        return ok(undefined);
    } catch (e) {
        try { if (await adapter.exists(tmp)) await adapter.remove(tmp); } catch { /* left for the next save */ }
        if (e instanceof Error && e.message === 'protected') return err('protected-path');
        if (e instanceof Error && e.message === 'foreign') return err('connector-file-not-ours');
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
            await ensureFolder(plugin, folder.value);

            const bundleBytes = buildConnectorBundle(pluginVersion);
            const bundle = await replaceOrCreate(
                plugin,
                bundlePath,
                (target) => adapter.writeBinary(target, bundleBytes.buffer.slice(bundleBytes.byteOffset, bundleBytes.byteOffset + bundleBytes.byteLength) as ArrayBuffer),
                async () => isOwnBundle(new Uint8Array(await adapter.readBinary(bundlePath))),
            );
            if (!bundle.ok) return err(bundle.error);

            const server = await replaceOrCreate(
                plugin,
                serverPath,
                (target) => adapter.write(target, buildServerFileText()),
                async () => isOwnServerFile(await adapter.read(serverPath)),
            );
            if (!server.ok) return err(server.error);
            return ok({ bundle: bundlePath, server: serverPath });
        } catch (e) {
            logger.error('Connector', 'Saving connector files failed', e);
            return err('write-failed');
        }
    });
}
