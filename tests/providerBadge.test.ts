// @vitest-environment happy-dom
/**
 * renderProviderBadge — each profile maps to the right pill class, accessible
 * name, and tooltip; null profile renders nothing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderProviderBadge } from '../src/ui/components/providerBadge';
import type { ProviderProfile } from '../src/services/providerProfile';

// Obsidian DOM helper polyfill over happy-dom.
function polyfill(el: HTMLElement): HTMLElement {
    const e = el as unknown as Record<string, unknown>;
    e.setText = (txt: string): void => { el.textContent = txt; };
    e.setAttr = (k: string, v: string): void => el.setAttribute(k, v);
    e.addClass = (c: string): void => el.classList.add(c);
    e.createSpan = (opts?: { cls?: string; text?: string }): HTMLElement => {
        const child = document.createElement('span');
        if (opts?.cls) child.className = opts.cls;
        if (opts?.text) child.textContent = opts.text;
        el.appendChild(child);
        return polyfill(child);
    };
    return el;
}

// Minimal translations slice the badge reads.
const t = {
    llmGateway: {
        badgeAzure: 'Azure {provider}',
        badgePersonal: 'Personal {provider}',
        badgeLocal: 'Local',
        badgeInvalid: 'Azure not configured',
        badgeNotConfigured: '{provider} not configured',
        badgeTooltip: 'Endpoint: {host}',
        badgeTooltipInvalid: 'Configure Azure in settings',
    },
} as unknown as Parameters<typeof renderProviderBadge>[2];

const base: ProviderProfile = {
    valid: true, mode: 'personal', provider: 'claude', providerLabel: 'Claude',
    endpointHost: 'api.anthropic.com', model: 'claude-sonnet-4-6', keySource: 'provider',
};

describe('renderProviderBadge', () => {
    let host: HTMLElement;
    beforeEach(() => { document.body.innerHTML = ''; host = polyfill(document.body.appendChild(document.createElement('div'))); });

    it('null profile → renders nothing', () => {
        expect(renderProviderBadge(host, null, t)).toBeNull();
        expect(host.children.length).toBe(0);
    });

    it('valid azure → 🏢 pill, azure class, host tooltip, role=img', () => {
        const pill = renderProviderBadge(host, { ...base, mode: 'azure', provider: 'azure-claude', endpointHost: 'r.services.ai.azure.com' }, t)!;
        expect(pill.className).toContain('is-azure');
        expect(pill.getAttribute('aria-label')).toBe('Azure Claude');
        expect(pill.textContent).toContain('🏢');
        expect(pill.getAttribute('title')).toBe('Endpoint: r.services.ai.azure.com');
        expect(pill.getAttribute('role')).toBe('img');
    });

    it('invalid azure → ⚠ warning pill, configure tooltip, no personal text', () => {
        const pill = renderProviderBadge(host, { ...base, mode: 'azure', valid: false, error: 'x' }, t)!;
        expect(pill.className).toContain('is-invalid');
        expect(pill.getAttribute('aria-label')).toMatch(/azure not configured/i);
        expect(pill.getAttribute('aria-label')).not.toMatch(/personal/i);
        expect(pill.getAttribute('title')).toMatch(/configure azure/i);
        expect(pill.textContent).toContain('⚠');
    });

    it('personal → 👤 pill, personal class', () => {
        const pill = renderProviderBadge(host, base, t)!;
        expect(pill.className).toContain('is-personal');
        expect(pill.getAttribute('aria-label')).toBe('Personal Claude');
        expect(pill.textContent).toContain('👤');
    });

    it('invalid personal → warning pill with provider name (M11)', () => {
        const pill = renderProviderBadge(host, { ...base, valid: false, error: 'No API key configured for Claude.' }, t)!;
        expect(pill.className).toContain('is-invalid');
        expect(pill.getAttribute('aria-label')).toBe('Claude not configured');
        expect(pill.textContent).toContain('⚠');
        expect(pill.getAttribute('title')).toMatch(/no api key/i);
    });

    it('local → 💻 pill, local class', () => {
        const pill = renderProviderBadge(host, { ...base, mode: 'local', provider: 'local', providerLabel: 'Local', endpointHost: 'localhost:11434' }, t)!;
        expect(pill.className).toContain('is-local');
        expect(pill.getAttribute('aria-label')).toBe('Local');
        expect(pill.textContent).toContain('💻');
    });
});
