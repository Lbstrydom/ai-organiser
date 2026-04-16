import { Notice, Setting, requestUrl } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { BaseSettingSection } from './BaseSettingSection';
import { getNewsletterOutputFullPath, getEffectiveOutputRoot } from '../../core/settings';
import { NewsletterService, SEEN_DATA_KEY, LAST_FETCH_DATA_KEY } from '../../services/newsletter/newsletterService';
import { showNewsletterFetchResultNotice } from '../../commands/newsletterCommands';
import { getAllFolders } from '../../utils/folderContextUtils';
import { COMMON_LANGUAGES, getLanguageDisplayName } from '../../services/languages';

const APPS_SCRIPT_TEMPLATE = `// Handles both fetch and confirm via GET query params.
// Apps Script redirects POST requests (302→GET), dropping the body,
// so everything uses doGet with an "action" parameter instead.
function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) ? e.parameter.action : 'fetch';

  // --- Confirm: mark messages as read + archive ---
  if (action === 'confirm') {
    var idStr = (e && e.parameter && e.parameter.ids) ? e.parameter.ids : '';
    var ids = idStr.split(',').filter(function(id) { return id.length > 0; });
    var count = 0;
    for (var i = 0; i < ids.length; i++) {
      var msg = GmailApp.getMessageById(ids[i]);
      if (msg) { msg.markRead(); msg.getThread().moveToArchive(); count++; }
    }
    return ContentService.createTextOutput(JSON.stringify({ok: true, count: count}))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // --- Fetch: return unread newsletters as JSON ---
  var labelName = (e && e.parameter && e.parameter.label) ? e.parameter.label : 'Newsletters';
  var limit = (e && e.parameter && e.parameter.limit) ? parseInt(e.parameter.limit, 10) : 20;
  var label = GmailApp.getUserLabelByName(labelName);
  if (!label) return ContentService.createTextOutput('[]').setMimeType(ContentService.MimeType.JSON);
  var threads = label.getThreads(0, limit);
  var emails = [];
  for (var i = 0; i < threads.length; i++) {
    var msgs = threads[i].getMessages();
    for (var j = 0; j < msgs.length; j++) {
      var msg = msgs[j];
      if (msg.isUnread()) {
        emails.push({
          id: msg.getId(),
          from: msg.getFrom(),
          subject: msg.getSubject(),
          date: msg.getDate().toISOString(),
          body: msg.getBody(),
          plain: msg.getPlainBody()
        });
      }
    }
  }
  return ContentService.createTextOutput(JSON.stringify(emails))
    .setMimeType(ContentService.MimeType.JSON);
}`;

export class NewsletterSettingsSection extends BaseSettingSection {
    constructor(plugin: AIOrganiserPlugin, containerEl: HTMLElement, settingTab: AIOrganiserSettingTab) {
        super(plugin, containerEl, settingTab);
    }

