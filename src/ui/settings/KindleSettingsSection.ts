/* eslint-disable obsidianmd/ui/sentence-case -- Kindle, Amazon are brand names; placeholders contain email/URL formats */
/**
 * Kindle Settings Section
 *
 * Settings for the Kindle highlights sync feature.
 * Includes: Amazon region, login/logout with cookie health,
 * output folder, highlight style, grouping, cover image, auto-tag.
 */

import { Notice, Platform, Setting, TFolder } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { BaseSettingSection } from './BaseSettingSection';
import { AMAZON_REGIONS } from '../../core/constants';
import { getKindleOutputFullPath, getEffectiveOutputRoot } from '../../core/settings';
import { isAuthenticated, getStoredCookies, clearCookies, getCookieAgeDays, getStoredAmazonEmail, getStoredAmazonPassword, storeAmazonEmail, storeAmazonPassword } from '../../services/kindle/kindleAuthService';
import { KindleLoginModal } from '../modals/KindleLoginModal';

const COOKIE_STALE_THRESHOLD_DAYS = 7;

export class KindleSettingsSection extends BaseSettingSection {
    constructor(plugin: AIOrganiserPlugin, containerEl: HTMLElement, settingTab: AIOrganiserSettingTab) {
        super(plugin, containerEl, settingTab);
    }

