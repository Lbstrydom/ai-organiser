/**
 * Newsletter Service
 *
 * Tier 1: Fetches newsletters from a Google Apps Script endpoint,
 * converts HTML to markdown, runs LLM triage, deduplicates,
 * and generates digest + individual notes in the vault.
 */

import { Notice, normalizePath, requestUrl, TAbstractFile, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { logger } from '../../utils/logger';
import type { RawNewsletter, ProcessedNewsletter, NewsletterFetchResult } from './newsletterTypes';
import { htmlToMarkdown, cleanMarkdown, cleanNewsletterMarkdown, extractNewsletterText, extractLinks } from '../../utils/htmlToMarkdown';
import { truncateAtBoundary, getMaxContentCharsForModel } from '../tokenLimits';
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
            // Recovery sweep MUST run even on empty fetches — that's the
            // most common scenario where it matters (no new emails today
            // means yesterday's bucket is closed but no fetch is bringing
            // new content to retrigger generateBriefsPerBucket). Skipping
            // here defeats the entire fix.
            // (Verified via persona-harness 2026-04-26: prior version
            // returned here before reaching the Phase 4b sweep, so April
            // 24's missing audio was never recovered.)
            try {
                await this.recoverMissedAudioPodcasts();
            } catch (e) {
                logger.warn('Newsletter', 'Audio recovery sweep failed (non-fatal)', e);
            }
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

        // Phase 4: Daily brief synthesis — one brief per bucket that got
        // content (extracted to keep this function under the SonarQube
        // cognitive-complexity ceiling).
        if (this.plugin.settings.newsletterDailyBrief && processed.length > 0) {
            await this.generateBriefsPerBucket(processed);
        }

        // Phase 4b: Audio podcast recovery — catch buckets whose audio was
        // deferred because the last newsletter landed before cutoff. Runs
        // on every fetch (independent of `processed.length` — the whole
        // point is to handle buckets that received NO new emails in this
        // fetch but are now closed and missing audio).
        try {
            await this.recoverMissedAudioPodcasts();
        } catch (e) {
            logger.warn('Newsletter', 'Audio recovery sweep failed (non-fatal)', e);
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
     *  Returns created file paths for downstream processing (auto-tag, metadata).
     *
     *  Each newsletter is bucketed by its arrival timestamp + the user's
     *  configured cutoff hour. Example: cutoff=08:00, newsletter received
     *  03:00 today → buckets into yesterday's digest (the user's "day"
     *  hasn't rolled over yet). A fetch batch can therefore span multiple
     *  buckets; we group by bucket date before writing. */
    private async createVaultNotes(newsletters: ProcessedNewsletter[]): Promise<string[]> {
        const vault = this.plugin.app.vault;
        const outputRoot = getNewsletterOutputFullPath(this.plugin.settings);
        const cutoff = this.plugin.settings.newsletterBriefCutoffHour ?? 6;

        // Group newsletters by bucket date (cutoff-aware). A fetch that runs
        // at 09:00 after cutoff=08:00 may pull emails from 06:00 today
        // (yesterday's bucket) and 08:30 today (today's bucket) in the same
        // batch — previously they all collapsed into the fetch-time calendar
        // date and polluted today's digest.
        const byBucket = new Map<string, ProcessedNewsletter[]>();
        for (const nl of newsletters) {
            const bucket = getBucketDateStr(nl.date, cutoff);
            const existing = byBucket.get(bucket);
            if (existing) existing.push(nl);
            else byBucket.set(bucket, [nl]);
        }

        const createdPaths: string[] = [];
        await ensureFolderExists(vault, outputRoot);

        for (const [dateStr, group] of byBucket) {
            const bucketPaths = await this.writeBucket(outputRoot, dateStr, group);
            createdPaths.push(...bucketPaths);
        }

        return createdPaths;
    }

    /** Write one bucket's worth of notes + digest. Extracted from
     *  createVaultNotes to keep cognitive complexity per function under the
     *  SonarQube threshold. */
    private async writeBucket(
        outputRoot: string,
        dateStr: string,
        group: ProcessedNewsletter[],
    ): Promise<string[]> {
        const vault = this.plugin.app.vault;
        const dateLabel = new Date(`${dateStr}T12:00:00`).toLocaleDateString(
            undefined, { year: 'numeric', month: 'long', day: 'numeric' },
        );
        const dailyFolder = normalizePath(`${outputRoot}/${dateStr}`);
        await ensureFolderExists(vault, dailyFolder);

        const paths: string[] = [];
        for (const nl of group) {
            const notePath = this.getDeterministicNotePath(dailyFolder, nl);
            const noteContent = this.buildNoteContent(nl, dateStr);
            if (!vault.getAbstractFileByPath(notePath)) {
                await vault.create(notePath, noteContent);
            }
            paths.push(notePath);
            nl._resolvedPath = notePath;
        }

        const digestPath = getDigestPath(outputRoot, dateStr);
        const existingDigest = vault.getAbstractFileByPath(digestPath);
        if (existingDigest instanceof TFile) {
            await this.mergeIntoExistingDigest(existingDigest, group, dateStr);
        } else {
            const digestContent = this.buildDigestContent(group, dateStr, dateLabel, 0);
            await vault.create(digestPath, digestContent);
        }

        return paths;
    }

    private buildNoteContent(nl: ProcessedNewsletter, dateStr: string): string {
        return [
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

    /** Build full digest markdown from scratch.
     *
     * The digest intentionally does NOT repeat each newsletter's triage as a
     * separate H2 section — the Daily Brief synthesises them across sources
     * with inline attribution. Instead we emit a compact `## Sources` list
     * of links to the individual newsletter notes so users can still drill
     * down. User feedback (2026-04-20): the per-section layout duplicated
     * what the brief already captured and buried the synthesis below the fold.
     */
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
            // Placeholder for the Daily Brief block. mergeOrPrependBrief()
            // finds and fills this after LLM synthesis completes; if the
            // synthesis fails the placeholder stays so users know where the
            // brief will appear once re-run.
            '<!-- DAILY_BRIEF_START -->',
            '## Daily Brief',
            '',
            '*Synthesizing…*',
            '',
            '<!-- DAILY_BRIEF_END -->',
            '',
            '## Sources',
            '',
        ];

        for (const nl of newsletters) {
            lines.push(this.buildSourceLink(nl, dateStr));
        }
        lines.push('');

        return lines.join('\n');
    }

    /** Build a single source-list entry: one-line link with sender. */
    private buildSourceLink(nl: ProcessedNewsletter, dateStr: string): string {
        const resolvedPath = nl._resolvedPath;
        const linkTarget = resolvedPath
            ? resolvedPath.split('/').slice(-2).join('/').replace(/\.md$/, '')
            : `${dateStr}/${sanitizeFileName(nl.senderName || nl.subject)}`;
        const display = nl.senderName || nl.subject;
        const suffix = nl.extractionFailed ? ' ⚠️ *(extraction failed)*' : '';
        return `- [[${linkTarget}|${display}]]${suffix}`;
    }

    /** Merge new source links into an existing digest, updating frontmatter count. */
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

        // Build new source links, skipping any whose note path already appears in the digest
        const newLinks = newsletters
            .filter(nl => {
                if (!nl._resolvedPath) return true;
                const linkSlug = nl._resolvedPath.split('/').slice(-2).join('/').replace(/\.md$/, '');
                return !updated.includes(`[[${linkSlug}`);
            })
            .map(nl => this.buildSourceLink(nl, dateStr));

        if (newLinks.length === 0) {
            await vault.modify(file, updated);
            return;
        }

        // Append into the existing `## Sources` section if present. Otherwise
        // append it to the end (legacy digests written before 2026-04-20 had
        // per-newsletter H2 sections and no Sources block — append conservatively).
        const sourcesHeaderRegex = /^## Sources\s*$/m;
        if (sourcesHeaderRegex.test(updated)) {
            // Find the Sources section + append inside it (after any existing links, before next ##)
            const headerMatch = sourcesHeaderRegex.exec(updated);
            if (headerMatch) {
                const headerEnd = (headerMatch.index ?? 0) + headerMatch[0].length;
                const afterHeader = updated.slice(headerEnd);
                const nextSectionMatch = /\n## /m.exec(afterHeader);
                const sectionEnd = nextSectionMatch
                    ? headerEnd + nextSectionMatch.index
                    : updated.length;
                const before = updated.slice(0, sectionEnd).trimEnd();
                const after = updated.slice(sectionEnd);
                updated = before + '\n' + newLinks.join('\n') + '\n' + (after ? after : '');
            }
        } else {
            updated = updated.trimEnd() + '\n\n## Sources\n\n' + newLinks.join('\n') + '\n';
        }

        await vault.modify(file, updated);
    }

    // ── Daily Brief (Phase 4) ────────────────────────────────────────────

    /**
     * Dispatch brief synthesis across every bucket that received content.
     * Fetches spanning the cutoff boundary therefore refresh BOTH yesterday's
     * and today's brief. Best-effort — a single bucket failure must not
     * cancel the rest.
     */
    private async generateBriefsPerBucket(processed: ProcessedNewsletter[]): Promise<void> {
        const cutoff = this.plugin.settings.newsletterBriefCutoffHour ?? 6;
        const byBucket = new Map<string, ProcessedNewsletter[]>();
        for (const nl of processed) {
            const bucket = getBucketDateStr(nl.date, cutoff);
            const existing = byBucket.get(bucket);
            if (existing) existing.push(nl);
            else byBucket.set(bucket, [nl]);
        }
        for (const [dateStr, group] of byBucket) {
            try {
                await this.generateAndInjectBrief(dateStr, group);
            } catch (e) {
                logger.warn('Newsletter', `Daily brief generation failed for ${dateStr} (non-fatal)`, e);
            }
        }
    }

    /**
     * Generate a synthesised daily brief for the given bucket date and
     * inject it as a managed block at the top of the digest file.
     *
     * Called once per bucket that received new newsletters in this fetch
     * (see `fetchAndProcess`). A single fetch can span cutoff boundaries
     * and therefore touch more than one bucket; each bucket gets its own
     * brief + audio. `dateStr` and `currentBatch` must be aligned — callers
     * pre-group newsletters by bucket via `getBucketDateStr` before calling.
     */
    private async generateAndInjectBrief(dateStr: string, currentBatch: ProcessedNewsletter[]): Promise<void> {
        const vault = this.plugin.app.vault;
        const outputRoot = getNewsletterOutputFullPath(this.plugin.settings);
        const digestPath = getDigestPath(outputRoot, dateStr);

        const digestFile = vault.getAbstractFileByPath(digestPath);
        if (!(digestFile instanceof TFile)) return;

        // Collect full day's sources (current batch + previously written notes)
        const sources = await this.collectDayNewsletters(digestFile, currentBatch);
        if (sources.length < 2) return; // no synthesis value for a single source

        const langCode = this.plugin.settings.newsletterPreferredLanguage;
        const langName = getLanguageNameForPrompt(langCode);
        const settings = this.plugin.settings;
        const provider = settings.serviceType === 'local' ? 'local' : settings.cloudServiceType;
        const cloudType = settings.cloudServiceType;
        const model = settings.serviceType === 'local' ? undefined : settings.providerSettings?.[cloudType]?.model;
        const maxChars = getMaxContentCharsForModel(provider, model);

        const { filled, truncatedCount } = insertBriefContent(
            buildDailyBriefPrompt({ language: langName || undefined }),
            sources,
            maxChars
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

        // Phase 5: Audio podcast — runs only when the bucket is CLOSED.
        //
        // Gate added 2026-04-23 after user reported: "Why has today's audio
        // already generated? It's supposed to cut off by next day at 08:00."
        //
        // Previously, audio regenerated every time new newsletters arrived
        // for a given bucket — so today's digest could trigger 5-10 audio
        // regenerations as emails trickled in, each costing API budget and
        // producing audio that became stale minutes later. The correct
        // semantic is: audio represents the FINAL digest for a completed
        // day, so it should be generated ONCE, after the bucket closes at
        // (next day's cutoffHour).
        //
        // For past/closed buckets (back-fills, manual re-fetches): audio
        // generates immediately as expected.
        //
        // Users who want today's audio right now can still hit the explicit
        // "Regenerate audio for today's brief" command — `regenerateAudioForToday`
        // bypasses this gate by design.
        if (this.plugin.settings.newsletterAudioPodcast) {
            const cutoff = this.plugin.settings.newsletterBriefCutoffHour ?? 6;
            if (isBucketClosed(dateStr, cutoff)) {
                await this.generateAudioForBrief(brief, outputRoot, dateStr);
            } else {
                logger.debug('Newsletter', `Audio podcast deferred for bucket ${dateStr} — bucket is still live (cutoff ${cutoff}:00 next day not yet reached)`);
            }
        }
    }

    private async generateAudioForBrief(brief: string, outputRoot: string, dateStr: string): Promise<void> {
        // This used to wrap everything in a try/catch that silently swallowed
        // errors — the user would see a success notice but no file, and no
        // console output told them why. Now errors propagate to the caller
        // (auto-fetch's own try/catch for background runs, or the
        // regenerateAudioForToday() caller which surfaces via Notice).

        // Resolve Gemini API key:
        //   1. SecretStorage 'gemini' provider key (primary — this is where
        //      Obsidian keys live for most users)
        //   2. providerSettings.gemini.apiKey (legacy plain-text fallback)
        //   3. cloudApiKey (only when main provider IS Gemini)
        //
        // Before this fix, we skipped SecretStorage entirely — so users whose
        // Gemini key was in SecretStorage (the Obsidian-recommended path) but
        // whose main provider was something else got a silent "skipped" log
        // with no audio output. The feature looked broken.
        const settings = this.plugin.settings;
        const secretKey = this.plugin.secretStorageService.isAvailable()
            ? await this.plugin.secretStorageService.getProviderKey('gemini')
            : null;
        const geminiApiKey =
            secretKey ||
            settings.providerSettings?.['gemini']?.apiKey ||
            (settings.cloudServiceType === 'gemini' ? settings.cloudApiKey : '') ||
            '';
        if (!geminiApiKey) {
            logger.warn('Newsletter', 'Audio podcast skipped — no Gemini API key configured (checked SecretStorage + providerSettings + cloudApiKey)');
            new Notice('Audio podcast skipped — add a gemini key in settings to enable', 6000);
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
            throw new Error(result.error || 'Audio generation failed (no error message)');
        }
        if (!result.filePath) {
            throw new Error('Audio generation returned success but no filePath');
        }
        logger.debug('Newsletter', `Audio saved: ${result.filePath}`);

            // Embed the audio link into today's digest note so the user
            // actually sees it. Otherwise the audio lives in a dated subfolder
            // with no surface in the UI.
        const digestPath = getDigestPath(outputRoot, dateStr);
        const digestFile = this.plugin.app.vault.getAbstractFileByPath(digestPath);
        if (digestFile instanceof TFile) {
            await this.injectAudioEmbedIntoDigest(digestFile, result.filePath);
        }
    }

    /**
     * Recovery sweep — generate audio for any recently-CLOSED bucket whose
     * digest has Daily Brief content but no audio embed.
     *
     * Why this exists: `generateAndInjectBrief` only triggers audio when a
     * bucket is closed AND fresh newsletters arrived in this fetch. The
     * common failure case is "last newsletter for the day arrived 7 minutes
     * before next-day cutoff at 08:00 → audio deferred → no later fetch
     * brought new content into that closed bucket → audio never generates."
     * The user reported this on 2026-04-25 (April 24 digest had brief but
     * no podcast). This sweep restores the contract: once a bucket is
     * closed, its audio WILL generate the next time fetchAndProcess runs,
     * regardless of whether new emails arrived for that bucket.
     *
     * Idempotent: if the digest already has an audio embed, skip. Safe to
     * call on every fetch.
     *
     * Bounded: only looks at the last RECOVERY_LOOKBACK_DAYS days to avoid
     * touching ancient buckets the user may have intentionally cleaned up.
     */
    private async recoverMissedAudioPodcasts(): Promise<void> {
        if (!this.plugin.settings.newsletterAudioPodcast) return;
        const cutoff = this.plugin.settings.newsletterBriefCutoffHour ?? 6;
        const outputRoot = getNewsletterOutputFullPath(this.plugin.settings);
        const vault = this.plugin.app.vault;

        // Walk the last RECOVERY_LOOKBACK_DAYS days; today (still-live bucket)
        // is excluded by the isBucketClosed check rather than by the loop bound.
        const RECOVERY_LOOKBACK_DAYS = 3;
        const today = new Date();
        for (let i = 1; i <= RECOVERY_LOOKBACK_DAYS; i++) {
            const d = new Date(today);
            d.setDate(today.getDate() - i);
            const dateStr = formatLocalYmd(d);
            if (!isBucketClosed(dateStr, cutoff)) continue;

            const digestPath = getDigestPath(outputRoot, dateStr);
            const digestFile = vault.getAbstractFileByPath(digestPath);
            if (!(digestFile instanceof TFile)) continue;

            try {
                const content = await vault.cachedRead(digestFile);
                if (hasAudioEmbed(content)) continue;
                const brief = extractBriefFromDigest(content);
                if (!brief || brief.length < 50) continue;
                logger.debug('Newsletter', `Recovery sweep: generating missing audio for ${dateStr}`);
                await this.generateAudioForBrief(brief, outputRoot, dateStr);
            } catch (e) {
                logger.warn('Newsletter', `Recovery sweep: audio generation failed for ${dateStr} (non-fatal)`, e);
            }
        }
    }

    /**
     * Inject or replace the audio embed line at the TOP of the digest file
     * — just after the H1 heading, before the Daily Brief managed block.
     * Users open the digest expecting the podcast front-and-centre; burying
     * it at the end of the brief meant they had to scroll past paragraphs
     * of text to reach it (user request 2026-04-22).
     *
     * Living outside the managed `<!-- DAILY_BRIEF_START/END -->` block is
     * deliberate — that block is wiped and re-written on every brief
     * regenerate, and we don't want the audio embed to blink between the
     * text-brief and audio-synthesis phases. Idempotent: any prior
     * `brief-*.(wav|mp3)` embed line is stripped anywhere in the file
     * before the new one is inserted.
     */
    private async injectAudioEmbedIntoDigest(digestFile: TFile, audioVaultPath: string): Promise<void> {
        const vault = this.plugin.app.vault;
        const content = await vault.cachedRead(digestFile);

        const fileName = audioVaultPath.split('/').pop() || audioVaultPath;
        const embedLine = `🎧 **Listen:** ![[${fileName}]]`;

        // Strip any prior audio-embed line (wherever it was) so we never
        // leave stale embeds behind when migrating from the old bottom
        // position or re-rendering with a new fingerprint.
        const priorEmbed = /\n?\s*🎧\s*\*\*Listen:\*\*\s*!\[\[[^\]]*brief-[^\]]+\.(?:wav|mp3)\]\]\s*\n?/g;
        let updated = content.replaceAll(priorEmbed, '\n');

        // Insert the new embed just after the H1 title if present, else
        // after the frontmatter, else prepend. Regex captures the H1 line
        // and puts the embed on its own line immediately below.
        const h1Match = /^(# .+\n)/m.exec(updated);
        if (h1Match) {
            const insertAt = h1Match.index + h1Match[0].length;
            updated = updated.slice(0, insertAt) + '\n' + embedLine + '\n' + updated.slice(insertAt);
        } else {
            const fmEnd = /^---\n[\s\S]*?\n---\n/.exec(updated);
            if (fmEnd) {
                const insertAt = fmEnd.index + fmEnd[0].length;
                updated = updated.slice(0, insertAt) + '\n' + embedLine + '\n' + updated.slice(insertAt);
            } else {
                updated = embedLine + '\n\n' + updated;
            }
        }

        await vault.modify(digestFile, updated);
        logger.debug('Newsletter', `Embedded audio at top of digest: ${fileName}`);
    }

    /**
     * Public entry point for manually regenerating the audio podcast against
     * today's already-synthesised Daily Brief. Lets users trigger audio
     * without waiting for the next fetch with new newsletters (common when
     * they enable the audio toggle AFTER the day's brief already ran, or
     * when they want to re-render with a different voice).
     *
     * Extracts the managed `<!-- DAILY_BRIEF_START --> ... <!-- DAILY_BRIEF_END -->`
     * block from today's digest file and pipes it through the same audio
     * pipeline used in `generateAndInjectBrief`.
     */
    public async regenerateAudioForToday(): Promise<{ success: boolean; error?: string; path?: string }> {
        if (!this.plugin.settings.newsletterAudioPodcast) {
            return { success: false, error: 'Audio podcast is off — toggle it on in settings first.' };
        }
        const vault = this.plugin.app.vault;
        const outputRoot = getNewsletterOutputFullPath(this.plugin.settings);
        const dateStr = getBriefDateStr(this.plugin.settings.newsletterBriefCutoffHour ?? 6);
        const digestPath = getDigestPath(outputRoot, dateStr);
        const digestFile = vault.getAbstractFileByPath(digestPath);
        if (!(digestFile instanceof TFile)) {
            return { success: false, error: `No digest file at ${digestPath} — run a newsletter fetch first.` };
        }
        const content = await vault.cachedRead(digestFile);
        // Strip any prior audio embed from the brief content before
        // synthesis — otherwise the LLM script would include "Listen: ..."
        // literal text. (Brief content and embed are both inside the managed
        // block; when this function extracts, it may pick up an old embed.)
        const priorEmbed = /\s*🎧\s*\*\*Listen:\*\*\s*!\[\[[^\]]*brief-[^\]]+\.(?:wav|mp3)\]\]\s*/g;
        const match = /<!--\s*DAILY_BRIEF_START\s*-->\s*##\s*Daily Brief\s*([\s\S]*?)<!--\s*DAILY_BRIEF_END\s*-->/.exec(content);
        if (!match) {
            return { success: false, error: "No Daily Brief block found in today's digest — the brief step didn't run or failed." };
        }
        const brief = match[1].replaceAll(priorEmbed, '').trim();
        if (brief.length < 50) {
            return { success: false, error: "Today's Daily Brief is empty / too short for audio synthesis." };
        }
        try {
            await this.generateAudioForBrief(brief, outputRoot, dateStr);
            return { success: true, path: `${outputRoot}/${dateStr}/` };
        } catch (e) {
            return { success: false, error: e instanceof Error ? e.message : String(e) };
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
    return getBucketDateStr(new Date(), cutoffHour);
}

