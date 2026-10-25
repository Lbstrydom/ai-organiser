/**
 * Newsletter Commands
 *
 * Registers the newsletter-fetch command for fetching and triaging newsletters.
 */

import { Notice } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import type { CaughtUpOutcome } from '../services/newsletter/newsletterMemoryTypes';
import { isFeatureEnabled } from '../services/featureService';
import { logger } from '../utils/logger';
import { plural } from '../utils/plural';
import { noticeWithSettingsLink } from '../utils/noticeUtils';
import type { NewsletterFetchResult } from '../services/newsletter/newsletterTypes';
import { NewsletterService, getBriefDateStr, extractDigestDate, digestBucketForPath } from '../services/newsletter/newsletterService';
import { isReadSignalEnabled } from '../services/newsletter/newsletterMemoryPolicy';
import { buildObservation, currentReadGeneration } from '../services/newsletter/newsletterReadSignal';
import type { ReadRefusal } from '../services/newsletter/newsletterMemoryTypes';
import { getNewsletterOutputFullPath } from '../core/settings';
import { withProgress } from '../services/progress';
import { getAudioMode, isCatchUpEnabled } from '../services/newsletter/newsletterAudioMode';
import { readEpisode } from '../services/newsletter/catchUp/catchUpEpisode';
import { ackAllInWindowEpisodes, markEpisodeListened } from '../services/newsletter/catchUp/catchUpListen';
import { describeError, formatGuidance } from '../core/friendlyErrors';
import { TFile } from 'obsidian';

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
    // "Regenerate today's audio" is the daily pipeline. When audio is made on demand it would
    // quietly produce a daily recording the catch-up never accounts for, so explain instead.
    if (plugin.settings.newsletterAudioPodcast && getAudioMode(plugin.settings) !== 'daily') {
        new Notice(formatGuidance(describeError(plugin.t, 'catchup-daily-only')), 6000);
        return;
    }
    if (!plugin.settings.newsletterAudioPodcast) {
        new Notice(nl?.audioPodcastOffNotice || 'Audio podcast is off — enable it in settings first.', 5000);
        return;
    }
    type AudioPhase = 'regeneratingAudio';
    const tp = plugin.t.progress;
    const r = await withProgress<{ path: string }, AudioPhase>(
        {
            plugin,
            initialPhase: { key: 'regeneratingAudio' },
            resolvePhase: (p) => tp.newsletter[p.key],
        },
        async () => {
            const service = new NewsletterService(plugin);
            const result = await service.regenerateAudioForToday();
            if (!result.ok) {
                throw new Error(result.error || 'unknown');
            }
            return result.value;
        },
    );
    if (!r.ok) return; // reporter fired the toast
    new Notice(
        (nl?.audioRegenerated || 'Audio regenerated. See {path}').replace('{path}', r.value.path),
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
 * Map a catch-up outcome to its notice. ONE function, used by the command and
 * the settings button, so the two surfaces cannot drift apart in what they tell
 * the user — and so a new outcome state cannot be added without the compiler
 * pointing here.
 */
export function formatCaughtUpOutcome(
    outcome: CaughtUpOutcome,
    nl: AIOrganiserPlugin['t']['settings']['newsletter'] | undefined,
): string {
    switch (outcome.kind) {
        case 'ok':
            // Plain words, not counters: the person asked to be "caught up", not for a bucket count.
            return plural(
                (outcome.stories === 0
                    ? nl?.caughtUpOkNone || 'Every story through {through} was already known.'
                    : nl?.caughtUpOk || 'Marked {stories} stor[y|ies] through {through} as already known.'),
                outcome.stories,
                'stories',
            ).replace('{through}', outcome.through);
        case 'noop':
            return nl?.caughtUpNoop || 'Already up to date — nothing to mark';
        case 'disabled':
            return nl?.caughtUpDisabled || 'Turn on story memory first';
        case 'error':
            return (nl?.caughtUpError || 'Could not mark caught up: {error}')
                .replace('{error}', outcome.error);
    }
}

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
        // It cannot be undone and silences stories in every later brief, so it is never one click.
        if (!await plugin.showConfirmationDialog(nl?.markCaughtUpConfirm || 'Mark every earlier story as already known?')) return;
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
    const outcome = await new NewsletterService(plugin).markCaughtUp(through);

    // "I am up to date" also means the catch-up episodes in the window count as heard. This is
    // independent of story memory: the durable ack is the authority on what was heard.
    let ackFailed = false;
    if (isCatchUpEnabled(plugin.settings)) {
        try {
            await ackAllInWindowEpisodes({ app: plugin.app, plugin, settings: plugin.settings }, through);
            plugin.refreshCatchUpStatus?.();
        } catch (e) {
            ackFailed = true;
            logger.warn('Newsletter', 'Could not acknowledge catch-up episodes', e);
        }
    }

    if (outcome.kind === 'error') {
        logger.error('Newsletter', `Mark caught up failed: ${outcome.error}`);
    }
    new Notice(formatCaughtUpOutcome(outcome, nl), outcome.kind === 'error' ? 6000 : 5000);
    // Partial success is reported as partial: the stories were marked, the episodes were not.
    if (ackFailed) new Notice(plugin.t.modals.newsletterCatchUp.ackFailed, 7000);
}

