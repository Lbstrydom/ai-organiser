/**
 * The Newsletter settings section: which controls exist in which audio mode, and that the mode
 * dropdown does what it says. A recording `Setting` stands in for Obsidian's.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const recorded = vi.hoisted(() => ({ items: [] as Array<{ name: string; desc?: string; heading: boolean; cls?: string; dropdown?: { options: Array<[string, string]>; value: string; change: (v: string) => void }; slider?: { min: number; max: number; step: number; value: number; change: (v: number) => void }; toggle?: { value: boolean; change: (v: boolean) => void } }> }));

vi.mock('obsidian', async () => {
    const base = await import('./mocks/obsidian');
    const chain = (): unknown => new Proxy(function () { /* callable */ }, {
        get: (_t, prop) => (prop === 'then' || typeof prop === 'symbol' ? undefined : chain()),
        apply: () => chain(),
    });
    class RecordingSetting {
        private item: (typeof recorded.items)[number];
        constructor(_el: unknown) { this.item = { name: '', heading: false }; recorded.items.push(this.item); }
        setName(n: string) { this.item.name = n; return this; }
        setDesc(d: string) { this.item.desc = d; return this; }
        setHeading() { this.item.heading = true; return this; }
        setClass(c: string) { this.item.cls = c; return this; }
        addDropdown(cb: (d: unknown) => void) {
            const dd = { options: [] as Array<[string, string]>, value: '', change: (_v: string): void => undefined };
            const api = {
                addOption: (v: string, l: string) => { dd.options.push([v, l]); return api; },
                setValue: (v: string) => { dd.value = v; return api; },
                onChange: (f: (v: string) => void) => { dd.change = f; return api; },
            };
            cb(api);
            this.item.dropdown = dd;
            return this;
        }
        addSlider(cb: (s: unknown) => void) {
            const sl = { min: 0, max: 0, step: 0, value: 0, change: (_v: number): void => undefined };
            const api = {
                setLimits: (a: number, b: number, c?: number) => { sl.min = a; sl.max = b; sl.step = c ?? 0; return api; },
                setValue: (v: number) => { sl.value = v; return api; },
                setDynamicTooltip: () => api,
                onChange: (f: (v: number) => void) => { sl.change = f; return api; },
            };
            cb(api);
            this.item.slider = sl;
            return this;
        }
        addToggle(cb: (t: unknown) => void) {
            const tg = { value: false, change: (_v: boolean): void => undefined };
            const api = { setValue: (v: boolean) => { tg.value = v; return api; }, onChange: (f: (v: boolean) => void) => { tg.change = f; return api; } };
            cb(api);
            this.item.toggle = tg;
            return this;
        }
        // Components this test does not inspect accept any chained call.
        addText(cb: (t: unknown) => void) { cb(chain()); return this; }
        addButton(cb: (b: unknown) => void) { cb(chain()); return this; }
        addTextArea(cb: (t: unknown) => void) { cb(chain()); return this; }
        addExtraButton(cb: (b: unknown) => void) { cb(chain()); return this; }
    }
    return { ...base, Setting: RecordingSetting };
});

import { NewsletterSettingsSection } from '../src/ui/settings/NewsletterSettingsSection';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { getTranslations } from '../src/i18n';
import { createTFolder } from './mocks/obsidian';

const t = getTranslations('en');

/** A container that accepts any DOM-helper call (createEl, createDiv, addClass, ...). */
function anyElement(): unknown {
    const make = (): unknown => new Proxy(function () { /* callable */ }, {
        get: (_t, prop) => (prop === 'then' || typeof prop === 'symbol' ? undefined : make()),
        apply: () => make(),
    });
    return make();
}

function build(over: Record<string, unknown> = {}) {
    const display = vi.fn();
    const plugin = {
        t,
        app: { vault: { getAbstractFileByPath: () => createTFolder('x') } },
        settings: {
            ...DEFAULT_SETTINGS,
            featureFlags: { newsletter: true },
            newsletterDailyBrief: true,
            newsletterAudioPodcast: true,
            newsletterAudioMode: 'on-demand',
            newsletterStoryMemory: true,
            ...over,
        },
        saveSettings: vi.fn(async () => undefined),
        scheduleCatchUpCleanup: vi.fn(),
        secretStorageService: { isAvailable: () => false },
        loadData: async () => ({}),
        newsletterSeenIds: [],
        newsletterLastFetchTime: 0,
    };
    const section = new NewsletterSettingsSection(plugin as never, anyElement() as never, { display } as never);
    return { plugin, display, section };
}

