import { App, Modal, Notice, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { describeError, formatGuidance } from '../../core/friendlyErrors';
import { applyHandback, type PreparedHandback, type ReviewActions } from '../../services/aiWorkspaces/handbackService';
import type { HandoffSection } from '../../services/aiWorkspaces/handoffParser';
import { plural } from '../../utils/plural';
import { refreshProcessViews } from '../views/processRefresh';
import { logger } from '../../utils/logger';

const SECTION_ORDER: readonly HandoffSection[] = ['decisions', 'actions', 'deliverables', 'questions'];

/**
 * The hand-back review: suggest a project (pre-selected only when clearly ahead), one row per item, nothing ticked for you.
 * Deliverables are listed but not filed in this version. Applying changes only what is ticked.
 */
export class HandbackReviewModal extends Modal {
    private projectId = '';
    private rememberChat = true;
    private readonly ticked = new Set<string>();
    private busy = false;

    constructor(app: App, private readonly plugin: AIOrganiserPlugin, private readonly prepared: PreparedHandback, private readonly reviewActions: ReviewActions) {
        super(app);
    }

    onOpen(): void {
        this.projectId = this.prepared.match.exact?.aioId ?? this.prepared.match.preselect?.aioId ?? '';
        this.containerEl.addClass('ai-organiser-modal-container');
        this.draw();
    }

    onClose(): void {
        this.contentEl.empty();
        refreshProcessViews(this.app);
    }

    private draw(): void {
        const t = this.plugin.t.handback;
        const { parse, match } = this.prepared;
        const el = this.contentEl;
        el.empty();
        el.createEl('h3', { text: t.title, cls: 'ai-organiser-modal-title' });
        el.createDiv({ text: this.prepared.notePath, cls: 'setting-item-description' });

        if (parse.status === 'malformed') {
            el.createEl('p', { text: t.malformedIntro });
            const list = el.createEl('ul');
            for (const r of parse.reasons) list.createEl('li', { text: t.malformedReasons[r] });
            new Setting(el).addButton((b) => b.setButtonText(t.close).onClick(() => this.close()));
            return;
        }

        // Project
        const ranked = match.ranked;
        const why = match.exact ? t.whyId : match.preselect ? t.whyReason[ranked.find((r) => r.project.aioId === match.preselect?.aioId)?.reason ?? 'title'] : '';
        const projectSetting = new Setting(el).then((row) => row.settingEl.addClass('ai-organiser-wrap-row')).setName(t.projectName).setDesc(match.rejected ? t.rejected[match.rejected] : why || (ranked.length > 0 ? t.chooseProject : t.noCandidate));
        projectSetting.addDropdown((d) => {
            d.addOption('', t.notChosen);
            const seen = new Set<string>();
            for (const r of ranked) { d.addOption(r.project.aioId, `${r.project.notePath} (${Math.round(r.score * 100)}%)`); seen.add(r.project.aioId); }
            for (const project of this.prepared.projects) if (!seen.has(project.aioId)) d.addOption(project.aioId, project.notePath);
            d.setValue(this.projectId).onChange((v) => { this.projectId = v; this.draw(); });
            d.selectEl.setAttribute('aria-label', t.projectName);
        });
        if (parse.chat && this.projectId !== '') {
            new Setting(el).setName(t.rememberName.replace('{chat}', parse.chat.name)).addToggle((tg) => tg.setValue(this.rememberChat).onChange((v) => { this.rememberChat = v; }));
        }

        // Items
        for (const section of SECTION_ORDER) {
            const rows = this.prepared.items.filter((i) => i.item.section === section);
            const more = parse.more[section] ?? 0;
            if (rows.length === 0 && more === 0) continue;
            el.createEl('h4', { text: t.sections[section] });
            for (const row of rows) {
                const done = row.state === 'applied';
                const s = new Setting(el).setName(row.item.text).setDesc(done ? t.itemDone : row.item.longItem ? t.longItem : '');
                if (section === 'deliverables') { s.setDesc(t.deliverableNote); continue; }
                s.addToggle((tg) => {
                    tg.setValue(this.ticked.has(row.id)).setDisabled(done).onChange((v) => { if (v) this.ticked.add(row.id); else this.ticked.delete(row.id); });
                    tg.toggleEl.setAttribute('aria-label', row.item.text);
                });
            }
            if (more > 0) el.createDiv({ text: plural(t.moreItems, more), cls: 'setting-item-description' });
        }
        if (parse.warnings.length > 0) {
            el.createDiv({ text: plural(t.warnings, parse.warnings.length), cls: 'setting-item-description' });
            const list = el.createEl('ul', { cls: 'setting-item-description' });
            for (const w of parse.warnings) list.createEl('li', { text: t.warningLines[w.code].replace('{detail}', w.detail) });
        }

        new Setting(el)
            .addButton((b) => b.setButtonText(t.cancel).onClick(() => this.close()))
            .addButton((b) => b.setCta().setButtonText(t.apply).onClick(() => { void this.apply(); }));
    }

    private async apply(): Promise<void> {
        const t = this.plugin.t.handback;
        if (this.busy) return;
        if (this.projectId === '') { new Notice(t.chooseFirst, 6000); return; }
        if (this.ticked.size === 0) { new Notice(t.nothingTicked, 6000); return; }
        this.busy = true;
        try {
            const res = await applyHandback(this.plugin, this.prepared, { projectId: this.projectId, ticked: this.ticked, rememberChat: this.rememberChat }, this.reviewActions);
            if (!res.ok) { new Notice(formatGuidance(describeError(this.plugin.t, res.error)), 9000); return; }
            const o = res.value;
            new Notice(plural(t.appliedNotice, o.applied).replace('{failed}', String(o.failed)), 7000);
            if (o.error) new Notice(formatGuidance(describeError(this.plugin.t, o.error)), 9000);
            this.close();
        } catch (e) {
            logger.error('AiWorkspaces', 'Hand-back apply failed', e);
            new Notice(formatGuidance(describeError(this.plugin.t, 'unknown')), 9000);
        } finally {
            this.busy = false;
        }
    }
}
