/**
 * Newsletter Commands
 *
 * Registers the newsletter-fetch command for fetching and triaging newsletters.
 */

import { Notice } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { logger } from '../utils/logger';
import type { NewsletterFetchResult } from '../services/newsletter/newsletterTypes';
import { NewsletterService, getDigestPath } from '../services/newsletter/newsletterService';
import { getNewsletterOutputFullPath } from '../core/settings';

/** Show the appropriate notice after a fetch completes. Shared by command and settings button. */
export function showNewsletterFetchResultNotice(
    result: NewsletterFetchResult,
    plugin: AIOrganiserPlugin
): void {
    const nl = plugin.t.settings.newsletter;
    if (result.errors.length > 0) {
        new Notice((nl?.fetchError || 'Failed to fetch: {error}').replace('{error}', result.errors[0]), 5000);
    } else if (result.totalNew === 0) {
        new Notice(nl?.fetchEmpty || 'No new newsletters found');
    } else {
        new Notice((nl?.fetchSuccess || 'Fetched {n} newsletters').replace('{n}', String(result.totalNew)), 5000);
    }
    if (result.hitLimit) {
        new Notice(
            (nl?.hitLimitWarning || 'Fetch limit of {n} reached — there may be more. Increase the limit in Settings.')
                .replace('{n}', String(plugin.settings.newsletterFetchLimit || 20)),
            7000
        );
    }
}

export function registerNewsletterCommands(plugin: AIOrganiserPlugin): void {
    const t = plugin.t;

    plugin.addCommand({
        id: 'newsletter-fetch',
        name: t.commands.newsletterFetch,
        icon: 'mail',
        callback: async () => {
            if (!plugin.settings.newsletterEnabled) {
                new Notice(t.settings.newsletter?.notEnabled || 'Newsletter digest is not enabled. Enable it in Settings → Integrations.');
                return;
            }

            if (!plugin.settings.newsletterScriptUrl?.trim()) {
                new Notice(t.settings.newsletter?.noScriptUrl || 'No Apps Script URL configured. Set it in Settings → Integrations → Newsletter Digest.');
                return;
            }

            new Notice(t.settings.newsletter?.fetching || 'Fetching newsletters...', 3000);

            try {
                const service = new NewsletterService(plugin);
                await service.loadSeenIds();
                const result = await service.fetchAndProcess((current, total) => {
                    logger.debug('Newsletter', `Processing ${current}/${total}`);
                });
                showNewsletterFetchResultNotice(result, plugin);
                await plugin.updateNewsletterLastFetchTime();
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                new Notice((t.settings.newsletter?.fetchError || 'Failed to fetch: {error}').replace('{error}', msg), 5000);
            }
        }
    });

    plugin.addCommand({
        id: 'newsletter-open-digest',
        name: t.commands.newsletterOpenDigest,
        icon: 'book-open',
        callback: async () => {
            const dateStr = new Date().toISOString().slice(0, 10);
            const outputRoot = getNewsletterOutputFullPath(plugin.settings);
            const digestPath = getDigestPath(outputRoot, dateStr);
            const file = plugin.app.vault.getAbstractFileByPath(digestPath);
            if (file) {
                await plugin.app.workspace.openLinkText(digestPath, '', false);
            } else {
                new Notice(t.settings.newsletter?.noDigestToday || 'No newsletter digest found for today');
            }
        }
    });
}