/**
 * True when the bucket represented by `bucketDateStr` has FULLY CLOSED —
 * meaning the cutoff hour of the following calendar day has passed.
 *
 * Example: cutoffHour=8, bucketDateStr='2026-04-23'.
 *   - bucket "2026-04-23" covers newsletters with timestamps in the range
 *     2026-04-23 08:00 → 2026-04-24 07:59 (local time)
 *   - bucket CLOSES at 2026-04-24 08:00
 *   - audio podcast should NOT be generated for this bucket until then,
 *     because new newsletters can still land in it and invalidate the audio
 *
 * Used to gate daily-brief audio podcast generation so we don't waste API
 * budget regenerating audio as each individual newsletter arrives during
 * the live day (user report 2026-04-23).
 */
export function isBucketClosed(bucketDateStr: string, cutoffHour: number, now: Date = new Date()): boolean {
    // Parse "YYYY-MM-DD" as local midnight, then advance to the cutoff boundary.
    const parts = bucketDateStr.split('-').map(Number);
    if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return false;
    const [y, m, d] = parts;
    const bucketClose = new Date(y, m - 1, d + 1, cutoffHour, 0, 0, 0);
    return now.getTime() >= bucketClose.getTime();
}

/**
 * Bucket a specific timestamp into a YYYY-MM-DD digest day using the user's
 * configured cutoff hour. A message received at 03:00 with cutoff=08:00
 * belongs to the previous day's bucket because the user's day hasn't rolled
 * over yet.
 *
 * Uses LOCAL time — cutoff hours are wall-clock in the user's timezone, not
 * UTC. `Date#getHours/Date/setDate` are local-time methods; only the final
 * ISO serialisation is UTC-based. We rebuild the YYYY-MM-DD string from
 * local parts so the bucket boundary matches the user's clock, not UTC.
 *
 * Shared by fetch-time bucketing, folder creation, digest path, and brief
 * synthesis so every code path agrees on which day a given message lives in.
 */
