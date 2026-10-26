import { App, Modal, Notice, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { describeError, formatGuidance } from '../../core/friendlyErrors';
import { MAX_CHATS, MAX_CONTEXT_SOURCES, validateChatUrl, type ChatApp, type WorkspaceRecord } from '../../services/aiWorkspaces/workspaceRecord';
import { getWorkspace, saveWorkspace } from '../../services/aiWorkspaces/workspaceService';
import { logger } from '../../utils/logger';

interface DraftChat { id: string; app: ChatApp; name: string; url: string }

/**
 * Edit the AI workspace of one project: its chat projects (Claude or ChatGPT addresses), the extra notes that feed its pack,
 * and the released mark. Rows are a draft; the record is stored only on Save, and a bad address is said so, never silently dropped.
 */
export class AiWorkspaceModal extends Modal {
    private chats: DraftChat[] = [];
    private sources: string[] = [];
    private released = false;
    private problem: HTMLElement | null = null;

    constructor(app: App, private readonly plugin: AIOrganiserPlugin, private readonly aioId: string) {
        super(app);
    }

    onOpen(): void {
        const record = getWorkspace(this.plugin, this.aioId);
        this.chats = record.chats.map((c) => ({ ...c }));
        this.sources = [...record.contextSources];
        this.released = record.released;
        this.containerEl.addClass('ai-organiser-modal-container');
        this.draw();
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private draw(): void {
        const t = this.plugin.t.aiWorkspaces;
        const el = this.contentEl;
        el.empty();
        el.createEl('h3', { text: t.editTitle, cls: 'ai-organiser-modal-title' });

        el.createEl('h4', { text: t.chatsHeading });
        if (this.chats.length === 0) el.createDiv({ text: t.chatsNone, cls: 'setting-item-description' });
        this.chats.forEach((chat, i) => {
            new Setting(el)
                .addDropdown((d) => {
                    d.addOption('claude', t.chatApps.claude).addOption('chatgpt', t.chatApps.chatgpt).setValue(chat.app).onChange((v) => { chat.app = v as ChatApp; });
                    d.selectEl.setAttribute('aria-label', t.chatAppLabel);
                })
                .addText((tx) => { tx.setPlaceholder(t.chatNameLabel).setValue(chat.name).onChange((v) => { chat.name = v; }); tx.inputEl.setAttribute('aria-label', t.chatNameLabel); })
                .addText((tx) => { tx.setPlaceholder(t.chatUrlLabel).setValue(chat.url).onChange((v) => { chat.url = v; }); tx.inputEl.setAttribute('aria-label', t.chatUrlLabel); })
                .addExtraButton((b) => b.setIcon('trash').setTooltip(t.chatRemove).onClick(() => { this.chats.splice(i, 1); this.draw(); }));
        });
        if (this.chats.length < MAX_CHATS) {
            new Setting(el).addButton((b) => b.setButtonText(t.addChat).onClick(() => {
                this.chats.push({ id: crypto.randomUUID(), app: 'claude', name: '', url: '' });
                this.draw();
            }));
        }

        el.createEl('h4', { text: t.sourcesHeading });
        el.createDiv({ text: t.sourcesDesc, cls: 'setting-item-description' });
        this.sources.forEach((path, i) => {
            new Setting(el)
                .addText((tx) => { tx.setPlaceholder(t.sourcePlaceholder).setValue(path).onChange((v) => { this.sources[i] = v; }); tx.inputEl.setAttribute('aria-label', t.sourcePlaceholder); })
                .addExtraButton((b) => b.setIcon('trash').setTooltip(t.removeSource).onClick(() => { this.sources.splice(i, 1); this.draw(); }));
        });
        if (this.sources.length < MAX_CONTEXT_SOURCES) {
            new Setting(el).addButton((b) => b.setButtonText(t.addSource).onClick(() => { this.sources.push(''); this.draw(); }));
        }

        new Setting(el).setName(t.releasedName).addToggle((tg) => tg.setValue(this.released).onChange((v) => { this.released = v; }));

        this.problem = el.createDiv({ cls: 'setting-item-description ai-organiser-capture-warning', attr: { role: 'status' } });
        new Setting(el)
            .addButton((b) => b.setButtonText(t.cancel).onClick(() => this.close()))
            .addButton((b) => b.setCta().setButtonText(t.save).onClick(() => { void this.save(); }));
    }

    private async save(): Promise<void> {
        const t = this.plugin.t.aiWorkspaces;
        const chats: WorkspaceRecord['chats'] = [];
        for (const chat of this.chats) {
            // An empty row is a row the person never filled in; a filled one with a wrong address is an error to say out loud.
            if (chat.url.trim() === '' && chat.name.trim() === '') continue;
            const url = validateChatUrl(chat.app, chat.url);
            if (!url) { this.problem?.setText(formatGuidance(describeError(this.plugin.t, 'workspace-chat-url-invalid'))); return; }
            chats.push({ id: chat.id, app: chat.app, name: chat.name.trim(), url });
        }
        const current = getWorkspace(this.plugin, this.aioId);
        try {
            const res = await saveWorkspace(this.plugin, { ...current, chats, contextSources: this.sources.map((s) => s.trim()).filter((s) => s !== ''), released: this.released });
            if (!res.ok && res.error !== 'rejected') { new Notice(formatGuidance(describeError(this.plugin.t, res.error)), 9000); return; }
            new Notice(t.workspaceSavedNotice, 5000);
            this.close();
        } catch (e) {
            logger.error('AiWorkspaces', 'Could not save the workspace', e);
            new Notice(formatGuidance(describeError(this.plugin.t, 'unknown')), 9000);
        }
    }
}
