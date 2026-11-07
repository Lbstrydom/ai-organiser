/**
 * Wires the live pack into the plugin: the service's environment, the scheduler's vault events, the settings-save hook, the
 * revoke-only reconciler at start-up and the feature teardown. Desktop only; on mobile `createLivePackRuntime` returns null and
 * nothing is registered.
 */
import { FileSystemAdapter, Platform, TFile, type EventRef } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { saveSettingsData } from '../../core/pluginDataStore';
import { logger } from '../../utils/logger';
import { Result, err } from '../../core/result';
import { checkMountFolderWithin } from '../offload/localMount';
import { deviceId } from '../operations/operationIndex';
import { sharePolicyRevision } from './aiShareScope';
import { liveDeps, localStorageJournal } from './liveFileWriter';
import { LivePackScheduler } from './livePackScheduler';
import { LivePackService, type LiveEnv } from './livePackService';
import { aiWorkspacesActive, collectPackNotes, packInputFor } from './workspaceService';

function vaultBase(plugin: AIOrganiserPlugin): string | null {
    const adapter = plugin.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
}

export function liveEnv(plugin: AIOrganiserPlugin): LiveEnv {
    return {
        settings: () => plugin.settings,
        saveConsent: () => plugin.saveSettings(),
        saveStatus: () => saveSettingsData(plugin, plugin.settings),
        featureOn: () => aiWorkspacesActive(plugin),
        collectNotes: (aioId) => collectPackNotes(plugin, aioId),
        packInput: (aioId, notes) => packInputFor(plugin, aioId, notes),
        sharePolicy: () => sharePolicyRevision(plugin.settings, plugin.settings.aiWorkspacePackFolder),
        deviceId: () => deviceId(plugin),
        deps: () => liveDeps(),
        vaultBase: () => vaultBase(plugin),
        journal: localStorageJournal((k) => plugin.app.loadLocalStorage(k) as unknown, (k, v) => plugin.app.saveLocalStorage(k, v)),
        now: () => new Date(),
    };
}

export class LivePackRuntime {
    readonly service: LivePackService;
    private scheduler: LivePackScheduler | null = null;
    private readonly refs: EventRef[] = [];

    constructor(private readonly plugin: AIOrganiserPlugin) {
        this.service = new LivePackService(liveEnv(plugin));
    }

    /** At layout ready: finish pending revocations (feature on or off), then watch the live packs while the feature is on. */
    start(): void {
        void this.service.reconcile().then((r) => {
            if (r.errors.length > 0) logger.warn('AiWorkspaces', `Live pack stubs still pending: ${r.errors.map((e) => e.error).join(', ')}`);
        });
        if (!aiWorkspacesActive(this.plugin)) return;
        const s = this.plugin.settings;
        const scheduler = new LivePackScheduler(this.service, () => Math.min(60, Math.max(1, s.aiWorkspaceLiveDelayMinutes)) * 60_000, {
            set: (fn, ms) => window.setTimeout(fn, ms),
            clear: (id) => window.clearTimeout(id),
            now: () => Date.now(),
        });
        this.scheduler = scheduler;
        const { app } = this.plugin;
        this.refs.push(
            app.metadataCache.on('changed', (file) => scheduler.touched(file.path)),
            app.vault.on('delete', (file) => { if (file instanceof TFile) scheduler.touched(file.path); }),
            app.vault.on('rename', (file, old) => { scheduler.touched(old); scheduler.touched(file.path); }),
        );
        for (const ref of this.refs) this.plugin.registerEvent(ref);
        scheduler.start();
    }

    /** Check a folder for live packs (the settings button): absolute, existing, outside the vault. Bounded in time. */
    async checkFolder(raw: string): Promise<Result<string>> {
        const deps = liveDeps();
        if (!deps) return err('live-desktop-only');
        if (raw.trim() === '') return err('live-folder-missing');
        const base = vaultBase(this.plugin);
        // Without the vault path the folder cannot be shown to lie outside it: the answer is no.
        if (!base) return err('mount-vault-unverified');
        return checkMountFolderWithin(deps, raw, base);
    }

    /** Called synchronously at the start of every settings save, before it awaits anything. */
    beforeSave(): void {
        this.service.bumpEpoch();
    }

    /** After a settings save (or a synced change): re-check the policy of every live pack here and what they watch. */
    afterSave(): void {
        this.service.checkPolicyAll();
        this.scheduler?.resync();
    }

    /** data.json changed on disk (another device): finish revocations it asked for, then re-check. */
    externalChange(): void {
        this.service.bumpEpoch();
        void this.service.reconcile();
        this.afterSave();
    }

    /** The feature was turned off: every live file here becomes the stub (persisted first, so a restart finishes it). */
    teardown(): void {
        void this.service.revokeAll('feature-off').then((r) => {
            if (r.errors.length > 0) logger.warn('AiWorkspaces', `Live pack stubs still pending after turning off: ${r.errors.length}`);
        });
        this.stop();
    }

    stop(): void {
        this.service.close();
        this.scheduler?.stop();
        this.scheduler = null;
        for (const ref of this.refs.splice(0)) this.plugin.app.vault.offref(ref);
    }
}

/** Null on mobile or wherever Node modules are not available. */
export function createLivePackRuntime(plugin: AIOrganiserPlugin): LivePackRuntime | null {
    return Platform.isDesktopApp && liveDeps() ? new LivePackRuntime(plugin) : null;
}
