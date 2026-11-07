/**
 * Your lists (Google Tasks settings): on automatic lists, approving again is a repair, so it sits in a
 * collapsed "Repair approved lists" group and is still reachable; the Load my lists row has a name and
 * a line saying what it does. Locked scripts keep their Copy script row unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Row { name?: string; desc?: string; buttons: string[]; parent: string }
const rec = vi.hoisted(() => ({ rows: [] as Row[], summaries: [] as string[] }));

vi.mock('obsidian', async () => {
    const base = await import('./mocks/obsidian');
    const chain = (): unknown => new Proxy(function () { /* callable */ }, {
        get: (_t, prop) => (prop === 'then' || typeof prop === 'symbol' ? undefined : chain()),
        apply: () => chain(),
    });
    class RecordingSetting {
        private row: Row;
        controlEl = chain();
        settingEl = chain();
        constructor(el: { __kind?: string }) { this.row = { buttons: [], parent: el?.__kind ?? 'container' }; rec.rows.push(this.row); }
        setName(n: string) { this.row.name = n; return this; }
        setDesc(d: string) { this.row.desc = d; return this; }
        setHeading() { return this; }
        setClass() { return this; }
        addButton(cb: (b: unknown) => void) {
            const api: Record<string, unknown> = {};
            const self = (): unknown => api;
            Object.assign(api, { setButtonText: (txt: string) => { this.row.buttons.push(txt); return api; }, setCta: self, setWarning: self, setIcon: self, onClick: self, buttonEl: chain() });
            cb(api);
            return this;
        }
        addExtraButton(cb: (b: unknown) => void) { cb(chain()); return this; }
        addToggle(cb: (t: unknown) => void) { cb(chain()); return this; }
        addDropdown(cb: (t: unknown) => void) { cb(chain()); return this; }
        addText(cb: (t: unknown) => void) { cb(chain()); return this; }
    }
    return { ...base, Setting: RecordingSetting };
});

vi.mock('../src/commands/googleScriptCommands', () => ({ copyAutomaticScript: vi.fn(), copyScriptForDeployment: vi.fn() }));
vi.mock('../src/services/inboxSweep/tasksAutoLists', () => ({ approveConfiguredLists: vi.fn() }));
vi.mock('../src/services/inboxSweep/tasksExportService', () => ({ fetchTaskLists: vi.fn() }));

import { renderTasksListsEditor } from '../src/ui/settings/GoogleTasksListsEditor';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { getTranslations } from '../src/i18n';

const t = getTranslations('en');
const c = t.googleTasks;

/** An element that marks a created `details` so a Setting built in it knows its parent; records summary text. */
function element(kind = 'container'): unknown {
    const make = (k: string): unknown => new Proxy(function () { /* callable */ }, {
        get: (_t, prop) => {
            if (prop === '__kind') return k;
            if (prop === 'then' || typeof prop === 'symbol') return undefined;
            if (prop === 'createEl') return (tag: string, opts?: { text?: string }) => {
                if (tag === 'summary' && opts?.text) rec.summaries.push(opts.text);
                return make(tag === 'details' ? 'details' : k);
            };
            return make(k);
        },
        apply: () => make(k),
    });
    return make(kind);
}

function render(over: Record<string, unknown>): void {
    const plugin = {
        t,
        settings: { ...DEFAULT_SETTINGS, tasksListId: 'main', tasksListName: 'Inbox', tasksScriptUrl: 'https://script.google.com/macros/s/x/exec', ...over },
        saveSettings: vi.fn(async () => undefined),
        secretStorageService: { getSecret: vi.fn() },
    };
    renderTasksListsEditor(element() as never, plugin as never, vi.fn());
}

const rowWithButton = (label: string) => rec.rows.find((r) => r.buttons.includes(label));

beforeEach(() => { rec.rows.length = 0; rec.summaries.length = 0; });

describe('Your lists: Approve these lists', () => {
    it('on automatic lists it sits in a collapsed Repair approved lists group, still reachable', () => {
        render({ tasksAutoLists: true });
        expect(rec.summaries).toContain(c.repairListsTitle);
        const row = rowWithButton(c.approveLists);
        expect(row).toBeDefined();
        expect(row?.parent).toBe('details');
        expect(row?.desc).toBe(c.autoListsDesc);
    });

    it('its description says it is not needed after adding or removing a list', () => {
        expect(c.autoListsDesc).toMatch(/not needed after adding or removing a list/i);
    });

    it('on a locked script there is no repair group and Copy script stays a top-level row', () => {
        render({ tasksAutoLists: false });
        expect(rec.summaries).not.toContain(c.repairListsTitle);
        expect(rowWithButton(c.approveLists)?.parent).not.toBe('details');
        expect(rowWithButton(c.copyNewScript)?.parent).toBe('container');
    });
});

describe('Your lists: Load my lists', () => {
    it('is a named row with a line saying what it does', () => {
        for (const auto of [true, false]) {
            render({ tasksAutoLists: auto });
            const row = rowWithButton(c.loadMyLists);
            expect(row?.name).toBe(c.loadListsName);
            expect(row?.desc).toBe(c.loadListsDesc);
            rec.rows.length = 0;
        }
    });
});