/** A command boundary: a failure is logged with context and shown as guidance, never dropped. */
async function guarded(plugin: AIOrganiserPlugin, what: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
    } catch (e) {
        logger.error('Newsletter', `Newsletter audio command failed (${what})`, e);
        new Notice(formatGuidance(describeError(plugin.t, 'unknown')), 6000);
    }
}

/** Open the catch-up window. The window itself explains audio-off and daily-mode states. */
export async function openCatchUpWindow(plugin: AIOrganiserPlugin): Promise<void> {
    if (!isFeatureEnabled(plugin.settings, 'newsletter')) {
        noticeWithSettingsLink(plugin, plugin.t.settings.newsletter?.notEnabled || 'Newsletter digest is not enabled. Enable it in settings → integrations.');
        return;
    }
    const { NewsletterCatchUpModal } = await import('../ui/modals/NewsletterCatchUpModal');
    new NewsletterCatchUpModal(plugin).open();
}

/** Mark the catch-up episode in the active note as heard. */
export async function runMarkCatchUpListened(plugin: AIOrganiserPlugin): Promise<void> {
    if (!isFeatureEnabled(plugin.settings, 'newsletter')) return;
    const m = plugin.t.modals.newsletterCatchUp;
    const file = plugin.app.workspace.getActiveFile();
    const episode = file instanceof TFile ? await readEpisode(plugin.app, file) : null;
    if (!episode) {
        new Notice(m.notAnEpisode, 5000);
        return;
    }
    const res = await markEpisodeListened({ app: plugin.app, plugin, settings: plugin.settings }, episode);
    if (!res.ok) {
        logger.warn('Newsletter', `Mark listened failed: ${res.error}`);
        new Notice(formatGuidance(describeError(plugin.t, 'unknown')), 5000);
        return;
    }
    plugin.refreshCatchUpStatus?.();
    new Notice(m.markedListened, 4000);
}

const READ_REFUSAL_GUIDANCE: Record<ReadRefusal, Parameters<typeof describeError>[1]> = {
    'not-a-digest-note': 'read-not-digest',
    'memory-off': 'read-signal-off',
    'mode-off': 'read-signal-off',
    'unparsable-brief': 'read-unparsable',
    'no-matching-stories': 'read-no-match',
    'invalidated': 'read-save-failed',
};

/**
 * Explicit read signal: the reader asserts they read the brief in the active digest note. What is
 * credited is what the note DISPLAYS (parsed from its own text) matched to the ledger by content —
 * never "whatever the ledger says now".
 */
