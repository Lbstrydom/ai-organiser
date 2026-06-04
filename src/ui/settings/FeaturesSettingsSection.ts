import { App, Modal, Notice, Setting, ToggleComponent } from 'obsidian';
import { BaseSettingSection } from './BaseSettingSection';
import {
    FEATURE_REGISTRY,
    FEATURE_CLUSTERS,
    FEATURE_BY_ID,
    type FeatureId,
    type FeatureCluster,
} from '../../core/features';
import {
    isFeatureEnabled,
    resolveEnable,
    resolveDisable,
    dependentsOf,
} from '../../services/featureService';

/** Lucide icon per cluster (UX §6 — common-region grouping). */
const CLUSTER_ICON: Record<FeatureCluster, string> = {
    core: 'lock',
    create: 'sparkles',
    'vault-intel': 'brain',
    'audio-meetings': 'mic',
    visualise: 'palette',
    capture: 'scan',
    'add-ons': 'puzzle',
};

/**
 * Features settings section (FT-5/FT-6/FT-8) — the single writer of `featureFlags` and the
 * sole trigger of `applyFeatureFlags`. Grouped by cluster; core toggles are locked ("always
 * on"). Enabling auto-enables transitive `requires` (with an "also enabled" notice);
 * disabling a feature with enabled dependents prompts a cascade-confirm.
 */
export class FeaturesSettingsSection extends BaseSettingSection {
    display(): void {
        for (const cluster of FEATURE_CLUSTERS) {
            const features = FEATURE_REGISTRY.filter((f) => f.cluster === cluster);
            if (features.length === 0) continue;
            this.createSectionHeader(this.plugin.t.features.clusters[cluster], CLUSTER_ICON[cluster], 2);
            for (const def of features) this.renderToggle(def.id);
        }
    }

    private renderToggle(id: FeatureId): void {
        const def = FEATURE_BY_ID[id];
        const t = this.plugin.t.features;
        const setting = new Setting(this.containerEl)
            .setName(this.resolveCopy(def.labelKey))
            .setDesc(this.resolveCopy(def.descKey));
        setting.addToggle((toggle) => {
            toggle.setValue(isFeatureEnabled(this.plugin.settings, id));
            if (def.core) {
                // Core features can't be disabled — lock the toggle + caption it (FT-6).
                toggle.setDisabled(true);
                setting.descEl.createSpan({
                    cls: 'ai-organiser-feature-always-on',
                    text: ` (${t.alwaysOn})`,
                });
                return;
            }
            toggle.onChange((value) => {
                if (value) this.handleEnable(id);
                else this.handleDisable(id, toggle);
            });
        });
    }

    /** Enable `id` + its transitive requires; surface the auto-enabled deps (FT-8). */
    private handleEnable(id: FeatureId): void {
        const { flags, also } = resolveEnable(this.plugin.settings.featureFlags, id);
        if (also.length > 0) {
            const names = also.map((d) => this.resolveCopy(FEATURE_BY_ID[d].labelKey)).join(', ');
            new Notice(this.plugin.t.features.alsoEnabled.replace('{features}', names), 6000);
        }
        void this.plugin.applyFeatureFlags(flags);
    }

    /** Disable `id`; if enabled dependents exist, confirm the cascade first (FT-8). */
    private handleDisable(id: FeatureId, toggle: ToggleComponent): void {
        const dependents = dependentsOf(this.plugin.settings, id);
        if (dependents.length === 0) {
            void this.plugin.applyFeatureFlags(resolveDisable(this.plugin.settings, id).flags);
            return;
        }
        const t = this.plugin.t.features;
        const depNames = dependents.map((d) => this.resolveCopy(FEATURE_BY_ID[d].labelKey)).join(', ');
        new FeatureDisableConfirmModal(this.plugin.app, {
            title: t.disableConfirmTitle,
            body: t.disableConfirmBody
                .replace('{feature}', this.resolveCopy(FEATURE_BY_ID[id].labelKey))
                .replace('{dependents}', depNames),
            confirmText: t.disableConfirmConfirm,
            cancelText: t.cancel,
            onConfirm: () => { void this.plugin.applyFeatureFlags(resolveDisable(this.plugin.settings, id).flags); },
            // Cancel → revert the visual toggle; no flag write, no re-render.
            onCancel: () => { toggle.setValue(true); },
        }).open();
    }

    /**
     * Resolve a registry `labelKey`/`descKey` dotted path (e.g. `features.smart-note.label`)
     * into `this.plugin.t`. Falls back to the raw path — a visible signal of a missing key
     * (the registry-completeness test also guards label/desc resolution).
     */
    private resolveCopy(path: string): string {
        let cur: unknown = this.plugin.t;
        for (const part of path.split('.')) {
            if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
                cur = (cur as Record<string, unknown>)[part];
            } else {
                return path;
            }
        }
        return typeof cur === 'string' ? cur : path;
    }
}

interface ConfirmOptions {
    title: string;
    body: string;
    confirmText: string;
    cancelText: string;
    onConfirm: () => void;
    onCancel: () => void;
}

/** Minimal cascade-disable confirm. Default close (Esc / X) is treated as cancel. */
class FeatureDisableConfirmModal extends Modal {
    private readonly opts: ConfirmOptions;
    private decided = false;

    constructor(app: App, opts: ConfirmOptions) {
        super(app);
        this.opts = opts;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: this.opts.title });
        contentEl.createEl('p', { text: this.opts.body });
        new Setting(contentEl)
            .addButton((b) => b
                .setButtonText(this.opts.cancelText)
                .onClick(() => this.close()))
            .addButton((b) => b
                .setButtonText(this.opts.confirmText)
                .setWarning()
                .onClick(() => { this.decided = true; this.opts.onConfirm(); this.close(); }));
    }

    onClose(): void {
        // Esc / X / cancel button → revert. The confirm button sets `decided` first.
        if (!this.decided) this.opts.onCancel();
        this.contentEl.empty();
    }
}
