/**
 * Catch-up wording helpers shared by the window and the status bar. Pure: they take the
 * translations, not the plugin, so neither surface has to import the other.
 */

import type { Translations } from '../../../i18n/types';

/** "3 days · 12 newsletters" / "One day · One newsletter". */
export function formatPendingSummary(t: Translations, days: number, newsletters: number): string {
    const m = t.modals.newsletterCatchUp;
    const d = days === 1 ? m.daysOne : m.daysMany.replace('{n}', String(days));
    const n = newsletters === 1 ? m.newslettersOne : m.newslettersMany.replace('{n}', String(newsletters));
    return m.pendingSummary.replace('{days}', d).replace('{newsletters}', n);
}

/** A comma list for a few dates, a range for many. */
export function formatDates(dates: readonly string[]): string {
    return dates.length <= 4 ? dates.join(', ') : `${dates[0]} – ${dates[dates.length - 1]}`;
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
