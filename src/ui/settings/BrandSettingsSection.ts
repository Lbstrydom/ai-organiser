import { Setting, TFile, TFolder } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { BaseSettingSection } from './BaseSettingSection';
import { loadBrandTheme } from '../../services/chat/brandThemeService';
import { addFolderPicker } from './components/FolderSuggest';
import { logger } from '../../utils/logger';
// Single shared brand-folder resolver + asset filename constants (audit M4/M9/M10)
// so the settings detection matches `brandAssets` resolution exactly.
import {
    getBrandFolder, BRAND_GUIDELINES_FILE, LOGO_LIGHT, LOGO_DARK, ICONS_DIR,
    inspectBrandFontCandidates,
} from '../../services/export/brand/brandAssets';

/**
 * Brand settings (Plan B §8).
 *
 * Configuration home for brand fidelity: the vault brand folder + the
 * on-brand-by-default toggle, plus a read-only resolved-font/min-font readout
 * and a "what's detected" status block (not-configured / partial / ok / invalid).
 *
 * Detection is purely structural (folder + file presence via the vault API);
 * the resolved font + parse warnings come from `loadBrandTheme`. Validation
 * re-runs on path change (debounced) and on section open.
 */
export class BrandSettingsSection extends BaseSettingSection {
    private statusEl: HTMLElement | null = null;
    private resolvedEl: HTMLElement | null = null;
    private debounceHandle: ReturnType<typeof setTimeout> | null = null;
    /** Debounce for `saveSettings()` on the free-text folder-path field — a save
     *  triggers service reinit + disk I/O, so we must NOT fire it per keystroke
     *  (audit-Gemini G2). The in-memory setting updates immediately; the persist
     *  is debounced. */
    private saveHandle: ReturnType<typeof setTimeout> | null = null;
    /** Monotonic counter so a slow async `revalidate()` never writes stale results
     *  over a newer run's output (audit M12). Incremented on every `display()` +
     *  every `revalidate()` start; each run captures its value and bails if it is
     *  no longer current after the awaited work. */
    private validationSeq = 0;

    constructor(plugin: AIOrganiserPlugin, containerEl: HTMLElement, settingTab: AIOrganiserSettingTab) {
        super(plugin, containerEl, settingTab);
    }

    display(): void {
        const { containerEl, plugin } = this;
        const t = plugin.t.settings.brand;

        // A fresh render invalidates any in-flight revalidate() targeting the old
        // (now-detached) statusEl/resolvedEl (audit M12).
        this.validationSeq++;

        // No leading section header: the sub-collapsible summary already shows the
        // "Brand" title, so an inner h1 only added empty space before the controls.

        // Help link to the public brand-setup guide (item D).
        const helpEl = containerEl.createDiv({ cls: 'ai-organiser-brand-help setting-item-description' });
        helpEl.createEl('a', {
            text: t.setupGuideText,
            href: 'https://github.com/Lbstrydom/ai-organiser/blob/main/docs/brand-setup.md',
        });

        addFolderPicker(
            new Setting(containerEl).setName(t.folderPathTitle).setDesc(t.folderPathDesc),
            plugin.app,
            () => plugin.settings.brandFolderPath || '999_Brand',
            (value) => {
                // Update in memory immediately; debounce the persist (reinit + I/O).
                plugin.settings.brandFolderPath = value.trim() || '999_Brand';
                this.scheduleSave();
                this.scheduleRevalidate();
            },
            '999_Brand',
        );

        new Setting(containerEl)
            .setName(t.onBrandDefaultTitle)
            .setDesc(t.onBrandDefaultDesc)
            .addToggle(toggle => toggle
                .setValue(plugin.settings.onBrandByDefault)
                .onChange(value => {
                    plugin.settings.onBrandByDefault = value;
                    plugin.saveSettings().catch(e => logger.error('Brand', 'saveSettings failed', e));
                }));

        // Editable universal min-font floor (item C). These are the minimum content
        // font sizes enforced on EVERY export; a brand-guidelines.md file can
        // override per role. The footer (slide-number strip) is the one auto-placed
        // exception and is not user-editable.
        // h4 group label (not createSectionHeader → its h2 is CSS-hidden inside a
        // sub-collapsible; h4 stays visible, matching the Export-section pattern).
        containerEl.createEl('h4', { text: t.minFontHeading });
        new Setting(containerEl).setDesc(t.minFontDesc);
        this.addMinFontInput(t.minFontBodyTitle, () => plugin.settings.exportMinFontBody, v => { plugin.settings.exportMinFontBody = v; });
        this.addMinFontInput(t.minFontCaptionTitle, () => plugin.settings.exportMinFontCaption, v => { plugin.settings.exportMinFontCaption = v; });
        this.addMinFontInput(t.minFontTableTitle, () => plugin.settings.exportMinFontTable, v => { plugin.settings.exportMinFontTable = v; });

        // Read-only resolved font + min-font (filled async by revalidate()).
        this.resolvedEl = new Setting(containerEl)
            .setName(t.resolvedFontTitle)
            .setDesc(t.resolvedFontDesc)
            .descEl.createDiv({ cls: 'ai-organiser-brand-resolved', text: t.statusChecking });

        // "What's detected" status block.
        this.createSectionHeader(t.statusHeading, 'search', 2);
        this.statusEl = containerEl.createDiv({ cls: 'ai-organiser-brand-status' });
        this.statusEl.setText(t.statusChecking);

        this.revalidate().catch(e => logger.error('Brand', 'revalidate failed', e));
    }