export async function runMarkBriefRead(plugin: AIOrganiserPlugin): Promise<void> {
    if (!isFeatureEnabled(plugin.settings, 'newsletter')) return;
    const fail = (code: Parameters<typeof describeError>[1]) => new Notice(formatGuidance(describeError(plugin.t, code)), 6000);
    if (!isReadSignalEnabled(plugin.settings)) { fail('read-signal-off'); return; }

    // Captured BEFORE any await: a purge or mode change while the note is being read invalidates this mark.
    const generation = currentReadGeneration();
    const file = plugin.app.workspace.getActiveFile();
    const date = file instanceof TFile ? digestBucketForPath(getNewsletterOutputFullPath(plugin.settings), file.path) : null;
    if (!(file instanceof TFile) || !date) { fail('read-not-digest'); return; }

    let text: string;
    try {
        text = await plugin.app.vault.cachedRead(file);
    } catch (e) {
        logger.warn('Newsletter', `Mark brief read could not read the note: ${e instanceof Error ? e.message : String(e)}`);
        fail('read-unparsable');
        return;
    }
    const built = buildObservation(date, text);
    if (!built) { fail('read-unparsable'); return; }

    const res = await new NewsletterService(plugin).markBriefRead(built.observation, 'explicit', generation);
    if (!res.ok) {
        logger.warn('Newsletter', `Mark brief read failed: ${res.error}`);
        fail('read-save-failed');
        return;
    }
    const nl = plugin.t.settings.newsletter;
    const out = res.value;
    if (out.kind === 'refused') { fail(READ_REFUSAL_GUIDANCE[out.code]); return; }
    if (out.kind === 'credited' && out.newly > 0) {
        new Notice(nl.briefMarkedRead.replace('{n}', String(out.newly)), 4000);
    } else {
        new Notice(nl.briefAlreadyRead, 4000);
    }
}

/**
 * Smart daily: after a fetch, make one catch-up episode if — and only if — admission allows
 * (nothing unheard, nothing unresolved, a closed day is pending). Never throws into the fetch.
 */
export async function runSmartDailyAfterFetch(plugin: AIOrganiserPlugin): Promise<void> {
    // Cheap guard first: this runs after EVERY fetch, and must cost nothing in the other modes.
    if (!isFeatureEnabled(plugin.settings, 'newsletter')) return;
    if (plugin.settings.newsletterAudioPodcast !== true || getAudioMode(plugin.settings) !== 'smart-daily') return;
    try {
        const [{ runAutoCatchUp }, { createCatchUpPorts }] = await Promise.all([
            import('../services/newsletter/catchUp/catchUpService'),
            import('../services/newsletter/catchUp/catchUpRuntime'),
        ]);
        const res = await runAutoCatchUp(createCatchUpPorts(plugin));
        const m = plugin.t.modals.newsletterCatchUp;
        if (res.ok && res.value) {
            const v = res.value;
            new Notice(m.autoReady.replace('{range}', v.from === v.to ? v.to : `${v.from} → ${v.to}`), 6000);
            plugin.scheduleCatchUpCleanup?.();
        } else if (!res.ok) {
            logger.warn('Newsletter', `Smart daily catch-up did not complete: ${res.error}`);
            new Notice(formatGuidance(describeError(plugin.t, res.error)), 6000);
        }
        plugin.refreshCatchUpStatus?.();
    } catch (e) {
        logger.warn('Newsletter', 'Smart daily catch-up failed (non-fatal)', e);
    }
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
                await runSmartDailyAfterFetch(plugin);
            }
            // On !r.ok the reporter already fired the toast.
        }
    });

    plugin.addCommand({
        id: 'newsletter-mark-caught-up',
        name: t.commands.newsletterMarkCaughtUp || 'Mark all newsletter stories as already known',
        icon: 'check-check',
        callback: () => { void runMarkCaughtUp(plugin); },
    });

    plugin.addCommand({
        id: 'newsletter-mark-brief-read',
        name: t.commands.newsletterMarkBriefRead || 'Mark newsletter brief as read',
        icon: 'book-open-check',
        callback: () => { void runMarkBriefRead(plugin).catch((e) => logger.warn('Newsletter', 'Mark brief read failed', e)); },
    });

    plugin.addCommand({
        id: 'newsletter-audio',
        name: t.commands.newsletterAudio || 'Newsletter audio',
        icon: 'headphones',
        callback: () => { void guarded(plugin, 'open the window', () => openCatchUpWindow(plugin)); },
    });

    plugin.addCommand({
        id: 'newsletter-mark-catchup-listened',
        name: t.commands.newsletterMarkCatchUpListened || 'Mark this catch-up episode as listened',
        icon: 'check-circle-2',
        callback: () => { void guarded(plugin, 'mark listened', () => runMarkCatchUpListened(plugin)); },
    });

    plugin.addCommand({
        id: 'newsletter-regenerate-audio',
        name: t.commands.newsletterRegenerateAudio || 'Regenerate audio for today\'s brief',
        icon: 'audio-lines',
        callback: () => { void runRegenerateAudio(plugin); },
    });
}
