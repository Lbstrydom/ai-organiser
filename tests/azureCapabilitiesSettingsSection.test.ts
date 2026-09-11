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
import * as obsidianMock from './mocks/obsidian';

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

    describe('Speech API key field — immediate migration (regression, 2026-09-11)', () => {
        // The generic bulk migrateFromPlainText() flow is gated on a "Migrate"
        // button that only renders when hasPlainTextKeys() is true — and before
        // this fix, that check never looked at azureSpeechApiKey. On a fresh
        // install with no OTHER plaintext key pending, a value typed into this
        // field sat inert in settings forever: resolveAzureSpeechCredential only
        // ever reads secretStorage, never this field directly, so it silently
        // fell back to the shared Foundry key instead — "unauthorized" with a
        // byte-correct key and no way to tell why from the UI.

        /** Drive the section's render, capturing the password-type field's onChange. */
        function driveAndCaptureApiKeyOnChange(plugin: any, container: HTMLElement): (v: string) => void | Promise<void> {
            const addTextSpy = vi.spyOn(obsidianMock.Setting.prototype, 'addText');
            const captured: { inputEl: { type?: string }; onChangeFn?: (v: string) => void }[] = [];
            addTextSpy.mockImplementation(function (this: any, cb: (t: any) => void) {
                const component: any = {
                    inputEl: {},
                    setValue: () => component,
                    getValue: () => '',
                    setPlaceholder: () => component,
                    onChange: (fn: (v: string) => void) => { component.onChangeFn = fn; return component; },
                };
                cb(component);
                captured.push(component);
                return this;
            });

            const section = new AzureCapabilitiesSettingsSection(plugin, container as never, { display: vi.fn() } as never);
            section.display();
            addTextSpy.mockRestore();

            const apiKeyField = captured.find((c) => c.inputEl.type === 'password');
            if (!apiKeyField?.onChangeFn) throw new Error('Speech API key field (password-type addText) not found in render');
            return apiKeyField.onChangeFn;
        }

        it('writes the key into SecretStorage under AZURE_SPEECH immediately, and clears the plaintext field', async () => {
            const setSecret = vi.fn().mockResolvedValue(undefined);
            const { plugin, container } = makeSection();
            plugin.secretStorageService = { isAvailable: () => true, getSecret: async () => null, resolveApiKey: async () => null, setSecret };

            const onChange = driveAndCaptureApiKeyOnChange(plugin, container);
            // onChange is fire-and-forget (void ...then(...)) by design — flush
            // the microtask queue rather than trusting await-on-undefined timing.
            onChange('my-native-foundry-key');
            await new Promise((r) => setTimeout(r, 0));

            expect(setSecret).toHaveBeenCalledWith('ai-organiser-azure-speech-key', 'my-native-foundry-key');
            expect(plugin.settings.azureSpeechApiKey).toBe('');
            expect(plugin.saveSettings).toHaveBeenCalled();
        });

        it('does not call setSecret for an empty value, and clears the field', async () => {
            const setSecret = vi.fn().mockResolvedValue(undefined);
            const { plugin, container } = makeSection({ azureSpeechApiKey: 'stale' });
            plugin.secretStorageService = { isAvailable: () => true, getSecret: async () => null, resolveApiKey: async () => null, setSecret };

            const onChange = driveAndCaptureApiKeyOnChange(plugin, container);
            await onChange('');

            expect(setSecret).not.toHaveBeenCalled();
            expect(plugin.settings.azureSpeechApiKey).toBe('');
        });

        it('falls back to plaintext (with a warning) when SecretStorage is unavailable on this platform', async () => {
            const setSecret = vi.fn();
            const { plugin, container } = makeSection();
            plugin.secretStorageService = { isAvailable: () => false, getSecret: async () => null, resolveApiKey: async () => null, setSecret };

            const onChange = driveAndCaptureApiKeyOnChange(plugin, container);
            await onChange('my-native-foundry-key');

            expect(setSecret).not.toHaveBeenCalled();
            expect(plugin.settings.azureSpeechApiKey).toBe('my-native-foundry-key');
        });
    });
});
