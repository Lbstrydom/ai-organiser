/**
 * The integration status row: one place that states what the user's deployed Google script can do. Each module (Google
 * Tasks, Drive inventory) shows its version and capabilities from a `ping`; a feature that needs a capability the script
 * lacks says so here and in its own guidance, and only that feature is turned off. Feature sections link here instead of each
 * showing their own script status.
 *
 * Gate: shown only while `google-tasks-export` or `cloud-inventory` is on. Off, nothing is rendered and nothing is called.
 */
import { Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { PLUGIN_SECRET_IDS } from '../../core/secretIds';
import { describeError, formatGuidance } from '../../core/friendlyErrors';
import { isFeatureEnabled } from '../../services/featureService';
import { pingModule, type ModuleInfo, type ScriptModule } from '../../services/googleScript/modulePing';
import { validateScriptUrl } from '../../services/appsScriptClient';
import { exportable, pendingApprovals } from '../../services/inboxSweep/sweepLedger';
import { plural } from '../../utils/plural';

/** Capabilities a feature of this plugin may ask for, per module, in the order they are listed. */
export const KNOWN_CAPABILITIES: Readonly<Record<ScriptModule, readonly string[]>> = Object.freeze({
    tasks: Object.freeze(['upsert', 'lists', 'multi-list', 'status']),
    inventory: Object.freeze(['list']),
});

export const integrationRowVisible = (settings: Parameters<typeof isFeatureEnabled>[0]): boolean =>
    isFeatureEnabled(settings, 'google-tasks-export') || isFeatureEnabled(settings, 'cloud-inventory');

type Checked = { at: number; url: string; result: { ok: true; info: ModuleInfo } | { ok: false; error: string } };
const lastChecks = new WeakMap<AIOrganiserPlugin, Partial<Record<ScriptModule, Checked>>>();

/** What each module still needs from the script, given what it reported (pure, for the row and for tests). */
export function missingCapabilities(module: ScriptModule, info: ModuleInfo): string[] {
    return KNOWN_CAPABILITIES[module].filter((c) => !info.capabilities.includes(c));
}

function endpointOf(plugin: AIOrganiserPlugin, module: ScriptModule): { url: string } | null {
    const url = module === 'tasks' ? plugin.settings.tasksScriptUrl : plugin.settings.cloudInventoryScriptUrl;
    const valid = validateScriptUrl(url ?? '');
    return valid.ok ? { url: valid.value } : null;
}

async function secretOf(plugin: AIOrganiserPlugin, module: ScriptModule): Promise<string> {
    return (await plugin.secretStorageService.getSecret(module === 'tasks' ? PLUGIN_SECRET_IDS.GOOGLE_TASKS : PLUGIN_SECRET_IDS.CLOUD_INVENTORY)) ?? '';
}

export function renderIntegrationStatusRow(container: HTMLElement, plugin: AIOrganiserPlugin, rerender: () => void): void {
    if (!integrationRowVisible(plugin.settings)) return;
    const t = plugin.t.integrationStatus;
    const box = container.createDiv({ cls: 'ai-organiser-integration-status' });
    box.createEl('h4', { text: t.title });
    box.createEl('p', { text: t.intro, cls: 'setting-item-description' });

    const modules: ScriptModule[] = [];
    if (isFeatureEnabled(plugin.settings, 'google-tasks-export')) modules.push('tasks');
    if (isFeatureEnabled(plugin.settings, 'cloud-inventory')) modules.push('inventory');
    const checks = lastChecks.get(plugin) ?? {};

    for (const module of modules) {
        const row = new Setting(box).setName(t.moduleName[module]);
        const endpoint = endpointOf(plugin, module);
        if (!endpoint) { row.setDesc(t.notConfigured); continue; }
        // A result is shown only for the deployment it was obtained from.
        const checked = checks[module]?.url === endpoint.url ? checks[module] : undefined;
        const lines: string[] = [];
        if (!checked) lines.push(t.notChecked);
        else if (!checked.result.ok) lines.push(t.failed.replace('{reason}', formatGuidance(describeError(plugin.t, checked.result.error))));
        else {
            const info = checked.result.info;
            lines.push(t.line.replace('{version}', String(info.version)).replace('{capabilities}', info.capabilities.join(', ') || '-'));
            if (info.legacy) lines.push(t.legacy);
            const missing = missingCapabilities(module, info);
            if (missing.length > 0) lines.push(t.lacks.replace('{capabilities}', missing.join(', ')));
        }
        if (module === 'tasks') {
            const waiting = pendingApprovals(plugin.settings.sweepApprovals, true).reduce((n, r) => n + exportable(r).length, 0);
            if (waiting > 0) lines.push(plural(t.waitingRedeploy, waiting));
        }
        row.setDesc(lines.join(' '));
        row.addButton((b) => b.setButtonText(t.checkNow).onClick(async () => {
            b.setDisabled(true).setButtonText(t.checking);
            const secret = await secretOf(plugin, module);
            const res = await pingModule(module, { url: endpoint.url, secret });
            const next = lastChecks.get(plugin) ?? {};
            next[module] = { at: Date.now(), url: endpoint.url, result: res.ok ? { ok: true, info: res.value } : { ok: false, error: res.error } };
            lastChecks.set(plugin, next);
            rerender();
        }));
    }
    box.createEl('p', { text: t.access, cls: 'setting-item-description' });
}
