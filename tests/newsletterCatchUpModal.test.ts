// @vitest-environment happy-dom
/**
 * The catch-up window, rendered. Asserts the contracts a person (and assistive tech) depends
 * on: which buttons exist in which state, that spend is previewed before it happens, that
 * failures show readable guidance, never a code.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('obsidian', () => {
    const polyfill = (proto: Record<string, unknown>): void => {
        proto.empty = function (this: HTMLElement) { while (this.firstChild) this.removeChild(this.firstChild); };
        proto.addClass = function (this: HTMLElement, c: string) { this.classList.add(c); };
        proto.removeClass = function (this: HTMLElement, c: string) { this.classList.remove(c); };
        proto.setText = function (this: HTMLElement, t: string) { this.textContent = t; };
        proto.createEl = function (this: HTMLElement, tag: string, o?: { text?: string; cls?: string }) {
            const el = document.createElement(tag);
            if (o?.cls) el.className = o.cls;
            if (o?.text) el.textContent = o.text;
            this.appendChild(el);
            return el;
        };
        proto.createDiv = function (this: HTMLElement, o?: { text?: string; cls?: string }) { return (this as never as { createEl: (t: string, o?: unknown) => HTMLElement }).createEl('div', o); };
        proto.createSpan = function (this: HTMLElement, o?: { text?: string; cls?: string }) { return (this as never as { createEl: (t: string, o?: unknown) => HTMLElement }).createEl('span', o); };
    };
    polyfill(HTMLElement.prototype as never);

    class Modal {
        contentEl = document.createElement('div');
        modalEl = document.createElement('div');
        constructor(public app: unknown) {}
        open(): void { (this as unknown as { onOpen(): void }).onOpen(); }
        close(): void { (this as unknown as { onClose(): void }).onClose(); }
    }
    class Setting {
        constructor(public containerEl: HTMLElement) {}
        setName(n: string) { this.containerEl.createDiv({ text: n }); return this; }
        setDesc() { return this; }
        setHeading() { return this; }
        addDropdown(cb: (d: { addOption(v: string, l: string): unknown; setValue(v: string): unknown; onChange(f: (v: string) => void): unknown }) => void) {
            const sel = document.createElement('select');
            this.containerEl.appendChild(sel);
            const d = {
                addOption: (v: string, l: string) => { const o = document.createElement('option'); o.value = v; o.textContent = l; sel.appendChild(o); return d; },
                setValue: (v: string) => { sel.value = v; return d; },
                onChange: (f: (v: string) => void) => { sel.addEventListener('change', () => f(sel.value)); return d; },
            };
            cb(d);
            return this;
        }
    }
    return {
        Modal, Setting,
        Notice: class { constructor(public msg: string) {} },
        TFile: class { path = ''; },
        Platform: { isMobile: false },
        normalizePath: (p: string) => p,
        setIcon: () => undefined,
    };
});

const snapshotRef = vi.hoisted(() => ({ value: null as unknown }));
const opRef = vi.hoisted(() => ({ value: { kind: 'none' } as unknown }));

vi.mock('../src/services/newsletter/catchUp/catchUpSelection', () => ({
    buildCatchUpSnapshot: vi.fn(async () => snapshotRef.value),
}));

const runCatchUp = vi.hoisted(() => vi.fn());
const resumeCatchUp = vi.hoisted(() => vi.fn());
const discardOperation = vi.hoisted(() => vi.fn(async () => ({ ok: true, value: true })));
vi.mock('../src/services/newsletter/catchUp/catchUpService', () => ({
    classifyOperation: vi.fn(async () => opRef.value),
    runCatchUp, resumeCatchUp, discardOperation,
}));

vi.mock('../src/services/newsletter/catchUp/catchUpRuntime', () => ({
    createCatchUpPorts: () => ({}),
    previewCost: (_p: unknown, cap: number) => ({ ttsUsd: cap === 0 ? null : 0.04, spokenChars: 1000 }),
}));

const markEpisodeListened = vi.hoisted(() => vi.fn(async () => ({ ok: true, value: { acked: true, buckets: 0 } })));
vi.mock('../src/services/newsletter/catchUp/catchUpListen', () => ({ markEpisodeListened }));

vi.mock('../src/services/progress', () => ({
    withProgressResult: async (_o: unknown, op: (r: unknown) => Promise<unknown>) => {
        const reporter = { signal: new AbortController().signal, setPhase: vi.fn(), setCancellable: vi.fn() };
        return op(reporter);
    },
}));

import { NewsletterCatchUpModal } from '../src/ui/modals/NewsletterCatchUpModal';
import { availabilityOf } from '../src/services/newsletter/catchUp/catchUpModalState';
import { formatPendingSummary, datesBetween } from '../src/services/newsletter/catchUp/catchUpFormat';
import { getTranslations } from '../src/i18n';
import { DEFAULT_SETTINGS } from '../src/core/settings';

const t = getTranslations('en');

function plugin(over: Record<string, unknown> = {}) {
    return {
        app: { workspace: { openLinkText: vi.fn() }, setting: { open: vi.fn(), openTabById: vi.fn() } },
        manifest: { id: 'ai-organiser' },
        t,
        settings: { ...DEFAULT_SETTINGS, featureFlags: { newsletter: true }, newsletterAudioPodcast: true, newsletterAudioMode: 'on-demand', ...over },
        saveSettings: vi.fn(async () => undefined),
        refreshCatchUpStatus: vi.fn(),
    } as never;
}

const entry = (date: string, n = 2) => ({ date, kind: 'full', coverage: { kind: 'revision', rev: 1 }, text: 't', newsletters: n, titles: [] });
const plan = (dates: string[]) => ({
    entries: dates.map((d) => entry(d)), unresolved: [], noStoredDates: [], windowDates: dates,
    length: { capMinutes: dates.length >= 4 ? 20 : 15, wordBudget: 1950 }, from: dates[0], to: dates.at(-1), createdAt: 1, planHash: 'abcd1234',
});
const episode = (id: string, from: string, to: string) => ({
    id, from, to, coverage: Object.fromEntries(datesBetween(from, to).map((d) => [d, { kind: 'whole' }])), audio: `catchup-${id}.mp3`, fingerprint: 'ab', minutes: 10, sources: 3, notePath: `Catch-up/${id}.md`,
});
function snapshot(over: Record<string, unknown> = {}) {
    return {
        today: '2026-10-23', window: [], memoryOn: true, outputRoot: 'R',
        pending: { entries: [], unresolved: [], noStoredDates: [], coveredDates: [], openDates: [] },
        state: 'caught-up', plan: null, episodes: [], missingAudio: [], unheard: [], latestEpisode: null, oldestStoredDate: null, expiringDates: [], skipped: [], evidenceDegraded: false, autoPendingDays: 0, ...over,
    };
}

async function open(p = plugin()): Promise<{ modal: NewsletterCatchUpModal; root: HTMLElement }> {
    const modal = new NewsletterCatchUpModal(p);
    modal.open();
    await vi.waitFor(() => expect((modal as never as { contentEl: HTMLElement }).contentEl.querySelector('.ai-organiser-catchup-actions') || (modal as never as { contentEl: HTMLElement }).contentEl.querySelector('p')).toBeTruthy());
    await new Promise((r) => setTimeout(r, 0));
    return { modal, root: (modal as never as { contentEl: HTMLElement }).contentEl };
}

const buttons = (root: HTMLElement) => Array.from(root.querySelectorAll('button')).map((b) => b.textContent);
const click = (root: HTMLElement, text: string) => {
    const b = Array.from(root.querySelectorAll('button')).find((x) => x.textContent === text);
    if (!b) throw new Error(`no button "${text}" in [${buttons(root).join(', ')}]`);
    b.click();
};
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
    runCatchUp.mockReset();
    resumeCatchUp.mockReset();
    markEpisodeListened.mockClear();
    opRef.value = { kind: 'none' };
    snapshotRef.value = snapshot({ plan: plan(['2026-10-21', '2026-10-22', '2026-10-23']), state: 'pending' });
});

describe('helpers', () => {
    it('availability follows the master toggle and the mode', () => {
        expect(availabilityOf((plugin({ newsletterAudioPodcast: false }) as never as { settings: never }).settings)).toBe('audio-off');
        expect(availabilityOf((plugin({ newsletterAudioMode: 'daily' }) as never as { settings: never }).settings)).toBe('wrong-mode');
        expect(availabilityOf((plugin({ newsletterAudioMode: 'smart-daily' }) as never as { settings: never }).settings)).toBe('ok');
        expect(availabilityOf((plugin() as never as { settings: never }).settings)).toBe('ok');
    });

    it('formats singular and plural summaries', () => {
        expect(formatPendingSummary(t, 1, 1)).toBe('1 day · 1 newsletter');
        expect(formatPendingSummary(t, 3, 12)).toBe('3 days · 12 newsletters');
    });

    it('datesBetween is inclusive and crosses month ends', () => {
        expect(datesBetween('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
        expect(datesBetween('2026-10-23', '2026-10-23')).toEqual(['2026-10-23']);
    });
});

describe('the window', () => {
    it('is a labelled dialog', async () => {
        const { modal } = await open();
        const el = (modal as never as { modalEl: HTMLElement }).modalEl;
        expect(el.getAttribute('role')).toBe('dialog');
        expect(el.getAttribute('aria-label')).toBe('Newsletter audio');
    });

    it('pending: previews days, length and cost BEFORE any spend', async () => {
        const { root } = await open();
        expect(root.textContent).toContain('3 days · 6 newsletters pending');
        expect(root.textContent).toContain('Covers 2026-10-21 to 2026-10-23');
        expect(root.textContent).toContain('Length: about 15 min');
        expect(root.textContent).toContain('Voice cost: about $0.04');
        expect(buttons(root)).toContain('Generate');
        expect(runCatchUp).not.toHaveBeenCalled();
    });

    it('four or more days explain the longer limit', async () => {
        snapshotRef.value = snapshot({ plan: plan(['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']), state: 'pending' });
        const { root } = await open();
        expect(root.textContent).toContain('Length: about 20 min (4 or more days pending)');
    });

    it('lets the person lower the longest episode', async () => {
        const p = plugin();
        const { root } = await open(p);
        const select = root.querySelector('select') as HTMLSelectElement;
        select.value = '10';
        select.dispatchEvent(new Event('change'));
        await flush();
        expect((p as never as { settings: { newsletterCatchUpMaxMins: number } }).settings.newsletterCatchUpMaxMins).toBe(10);
    });

    it('Generate is focused first so the primary action is one keystroke away', async () => {
        const { root } = await open();
        const cta = root.querySelector('button.mod-cta');
        expect(cta?.textContent).toBe('Generate');
    });

    it('lists days with nothing stored neutrally and warns about expiring days', async () => {
        snapshotRef.value = snapshot({
            plan: plan(['2026-10-22']), state: 'pending', expiringDates: ['2026-10-22'],
            pending: { entries: [], unresolved: [], noStoredDates: ['2026-10-20', '2026-10-21'], coveredDates: [], openDates: [] },
        });
        const { root } = await open();
        expect(root.textContent).toContain('No newsletters stored for 2026-10-20, 2026-10-21.');
        expect(root.textContent).toContain('will be removed by your retention setting');
        expect(root.textContent).not.toMatch(/expired/i);
    });

    it('says which days were left out because their daily audio was heard, and can bring them back', async () => {
        snapshotRef.value = snapshot({
            plan: plan(['2026-10-23']), state: 'pending',
            skipped: [{ date: '2026-10-21', reason: 'heard-daily-audio' }, { date: '2026-10-22', reason: 'heard-daily-audio' }],
        });
        const { root } = await open();
        expect(root.textContent).toContain('2 earlier days are left out because you already listened to their daily audio: 2026-10-21, 2026-10-22.');
        click(root, 'Include them too');
        await flush();
        const { buildCatchUpSnapshot } = await import('../src/services/newsletter/catchUp/catchUpSelection');
        const last = (buildCatchUpSnapshot as unknown as { mock: { calls: Array<[{ forceDates?: string[] }]> } }).mock.calls.at(-1)![0];
        expect(last.forceDates).toEqual(['2026-10-21', '2026-10-22']);
    });

    it('a still-open day is said to be left out when story memory is off', async () => {
        snapshotRef.value = snapshot({ plan: plan(['2026-10-22']), state: 'pending', skipped: [{ date: '2026-10-23', reason: 'open-day' }] });
        const { root } = await open();
        expect(root.textContent).toContain('2026-10-23 is left out until the day closes, because story memory is off.');
    });

    it('the Covers line never spans days that are not included', async () => {
        snapshotRef.value = snapshot({ plan: plan(['2026-10-21', '2026-10-24']), state: 'pending' });
        const { root } = await open();
        expect(root.textContent).toContain('Covers 2026-10-21, 2026-10-24');
        expect(root.textContent).not.toContain('Covers 2026-10-21 to 2026-10-24');
    });

    it('caught up: any day in the window can be included again, not only the last episode range', async () => {
        snapshotRef.value = snapshot({ window: ['2026-10-21', '2026-10-22', '2026-10-23'], state: 'caught-up' });
        const { root } = await open();
        expect(buttons(root)).toContain('Include all 3 days again');
        click(root, 'Include all 3 days again');
        await flush();
        const { buildCatchUpSnapshot } = await import('../src/services/newsletter/catchUp/catchUpSelection');
        const last = (buildCatchUpSnapshot as unknown as { mock: { calls: Array<[{ forceDates?: string[] }]> } }).mock.calls.at(-1)![0];
        expect(last.forceDates).toEqual(['2026-10-21', '2026-10-22', '2026-10-23']);
    });

    it('smart daily: says it is waiting, how many days are pending and what ends the wait', async () => {
        snapshotRef.value = snapshot({ plan: plan(['2026-10-22', '2026-10-23']), state: 'pending', unheard: [episode('20261021-100000-aaaa', '2026-10-19', '2026-10-21')], autoPendingDays: 2 });
        const { root } = await open(plugin({ newsletterAudioMode: 'smart-daily' }));
        expect(root.textContent).toContain('Waiting: your last episode is unheard, 2 days pending.');
        expect(root.textContent).toContain('This ends when you listen to it, mark it listened, or replace it.');
        expect(buttons(root)).toEqual(expect.arrayContaining(['Open episode', 'Mark listened']));
        expect(root.textContent).not.toContain('Your last episode is not marked as listened');
        expect(root.querySelector('[role="status"].ai-organiser-catchup-waiting')).toBeTruthy();
    });

    it('smart daily with several unheard episodes names them all', async () => {
        snapshotRef.value = snapshot({
            plan: plan(['2026-10-23']), state: 'pending', autoPendingDays: 1,
            unheard: [episode('20261020-100000-aaaa', '2026-10-17', '2026-10-18'), episode('20261021-100000-bbbb', '2026-10-19', '2026-10-21')],
        });
        const { root } = await open(plugin({ newsletterAudioMode: 'smart-daily' }));
        expect(root.textContent).toContain('Waiting: 2 episodes are unheard, 1 day pending.');
        expect(root.textContent).toContain('This ends when you listen to each one, mark them listened, or replace them.');
        expect(root.textContent).toContain('2026-10-19 → 2026-10-21');
        expect(root.textContent).toContain('2026-10-17 → 2026-10-18');
        expect(root.querySelectorAll('.ai-organiser-catchup-waiting-episode')).toHaveLength(2);
    });

    it('on demand never claims to be waiting', async () => {
        snapshotRef.value = snapshot({ plan: plan(['2026-10-23']), state: 'pending', unheard: [episode('e1', '2026-10-20', '2026-10-22')], autoPendingDays: 1 });
        const { root } = await open(plugin({ newsletterAudioMode: 'on-demand' }));
        expect(root.textContent).not.toContain('Waiting:');
        expect(root.textContent).toContain('Your last episode is not marked as listened');
    });

    it('an unheard episode shows a warning ABOVE Generate, with Mark listened', async () => {
        snapshotRef.value = snapshot({ plan: plan(['2026-10-23']), state: 'pending', unheard: [episode('e1', '2026-10-20', '2026-10-22')] });
        const { root } = await open();
        const html = root.innerHTML;
        expect(html.indexOf('Mark listened')).toBeGreaterThan(-1);
        expect(html.indexOf('Mark listened')).toBeLessThan(html.indexOf('>Generate<'));
        expect(root.textContent).toContain('Your last episode is not marked as listened');
        click(root, 'Mark listened');
        await flush();
        expect(markEpisodeListened).toHaveBeenCalledTimes(1);
    });
});

describe('nothing to generate', () => {
    it('caught up: no Generate, but replay and include again stay reachable', async () => {
        snapshotRef.value = snapshot({ latestEpisode: episode('e1', '2026-10-20', '2026-10-22') });
        const { root } = await open();
        expect(root.textContent).toContain('You are caught up through 2026-10-23.');
        expect(buttons(root)).not.toContain('Generate');
        expect(buttons(root)).toEqual(expect.arrayContaining(['Open latest episode', 'Include again…']));
    });

    it('Include again re-reads with the latest episode\'s dates and the window can then generate', async () => {
        const { buildCatchUpSnapshot } = await import('../src/services/newsletter/catchUp/catchUpSelection');
        snapshotRef.value = snapshot({ latestEpisode: episode('e1', '2026-10-21', '2026-10-22') });
        const { root } = await open();
        snapshotRef.value = snapshot({ plan: plan(['2026-10-21', '2026-10-22']), state: 'pending' });
        click(root, 'Include again…');
        await flush(); await flush();
        const lastCall = (buildCatchUpSnapshot as unknown as { mock: { calls: Array<[{ forceDates?: string[] }]> } }).mock.calls.at(-1)![0];
        expect(lastCall.forceDates).toEqual(['2026-10-21', '2026-10-22']);
        expect(buttons(root)).toContain('Generate');
    });

    it('a provable gap says older material is unavailable and never "caught up"', async () => {
        snapshotRef.value = snapshot({ state: 'gap', latestEpisode: episode('e1', '2026-10-05', '2026-10-10') });
        const { root } = await open();
        expect(root.textContent).toContain('Older material is unavailable');
        expect(root.textContent).not.toContain('caught up through');
    });

    it('updates that could not be itemised never read as caught up', async () => {
        snapshotRef.value = snapshot({
            state: 'unresolved-only',
            pending: { entries: [], unresolved: [{ date: '2026-10-22', reason: 'unitemisable' }], noStoredDates: [], coveredDates: [], openDates: [] },
        });
        const { root } = await open();
        expect(root.textContent).toContain('could not be checked');
        expect(root.textContent).not.toContain('You are caught up');
        expect(buttons(root)).not.toContain('Generate');
    });
});

describe('unavailable', () => {
    it('daily mode explains and offers settings', async () => {
        const { root } = await open(plugin({ newsletterAudioMode: 'daily' }));
        expect(root.textContent).toContain('Audio is set to daily');
        expect(buttons(root)).toEqual(expect.arrayContaining(['Open settings', 'Close']));
        expect(buttons(root)).not.toContain('Generate');
    });

    it('audio off explains how to turn it on', async () => {
        const { root } = await open(plugin({ newsletterAudioPodcast: false }));
        expect(root.textContent).toContain('turned off');
        expect(buttons(root)).not.toContain('Generate');
    });
});

describe('an unfinished operation', () => {
    const record = (phase: string) => ({
        version: 1, opId: 'op', phase, script: 's', scriptIdentity: 'i', outputRoot: 'R', capMinutes: 15, createdAt: 1,
        frozen: { entries: [], from: '2026-10-21', to: '2026-10-22', sources: 4, titles: [] },
    });

    it('scripted: Resume, Start over and Discard — and no Generate that would replace it', async () => {
        opRef.value = { kind: 'scripted', record: record('scripted') };
        const { root } = await open();
        expect(root.textContent).toContain('An earlier episode was left unfinished');
        expect(buttons(root)).toEqual(['Resume', 'Start over', 'Discard']);
    });

    it('audio ready: Finish saving', async () => {
        opRef.value = { kind: 'audio-ready', record: record('audio-ready') };
        const { root } = await open();
        expect(buttons(root)).toContain('Finish saving');
        expect(root.textContent).toContain('The audio is ready');
    });

    it('Resume runs the stored operation, not a new one', async () => {
        opRef.value = { kind: 'scripted', record: record('scripted') };
        resumeCatchUp.mockResolvedValue({ ok: true, value: { opId: 'op', notePath: 'N.md', audioPath: 'A.mp3', minutes: 12, from: '2026-10-21', to: '2026-10-22', days: 2, sources: 4, created: true } });
        const { root } = await open();
        click(root, 'Resume');
        await vi.waitFor(() => expect(resumeCatchUp).toHaveBeenCalledTimes(1));
        expect(runCatchUp).not.toHaveBeenCalled();
    });

    it('Discard asks first, because the written script was paid for', async () => {
        discardOperation.mockClear();
        opRef.value = { kind: 'scripted', record: record('scripted') };
        const { root } = await open();
        click(root, 'Discard');
        expect(discardOperation).not.toHaveBeenCalled();
        expect(root.textContent).toContain('Discard this unfinished episode?');
        expect(buttons(root)).toEqual(['Keep it', 'Discard']);
    });

    it('"Keep it" returns to the choices and discards nothing', async () => {
        discardOperation.mockClear();
        opRef.value = { kind: 'scripted', record: record('scripted') };
        const { root } = await open();
        click(root, 'Discard');
        click(root, 'Keep it');
        expect(discardOperation).not.toHaveBeenCalled();
        expect(buttons(root)).toEqual(['Resume', 'Start over', 'Discard']);
    });

    it('confirming Discard removes it and says so', async () => {
        opRef.value = { kind: 'scripted', record: record('scripted') };
        const { root } = await open();
        opRef.value = { kind: 'none' };
        click(root, 'Discard');
        click(root, 'Discard');
        await vi.waitFor(() => expect(discardOperation).toHaveBeenCalled());
        await flush(); await flush();
        expect(root.textContent).toContain('The unfinished episode was discarded.');
    });

    // Persona test N6: Start over on an episode made through "Include again" ended at "caught up".
    it('Start over remakes the SAME days even when they are no longer pending', async () => {
        const { buildCatchUpSnapshot } = await import('../src/services/newsletter/catchUp/catchUpSelection');
        opRef.value = { kind: 'scripted', record: record('scripted') };
        const { root } = await open();
        opRef.value = { kind: 'none' };
        click(root, 'Start over');
        await vi.waitFor(() => expect(discardOperation).toHaveBeenCalled());
        await flush(); await flush();
        const lastCall = (buildCatchUpSnapshot as unknown as { mock: { calls: Array<[{ forceDates?: string[] }]> } }).mock.calls.at(-1)![0];
        expect(lastCall.forceDates).toEqual(['2026-10-21', '2026-10-22']);
    });

    it('a plain Discard does not keep the days for another run', async () => {
        const { buildCatchUpSnapshot } = await import('../src/services/newsletter/catchUp/catchUpSelection');
        opRef.value = { kind: 'scripted', record: record('scripted') };
        const { root } = await open();
        opRef.value = { kind: 'none' };
        click(root, 'Discard');
        click(root, 'Discard');
        await flush(); await flush();
        const last = (buildCatchUpSnapshot as unknown as { mock: { calls: Array<[{ forceDates?: string[] }]> } }).mock.calls.at(-1)![0];
        expect(last.forceDates).toBeUndefined();
    });
});

describe('generating', () => {
    const done = { ok: true, value: { opId: 'op', notePath: 'Catch-up/N.md', audioPath: 'A.mp3', minutes: 14.2, from: '2026-10-21', to: '2026-10-23', days: 3, sources: 6, created: true } };

    it('passes the previewed hash and shows the result with a way to open the note', async () => {
        runCatchUp.mockResolvedValue(done);
        const { root } = await open();
        click(root, 'Generate');
        await vi.waitFor(() => expect(runCatchUp).toHaveBeenCalledTimes(1));
        expect(runCatchUp.mock.calls[0][1]).toMatchObject({ previewHash: 'abcd1234', interactive: true });
        await vi.waitFor(() => expect(root.textContent).toContain('Episode ready — about 14 min covering 3 days · 6 newsletters.'));
        expect(buttons(root)).toContain('Open episode note');
    });

    it('a sub-minute episode never reads "about 0 min"', async () => {
        runCatchUp.mockResolvedValue({ ...done, value: { ...done.value, minutes: 0 } });
        const { root } = await open();
        click(root, 'Generate');
        await vi.waitFor(() => expect(root.textContent).toContain('Episode ready — under a minute covering'));
        expect(root.textContent).not.toContain('about 0 min');
    });

    it('shows the progress region as a polite live region while running', async () => {
        let release: (v: unknown) => void = () => undefined;
        runCatchUp.mockImplementation(() => new Promise((r) => { release = r; }));
        const { root } = await open();
        click(root, 'Generate');
        await vi.waitFor(() => expect(root.querySelector('.ai-organiser-catchup-progress')).toBeTruthy());
        expect(root.querySelector('.ai-organiser-catchup-progress')?.getAttribute('aria-live')).toBe('polite');
        release(done);
        await flush();
    });

    it('a failure shows readable guidance, never the raw code', async () => {
        runCatchUp.mockResolvedValue({ ok: false, error: 'catchup-tts-failed' });
        const { root } = await open();
        click(root, 'Generate');
        await vi.waitFor(() => expect(root.textContent).toContain('The audio could not be made.'));
        expect(root.textContent).not.toContain('catchup-tts-failed');
    });

    it('a changed world asks for a fresh look instead of generating', async () => {
        runCatchUp.mockResolvedValue({ ok: false, error: 'catchup-changed' });
        const { root } = await open();
        click(root, 'Generate');
        await vi.waitFor(() => expect(root.textContent).toContain('changed while this window was open'));
    });

    it('cancelling before a script exists says nothing was saved', async () => {
        runCatchUp.mockResolvedValue({ ok: false, error: 'cancelled' });
        const { root } = await open();
        click(root, 'Generate');
        await vi.waitFor(() => expect(root.textContent).toContain('Nothing was saved, and another attempt starts over.'));
    });

    it('cancelling after a script exists says the script is kept', async () => {
        runCatchUp.mockImplementation(async () => { opRef.value = { kind: 'scripted', record: { version: 1, opId: 'op', phase: 'scripted', script: 's', scriptIdentity: 'i', createdAt: 1, frozen: { entries: [], from: '2026-10-21', to: '2026-10-23', sources: 1, titles: [] } } }; return { ok: false, error: 'cancelled' }; });
        const { root } = await open();
        click(root, 'Generate');
        await vi.waitFor(() => expect(root.textContent).toContain('Your script is kept, so you can resume.'));
    });

    it('an over-limit script asks before any audio is made, with the estimate', async () => {
        let answer: string | undefined;
        runCatchUp.mockImplementation(async (_ports: unknown, o: { confirmOverrun: (i: unknown) => Promise<string> }) => {
            answer = await o.confirmOverrun({ estimatedMinutes: 24.5, capMinutes: 15 });
            return done;
        });
        const { root } = await open();
        click(root, 'Generate');
        await vi.waitFor(() => expect(root.textContent).toContain('The script is longer than your limit'));
        expect(root.textContent).toContain('It is about 24.5 min, and your limit is 15 min.');
        expect(buttons(root)).toEqual(['Shorten again', 'Continue anyway', 'Cancel']);
        click(root, 'Continue anyway');
        await vi.waitFor(() => expect(answer).toBe('continue'));
    });

    it('closing the window while a question is open answers it with cancel', async () => {
        let answer: string | undefined;
        runCatchUp.mockImplementation(async (_ports: unknown, o: { confirmOverrun: (i: unknown) => Promise<string> }) => {
            answer = await o.confirmOverrun({ estimatedMinutes: 24, capMinutes: 15 });
            return { ok: false, error: 'cancelled' };
        });
        const { modal, root } = await open();
        click(root, 'Generate');
        await vi.waitFor(() => expect(root.textContent).toContain('longer than your limit'));
        modal.close();
        await vi.waitFor(() => expect(answer).toBe('cancel'));
    });
});

describe('failures and lifecycle', () => {
    const record = {
        version: 1, opId: 'op', phase: 'scripted', script: 's', scriptIdentity: 'i', outputRoot: 'R', capMinutes: 15, createdAt: 1,
        frozen: { entries: [], from: '2026-10-21', to: '2026-10-22', sources: 4, titles: [] },
    };

    it('a failed Discard says so and keeps the unfinished operation on screen', async () => {
        opRef.value = { kind: 'scripted', record };
        discardOperation.mockResolvedValueOnce({ ok: false, error: 'EBUSY' } as never);
        const { root } = await open();
        click(root, 'Discard');
        click(root, 'Discard'); // confirm
        await vi.waitFor(() => expect(root.textContent).toContain('could not be discarded'));
        expect(root.textContent).not.toContain('The unfinished episode was discarded.');
        expect(root.textContent).not.toContain('EBUSY');
        expect(buttons(root)).toContain('Resume');
    });

    it('a slow early read cannot overwrite a newer one', async () => {
        const { buildCatchUpSnapshot } = await import('../src/services/newsletter/catchUp/catchUpSelection');
        const mocked = buildCatchUpSnapshot as unknown as ReturnType<typeof vi.fn>;
        let releaseOld: (v: unknown) => void = () => undefined;
        const old = snapshot({ latestEpisode: episode('old', '2026-10-01', '2026-10-02') });
        mocked.mockImplementationOnce(() => new Promise((r) => { releaseOld = r; }));
        const modal = new NewsletterCatchUpModal(plugin());
        modal.open(); // read #1 is now stuck
        const root = (modal as never as { contentEl: HTMLElement }).contentEl;
        snapshotRef.value = snapshot({ plan: plan(['2026-10-22']), state: 'pending' });
        (modal as never as { refresh(): Promise<void> }).refresh(); // read #2 wins
        await vi.waitFor(() => expect(buttons(root)).toContain('Generate'));
        releaseOld(old); // read #1 finally lands
        await flush(); await flush();
        expect(buttons(root)).toContain('Generate');
        expect(root.textContent).not.toContain('You are caught up');
    });

    it('a slow early read that FAILS cannot replace a newer good view with an error', async () => {
        const { buildCatchUpSnapshot } = await import('../src/services/newsletter/catchUp/catchUpSelection');
        const mocked = buildCatchUpSnapshot as unknown as ReturnType<typeof vi.fn>;
        let failOld: (e: unknown) => void = () => undefined;
        mocked.mockImplementationOnce(() => new Promise((_, rej) => { failOld = rej; }));
        const modal = new NewsletterCatchUpModal(plugin());
        modal.open(); // read #1 is stuck
        const root = (modal as never as { contentEl: HTMLElement }).contentEl;
        snapshotRef.value = snapshot({ plan: plan(['2026-10-22']), state: 'pending' });
        (modal as never as { refresh(): Promise<void> }).refresh(); // read #2 wins
        await vi.waitFor(() => expect(buttons(root)).toContain('Generate'));
        failOld(new Error('late failure')); // read #1 rejects afterwards
        await flush(); await flush();
        expect(buttons(root)).toContain('Generate');
        expect(root.textContent).not.toContain('could not');
    });

    it('a question raised after the window closed is answered at once', async () => {
        const { modal } = await open();
        modal.close();
        const answer = await (modal as never as { renderOverrun(i: unknown): Promise<string> }).renderOverrun({ estimatedMinutes: 20, capMinutes: 15 });
        expect(answer).toBe('cancel');
    });
});
