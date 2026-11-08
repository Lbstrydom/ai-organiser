/**
 * The AI processing mark in its own property (`aiStatusProperty: 'aio-status'`, opt-in).
 * Off (the default `status`) is byte-identical: the resolver, the filter retarget, the metadata writer, Upgrade metadata
 * and dashboard creation all behave as before. On, the mark goes to `aio-status` and `status` is never touched.
 * The move of existing marks is planned per file, reviewed, and skipped when the file changed since the scan.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as yaml from 'js-yaml';

vi.mock('obsidian', async () => await import('./mocks/obsidian'));

import { App, TFile, createTFile, createTFolder } from './mocks/obsidian';
import { AIO_STATUS_KEY, aiStatusKey, retargetStatusFilter } from '../src/core/aiStatus';
import { DEFAULT_SETTINGS, migrateOldSettings } from '../src/core/settings';
import { setActiveProtection } from '../src/core/protectedPaths';
import { readFrontmatterRecord } from '../src/utils/frontmatterKeys';
import { applyAiStatusMoves, planDashboardMove, planNoteMove, scanAiStatusMoves } from '../src/services/aiStatusMove';
import { markNoteProcessed } from '../src/services/metadataPostOp';
import { MigrationService } from '../src/services/migrationService';
import { DashboardService } from '../src/services/dashboardService';
import { DEFAULT_BASES_TEMPLATES } from '../src/services/configurationService';

const ON = { aiStatusProperty: 'aio-status' };

afterEach(() => setActiveProtection(null));

describe('resolver and settings', () => {
    it('defaults to status, and anything but an explicit opt-in is status', () => {
        expect(DEFAULT_SETTINGS.aiStatusProperty).toBe('status');
        expect(aiStatusKey(DEFAULT_SETTINGS)).toBe('status');
        for (const v of [undefined, null, 'aio_status', 'AIO-STATUS', 1]) expect(aiStatusKey({ aiStatusProperty: v })).toBe('status');
        expect(aiStatusKey(null)).toBe('status');
        expect(aiStatusKey(ON)).toBe(AIO_STATUS_KEY);
    });

    it('migrateOldSettings coerces an unknown value to status and keeps a valid one', () => {
        expect((migrateOldSettings({ aiStatusProperty: 'nope' }) as { aiStatusProperty: unknown }).aiStatusProperty).toBe('status');
        expect((migrateOldSettings({ aiStatusProperty: 'aio-status' }) as { aiStatusProperty: unknown }).aiStatusProperty).toBe('aio-status');
        expect(migrateOldSettings({})).not.toHaveProperty('aiStatusProperty');
    });
});

describe('retargetStatusFilter', () => {
    const text = `filters: 'status == "processed"'\nviews: []\n`;

    it('returns the input untouched with status', () => {
        expect(retargetStatusFilter(text, 'status')).toBe(text);
    });

    it('retargets each mark comparison, with or without note., and nothing else', () => {
        expect(retargetStatusFilter(text, 'aio-status')).toBe(`filters: 'note["aio-status"] == "processed"'\nviews: []\n`);
        expect(retargetStatusFilter('a: note.status != "error" and status=="pending"', 'aio-status'))
            .toBe('a: note["aio-status"] != "error" and note["aio-status"]=="pending"');
        for (const keep of ['status == "active"', 'my-status == "processed"', 'file.status == "processed"', 'property.status == "processed"', 'xstatus == "processed"']) {
            expect(retargetStatusFilter(keep, 'aio-status')).toBe(keep);
        }
    });
});

describe('planNoteMove', () => {
    it('renames the status line in place for an ordinary note, keeping every other byte', () => {
        const plan = planNoteMove('---\ntitle: X\nstatus: processed\nsummary: S\n---\nBody\n');
        expect(plan).toEqual({ ok: true, value: { next: '---\ntitle: X\naio-status: processed\nsummary: S\n---\nBody\n', mark: 'processed', becomesActive: false } });
        const crlf = planNoteMove('---\r\nstatus: "pending" # ai\r\n---\r\nx');
        expect(crlf.ok && crlf.value.next).toBe('---\r\naio-status: pending # ai\r\n---\r\nx');
    });

    it('an adopted project keeps a status of its own: active, plus the moved mark', () => {
        const plan = planNoteMove('---\naio-role: project\nstatus: processed\n---\nx');
        expect(plan.ok && plan.value.next).toBe('---\naio-role: project\nstatus: active\naio-status: processed\n---\nx');
        expect(plan.ok && plan.value.becomesActive).toBe(true);
        const area = planNoteMove('---\naio-role: area\nstatus: error\n---\nx');
        expect(area.ok && area.value.next).toBe('---\naio-role: area\naio-status: error\n---\nx');
    });

    it('refuses a note without a mark, one that already has aio-status, and a mark written as a list', () => {
        expect(planNoteMove('---\nstatus: active\n---\n')).toEqual({ ok: false, error: 'no-ai-status-mark' });
        expect(planNoteMove('---\nstatus: processed\naio-status: processed\n---\n')).toEqual({ ok: false, error: 'aio-status-exists' });
        expect(planNoteMove('---\nstatus: [processed]\n---\n')).toEqual({ ok: false, error: 'no-ai-status-mark' });
        expect(planNoteMove('no frontmatter')).toEqual({ ok: false, error: 'no-ai-status-mark' });
    });
});

describe('planDashboardMove', () => {
    it('retargets the default dashboard filter and keeps it valid YAML', () => {
        const plan = planDashboardMove(DEFAULT_BASES_TEMPLATES[0].content);
        expect(plan.ok).toBe(true);
        const doc = yaml.load(plan.ok ? plan.value : '') as { filters: unknown };
        expect(doc.filters).toBe('note["aio-status"] == "processed"');
    });

    it('refuses a dashboard with no mark filter, and one the change would break', () => {
        expect(planDashboardMove('filters: \'file.inFolder("A")\'\nviews: []\n')).toEqual({ ok: false, error: 'no-status-filter' });
        // In a YAML flow list the brackets of note["aio-status"] would end the list: refused, not written.
        expect(planDashboardMove('filters:\n  and: [status == "processed"]\n')).toEqual({ ok: false, error: 'dashboard-unreadable' });
    });
});

describe('scan and apply', () => {
    function world(files: Record<string, string>) {
        const store = new Map(Object.entries(files));
        const all = () => [...store.keys()].map((p) => createTFile(p));
        const process = vi.fn(async (f: TFile, fn: (s: string) => string) => { store.set(f.path, fn(store.get(f.path) ?? '')); });
        const app = {
            vault: {
                getMarkdownFiles: () => all().filter((f) => f.extension === 'md'),
                getFiles: all,
                cachedRead: async (f: TFile) => store.get(f.path) ?? '',
                getAbstractFileByPath: (p: string) => (store.has(p) ? createTFile(p) : null),
                process,
            },
            metadataCache: { getFileCache: (f: TFile) => ({ frontmatter: readFrontmatterRecord(store.get(f.path) ?? '') ?? undefined }) },
        };
        return { app: app as never, store, process };
    }

    it('lists marked notes and mark-filtered dashboards, never protected ones, and writes nothing', async () => {
        setActiveProtection(() => ['Locked']);
        const w = world({
            'A/One.md': '---\nstatus: processed\n---\n',
            'A/Two.md': '---\nstatus: active\n---\n',
            'Locked/Three.md': '---\nstatus: processed\n---\n',
            'Dash.base': DEFAULT_BASES_TEMPLATES[0].content,
            'Other.base': 'filters: \'file.inFolder("A")\'\n',
        });
        const res = await scanAiStatusMoves(w.app);
        expect(res.ok && res.value.map((i) => `${i.kind}:${i.path}`)).toEqual(['note:A/One.md', 'dashboard:Dash.base']);
        expect(w.process).not.toHaveBeenCalled();
    });

    it('applies ticked items, and skips one that changed since the scan', async () => {
        const w = world({ 'A/One.md': '---\nstatus: processed\n---\n', 'A/Two.md': '---\nstatus: pending\n---\n' });
        const scan = await scanAiStatusMoves(w.app);
        const items = scan.ok ? scan.value : [];
        w.store.set('A/Two.md', '---\nstatus: pending\n---\nEdited meanwhile\n');
        const res = await applyAiStatusMoves(w.app, items);
        expect(res).toEqual({ ok: true, value: { moved: ['A/One.md'], skipped: ['A/Two.md'], failed: [] } });
        expect(w.store.get('A/One.md')).toBe('---\naio-status: processed\n---\n');
        expect(w.store.get('A/Two.md')).toBe('---\nstatus: pending\n---\nEdited meanwhile\n');
    });

    it('skips a note that became protected after the scan', async () => {
        const w = world({ 'A/One.md': '---\nstatus: processed\n---\n' });
        const scan = await scanAiStatusMoves(w.app);
        setActiveProtection(() => ['A']);
        const res = await applyAiStatusMoves(w.app, scan.ok ? scan.value : []);
        expect(res.ok && res.value.skipped).toEqual(['A/One.md']);
        expect(w.process).not.toHaveBeenCalled();
    });
});

describe('writers with aio-status chosen', () => {
    function plugin(settings: Record<string, unknown>, fmInitial: Record<string, unknown>) {
        const fm: Record<string, unknown> = { ...fmInitial };
        return {
            fm,
            plugin: {
                settings: { enableStructuredMetadata: true, autoDetectContentType: false, ...settings },
                app: {
                    fileManager: { processFrontMatter: vi.fn(async (_f: TFile, m: (x: Record<string, unknown>) => void) => { m(fm); }) },
                    vault: { read: vi.fn(async () => 'one two three') },
                    metadataCache: { getFileCache: vi.fn(() => ({ frontmatter: { ...fm } })) },
                },
            } as never,
        };
    }
    const file = (): TFile => Object.assign(createTFile('P/N.md'), { stat: { mtime: 0 } });

    it('markNoteProcessed writes aio-status on every note, a project included, and never status', async () => {
        for (const initial of [{}, { status: 'active', 'aio-role': 'project' }, { status: 'draft' }]) {
            const w = plugin(ON, initial);
            await markNoteProcessed(w.plugin, file());
            expect(w.fm['aio-status']).toBe('processed');
            expect(w.fm.status).toBe((initial as { status?: string }).status);
        }
        const err = plugin(ON, { 'aio-status': 'error' });
        await markNoteProcessed(err.plugin, file());
        expect(err.fm['aio-status']).toBe('error');
        const explicit = plugin(ON, {});
        await markNoteProcessed(explicit.plugin, file(), { status: 'error' });
        expect(explicit.fm).toMatchObject({ 'aio-status': 'error' });
        expect(explicit.fm.status).toBeUndefined();
    });

    it('markNoteProcessed is unchanged with the default', async () => {
        const w = plugin({}, {});
        await markNoteProcessed(w.plugin, file());
        expect(w.fm.status).toBe('processed');
        expect(w.fm['aio-status']).toBeUndefined();
    });

    it('Upgrade metadata writes aio-status, leaves status, and counts a mark still in status as upgraded', async () => {
        const w = plugin(ON, { status: 'active', tags: ['a'] });
        const svc = new MigrationService((w.plugin as { app: never }).app, w.plugin);
        await svc.migrateNote(file(), { overwriteExisting: false, extractSummary: false } as never);
        expect(w.fm['aio-status']).toBe('processed');
        expect(w.fm.status).toBe('active');
        const marked = plugin(ON, { status: 'processed' });
        const svc2 = new MigrationService((marked.plugin as { app: never }).app, marked.plugin);
        expect(await svc2.migrateNote(file(), { overwriteExisting: false, extractSummary: false } as never)).toBe(false);
        expect(marked.fm['aio-status']).toBeUndefined();
    });
});

describe('dashboard creation', () => {
    async function create(settings: Record<string, unknown> | undefined): Promise<string> {
        const app = new App();
        let created = '';
        app.vault.getAbstractFileByPath = () => null;
        app.vault.create = async (path: string, content: string) => { created = content; return createTFile(path); };
        const template = { ...DEFAULT_BASES_TEMPLATES[0] };
        const p = {
            settings,
            configService: { getBasesTemplateByName: vi.fn().mockResolvedValue(template) },
            basesService: { isBasesEnabled: vi.fn().mockReturnValue(false) },
        };
        const service = new DashboardService(app as never, p as never);
        await service.createDashboard({ template: 'Notes Dashboard', folder: createTFolder('Projects') });
        return created;
    }

    it('filters on aio-status once chosen, and is byte-identical by default', async () => {
        const on = yaml.load(await create(ON)) as { filters: unknown };
        expect(on.filters).toEqual({ and: ['file.inFolder("Projects")', 'note["aio-status"] == "processed"'] });
        expect(await create({ aiStatusProperty: 'status' })).toBe(await create(undefined));
    });
});
