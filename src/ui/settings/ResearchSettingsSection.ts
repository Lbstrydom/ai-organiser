/**
 * Research Settings Section
 *
 * Settings for the Research Assistant feature.
 * Includes: search provider, API keys, preferred/excluded sites, output preferences.
 */

import { Notice, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { BaseSettingSection } from './BaseSettingSection';
import { PLUGIN_SECRET_IDS } from '../../core/secretIds';
import { ResearchSearchService } from '../../services/research/researchSearchService';
import { ResearchUsageService } from '../../services/research/researchUsageService';

export class ResearchSettingsSection extends BaseSettingSection {
    constructor(plugin: AIOrganiserPlugin, containerEl: HTMLElement, settingTab: AIOrganiserSettingTab) {
        super(plugin, containerEl, settingTab);
    }

    async display(): Promise<void> {
        const t = this.plugin.t.settings as unknown as Record<string, Record<string, string>>;
        const rt = t.research || {};

        this.createSectionHeader(rt.title || 'Research Assistant', 'telescope', 2);

        // Search Provider
        new Setting(this.containerEl)
            .setName(rt.provider || 'Search Provider')
            .setDesc(rt.providerDesc || 'Which search API to use for web research')
            .addDropdown(dd => {
                dd.addOption('claude-web-search', rt.claudeWebSearch || 'Claude Web Search ($0.01/search)');
                dd.addOption('tavily', 'Tavily');
                dd.addOption('brightdata-serp', 'Bright Data SERP');
                dd.setValue(this.plugin.settings.researchProvider)
                    .onChange(async v => {
                        this.plugin.settings.researchProvider = v as typeof this.plugin.settings.researchProvider;
                        await this.plugin.saveSettings();
                        this.settingTab.display();
                    });
            });

        // Provider-specific API key fields
        const provider = this.plugin.settings.researchProvider;
        if (provider === 'tavily') {
            this.renderApiKeyField({
                name: rt.apiKey || 'API Key',
                desc: rt.apiKeyDesc || 'Your Tavily API key (stored securely)',
                secretId: PLUGIN_SECRET_IDS.RESEARCH_TAVILY_API_KEY,
                currentValue: '',
                onChange: () => {},
            });

            this.containerEl.createEl('div', {
                text: rt.tavilyInfo || 'Tavily: 1,000 free searches/month. Sign up at tavily.com',
                cls: 'setting-item-description ai-organiser-info-box',
            });
        } else if (provider === 'brightdata-serp') {
            this.renderApiKeyField({
                name: rt.serpKey || 'SERP API Key',
                desc: rt.serpKeyDesc || 'Bright Data SERP API key for web search',
                secretId: PLUGIN_SECRET_IDS.BRIGHT_DATA_SERP_KEY,
                currentValue: '',
                onChange: () => {},
            });
        } else if (provider === 'claude-web-search') {
            this.renderApiKeyField({
                name: rt.apiKey || 'API Key',
                desc: rt.claudeWebSearchKeyDesc || 'Claude API key for web search (stored securely)',
                secretId: PLUGIN_SECRET_IDS.RESEARCH_CLAUDE_WEB_SEARCH_KEY,
                currentValue: '',
                onChange: () => {},
            });

            // "Use main Claude API key" button (AD-4)
            if (this.plugin.settings.cloudServiceType === 'claude') {
                new Setting(this.containerEl)
                    .addButton(btn => btn
                        .setButtonText(rt.useMainClaudeKey || 'Use main Claude API key')
                        .onClick(async () => {
                            const mainKey = await this.plugin.secretStorageService.getSecret('anthropic-api-key');
                            if (mainKey) {
                                await this.plugin.secretStorageService.setSecret(
                                    PLUGIN_SECRET_IDS.RESEARCH_CLAUDE_WEB_SEARCH_KEY, mainKey,
                                );
                                new Notice(rt.keyCopied || 'Main Claude API key copied to research key');
                                this.settingTab.display();
                            } else {
                                new Notice(rt.noMainKey || 'No main Claude API key found');
                            }
                        }));
            }

            // Max searches per query (AD-7)
            new Setting(this.containerEl)
                .setName(rt.claudeMaxSearches || 'Max searches per query')
                .setDesc(rt.claudeMaxSearchesDesc || 'Limit searches per research request (cost control)')
                .addSlider(slider => slider
                    .setLimits(1, 10, 1)
                    .setValue(this.plugin.settings.researchClaudeMaxSearches)
                    .setDynamicTooltip()
                    .onChange(async v => {
                        this.plugin.settings.researchClaudeMaxSearches = v;
                        await this.plugin.saveSettings();
                    }));

            // Dynamic filtering toggle (AD-7)
            new Setting(this.containerEl)
                .setName(rt.claudeDynamicFiltering || 'Dynamic filtering')
                .setDesc(rt.claudeDynamicFilteringDesc || 'Claude filters results with code before reasoning (requires Claude 4.6)')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.researchClaudeUseDynamicFiltering)
                    .onChange(async v => {
                        this.plugin.settings.researchClaudeUseDynamicFiltering = v;
                        await this.plugin.saveSettings();
                    }));

            this.containerEl.createEl('div', {
                text: rt.claudeWebSearchInfo || 'Claude Web Search: $0.01/search. Uses Claude\'s built-in web search with dynamic filtering and native citations.',
                cls: 'setting-item-description ai-organiser-info-box',
            });
        }

        // Test Connection button with inline status
        const testContainer = this.containerEl.createDiv('ai-organiser-connection-test-container');
        new Setting(testContainer)
            .setName(rt.testConnection || 'Test Connection')
            .addButton(btn => btn
                .setButtonText(rt.testConnection || 'Test Connection')
                .onClick(async () => {
                    try {
                        btn.setButtonText('Testing...');
                        btn.setDisabled(true);
                        statusEl.textContent = '';
                        statusEl.className = '';
                        statusContainer.addClass('ai-organiser-hidden');
                        const searchService = new ResearchSearchService(this.plugin);
                        const providerType = this.plugin.settings.researchProvider;
                        let msg: string;
                        if (providerType === 'claude-web-search') {
                            // Lightweight check — verify API key is configured without making a paid search call
                            const provider = searchService.getProvider('claude-web-search');
                            if (provider && await provider.isConfigured()) {
                                msg = 'Claude Web Search configured ✓';
                            } else {
                                throw new Error('No API key configured for Claude Web Search');
                            }
                        } else {
                            const results = await searchService.search(['test'], { maxResults: 1 });
                            msg = `Connected — ${results.length} result${results.length === 1 ? '' : 's'} returned`;
                        }
                        statusContainer.addClass('ai-organiser-block');
                        statusContainer.className = 'ai-organiser-connection-test-status success';
                        statusEl.textContent = msg;
                    } catch (error) {
                        const errMsg = (error as Error).message || 'Unknown error';
                        statusContainer.addClass('ai-organiser-block');
                        statusContainer.className = 'ai-organiser-connection-test-status error';
                        statusEl.textContent = `Connection failed: ${errMsg}`;
                    } finally {
                        btn.setButtonText(rt.testConnection || 'Test Connection');
                        btn.setDisabled(false);
                    }
                }));
        const statusContainer = testContainer.createDiv('ai-organiser-connection-test-status');
        const statusEl = statusContainer.createSpan();
        statusContainer.addClass('ai-organiser-hidden');

        // Preferred Sources
        this.containerEl.createEl('h4', { text: rt.preferredSitesHeader || 'Source Preferences' });

        new Setting(this.containerEl)
            .setName(rt.preferredSites || 'Priority Sites')
            .setDesc(rt.preferredSitesDesc || 'Comma-separated domains to prioritize (e.g., pubmed.gov, nature.com)')
            .addText(text => text
                .setPlaceholder(rt.preferredSitesPlaceholder || 'e.g., pubmed.gov, nature.com')
                .setValue(this.plugin.settings.researchPreferredSites)
                .onChange(async v => {
                    this.plugin.settings.researchPreferredSites = v;
                    await this.plugin.saveSettings();
                }));

        new Setting(this.containerEl)
            .setName(rt.excludedSites || 'Excluded Sites')
            .setDesc(rt.excludedSitesDesc || 'Comma-separated domains to exclude (e.g., pinterest.com)')
            .addText(text => text
                .setPlaceholder(rt.excludedSitesPlaceholder || 'e.g., pinterest.com, quora.com')
                .setValue(this.plugin.settings.researchExcludedSites)
                .onChange(async v => {
                    this.plugin.settings.researchExcludedSites = v;
                    await this.plugin.saveSettings();
                }));

        // Output Settings
        this.containerEl.createEl('h4', { text: rt.outputHeader || 'Output' });

        new Setting(this.containerEl)
            .setName(rt.outputFolder || 'Output Folder')
            .setDesc(rt.outputFolderDesc || 'Subfolder under your plugin folder for research notes')
            .addText(text => text
                .setPlaceholder('Research')
                .setValue(this.plugin.settings.researchOutputFolder)
                .onChange(async v => {
                    this.plugin.settings.researchOutputFolder = v;
                    await this.plugin.saveSettings();
                }));

        new Setting(this.containerEl)
            .setName(rt.defaultOutput || 'Default Output')
            .setDesc(rt.defaultOutputDesc || 'Where to put research results by default')
            .addDropdown(dd => {
                dd.addOption('cursor', 'Insert at cursor');
                dd.addOption('section', 'Add as section');
                dd.addOption('pending', 'Save to pending');
                dd.setValue(this.plugin.settings.researchDefaultOutput)
                    .onChange(async v => {
                        this.plugin.settings.researchDefaultOutput = v as typeof this.plugin.settings.researchDefaultOutput;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(this.containerEl)
            .setName(rt.includeCitations || 'Include Citations')
            .setDesc(rt.includeCitationsDesc || 'Add numbered source references to the synthesis')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.researchIncludeCitations)
                .onChange(async v => {
                    this.plugin.settings.researchIncludeCitations = v;
                    await this.plugin.saveSettings();
                }));

        // Deep Extraction (Bright Data)
        this.containerEl.createEl('h4', { text: rt.brightDataSection || 'Deep Extraction (Bright Data)' });

        this.containerEl.createEl('div', {
            text: rt.brightDataInfo || 'For sites that block direct access. Optional — most sites work without this.',
            cls: 'setting-item-description ai-organiser-info-box',
        });

        this.renderApiKeyField({
            name: rt.webUnlockerKey || 'Web Unlocker API Key',
            desc: rt.webUnlockerKeyDesc || 'For bypassing anti-bot protection (Cloudflare, etc.)',
            secretId: PLUGIN_SECRET_IDS.BRIGHT_DATA_WEB_UNLOCKER_KEY,
            currentValue: '',
            onChange: () => {},
        });

        this.renderApiKeyField({
            name: rt.scrapingBrowserUrl || 'Scraping Browser URL',
            desc: rt.scrapingBrowserDesc || 'WSS endpoint for full browser rendering. Most expensive — last resort.',
            secretId: PLUGIN_SECRET_IDS.BRIGHT_DATA_BROWSER,
            currentValue: '',
            onChange: () => {},
        });

        // Budget & Guardrails
        this.containerEl.createEl('h4', { text: rt.budgetSection || 'Budget & Guardrails' });

        new Setting(this.containerEl)
            .setName(rt.monthlyBudget || 'Monthly Budget (USD)')
            .setDesc(rt.monthlyBudgetDesc || 'Maximum estimated monthly spend on paid extraction services')
            .addText(text => text
                .setPlaceholder('10')
                .setValue(String(this.plugin.settings.researchMonthlyBudgetUsd))
                .onChange(async v => {
                    const num = Number.parseFloat(v);
                    if (!Number.isNaN(num) && num >= 0) {
                        this.plugin.settings.researchMonthlyBudgetUsd = num;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(this.containerEl)
            .setName(rt.warnThreshold || 'Warn Threshold (%)')
            .setDesc(rt.warnThresholdDesc || 'Show a warning when spend reaches this percentage of the budget')
            .addText(text => text
                .setPlaceholder('80')
                .setValue(String(this.plugin.settings.researchWarnThresholdPercent))
                .onChange(async v => {
                    const num = Number.parseInt(v, 10);
                    if (!Number.isNaN(num) && num >= 0 && num <= 100) {
                        this.plugin.settings.researchWarnThresholdPercent = num;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(this.containerEl)
            .setName(rt.blockAtLimit || 'Block at Limit')
            .setDesc(rt.blockAtLimitDesc || 'Prevent paid operations when the monthly budget is reached')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.researchBlockAtLimit)
                .onChange(async v => {
                    this.plugin.settings.researchBlockAtLimit = v;
                    await this.plugin.saveSettings();
                }));

        // Current Usage display
        const usageService = new ResearchUsageService(this.plugin.app, this.plugin.settings);
        await usageService.ensureLoaded();
        const summary = usageService.getUsageSummary();

        new Setting(this.containerEl)
            .setName(rt.currentUsage || 'Current Usage')
            .setDesc(`${summary.estimatedUsd} estimated · ${summary.operations} operations · ${summary.status}`)
            .addButton(btn => btn
                .setButtonText(rt.resetUsage || 'Reset Usage')
                .onClick(() => { void (async () => {
                    if (await this.plugin.showConfirmationDialog(rt.resetUsageConfirm || 'Reset usage counter to zero?')) {
                        await usageService.resetUsage();
                        new Notice(rt.resetUsageSuccess || 'Usage counter reset');
                        this.settingTab.display();
                    }
                })(); }));

        // Quality & Academic
        this.containerEl.createEl('h4', { text: rt.qualitySection || 'Quality & Academic' });

        new Setting(this.containerEl)
            .setName(rt.qualityScoring || 'Quality Scoring')
            .setDesc(rt.qualityScoringDesc || 'Score and rank results by relevance, authority, freshness, depth, and diversity')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableResearchQualityScoring)
                .onChange(async v => {
                    this.plugin.settings.enableResearchQualityScoring = v;
                    await this.plugin.saveSettings();
                }));

        new Setting(this.containerEl)
            .setName(rt.citationStyle || 'Citation Style')
            .setDesc(rt.citationStyleDesc || 'How to format citations in the synthesis')
            .addDropdown(dd => {
                dd.addOption('numeric', rt.citationNumeric || 'Numeric [1], [2]');
                dd.addOption('author-year', rt.citationAuthorYear || 'Author-Year (Smith, 2024)');
                dd.setValue(this.plugin.settings.researchCitationStyle)
                    .onChange(async v => {
                        this.plugin.settings.researchCitationStyle = v as 'numeric' | 'author-year';
                        await this.plugin.saveSettings();
                    });
            });

        // Smart Research
        this.containerEl.createEl('h4', { text: rt.smartSection || 'Smart Research' });

        new Setting(this.containerEl)
            .setName(rt.vaultPrecheck || 'Vault Pre-check')
            .setDesc(rt.vaultPrecheckDesc || 'Check vault for existing relevant notes before searching the web')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableResearchVaultPrecheck)
                .onChange(async v => {
                    this.plugin.settings.enableResearchVaultPrecheck = v;
                    await this.plugin.saveSettings();
                    this.settingTab.display();
                }));

        if (this.plugin.settings.enableResearchVaultPrecheck) {
            new Setting(this.containerEl)
                .setName(rt.vaultPrecheckSimilarity || 'Minimum Similarity')
                .setDesc(rt.vaultPrecheckSimilarityDesc || 'Minimum similarity score for vault pre-check results (0.3–0.9)')
                .addSlider(slider => slider
                    .setLimits(0.3, 0.9, 0.05)
                    .setValue(this.plugin.settings.researchVaultPrecheckMinSimilarity)
                    .setDynamicTooltip()
                    .onChange(async v => {
                        this.plugin.settings.researchVaultPrecheckMinSimilarity = v;
                        await this.plugin.saveSettings();
                    }));
        }

        new Setting(this.containerEl)
            .setName(rt.perspectives || 'Multi-Perspective Queries')
            .setDesc(rt.perspectivesDesc || 'Generate queries from multiple research perspectives')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableResearchPerspectiveQueries)
                .onChange(async v => {
                    this.plugin.settings.enableResearchPerspectiveQueries = v;
                    await this.plugin.saveSettings();
                    this.settingTab.display();
                }));

        if (this.plugin.settings.enableResearchPerspectiveQueries) {
            new Setting(this.containerEl)
                .setName(rt.perspectivePreset || 'Perspective Preset')
                .addDropdown(dd => {
                    dd.addOption('balanced', 'Balanced');
                    dd.addOption('critical', 'Critical');
                    dd.addOption('historical', 'Historical');
                    dd.addOption('custom', 'Custom');
                    dd.setValue(this.plugin.settings.researchPerspectivePreset)
                        .onChange(async v => {
                            this.plugin.settings.researchPerspectivePreset = v as 'balanced' | 'critical' | 'historical' | 'custom';
                            await this.plugin.saveSettings();
                            this.settingTab.display();
                        });
                });

            if (this.plugin.settings.researchPerspectivePreset === 'custom') {
                new Setting(this.containerEl)
                    .setName(rt.perspectiveCustom || 'Custom perspectives')
                    .setDesc(rt.perspectiveCustomDesc || 'Comma-separated perspective names')
                    .addText(text => text
                        .setPlaceholder(rt.perspectiveCustomPlaceholder || 'e.g., economic, ethical, technological')
                        .setValue(this.plugin.settings.researchCustomPerspectives)
                        .onChange(async v => {
                            this.plugin.settings.researchCustomPerspectives = v;
                            await this.plugin.saveSettings();
                        }));
            }
        }

        new Setting(this.containerEl)
            .setName(rt.streaming || 'Streaming Synthesis')
            .setDesc(rt.streamingDesc || 'Show synthesis as it\'s generated (experimental)')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableResearchStreamingSynthesis)
                .onChange(async v => {
                    this.plugin.settings.enableResearchStreamingSynthesis = v;
                    await this.plugin.saveSettings();
                }));

        // Integrations
        this.containerEl.createEl('h4', { text: rt.integrationsSection || 'Integrations' });

        new Setting(this.containerEl)
            .setName(rt.zotero || 'Zotero Integration')
            .setDesc(rt.zoteroDesc || 'Send research references to Zotero (requires obsidian-zotero-desktop-connector, desktop only)')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableResearchZoteroIntegration)
                .onChange(async v => {
                    this.plugin.settings.enableResearchZoteroIntegration = v;
                    await this.plugin.saveSettings();
                    this.settingTab.display();
                }));

        if (this.plugin.settings.enableResearchZoteroIntegration) {
            new Setting(this.containerEl)
                .setName(rt.zoteroCollection || 'Zotero Collection')
                .setDesc(rt.zoteroCollectionDesc || 'Target collection name in Zotero')
                .addText(text => text
                    .setPlaceholder('AI Organiser research')
                    .setValue(this.plugin.settings.researchZoteroCollection)
                    .onChange(async v => {
                        this.plugin.settings.researchZoteroCollection = v;
                        await this.plugin.saveSettings();
                    }));
        }
    }
}
