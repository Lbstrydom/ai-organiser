// @vitest-environment happy-dom
/**
 * SemanticSearchSettingsSection tests — npm-audit-remediation plan, Cluster 4.
 *
 * Focused on `applyLocalOnnxConsentChange`'s rollback contract (Gemini gate
 * round 1 G2): a mutator callback captures exactly what each caller needs
 * to change, and a save failure restores ALL snapshotted fields (flag,
 * provider, model) — not just the flag — leaving in-memory settings exactly
 * as they were before the mutation.
 *
 * Uses the same minimal-double + prototype-shim pattern as
 * azureCapabilitiesSettingsSection.test.ts.
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

import { SemanticSearchSettingsSection } from '../src/ui/settings/SemanticSearchSettingsSection';
import { en } from '../src/i18n/en';

interface Harness {
    section: SemanticSearchSettingsSection;
    plugin: any;
}

function makeSection(settings: Record<string, unknown> = {}, saveImpl?: () => Promise<void>): Harness {
    const plugin = {
        settings: {
            embeddingProvider: 'openai',
            embeddingModel: 'text-embedding-3-small',
            // Non-empty by default so display()'s re-render (triggered
            // internally by applyLocalOnnxConsentChange) takes the
            // "key available" branch, not the broken renderApiKeyField
            // mock-gap path (BaseSettingSection's Setting mock has no
            // descEl — a pre-existing shared-mock limitation).
            embeddingApiKey: 'sk-default-test-key',
            enableLocalOnnxEmbeddings: false,
            enableVaultChat: false,
            useSharedExcludedFolders: true,
            excludedFolders: [],
            featureFlags: { 'semantic-search': true },
            providerSettings: {},
            cloudApiKey: '',
            cloudServiceType: 'openai',
            autoIndexNewNotes: true,
            indexAttachmentText: false,
            maxAttachmentCharsPerNote: 50000,
            chunkSize: 2000,
            chunkOverlap: 200,
            maxChunksPerNote: 10,
            ...settings,
        },
        t: en,
        saveSettings: vi.fn(saveImpl ?? (async () => { /* success */ })),
        secretStorageService: {
            isAvailable: () => false,
            getSecret: async () => null,
            resolveApiKey: async () => null,
            hasSecret: async () => false,
        },
        app: {},
    };
    const container = document.createElement('div');
    const settingTab = { display: vi.fn(), expandedSections: new Set<string>() };
    const section = new SemanticSearchSettingsSection(plugin as never, container as never, settingTab as never);
    return { section, plugin };
}

describe('SemanticSearchSettingsSection — applyLocalOnnxConsentChange rollback', () => {
    it('a successful save persists the mutator\'s change', async () => {
        const { section, plugin } = makeSection();
        await (section as any).applyLocalOnnxConsentChange(plugin, () => {
            plugin.settings.enableLocalOnnxEmbeddings = true;
        });
        expect(plugin.settings.enableLocalOnnxEmbeddings).toBe(true);
        expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
    });

    it('a failed save rolls back ALL snapshotted fields — not just the one the mutator touched directly', async () => {
        const { section, plugin } = makeSection({}, async () => { throw new Error('disk full'); });
        const before = {
            enableLocalOnnxEmbeddings: plugin.settings.enableLocalOnnxEmbeddings,
            embeddingProvider: plugin.settings.embeddingProvider,
            embeddingModel: plugin.settings.embeddingModel,
        };

        await (section as any).applyLocalOnnxConsentChange(plugin, () => {
            // Mirrors the dropdown/banner mutator — changes THREE fields.
            plugin.settings.enableLocalOnnxEmbeddings = true;
            plugin.settings.embeddingProvider = 'local-onnx';
            plugin.settings.embeddingModel = 'Xenova/all-MiniLM-L6-v2';
        });

        expect(plugin.settings.enableLocalOnnxEmbeddings).toBe(before.enableLocalOnnxEmbeddings);
        expect(plugin.settings.embeddingProvider).toBe(before.embeddingProvider);
        expect(plugin.settings.embeddingModel).toBe(before.embeddingModel);
    });

    it('a failed save on the toggle-only mutator rolls back just the flag (nothing else was touched)', async () => {
        const { section, plugin } = makeSection(
            { enableLocalOnnxEmbeddings: true },
            async () => { throw new Error('disk full'); },
        );
        await (section as any).applyLocalOnnxConsentChange(plugin, () => {
            plugin.settings.enableLocalOnnxEmbeddings = false;
        });
        expect(plugin.settings.enableLocalOnnxEmbeddings).toBe(true);
    });

    // NOTE: full-render display() smoke tests were attempted here but
    // dropped — display() exercises pre-existing, unrelated render paths
    // (the Manage Index button's setIcon(), the API-key field's descEl)
    // that the shared Obsidian mock (tests/mocks/obsidian.ts) doesn't
    // implement. No existing test in this repo fully renders this section
    // today, so this is pre-existing shared-mock debt, not a Cluster-4
    // regression — expanding this test file to patch the shared mock's
    // Setting/addButton API surface is out of scope for this cluster.
    // The rollback tests above (the actual required coverage for this
    // cluster) exercise the real logic directly; `npx tsc` confirms the
    // file compiles and wires correctly against the real Setting/Modal
    // Obsidian API types.
});
