/**
 * The Google Tasks export settings section holds settings, not actions: Set up Google Tasks shows
 * only while setup is not Ready (the status row's Review setup is the way in once Ready), there is
 * no send button and no "List: ..." line. A failed or held send says where to send again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SetupState } from '../src/core/setupState';

const rec = vi.hoisted(() => ({
    buttons: [] as string[],
    texts: [] as string[],
    statusRows: 0,
    listsEditor: 0,
    state: 'not-set-up' as string,
}));

vi.mock('obsidian', async () => {
    const base = await import('./mocks/obsidian');
    const chain = (): unknown => new Proxy(function () { /* callable */ }, {
        get: (_t, prop) => (prop === 'then' || typeof prop === 'symbol' ? undefined : chain()),
        apply: () => chain(),
    });
    class RecordingSetting {
        settingEl = chain();
        constructor(_el: unknown) { /* recorded through buttons */ }
        setName() { return this; }
        setDesc() { return this; }
        setHeading() { return this; }
        setClass() { return this; }
        addButton(cb: (b: unknown) => void) {
            const api: Record<string, unknown> = {};
            const self = (): unknown => api;
            Object.assign(api, {
                setButtonText: (txt: string) => { rec.buttons.push(txt); return api; },
                setCta: self, setWarning: self, setIcon: self, setDisabled: self, setTooltip: self,
                onClick: self, buttonEl: chain(),
            });
            cb(api);
            return this;
        }
        addText(cb: (t: unknown) => void) { cb(chain()); return this; }
        addToggle(cb: (t: unknown) => void) { cb(chain()); return this; }
        addDropdown(cb: (t: unknown) => void) { cb(chain()); return this; }
    }
    return { ...base, Setting: RecordingSetting };
});

vi.mock('../src/core/setupState', async (orig) => ({
    ...(await orig<typeof import('../src/core/setupState')>()),
    evaluateSetup: () => ({ state: rec.state }),
}));
vi.mock('../src/ui/setup/SetupStatusRow', () => ({ renderSetupStatusRow: () => { rec.statusRows++; } }));
vi.mock('../src/ui/settings/GoogleTasksListsEditor', () => ({ renderTasksListsEditor: () => { rec.listsEditor++; } }));
vi.mock('../src/commands/inboxSweepCommands', () => ({ openTasksSetup: vi.fn(), tasksConfigKey: () => 'key' }));

import { GoogleTasksSettingsSection } from '../src/ui/settings/GoogleTasksSettingsSection';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { getTranslations } from '../src/i18n';

const t = getTranslations('en');

/** A container that records the text of every element created in it and accepts any other call. */
function recordingElement(): unknown {
    const make = (): unknown => new Proxy(function () { /* callable */ }, {
        get: (_t, prop) => {
            if (prop === 'then' || typeof prop === 'symbol') return undefined;
            if (prop === 'createDiv' || prop === 'createEl' || prop === 'createSpan') {
                return (...args: unknown[]) => {
                    const opts = args.find((a) => a && typeof a === 'object') as { text?: string } | undefined;
                    if (opts?.text) rec.texts.push(opts.text);
                    return make();
                };
            }
            return make();
        },
        apply: () => make(),
    });
    return make();
}

function render(state: SetupState, over: Record<string, unknown> = {}): void {
    rec.state = state;
    const plugin = { t, settings: { ...DEFAULT_SETTINGS, tasksListName: 'Inbox', ...over } };
    new GoogleTasksSettingsSection(plugin as never, recordingElement() as never, { display: vi.fn() } as never).display();
}

beforeEach(() => {
    rec.buttons.length = 0;
    rec.texts.length = 0;
    rec.statusRows = 0;
    rec.listsEditor = 0;
});

describe('Google Tasks export settings section', () => {
    it('shows Set up Google Tasks while setup is not set up', () => {
        render('not-set-up');
        expect(rec.statusRows).toBe(1);
        expect(rec.buttons).toEqual([t.googleTasks.setupButton]);
    });

    it('shows Set up Google Tasks while setup needs attention', () => {
        render('needs-attention');
        expect(rec.buttons).toEqual([t.googleTasks.setupButton]);
    });

    it('hides Set up Google Tasks once Ready: the status row is the one way back in', () => {
        render('ready');
        expect(rec.statusRows).toBe(1);
        expect(rec.buttons).not.toContain(t.googleTasks.setupButton);
        expect(rec.listsEditor).toBe(1);
    });

    it('has no send button in either state', () => {
        for (const state of ['not-set-up', 'ready'] as const) {
            render(state);
            expect(rec.buttons.some((b) => /send/i.test(b))).toBe(false);
        }
    });

    it('does not repeat the main list as a "List: ..." line', () => {
        render('ready');
        expect(rec.texts.some((x) => x.startsWith(`${t.googleTasks.listName}:`))).toBe(false);
    });
});

describe('Where to send again', () => {
    it('the hint names the picker route and the command name', () => {
        const hint = t.inboxSweep.sendAgainHint;
        expect(hint).toContain('command picker');
        expect(hint).toContain('Refine');
        expect(hint).toContain(t.commands.sendTasksToGoogle);
    });

    it('withSendAgain appends the hint to a send notice', async () => {
        const actual = await vi.importActual<typeof import('../src/commands/inboxSweepCommands')>('../src/commands/inboxSweepCommands');
        expect(actual.withSendAgain(t, 'It failed.')).toBe(`It failed. ${t.inboxSweep.sendAgainHint}`);
    });
});
