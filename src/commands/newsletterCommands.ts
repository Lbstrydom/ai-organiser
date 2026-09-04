/**
 * Newsletter Commands
 *
 * Registers the newsletter-fetch command for fetching and triaging newsletters.
 */

import { Notice } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { isFeatureEnabled } from '../services/featureService';
import { logger } from '../utils/logger';
import { noticeWithSettingsLink } from '../utils/noticeUtils';
import type { NewsletterFetchResult } from '../services/newsletter/newsletterTypes';
import { NewsletterService, getBriefDateStr, extractDigestDate } from '../services/newsletter/newsletterService';
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
    // Respect the master feature toggle, same as newsletter-fetch. Without this
    // the command stays runnable from the native palette after the feature is
    // switched off, since the audio-podcast setting is a sub-toggle, not the gate.
    if (!isFeatureEnabled(plugin.settings, 'newsletter')) {
        noticeWithSettingsLink(plugin, nl?.notEnabled || 'Newsletter digest is not enabled. Enable it in settings → integrations.');
        return;
    }
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

/**
 * Which day the reader is asserting they are caught up through.
 *
 * One policy shared by the command and the settings button, so the two surfaces
 * cannot disagree about what "caught up" means: the digest you are looking at
 * if you are looking at one, otherwise today's cutoff-aware bucket.
 */
export function resolveCatchUpTargetDate(plugin: AIOrganiserPlugin): string {
    const today = getBriefDateStr(
        plugin.settings.newsletterBriefCutoffHour ?? 6,
        plugin.settings.newsletterBriefCutoffMinute ?? 0,
    );
    const active = plugin.app.workspace.getActiveFile();
    const digestDate = active ? extractDigestDate(active.name) : null;
    if (!digestDate) return today;
    // A future-dated digest is clamped: you cannot be caught up on tomorrow.
    return digestDate > today ? today : digestDate;
}

/** Single-flight guard: rapid clicks must not spawn overlapping catch-up runs
 *  that each read the ledger and race each other's writes. */
let markingCaughtUp = false;

/**
 * Run the catch-up and show one notice. Shared by the command and the settings
 * button so their messaging cannot drift.
 *
 * A control that silently does nothing is worse than one that says why, so the
 * disabled and no-op cases get their own distinct notices rather than a
 * generic success.
 */
export async function runMarkCaughtUp(plugin: AIOrganiserPlugin): Promise<void> {
    const t = plugin.t;
    const nl = t.settings?.newsletter;

    // The master feature toggle and the story-memory sub-toggle are different
    // states, so they get different notices — "turn on story memory" would be
    // misleading advice when the whole feature is off.
    if (!isFeatureEnabled(plugin.settings, 'newsletter')) {
        noticeWithSettingsLink(plugin, nl?.notEnabled || 'Newsletter digest is not enabled. Enable it in settings → integrations.');
        return;
    }
    if (markingCaughtUp) return;
    markingCaughtUp = true;
    try {
        await markCaughtUpInner(plugin, nl);
    } finally {
        markingCaughtUp = false;
    }
}

async function markCaughtUpInner(
    plugin: AIOrganiserPlugin,
    nl: AIOrganiserPlugin['t']['settings']['newsletter'] | undefined,
): Promise<void> {
    const through = resolveCatchUpTargetDate(plugin);
    const service = new NewsletterService(plugin);

    const result = await service.markCaughtUp(through);
    if (!result.ok) {
        if (result.error === 'disabled') {
            new Notice(nl?.caughtUpDisabled || 'Turn on story memory first', 5000);
            return;
        }
        logger.error('Newsletter', `Mark caught up failed: ${result.error}`);
        new Notice(
            (nl?.caughtUpError || 'Could not mark caught up: {error}').replace('{error}', result.error),
            6000,
        );
        return;
    }

    if (result.value.buckets === 0) {
        new Notice(nl?.caughtUpNoop || 'Already up to date — nothing to mark', 4000);
        return;
    }

    new Notice(
        (nl?.caughtUpOk || 'Caught up through {through} — {buckets} day(s), {stories} stories')
            .replace('{through}', through)
            .replace('{buckets}', String(result.value.buckets))
            .replace('{stories}', String(result.value.stories)),
        5000,
    );
}

export function registerNewsletterCommands(plugin: AIOrganiserPlugin): void {
    const t = plugin.t;

    plugin.addCommand({
        id: 'newsletter-fetch',
        name: t.commands.newsletterFetch,
        icon: 'mail',
        callback: async () => {
            if (!isFeatureEnabled(plugin.settings, 'newsletter')) {
                noticeWithSettingsLink(plugin, t.settings.newsletter?.notEnabled || 'Newsletter digest is not enabled. Enable it in settings → integrations.');
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
        id: 'newsletter-mark-caught-up',
        name: t.commands.newsletterMarkCaughtUp || 'Mark newsletters caught up',
        icon: 'check-check',
        callback: () => { void runMarkCaughtUp(plugin); },
    });

    plugin.addCommand({
        id: 'newsletter-regenerate-audio',
        name: t.commands.newsletterRegenerateAudio || 'Regenerate audio for today\'s brief',
        icon: 'audio-lines',
        callback: () => { void runRegenerateAudio(plugin); },
    });
}
