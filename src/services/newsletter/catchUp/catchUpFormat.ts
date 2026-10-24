/**
 * Catch-up wording helpers shared by the window and the status bar. Pure: they take the
 * translations, not the plugin, so neither surface has to import the other.
 */

import type { Translations } from '../../../i18n/types';
import { effectiveLookbackDays } from './catchUpCoverage';

/** "3 days · 12 newsletters" / "One day · One newsletter". */
export function formatPendingSummary(t: Translations, days: number, newsletters: number): string {
    const m = t.modals.newsletterCatchUp;
    const d = (days === 1 ? m.daysOne : m.daysMany).replace('{n}', String(days));
    const n = (newsletters === 1 ? m.newslettersOne : m.newslettersMany).replace('{n}', String(newsletters));
    return m.pendingSummary.replace('{days}', d).replace('{newsletters}', n);
}

/** The completion line: "about 12 min", or "under a minute" for a very short episode (never "about 0 min"). */
export function formatEpisodeDone(t: Translations, minutes: number, covering: string): string {
    const m = t.modals.newsletterCatchUp;
    return (minutes < 1 ? m.doneShort : m.done.replace('{minutes}', String(Math.round(minutes)))).replace('{days}', covering);
}

/**
 * The note shown under the catch-up window setting when the retention period is shorter than the
 * window: older digests are gone, so the window is silently shorter. Null when nothing is clamped.
 */
export function lookbackClampNote(t: Translations, lookbackSetting: unknown, retentionDays: unknown): string | null {
    const effective = effectiveLookbackDays(lookbackSetting, retentionDays);
    const asked = effectiveLookbackDays(lookbackSetting, 0);
    return effective < asked ? t.settings.newsletter.catchUp.lookbackClampNote.replaceAll('{n}', String(effective)) : null;
}

/** A comma list for a few dates, a range for many consecutive ones; many scattered dates stay a counted list (a range would claim the gaps). */
export function formatDates(dates: readonly string[]): string {
    if (dates.length <= 4) return dates.join(', ');
    return isContiguous(dates) ? `${dates[0]} – ${dates[dates.length - 1]}` : formatDateList(dates);
}

/** Every date for a handful of dates, the first few and a count beyond that (never a range that hides gaps). */
export function formatDateList(dates: readonly string[], max = 6): string {
    return dates.length <= max ? dates.join(', ') : `${dates.slice(0, max - 1).join(', ')} +${dates.length - (max - 1)} more`;
}

/** True when the dates are consecutive calendar days, so "A to B" does not hide a gap. */
export function isContiguous(dates: readonly string[]): boolean {
    return dates.length < 2 || datesBetween(dates[0], dates[dates.length - 1]).length === dates.length;
}

/** Every calendar date from `from` to `to`, inclusive. */
export function datesBetween(from: string, to: string): string[] {
    const out: string[] = [];
    const [y, m, d] = from.split('-').map(Number);
    for (let i = 0; i < 400; i++) {
        const dt = new Date(y, m - 1, d + i);
        const s = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
        out.push(s);
        if (s >= to) break;
    }
    return out;
}
