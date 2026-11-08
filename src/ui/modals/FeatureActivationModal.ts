/**
 * Turn on a feature chosen from the picker's "Available to turn on" block
 * (docs/plans/navigation-discoverability.md, decision 3).
 *
 * Shows what the feature does, every action it adds, the features turned on with it (named,
 * never silent), the setup it needs, and one "Turn on and reload" button. Turning on writes
 * the flags and the resume intent in one save, then reloads AI Organiser; after the reload the
 * chosen action is offered, never run. Cancel writes nothing.
 */
import { App, ButtonComponent, Modal, Notice, Platform } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { actionName } from '../../core/actionRegistry';
import { applyActivation, featureToActivate, planActivation, type ActivationPlan } from '../../services/featureActivation';
import { reloadSelf } from '../../services/pluginLifecycle';
import { describeError, formatGuidance } from '../../core/friendlyErrors';
import type { FeatureId } from '../../core/features';

export class FeatureActivationModal extends Modal {
    private busy = false;

    constructor(app: App, private readonly plugin: AIOrganiserPlugin, private readonly actionId: string) {
        super(app);
    }

    onOpen(): void {
        const t = this.plugin.t;
        const a = t.activation;
        const feature = featureToActivate(this.actionId);
        if (!feature) { this.close(); return; }
        const plan = planActivation(this.plugin.settings.featureFlags, feature, Platform.isMobile);
        const label = (id: FeatureId): string => t.features[id].label;

        this.modalEl.addClass('ai-organiser-activation-modal');
        this.titleEl.setText(a.title.replace('{feature}', label(feature)));
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('p', { text: t.features[feature].desc });

        this.section(a.addsHeading, plan.adds.map((d) => actionName(t, d.id)));
        if (plan.also.length > 0) this.section(a.alsoHeading, plan.also.map(label));
        this.section(a.setupHeading, plan.setup.length > 0
            ? plan.setup.map((d) => a.setupStep.replace('{action}', actionName(t, d.id)))
            : [a.setupNone]);

        if (plan.blocked === 'desktop-only') {
            contentEl.createEl('p', { cls: 'mod-warning', text: a.desktopOnly.replace('{feature}', label(feature)) });
        } else {
            contentEl.createEl('p', { cls: 'setting-item-description', text: a.reloadNote });
        }

        const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
        new ButtonComponent(buttons).setButtonText(a.cancel).onClick(() => this.close());
        if (!plan.blocked) {
            const turnOn = new ButtonComponent(buttons).setButtonText(a.turnOn).setCta();
            turnOn.onClick(() => { void this.turnOn(plan, turnOn); });
            // Focus the primary action; Obsidian's modal traps focus and returns it on close.
            window.setTimeout(() => turnOn.buttonEl.focus(), 0);
        }
    }

    private section(heading: string, items: readonly string[]): void {
        const block = this.contentEl.createDiv({ cls: 'ai-organiser-activation-section' });
        block.createEl('h4', { text: heading });
        const list = block.createEl('ul');
        for (const item of items) list.createEl('li', { text: item });
    }

    private async turnOn(plan: ActivationPlan, button: ButtonComponent): Promise<void> {
        if (this.busy) return;
        this.busy = true;
        const t = this.plugin.t;
        button.setDisabled(true).setButtonText(t.activation.busy);
        const saved = await applyActivation(this.plugin, plan, {
            v: 1, kind: 'action', commandId: this.actionId, createdAt: Date.now(),
        });
        if (!saved.ok) {
            this.busy = false;
            button.setDisabled(false).setButtonText(t.activation.turnOn);
            new Notice(t.features.saveError, 6000);
            return;
        }
        this.plugin.featureReloadPending = true;
        this.close();
        const reenableFailed = formatGuidance(describeError(t, 'activation-reenable-failed'));
        const reload = reloadSelf(this.app, this.plugin.manifest.id, reenableFailed);
        if (!reload.ok) new Notice(formatGuidance(describeError(t, reload.error)), 0);
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