export function getBucketDateStr(when: Date | string, cutoffHour: number): string {
    const d = new Date(when);
    if (!Number.isFinite(d.getTime())) {
        // Fall back to "today" in local time if parsing failed — defensive
        // guard against a malformed payload; bucketing stays monotonic.
        return getBucketDateStr(new Date(), cutoffHour);
    }
    if (d.getHours() < cutoffHour) {
        d.setDate(d.getDate() - 1);
    }
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
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

/** Format a Date as YYYY-MM-DD using LOCAL time parts. Mirrors the
 *  bucket-key convention used elsewhere — never uses UTC, so a 23:00
 *  local-time fetch the day before cutoff still maps to the correct
 *  bucket. Exported so the recovery-sweep tests can build deterministic
 *  date strings without timezone confusion. */
export function formatLocalYmd(d: Date): string {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

/** True when the digest already has an audio embed line. The recovery
 *  sweep uses this to avoid regenerating audio for already-podcasted
 *  digests on every fetch. Match shape mirrors the strip regex in
 *  `injectAudioEmbedIntoDigest` so they stay in lockstep. */
export function hasAudioEmbed(digestContent: string): boolean {
    return /🎧\s*\*\*Listen:\*\*\s*!\[\[[^\]]*brief-[^\]]+\.(?:wav|mp3)\]\]/.test(digestContent);
}

/** Extract just the brief paragraphs from a digest's managed
 *  `<!-- DAILY_BRIEF_START --> ## Daily Brief … <!-- DAILY_BRIEF_END -->`
 *  block, with any prior audio-embed line stripped. Returns '' when the
 *  block is absent or empty. Mirrors the parsing in
 *  `regenerateAudioForToday` so the recovery sweep and the manual command
 *  feed identical text into the synthesis pipeline. */
export function extractBriefFromDigest(digestContent: string): string {
    const match = /<!--\s*DAILY_BRIEF_START\s*-->\s*##\s*Daily Brief\s*([\s\S]*?)<!--\s*DAILY_BRIEF_END\s*-->/.exec(digestContent);
    if (!match) return '';
    const priorEmbed = /\s*🎧\s*\*\*Listen:\*\*\s*!\[\[[^\]]*brief-[^\]]+\.(?:wav|mp3)\]\]\s*/g;
    return match[1].replaceAll(priorEmbed, '').trim();
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
