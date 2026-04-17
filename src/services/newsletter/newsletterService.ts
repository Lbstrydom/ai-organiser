/**
 * Newsletter Service
 *
 * Tier 1: Fetches newsletters from a Google Apps Script endpoint,
 * converts HTML to markdown, runs LLM triage, deduplicates,
 * and generates digest + individual notes in the vault.
 */

import { normalizePath, requestUrl, TAbstractFile, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { logger } from '../../utils/logger';
import type { RawNewsletter, ProcessedNewsletter, NewsletterFetchResult } from './newsletterTypes';
import { htmlToMarkdown, cleanMarkdown, cleanNewsletterMarkdown, extractNewsletterText, extractLinks } from '../../utils/htmlToMarkdown';
import { truncateAtBoundary } from '../tokenLimits';
import { buildTriagePrompt, insertContentIntoTriagePrompt } from '../prompts/triagePrompts';
import { buildDailyBriefPrompt, insertBriefContent, type BriefSource } from '../prompts/newsletterPrompts';
import { summarizeText, pluginContext } from '../llmFacade';
import { ensureFolderExists, sanitizeFileName } from '../../utils/minutesUtils';
import { getNewsletterOutputFullPath } from '../../core/settings';
import { updateAIOMetadata, createSummaryHook } from '../../utils/frontmatterUtils';
import { SourceType } from '../../core/constants';
import { getLanguageNameForPrompt } from '../languages';

const TRIAGE_MAX_CHARS = 6000;
const MAX_SEEN_IDS = 500;
export const SEEN_DATA_KEY = 'newsletter-seen-ids';
export const LAST_FETCH_DATA_KEY = 'newsletter-last-auto-fetch';

export class NewsletterService {
    private readonly plugin: AIOrganiserPlugin;

    constructor(plugin: AIOrganiserPlugin) {
        this.plugin = plugin;
    }

    /** Fetch newsletters from Apps Script endpoint, process, and create vault notes.
     *  Mark-seen is deferred until after vault writes succeed to prevent data loss. */
    async fetchAndProcess(
        onProgress?: (current: number, total: number) => void
    ): Promise<NewsletterFetchResult> {
        const url = this.plugin.settings.newsletterScriptUrl?.trim();
        if (!url) {
            return { newsletters: [], totalFetched: 0, totalNew: 0, totalSkipped: 0, errors: ['No Apps Script URL configured'], hitLimit: false };
        }

        // Fetch raw emails from Apps Script
        let rawEmails: RawNewsletter[];
        try {
            rawEmails = await this.fetchFromAppsScript(url);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return { newsletters: [], totalFetched: 0, totalNew: 0, totalSkipped: 0, errors: [`Fetch failed: ${msg}`], hitLimit: false };
        }

        if (rawEmails.length === 0) {
            return { newsletters: [], totalFetched: 0, totalNew: 0, totalSkipped: 0, errors: [], hitLimit: false };
        }

        const hitLimit = rawEmails.length >= (this.plugin.settings.newsletterFetchLimit || 20);

        // Dedup
        const seenIds = this.getSeenIds();
        const newEmails = rawEmails.filter(e => !seenIds.includes(this.hashId(e.id)));
        const totalSkipped = rawEmails.length - newEmails.length;

        // Phase 1: Process each (HTML→markdown, LLM triage) — no vault writes yet
        const { processed, errors } = await this.processAll(newEmails, onProgress);

        // Phase 2: Write vault notes — only then mark seen
        const createdPaths = await this.writeAndMarkSeen(processed);

        // Phase 3: Post-processing — Bases metadata always, AI tagging if enabled
        if (createdPaths.length > 0) {
            await this.postProcessNotes(createdPaths, processed);
        }

        // Phase 4: Daily brief synthesis (fires after all notes written) — best-effort
        if (this.plugin.settings.newsletterDailyBrief && processed.length > 0) {
            try {
                await this.generateAndInjectBrief(processed);
            } catch (e) {
                logger.warn('Newsletter', 'Daily brief generation failed (non-fatal)', e);
            }
        }

        // Retention pruning — fire-and-forget so it never delays the fetch result.
        // Errors are logged but do not affect the returned NewsletterFetchResult.
        const retentionDays = this.plugin.settings.newsletterRetentionDays ?? 30;
        if (retentionDays > 0) {
            void this.pruneOldNewsletters(retentionDays).catch(e =>
                logger.warn('Newsletter', 'Retention pruning failed (non-fatal)', e)
            );
        }

        return {
            newsletters: processed,
            totalFetched: rawEmails.length,
            totalNew: processed.length,
            totalSkipped,
            errors,
            hitLimit,
        };
    }

    /** Process raw emails into ProcessedNewsletters sequentially to avoid
     *  rate-limiting failures when multiple LLM triage calls fire at once. */
    private async processAll(
        emails: RawNewsletter[],
        onProgress?: (current: number, total: number) => void
    ): Promise<{ processed: ProcessedNewsletter[]; errors: string[] }> {
        const errors: string[] = [];
        const processed: ProcessedNewsletter[] = [];

        for (let i = 0; i < emails.length; i++) {
            try {
                const result = await this.processNewsletter(emails[i]);
                processed.push(result);
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                errors.push(`${emails[i].subject}: ${msg}`);
            }
            onProgress?.(i + 1, emails.length);
        }

        return { processed, errors };
    }

    /** Write vault notes, mark seen locally, then confirm read on Gmail.
     *  Returns created file paths. Gmail confirmation is best-effort. */
    private async writeAndMarkSeen(processed: ProcessedNewsletter[]): Promise<string[]> {
        if (processed.length === 0) return [];
        const createdPaths = await this.createVaultNotes(processed);
        // Mark all seen in-memory first (synchronous), then persist once to avoid
        // concurrent loadData/saveData races that would drop seen IDs.
        for (const nl of processed) {
            this.markSeenInMemory(nl.id);
        }
        await this.persistSeenIds(this.getSeenIds());
        // Confirm to Apps Script that these messages can be marked read in Gmail.
        // Best-effort — if this fails, messages stay unread (safe: plugin dedup prevents re-import)
        await this.confirmReadOnGmail(processed.map(nl => nl.id));
        return createdPaths;
    }

    /** POST message IDs back to Apps Script to mark as read in Gmail.
     *  Returns true if the script confirmed, false if old/missing doPost (needs re-deploy). */
    async confirmReadOnGmail(messageIds: string[]): Promise<boolean> {
        const url = this.plugin.settings.newsletterScriptUrl?.trim();
        if (!url || messageIds.length === 0) return false;
        try {
            // Use GET with query params — Apps Script redirects POST (302→GET),
            // dropping the request body, so doPost never receives the IDs.
            const ids = encodeURIComponent(messageIds.join(','));
            const label = encodeURIComponent(this.plugin.settings.newsletterGmailLabel || 'Newsletters');
            const confirmUrl = `${url}?action=confirm&ids=${ids}&label=${label}`;
            logger.debug('Newsletter', 'Newsletter confirm:', { confirmUrl, count: messageIds.length });
            const response = await requestUrl({ url: confirmUrl, method: 'GET' });
            logger.debug('Newsletter', 'Newsletter confirm response:', {
                status: response.status,
                text: response.text?.slice(0, 200),
            });
            if (response.status >= 400) {
                this.warnOldScript();
                return false;
            }
            // Verify the script returned JSON with ok:true (not an HTML page)
            try {
                const data = JSON.parse(response.text);
                return data?.ok === true;
            } catch {
                this.warnOldScript();
                return false;
            }
        } catch (e) {
            logger.error('Newsletter', 'Newsletter confirm failed', e);
            this.warnOldScript();
            return false;
        }
    }

    /** One-time console warning when the script doesn't support two-phase confirm. */
    private oldScriptWarned = false;
    private warnOldScript(): void {
        if (this.oldScriptWarned) return;
        this.oldScriptWarned = true;
        logger.warn('Newsletter',
            'Newsletter script does not support two-phase confirmation (doPost). ' +
            'Re-deploy the updated script template from Settings → Newsletter Digest → Copy Script Template. ' +
            'Until re-deployed, Gmail messages are marked read before notes are saved.'
        );
    }

    /** Post-process created notes: Bases metadata (always) + AI tagging (if enabled). Best-effort. */
    private async postProcessNotes(
        paths: string[],
        newsletters: ProcessedNewsletter[]
    ): Promise<void> {
        const vault = this.plugin.app.vault;
        const app = this.plugin.app;
        const doAutoTag = this.plugin.settings.newsletterAutoTag;
        const doMetadata = this.plugin.settings.enableStructuredMetadata;

        for (let i = 0; i < paths.length; i++) {
            try {
                const file = vault.getAbstractFileByPath(paths[i]);
                if (!file || !(file instanceof TFile)) continue;

                // AI tagging (gated on setting)
                if (doAutoTag) {
                    const content = await vault.read(file);
                    if (content.trim()) {
                        await this.plugin.analyzeAndTagNote(file, content);
                    }
                }

                // Bases metadata via shared helper (gated on structured metadata setting)
                if (doMetadata) {
                    const nl = newsletters[i];
                    const hook = nl?.triage ? createSummaryHook(nl.triage) : '';
                    await updateAIOMetadata(app, file, {
                        summary: hook || undefined,
                        source: 'email' as SourceType,
                    });
                }
            } catch {
                // Best-effort — don't block the fetch result
            }
        }
    }

    /** Fetch raw emails from Google Apps Script web app. */
    private async fetchFromAppsScript(url: string): Promise<RawNewsletter[]> {
        const label = encodeURIComponent(this.plugin.settings.newsletterGmailLabel || 'Newsletters');
        const limit = this.plugin.settings.newsletterFetchLimit || 20;
        const fetchUrl = `${url}?label=${label}&limit=${limit}`;
        const response = await requestUrl({ url: fetchUrl, method: 'GET' });
        if (response.status !== 200) {
            throw new Error(`HTTP ${response.status}`);
        }
        // Check raw text before parsing — Google returns an HTML login page (not JSON)
        // when the deployment is set to "Only myself" instead of "Anyone".
        const text = response.text;
        if (text.trimStart().startsWith('<')) {
            throw new Error(
                'Script returned an HTML page instead of JSON. ' +
                'In the Apps Script deployment, set "Who has access" to "Anyone" (not "Only myself" or "Anyone with Google account").'
            );
        }
        let data: unknown;
        try {
            data = JSON.parse(text);
        } catch {
            throw new Error('Script returned invalid JSON. Check that the URL points to the deployed web app (ends with /exec), not the script editor.');
        }
        if (!Array.isArray(data)) {
            throw new TypeError('Invalid response: expected JSON array');
        }
        return data as RawNewsletter[];
    }

    /** Convert HTML to markdown, run LLM triage, extract sender name. */
    private async processNewsletter(raw: RawNewsletter): Promise<ProcessedNewsletter> {
        // HTML → clean markdown for vault storage
        // flattenTables: email layout tables become plain paragraphs instead of | pipe | rows
        let markdown: string;
        try {
            markdown = cleanNewsletterMarkdown(cleanMarkdown(htmlToMarkdown(raw.body, { flattenTables: true })));
        } catch {
            markdown = raw.plain || raw.body;
        }
        // Fall back to plain text when HTML conversion lost too much content.
        // Layout-heavy emails (Campaign Monitor, Mailchimp) can produce near-empty
        // markdown after table flattening + image/footer stripping.
        const plainLen = (raw.plain || '').trim().length;
        if (!markdown?.trim() || (plainLen > 200 && markdown.trim().length < plainLen * 0.3)) {
            markdown = cleanNewsletterMarkdown(raw.plain || '(empty newsletter)');
        }

        // LLM triage — use plain prose (no table pipes, no image refs, no URLs)
        // so the model sees actual content rather than markdown formatting noise
        const plainText = extractNewsletterText(markdown);

        // Extraction yield check: compare meaningful-word counts between raw markdown
        // and the extracted plain text. A very low yield means the short-line filter
        // (60-char minimum) stripped too much content — e.g. a newsletter with short
        // punchy lines where extraction only preserved the first sentence.
        // We ALWAYS attempt triage — the check decides WHICH source to use, never
        // whether to triage at all.
        const rawWordCount  = (markdown.match(/\b\w{4,}\b/g) ?? []).length;
        const plainWordCount = (plainText.match(/\b\w{4,}\b/g) ?? []).length;
        // Thresholds: absolute floor of 10 words, OR yield < 15% of a substantial raw
        // (≥100 words). Data from real newsletters shows healthy yield is 60–80%;
        // 15% leaves a wide safety margin without triggering false fallbacks.
        const EXTRACTION_MIN_WORDS = 10;
        const YIELD_MIN_RATIO = 0.15;
        const YIELD_CHECK_MIN_RAW = 100;
        const yieldRatio = rawWordCount > 0 ? plainWordCount / rawWordCount : 0;
        const extractionThin = plainWordCount < EXTRACTION_MIN_WORDS ||
            (rawWordCount >= YIELD_CHECK_MIN_RAW && yieldRatio < YIELD_MIN_RATIO);
        if (extractionThin) {
            logger.warn('Newsletter',
                `Low extraction yield for "${raw.subject}" ` +
                `(${plainWordCount}/${rawWordCount} words, ${Math.round(yieldRatio * 100)}%) ` +
                `— falling back to raw markdown for triage`
            );
        }
        // Use plainText when yield looks healthy; fall back to full markdown otherwise
        const triageSource = extractionThin ? markdown : plainText;

        let triage: string | null = null;
        let llmFailed = false;
        let extractionFailed = false;
        try {
            const truncated = truncateAtBoundary(triageSource, TRIAGE_MAX_CHARS);
            const langCode = this.plugin.settings.newsletterPreferredLanguage;
            const langName = getLanguageNameForPrompt(langCode);
            const prompt = buildTriagePrompt({
                contentType: 'newsletter',
                language: langName || undefined,
            });
            const filled = insertContentIntoTriagePrompt(prompt, truncated);
            const result = await summarizeText(pluginContext(this.plugin), filled);
            if (result.success && result.content) {
                triage = result.content;
            } else {
                llmFailed = true;
                logger.warn('Newsletter', `LLM triage failed for "${raw.subject}": ${result.content || 'empty response'}`);
            }
        } catch (e) {
            llmFailed = true;
            logger.error('Newsletter', `LLM triage error for "${raw.subject}"`, e);
        }
        // Fallback: excerpt from triage source so the digest always shows something
        if (!triage) {
            triage = truncateAtBoundary(triageSource, 500, '...');
            extractionFailed = llmFailed && extractionThin; // only flag if both quality AND LLM failed
        }

        return {
            id: raw.id,
            from: raw.from,
            subject: raw.subject,
            date: raw.date,
            senderName: extractSenderName(raw.from),
            markdown,
            triage,
            llmFailed,
            extractionFailed: extractionFailed || undefined,
            keyLinks: extractNewsletterLinks(raw.body),
        };
    }

    /** Create digest note and individual newsletter notes in the vault.
     *  Returns created file paths for downstream processing (auto-tag, metadata). */
    private async createVaultNotes(newsletters: ProcessedNewsletter[]): Promise<string[]> {
        const vault = this.plugin.app.vault;
        const outputRoot = getNewsletterOutputFullPath(this.plugin.settings);
        const today = new Date();
        const dateStr = today.toISOString().slice(0, 10);
        const dateLabel = today.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

        // Daily subfolder for individual notes
        const dailyFolder = normalizePath(`${outputRoot}/${dateStr}`);
        await ensureFolderExists(vault, dailyFolder);

        // Create individual notes — deterministic path per message (idempotent on retry)
        const createdPaths: string[] = [];
        for (const nl of newsletters) {
            const notePath = this.getDeterministicNotePath(dailyFolder, nl);

            const noteContent = [
                '---',
                'tags:',
                '  - newsletter',
                `created: ${dateStr}`,
                'sender_name: "' + (nl.senderName || '').replaceAll('"', String.raw`\"`) + '"',
                '---',
                '',
                `# ${nl.subject}`,
                '',
                `*From: ${nl.from}*`,
                '',
                nl.triage || '(No summary available)',
                ...(nl.keyLinks.length > 0 ? ['', '## Key Links', '', ...nl.keyLinks.map(l => `- [${l.text}](${l.href})`)] : []),
            ].join('\n');

            const existing = vault.getAbstractFileByPath(notePath);
            if (!existing) {
                await vault.create(notePath, noteContent);
            }
            createdPaths.push(notePath);
            // Stash resolved filename for digest link
            nl._resolvedPath = notePath;
        }

        // Create or update digest note — merge entries, don't raw-append
        await ensureFolderExists(vault, outputRoot);
        const digestPath = getDigestPath(outputRoot, dateStr);

        const existingDigest = vault.getAbstractFileByPath(digestPath);
        if (existingDigest instanceof TFile) {
            await this.mergeIntoExistingDigest(existingDigest, newsletters, dateStr);
        } else {
            const digestContent = this.buildDigestContent(newsletters, dateStr, dateLabel, 0);
            await vault.create(digestPath, digestContent);
        }

        return createdPaths;
    }

    /** Build a deterministic note path for a newsletter.
     *  Uses sender name + short message-ID hash so that:
     *  - Different messages from the same sender get unique paths
     *  - Retrying the same message always targets the same file (idempotent) */
    private getDeterministicNotePath(folder: string, nl: ProcessedNewsletter): string {
        const baseName = sanitizeFileName(nl.senderName || nl.subject);
        const shortHash = this.hashId(nl.id).slice(0, 6);
        return normalizePath(`${folder}/${baseName}-${shortHash}.md`);
    }

    /** Build full digest markdown from scratch. */
    private buildDigestContent(
        newsletters: ProcessedNewsletter[],
        dateStr: string,
        dateLabel: string,
        existingCount: number
    ): string {
        const totalCount = existingCount + newsletters.length;
        const lines: string[] = [
            '---',
            'tags:',
            '  - newsletter-digest',
            `created: ${dateStr}`,
            `newsletter_count: ${totalCount}`,
            '---',
            '',
            `# Newsletter Digest — ${dateLabel}`,
            '',
        ];

        for (const nl of newsletters) {
            lines.push(...this.buildDigestEntry(nl, dateStr));
        }

        return lines.join('\n');
    }

    /** Build a single digest entry block. */
    private buildDigestEntry(nl: ProcessedNewsletter, dateStr: string): string[] {
        // Use resolved unique path if available, else derive from sender/subject
        const resolvedPath = nl._resolvedPath;
        const linkTarget = resolvedPath
            ? resolvedPath.split('/').slice(-2).join('/').replace(/\.md$/, '')
            : `${dateStr}/${sanitizeFileName(nl.senderName || nl.subject)}`;
        const summaryLine = nl.extractionFailed
            ? '⚠️ *Content could not be extracted — open the raw note to read manually.*'
            : (nl.triage || '(No summary available)');
        return [
            `## ${nl.senderName || nl.subject}`,
            `*From: ${nl.from}*`,
            '',
            summaryLine,
            '',
            `**[[${linkTarget}|Read full]]** · *Summarize*`,
            '',
            '---',
            '',
        ];
    }

    /** Merge new entries into an existing digest, updating frontmatter count. */
    private async mergeIntoExistingDigest(
        file: TFile,
        newsletters: ProcessedNewsletter[],
        dateStr: string
    ): Promise<void> {
        const vault = this.plugin.app.vault;
        const existing = await vault.cachedRead(file);

        // Parse existing count from frontmatter
        const countRegex = /newsletter_count:\s*(\d+)/;
        const countMatch = countRegex.exec(existing);
        const existingCount = countMatch ? Number.parseInt(countMatch[1], 10) : 0;
        const newCount = existingCount + newsletters.length;

        // Update the count in frontmatter
        let updated = existing.replace(
            /newsletter_count:\s*\d+/,
            `newsletter_count: ${newCount}`
        );

        // Build new entries, skipping any whose note path already appears in the digest
        const newEntries = newsletters
            .filter(nl => {
                if (!nl._resolvedPath) return true;
                const linkSlug = nl._resolvedPath.split('/').slice(-2).join('/').replace(/\.md$/, '');
                return !updated.includes(`[[${linkSlug}`);
            })
            .map(nl => this.buildDigestEntry(nl, dateStr).join('\n'))
            .join('\n');

        if (!newEntries.trim()) return;

        // Append new entries at the end (after trimming trailing whitespace)
        updated = updated.trimEnd() + '\n\n' + newEntries;

        await vault.modify(file, updated);
    }

    // ── Daily Brief (Phase 4) ────────────────────────────────────────────

    /**
     * Generate a synthesised daily brief from all newsletters in today's digest
     * and inject it as a managed block at the top of the digest file.
     * Called after all newsletter notes are written so standalone reconstruction works.
     */
    private async generateAndInjectBrief(currentBatch: ProcessedNewsletter[]): Promise<void> {
        const vault = this.plugin.app.vault;
        const outputRoot = getNewsletterOutputFullPath(this.plugin.settings);
        const dateStr = getBriefDateStr(this.plugin.settings.newsletterBriefCutoffHour ?? 6);
        const digestPath = getDigestPath(outputRoot, dateStr);

        const digestFile = vault.getAbstractFileByPath(digestPath);
        if (!(digestFile instanceof TFile)) return;

        // Collect full day's sources (current batch + previously written notes)
        const sources = await this.collectDayNewsletters(digestFile, currentBatch);
        if (sources.length < 2) return; // no synthesis value for a single source

        const langCode = this.plugin.settings.newsletterPreferredLanguage;
        const langName = getLanguageNameForPrompt(langCode);
        const { filled, truncatedCount } = insertBriefContent(
            buildDailyBriefPrompt({ language: langName || undefined }),
            sources
        );

        let brief: string | null = null;
        try {
            const result = await summarizeText(pluginContext(this.plugin), filled);
            if (result.success && result.content && result.content.trim().length >= 50) {
                brief = result.content.trim();
            }
        } catch (e) {
            logger.warn('Newsletter', 'Daily brief LLM call failed', e);
        }

        if (!brief) return; // leave existing block unchanged on failure

        const truncationSuffix = truncatedCount > 1 ? 's were' : ' was';
        const truncationWarning = truncatedCount > 0
            ? `\n> [!note] ${truncatedCount} newsletter${truncationSuffix} excluded from this synthesis — the digest was too long to fit the synthesis budget.\n`
            : '';

        await this.mergeOrPrependBrief(digestFile, brief + truncationWarning);

        // Phase 5: Audio podcast — runs only when Daily Brief succeeded
        if (this.plugin.settings.newsletterAudioPodcast) {
            await this.generateAudioForBrief(brief, outputRoot, dateStr);
        }
    }

    private async generateAudioForBrief(brief: string, outputRoot: string, dateStr: string): Promise<void> {
        try {
            // Resolve Gemini API key: provider-specific key → main key if cloudServiceType=gemini
            const settings = this.plugin.settings;
            const geminiApiKey =
                settings.providerSettings?.['gemini']?.apiKey ||
                (settings.cloudServiceType === 'gemini' ? settings.cloudApiKey : '') ||
                '';
            if (!geminiApiKey) {
                logger.warn('Newsletter', 'Audio podcast skipped — no Gemini API key configured');
                return;
            }

            const { buildPodcastScriptPrompt, insertPodcastContent } = await import('../prompts/newsletterPrompts');
            const langCode = this.plugin.settings.newsletterPreferredLanguage;
            const { getLanguageNameForPrompt: getLang } = await import('../languages');
            const langName = getLang(langCode);

            const maxMins = this.plugin.settings.newsletterPodcastMaxMins ?? 5;
            const scriptPrompt = insertPodcastContent(
                buildPodcastScriptPrompt({ language: langName || undefined, maxMins }),
                brief
            );
            const scriptResult = await summarizeText(pluginContext(this.plugin), scriptPrompt);
            if (!scriptResult.success || !scriptResult.content) {
                logger.warn('Newsletter', 'Podcast script LLM call failed');
                return;
            }
            const podcastScript = scriptResult.content.trim();

            const { generateAudioPodcast } = await import('./newsletterAudioService');
            const audioFolder = normalizePath(`${outputRoot}/${dateStr}`);
            const result = await generateAudioPodcast(this.plugin.app, podcastScript, {
                apiKey: geminiApiKey,
                voice: this.plugin.settings.newsletterPodcastVoice || 'Charon',
                outputFolder: audioFolder,
                dateStr,
            });

            if (!result.success) {
                logger.warn('Newsletter', 'Audio podcast generation failed', result.error);
            }
        } catch (e) {
            logger.warn('Newsletter', 'Audio podcast pipeline error', e);
        }
    }

    /**
     * Collect { sourceDisplayName, triageText } for every newsletter in the day's digest.
     * For the current batch, uses in-memory fields.
     * For previously-written newsletters, reads their vault note files.
     */
    private async collectDayNewsletters(
        digestFile: TFile,
        currentBatch: ProcessedNewsletter[]
    ): Promise<BriefSource[]> {
        const vault = this.plugin.app.vault;
        const digestContent = await vault.cachedRead(digestFile);
        const dateStr = /(\d{4}-\d{2}-\d{2})/.exec(digestFile.path)?.[1] ?? '';

        // Build a map from resolved path → in-memory data for current batch
        const batchByPath = new Map<string, ProcessedNewsletter>();
        for (const nl of currentBatch) {
            if (nl._resolvedPath) batchByPath.set(nl._resolvedPath, nl);
        }

        // Find all newsletter note links in the digest: [[<dateStr>/name|...]] or [[<dateStr>/name.md|...]]
        // Obsidian wikilinks typically omit .md — match with or without extension
        const linkRegex = new RegExp(String.raw`\[\[` + dateStr + String.raw`/([^\]|]+?)(?:\.md)?[|\]]`, 'g');
        const seen = new Set<string>();
        const sources: BriefSource[] = [];

        let match: RegExpExecArray | null;
        while ((match = linkRegex.exec(digestContent)) !== null) {
            // Ensure .md extension for vault path resolution
            const fileName = match[1].endsWith('.md') ? match[1] : `${match[1]}.md`;
            const relativePath = `${digestFile.parent?.path ?? ''}/${dateStr}/${fileName}`;
            const normalizedPath = relativePath.replaceAll('//', '/').replace(/^\//, '');

            if (seen.has(normalizedPath)) continue;
            seen.add(normalizedPath);

            // Prefer in-memory data for current batch entries
            const inMemory = batchByPath.get(normalizedPath);
            if (inMemory) {
                sources.push({
                    sourceDisplayName: inMemory.senderName || inMemory.subject,
                    triageText: inMemory.triage ?? '',
                });
                continue;
            }

            // Read from vault for previously-written notes
            const noteFile = vault.getAbstractFileByPath(normalizedPath);
            if (!(noteFile instanceof TFile)) continue;

            try {
                const content = await vault.cachedRead(noteFile);
                sources.push({
                    sourceDisplayName: extractFrontmatterField(content, 'sender_name') ?? extractSenderName(noteFile.basename),
                    triageText: extractTriageFromNote(content),
                });
            } catch {
                // best-effort — skip unreadable notes
            }
        }

        return sources;
    }

    /**
     * Insert or replace the managed Daily Brief block in the digest file.
     * Uses <!-- DAILY_BRIEF_START --> / <!-- DAILY_BRIEF_END --> markers.
     */
    private async mergeOrPrependBrief(file: TFile, brief: string): Promise<void> {
        const vault = this.plugin.app.vault;
        const existing = await vault.cachedRead(file);

        const managedBlock = `<!-- DAILY_BRIEF_START -->\n## Daily Brief\n\n${brief}\n\n<!-- DAILY_BRIEF_END -->`;

        let updated: string;
        if (existing.includes('<!-- DAILY_BRIEF_START -->')) {
            // Replace existing block
            updated = existing.replace(
                /<!-- DAILY_BRIEF_START -->[\s\S]*?<!-- DAILY_BRIEF_END -->/,
                managedBlock
            );
        } else {
            // Insert after the H1 heading line
            const h1Match = /^# .+$/m.exec(existing);
            if (h1Match) {
                const insertAt = (h1Match.index ?? 0) + h1Match[0].length;
                updated = existing.slice(0, insertAt) + '\n\n' + managedBlock + '\n\n' + existing.slice(insertAt).trimStart();
            } else {
                updated = managedBlock + '\n\n' + existing;
            }
        }

        await vault.modify(file, updated);
    }

    // ── Dedup helpers ────────────────────────────────────────────────────

    private getSeenIds(): string[] {
        const data = this.plugin.newsletterSeenIds;
        return Array.isArray(data) ? data : [];
    }

    /** Update in-memory seen list without persisting — call `persistSeenIds` once after batching. */
    private markSeenInMemory(id: string): void {
        const seen = this.getSeenIds();
        seen.push(this.hashId(id));
        if (seen.length > MAX_SEEN_IDS) seen.splice(0, seen.length - MAX_SEEN_IDS);
        this.plugin.newsletterSeenIds = seen;
    }

    private hashId(id: string): string {
        // Simple hash — deterministic, fast, no crypto needed for dedup
        let hash = 0;
        for (let i = 0; i < id.length; i++) {
            hash = Math.trunc((hash << 5) - hash + (id.codePointAt(i) ?? 0));
        }
        return hash.toString(36);
    }

    async loadSeenIds(): Promise<void> {
        try {
            const data = await this.plugin.loadData();
            this.plugin.newsletterSeenIds = data?.[SEEN_DATA_KEY] ?? [];
        } catch {
            this.plugin.newsletterSeenIds = [];
        }
    }

    private async persistSeenIds(seen: string[]): Promise<void> {
        try {
            const data = (await this.plugin.loadData()) ?? {};
            data[SEEN_DATA_KEY] = seen;
            await this.plugin.saveData(data);
        } catch {
            // Silent — dedup is best-effort
        }
    }

    /**
     * Delete date-subdirectories and digest files older than retentionDays.
     * Only touches folders/files matching the newsletter date pattern (YYYY-MM-DD).
     */
    private async pruneOldNewsletters(retentionDays: number): Promise<void> {
        const { vault, fileManager } = this.plugin.app;
        const outputRoot = getNewsletterOutputFullPath(this.plugin.settings);
        const rootFolder = vault.getAbstractFileByPath(normalizePath(outputRoot));
        if (!rootFolder || !('children' in rootFolder)) return;

        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - retentionDays);
        const cutoffStr = cutoff.toISOString().slice(0, 10);

        for (const child of (rootFolder as { children: unknown[] }).children) {
            if (child instanceof TAbstractFile && isExpiredNewsletterEntry(child, cutoffStr)) {
                try { await fileManager.trashFile(child); } catch { /* best-effort */ }
            }
        }
    }
}

/**
 * Returns the YYYY-MM-DD string for the current "brief day".
 * If the current hour is before cutoffHour, the brief belongs to yesterday's date
 * (e.g. newsletters arriving at 2am still roll up into the previous day's brief).
 */
export function getBriefDateStr(cutoffHour: number): string {
    const now = new Date();
    if (now.getHours() < cutoffHour) {
        now.setDate(now.getDate() - 1);
    }
    return now.toISOString().slice(0, 10);
}

/**
 * Returns true if a vault entry (folder or file) is an expired newsletter
 * date-directory (YYYY-MM-DD) or digest file (Digest — YYYY-MM-DD.md).
 */
function isExpiredNewsletterEntry(child: TAbstractFile, cutoffStr: string): boolean {
    const { name } = child;
    if (/^\d{4}-\d{2}-\d{2}$/.test(name)) return name < cutoffStr;
    const m = /^Digest — (\d{4}-\d{2}-\d{2})\.md$/.exec(name);
    return m !== null && m[1] < cutoffStr;
}

const NEWSLETTER_LINK_SKIP = ['unsubscribe', 'optout', 'opt-out', 'manage-preferences', 'email-preferences', 'view-in-browser', 'webversion', 'mailto:', 'twitter.com', 'facebook.com', 'instagram.com', 'linkedin.com'];

function extractNewsletterLinks(htmlBody: string): Array<{text: string; href: string}> {
    if (!htmlBody) return [];
    return extractLinks(htmlBody)
        .filter(l =>
            !NEWSLETTER_LINK_SKIP.some(p => l.href.toLowerCase().includes(p)) &&
            l.text.length > 3
        )
        .slice(0, 10);
}

/** Build the vault path for today's digest note. */
export function getDigestPath(outputRoot: string, dateStr: string): string {
    return normalizePath(`${outputRoot}/Digest — ${dateStr}.md`);
}

/** Extract display name from "Name <email>" format. */
export function extractSenderName(from: string): string {
    // "Morning Brew <morning@brew.com>" → "Morning Brew"
    const match = /^"?([^"<]+)"?\s*<.*>$/.exec(from);
    if (match) return match[1].trim();
    // "email@example.com" → "email"
    const atIdx = from.indexOf('@');
    if (atIdx > 0) return from.slice(0, atIdx);
    return from.trim();
}

/**
 * Extract a named field from YAML frontmatter.
 * Handles simple scalar values (string, number, boolean).
 */
export function extractFrontmatterField(content: string, field: string): string | undefined {
    const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    if (!fmMatch) return undefined;
    const yaml = fmMatch[1];
    // Match "field: value" or `field: "quoted value"`
    const lineMatch = new RegExp(
        String.raw`^${field}\s*:\s*"?([^"\r\n]+)"?\s*$`,
        'm'
    ).exec(yaml);
    if (!lineMatch) return undefined;
    return lineMatch[1].trim();
}

/**
 * Extract the triage body from a newsletter vault note.
 * Strips YAML frontmatter and the "## Key Links" section.
 */
export function extractTriageFromNote(content: string): string {
    // Strip frontmatter
    let body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    // Strip ## Key Links section (and everything after it in the note)
    const keyLinksIdx = /^## Key Links\b/m.exec(body)?.index;
    if (keyLinksIdx !== undefined) {
        body = body.slice(0, keyLinksIdx);
    }
    return body.trim();
}
