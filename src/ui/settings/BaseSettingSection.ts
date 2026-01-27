import { setIcon, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import type { AdapterType } from '../../services/adapters';

export interface ApiKeyFieldOptions {
    name: string;
    desc: string;
    secretId: string;
    provider?: AdapterType;
    currentValue?: string;
    placeholder?: string;
    onChange: (value: string) => void;
    testCallback?: () => Promise<boolean>;
}

export abstract class BaseSettingSection {
    protected plugin: AIOrganiserPlugin;
    protected containerEl: HTMLElement;
    protected settingTab: AIOrganiserSettingTab;

    constructor(plugin: AIOrganiserPlugin, containerEl: HTMLElement, settingTab: AIOrganiserSettingTab) {
        this.plugin = plugin;
        this.containerEl = containerEl;
        this.settingTab = settingTab;
    }

    /**
     * Creates a section header with an icon
     * @param title - The header text
     * @param icon - Lucide icon name (e.g., 'bot', 'tag', 'search')
     * @param level - Header level (1 or 2), defaults to 1
     * @param container - Optional container element, defaults to this.containerEl
     */
    protected createSectionHeader(title: string, icon: string, level: 1 | 2 = 1, container?: HTMLElement): HTMLElement {
        const targetEl = container || this.containerEl;
        const headerEl = targetEl.createEl(level === 1 ? 'h1' : 'h2', { cls: 'ai-organiser-settings-header' });

        const iconEl = headerEl.createSpan({ cls: 'ai-organiser-settings-header-icon' });
        setIcon(iconEl, icon);

        headerEl.createSpan({ text: title });

        return headerEl;
    }

    /**
     * Renders an API key field with SecretStorage integration
     * Uses OS keychain (SecretComponent) on Obsidian 1.11+ or falls back to password field
     */
    protected renderApiKeyField(options: ApiKeyFieldOptions): Setting {
        const { name, desc, secretId, currentValue, onChange, testCallback, placeholder } = options;
        const t = this.plugin.t.settings;
        const secretStorage = this.plugin.secretStorageService;

        const setting = new Setting(this.containerEl)
            .setName(name)
            .setDesc(desc);

        const useSecretStorage = secretStorage.isAvailable();
        const placeholderText = placeholder || t.secretStorage.apiKeyPlaceholder;
        const supportsSecretComponent = useSecretStorage && typeof (setting as any).addSecret === 'function';

        if (useSecretStorage) {
            // Check key status asynchronously
            secretStorage.hasSecret(secretId).then((hasKey) => {
                // Add status indicator
                const statusEl = setting.nameEl.createSpan({
                    cls: hasKey ? 'ai-organiser-key-status-set' : 'ai-organiser-key-status-empty',
                    text: hasKey ? t.secretStorage.keyConfigured : t.secretStorage.noKeySet
                });
                statusEl.style.marginLeft = '8px';
                statusEl.style.fontSize = '0.9em';
            });

            // Add device-only badge
            const deviceBadge = setting.nameEl.createSpan({
                cls: 'ai-organiser-device-badge',
                text: t.secretStorage.deviceOnly
            });
            deviceBadge.style.fontSize = '0.8em';
            deviceBadge.style.color = 'var(--text-muted)';
            deviceBadge.style.marginLeft = '8px';
        }

        if (supportsSecretComponent) {
            // Use native SecretComponent on Obsidian 1.11+
            (setting as any).addSecret((secret: any) => {
                secret.setSecretId(secretId);
                secret.setPlaceholder(placeholderText);
            });
        } else {
            // Use password field (works for all Obsidian versions)
            setting.addText((text) => {
                text
                    .setPlaceholder(placeholderText)
                    .setValue(useSecretStorage ? '' : (currentValue || ''))
                    .onChange(async (value) => {
                        if (useSecretStorage) {
                            if (value) {
                                await secretStorage.setSecret(secretId, value);
                                onChange('');
                                text.setValue('');
                            }
                            return;
                        }
                        onChange(value);
                    });
                text.inputEl.type = 'password';
            });
        }

        // Add "Test Key" button if callback provided
        if (testCallback) {
            setting.addButton((btn) => {
                btn
                    .setButtonText(t.secretStorage.testKey)
                    .onClick(async () => {
                        btn.setDisabled(true);
                        btn.setButtonText(t.secretStorage.testing);
                        try {
                            const success = await testCallback();
                            btn.setButtonText(success ? t.secretStorage.valid : t.secretStorage.invalid);
                            setTimeout(() => {
                                btn.setButtonText(t.secretStorage.testKey);
                                btn.setDisabled(false);
                            }, 2000);
                        } catch (error) {
                            btn.setButtonText(t.secretStorage.error);
                            console.error('Key test failed:', error);
                            setTimeout(() => {
                                btn.setButtonText(t.secretStorage.testKey);
                                btn.setDisabled(false);
                            }, 2000);
                        }
                    });
            });
        }

        if (!useSecretStorage) {
            // Show warning for older Obsidian versions
            const warningEl = setting.descEl.createDiv({
                cls: 'ai-organiser-fallback-warning',
                text: t.secretStorage.fallbackWarning
            });
            warningEl.style.color = 'var(--text-warning)';
            warningEl.style.fontSize = '0.9em';
            warningEl.style.marginTop = '4px';
        }

        return setting;
    }

    abstract display(): void | Promise<void>;
}
