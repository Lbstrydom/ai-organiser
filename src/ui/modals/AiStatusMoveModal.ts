/**
 * Review for "Move AI status marks to aio-status": every note and dashboard that would change, grouped by folder, each
 * with its own checkbox (and one per folder). Nothing is written until Apply. Ticked items are applied one file at a time;
 * one that changed since the scan is skipped and counted.
 */
import { App, Modal, Notice } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { listen } from '../utils/domUtils';
import { applyAiStatusMoves, scanAiStatusMoves, type AiStatusMoveItem } from '../../services/aiStatusMove';

const folderOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '/');

export class AiStatusMoveModal extends Modal {
    private cleanups: (() => void)[] = [];
    private items: AiStatusMoveItem[] = [];
    private chosen = new Set<string>();
    private applying = false;

    constructor(app: App, private plugin: AIOrganiserPlugin) {
        super(app);
    }

    onOpen(): void {
        const t = this.plugin.t.modals.aiStatusMove;
        this.titleEl.setText(t.title);
        this.contentEl.addClass('ai-organiser-modal-content', 'ai-organiser-ai-status-move');
        this.contentEl.createEl('p', { text: t.scanning });
        void scanAiStatusMoves(this.app).then((res) => {
            if (!res.ok) { this.contentEl.empty(); this.contentEl.createEl('p', { text: t.scanFailed }); return; }
            this.items = res.value;
            this.chosen = new Set(this.items.map((i) => i.path));
            this.render();
        });
    }

    onClose(): void {
        for (const c of this.cleanups) c();
        this.cleanups = [];
        this.contentEl.empty();
    }

    private render(): void {
        const t = this.plugin.t.modals.aiStatusMove;
        for (const c of this.cleanups) c();
        this.cleanups = [];
        const el = this.contentEl;
        el.empty();
        if (this.items.length === 0) {
            el.createEl('p', { text: t.nothing });
            return;
        }
        el.createEl('p', { cls: 'setting-item-description', text: t.intro });
        const notes = this.items.filter((i) => i.kind === 'note');
        const dashboards = this.items.filter((i) => i.kind === 'dashboard');
        if (notes.length) {
            el.createEl('h4', { text: t.notesHeading.replace('{n}', String(notes.length)) });
            const byFolder = new Map<string, AiStatusMoveItem[]>();
            for (const n of notes) byFolder.set(folderOf(n.path), [...(byFolder.get(folderOf(n.path)) ?? []), n]);
            for (const [folder, group] of byFolder) this.renderGroup(el, folder, group);
        }
        if (dashboards.length) {
            el.createEl('h4', { text: t.dashboardsHeading.replace('{n}', String(dashboards.length)) });
            el.createEl('p', { cls: 'setting-item-description', text: t.dashboardsIntro });
            this.renderGroup(el, '', dashboards);
        }
        const actions = el.createDiv({ cls: 'modal-button-container' });
        const cancel = actions.createEl('button', { text: t.cancel });
        const apply = actions.createEl('button', { cls: 'mod-cta', text: t.apply.replace('{n}', String(this.chosen.size)) });
        apply.disabled = this.chosen.size === 0;
        this.cleanups.push(listen(cancel, 'click', () => this.close()));
        this.cleanups.push(listen(apply, 'click', () => { void this.apply(); }));
    }

    private renderGroup(el: HTMLElement, folder: string, group: AiStatusMoveItem[]): void {
        const t = this.plugin.t.modals.aiStatusMove;
        const box = el.createDiv({ cls: 'ai-organiser-ai-status-move-group' });
        if (folder) {
            const head = box.createEl('label', { cls: 'ai-organiser-ai-status-move-folder' });
            const all = head.createEl('input', { type: 'checkbox' });
            all.checked = group.every((i) => this.chosen.has(i.path));
            head.appendText(` ${folder} (${group.length})`);
            this.cleanups.push(listen(all, 'change', () => {
                for (const i of group) { if (all.checked) this.chosen.add(i.path); else this.chosen.delete(i.path); }
                this.render();
            }));
        }
        for (const item of group) {
            const row = box.createEl('label', { cls: 'ai-organiser-ai-status-move-item' });
            const cb = row.createEl('input', { type: 'checkbox' });
            cb.checked = this.chosen.has(item.path);
            const name = item.path.split('/').pop() ?? item.path;
            const what = item.kind === 'dashboard' ? t.dashboardLine
                : item.becomesActive ? t.projectLine.replace('{mark}', item.mark ?? '')
                : t.noteLine.replace('{mark}', item.mark ?? '');
            row.appendText(` ${item.kind === 'dashboard' ? item.path : name}: ${what}`);
            this.cleanups.push(listen(cb, 'change', () => {
                if (cb.checked) this.chosen.add(item.path); else this.chosen.delete(item.path);
                this.render();
            }));
        }
    }

    private async apply(): Promise<void> {
        if (this.applying) return;
        this.applying = true;
        const t = this.plugin.t.modals.aiStatusMove;
        const res = await applyAiStatusMoves(this.app, this.items.filter((i) => this.chosen.has(i.path)));
        this.applying = false;
        if (!res.ok) { new Notice(t.scanFailed, 8000); return; }
        const { moved, skipped, failed } = res.value;
        new Notice(t.done.replace('{moved}', String(moved.length)).replace('{skipped}', String(skipped.length)).replace('{failed}', String(failed.length)), 9000);
        this.close();
    }
}
