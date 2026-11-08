/**
 * Who sees the first-run welcome (docs/plans/navigation-discoverability.md, Phase 5). Decided from
 * the RAW persisted data, before defaults are merged: a genuinely new install (no data) sees it;
 * any install that already had settings, even without `features`, does not. An existing value
 * is kept. Pure, and idempotent on a second load.
 */
export function markWelcomeForExistingInstall(raw: unknown, migrated: Record<string, unknown> | null | undefined): void {
    if (!migrated || typeof migrated !== 'object') return;
    if (typeof migrated.welcomeSeen === 'boolean') return;
    if (raw !== null && raw !== undefined) migrated.welcomeSeen = true;
}
