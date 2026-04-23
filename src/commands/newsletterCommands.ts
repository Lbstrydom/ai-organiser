/**
 * Newsletter Commands
 *
 * Registers the newsletter-fetch command for fetching and triaging newsletters.
 */

import { Notice } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { logger } from '../utils/logger';
import type { NewsletterFetchResult } from '../services/newsletter/newsletterTypes';
import { NewsletterService } from '../services/newsletter/newsletterService';
import { withProgress } from '../services/progress';

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

/** Run the audio-regeneration pipeline and show a user-visible notice. Shared
 *  by the command and the settings button. Uses ProgressReporter so the user
 *  sees a persistent "Regenerating podcast audio…" toast instead of a 3s
 *  flash that disappears before the actual work starts. */
export async function runRegenerateAudio(plugin: AIOrganiserPlugin): Promise<void> {
    const nl = plugin.t.settings.newsletter;
    if (!plugin.settings.newsletterAudioPodcast) {
        new Notice(nl?.audioPodcastOffNotice || 'Audio podcast is off — enable it in settings first.', 5000);
        return;
    }
    type AudioPhase = 'regeneratingAudio';
    const tp = plugin.t.progress;
    const r = await withProgress<{ path?: string }, AudioPhase>(
        {
            plugin,
            initialPhase: { key: 'regeneratingAudio' },
            resolvePhase: (p) => tp.newsletter[p.key],
        },
        async () => {
            const service = new NewsletterService(plugin);
            const result = await service.regenerateAudioForToday();
            if (!result.success) {
                throw new Error(result.error || 'unknown');
            }
            return { path: result.path };
        },
    );
    if (!r.ok) return; // reporter fired the toast
    new Notice(
        (nl?.audioRegenerated || 'Audio regenerated. See {path}').replace('{path}', r.value.path || ''),
        6000,
    );
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

            type FetchPhase = 'fetching' | 'triaging';
            const tp = t.progress;
            const r = await withProgress<NewsletterFetchResult, FetchPhase>(
                {
                    plugin,
                    initialPhase: { key: 'fetching' },
                    resolvePhase: (p) => {
                        const tmpl = tp.newsletter[p.key];
                        if (p.params) {
                            return Object.entries(p.params).reduce(
                                (acc, [k, v]) => acc.replace(`{${k}}`, String(v)),
                                tmpl,
                            );
                        }
                        return tmpl;
                    },
                    total: undefined, // total only known after fetch returns
                },
                async (reporter) => {
                    const service = new NewsletterService(plugin);
                    await service.loadSeenIds();
                    const result = await service.fetchAndProcess((current, total) => {
                        logger.debug('Newsletter', `Processing ${current}/${total}`);
                        reporter.setPhase({
                            key: 'triaging',
                            params: { current, total },
                        });
                    });
                    return result;
                },
            );
            if (r.ok) {
                showNewsletterFetchResultNotice(r.value, plugin);
                await plugin.updateNewsletterLastFetchTime();
            }
            // On !r.ok the reporter already fired the toast.
        }
    });

    plugin.addCommand({
        id: 'newsletter-regenerate-audio',
        name: t.commands.newsletterRegenerateAudio || 'Regenerate audio for today\'s brief',
        icon: 'audio-lines',
        callback: () => { void runRegenerateAudio(plugin); },
    });
}
