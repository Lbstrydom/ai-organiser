import { Notice, Setting, requestUrl } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { AIOrganiserSettingTab } from './AIOrganiserSettingTab';
import { BaseSettingSection } from './BaseSettingSection';
import { getNewsletterOutputFullPath, getEffectiveOutputRoot } from '../../core/settings';
import { NewsletterService, SEEN_DATA_KEY, LAST_FETCH_DATA_KEY } from '../../services/newsletter/newsletterService';
import { showNewsletterFetchResultNotice } from '../../commands/newsletterCommands';
import { addFolderPicker } from './components/FolderSuggest';
import { logger } from '../../utils/logger';
import { describeError, formatGuidance } from '../../core/friendlyErrors';
import { COMMON_LANGUAGES, getLanguageDisplayName } from '../../services/languages';
import { updatePluginData } from '../../core/pluginDataStore';
import { getAudioMode, isAudioMode } from '../../services/newsletter/newsletterAudioMode';
import { normaliseWhenBehind } from '../../services/newsletter/catchUp/catchUpTypes';
import { getReadMode, isReadMode, type NewsletterReadMode } from '../../services/newsletter/newsletterReadMode';
import { bumpReadGeneration } from '../../services/newsletter/newsletterReadSignal';
import { lookbackClampNote } from '../../services/newsletter/catchUp/catchUpFormat';
import { CATCHUP_BASE_CAP_MINS, CATCHUP_BIG_THRESHOLD_DAYS, CATCHUP_CLEANUP_MAX_DAYS, normaliseCleanupDays } from '../../services/newsletter/catchUp/catchUpTypes';

