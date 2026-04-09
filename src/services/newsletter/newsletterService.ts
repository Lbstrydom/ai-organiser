/**
 * Newsletter Service
 *
 * Tier 1: Fetches newsletters from a Google Apps Script endpoint,
 * converts HTML to markdown, runs LLM triage, deduplicates,
 * and generates digest + individual notes in the vault.
 */

import { normalizePath, requestUrl, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { logger } from '../../utils/logger';
import type { RawNewsletter, ProcessedNewsletter, NewsletterFetchResult } from './newsletterTypes';
import { htmlToMarkdown, cleanMarkdown, cleanNewsletterMarkdown, extractNewsletterText, extractLinks } from '../../utils/htmlToMarkdown';
import { truncateAtBoundary } from '../tokenLimits';
import { buildTriagePrompt, insertContentIntoTriagePrompt } from '../prompts/triagePrompts';
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
            const confirmUrl = `${url}?action=confirm&ids=${ids}`;
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
        let triage: string | null = null;
        let llmFailed = false;
        try {
            const truncated = truncateAtBoundary(plainText || markdown, TRIAGE_MAX_CHARS);
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
        // Fallback: use cleaned plain text (not raw markdown) — avoids layout noise
        if (!triage) {
            triage = truncateAtBoundary(plainText || markdown, 500, '...');
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
        return [
            `## ${nl.senderName || nl.subject}`,
            `*From: ${nl.from}*`,
            '',
            nl.triage || '(No summary available)',
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
