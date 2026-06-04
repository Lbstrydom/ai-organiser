import type { ProviderProfile } from '../../services/providerProfile';
import type { Translations } from '../../i18n/types';

/**
 * Provider trust badge (UX §3) — a pure presentational pill derived from the
 * resolved `ProviderProfile`. No state of its own; the mode-bar re-renders it.
 *
 * Accessibility: the pill is `role="img"` with an `aria-label` accessible name
 * (P0 — a labelled element, NOT `role="status"`; only the live status line uses
 * `role="status"`). The endpoint host is exposed via the tooltip.
 */
export function renderProviderBadge(
    container: HTMLElement,
    profile: ProviderProfile | null,
    t: Pick<Translations, 'llmGateway'>,
): HTMLElement | null {
    if (!profile) return null;
    const g = t.llmGateway;

    let label: string;
    let cls: BadgeClass;
    let tooltip: string;

    if (!profile.valid) {
        // M11: ANY unusable profile renders the warning pill, not just Azure —
        // a personal/local profile with no key/endpoint is equally misconfigured.
        label = profile.mode === 'azure'
            ? g.badgeInvalid
            : g.badgeNotConfigured.replace('{provider}', profile.providerLabel);
        cls = 'is-invalid';
        tooltip = profile.mode === 'azure' ? g.badgeTooltipInvalid : (profile.error ?? g.badgeTooltipInvalid);
    } else if (profile.mode === 'azure') {
        label = g.badgeAzure.replace('{provider}', profile.providerLabel);
        cls = 'is-azure';
        tooltip = g.badgeTooltip.replace('{host}', profile.endpointHost || '—');
    } else if (profile.mode === 'local') {
        label = g.badgeLocal;
        cls = 'is-local';
        tooltip = g.badgeTooltip.replace('{host}', profile.endpointHost || '—');
    } else {
        label = g.badgePersonal.replace('{provider}', profile.providerLabel);
        cls = 'is-personal';
        tooltip = g.badgeTooltip.replace('{host}', profile.endpointHost || '—');
    }

    const icon = ICONS[cls] ?? '';
    const pill = container.createSpan({ cls: `ai-organiser-provider-badge ${cls}` });
    pill.setText(icon ? `${icon} ${label}` : label);
    pill.setAttr('role', 'img');
    pill.setAttr('aria-label', label);
    pill.setAttr('title', tooltip);
    return pill;
}

type BadgeClass = 'is-azure' | 'is-personal' | 'is-local' | 'is-invalid';

const ICONS: Record<BadgeClass, string> = {
    'is-azure': '🏢',
    'is-personal': '👤',
    'is-local': '💻',
    'is-invalid': '⚠',
};
