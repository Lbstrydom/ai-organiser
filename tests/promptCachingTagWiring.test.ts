/**
 * Prompt caching — which tag calls carry a cacheable prefix.
 *
 * A prefix is only worth marking when the call repeats within the cache TTL:
 * a multi-note batch does, a one-off "tag this note" does not (it would pay the
 * 1.25x write premium and never read it back).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('obsidian', async () => await import('./mocks/obsidian'));

import { App, TFile } from 'obsidian';
import AIOrganiserPlugin from '../src/main';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { buildTaxonomyTagPrompt } from '../src/services/prompts/tagPrompts';

const TAXONOMY = '<available_themes>\n- A: a\n</available_themes>';

function makePlugin() {
    const app = new App();
    const plugin = new AIOrganiserPlugin(app as never, {
        id: 'test', version: '1.0.0', name: 'Test', author: 'Test', minAppVersion: '0.0.0', description: 'Test',
    } as never);
    plugin.settings = { ...DEFAULT_SETTINGS, enableTaxonomyGuardrail: false };
    const generateTags = vi.fn().mockResolvedValue({ success: false, error: 'stop here' });
    (plugin as unknown as { configService: unknown }).configService = {
        getTaxonomyForPrompt: async () => TAXONOMY,
        getExcludedTags: async () => [],
    };
    (plugin as unknown as { getTaggingService: unknown }).getTaggingService = async () => ({ generateTags });
    return { plugin, generateTags };
}

const file = Object.assign(new TFile(), { path: 'n.md', basename: 'n' });

beforeEach(() => { vi.clearAllMocks(); });

describe('analyzeAndTagNote', () => {
    it('cacheTagPrefix: sends the stable head as stablePrefix and only the note part as the prompt', async () => {
        const { plugin, generateTags } = makePlugin();
        await plugin.analyzeAndTagNote(file, 'note body', { cacheTagPrefix: true });
        const [prompt, opts] = generateTags.mock.calls[0];
        expect(opts.stablePrefix).toBeTruthy();
        expect(opts.label).toBe('tagging');
        expect(opts.stablePrefix).not.toContain('note body');
        expect(prompt).toContain('note body');
        expect(`${opts.stablePrefix}\n\n${prompt}`)
            .toBe(buildTaxonomyTagPrompt('note body', TAXONOMY, plugin.settings.maxTags, plugin.settings.language));
    });

    it('a single note (no cacheTagPrefix): sends the legacy joined prompt with no stablePrefix', async () => {
        const { plugin, generateTags } = makePlugin();
        await plugin.analyzeAndTagNote(file, 'note body');
        const [prompt, opts] = generateTags.mock.calls[0];
        expect(opts.stablePrefix).toBeUndefined();
        expect(prompt).toBe(buildTaxonomyTagPrompt('note body', TAXONOMY, plugin.settings.maxTags, plugin.settings.language));
    });
});

describe('analyzeAndTagFiles', () => {
    // The batch status bar / long-running-op controller use `window` timers.
    let hadWindow = false;
    let originalWindow: unknown;
    beforeEach(() => {
        hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
        originalWindow = (globalThis as unknown as { window?: unknown }).window;
        (globalThis as unknown as { window: unknown }).window = globalThis;
    });
    afterEach(() => {
        if (hadWindow) (globalThis as unknown as { window?: unknown }).window = originalWindow;
        else delete (globalThis as unknown as { window?: unknown }).window;
    });

    const run = async (count: number): Promise<Array<boolean | undefined>> => {
        const { plugin } = makePlugin();
        const files = Array.from({ length: count }, (_v, i) => Object.assign(new TFile(), { path: `n${i}.md`, basename: `n${i}` }));
        (plugin.app.vault as unknown as { read: unknown }).read = vi.fn().mockResolvedValue('body');
        const spy = vi.spyOn(plugin, 'analyzeAndTagNote').mockResolvedValue({ success: true, message: 'ok', tags: [] });
        vi.spyOn(plugin, 'handleTagUpdateResult').mockImplementation(() => {});
        await plugin.analyzeAndTagFiles(files);
        return spy.mock.calls.map(c => c[2]?.cacheTagPrefix);
    };

    it('marks the prefix cacheable for a batch of 2+ notes', async () => {
        expect(await run(3)).toEqual([true, true, true]);
    });

    it('does not mark a one-note "batch"', async () => {
        expect(await run(1)).toEqual([false]);
    });
});
