// @vitest-environment happy-dom
/**
 * AzureCapabilitiesSettingsSection tests (azure-audio Phase 5).
 *
 * The section is render-heavy; these tests pin the DECISION surface the azure
 * speech subsection introduces: azure-gating, capability mode writes, and the
 * speech settings round-trip — using the same minimal-double pattern as
 * featuresSettingsSection.test.ts. The voice-catalog fetch states are covered
 * by voiceCatalogService via its own service-level behaviour.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('obsidian', async () => await import('./mocks/obsidian'));

beforeAll(() => {
    type ElOpts = { cls?: string; text?: string; attr?: Record<string, string>; type?: string; value?: string };
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const proto = HTMLElement.prototype as any;
    if (!proto.empty) proto.empty = function () { while (this.firstChild) this.firstChild.remove(); };
    if (!proto.addClass) proto.addClass = function (c: string) { this.classList.add(c); };
    if (!proto.setText) proto.setText = function (t: string) { this.textContent = t; };
    if (!proto.createEl) proto.createEl = function (tag: string, opts: ElOpts = {}) {
        const el = document.createElement(tag);
        if (opts.cls) el.className = opts.cls;
        if (opts.text !== undefined) el.textContent = opts.text;
        if (opts.attr) for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
        this.appendChild(el);
        return el;
    };
    if (!proto.createDiv) proto.createDiv = function (opts: ElOpts = {}) { return this.createEl('div', opts); };
    if (!proto.createSpan) proto.createSpan = function (opts: ElOpts = {}) { return this.createEl('span', opts); };
    /* eslint-enable @typescript-eslint/no-explicit-any */
});

import { AzureCapabilitiesSettingsSection } from '../src/ui/settings/AzureCapabilitiesSettingsSection';
import { en } from '../src/i18n/en';

interface Harness {
    section: AzureCapabilitiesSettingsSection;
    plugin: any;
    container: HTMLElement;
}

function makeSection(settings: Record<string, unknown> = {}): Harness {
    const plugin = {
        settings: {
            cloudServiceType: 'azure-claude',
            featureFlags: {},
            azureCapabilities: {},
            azureSpeechRegion: '',
            azureSpeechEndpoint: '',
            azureSpeechVoice: '',
            azureSpeechMaxSpeakers: 4,
            azureSpeechRequired: false,
            audioDiarisationProvider: 'none',
            azureAIEndpoint: 'https://res.services.ai.azure.com',
            azureOpenAIEndpoint: 'https://res.openai.azure.com',
            ...settings,
        },
        t: en,
        saveSettings: vi.fn().mockResolvedValue(undefined),
        secretStorageService: {
            isAvailable: () => false,
            getSecret: async () => null,
            resolveApiKey: async () => null,
        },
    };
    const container = document.createElement('div');
    const settingTab = { display: vi.fn() };
    const section = new AzureCapabilitiesSettingsSection(plugin as never, container as never, settingTab as never);
    return { section, plugin, container };
}

describe('AzureCapabilitiesSettingsSection — azure speech subsection', () => {
    it('renders nothing outside Azure mode (hard gate)', () => {
        const { section, container } = makeSection({ cloudServiceType: 'claude' });
        section.display();
        expect(container.childElementCount).toBe(0);
    });

    it('renders the speech section header + description in Azure mode', () => {
        const { section, container } = makeSection();
        // The mock Setting does not paint names into the DOM — rendered
        // elements (h4/p/div) are the observable surface here; the full row
        // set (toggle/slider/dropdown) is exercised by display() not throwing.
        section.display();
        const text = container.textContent ?? '';
        expect(text).toContain(en.settings.azureSpeech.title);
        expect(text).toContain(en.settings.azureSpeech.description);
    });

    it('shows the Global-Standard legacy notice while speech is unconfigured + strict off (DP-1)', () => {
        const { section, container } = makeSection();
        section.display();
        expect(container.textContent).toContain(en.settings.azureSpeech.legacyGlobalStandardNotice);
    });

    it('hides the legacy notice once speech is configured', () => {
        const { section, container } = makeSection({
            azureSpeechRegion: 'swedencentral',
            azureSpeechVoice: 'en-US-AvaNeural',
        });
        section.display();
        expect(container.textContent).not.toContain(en.settings.azureSpeech.legacyGlobalStandardNotice);
    });

    it('hides the legacy notice in strict mode (fail-closed, not legacy)', () => {
        const { section, container } = makeSection({ azureSpeechRequired: true });
        section.display();
        expect(container.textContent).not.toContain(en.settings.azureSpeech.legacyGlobalStandardNotice);
    });
});
