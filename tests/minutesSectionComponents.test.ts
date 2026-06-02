/**
 * @vitest-environment happy-dom
 *
 * UI components for multi-segment minutes (TD: test hardening):
 *   - SectionAssignmentSelect (D3/D11): the per-row General | +New topic | <topics> select
 *   - ScopedFilePickerHeader (D9): the "Files in this note / All vault files" radio
 *
 * Polyfills the Obsidian HTMLElement helpers the components use (same approach
 * as editAccessories.test.ts), extended for `value` / `setText` / `removeClass`.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

beforeAll(() => {
    type ElOpts = { cls?: string; text?: string; attr?: Record<string, string>; type?: string; value?: string };
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const proto = HTMLElement.prototype as any;
    if (!proto.empty) proto.empty = function () { while (this.firstChild) this.firstChild.remove(); };
    if (!proto.addClass) proto.addClass = function (c: string) { this.classList.add(c); };
    if (!proto.removeClass) proto.removeClass = function (c: string) { this.classList.remove(c); };
    if (!proto.setText) proto.setText = function (t: string) { this.textContent = t; };
    if (!proto.createEl) proto.createEl = function (tag: string, opts: ElOpts = {}) {
        const el = document.createElement(tag);
        if (opts.cls) el.className = opts.cls;
        if (opts.text !== undefined) el.textContent = opts.text;
        if (opts.value !== undefined) (el as HTMLInputElement).value = opts.value;
        if (opts.attr) for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
        if (opts.type) (el as HTMLInputElement).type = opts.type;
        this.appendChild(el);
        return el;
    };
    if (!proto.createDiv) proto.createDiv = function (opts: ElOpts = {}) { return this.createEl('div', opts); };
    if (!proto.createSpan) proto.createSpan = function (opts: ElOpts = {}) { return this.createEl('span', opts); };
    /* eslint-enable @typescript-eslint/no-explicit-any */
});

import { renderSectionAssignmentSelect } from '../src/ui/components/SectionAssignmentSelect';
import { renderScopedFilePickerHeader } from '../src/ui/components/ScopedFilePickerHeader';
import { SectionRegistryController } from '../src/services/minutes/sectionRegistryController';

const LABELS = {
    generalOption: 'General', newTopicOption: '+ New topic…', topicNamePrompt: 'Topic name',
    topicNameTooLong: 'Topic name must be 40 characters or fewer', topicCreated: 'Created topic: {name}', topicPrefix: 'Topic: ',
};

function host() { return document.body.appendChild(document.createElement('div')); }

