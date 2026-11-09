/**
 * The importer's runtime: off means nothing exists (no runtime, no command, no data key written); one run at a time; another
 * computer's import is not run here; a settings change ends a running run before its next write.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { REGISTER_BY_FEATURE } from '../src/commands/index';
import { DEFAULT_SETTINGS, migrateOldSettings } from '../src/core/settings';
// vi.mock is hoisted above every import, so the runtime below already sees the mocked service and Node modules.
import { ClaudeImportRuntime, createClaudeImportRuntime } from '../src/services/claudeImport/importRuntime';

vi.stubGlobal('window', globalThis);

const runImport = vi.fn();
vi.mock('../src/services/claudeImport/importService', async (orig) => ({
    ...(await orig<typeof import('../src/services/claudeImport/importService')>()),
    runImport: (...args: unknown[]) => runImport(...args),
}));
vi.mock('../src/services/offload/fingerprint', async (orig) => ({
    ...(await orig<typeof import('../src/services/offload/fingerprint')>()),
    nodeDeps: () => ({ fs: {}, path: {}, crypto: {} }),
}));


function fakePlugin(on: boolean, deviceOwner = '') {
    const data: Record<string, unknown> = {};
    const local: Record<string, unknown> = { 'ai-organiser-device': 'aaaaaaaa-1111' };
    const plugin = {
        settings: { ...DEFAULT_SETTINGS, featureFlags: { ...DEFAULT_SETTINGS.featureFlags, 'claude-import': on }, claudeImportSourceFolder: 'G:\\My Drive\\From Claude', claudeImportDeviceId: deviceOwner },
        t: { claudeImport: { noticeImported: '{count}', noticeHandbacks: '{count}', noticeRefused: '{count}' }, guidance: {} },
        app: { vault: { adapter: {} }, loadLocalStorage: (k: string) => local[k], saveLocalStorage: (k: string, v: unknown) => { local[k] = v; } },
        loadData: vi.fn(async () => data),
        saveData: vi.fn(async (d: Record<string, unknown>) => { Object.assign(data, d); }),
        saveSettings: vi.fn(async () => undefined),
    };
    return { plugin, data };
}

const report = (over = {}) => ({ trigger: 'manual', finishedAt: 0, imported: [], outstanding: [], newRefusals: [], ambiguous: [], waiting: 0, nextReadyAt: null, alreadyImported: 0, other: 0, cancelled: false, ...over });

beforeEach(() => { runImport.mockReset(); });

describe('claude import: off path', () => {
    it('is off by default and registers its commands only through its feature', () => {
        expect(DEFAULT_SETTINGS.featureFlags['claude-import']).toBeFalsy();
        expect(REGISTER_BY_FEATURE['claude-import']).toHaveLength(1);
    });
    it('creates no runtime while off, and writes no data key', () => {
        const { plugin, data } = fakePlugin(false);
        expect(createClaudeImportRuntime(plugin as never)).toBeNull();
        expect(Object.keys(data)).toEqual([]);
        expect(plugin.saveData).not.toHaveBeenCalled();
    });
    it('migrates settings idempotently with clamped limits', () => {
        const once = migrateOldSettings({ claudeImportMaxKB: 99999, claudeImportStabilitySeconds: 1, claudeImportAutoMinutes: 0, claudeImportSourceFolder: '  G:\\x  ' }) as Record<string, unknown>;
        expect([once.claudeImportMaxKB, once.claudeImportStabilitySeconds, once.claudeImportAutoMinutes, once.claudeImportSourceFolder]).toEqual([4096, 5, 0, 'G:\\x']);
        const twice = migrateOldSettings({ ...once }) as Record<string, unknown>;
        expect([twice.claudeImportMaxKB, twice.claudeImportStabilitySeconds, twice.claudeImportAutoMinutes]).toEqual([4096, 5, 0]);
        expect((migrateOldSettings({ claudeImportAutoMinutes: 1 }) as Record<string, unknown>).claudeImportAutoMinutes).toBe(2);
    });
});

describe('claude import: runtime', () => {
    it('runs one at a time: a second manual request gets the same run, a timer tick is dropped', async () => {
        const { plugin } = fakePlugin(true, 'aaaaaaaa-1111');
        let release!: () => void;
        runImport.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ ok: true, value: report() }); }));
        const rt = new ClaudeImportRuntime(plugin as never, {} as never);
        const a = rt.run('manual');
        const b = rt.run('manual');
        const c = await rt.run('background');
        expect(a).toBe(b);
        expect(c.ok).toBe(false);
        await vi.waitFor(() => expect(runImport).toHaveBeenCalledTimes(1));
        release();
        expect((await a).ok).toBe(true);
        expect(rt.status().running).toBe(false);
    });
    it('does not import when another computer owns the import, and a manual run claims an unowned one', async () => {
        runImport.mockResolvedValue({ ok: true, value: report() });
        const other = fakePlugin(true, 'bbbbbbbb-2222');
        expect(await new ClaudeImportRuntime(other.plugin as never, {} as never).run('manual')).toEqual({ ok: false, error: 'claude-import-other-device' });
        expect(runImport).not.toHaveBeenCalled();
        const none = fakePlugin(true, '');
        expect((await new ClaudeImportRuntime(none.plugin as never, {} as never).run('background')).ok).toBe(false);
        expect(runImport).not.toHaveBeenCalled();
        await new ClaudeImportRuntime(none.plugin as never, {} as never).run('manual');
        expect(none.plugin.settings.claudeImportDeviceId).toBe('aaaaaaaa-1111');
        expect(runImport).toHaveBeenCalledTimes(1);
    });
    it('ends a running run when an importer setting changes, or when it is stopped', async () => {
        const { plugin } = fakePlugin(true, 'aaaaaaaa-1111');
        let alive: (() => boolean) | null = null;
        let release!: () => void;
        runImport.mockImplementation((env: { alive: () => boolean }) => { alive = env.alive; return new Promise((resolve) => { release = () => resolve({ ok: true, value: report() }); }); });
        const rt = new ClaudeImportRuntime(plugin as never, {} as never);
        const p = rt.run('manual');
        await vi.waitFor(() => expect(alive).not.toBeNull());
        expect(alive!()).toBe(true);
        plugin.settings.claudeImportDestination = 'Elsewhere';
        rt.afterSave();
        expect(alive!()).toBe(false);
        release();
        await p;
        const q = rt.run('manual');
        await vi.waitFor(() => expect(runImport).toHaveBeenCalledTimes(2));
        rt.stop();
        expect(alive!()).toBe(false);
        release();
        await q;
    });
    it('queues a choice about an ambiguous copy behind a running run', async () => {
        const { plugin } = fakePlugin(true, 'aaaaaaaa-1111');
        const order: string[] = [];
        let release!: () => void;
        runImport.mockImplementation(() => new Promise((resolve) => { release = () => { order.push('run'); resolve({ ok: true, value: report() }); }; }));
        const rt = new ClaudeImportRuntime(plugin as never, {} as never);
        const p = rt.run('manual');
        await vi.waitFor(() => expect(runImport).toHaveBeenCalledTimes(1));
        const q = rt.resolve('a'.repeat(64), 'fresh-copy').then((r) => { order.push('resolve'); return r; });
        await new Promise((r) => setTimeout(r, 10));
        expect(order).toEqual([]);
        release();
        await Promise.all([p, q]);
        expect(order).toEqual(['run', 'resolve']);
    });
    it('puts the owner back when claiming cannot be saved, and does not run', async () => {
        runImport.mockResolvedValue({ ok: true, value: report() });
        const { plugin } = fakePlugin(true, '');
        plugin.saveSettings.mockRejectedValueOnce(new Error('disk full'));
        const res = await new ClaudeImportRuntime(plugin as never, {} as never).run('manual');
        expect(res.ok).toBe(false);
        expect(plugin.settings.claudeImportDeviceId).toBe('');
        expect(runImport).not.toHaveBeenCalled();
    });
    it('makes no automatic look at start-up when automatic looks are off', async () => {
        runImport.mockResolvedValue({ ok: true, value: report() });
        const { plugin } = fakePlugin(true, 'aaaaaaaa-1111');
        plugin.settings.claudeImportAutoMinutes = 0;
        const rt = new ClaudeImportRuntime(plugin as never, {} as never);
        rt.start();
        await new Promise((r) => setTimeout(r, 20));
        expect(runImport).not.toHaveBeenCalled();
        plugin.settings.claudeImportAutoMinutes = 10;
        const on = new ClaudeImportRuntime(plugin as never, {} as never);
        on.start();
        await vi.waitFor(() => expect(runImport).toHaveBeenCalledTimes(1));
        on.stop();
    });
    it('refuses to run on an unreadable record', async () => {
        const { plugin, data } = fakePlugin(true, 'aaaaaaaa-1111');
        data['claude-import-ledger'] = { v: 9 };
        const rt = new ClaudeImportRuntime(plugin as never, {} as never);
        expect(await rt.run('manual')).toEqual({ ok: false, error: 'claude-import-ledger-corrupt' });
        expect(runImport).not.toHaveBeenCalled();
        expect(rt.status().corrupt).toBe(true);
        expect((await rt.resetRecord()).ok).toBe(true);
        expect(Array.isArray(data['claude-import-ledger-backup'])).toBe(true);
    });
});