    private scheduleRevalidate(): void {
        if (this.debounceHandle) clearTimeout(this.debounceHandle);
        this.debounceHandle = setTimeout(() => {
            this.revalidate().catch(e => logger.error('Brand', 'revalidate failed', e));
        }, 400);
    }

    /** Debounced persist for the free-text folder path (audit-Gemini G2). */
    private scheduleSave(): void {
        if (this.saveHandle) clearTimeout(this.saveHandle);
        this.saveHandle = setTimeout(() => {
            this.plugin.saveSettings().catch(e => logger.error('Brand', 'saveSettings failed', e));
        }, 600);
    }

    /**
     * Add a clamped (8–24) min-font number input. Validated finite + clamped on
     * change; persist debounced. After save, re-resolves the readout so the
     * "Resolved font" line reflects the new effective floor when no brand file
     * overrides it.
     */
    private addMinFontInput(name: string, getValue: () => number, setValue: (v: number) => void): void {
        new Setting(this.containerEl)
            .setName(name)
            .addText(text => {
                text.inputEl.type = 'number';
                text.inputEl.min = '8';
                text.inputEl.max = '24';
                text.setValue(String(getValue()));
                text.onChange(raw => {
                    const n = parseFloat(raw);
                    if (!Number.isFinite(n)) return;
                    const clamped = Math.max(8, Math.min(24, Math.round(n)));
                    setValue(clamped);
                    this.scheduleSave();
                    this.scheduleRevalidate();
                });
                text.inputEl.addEventListener('blur', () => {
                    // Normalise the visible value to the clamped/stored value.
                    text.setValue(String(getValue()));
                });
            });
    }

    private brandFolder(): string {
        return getBrandFolder(this.plugin.settings);
    }

    /** Structural detection of the brand pack files inside the brand folder. */
    private detectAssets(): { guidelines: boolean; logo: boolean; icons: number; fontCount: number } {
        const { app } = this.plugin;
        const folder = this.brandFolder();

        const guidelines = app.vault.getAbstractFileByPath(`${folder}/${BRAND_GUIDELINES_FILE}`) instanceof TFile;
        // Match `brandAssets.getLogo` resolution (audit M20): a logo counts as
        // present if EITHER the `.png` OR the `.svg` variant exists, for either
        // light or dark.
        const logoPresent = (name: string): boolean =>
            app.vault.getAbstractFileByPath(`${folder}/${name}.png`) instanceof TFile
            || app.vault.getAbstractFileByPath(`${folder}/${name}.svg`) instanceof TFile;
        const logoLight = logoPresent(LOGO_LIGHT);
        const logoDark = logoPresent(LOGO_DARK);

        let icons = 0;
        const iconsFolder = app.vault.getAbstractFileByPath(`${folder}/${ICONS_DIR}`);
        if (iconsFolder instanceof TFolder) {
            for (const child of iconsFolder.children) {
                if (child instanceof TFile && child.extension.toLowerCase() === 'svg') icons++;
            }
        }

        // Embedded-font candidates (sync, stat-only — no base64).
        const fontCount = inspectBrandFontCandidates(this.plugin.app, this.plugin.settings).count;

        return { guidelines, logo: logoLight || logoDark, icons, fontCount };
    }