describe('SectionAssignmentSelect', () => {
    beforeEach(() => { document.body.innerHTML = ''; });

    it('renders General + each topic + the "+ New topic…" option', () => {
        const reg = new SectionRegistryController();
        reg.addTopic('VAT');
        const cleanups: Array<() => void> = [];
        const select = renderSectionAssignmentSelect({
            host: host(), sectionRegistry: reg, currentSectionId: 'general',
            ariaLabel: 'Section assignment for x.docx', labels: LABELS,
            onChange: vi.fn(), cleanups,
        });
        const texts = Array.from(select.options).map((o) => o.text);
        expect(texts[0]).toBe('General');
        expect(texts).toContain('Topic: VAT');
        expect(texts[texts.length - 1]).toBe('+ New topic…');
        expect(select.getAttribute('aria-label')).toBe('Section assignment for x.docx');
    });

    it('reflects currentSectionId as the selected option', () => {
        const reg = new SectionRegistryController();
        const t = reg.addTopic('Sales');
        const id = t.ok ? t.value.id : 'general';
        const select = renderSectionAssignmentSelect({
            host: host(), sectionRegistry: reg, currentSectionId: id,
            ariaLabel: 'a', labels: LABELS, onChange: vi.fn(), cleanups: [],
        });
        expect(select.value).toBe(id);
    });

    it('selecting an existing section fires onChange with its id', () => {
        const reg = new SectionRegistryController();
        const onChange = vi.fn();
        const select = renderSectionAssignmentSelect({
            host: host(), sectionRegistry: reg, currentSectionId: 'general',
            ariaLabel: 'a', labels: LABELS, onChange, cleanups: [],
        });
        select.value = 'general';
        // simulate picking a (no-op) value then a real change to general via event
        const t = reg.addTopic('VAT');
        renderSectionAssignmentSelect({  // re-render to include the topic
            host: select.parentElement as HTMLElement, sectionRegistry: reg,
            currentSectionId: 'general', ariaLabel: 'a', labels: LABELS, onChange, cleanups: [],
        });
        const sel2 = document.querySelector('select') as HTMLSelectElement;
        sel2.value = t.ok ? t.value.id : 'general';
        sel2.dispatchEvent(new Event('change'));
        expect(onChange).toHaveBeenCalledWith(t.ok ? t.value.id : 'general');
    });

    it('“+ New topic…” → entering a name creates the topic and fires onChange + onTopicCreated', () => {
        const reg = new SectionRegistryController();
        const onChange = vi.fn();
        const onTopicCreated = vi.fn();
        const h = host();
        const select = renderSectionAssignmentSelect({
            host: h, sectionRegistry: reg, currentSectionId: 'general',
            ariaLabel: 'a', labels: LABELS, onChange, onTopicCreated, cleanups: [],
        });
        select.value = '__new_topic__';
        select.dispatchEvent(new Event('change'));
        const input = document.querySelector('[data-testid="topic-name-input"]') as HTMLInputElement;
        expect(input).toBeTruthy();
        input.value = 'Performance';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        expect(reg.listTopics().some((t) => t.name === 'Performance')).toBe(true);
        const newId = reg.listTopics().find((t) => t.name === 'Performance')!.id;
        expect(onChange).toHaveBeenCalledWith(newId);
        expect(onTopicCreated).toHaveBeenCalledWith(newId);
    });

    it('cancelling the new-topic prompt reverts to last committed selection (no onChange, no topic)', () => {
        const reg = new SectionRegistryController();
        const onChange = vi.fn();
        const select = renderSectionAssignmentSelect({
            host: host(), sectionRegistry: reg, currentSectionId: 'general',
            ariaLabel: 'a', labels: LABELS, onChange, cleanups: [],
        });
        select.value = '__new_topic__';
        select.dispatchEvent(new Event('change'));
        const input = document.querySelector('[data-testid="topic-name-input"]') as HTMLInputElement;
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(reg.hasTopics()).toBe(false);
        expect(onChange).not.toHaveBeenCalled();
        expect(select.value).toBe('general');   // reverted
    });
});

describe('ScopedFilePickerHeader', () => {
    beforeEach(() => { document.body.innerHTML = ''; });

    it('renders both radios with counts; initial scope checks active-note', () => {
        const cleanups: Array<() => void> = [];
        renderScopedFilePickerHeader({
            container: host(), initialScope: 'active-note', activeNoteCount: 8, vaultCount: 1247,
            inNoteLabel: 'Files in this note', allVaultLabel: 'All vault files', onScopeChange: vi.fn(), cleanups,
        });
        const active = document.querySelector('[data-testid="scoped-picker-active-radio"]') as HTMLInputElement;
        const all = document.querySelector('[data-testid="scoped-picker-all-radio"]') as HTMLInputElement;
        expect(active.checked).toBe(true);
        expect(all.checked).toBe(false);
        expect(document.body.textContent).toContain('Files in this note (8)');
        expect(document.body.textContent).toContain('All vault files (1247)');
        expect(cleanups).toHaveLength(2);
    });

    it('toggling to all-vault fires onScopeChange("all-vault")', () => {
        const onScopeChange = vi.fn();
        renderScopedFilePickerHeader({
            container: host(), initialScope: 'active-note', activeNoteCount: 8, vaultCount: 1247,
            inNoteLabel: 'Files in this note', allVaultLabel: 'All vault files', onScopeChange, cleanups: [],
        });
        const all = document.querySelector('[data-testid="scoped-picker-all-radio"]') as HTMLInputElement;
        all.checked = true;
        all.dispatchEvent(new Event('change'));
        expect(onScopeChange).toHaveBeenCalledWith('all-vault');
    });

    it('initial scope all-vault checks the all radio (no-embeds fallback)', () => {
        renderScopedFilePickerHeader({
            container: host(), initialScope: 'all-vault', activeNoteCount: 0, vaultCount: 50,
            inNoteLabel: 'Files in this note', allVaultLabel: 'All vault files', onScopeChange: vi.fn(), cleanups: [],
        });
        const all = document.querySelector('[data-testid="scoped-picker-all-radio"]') as HTMLInputElement;
        expect(all.checked).toBe(true);
    });
});
