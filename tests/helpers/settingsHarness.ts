/**
 * Harness for tests that render the real settings sections: a `Setting` that
 * paints into the DOM (so order and grouping are observable) and records every
 * control's handlers, plus a real plugin instance whose save re-initialises the
 * LLM service.
 *
 * Use from a test file as (the factory itself must import the base mock):
 *   vi.mock('obsidian', async () => ({
 *       ...await import('./mocks/obsidian'),
 *       ...(await import('./helpers/settingsHarness')).settingsObsidianOverrides(),
 *       requestUrl: vi.fn(),
 *   }));
 */
import { vi } from 'vitest';
import { installObsidianDomShims } from './obsidianDom';

export interface RecordedControl {
    kind: string;
    value?: unknown;
    buttonText?: string;
    change?: (v: unknown) => unknown;
    click?: () => unknown;
}

export interface RecordedSetting {
    name: string;
    desc: string;
    el: HTMLElement;
    controls: RecordedControl[];
}

export const recordedSettings: RecordedSetting[] = [];

function makeControl(kind: string, setting: RecordedSetting): { proxy: unknown; el: HTMLElement } {
    const el = document.createElement(kind === 'button' ? 'button' : 'input') as HTMLInputElement & {
        show(): void; hide(): void;
    };
    el.dataset.control = kind;
    el.show = () => { el.hidden = false; };
    el.hide = () => { el.hidden = true; };
    const control: RecordedControl = { kind };
    setting.controls.push(control);
    const proxy: unknown = new Proxy({}, {
        get(_t, prop) {
            if (prop === 'inputEl' || prop === 'buttonEl' || prop === 'selectEl' || prop === 'toggleEl') return el;
            if (prop === 'getValue') return () => control.value;
            if (prop === 'onChange') return (fn: (v: unknown) => unknown) => { control.change = fn; return proxy; };
            if (prop === 'onClick') return (fn: () => unknown) => { control.click = fn; return proxy; };
            // Obsidian's toggles fire onChange from a later setValue; mimic it so a render that writes shows up.
            if (prop === 'setValue') return (v: unknown) => { control.value = v; control.change?.(v); return proxy; };
            if (prop === 'setButtonText') return (text: string) => { control.buttonText = text; el.textContent = text; return proxy; };
            if (prop === 'then') return undefined;
            return () => proxy;
        },
    });
    return { proxy, el };
}

export function settingsObsidianOverrides() {
    class RecordingSetting {
        settingEl: HTMLElement;
        nameEl: HTMLElement;
        descEl: HTMLElement;
        private readonly rec: RecordedSetting;
        constructor(containerEl: HTMLElement) {
            this.settingEl = containerEl.appendChild(document.createElement('div'));
            this.settingEl.className = 'setting-item';
            this.nameEl = this.settingEl.appendChild(document.createElement('div'));
            this.descEl = this.settingEl.appendChild(document.createElement('div'));
            this.rec = { name: '', desc: '', el: this.settingEl, controls: [] };
            recordedSettings.push(this.rec);
        }
        setName(name: string) { this.rec.name = name; this.settingEl.dataset.setting = name; this.nameEl.textContent = name; return this; }
        setDesc(desc: string) { this.rec.desc = desc; this.descEl.textContent = desc; return this; }
        setClass(c: string) { this.settingEl.classList.add(c); return this; }
        setHeading() { return this; }
        private add(kind: string, cb: (c: unknown) => unknown) {
            const { proxy, el } = makeControl(kind, this.rec);
            this.settingEl.appendChild(el);
            cb(proxy);
            return this;
        }
        addDropdown(cb: (c: unknown) => unknown) { return this.add('dropdown', cb); }
        addText(cb: (c: unknown) => unknown) { return this.add('text', cb); }
        addTextArea(cb: (c: unknown) => unknown) { return this.add('textarea', cb); }
        addToggle(cb: (c: unknown) => unknown) { return this.add('toggle', cb); }
        addSlider(cb: (c: unknown) => unknown) { return this.add('slider', cb); }
        addButton(cb: (c: unknown) => unknown) { return this.add('button', cb); }
        addExtraButton(cb: (c: unknown) => unknown) { return this.add('button', cb); }
    }

    class RecordingButton {
        constructor(containerEl: HTMLElement) {
            const rec: RecordedSetting = { name: '', desc: '', el: containerEl, controls: [] };
            const { proxy, el } = makeControl('button', rec);
            containerEl.appendChild(el);
            recordedSettings.push(rec);
            return proxy as RecordingButton;
        }
    }

    return { Setting: RecordingSetting, ButtonComponent: RecordingButton, setIcon: () => {} };
}

export function setupSettingsDom(): void {
    installObsidianDomShims();
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    proto.show ??= function (this: HTMLElement) { this.hidden = false; };
    proto.hide ??= function (this: HTMLElement) { this.hidden = true; };
    proto.appendText ??= function (this: HTMLElement, text: string) { this.append(text); };
}

/** A real plugin instance; saving settings re-initialises the LLM service (persistence skipped). */
export async function makeSettingsPlugin(
    deps: { Plugin: typeof import('../../src/main').default; defaults: object; t: unknown },
    overrides: Record<string, unknown>,
) {
    const { App } = await import('../mocks/obsidian');
    const plugin = new deps.Plugin(new App() as never, {
        id: 'test', version: '1.0.0', name: 'Test', author: 'Test', minAppVersion: '0.0.0', description: 'Test',
    } as never);
    plugin.settings = { ...structuredClone(deps.defaults), ...overrides } as typeof plugin.settings;
    plugin.t = deps.t as typeof plugin.t;
    (plugin as unknown as { secretStorageService: unknown }).secretStorageService = {
        isAvailable: () => false,
        getSecret: async () => null,
        hasSecret: async () => false,
        getProviderKey: async () => null,
        resolveApiKey: async (o: { plainTextFallback?: { primaryKey?: string } }) => o.plainTextFallback?.primaryKey ?? null,
    };
    const internals = plugin as unknown as { initializeLLMService(): Promise<void> };
    const pending: Array<Promise<void>> = [];
    plugin.saveSettings = vi.fn(() => {
        const p = internals.initializeLLMService();
        pending.push(p);
        return p;
    });
    await internals.initializeLLMService();
    return { plugin, settled: () => Promise.all(pending) };
}

/** Let async render follow-ups (SecretStorage lookups, capability checks) finish. */
export async function flushRender(): Promise<void> {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}