    private async revalidate(): Promise<void> {
        const t = this.plugin.t.settings.brand;
        // Capture the sequence at the start; after the awaited work, only write the
        // DOM if this is still the latest run AND the section wasn't re-rendered /
        // disposed (audit M12).
        const seq = ++this.validationSeq;
        const { guidelines, logo, icons, fontCount } = this.detectAssets();

        // Resolved font + min-font readout (only meaningful when guidelines load).
        const brand = await loadBrandTheme(this.plugin.app, this.plugin.settings);
        // Drop stale results — a newer revalidate()/display() superseded this one.
        if (seq !== this.validationSeq) return;
        if (this.resolvedEl) {
            this.resolvedEl.empty();
            if (brand.ok) {
                this.resolvedEl.createDiv({ text: brand.value.font });
                const mf = brand.value.minFont;
                this.resolvedEl.createDiv({
                    cls: 'ai-organiser-text-muted',
                    text: t.minFontLabel
                        .replace('{body}', String(mf.body))
                        .replace('{caption}', String(mf.caption))
                        .replace('{table}', String(mf.table))
                        .replace('{footer}', String(mf.footer)),
                });
            } else {
                this.resolvedEl.createDiv({ cls: 'ai-organiser-text-muted', text: t.usingExample });
            }
        }

        if (!this.statusEl) return;
        this.statusEl.empty();

        // State machine per §8: not-configured / invalid / partial / ok.
        const noFolder = this.plugin.app.vault.getAbstractFileByPath(this.brandFolder()) === null;

        if (!guidelines && noFolder) {
            this.renderStatusLine(this.statusEl, '○', t.statusNotConfigured);
            this.renderStatusLine(this.statusEl, '○', t.usingExample, 'ai-organiser-text-muted');
            return;
        }

        if (!brand.ok && guidelines) {
            // Guidelines file present but unreadable → invalid.
            this.renderStatusLine(this.statusEl, '✕', t.statusInvalid, 'ai-organiser-text-warning');
            this.renderStatusLine(this.statusEl, '✕', brand.error, 'ai-organiser-text-warning');
            return;
        }

        if (!guidelines) {
            // Folder exists but no guidelines file → treat as not-configured.
            this.renderStatusLine(this.statusEl, '⚠', t.checkGuidelinesMissing, 'ai-organiser-text-warning');
            this.renderStatusLine(this.statusEl, '○', t.usingExample, 'ai-organiser-text-muted');
            return;
        }

        // Guidelines load OK — report logo + icon coverage.
        const warnings = brand.ok ? brand.value.warnings : [];
        const headline = logo && icons > 0 ? t.statusOk : t.statusPartial;
        this.renderStatusLine(this.statusEl, '✓', headline);
        this.renderStatusLine(this.statusEl, '✓', t.checkGuidelines);
        this.renderStatusLine(
            this.statusEl,
            logo ? '✓' : '⚠',
            logo ? t.checkLogo : t.checkLogoMissing,
            logo ? undefined : 'ai-organiser-text-warning',
        );
        this.renderStatusLine(
            this.statusEl,
            icons > 0 ? '✓' : '⚠',
            icons > 0 ? t.checkIcons.replace('{count}', String(icons)) : t.checkIconsMissing,
            icons > 0 ? undefined : 'ai-organiser-text-warning',
        );
        // Embedded-font candidates — "○" (neutral, optional) when none, since the
        // named font + fallback still renders.
        this.renderStatusLine(
            this.statusEl,
            fontCount > 0 ? '✓' : '○',
            fontCount > 0 ? t.checkFonts.replace('{count}', String(fontCount)) : t.checkFontsMissing,
            fontCount > 0 ? undefined : 'ai-organiser-text-muted',
        );
        for (const w of warnings) {
            this.renderStatusLine(this.statusEl, '⚠', w, 'ai-organiser-text-warning');
        }
    }

    private renderStatusLine(parent: HTMLElement, marker: string, text: string, cls?: string): void {
        const line = parent.createDiv({ cls: 'ai-organiser-brand-status-line' });
        if (cls) line.addClass(cls);
        line.createSpan({ cls: 'ai-organiser-brand-status-marker', text: `${marker} ` });
        line.createSpan({ text });
    }
}