const names = () => recorded.items.map((i) => i.name);
const find = (name: string) => recorded.items.find((i) => i.name === name);

beforeEach(() => { recorded.items.length = 0; });

function render(over: Record<string, unknown> = {}) {
    const ctx = build(over);
    try { ctx.section.display(); } catch (e) { throw new Error(`display() threw: ${String(e)}`); }
    return ctx;
}

describe('audio delivery in the Newsletter section', () => {
    it('on demand: shows the mode, the catch-up controls and the voice, but not the daily-only controls', () => {
        render({ newsletterAudioMode: 'on-demand' });
        expect(names()).toEqual(expect.arrayContaining(['Catch-up audio', 'Audio delivery', 'Podcast voice', 'Catch-up window (days)', 'Longest episode (minutes)', 'Show pending days in the status bar']));
        expect(names()).not.toContain('Maximum podcast length (minutes)');
        expect(names()).not.toContain('Regenerate audio for today');
    });

    it('smart daily shows the same catch-up controls', () => {
        render({ newsletterAudioMode: 'smart-daily' });
        expect(names()).toEqual(expect.arrayContaining(['Audio delivery', 'Catch-up window (days)', 'Longest episode (minutes)']));
        expect(names()).not.toContain('Regenerate audio for today');
    });

    it('daily keeps the daily controls exactly and previews the catch-up controls switched off', () => {
        render({ newsletterAudioMode: 'daily' });
        expect(names()).toEqual(expect.arrayContaining(['Audio delivery', 'Podcast voice', 'Maximum podcast length (minutes)', 'Regenerate audio for today']));
        // Shown (disabled in the DOM, see the real-render check) so a Daily user can see what On demand offers.
        expect(names()).toEqual(expect.arrayContaining(['Catch-up window (days)', 'Longest episode (minutes)']));
        // Daily-only controls are not duplicated and "When I am behind" stays Smart-daily-only.
        expect(names().filter((n) => n === 'Audio delivery')).toHaveLength(1);
        expect(names()).not.toContain('When I am behind');
    });

    it('the preview does not change a stored value just by being drawn', () => {
        const { plugin } = render({ newsletterAudioMode: 'daily', newsletterCatchUpLookbackDays: 9, newsletterCatchUpMaxMins: 12 });
        expect(plugin.settings.newsletterCatchUpLookbackDays).toBe(9);
        expect(plugin.settings.newsletterCatchUpMaxMins).toBe(12);
        expect(plugin.saveSettings).not.toHaveBeenCalled();
    });

    it('audio off hides every audio control, whatever the stored mode', () => {
        render({ newsletterAudioPodcast: false, newsletterAudioMode: 'on-demand' });
        expect(names()).not.toContain('Audio delivery');
        expect(names()).not.toContain('Podcast voice');
    });

    it('offers exactly the three modes and selects the stored one', () => {
        render({ newsletterAudioMode: 'smart-daily' });
        const dd = find('Audio delivery')!.dropdown!;
        expect(dd.options.map(([v]) => v)).toEqual(['on-demand', 'smart-daily', 'daily']);
        expect(dd.value).toBe('smart-daily');
    });

    it('the three modes are named plainly, and the description under the dropdown says what the SELECTED mode does', () => {
        const expected: Record<string, [string, RegExp]> = {
            'on-demand': ['On demand', /Nothing is made automatically\. You ask for a catch-up when you want one/],
            'smart-daily': ['Smart daily', /One audio covers every day since your last one.*waits until you have heard the last episode/],
            daily: ['Daily', /A short audio every day, whether or not you heard yesterday's/],
        };
        for (const [mode, [label, desc]] of Object.entries(expected)) {
            recorded.items.length = 0;
            render({ newsletterAudioMode: mode });
            const item = find('Audio delivery')!;
            expect(item.dropdown!.options.find(([v]) => v === mode)![1]).toBe(label);
            expect(item.desc).toMatch(desc);
        }
        recorded.items.length = 0;
        render({ newsletterAudioMode: 'on-demand' });
        expect(find('Audio delivery')!.dropdown!.options.map(([, l]) => l)).toEqual(['On demand', 'Smart daily', 'Daily']);
        expect(JSON.stringify(find('Audio delivery'))).not.toContain('previous behaviour');
    });

    it('a garbage stored mode shows the default, never daily', () => {
        render({ newsletterAudioMode: 'weekly' });
        expect(find('Audio delivery')!.dropdown!.value).toBe('on-demand');
    });

    it('choosing a mode saves it and redraws the section', () => {
        const { plugin, display } = render({ newsletterAudioMode: 'daily' });
        find('Audio delivery')!.dropdown!.change('on-demand');
        expect(plugin.settings.newsletterAudioMode).toBe('on-demand');
        expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
        expect(display).toHaveBeenCalledTimes(1);
    });

    it('ignores a value that is not a mode', () => {
        const { plugin, display } = render({ newsletterAudioMode: 'on-demand' });
        find('Audio delivery')!.dropdown!.change('hourly');
        expect(plugin.settings.newsletterAudioMode).toBe('on-demand');
        expect(plugin.saveSettings).not.toHaveBeenCalled();
        expect(display).not.toHaveBeenCalled();
    });
});

describe('catch-up controls', () => {
    it('the window is 1 to 14 calendar days and saves', () => {
        const { plugin } = render({ newsletterAudioMode: 'on-demand', newsletterCatchUpLookbackDays: 9 });
        const sl = find('Catch-up window (days)')!.slider!;
        expect([sl.min, sl.max, sl.value]).toEqual([1, 14, 9]);
        sl.change(5);
        expect(plugin.settings.newsletterCatchUpLookbackDays).toBe(5);
        expect(plugin.saveSettings).toHaveBeenCalled();
    });

    it('the longest episode is 5 to 20 minutes and saves', () => {
        const { plugin } = render({ newsletterAudioMode: 'on-demand' });
        const sl = find('Longest episode (minutes)')!.slider!;
        expect([sl.min, sl.max, sl.value]).toEqual([5, 20, 20]);
        sl.change(12);
        expect(plugin.settings.newsletterCatchUpMaxMins).toBe(12);
    });

    it('the status bar toggle reflects and saves the choice', () => {
        const { plugin } = render({ newsletterAudioMode: 'on-demand', newsletterCatchUpStatusBar: false });
        const tg = find('Show pending days in the status bar')!.toggle!;
        expect(tg.value).toBe(false);
        tg.change(true);
        expect(plugin.settings.newsletterCatchUpStatusBar).toBe(true);
    });

    it('audio cleanup is off by default: a 0 to 28 day slider that saves, clamps and schedules a sweep', async () => {
        const { plugin } = render({ newsletterAudioMode: 'on-demand' });
        const sl = find('Remove audio of listened catch-up episodes after (days)')!.slider!;
        expect([sl.min, sl.max, sl.value]).toEqual([0, 28, 0]);
        sl.change(14);
        expect(plugin.settings.newsletterCatchUpAudioCleanupDays).toBe(14);
        expect(plugin.saveSettings).toHaveBeenCalled();
        await Promise.resolve();
        await Promise.resolve();
        expect(plugin.scheduleCatchUpCleanup).toHaveBeenCalledTimes(1);
        sl.change(0);
        expect(plugin.settings.newsletterCatchUpAudioCleanupDays).toBe(0);
    });

    it('shows a stored value and clamps a garbage one', () => {
        render({ newsletterAudioMode: 'on-demand', newsletterCatchUpAudioCleanupDays: 21 });
        expect(find('Remove audio of listened catch-up episodes after (days)')!.slider!.value).toBe(21);
        recorded.items.length = 0;
        render({ newsletterAudioMode: 'on-demand', newsletterCatchUpAudioCleanupDays: 400 });
        expect(find('Remove audio of listened catch-up episodes after (days)')!.slider!.value).toBe(28);
    });

    it('daily mode only previews the cleanup control (switched off in the DOM), and saves nothing', () => {
        const { plugin } = render({ newsletterAudioMode: 'daily' });
        expect(names().filter((n) => n === 'Remove audio of listened catch-up episodes after (days)')).toHaveLength(1);
        expect(plugin.saveSettings).not.toHaveBeenCalled();
    });

    it('with story memory off the section says catch-up covers whole closed days', () => {
        render({ newsletterAudioMode: 'on-demand', newsletterStoryMemory: false });
        // The note is a description-only Setting: it has no name, but it is rendered.
        expect(recorded.items.filter((i) => i.name === '').length).toBeGreaterThan(0);
    });
});

describe('the listened / read / known map', () => {
    it('is shown once, in the memory block, and the known control is named plainly', () => {
        render({ newsletterAudioMode: 'on-demand', newsletterStoryMemory: true });
        expect(recorded.items.filter((i) => i.name === 'How listened, read and known fit together')).toHaveLength(1);
        const map = find('How listened, read and known fit together')!;
        expect(map.desc).toMatch(/Listened: you played a catch-up episode/);
        expect(map.desc).toMatch(/Read: you read a written brief/);
        expect(map.desc).toMatch(/Known: you tell the brief you already know every earlier story/);
        expect(names()).toContain('Mark all stories as already known');
        expect(names()).not.toContain('Mark all caught up');
    });

    it('is absent when story memory is off (none of the three concerns it)', () => {
        render({ newsletterAudioMode: 'on-demand', newsletterStoryMemory: false });
        expect(names()).not.toContain('How listened, read and known fit together');
    });
});

describe('When I am behind', () => {
    it('is offered only in smart daily, with the default selected', () => {
        render({ newsletterAudioMode: 'smart-daily' });
        const item = find('When I am behind')!;
        expect(item.dropdown!.options).toEqual([['wait', 'Wait for me'], ['replace', 'Replace my unheard episode automatically']]);
        expect(item.dropdown!.value).toBe('wait');
        expect(item.desc).toMatch(/never an episode that is playing, was played in the last day/);
        for (const mode of ['on-demand', 'daily']) {
            recorded.items.length = 0;
            render({ newsletterAudioMode: mode });
            expect(names()).not.toContain('When I am behind');
        }
    });

    it('shows a stored replace, shows wait for junk, and saves only a normalised value', () => {
        render({ newsletterAudioMode: 'smart-daily', newsletterCatchUpWhenBehind: 'replace' });
        expect(find('When I am behind')!.dropdown!.value).toBe('replace');
        recorded.items.length = 0;
        const { plugin } = render({ newsletterAudioMode: 'smart-daily', newsletterCatchUpWhenBehind: 'REPLACE-ish' });
        const item = find('When I am behind')!;
        expect(item.dropdown!.value).toBe('wait');
        item.dropdown!.change('replace');
        expect(plugin.settings.newsletterCatchUpWhenBehind).toBe('replace');
        item.dropdown!.change('anything else');
        expect(plugin.settings.newsletterCatchUpWhenBehind).toBe('wait');
        expect(plugin.saveSettings).toHaveBeenCalledTimes(2);
    });
});

describe('settings structure', () => {
    const at = (n: string): number => names().indexOf(n);

    it('Podcast voice sits above the Catch-up audio group, which starts at Audio delivery', () => {
        for (const mode of ['on-demand', 'smart-daily', 'daily']) {
            recorded.items.length = 0;
            render({ newsletterAudioMode: mode });
            expect(at('Podcast voice')).toBeGreaterThan(-1);
            expect(at('Podcast voice')).toBeLessThan(at('Catch-up audio'));
            expect(at('Catch-up audio') + 1).toBe(at('Audio delivery'));
        }
    });

    it('the Catch-up audio group is closed by a heading before the written-brief controls', () => {
        render({ newsletterAudioMode: 'on-demand' });
        const closing = recorded.items.find((i) => i.name === 'Written brief and story memory');
        expect(closing?.heading).toBe(true);
        expect(at('Written brief and story memory')).toBeGreaterThan(at('Longest episode (minutes)'));
        expect(at('Written brief and story memory')).toBeLessThan(at('Home region'));
        expect(at('Written brief and story memory')).toBeLessThan(at('Story memory'));
    });

    it('the audio podcast description no longer carries the cutoff jargon, the cutoff explains itself', () => {
        render({ newsletterAudioMode: 'on-demand' });
        expect(find('Audio podcast')!.desc).not.toMatch(/schedule trigger/);
        expect(find('Brief day cutoff')!.desc).toMatch(/does not schedule anything/);
    });

    it('long-option dropdowns take a full row on a phone', () => {
        render({ newsletterAudioMode: 'smart-daily' });
        expect(find('Audio delivery')!.cls).toBe('ai-organiser-wide-select');
        expect(find('When I am behind')!.cls).toBe('ai-organiser-wide-select');
        expect(find('Briefs you have read')!.cls).toBe('ai-organiser-wide-select');
    });

    it('the retention slider steps by one day, so the stored 30 shows as 30 and 1 to 6 days can be set', () => {
        const { plugin } = render({ newsletterRetentionDays: 30 });
        const sl = find('Keep newsletters for')!.slider!;
        expect([sl.min, sl.max, sl.step, sl.value]).toEqual([0, 365, 1, 30]);
        sl.change(3);
        expect(plugin.settings.newsletterRetentionDays).toBe(3);
    });
});
