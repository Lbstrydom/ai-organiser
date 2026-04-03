/**
 * Web Reader Service
 * Fetches web articles, generates triage summaries, and creates output notes.
 */

import { App, TFile } from 'obsidian';
import { fetchArticle, WebContent } from './webContentService';
import { summarizeText, pluginContext, LLMFacadeContext } from './llmFacade';
import { buildTriagePrompt, insertContentIntoTriagePrompt } from './prompts/triagePrompts';
import { truncateContent } from './tokenLimits';
import { AIOrganiserSettings, getWebReaderOutputFullPath } from '../core/settings';
import { ensureFolderExists, sanitizeFileName, getAvailableFilePath } from '../utils/minutesUtils';
import type AIOrganiserPlugin from '../main';

export interface TriagedArticle {
    url: string;
    title: string;
    siteName: string | null;
    byline: string | null;
    briefSummary: string;
    fetchError?: string;
    llmFailed?: boolean;
}

export interface TriageProgress {
    current: number;
    total: number;
    url: string;
    phase: 'fetching' | 'summarizing' | 'done' | 'error';
}

/**
 * Fetch and triage a list of URLs sequentially.
 * Reports progress via callback; supports cancellation via AbortSignal.
 */
export async function fetchAndTriageArticles(
    urls: string[],
    plugin: AIOrganiserPlugin,
    onProgress: (p: TriageProgress) => void,
    signal?: AbortSignal
): Promise<TriagedArticle[]> {
    const results: TriagedArticle[] = [];
    const total = urls.length;
    const t = plugin.t;
    const context: LLMFacadeContext = pluginContext(plugin);
    const provider = plugin.settings.serviceType === 'cloud'
        ? plugin.settings.cloudServiceType
        : 'local';

    for (let i = 0; i < urls.length; i++) {
        if (signal?.aborted) break;

        const url = urls[i];

        // Phase: fetching
        onProgress({ current: i + 1, total, url, phase: 'fetching' });

        const fetchResult = await fetchArticle(url);

        if (!fetchResult.success || !fetchResult.content) {
            results.push({
                url,
                title: url,
                siteName: null,
                byline: null,
                briefSummary: fetchResult.error || t.modals.webReader.fetchFailed,
                fetchError: fetchResult.error || t.modals.webReader.fetchFailed,
            });
            onProgress({ current: i + 1, total, url, phase: 'error' });
            continue;
        }

        const content: WebContent = fetchResult.content;

        // Check abort after fetch (before costly LLM call)
        if (signal?.aborted) {
            results.push({
                url,
                title: content.title,
                siteName: content.siteName,
                byline: content.byline,
                briefSummary: content.excerpt || t.modals.webReader.noSummaryAvailable,
                llmFailed: true,
            });
            break;
        }

        // Phase: summarizing
        onProgress({ current: i + 1, total, url, phase: 'summarizing' });

        const truncated = truncateContent(content.textContent, provider);
        const prompt = buildTriagePrompt({ language: plugin.settings.summaryLanguage });
        const finalPrompt = insertContentIntoTriagePrompt(prompt, truncated);
        const llmResult = await summarizeText(context, finalPrompt);

        let briefSummary: string;
        let llmFailed = false;

        if (llmResult.success && llmResult.content) {
            briefSummary = llmResult.content;
        } else if (content.excerpt) {
            briefSummary = content.excerpt;
            llmFailed = true;
        } else {
            briefSummary = t.modals.webReader.noSummaryAvailable;
            llmFailed = true;
        }

        results.push({
            url,
            title: content.title,
            siteName: content.siteName,
            byline: content.byline,
            briefSummary,
            llmFailed: llmFailed || undefined,
        });

        onProgress({ current: i + 1, total, url, phase: 'done' });
    }

    return results;
}

/**
 * Create a note containing URL links for selected articles.
 * Returns the created TFile. Does NOT open the file (caller's responsibility).
 */
export async function createNoteFromArticles(
    app: App,
    settings: AIOrganiserSettings,
    articles: TriagedArticle[],
    noteTitle?: string
): Promise<TFile> {
    const outputFolder = getWebReaderOutputFullPath(settings);
    await ensureFolderExists(app.vault, outputFolder);

    const title = noteTitle
        || articles[0]?.title
        || `Web Reader - ${new Date().toISOString().slice(0, 10)}`;
    const sanitized = sanitizeFileName(title);
    const filePath = await getAvailableFilePath(app.vault, outputFolder, sanitized + '.md');

    const links = articles
        .map(a => `- [${a.title}](${a.url})`)
        .join('\n');

    const content = `---\ntags: []\n---\n\n# ${title}\n\n${links}\n`;

    const file = await app.vault.create(filePath, content);
    return file;
}