const APPS_SCRIPT_TEMPLATE = `// Handles both fetch and confirm via GET query params.
// Apps Script redirects POST requests (302→GET), dropping the body,
// so everything uses doGet with an "action" parameter instead.
function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) ? e.parameter.action : 'fetch';

  // --- Confirm: mark read, remove label, archive ---
  if (action === 'confirm') {
    var idStr = (e && e.parameter && e.parameter.ids) ? e.parameter.ids : '';
    var ids = idStr.split(',').filter(function(id) { return id.length > 0; });
    var labelName2 = (e && e.parameter && e.parameter.label) ? e.parameter.label : 'Newsletters';
    var confirmLabel = GmailApp.getUserLabelByName(labelName2);
    var count = 0;
    for (var i = 0; i < ids.length; i++) {
      try {
        var msg = GmailApp.getMessageById(ids[i]);
        if (msg) {
          msg.markRead();
          var thread = msg.getThread();
          if (confirmLabel) thread.removeLabel(confirmLabel);
          thread.moveToArchive();
          count++;
        }
      } catch (ex) { /* skip invalid/deleted message IDs */ }
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
    /** Re-evaluates the "retention shortens the catch-up window" note; set while the catch-up settings are shown. */
    private refreshClampNote: (() => void) | null = null;

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
        // The feature flag (Settings → Features) is the master switch (FT-11). This section
        // only renders when newsletter is enabled, so it shows configuration only — the
        // redundant inner enable toggle was removed.
        this.containerEl.createEl('p', {
            text: t.features.managedInFeatures,
            cls: 'setting-item-description'
        });

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
                drop.addOption('20', '20 (Default)');
                drop.addOption('30', '30');
                drop.addOption('50', '50');
                drop.setValue(String(this.plugin.settings.newsletterFetchLimit || 20));
                drop.onChange(value => {
                    this.plugin.settings.newsletterFetchLimit = Number(value);
                    void this.plugin.saveSettings();
                });
            });

        // Output folder — browse-style picker. Displays the resolved full path;
        // stores the subfolder relative to the output-root (prefix stripped).
        const pluginPrefix = `${getEffectiveOutputRoot(this.plugin.settings)}/`;
        addFolderPicker(
            new Setting(this.containerEl)
                .setName(nl?.outputFolder || 'Output folder')
                .setDesc(nl?.outputFolderDesc || 'Where to save newsletter digest notes'),
            this.plugin.app,
            () => getNewsletterOutputFullPath(this.plugin.settings),
            (value) => {
                const sanitized = (value || 'Newsletter Inbox').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
                const normalized = sanitized.startsWith(pluginPrefix) ? sanitized.slice(pluginPrefix.length) : sanitized;
                this.plugin.settings.newsletterOutputFolder = normalized || 'Newsletter Inbox';
                void this.plugin.saveSettings();
            },
            getNewsletterOutputFullPath(this.plugin.settings),
        );

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
                const cu = nl?.catchUp;
                const audioMode = getAudioMode(this.plugin.settings);
                new Setting(this.containerEl).setName(cu?.heading || 'Catch-up audio').setHeading();
                new Setting(this.containerEl)
                    .setName(cu?.modeLabel || 'Audio delivery')
                    .setDesc((audioMode === 'daily' ? cu?.modeDescDaily : audioMode === 'smart-daily' ? cu?.modeDescSmartDaily : cu?.modeDescOnDemand) || '')
                    .addDropdown(drop => drop
                        .addOption('on-demand', cu?.modeOnDemand || 'On demand')
                        .addOption('smart-daily', cu?.modeSmartDaily || 'Smart daily')
                        .addOption('daily', cu?.modeDaily || 'Daily')
                        .setValue(audioMode)
                        .onChange(value => {
                            if (!isAudioMode(value)) return;
                            this.plugin.settings.newsletterAudioMode = value;
                            void this.plugin.saveSettings();
                            this.settingTab.display();
                        }));

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

                if (audioMode === 'daily') {
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

                    // Manual "Regenerate audio for today" button — lets users
                    // trigger TTS against today's existing Daily Brief without
                    // waiting for a new fetch (needed when audio toggle was
                    // turned on AFTER today's brief already ran, or to re-render
                    // with a different voice).
                    new Setting(this.containerEl)
                        .setName(nl?.audioRegenerateForToday || 'Regenerate audio for today')
                        .setDesc(nl?.audioRegenerateForTodayDesc || 'Use today\'s existing Daily Brief to produce a fresh audio podcast.')
                        .addButton(btn => btn
                            .setButtonText(nl?.audioRegenerateButton || 'Regenerate now')
                            .onClick(async () => {
                                const { runRegenerateAudio } = await import('../../commands/newsletterCommands');
                                btn.setDisabled(true).setButtonText('…');
                                try {
                                    await runRegenerateAudio(this.plugin);
                                } finally {
                                    btn.setDisabled(false).setButtonText(nl?.audioRegenerateButton || 'Regenerate now');
                                }
                            }));
                } else {
                    this.renderCatchUpSettings();
                }
            }

            // ── Local news ──────────────────────────────────────────────
            new Setting(this.containerEl)
                .setName(nl?.homeRegion || 'Home region')
                .setDesc(nl?.homeRegionDesc || 'Local news about this region is given its own section and is never dropped to make room for international stories. Separate alternative names with semicolons. Leave empty to turn this off.')
                .addText(text => text
                    .setPlaceholder('Leidschendam; Voorburg; Netherlands')
                    .setValue(this.plugin.settings.newsletterHomeRegion || '')
                    .onChange(value => {
                        this.plugin.settings.newsletterHomeRegion = value;
                        void this.plugin.saveSettings();
                    }));

            // ── Story memory ────────────────────────────────────────────
            new Setting(this.containerEl)
                .setName(nl?.storyMemory || 'Story memory')
                .setDesc(nl?.storyMemoryDesc || 'Remember which stories you have already been told, so the brief leads with what is new instead of retelling. Turning this off deletes the stored history.')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.newsletterStoryMemory !== false)
                    .onChange(async value => {
                        this.plugin.settings.newsletterStoryMemory = value;
                        await this.plugin.saveSettings();
                        // Turning memory off must actually forget. Pruning is
                        // driven by store activity, so a disabled feature would
                        // otherwise strand a week of story text in plugin data —
                        // the opposite of what switching it off implies.
                        if (!value) {
                            const purged = await new NewsletterService(this.plugin).clearStoryMemory();
                            if (!purged.ok) {
                                logger.warn('Newsletter', `Failed to clear story memory: ${purged.error}`);
                                new Notice(formatGuidance(describeError(this.plugin.t, 'read-save-failed')), 6000);
                            }
                        }
                        this.settingTab.display();
                    }));

            if (this.plugin.settings.newsletterStoryMemory !== false) {
                // One map of the three "mark as" ideas, once, where all of them live.
                new Setting(this.containerEl)
                    .setName(nl?.listenReadKnown || 'How listened, read and known fit together')
                    .setDesc(nl?.listenReadKnownDesc || '');
                this.renderReadSignal(nl);
                new Setting(this.containerEl)
                    .setName(nl?.markCaughtUp || 'Mark all stories as already known')
                    .setDesc(nl?.markCaughtUpDesc || 'Known: tell the brief you already know every earlier story, so it stops retelling them.')
                    .addButton(btn => btn
                        .setButtonText(nl?.markCaughtUpButton || 'Mark as known')
                        .onClick(async () => {
                            btn.setDisabled(true);
                            try {
                                const { runMarkCaughtUp } = await import('../../commands/newsletterCommands');
                                await runMarkCaughtUp(this.plugin);
                            } finally {
                                btn.setDisabled(false).setButtonText(nl?.markCaughtUpButton || 'Mark as known');
                            }
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

            new Setting(this.containerEl)
                .setName(nl?.briefCutoffMinute || 'Brief day cutoff (minutes)')
                .setDesc(nl?.briefCutoffMinuteDesc || 'Minute offset within the cutoff hour, for sub-hour precision (e.g. 7:30).')
                .addSlider(slider => slider
                    .setLimits(0, 45, 15)
                    .setValue(this.plugin.settings.newsletterBriefCutoffMinute ?? 0)
                    .setDynamicTooltip()
                    .onChange(value => {
                        this.plugin.settings.newsletterBriefCutoffMinute = value;
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
                    this.refreshClampNote?.();
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
                        await updatePluginData(this.plugin, (data) => {
                            delete data[SEEN_DATA_KEY];
                            delete data[LAST_FETCH_DATA_KEY];
                            return { changed: true };
                        });
                        this.plugin.newsletterSeenIds = [];
                        this.plugin.newsletterLastFetchTime = 0;
                        new Notice(nl?.resetHistoryDone || 'Import history cleared');
                        this.settingTab.display();
                    } finally {
                        btn.setDisabled(false);
                    }
                }));
    }

    /** Catch-up controls, shown for the on-demand and smart-daily modes. */
    /** Which briefs count as read, so the written brief stops retelling earlier days. Needs story memory. */
    private renderReadSignal(nl: AIOrganiserPlugin['t']['settings']['newsletter'] | undefined): void {
        const settings = this.plugin.settings;
        const mode = getReadMode(settings);
        new Setting(this.containerEl)
            .setName(nl?.readMode || 'Briefs you have read')
            .setDesc(nl?.readModeDesc || 'Stop retelling stories from earlier days that you have already read in the written brief.')
            .addDropdown(dd => dd
                .addOption('off', nl?.readModeOff || 'Off')
                .addOption('explicit', nl?.readModeExplicit || 'Only when I mark a brief as read')
                .addOption('read-through', nl?.readModeReadThrough || 'When I read it through, or mark it')
                .setValue(mode)
                .onChange(async (value) => {
                    // One transition at a time: the control is inert until persistence and the purge have finished.
                    dd.setDisabled(true);
                    const previous = getReadMode(settings);
                    const next: NewsletterReadMode = isReadMode(value) ? value : 'off';
                    try {
                        // Invalidate sessions that qualified under the old mode BEFORE anything is awaited.
                        bumpReadGeneration();
                        settings.newsletterReadMode = next;
                        await this.plugin.saveSettings();
                        if (next === 'off') {
                            const res = await new NewsletterService(this.plugin).clearReadHistory();
                            if (!res.ok) {
                                // Collection is already off; nothing reads the old record while it is. Say so, and keep Forget available.
                                logger.warn('Newsletter', `Failed to clear read history: ${res.error}`);
                                new Notice(formatGuidance(describeError(this.plugin.t, 'read-save-failed')), 6000);
                            }
                        }
                    } catch (e) {
                        // The mode could not be saved: put the control back to what is really stored.
                        logger.warn('Newsletter', 'Failed to save the read mode', e);
                        settings.newsletterReadMode = previous;
                        new Notice(formatGuidance(describeError(this.plugin.t, 'read-save-failed')), 6000);
                    } finally {
                        this.settingTab.display();
                    }
                }));

        {
            new Setting(this.containerEl)
                .setName(nl?.forgetRead || 'Forget what I have read')
                .setDesc(nl?.forgetReadDesc || 'Deletes the record of which briefs you read. Stories may be retold once.')
                .addButton(btn => btn
                    .setButtonText(nl?.forgetReadButton || 'Forget')
                    .onClick(async () => {
                        btn.setDisabled(true);
                        try {
                            const res = await new NewsletterService(this.plugin).clearReadHistory();
                            new Notice(res.ok ? (nl?.forgetReadDone || 'Forgotten.') : formatGuidance(describeError(this.plugin.t, 'read-save-failed')), 4000);
                        } finally {
                            btn.setDisabled(false);
                        }
                    }));
        }
    }

    private renderCatchUpSettings(): void {
        const cu = this.plugin.t.settings?.newsletter?.catchUp;
        const settings = this.plugin.settings;

        new Setting(this.containerEl)
            .setName(cu?.lookbackDays || 'Catch-up window (days)')
            .setDesc(cu?.lookbackDaysDesc || 'How many calendar days, today included, a catch-up looks back over.')
            .addSlider(slider => slider
                .setLimits(1, 14, 1)
                .setValue(settings.newsletterCatchUpLookbackDays ?? 7)
                .setDynamicTooltip()
                .onChange(value => {
                    settings.newsletterCatchUpLookbackDays = value;
                    void this.plugin.saveSettings();
                    this.refreshClampNote?.();
                }));
        // Said where it is set, and as it changes: a retention period shorter than the window silently shortens it.
        const clampNote = this.containerEl.createDiv({ cls: 'setting-item-description ai-organiser-catchup-clamp-note', attr: { role: 'status' } });
        this.refreshClampNote = () => {
            const text = lookbackClampNote(this.plugin.t, settings.newsletterCatchUpLookbackDays, settings.newsletterRetentionDays ?? 30);
            clampNote.setText(text ?? '');
            clampNote.toggleClass('is-hidden', text === null);
        };
        this.refreshClampNote();

        new Setting(this.containerEl)
            .setName(cu?.maxMins || 'Longest episode (minutes)')
            .setDesc((cu?.maxMinsDesc || 'An episode aims for about {base} minutes, and up to this limit when {days} or more days are pending.')
                .replace('{base}', String(CATCHUP_BASE_CAP_MINS)).replace('{days}', String(CATCHUP_BIG_THRESHOLD_DAYS)))
            .addSlider(slider => slider
                .setLimits(5, 20, 1)
                .setValue(settings.newsletterCatchUpMaxMins ?? 20)
                .setDynamicTooltip()
                .onChange(value => {
                    settings.newsletterCatchUpMaxMins = value;
                    void this.plugin.saveSettings();
                }));

        new Setting(this.containerEl)
            .setName(cu?.statusBar || 'Show pending days in the status bar')
            .setDesc(cu?.statusBarDesc || 'Desktop only. Click the status bar item to open the catch-up window.')
            .addToggle(toggle => toggle
                .setValue(settings.newsletterCatchUpStatusBar !== false)
                .onChange(value => {
                    settings.newsletterCatchUpStatusBar = value;
                    void this.plugin.saveSettings();
                }));

        // Only Smart daily acts on its own, so only there is there anything to decide.
        if (getAudioMode(settings) === 'smart-daily') {
            new Setting(this.containerEl)
                .setName(cu?.whenBehindLabel || 'When I am behind')
                .setDesc(cu?.whenBehindDesc || '')
                .addDropdown(drop => drop
                    .addOption('wait', cu?.whenBehindWait || 'Wait for me')
                    .addOption('replace', cu?.whenBehindReplace || 'Replace my unheard episode automatically')
                    .setValue(normaliseWhenBehind(settings.newsletterCatchUpWhenBehind))
                    .onChange(value => {
                        settings.newsletterCatchUpWhenBehind = normaliseWhenBehind(value);
                        void this.plugin.saveSettings();
                    }));
        }

        new Setting(this.containerEl)
            .setName(cu?.cleanupDays || 'Remove audio of heard episodes after (days)')
            .setDesc(cu?.cleanupDaysDesc || 'Sends the audio file of an episode you have listened to to your trash once its newest day is this many days old. The note and transcript stay. Episodes you have not listened to are never touched. Off at 0.')
            .addSlider(slider => slider
                .setLimits(0, CATCHUP_CLEANUP_MAX_DAYS, 1)
                .setValue(normaliseCleanupDays(settings.newsletterCatchUpAudioCleanupDays))
                .setDynamicTooltip()
                .onChange(value => {
                    settings.newsletterCatchUpAudioCleanupDays = normaliseCleanupDays(value);
                    void this.plugin.saveSettings().then(() => this.plugin.scheduleCatchUpCleanup());
                }));

        if (settings.newsletterStoryMemory === false) {
            new Setting(this.containerEl)
                .setDesc(cu?.memoryOffNote || 'Story memory is off, so a catch-up covers whole days and only days that have closed.');
        }
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