    display(): void {
        const t = this.plugin.t;
        const nl = t.settings.newsletter;

        this.createSectionHeader(nl?.title || 'Newsletter digest', 'mail', 2);

        if (nl?.description) {
            this.containerEl.createEl('p', {
                text: nl.description,
                cls: 'setting-item-description'
            });
        }

        // Enable toggle
        new Setting(this.containerEl)
            .setName(nl?.enabled || 'Enable newsletter digest')
            .setDesc(nl?.enabledDesc || 'Fetch and summarize newsletters from your Gmail')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.newsletterEnabled)
                .onChange(value => {
                    this.plugin.settings.newsletterEnabled = value;
                    void this.plugin.saveSettings();
                    this.settingTab.display();
                }));

        // Only show remaining settings when enabled
        if (!this.plugin.settings.newsletterEnabled) return;

        // Source dropdown (Apps Script recommended; Gmail API is Tier 2 / not yet implemented)
        new Setting(this.containerEl)
            .setName(nl?.source || 'Connection method')
            .addDropdown(dropdown => dropdown
                .addOption('apps-script', nl?.sourceAppsScript || 'Google apps script (recommended)')
                .addOption('gmail-api', (nl?.sourceGmailApi || 'Gmail API (desktop only)') + ' \u2014 coming soon')
                .setValue(this.plugin.settings.newsletterSource)
                .onChange(value => {
                    this.plugin.settings.newsletterSource = value as 'apps-script' | 'gmail-api';
                    void this.plugin.saveSettings();
                    this.settingTab.display();
                }));

        // Apps Script fields — hidden when Gmail API is selected (Tier 2, not yet implemented)
        if (this.plugin.settings.newsletterSource !== 'gmail-api') {
            // Script URL
            new Setting(this.containerEl)
                .setName(nl?.scriptUrl || 'Apps script URL')
                .setDesc(nl?.scriptUrlDesc || 'Paste the web app URL from your deployed Apps Script')
                .addText(text => text
                    .setPlaceholder(nl?.scriptUrlPlaceholder || 'https://script.google.com/macros/s/.../exec')
                    .setValue(this.plugin.settings.newsletterScriptUrl)
                    .onChange(value => {
                        this.plugin.settings.newsletterScriptUrl = value.trim();
                        void this.plugin.saveSettings();
                    }));

            // Re-deploy notice for existing users
            const upgradeBox = this.containerEl.createDiv({ cls: 'setting-item-description' });
            upgradeBox.setCssProps({ '--border-left': '3px solid var(--text-warning)' }); upgradeBox.addClass('ai-organiser-border-left-custom');
            upgradeBox.setCssProps({ '--pl': '8px' }); upgradeBox.addClass('ai-organiser-pl-custom');
            upgradeBox.addClass('ai-organiser-mb-12');
            upgradeBox.createEl('strong', { text: 'Existing users: ' });
            upgradeBox.createSpan({
                text: 'The script template was updated to support two-phase confirmation. '
                    + 'Re-copy the template below and re-deploy your Apps Script to ensure '
                    + 'newsletters are only marked as read after notes are safely saved.',
            });

            // Setup instructions
            this.containerEl.createEl('h4', { text: nl?.setupTitle || 'Setup instructions' });

            const infoBox = this.containerEl.createDiv({ cls: 'setting-item-description' });
            const steps = [
                nl?.setupStep1 || '1. Go to script.google.com → New Project',
                nl?.setupStep2 || '2. Paste the template (click Copy below)',
                nl?.setupStep3 || '3. Deploy → Web App → Execute as Me, access Anyone',
                nl?.setupStep4 || '4. Copy the URL and paste it above',
            ];
            for (const step of steps) {
                infoBox.createEl('p', { text: step });
            }

            // Copy Script Template button
            new Setting(this.containerEl)
                .setName(nl?.copyTemplate || 'Copy script template')
                .addButton(btn => btn
                    .setButtonText(nl?.copyTemplate || 'Copy script template')
                    .onClick(async () => {
                        await navigator.clipboard.writeText(APPS_SCRIPT_TEMPLATE);
                        new Notice(nl?.copyTemplateSuccess || 'Script template copied to clipboard');
                    }));
        }

        // Gmail Label setting
        new Setting(this.containerEl)
            .setName(nl?.gmailLabel || 'Gmail label')
            .setDesc(nl?.gmailLabelDesc || 'The Gmail label to fetch newsletters from')
            .addText(text => text
                .setValue(this.plugin.settings.newsletterGmailLabel)
                .onChange(value => {
                    this.plugin.settings.newsletterGmailLabel = value.trim() || 'Newsletters';
                    void this.plugin.saveSettings();
                }));

        // Test Connection button — only shown when script URL is set
        if (this.plugin.settings.newsletterScriptUrl?.trim()) {
            new Setting(this.containerEl)
                .setName(nl?.testConnection || 'Test connection')
                .addButton(btn => btn
                    .setButtonText(nl?.testConnection || 'Test connection')
                    .onClick(async () => {
                        btn.setDisabled(true);
                        btn.setButtonText('Testing...');
                        try {
                            const url = this.plugin.settings.newsletterScriptUrl.trim();
                            const label = encodeURIComponent(this.plugin.settings.newsletterGmailLabel || 'Newsletters');
                            const response = await requestUrl({ url: `${url}?label=${label}&limit=50`, method: 'GET' });
                            const text = response.text;
                            if (text.trimStart().startsWith('<')) throw new Error('HTML returned — check deployment access settings');
                            const data = JSON.parse(text);
                            const count = Array.isArray(data) ? data.filter((m: Record<string, unknown>) => m && m['id']).length : 0;
                            const msg = count > 0
                                ? (nl?.testConnectionConnected || '✓ Connected — {n} newsletter(s) waiting').replace('{n}', String(count))
                                : (nl?.testConnectionEmpty || '✓ Connected — inbox is empty');
                            new Notice(msg, 5000);
                        } catch (e) {
                            const msg = e instanceof Error ? e.message : String(e);
                            new Notice((nl?.testConnectionFailed || 'Connection failed: {error}').replace('{error}', msg), 6000);
                        } finally {
                            btn.setDisabled(false);
                            btn.setButtonText(nl?.testConnection || 'Test connection');
                        }
                    }));
        }

        // Max newsletters per fetch
        new Setting(this.containerEl)
            .setName(nl?.fetchLimit || 'Max newsletters per fetch')
            .setDesc(nl?.fetchLimitDesc || 'Maximum number of newsletters to fetch in one run')
            .addDropdown(drop => {
                drop.addOption('10', '10');
                drop.addOption('20', '20 (default)');
                drop.addOption('30', '30');
                drop.addOption('50', '50');
                drop.setValue(String(this.plugin.settings.newsletterFetchLimit || 20));
                drop.onChange(value => {
                    this.plugin.settings.newsletterFetchLimit = Number(value);
                    void this.plugin.saveSettings();
                });
            });

        // Output folder
        const pluginPrefix = `${getEffectiveOutputRoot(this.plugin.settings)}/`;
        const resolvedDefault = getNewsletterOutputFullPath(this.plugin.settings);
        const folders = getAllFolders(this.plugin.app).map(f => f.path);

        new Setting(this.containerEl)
            .setName(nl?.outputFolder || 'Output folder')
            .setDesc(nl?.outputFolderDesc || 'Where to save newsletter digest notes')
            .addDropdown(dropdown => {
                dropdown.addOption(resolvedDefault, `${resolvedDefault} (default)`);
                for (const folder of folders) {
                    if (folder !== resolvedDefault) {
                        dropdown.addOption(folder, folder);
                    }
                }
                dropdown.setValue(resolvedDefault);
                dropdown.onChange(value => {
                    const normalized = value.startsWith(pluginPrefix) ? value.slice(pluginPrefix.length) : value;
                    this.plugin.settings.newsletterOutputFolder = normalized || 'Newsletter Inbox';
                    void this.plugin.saveSettings();
                });
            });

        // Preferred language for newsletter summaries
        const langOptions = COMMON_LANGUAGES.filter(l => l.code !== 'auto');
        new Setting(this.containerEl)
            .setName(nl?.preferredLanguage || 'Summary language')
            .setDesc(nl?.preferredLanguageDesc || 'Translate newsletter summaries to this language. Foreign-language newsletters will be summarised in your chosen language.')
            .addDropdown(drop => {
                for (const lang of langOptions) {
                    drop.addOption(lang.code, getLanguageDisplayName(lang));
                }
                drop.setValue(this.plugin.settings.newsletterPreferredLanguage || 'en');
                drop.onChange(value => {
                    this.plugin.settings.newsletterPreferredLanguage = value;
                    void this.plugin.saveSettings();
                });
            });

        // Daily brief synthesis toggle
        new Setting(this.containerEl)
            .setName(nl?.dailyBrief || 'Daily brief')
            .setDesc(nl?.dailyBriefDesc || 'Synthesise all newsletters into a deduplicated daily brief at the top of the digest')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.newsletterDailyBrief)
                .onChange(value => {
                    this.plugin.settings.newsletterDailyBrief = value;
                    void this.plugin.saveSettings();
                    this.settingTab.display();
                }));

        // Audio podcast — only shown when daily brief is on
        if (this.plugin.settings.newsletterDailyBrief) {
            new Setting(this.containerEl)
                .setName(nl?.audioPodcast || 'Audio podcast')
                .setDesc(nl?.audioPodcastDesc || 'Convert the daily brief into a spoken podcast using Gemini TTS')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.newsletterAudioPodcast)
                    .onChange(value => {
                        this.plugin.settings.newsletterAudioPodcast = value;
                        void this.plugin.saveSettings();
                        this.settingTab.display();
                    }));

            if (this.plugin.settings.newsletterAudioPodcast) {
                new Setting(this.containerEl)
                    .setName(nl?.podcastVoice || 'Podcast voice')
                    .setDesc(nl?.podcastVoiceDesc || 'Voice used for the audio podcast')
                    .addDropdown(drop => drop
                        .addOption('Charon', nl?.podcastVoiceCharon || 'Charon (neutral, clear)')
                        .addOption('Puck',   nl?.podcastVoicePuck   || 'Puck (warm, conversational)')
                        .addOption('Kore',   nl?.podcastVoiceKore   || 'Kore (professional, precise)')
                        .setValue(this.plugin.settings.newsletterPodcastVoice || 'Charon')
                        .onChange(value => {
                            this.plugin.settings.newsletterPodcastVoice = value;
                            void this.plugin.saveSettings();
                        }));

                new Setting(this.containerEl)
                    .setName(nl?.podcastMaxMins || 'Maximum podcast length (minutes)')
                    .setDesc(nl?.podcastMaxMinsDesc || 'Upper limit for the spoken podcast. If the day\'s news is light the script will be shorter — this is a ceiling, not a target.')
                    .addSlider(slider => slider
                        .setLimits(1, 15, 1)
                        .setValue(this.plugin.settings.newsletterPodcastMaxMins ?? 5)
                        .setDynamicTooltip()
                        .onChange(value => {
                            this.plugin.settings.newsletterPodcastMaxMins = value;
                            void this.plugin.saveSettings();
                        }));
            }

            new Setting(this.containerEl)
                .setName(nl?.briefCutoffHour || 'Brief day cutoff')
                .setDesc(nl?.briefCutoffHourDesc || 'Hour when the daily brief rolls over to a new day. Newsletters arriving before this hour are grouped with the previous day.')
                .addSlider(slider => slider
                    .setLimits(0, 12, 1)
                    .setValue(this.plugin.settings.newsletterBriefCutoffHour ?? 6)
                    .setDynamicTooltip()
                    .onChange(value => {
                        this.plugin.settings.newsletterBriefCutoffHour = value;
                        void this.plugin.saveSettings();
                    }));
        }

        // Retention
        new Setting(this.containerEl)
            .setName(nl?.retentionDays || 'Keep newsletters for')
            .setDesc(nl?.retentionDaysDesc || 'Automatically delete newsletters and digest files older than this. Set to 0 to keep forever.')
            .addSlider(slider => slider
                .setLimits(0, 365, 7)
                .setValue(this.plugin.settings.newsletterRetentionDays ?? 30)
                .setDynamicTooltip()
                .onChange(value => {
                    this.plugin.settings.newsletterRetentionDays = value;
                    void this.plugin.saveSettings();
                }));

        // Auto-tag toggle
        new Setting(this.containerEl)
            .setName(nl?.autoTag || 'Auto-tag newsletters')
            .setDesc(nl?.autoTagDesc || 'Run AI tagging on full newsletter notes after import')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.newsletterAutoTag)
                .onChange(value => {
                    this.plugin.settings.newsletterAutoTag = value;
                    void this.plugin.saveSettings();
                }));

        // Auto-fetch toggle
        new Setting(this.containerEl)
            .setName(nl?.autoFetch || 'Auto-fetch')
            .setDesc(nl?.autoFetchDesc || 'Automatically fetch newsletters in the background while Obsidian is open')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.newsletterAutoFetch)
                .onChange(value => {
                    this.plugin.settings.newsletterAutoFetch = value;
                    void this.plugin.saveSettings();
                    this.settingTab.display();
                }));

        // Interval dropdown — only shown when auto-fetch is on
        if (this.plugin.settings.newsletterAutoFetch) {
            new Setting(this.containerEl)
                .setName(nl?.autoFetchInterval || 'Check interval')
                .setDesc(nl?.autoFetchIntervalDesc || 'How often to check for new newsletters')
                .addDropdown(drop => {
                    drop.addOption('30',   nl?.autoFetchInterval30min || 'Every 30 minutes');
                    drop.addOption('60',   nl?.autoFetchInterval1h    || 'Every hour');
                    drop.addOption('120',  nl?.autoFetchInterval2h    || 'Every 2 hours');
                    drop.addOption('360',  nl?.autoFetchInterval6h    || 'Every 6 hours');
                    drop.addOption('720',  nl?.autoFetchInterval12h   || 'Every 12 hours');
                    drop.addOption('1440', nl?.autoFetchInterval24h   || 'Once a day');
                    drop.setValue(String(this.plugin.settings.newsletterAutoFetchIntervalMins));
                    drop.onChange(value => {
                        this.plugin.settings.newsletterAutoFetchIntervalMins = Number(value);
                        void this.plugin.saveSettings();
                    });
                });
        }

        // Fetch Now button
        new Setting(this.containerEl)
            .setName(nl?.fetchNow || 'Fetch now')
            .addButton(btn => btn
                .setButtonText(nl?.fetchNow || 'Fetch now')
                .setCta()
                .onClick(async () => {
                    btn.setDisabled(true);
                    btn.setButtonText(nl?.fetching || 'Fetching...');
                    try {
                        const service = new NewsletterService(this.plugin);
                        await service.loadSeenIds();
                        const result = await service.fetchAndProcess();
                        showNewsletterFetchResultNotice(result, this.plugin);
                        await this.plugin.updateNewsletterLastFetchTime();
                    } catch (e) {
                        const msg = e instanceof Error ? e.message : String(e);
                        new Notice((nl?.fetchError || 'Failed to fetch: {error}').replace('{error}', msg));
                    } finally {
                        btn.setDisabled(false);
                        btn.setButtonText(nl?.fetchNow || 'Fetch now');
                    }
                }));

        // Last fetched display + Reset import history
        const lastTime = this.plugin.newsletterLastFetchTime;
        const lastFetchedText = lastTime === 0
            ? (nl?.lastFetchedNever || 'Never fetched')
            : (nl?.lastFetched || 'Last fetched: {time}').replace('{time}', formatRelativeTime(lastTime));

        new Setting(this.containerEl)
            .setName(nl?.resetHistory || 'Reset import history')
            .setDesc(`${nl?.resetHistoryDesc || 'Clear the seen-IDs cache so previously imported newsletters can be re-imported'}  ·  ${lastFetchedText}`)
            .addButton(btn => btn
                .setButtonText(nl?.resetHistory || 'Reset import history')
                .setWarning()
                .onClick(async () => {
                    btn.setDisabled(true);
                    try {
                        const data = (await this.plugin.loadData()) ?? {};
                        delete data[SEEN_DATA_KEY];
                        delete data[LAST_FETCH_DATA_KEY];
                        await this.plugin.saveData(data);
                        this.plugin.newsletterSeenIds = [];
                        this.plugin.newsletterLastFetchTime = 0;
                        new Notice(nl?.resetHistoryDone || 'Import history cleared');
                        this.settingTab.display();
                    } finally {
                        btn.setDisabled(false);
                    }
                }));
    }

}

function formatRelativeTime(timestamp: number): string {
    const diffMs = Date.now() - timestamp;
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
}
