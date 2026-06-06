/**
 * Canonical elapsed-time formatter (waiting-state-ux SSOT).
 *
 * ONE format used by every waiting indicator (the chat thinking indicator AND
 * ProgressReporter's Notice) so long-wait UX is visually consistent. Pure +
 * unit-tested. `formatDuration` is kept as a thin delegating alias so existing
 * imports don't break (deterministic migration — no two divergent formatters).
 */

/**
 * Format an elapsed duration as `m:ss` (`< 1h`) or `h:mm:ss` (`≥ 1h`).
 * Non-finite / negative / NaN inputs clamp to `0:00`.
 */
export function formatElapsed(ms: number): string {
    const totalSec = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
    const s = totalSec % 60;
    const m = Math.floor(totalSec / 60) % 60;
    const h = Math.floor(totalSec / 3600);
    const ss = s.toString().padStart(2, '0');
    if (h > 0) {
        const mm = m.toString().padStart(2, '0');
        return `${h}:${mm}:${ss}`;
    }
    return `${m}:${ss}`;
}

/** @deprecated Use {@link formatElapsed}. Kept as a delegating alias so existing
 *  imports keep working during the migration (one implementation, two names). */
export const formatDuration = formatElapsed;
