/**
 * Reload AI Organiser itself, so commands and views of a feature just turned on register
 * (docs/plans/navigation-discoverability.md, decision 3). This is the only caller of
 * Obsidian's internal plugin manager, behind a check that both functions exist.
 *
 * The re-enable runs in a promise chain held by the plugin manager's own call, not by the
 * plugin instance being unloaded, so it survives the unload. A failure after the unload can no
 * longer use the plugin, so the caller passes the notice text in beforehand.
 */
import { Notice } from 'obsidian';
import { err, ok, type Result } from '../core/result';
import { logger } from '../utils/logger';

interface PluginManager {
    disablePlugin(id: string): Promise<unknown>;
    enablePlugin(id: string): Promise<unknown>;
}

function pluginManager(app: unknown): PluginManager | null {
    const plugins = (app as { plugins?: Partial<PluginManager> } | null)?.plugins;
    if (!plugins || typeof plugins.disablePlugin !== 'function' || typeof plugins.enablePlugin !== 'function') return null;
    return plugins as PluginManager;
}

export type ReloadErrorCode = 'activation-reload-unsupported' | 'activation-reenable-failed';

/**
 * Start the reload. `ok` means the disable was started; the enable follows it. Returns
 * `activation-reload-unsupported` (nothing was touched) when the internal API is missing or the
 * disable throws synchronously, so the caller can fall back to "reload Obsidian".
 */
export function reloadSelf(app: unknown, pluginId: string, reenableFailedNotice: string): Result<'started'> {
    const plugins = pluginManager(app);
    if (!plugins) return err('activation-reload-unsupported');
    let disabling: Promise<unknown>;
    try {
        disabling = plugins.disablePlugin(pluginId);
    } catch (e) {
        logger.warn('Core', 'disablePlugin threw; not reloading', e);
        return err('activation-reload-unsupported');
    }
    void Promise.resolve(disabling)
        .then(() => plugins.enablePlugin(pluginId))
        .catch((e: unknown) => {
            logger.error('Core', 'AI Organiser did not start again after the reload', e);
            new Notice(reenableFailedNotice, 0);
        });
    return ok('started');
}
