/**
 * Newsletter audio mode — the ONE predicate every audio call site asks.
 *
 * `newsletterAudioPodcast` stays the master "Audio podcast" toggle (default off, so
 * nothing paid happens until the user turns audio on). `newsletterAudioMode` then picks
 * HOW audio is made:
 *
 *   - `daily`      today's pipeline, byte-identical (existing installs that had audio on)
 *   - `on-demand`  no automatic audio; the Newsletter audio command makes one catch-up
 *   - `smart-daily` automatic catch-up, but only when nothing earlier is still unheard
 *
 * Pure and dependency-free so the settings migration, the legacy gates and the new
 * catch-up engine can all import it without a cycle.
 */

export type NewsletterAudioMode = 'on-demand' | 'smart-daily' | 'daily';

export const NEWSLETTER_AUDIO_MODES: readonly NewsletterAudioMode[] = ['on-demand', 'smart-daily', 'daily'];

/** The mode a brand-new install (or an install that never had audio on) gets. */
export const DEFAULT_AUDIO_MODE: NewsletterAudioMode = 'on-demand';

/** The slice of settings these predicates read. */
export interface AudioModeSettings {
    newsletterAudioPodcast?: boolean;
    newsletterAudioMode?: unknown;
}

export function isAudioMode(value: unknown): value is NewsletterAudioMode {
    return typeof value === 'string' && (NEWSLETTER_AUDIO_MODES as readonly string[]).includes(value);
}

/**
 * The effective mode. Fail closed to the DEFAULT on an unrecognised value — never to
 * `daily`, which is the mode that spends money without being asked.
 */
export function getAudioMode(settings: AudioModeSettings): NewsletterAudioMode {
    return isAudioMode(settings.newsletterAudioMode) ? settings.newsletterAudioMode : DEFAULT_AUDIO_MODE;
}

/**
 * Whether the LEGACY daily pipeline (brief audio after each closed bucket, the recovery
 * sweep, "regenerate today") may run. For a `daily` install this is exactly the old
 * `newsletterAudioPodcast` truth table, which is what keeps that mode byte-identical.
 */
export function isDailyAudioEnabled(settings: AudioModeSettings): boolean {
    return settings.newsletterAudioPodcast === true && getAudioMode(settings) === 'daily';
}

/** Whether the catch-up engine (command, modal, status bar, smart-daily) is available. */
export function isCatchUpEnabled(settings: AudioModeSettings): boolean {
    return settings.newsletterAudioPodcast === true && getAudioMode(settings) !== 'daily';
}

/** Whether the mode generates audio without being asked. */
export function isAutomaticAudioMode(settings: AudioModeSettings): boolean {
    const mode = getAudioMode(settings);
    return settings.newsletterAudioPodcast === true && (mode === 'daily' || mode === 'smart-daily');
}

/**
 * Settings-migration helper: derive the stored mode for an install whose settings file
 * pre-dates the mode. Only an install that HAD audio on keeps today's behaviour
 * (`daily`); everyone else takes the default, which for them changes nothing because
 * audio was off.
 */
export function deriveAudioMode(stored: { newsletterAudioMode?: unknown; newsletterAudioPodcast?: unknown }): NewsletterAudioMode {
    if (isAudioMode(stored.newsletterAudioMode)) return stored.newsletterAudioMode;
    return stored.newsletterAudioPodcast === true ? 'daily' : DEFAULT_AUDIO_MODE;
}