    async display(): Promise<void> {
        const t = this.plugin.t;

        this.createSectionHeader(t.settings.kindle.title, 'book-open', 2);

        // Description with desktop-only badge when applicable
        const descText = Platform.isMobile
            ? t.settings.kindle.description
            : `${t.settings.kindle.description} ${t.settings.kindle.desktopSignIn}`;
        this.containerEl.createEl('p', {
            text: descText,
            cls: 'setting-item-description'
        });

        // --- Amazon Cloud Sync Settings ---

        // Amazon Region Dropdown
        new Setting(this.containerEl)
            .setName(t.settings.kindle.region)
            .setDesc(t.settings.kindle.regionDesc)
            .addDropdown(dd => {
                for (const [key, { label }] of Object.entries(AMAZON_REGIONS)) {
                    dd.addOption(key, label);
                }
                dd.setValue(this.plugin.settings.kindleAmazonRegion)
                    .onChange(async v => {
                        this.plugin.settings.kindleAmazonRegion = v;
                        await this.plugin.saveSettings();
                        // Invalidate cookies AND ASIN state if region changed
                        const payload = await getStoredCookies(this.plugin);
                        if (payload && payload.region !== v) {
                            await clearCookies(this.plugin);
                            this.plugin.settings.kindleSyncState.importedHighlightsByAsin = {};
                            this.plugin.settings.kindleSyncState.cachedBooks = undefined;
                            await this.plugin.saveSettings();
                            new Notice(t.settings.kindle.regionChangedCookiesCleared);
                        }
                    });
            });

        // Amazon Account Login/Logout with cookie health
        const loginSetting = new Setting(this.containerEl)
            .setName(t.settings.kindle.amazonAccount);

        const authenticated = await isAuthenticated(this.plugin);
        if (authenticated) {
            const payload = await getStoredCookies(this.plugin);
            const ageDays = payload ? getCookieAgeDays(payload) : -1;

            // Cookie age display with accessible indicators (DD-6)
            const descEl = loginSetting.descEl;
            if (ageDays >= 0) {
                const ageEl = descEl.createDiv({ cls: 'ai-organiser-kindle-cookie-age' });
                if (ageDays >= COOKIE_STALE_THRESHOLD_DAYS) {
                    ageEl.addClass('is-stale');
                    ageEl.textContent = `\u26A0 ${t.settings.kindle.cookieAgeStale.replace('{days}', String(ageDays))}`;
                } else {
                    ageEl.textContent = `\u2713 ${t.settings.kindle.cookieAge.replace('{days}', String(ageDays))}`;
                }
            } else {
                descEl.textContent = t.settings.kindle.connected;
            }

            // Re-authenticate button
            loginSetting.addButton(btn => btn
                .setButtonText(t.settings.kindle.reAuth)
                .onClick(async () => {
                    const loggedIn = await new KindleLoginModal(this.plugin.app, this.plugin).openAndWait();
                    if (loggedIn) {
                        this.settingTab.display();
                    }
                }));

            // Sign out button
            loginSetting.addButton(btn => btn
                .setButtonText(t.settings.kindle.logoutButton)
                .onClick(async () => {
                    await clearCookies(this.plugin);
                    this.plugin.settings.kindleSyncState.cachedBooks = undefined;
                    await this.plugin.saveSettings();
                    new Notice(t.settings.kindle.notConnected);
                    this.settingTab.display();
                }));
        } else {
            loginSetting.setDesc(t.settings.kindle.notConnected);
            loginSetting.addButton(btn => btn
                .setButtonText(t.settings.kindle.loginButton)
                .setCta()
                .onClick(async () => {
                    const loggedIn = await new KindleLoginModal(this.plugin.app, this.plugin).openAndWait();
                    if (loggedIn) {
                        this.settingTab.display();
                    }
                }));
        }

        // --- Output Settings ---

        // Amazon Email — stored in SecretStorage for auto-fill during embedded login
        const storedEmail = await getStoredAmazonEmail(this.plugin);
        new Setting(this.containerEl)
            .setName(t.settings.kindle.amazonEmail)
            .setDesc(t.settings.kindle.amazonEmailDesc)
            .addText(text => text
                .setPlaceholder('you@example.com')
                .setValue(storedEmail || '')
                .onChange(async (value) => {
                    await storeAmazonEmail(this.plugin, value);
                }));

        // Amazon Password — stored in SecretStorage for auto-fill during embedded login
        const storedPassword = await getStoredAmazonPassword(this.plugin);
        const passwordSetting = new Setting(this.containerEl)
            .setName(t.settings.kindle.amazonPassword)
            .setDesc(t.settings.kindle.amazonPasswordDesc);

        passwordSetting.addText(text => {
            text.setPlaceholder('••••••••')
                .setValue(storedPassword || '')
                .onChange(async (value) => {
                    await storeAmazonPassword(this.plugin, value);
                });
            // Make the input a password field
            text.inputEl.type = 'password';
            text.inputEl.autocomplete = 'off';
        });

        // --- Output & Display Settings ---

        // Output folder — dropdown with existing vault folders + custom path
        const folderSetting = new Setting(this.containerEl)
            .setName(t.settings.kindle.outputFolder)
            .setDesc(t.settings.kindle.outputFolderDesc);

        const pluginPrefix = `${getEffectiveOutputRoot(this.plugin.settings)}/`;
        const resolvedDefault = getKindleOutputFullPath(this.plugin.settings);
        const currentResolved = getKindleOutputFullPath(this.plugin.settings);
        const folders = this.getVaultFolders();

        folderSetting.addDropdown(dropdown => {
            dropdown.addOption(resolvedDefault, `${resolvedDefault} (default)`);
            for (const folder of folders) {
                if (folder !== resolvedDefault) {
                    dropdown.addOption(folder, folder);
                }
            }
            dropdown.addOption('__custom__', '— Custom path —');

            const isCustom = !folders.includes(currentResolved) && currentResolved !== resolvedDefault;
            dropdown.setValue(isCustom ? '__custom__' : currentResolved);

            dropdown.onChange(value => {
                if (value === '__custom__') {
                    this.settingTab.display();
                } else {
                    const normalized = value.startsWith(pluginPrefix) ? value.slice(pluginPrefix.length) : value;
                    this.plugin.settings.kindleOutputFolder = normalized || 'Kindle';
                    void this.plugin.saveSettings();
                }
            });
        });

        const isCustom = !folders.includes(currentResolved) && currentResolved !== resolvedDefault;
        if (isCustom) {
            folderSetting.addText(text => text
                .setPlaceholder('Kindle')
                .setValue(this.plugin.settings.kindleOutputFolder)
                .onChange(value => {
                    const sanitized = (value || 'Kindle').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
                    const normalized = sanitized.startsWith(pluginPrefix) ? sanitized.slice(pluginPrefix.length) : sanitized;
                    this.plugin.settings.kindleOutputFolder = normalized || 'Kindle';
                    void this.plugin.saveSettings();
                }));
        }

        // Highlight style dropdown
        new Setting(this.containerEl)
            .setName(t.settings.kindle.highlightStyle)
            .setDesc(t.settings.kindle.highlightStyleDesc)
            .addDropdown(dropdown => dropdown
                .addOption('blockquote', 'Blockquote')
                .addOption('callout', 'Callout')
                .addOption('bullet', 'Bullet')
                .setValue(this.plugin.settings.kindleHighlightStyle)
                .onChange((value) => {
                    this.plugin.settings.kindleHighlightStyle = value as 'blockquote' | 'callout' | 'bullet';
                    void this.plugin.saveSettings();
                }));

        // Group by color toggle
        new Setting(this.containerEl)
            .setName(t.settings.kindle.groupByColor)
            .setDesc(t.settings.kindle.groupByColorDesc)
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.kindleGroupByColor)
                .onChange((value) => {
                    this.plugin.settings.kindleGroupByColor = value;
                    void this.plugin.saveSettings();
                }));

        // Include cover image toggle
        new Setting(this.containerEl)
            .setName(t.settings.kindle.includeCoverImage)
            .setDesc(t.settings.kindle.includeCoverImageDesc)
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.kindleIncludeCoverImage)
                .onChange((value) => {
                    this.plugin.settings.kindleIncludeCoverImage = value;
                    void this.plugin.saveSettings();
                }));

        // Auto-tag after import toggle
        new Setting(this.containerEl)
            .setName(t.settings.kindle.autoTag)
            .setDesc(t.settings.kindle.autoTagDesc)
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.kindleAutoTag)
                .onChange((value) => {
                    this.plugin.settings.kindleAutoTag = value;
                    void this.plugin.saveSettings();
                }));
    }

    private getVaultFolders(): string[] {
        const folders: string[] = [];
        for (const file of this.plugin.app.vault.getAllLoadedFiles()) {
            if (file instanceof TFolder && file.path !== '/') {
                folders.push(file.path);
            }
        }
        folders.sort((a, b) => a.localeCompare(b));
        return folders;
    }
}
