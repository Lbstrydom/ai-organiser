/**
 * The action registry (docs/plans/navigation-discoverability.md, Phase 2).
 *
 * - Classification harness: every command any registrar can register, with every feature on,
 *   on desktop and on mobile, is either an action or a declared hidden command. Nothing can
 *   become palette-only again by accident.
 * - One label: each registered command's palette name is its registry label.
 * - Phase 2 oracle: the picker tree is the Phase 1 tree plus exactly the enumerated additions.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { Platform } from 'obsidian';
import { ACTIONS, ACTION_BY_ID, HIDDEN_COMMANDS, PICKER_GROUPS, actionName } from '../src/core/actionRegistry';
import { REGISTER_BY_FEATURE } from '../src/commands/index';
import { registerProcessCommands } from '../src/commands/processCommands';
import { buildCommandCategories } from '../src/ui/modals/CommandPickerModal';
import { FEATURE_REGISTRY } from '../src/core/features';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { en } from '../src/i18n/en';
import { snapshotPickerTree, type LeafRow } from './helpers/pickerTreeSnapshot';

type Registrar = (plugin: never) => void;

/** A stand-in for anything the registrars touch besides addCommand: every property and call is a no-op. */
function inert(): unknown {
    const fn = function () { return proxy; };
    const proxy: unknown = new Proxy(fn, {
        get: (_t, key) => (key === Symbol.toPrimitive ? () => '' : key === 'then' ? undefined : proxy),
        apply: () => proxy,
        construct: () => proxy as object,
    });
    return proxy;
}

/** Run registrars against a fake plugin and record every addCommand id and name. */
function collect(registrars: readonly Registrar[]): Map<string, string> {
    const commands = new Map<string, string>();
    const settings = { ...DEFAULT_SETTINGS, featureFlags: Object.fromEntries(FEATURE_REGISTRY.map((f) => [f.id, true])) };
    const plugin = new Proxy({
        t: en,
        settings,
        addCommand: (c: { id: string; name: string }) => { commands.set(c.id, c.name); return c; },
    } as Record<string | symbol, unknown>, {
        get: (target, key) => (key in target ? target[key] : inert()),
    });
    for (const register of registrars) register(plugin as never);
    return commands;
}

const ALL_REGISTRARS: Registrar[] = [
    ...Object.values(REGISTER_BY_FEATURE).flat() as Registrar[],
    registerProcessCommands as Registrar,
];

const setPlatform = (mobile: boolean): void => {
    Object.assign(Platform, { isMobile: mobile, isMobileApp: mobile, isDesktop: !mobile, isDesktopApp: !mobile });
};
afterEach(() => setPlatform(false));

function registeredEverywhere(): Map<string, string> {
    setPlatform(false);
    const desktop = collect(ALL_REGISTRARS);
    setPlatform(true);
    const mobile = collect(ALL_REGISTRARS);
    setPlatform(false);
    return new Map([...mobile, ...desktop]);
}

/** Ids that are neither an action nor a declared hidden command. */
function unclassified(ids: Iterable<string>): string[] {
    return [...ids].filter((id) => !ACTION_BY_ID.has(id) && !(id in HIDDEN_COMMANDS)).sort();
}

