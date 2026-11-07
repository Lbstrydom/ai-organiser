/**
 * Google Tasks: the user's own lists, the routing rules that pre-select a destination in the review, and the two opt-ins
 * (completion check, note link). Lists are chosen from the user's real Google lists (loaded through the script), never typed as
 * ids. Changing which lists exist changes what the deployed script must approve, so the editor says so and offers the new
 * script; nothing is sent anywhere until the user deploys it.
 */
import { Notice, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { PLUGIN_SECRET_IDS } from '../../core/secretIds';
import { copyAutomaticScript, copyScriptForDeployment } from '../../commands/googleScriptCommands';
import { approveConfiguredLists } from '../../services/inboxSweep/tasksAutoLists';
import { describeError, formatGuidance } from '../../core/friendlyErrors';
import { validateScriptUrl } from '../../services/appsScriptClient';
import { fetchTaskLists, type TaskList } from '../../services/inboxSweep/tasksExportService';
import { allLists, normaliseRoutingRules, resolveTasksLists, updateTasksLists, type Destination, type RoutingRule } from '../../services/inboxSweep/tasksRouting';
import type { SweepItemKind } from '../../services/prompts/sweepPrompts';
import { logger } from '../../utils/logger';

const loaded = new WeakMap<AIOrganiserPlugin, TaskList[]>();
const KINDS: readonly SweepItemKind[] = ['next_action', 'waiting_for', 'project', 'someday_maybe'];

export function renderTasksListsEditor(container: HTMLElement, plugin: AIOrganiserPlugin, rerender: () => void): void {
    const t = plugin.t;
    const c = t.googleTasks;
    const s = plugin.settings;
    const save = (): void => { void plugin.saveSettings().catch((e: unknown) => logger.error('Sweep', 'Could not save the Google Tasks lists', e)); };
    /** Approve the configured lists: only ever from something the person just did on this page. */
    const approve = async (): Promise<void> => {
        const res = await approveConfiguredLists(plugin);
        new Notice(res.ok ? c.listsApproved : formatGuidance(describeError(t, res.error)), 9000);
        rerender();
    };

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
        // The label sits right beside the switch, so it reads as what the switch does and not as a fact about the list.
        row.controlEl.createSpan({ text: c.needsDateName, cls: 'setting-item-description' });
        row.addToggle((tg) => {
            tg.setValue(list.needsDate).onChange((v) => {
                updateTasksLists(s, (lists, mainId) => ({ lists: lists.map((l) => (l.id === list.id ? { ...l, needsDate: v, title: titleOf(l.id) } : l)), mainId }));
                save();
            });
            tg.toggleEl.setAttribute('aria-label', `${c.needsDateName}: ${titleOf(list.id)}`);
        });
        if (list.id !== main.id) {
            row.addExtraButton((b) => b.setIcon('trash').setTooltip(c.removeList).onClick(() => {
                updateTasksLists(s, (lists, mainId) => ({ lists: lists.filter((l) => l.id !== list.id), mainId }));
                save();
                rerender();
                if (s.tasksAutoLists) void approve();
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
                if (s.tasksAutoLists) void approve();
            }));
    }
    new Setting(container).setName(c.loadListsName).setDesc(c.loadListsDesc).addButton((b) => b.setButtonText(c.loadMyLists).onClick(async () => {
        status.setText(c.testing);
        try {
            const url = validateScriptUrl(s.tasksScriptUrl);
            const secret = await plugin.secretStorageService.getSecret(PLUGIN_SECRET_IDS.GOOGLE_TASKS);
            if (!url.ok || !secret) { status.setText(formatGuidance(describeError(t, url.ok ? 'tasks-no-secret' : url.error))); return; }
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
    // Automatic lists need no paste for a list change: the plugin approves them, so the Copy script row is replaced.
    // Adding or removing a list already approves the new set, so approving again is a repair (lists changed on another
    // device, or a send held a list as not approved): kept reachable, folded away so it does not read as a second step.
    if (s.tasksAutoLists) {
        const repair = container.createEl('details', { cls: 'ai-organiser-advanced-group' });
        repair.createEl('summary', { text: c.repairListsTitle });
        new Setting(repair).setName(c.autoListsName).setDesc(c.autoListsDesc).addButton((b) => b.setButtonText(c.approveLists).onClick(() => { void approve(); }));
    } else {
        new Setting(container).setName(c.newScriptName).setDesc(c.newScriptDesc).addButton((b) => b.setButtonText(c.copyNewScript).onClick(async () => {
            try {
                await copyScriptForDeployment(plugin, main.id);
            } catch (e) {
                logger.warn('Sweep', 'Could not copy the script', e);
                new Notice(formatGuidance(describeError(t, 'unknown')), 8000);
            }
        }));
        if (s.tasksScriptUrl) {
            new Setting(container).setName(c.switchName).setDesc(c.switchDesc)
                .addButton((b) => b.setButtonText(c.switchCopy).onClick(() => { void copyAutomaticScript(plugin, c.switchCopied); }))
                .addButton((b) => b.setButtonText(c.switchFinish).onClick(() => { void approve(); }));
        }
    }

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
    const problem = container.createDiv({ cls: 'setting-item-description ai-organiser-capture-warning', attr: { role: 'status' } });
    problem.hide();
    // Rows are edited as a draft: a half-filled row is not stored.
    let draft: Array<{ kind: SweepItemKind; context: string; dest: string }> = s.tasksRoutingRules.map((r) => ({ kind: r.kind, context: r.context ?? '', dest: r.destination.type === 'list' ? `list:${r.destination.listId}` : 'report-only' }));
    const commit = (): void => {
        // A half-typed or invalid context never overwrites the saved rules: the draft keeps it until it is valid.
        const invalid = draft.filter((d) => d.context.trim() !== '' && !/^@[a-z0-9][a-z0-9_-]{0,23}$/.test(d.context.trim()));
        problem.setText(invalid.length > 0 ? c.ruleContextInvalid.replace('{contexts}', invalid.map((d) => d.context.trim()).join(', ')) : '');
        problem.toggle(invalid.length > 0);
        if (invalid.length > 0) return;
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
