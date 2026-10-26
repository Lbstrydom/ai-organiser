/**
 * Google Tasks: the user's own lists, the routing rules that pre-select a destination in the review, and the two opt-ins
 * (completion check, note link). Lists are chosen from the user's real Google lists (loaded through the script), never typed as
 * ids. Changing which lists exist changes what the deployed script must approve, so the editor says so and offers the new
 * script; nothing is sent anywhere until the user deploys it.
 */
import { Notice, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { PLUGIN_SECRET_IDS } from '../../core/secretIds';
import { describeError, formatGuidance } from '../../core/friendlyErrors';
import { validateScriptUrl } from '../../services/appsScriptClient';
import { fetchTaskLists, type TaskList } from '../../services/inboxSweep/tasksExportService';
import { allLists, normaliseRoutingRules, resolveTasksLists, updateTasksLists, type Destination, type RoutingRule } from '../../services/inboxSweep/tasksRouting';
import { selectTasksScript } from '../../services/inboxSweep/tasksScriptSelect';
import type { SweepItemKind } from '../../services/prompts/sweepPrompts';
import { logger } from '../../utils/logger';

const loaded = new WeakMap<AIOrganiserPlugin, TaskList[]>();
const KINDS: readonly SweepItemKind[] = ['next_action', 'waiting_for', 'project', 'someday_maybe'];

export function renderTasksListsEditor(container: HTMLElement, plugin: AIOrganiserPlugin, rerender: () => void): void {
    const t = plugin.t;
    const c = t.googleTasks;
    const s = plugin.settings;
    const save = (): void => { void plugin.saveSettings().catch((e: unknown) => logger.error('Sweep', 'Could not save the Google Tasks lists', e)); };

    container.createEl('h4', { text: c.listsTitle });
    container.createEl('p', { text: c.listsHelp, cls: 'setting-item-description' });
    const status = container.createDiv({ cls: 'setting-item-description', attr: { role: 'status' } });

    const { main } = resolveTasksLists(s);
    if (!main) {
        container.createEl('p', { text: c.listsNeedMain, cls: 'setting-item-description' });
        return;
    }
    const known = loaded.get(plugin) ?? [];
    const titleOf = (id: string): string => known.find((l) => l.id === id)?.title || allLists(s).find((l) => l.id === id)?.title || id;

    for (const list of allLists(s)) {
        const row = new Setting(container).setName(titleOf(list.id));
        if (list.id === main.id) row.setDesc(c.mainBadge);
        row.addToggle((tg) => {
            tg.setValue(list.needsDate).onChange((v) => {
                updateTasksLists(s, (lists, mainId) => ({ lists: lists.map((l) => (l.id === list.id ? { ...l, needsDate: v, title: titleOf(l.id) } : l)), mainId }));
                save();
            });
            tg.toggleEl.setAttribute('aria-label', `${c.needsDateName}: ${titleOf(list.id)}`);
        });
        row.nameEl.createSpan({ text: ` · ${c.needsDateName}`, cls: 'setting-item-description' });
        if (list.id !== main.id) {
            row.addExtraButton((b) => b.setIcon('trash').setTooltip(c.removeList).onClick(() => {
                updateTasksLists(s, (lists, mainId) => ({ lists: lists.filter((l) => l.id !== list.id), mainId }));
                save();
                rerender();
            }));
        }
    }

    const candidates = known.filter((l) => !allLists(s).some((x) => x.id === l.id));
    if (candidates.length > 0) {
        let pick = candidates[0].id;
        new Setting(container).setName(c.addList)
            .addDropdown((d) => { for (const l of candidates) d.addOption(l.id, l.title); d.setValue(pick).onChange((v) => { pick = v; }); })
            .addButton((b) => b.setButtonText(c.addList).onClick(() => {
                updateTasksLists(s, (lists, mainId) => ({ lists: [...lists, { id: pick, title: titleOf(pick), needsDate: false }], mainId }));
                save();
                rerender();
            }));
    }
    new Setting(container).addButton((b) => b.setButtonText(c.loadMyLists).onClick(async () => {
        status.setText(c.testing);
        try {
            const url = validateScriptUrl(s.tasksScriptUrl);
            const secret = await plugin.secretStorageService.getSecret(PLUGIN_SECRET_IDS.GOOGLE_TASKS);
            if (!url.ok || !secret) { status.setText(formatGuidance(describeError(t, url.ok ? 'no-secret' : url.error))); return; }
            const res = await fetchTaskLists({ url: url.value, secret });
            if (!res.ok) { status.setText(formatGuidance(describeError(t, res.error))); return; }
            loaded.set(plugin, res.value);
            rerender();
        } catch (e) {
            logger.warn('Sweep', 'Could not load the Google lists', e);
            status.setText(formatGuidance(describeError(t, 'unknown')));
        }
    }));
    // What the deployed script must approve changed: say so, and offer the new script (nothing is sent until it is deployed).
    new Setting(container).setName(c.newScriptName).setDesc(c.newScriptDesc).addButton((b) => b.setButtonText(c.copyNewScript).onClick(async () => {
        try {
            const secret = await plugin.secretStorageService.getSecret(PLUGIN_SECRET_IDS.GOOGLE_TASKS);
            if (!secret) { new Notice(formatGuidance(describeError(t, 'no-secret')), 8000); return; }
            await navigator.clipboard.writeText(selectTasksScript(s, secret, main.id).text);
            new Notice(c.scriptCopied, 8000);
        } catch (e) {
            logger.warn('Sweep', 'Could not copy the script', e);
            new Notice(formatGuidance(describeError(t, 'unknown')), 8000);
        }
    }));

    renderRules(container, plugin);

    new Setting(container).setName(c.readBackName).setDesc(c.readBackDesc).addToggle((tg) => tg.setValue(s.tasksReadBack).onChange((v) => { s.tasksReadBack = v; save(); }));
    new Setting(container).setName(c.noteLinkName).setDesc(c.noteLinkDesc).addToggle((tg) => tg.setValue(s.tasksIncludeNoteLink).onChange((v) => { s.tasksIncludeNoteLink = v; save(); }));
}

/** Routing rules: first match wins; the review only pre-selects, the person decides. */
function renderRules(container: HTMLElement, plugin: AIOrganiserPlugin): void {
    const c = plugin.t.googleTasks;
    const s = plugin.settings;
    container.createEl('h4', { text: c.rulesTitle });
    container.createEl('p', { text: c.rulesHelp, cls: 'setting-item-description' });
    const holder = container.createDiv();
    // Rows are edited as a draft: a half-filled row is not stored.
    let draft: Array<{ kind: SweepItemKind; context: string; dest: string }> = s.tasksRoutingRules.map((r) => ({ kind: r.kind, context: r.context ?? '', dest: r.destination.type === 'list' ? `list:${r.destination.listId}` : 'report-only' }));
    const commit = (): void => {
        // A half-typed or invalid context never overwrites the saved rules: the draft keeps it until it is valid.
        if (draft.some((d) => d.context.trim() !== '' && !/^@[a-z0-9][a-z0-9_-]{0,23}$/.test(d.context.trim()))) return;
        const rules: RoutingRule[] = draft.map((d) => ({
            kind: d.kind,
            ...(d.context.trim() !== '' ? { context: d.context.trim() } : {}),
            destination: (d.dest === 'report-only' ? { type: 'report-only' } : { type: 'list', listId: d.dest.slice(5) }) as Destination,
        }));
        s.tasksRoutingRules = normaliseRoutingRules(rules);
        void plugin.saveSettings().catch((e: unknown) => logger.error('Sweep', 'Could not save the routing rules', e));
    };
    const draw = (): void => {
        holder.empty();
        draft.forEach((row, i) => {
            new Setting(holder)
                .addDropdown((d) => { for (const k of KINDS) d.addOption(k, plugin.t.inboxSweep.kindLabels[k]); d.setValue(row.kind).onChange((v) => { row.kind = v as SweepItemKind; commit(); }); d.selectEl.setAttribute('aria-label', c.ruleKind); })
                .addText((tx) => { tx.setPlaceholder(c.ruleContext).setValue(row.context).onChange((v) => { row.context = v; commit(); }); tx.inputEl.setAttribute('aria-label', c.ruleContext); })
                .addDropdown((d) => {
                    for (const l of allLists(s)) d.addOption(`list:${l.id}`, l.title || l.id);
                    d.addOption('report-only', plugin.t.inboxSweep.destinationReportOnly);
                    d.setValue(row.dest).onChange((v) => { row.dest = v; commit(); });
                    d.selectEl.setAttribute('aria-label', c.ruleDestination);
                })
                .addExtraButton((b) => b.setIcon('trash').setTooltip(c.removeRule).onClick(() => { draft = draft.filter((_, j) => j !== i); draw(); commit(); }));
        });
    };
    draw();
    new Setting(container).addButton((b) => b.setButtonText(c.addRule).onClick(() => {
        const first = allLists(s)[0];
        draft = [...draft, { kind: 'next_action', context: '', dest: first ? `list:${first.id}` : 'report-only' }];
        draw();
    }));
}
