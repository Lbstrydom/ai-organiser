/**
 * Cloud folder inventory (F4): commands and the guided setup.
 *
 * The setup walks an ordinary user through four steps: choose the folders, set up the Google script
 * (with a ready-to-paste copy that already contains the secret and the approved folder), connect
 * (a "Test connection" that says what to do when it fails), and preview the hub note before anything
 * is written. The secret is stored the moment the user copies the script, because deploying Google
 * code cannot be undone by cancelling; reopening the setup reuses the same secret.
 */
import { logger } from '../utils/logger';
import { Notice, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { Result, ok, err } from '../core/result';
import { PLUGIN_SECRET_IDS } from '../core/secretIds';
import { describeError, formatGuidance } from '../core/friendlyErrors';
import { DRIVE_FOLDER_ID_PATTERN, type CloudInventoryPair } from '../core/settings';
import { validateScriptUrl } from '../services/appsScriptClient';
import { parseDriveFolderInput } from '../services/cloudInventory/driveLinkParser';
import { buildInventoryScript } from '../services/cloudInventory/scriptTemplate';
import {
    approvedRoots,
    checkPair,
    hubNotePath,
    inventoryConfigKey,
    makeLister,
    planPair,
    refreshPair,
    testConnection,
    toTestResult,
    type RefreshDeps,
} from '../services/cloudInventory/cloudInventoryService';
import { ConfirmationModal } from '../ui/modals/ConfirmationModal';
import { GuidedSetupModal } from '../ui/modals/GuidedSetupModal';
import { addFolderPicker } from '../ui/settings/components/FolderSuggest';

// ─── Secret ──────────────────────────────────────────────────────────────────

function randomSecret(): string {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The stored secret, or null when none exists yet. */
export async function getInventorySecret(plugin: AIOrganiserPlugin): Promise<string | null> {
    return plugin.secretStorageService.getSecret(PLUGIN_SECRET_IDS.CLOUD_INVENTORY);
}

/** The stored secret, creating and storing a new one the first time. */
export async function ensureInventorySecret(plugin: AIOrganiserPlugin): Promise<{ secret: string; created: boolean }> {
    const existing = await getInventorySecret(plugin);
    if (existing) return { secret: existing, created: false };
    const secret = randomSecret();
    await plugin.secretStorageService.setSecret(PLUGIN_SECRET_IDS.CLOUD_INVENTORY, secret);
    return { secret, created: true };
}

function newPairId(): string {
    return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Run a detached task from a button or command; a thrown error becomes a notice, never an unhandled rejection. */
function detach(plugin: AIOrganiserPlugin, task: () => Promise<void>, onFail?: (message: string) => void): void {
    task().catch((e: unknown) => {
        logger.error('CloudInventory', 'Task failed', e);
        const message = formatGuidance(describeError(plugin.t, 'unknown'));
        if (onFail) onFail(message);
        else new Notice(message, 8000);
    });
}

// ─── Refresh / check ─────────────────────────────────────────────────────────

function confirmAppend(plugin: AIOrganiserPlugin): (path: string) => Promise<boolean> {
    const c = plugin.t.cloudInventory;
    return (path) =>
        new Promise<boolean>((resolve) => {
            let answered = false;
            const modal = new ConfirmationModal(
                plugin.app,
                c.appendConfirmTitle,
                c.appendConfirmBody.replace('{path}', path),
                () => { answered = true; resolve(true); },
                plugin,
            );
            const close = modal.onClose.bind(modal);
            modal.onClose = () => { close(); if (!answered) resolve(false); };
            modal.open();
        });
}

async function buildDeps(plugin: AIOrganiserPlugin): Promise<Result<RefreshDeps>> {
    let secret: string | null = null;
    try {
        secret = await getInventorySecret(plugin);
    } catch (e) {
        logger.error('CloudInventory', 'Secret storage unavailable', e);
    }
    if (!secret) return err('no-secret');
    const v = validateScriptUrl(plugin.settings.cloudInventoryScriptUrl);
    if (!v.ok) return err(v.error);
    return ok({ list: makeLister(plugin, secret), confirmAppend: confirmAppend(plugin) });
}

/** Refresh the pairs in `only` when given; otherwise the hub note being viewed, or every pair. */
export async function runRefresh(plugin: AIOrganiserPlugin, only?: readonly string[]): Promise<void> {
    const c = plugin.t.cloudInventory;
    const pairs = plugin.settings.cloudInventoryPairs;
    if (pairs.length === 0) { new Notice(c.noPairsNotice, 6000); return; }
    const deps = await buildDeps(plugin);
    if (!deps.ok) { new Notice(formatGuidance(describeError(plugin.t, deps.error)), 8000); return; }
    // From inside a hub note, refresh just that note's pair; otherwise refresh all.
    const active = plugin.app.workspace.getActiveFile()?.path;
    const here = !only && active ? pairs.filter((p) => { const h = hubNotePath(p, plugin.settings.protectedFolders); return h.ok && h.value === active; }) : [];
    const targets = only ? pairs.filter((p) => only.includes(p.id)) : here.length > 0 ? here : pairs;
    const working = new Notice(c.testing, 0);
    const counts = { created: 0, updated: 0, unchanged: 0 };
    const seen = new Set<string>();
    try {
        for (const pair of targets) {
            // Pairs that share a Drive folder are listed once per refresh.
            if (seen.has(pair.driveFolderId + pair.id)) continue;
            seen.add(pair.driveFolderId + pair.id);
            const res = await refreshPair(plugin, pair, deps.value);
            if (!res.ok) {
                new Notice(
                    res.error === 'marker-conflict'
                        ? c.conflictNotice.replace('{path}', (() => { const h = hubNotePath(pair, plugin.settings.protectedFolders); return h.ok ? h.value : pair.vaultFolder; })())
                        : `${c.refreshFailedFor.replace('{pair}', pair.label || pair.vaultFolder || pair.id)} ${formatGuidance(describeError(plugin.t, res.error))}`,
                    10000,
                );
                continue;
            }
            if (res.value.state === 'declined') new Notice(c.declinedNotice.replace('{path}', res.value.path), 5000);
            else counts[res.value.state]++;
            plugin.settings.cloudInventoryLastChecked[pair.id] = new Date().toISOString();
        }
    } finally {
        working.hide();
    }
    await plugin.saveSettings();
    new Notice(c.refreshDone.replace('{created}', String(counts.created)).replace('{updated}', String(counts.updated)).replace('{unchanged}', String(counts.unchanged)), 6000);
}

export async function runCheck(plugin: AIOrganiserPlugin): Promise<void> {
    const c = plugin.t.cloudInventory;
    const pairs = plugin.settings.cloudInventoryPairs;
    if (pairs.length === 0) { new Notice(c.noPairsNotice, 6000); return; }
    const deps = await buildDeps(plugin);
    if (!deps.ok) { new Notice(formatGuidance(describeError(plugin.t, deps.error)), 8000); return; }
    const working = new Notice(c.testing, 0);
    let changed = 0;
    let failed = 0;
    try {
        for (const pair of pairs) {
            const res = await checkPair(plugin, pair, deps.value);
            if (!res.ok) {
                failed++;
                new Notice(`${c.refreshFailedFor.replace('{pair}', pair.label || pair.vaultFolder || pair.id)} ${formatGuidance(describeError(plugin.t, res.error))}`, 10000);
                continue;
            }
            if (res.value.changed) changed++;
        }
    } finally {
        working.hide();
    }
    // A check that could not read some pairs cannot say they are unchanged.
    if (failed > 0) {
        new Notice(c.checkIncomplete.replace('{failed}', String(failed)).replace('{total}', String(pairs.length)).replace('{changed}', String(changed)), 8000);
        return;
    }
    new Notice(changed === 0 ? c.checkNoChange.replace('{total}', String(pairs.length)) : c.checkDone.replace('{changed}', String(changed)).replace('{total}', String(pairs.length)), 6000);
}

// ─── Guided setup ────────────────────────────────────────────────────────────

export function openCloudInventorySetup(plugin: AIOrganiserPlugin, onDone?: () => void): void {
    const t = plugin.t;
    const c = t.cloudInventory;
    const s = plugin.settings;
    const draft = {
        vaultFolder: '',
        driveInput: '',
        placement: 'beside' as 'beside' | 'inside',
        scriptUrl: s.cloudInventoryScriptUrl,
        driveFolderId: '',
        connection: null as ReturnType<typeof toTestResult> | null,
        connectionLine: c.notTested,
        previewText: '',
        createNow: true,
    };
    const draftPair = (): CloudInventoryPair => ({
        id: 'draft',
        vaultFolder: draft.vaultFolder,
        driveFolderId: draft.driveFolderId,
        placement: draft.placement,
    });
    const roots = (): string[] => approvedRoots([...s.cloudInventoryPairs, ...(DRIVE_FOLDER_ID_PATTERN.test(draft.driveFolderId) ? [draftPair()] : [])]);

    new GuidedSetupModal(plugin.app, t, {
        title: c.wizardTitle,
        steps: [
            {
                id: 'pair',
                title: c.stepPair,
                validate: () => {
                    const parsed = parseDriveFolderInput(draft.driveInput);
                    if (!parsed.ok) return err(parsed.error);
                    draft.driveFolderId = parsed.value;
                    return ok(undefined);
                },
                render: (el) => {
                    const vault = new Setting(el).setName(c.vaultFolderLabel).setDesc(c.vaultFolderHelp);
                    addFolderPicker(vault, plugin.app, () => draft.vaultFolder, (v) => { draft.vaultFolder = v.trim(); });
                    new Setting(el).setName(c.driveLinkLabel).addText((tx) => {
                        tx.setPlaceholder(c.driveLinkPlaceholder).setValue(draft.driveInput).onChange((v) => { draft.driveInput = v; });
                        tx.inputEl.setAttribute('aria-label', c.driveLinkLabel);
                    });
                    new Setting(el).setName(c.placementLabel).addDropdown((d) => d
                        .addOption('beside', c.placementBeside)
                        .addOption('inside', c.placementInside)
                        .setValue(draft.placement)
                        .onChange((v) => { draft.placement = v === 'inside' ? 'inside' : 'beside'; }));
                },
            },
            {
                id: 'script',
                title: c.stepScript,
                render: (el) => {
                    el.createEl('p', { text: c.scriptIntro });
                    for (const line of [c.scriptStep1, c.scriptStep2, c.scriptStep3, c.scriptStep4, c.scriptStep5]) el.createEl('p', { text: line });
                    new Setting(el).addButton((b) => b.setButtonText(c.copyScript).setCta().onClick(() => {
                        detach(plugin, async () => {
                            const { secret, created } = await ensureInventorySecret(plugin);
                            await navigator.clipboard.writeText(buildInventoryScript({ secret, rootFolderIds: roots() }));
                            new Notice(c.scriptCopied + (created ? ` ${c.secretCreated}` : ''), 8000);
                        });
                    }));
                },
            },
            {
                id: 'connect',
                title: c.stepConnect,
                validate: () => {
                    const v = validateScriptUrl(draft.scriptUrl);
                    return v.ok ? ok(undefined) : err(v.error);
                },
                render: (el) => {
                    new Setting(el).setName(c.scriptUrlName).setDesc(c.scriptUrlDesc).addText((tx) => {
                        tx.setPlaceholder(c.scriptUrlName).setValue(draft.scriptUrl).onChange((v) => { draft.scriptUrl = v.trim(); });
                        tx.inputEl.setAttribute('aria-label', c.scriptUrlName);
                    });
                    const line = el.createDiv({ cls: 'setting-item-description', attr: { role: 'status' } });
                    line.setText(draft.connectionLine);
                    new Setting(el).addButton((b) => b.setButtonText(c.testConnection).onClick(() => {
                        detach(plugin, async () => {
                            line.setText(c.testing);
                            const secret = await getInventorySecret(plugin);
                            const urlOk = validateScriptUrl(draft.scriptUrl);
                            const key = inventoryConfigKey(draft.scriptUrl, [...s.cloudInventoryPairs, draftPair()]);
                            const fail = (code: string): void => {
                                draft.connection = toTestResult(key, null, new Date().toISOString());
                                draft.connectionLine = formatGuidance(describeError(t, code));
                                line.setText(draft.connectionLine);
                            };
                            if (!secret) return fail('no-secret');
                            if (!urlOk.ok) return fail(urlOk.error);
                            const res = await testConnection({ url: draft.scriptUrl, secret, roots: roots(), folderId: draft.driveFolderId });
                            if (!res.ok) return fail(res.error);
                            draft.connection = toTestResult(key, res.value, new Date().toISOString());
                            draft.connectionLine = res.value.folderName ? c.connected.replace('{folder}', res.value.folderName) : c.connectedNoFolder;
                            line.setText(draft.connectionLine);
                        }, (message) => { draft.connectionLine = message; line.setText(message); });
                    }));
                },
            },
            {
                id: 'preview',
                title: c.stepPreview,
                render: (el) => {
                    const where = hubNotePath(draftPair(), s.protectedFolders);
                    if (where.ok) el.createEl('p', { text: c.previewWhere.replace('{path}', where.value) });
                    const box = el.createEl('pre', { cls: 'ai-organiser-inventory-preview' });
                    box.setText(draft.previewText || '');
                    new Setting(el).addButton((b) => b.setButtonText(c.previewButton).onClick(() => {
                        detach(plugin, async () => {
                            box.setText(c.previewLoading);
                            const secret = await getInventorySecret(plugin);
                            if (!secret) { box.setText(formatGuidance(describeError(t, 'no-secret'))); return; }
                            const listing = await makeLister(plugin, secret, undefined, draft.scriptUrl)({ ...draftPair() });
                            if (listing.status === 'failed') { box.setText(formatGuidance(describeError(t, listing.error ?? 'script-drive-error'))); return; }
                            const planned = await planPair(plugin, draftPair(), listing, new Date().toISOString());
                            if (!planned.ok) { box.setText(formatGuidance(describeError(t, planned.error))); return; }
                            draft.previewText = planned.value.block.split('\n').slice(0, 24).join('\n');
                            box.setText(draft.previewText);
                        }, (message) => box.setText(message));
                    }));
                    new Setting(el).setName(c.createHub).addToggle((tg) => tg.setValue(draft.createNow).onChange((v) => { draft.createNow = v; }));
                },
            },
        ],
        onFinish: async (): Promise<Result<void>> => {
            const pair: CloudInventoryPair = { ...draftPair(), id: newPairId() };
            const existing = s.cloudInventoryPairs.find((p) => p.driveFolderId === pair.driveFolderId && p.vaultFolder === pair.vaultFolder);
            if (!existing) s.cloudInventoryPairs = [...s.cloudInventoryPairs, pair];
            s.cloudInventoryScriptUrl = draft.scriptUrl;
            const finalKey = inventoryConfigKey(draft.scriptUrl, s.cloudInventoryPairs);
            s.cloudInventoryLastTest = draft.connection && draft.connection.configHash === finalKey ? draft.connection : null;
            s.featureSetupCompletedAt['cloud-inventory'] = new Date().toISOString();
            await plugin.saveSettings();
            onDone?.();
            if (draft.createNow) {
                const mine = s.cloudInventoryPairs.find((p) => p.driveFolderId === pair.driveFolderId && p.vaultFolder === pair.vaultFolder);
                if (mine) detach(plugin, () => runRefresh(plugin, [mine.id]));
            }
            return ok(undefined);
        },
    }).open();
}

export function registerCloudInventoryCommands(plugin: AIOrganiserPlugin): void {
    const t = plugin.t;
    plugin.addCommand({ id: 'refresh-cloud-inventories', name: t.commands.refreshCloudInventories, icon: 'refresh-cw', callback: () => { detach(plugin, () => runRefresh(plugin)); } });
    plugin.addCommand({ id: 'check-cloud-inventories', name: t.commands.checkCloudInventories, icon: 'list-checks', callback: () => { detach(plugin, () => runCheck(plugin)); } });
    plugin.addCommand({ id: 'setup-cloud-inventory', name: t.commands.setupCloudInventory, icon: 'cloud', callback: () => openCloudInventorySetup(plugin) });
}
