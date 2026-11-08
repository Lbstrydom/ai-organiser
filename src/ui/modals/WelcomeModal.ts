/**
 * First-run welcome (docs/plans/navigation-discoverability.md, Phase 5): three ways in. Shown
 * once on a new install; any button or closing it marks it seen. Reopened by the
 * "Open the welcome window" action in Setup and tools.
 */
import { App, ButtonComponent, Modal, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';

export interface WelcomeActions {
    jobs: () => void;
    setupAi: () => void;
    browse: () => void;
    /** Called once when the window closes, however it closes. */
    seen: () => void;
}

export class WelcomeModal extends Modal {
    constructor(app: App, private readonly plugin: AIOrganiserPlugin, private readonly actions: WelcomeActions) { super(app); }

    onOpen(): void {
        const w = this.plugin.t.welcome;
        this.titleEl.setText(w.title);
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('p', { text: w.intro });
        let first: ButtonComponent | null = null;
        const row = (name: string, desc: string, go: () => void, cta = false): void => {
            new Setting(contentEl).setName(name).setDesc(desc).addButton((b) => {
                b.setButtonText(name).onClick(() => { this.close(); go(); });
                if (cta) b.setCta();
                first ??= b;
            });
        };
        row(w.jobs, w.jobsDesc, this.actions.jobs, true);
        row(w.setupAi, w.setupAiDesc, this.actions.setupAi);
        row(w.browse, w.browseDesc, this.actions.browse);
        // Focus starts on the first way in; Obsidian's modal returns focus on close.
        const button = first as ButtonComponent | null;
        if (button) window.setTimeout(() => button.buttonEl.focus(), 0);
    }

    onClose(): void {
        this.contentEl.empty();
        this.actions.seen();
    }
}