describe('classification: every registered command is an action or declared hidden', () => {
    const registered = registeredEverywhere();
    // open-picker is registered by main.ts itself, not by a feature registrar.
    registered.set('open-picker', en.commands.openCommandPicker);

    it('finds the commands (positive control: the harness really collects)', () => {
        expect(registered.size).toBeGreaterThan(90);
        expect(registered.has('resume-offload')).toBe(true); // desktop-only registration
    });

    it('leaves nothing unclassified', () => {
        expect(unclassified(registered.keys())).toEqual([]);
    });

    it('every action and every hidden id is really registered (no stale entries)', () => {
        for (const def of ACTIONS) expect(registered.has(def.id), def.id).toBe(true);
        for (const id of Object.keys(HIDDEN_COMMANDS)) expect(registered.has(id), id).toBe(true);
    });

    it('no id is both an action and hidden, and no action is listed twice', () => {
        for (const id of Object.keys(HIDDEN_COMMANDS)) expect(ACTION_BY_ID.has(id), id).toBe(false);
        expect(new Set(ACTIONS.map((a) => a.id)).size).toBe(ACTIONS.length);
    });

    it('each action command is named by its registry label in Ctrl+P', () => {
        for (const def of ACTIONS) expect(registered.get(def.id), def.id).toBe(actionName(en, def.id));
    });

    it('catches an unclassified command under a default-off feature', () => {
        const offFeature = FEATURE_REGISTRY.find((f) => !f.defaultOn && !f.core)!;
        expect(offFeature).toBeDefined();
        const extra: Registrar = (p) => { (p as { addCommand: (c: unknown) => void }).addCommand({ id: 'sneaky-off-feature', name: 'Sneaky' }); };
        expect(unclassified(collect([extra]).keys())).toEqual(['sneaky-off-feature']);
    });

    it('catches an unclassified command inside a desktop-only branch', () => {
        const desktopOnly: Registrar = (p) => {
            if (!Platform.isDesktopApp) return;
            (p as { addCommand: (c: unknown) => void }).addCommand({ id: 'sneaky-desktop', name: 'Sneaky' });
        };
        setPlatform(true);
        expect(collect([desktopOnly]).size).toBe(0);
        setPlatform(false);
        expect(unclassified(collect([desktopOnly]).keys())).toEqual(['sneaky-desktop']);
    });
});

describe('registry shape', () => {
    it('every label and description resolves to a non-empty English string', () => {
        const desc = en.modals.commandPicker.descriptions;
        for (const def of ACTIONS) {
            expect(typeof en.commands[def.labelKey], def.id).toBe('string');
            expect(actionName(en, def.id).length, def.id).toBeGreaterThan(0);
            expect((desc[def.descKey] || def.descFallback).length, def.id).toBeGreaterThan(0);
        }
    });

    it('every grouped action names a declared group in its own category', () => {
        for (const def of ACTIONS) {
            if (!def.legacyPlacement.group) continue;
            const g = PICKER_GROUPS.find((x) => x.id === def.legacyPlacement.group);
            expect(g?.category, def.id).toBe(def.legacyPlacement.category);
        }
    });

    it('setup actions are kind setup', () => {
        for (const def of ACTIONS) if (def.id.startsWith('setup-')) expect(def.kind, def.id).toBe('setup');
    });

    it('actionName throws on an unknown id (a bug, never a silent blank)', () => {
        expect(() => actionName(en, 'no-such-action')).toThrow();
    });

    it('the registry imports nothing from src/commands (no cycle)', () => {
        const src = readFileSync('src/core/actionRegistry.ts', 'utf8');
        expect(src).not.toMatch(/from '\.\.\/commands/);
    });
});

describe('Phase 2 oracle: the picker is the Phase 1 tree plus the enumerated additions', () => {
    const phase1: LeafRow[] = JSON.parse(readFileSync('tests/fixtures/navigation/picker-tree-phase1.json', 'utf8'));
    const current = snapshotPickerTree(buildCommandCategories(en, () => {}));
    const key = (r: LeafRow): string => `${r.category}/${r.group ?? ''}/${r.id}`;
    const ADDED = [
        'capture/capture-newsletter/newsletter-regenerate-audio',
        'refine//refresh-task-status',
        'refine//copy-combined-google-script',
        'refine/refine-pending/ensure-note-structure',
        'refine/refine-pending/quick-add-text-pending',
        'refine/refine-pending/quick-add-url-pending',
        'refine/refine-pending/drop-selection-pending',
        'find//manage-index',
        'maintain//notebooklm-toggle-selection',
        'maintain//notebooklm-clear-selection',
        'maintain//notebooklm-open-export-folder',
    ];

    it('every Phase 1 leaf is unchanged: same place, name, owner, requirement and platform', () => {
        const now = new Map(current.map((r) => [key(r), r]));
        for (const old of phase1) expect(now.get(key(old)), key(old)).toEqual(old);
    });

    it('adds exactly the enumerated, previously palette-only commands', () => {
        const before = new Set(phase1.map(key));
        expect(current.filter((r) => !before.has(key(r))).map(key).sort()).toEqual([...ADDED].sort());
    });

    it('each added leaf carries its command\'s label and owning feature', () => {
        for (const k of ADDED) {
            const id = k.split('/')[2];
            const row = current.find((r) => r.id === id)!;
            expect(row.name).toBe(actionName(en, id));
            expect(row.feature).toBe(ACTION_BY_ID.get(id)!.feature);
        }
    });
});
