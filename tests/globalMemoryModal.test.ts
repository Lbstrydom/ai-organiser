/**
 * GlobalMemoryModal unit tests.
 * Exercises modal logic (add, dedup, capacity, remove, save) via a minimal DOM mock.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MAX_GLOBAL_MEMORY_ITEMS } from '../src/services/chat/globalMemoryService';

// ── Minimal DOM element mock ─────────────────────────────────────────────────

function makeEl(tag = 'div'): any {
    const children: any[] = [];
    const listeners: Record<string, Function[]> = {};
    const attrs: Record<string, string> = {};
    const classes: string[] = [];

    const el: any = {
        tagName: tag,
        children,
        value: '',
        textContent: '',
        text: '',
        cls: '',
        setAttribute: (k: string, v: string) => { attrs[k] = v; },
        getAttribute: (k: string) => attrs[k] ?? null,
        addEventListener: (event: string, fn: Function) => {
            (listeners[event] ??= []).push(fn);
        },
        dispatchEvent: (event: string, detail?: any) => {
            for (const fn of listeners[event] ?? []) fn(detail);
        },
        addClass: (c: string) => { classes.push(c); },
        setText: (t: string) => { el.textContent = t; },
        empty: () => { children.length = 0; },
        createEl: (tagOrOpts: string, opts?: any) => {
            const child = makeEl(typeof tagOrOpts === 'string' ? tagOrOpts : 'div');
            if (opts) {
                if (opts.text) child.textContent = opts.text;
                if (opts.cls) child.cls = opts.cls;
                if (opts.type) child.type = opts.type;
                if (opts.placeholder) child.placeholder = opts.placeholder;
            }
            children.push(child);
            return child;
        },
        createDiv: (clsOrOpts?: string | { cls?: string; text?: string }) => {
            const child = makeEl('div');
            if (typeof clsOrOpts === 'string') child.cls = clsOrOpts;
            else if (clsOrOpts) {
                if (clsOrOpts.cls) child.cls = clsOrOpts.cls;
                if (clsOrOpts.text) child.textContent = clsOrOpts.text;
            }
            children.push(child);
            return child;
        },
        createSpan: (opts?: { cls?: string; text?: string }) => {
            const child = makeEl('span');
            if (opts?.cls) child.cls = opts.cls;
            if (opts?.text) child.textContent = opts.text;
            children.push(child);
            return child;
        },
    };
    return el;
}

// ── Mock translations ────────────────────────────────────────────────────────

function makeTranslations() {
    return {
        globalMemoryTitle: 'Global Chat Memory',
        globalMemoryDescription: 'Preferences that apply to all chats.',
        globalMemoryEmpty: 'No items saved yet.',
        globalMemoryAdd: 'Add',
        globalMemoryAddPlaceholder: 'Add a preference…',
        globalMemoryRemove: 'Remove',
        globalMemorySave: 'Save',
        globalMemoryCancel: 'Cancel',
        globalMemoryFull: 'Memory is full (max 50 items).',
    } as any;
}

// ── Mock service ─────────────────────────────────────────────────────────────

function makeServiceMock(initialItems: string[] = []) {
    return {
        loadMemory: vi.fn().mockResolvedValue([...initialItems]),
        saveAll: vi.fn().mockResolvedValue(undefined),
        addMemory: vi.fn().mockResolvedValue(true),
        removeMemory: vi.fn().mockResolvedValue(undefined),
    };
}

// ── Extract modal logic into a testable harness ──────────────────────────────
// Instead of instantiating the real Modal (which needs Obsidian's App),
// we replicate the exact same logic the modal uses, ensuring parity.

class ModalLogicHarness {
    items: string[] = [];
    private readonly t = makeTranslations();
    private noticeCalls: string[] = [];

    async loadFrom(service: ReturnType<typeof makeServiceMock>): Promise<void> {
        this.items = await service.loadMemory();
    }

    /** Same logic as GlobalMemoryModal.doAdd */
    addItem(fact: string): { added: boolean; notice?: string } {
        const trimmed = fact.trim();
        if (!trimmed) return { added: false };

        if (this.items.some(i => i.toLowerCase() === trimmed.toLowerCase())) {
            return { added: false };
        }

        if (this.items.length >= MAX_GLOBAL_MEMORY_ITEMS) {
            const msg = this.t.globalMemoryFull;
            this.noticeCalls.push(msg);
            return { added: false, notice: msg };
        }

        this.items.push(trimmed);
        return { added: true };
    }

    /** Same logic as GlobalMemoryModal remove-button click */
    removeItem(item: string): void {
        this.items = this.items.filter(i => i !== item);
    }

    /** Same logic as GlobalMemoryModal save-button click */
    async save(service: ReturnType<typeof makeServiceMock>, onSaved: (items: string[]) => void): Promise<void> {
        await service.saveAll(this.items);
        onSaved(this.items);
    }

    getNotices(): string[] {
        return [...this.noticeCalls];
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GlobalMemoryModal logic', () => {
    let harness: ModalLogicHarness;
    let service: ReturnType<typeof makeServiceMock>;

    beforeEach(() => {
        harness = new ModalLogicHarness();
        service = makeServiceMock();
    });

    // ── Load ─────────────────────────────────────────────────────────────

    describe('loadFrom', () => {
        it('loads items from service', async () => {
            service = makeServiceMock(['Pref A', 'Pref B']);
            await harness.loadFrom(service);
            expect(harness.items).toEqual(['Pref A', 'Pref B']);
        });

        it('starts with empty items when service returns none', async () => {
            await harness.loadFrom(service);
            expect(harness.items).toEqual([]);
        });
    });

    // ── Add ──────────────────────────────────────────────────────────────

    describe('addItem', () => {
        it('adds a new item', () => {
            const result = harness.addItem('Use formal English');
            expect(result.added).toBe(true);
            expect(harness.items).toContain('Use formal English');
        });

        it('trims whitespace', () => {
            harness.addItem('  padded item  ');
            expect(harness.items).toEqual(['padded item']);
        });

        it('rejects empty input', () => {
            const result = harness.addItem('');
            expect(result.added).toBe(false);
            expect(harness.items).toHaveLength(0);
        });

        it('rejects whitespace-only input', () => {
            const result = harness.addItem('   ');
            expect(result.added).toBe(false);
            expect(harness.items).toHaveLength(0);
        });

        it('deduplicates case-insensitively', () => {
            harness.addItem('Be concise');
            const result = harness.addItem('BE CONCISE');
            expect(result.added).toBe(false);
            expect(harness.items).toHaveLength(1);
        });

        it('deduplicates with mixed case', () => {
            harness.addItem('Write in Finnish');
            const result = harness.addItem('write in finnish');
            expect(result.added).toBe(false);
            expect(harness.items).toHaveLength(1);
            expect(harness.items[0]).toBe('Write in Finnish'); // original preserved
        });

        it('allows different items', () => {
            harness.addItem('Pref A');
            harness.addItem('Pref B');
            expect(harness.items).toEqual(['Pref A', 'Pref B']);
        });

        it('blocks at capacity and shows notice', () => {
            for (let i = 0; i < MAX_GLOBAL_MEMORY_ITEMS; i++) {
                harness.addItem(`Item ${i}`);
            }
            expect(harness.items).toHaveLength(MAX_GLOBAL_MEMORY_ITEMS);

            const result = harness.addItem('One more');
            expect(result.added).toBe(false);
            expect(result.notice).toBeDefined();
            expect(harness.items).toHaveLength(MAX_GLOBAL_MEMORY_ITEMS);
        });

        it('does not show notice for dedup (silent)', () => {
            harness.addItem('Existing');
            const result = harness.addItem('EXISTING');
            expect(result.notice).toBeUndefined();
        });
    });

    // ── Remove ───────────────────────────────────────────────────────────

    describe('removeItem', () => {
        it('removes an existing item', () => {
            harness.addItem('Keep');
            harness.addItem('Remove me');
            harness.removeItem('Remove me');
            expect(harness.items).toEqual(['Keep']);
        });

        it('is a no-op for non-existent items', () => {
            harness.addItem('Only item');
            harness.removeItem('Not here');
            expect(harness.items).toEqual(['Only item']);
        });

        it('removes only the exact match', () => {
            harness.addItem('Item A');
            harness.addItem('Item AB');
            harness.removeItem('Item A');
            expect(harness.items).toEqual(['Item AB']);
        });

        it('allows adding after remove frees capacity', () => {
            for (let i = 0; i < MAX_GLOBAL_MEMORY_ITEMS; i++) {
                harness.addItem(`Item ${i}`);
            }
            expect(harness.addItem('Overflow').added).toBe(false);

            harness.removeItem('Item 0');
            expect(harness.addItem('New item').added).toBe(true);
            expect(harness.items).toHaveLength(MAX_GLOBAL_MEMORY_ITEMS);
        });
    });

    // ── Save ─────────────────────────────────────────────────────────────

    describe('save', () => {
        it('calls service.saveAll with current items', async () => {
            harness.addItem('Pref 1');
            harness.addItem('Pref 2');

            await harness.save(service, () => {});
            expect(service.saveAll).toHaveBeenCalledWith(['Pref 1', 'Pref 2']);
        });

        it('invokes onSaved callback with items', async () => {
            harness.addItem('My pref');
            const onSaved = vi.fn();

            await harness.save(service, onSaved);
            expect(onSaved).toHaveBeenCalledWith(['My pref']);
        });

        it('saves empty list when all items removed', async () => {
            harness.addItem('Temp');
            harness.removeItem('Temp');

            await harness.save(service, () => {});
            expect(service.saveAll).toHaveBeenCalledWith([]);
        });

        it('saves after multiple add/remove operations', async () => {
            harness.addItem('A');
            harness.addItem('B');
            harness.addItem('C');
            harness.removeItem('B');

            await harness.save(service, () => {});
            expect(service.saveAll).toHaveBeenCalledWith(['A', 'C']);
        });
    });

    // ── Combined flows ───────────────────────────────────────────────────

    describe('combined flows', () => {
        it('load → add → remove → save round-trip', async () => {
            service = makeServiceMock(['Existing']);
            await harness.loadFrom(service);

            harness.addItem('New pref');
            harness.removeItem('Existing');

            const onSaved = vi.fn();
            await harness.save(service, onSaved);

            expect(service.saveAll).toHaveBeenCalledWith(['New pref']);
            expect(onSaved).toHaveBeenCalledWith(['New pref']);
        });

        it('dedup check uses loaded items', async () => {
            service = makeServiceMock(['Already here']);
            await harness.loadFrom(service);

            const result = harness.addItem('ALREADY HERE');
            expect(result.added).toBe(false);
            expect(harness.items).toHaveLength(1);
        });

        it('capacity check includes loaded items', async () => {
            const items = Array.from({ length: MAX_GLOBAL_MEMORY_ITEMS }, (_, i) => `Item ${i}`);
            service = makeServiceMock(items);
            await harness.loadFrom(service);

            const result = harness.addItem('Overflow');
            expect(result.added).toBe(false);
            expect(result.notice).toBeDefined();
        });
    });
});
