import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { DEFAULT_SETTINGS, type AIOrganiserSettings } from '../src/core/settings';
import { ok, err } from '../src/core/result';
import { LivePackService, type LiveEnv } from '../src/services/aiWorkspaces/livePackService';
import type { IntentJournal, LiveDeps, LiveIntent } from '../src/services/aiWorkspaces/liveFileWriter';
import type { PackInput, PackNote } from '../src/services/aiWorkspaces/contextPack';
import type { PackNotes } from '../src/services/aiWorkspaces/workspaceService';
import { emptyWorkspace } from '../src/services/aiWorkspaces/workspaceRecord';

const ID = '3f2b8f4e-1c2d-4e5f-8a6b-7c8d9e0f1a2b';
const ME = '11111111-1111-4111-8111-111111111111';
const THEM = '22222222-2222-4222-8222-222222222222';
const deps = { fs, path, crypto } as unknown as LiveDeps;

interface World {
    env: LiveEnv;
    settings: AIOrganiserSettings;
    notes: Map<string, string>;
    shared: Set<string>;
    policy: { value: string };
    device: { value: string };
    journal: IntentJournal;
    hooks: { beforeCollect?: () => void };
    saves: number;
}

let tmp: string;
let drive: string;
let vault: string;
const fileName = 'Pkm - live pack.md';
const livePath = () => path.join(drive, fileName);

function world(): World {
    const settings: AIOrganiserSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    settings.aiWorkspaceLiveFolder = drive;
    settings.aiWorkspaces = { [ID]: { ...emptyWorkspace(ID), contextSources: ['P/Reading.md', 'P/New.md'] } };
    const notes = new Map<string, string>([['P/Pkm.md', '# Pkm\n\nproject words\n'], ['P/Reading.md', 'reading words\n']]);
    const shared = new Set(['P/Pkm.md', 'P/Reading.md', 'P/New.md']);
    const policy = { value: 'a'.repeat(64) };
    const device = { value: ME };
    const map = new Map<string, LiveIntent>();
    const journal: IntentJournal = { get: (d) => map.get(d) ?? null, set: (d, i) => { map.set(d, i); }, clear: (d) => { map.delete(d); }, all: () => [...map.entries()] };
    const w: World = { settings, notes, shared, policy, device, journal, hooks: {}, saves: 0, env: undefined as unknown as LiveEnv };
    w.env = {
        settings: () => settings,
        saveConsent: async () => { w.saves++; },
        saveStatus: async () => undefined,
        featureOn: () => true,
        collectNotes: async (aioId) => {
            w.hooks.beforeCollect?.();
            const record = settings.aiWorkspaces[aioId];
            const project = notes.get('P/Pkm.md');
            if (!record || project === undefined) return err('project-not-found');
            const sources: PackNote[] = [];
            const missing: string[] = [];
            for (const p of record.contextSources) { const t = notes.get(p); if (t !== undefined) sources.push({ path: p, text: t }); else missing.push(p); }
            return ok<PackNotes>({ record, project: { path: 'P/Pkm.md', text: project }, area: null, sources, missing });
        },
        packInput: async (aioId, n): Promise<PackInput> => ({
            vaultId: 'v', aioId, projectName: 'Pkm', project: n.project, sources: n.sources,
            reasonNotShareable: (p) => (shared.has(p) ? null : 'outside-allow-list'),
            resolveLink: () => null, linksOf: () => [], sharePolicyRevision: policy.value,
            ...(n.record.live ? { livePackName: n.record.live.fileName } : {}),
        }),
        sharePolicy: async () => policy.value,
        deviceId: () => device.value,
        deps: () => deps,
        vaultBase: () => vault,
        journal,
        now: () => new Date('2026-11-07T10:00:00.000Z'),
    };
    return w;
}

async function turnOn(w: World, svc: LivePackService, ticked = ['P/Pkm.md', 'P/Reading.md']) {
    const review = await svc.prepareReview(ID);
    if (!review.ok) throw new Error(review.error);
    const preview = await svc.previewSelection(review.value, ticked);
    if (!preview.ok) throw new Error(preview.error);
    return { review: review.value, preview: preview.value, res: await svc.confirm(review.value, preview.value) };
}

beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aio-live-svc-')));
    drive = path.join(tmp, 'My Drive');
    vault = path.join(tmp, 'vault');
    fs.mkdirSync(drive);
    fs.mkdirSync(vault);
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('turning the live pack on', () => {
    it('writes exactly the approved notes and records the approval', async () => {
        const w = world();
        const svc = new LivePackService(w.env);
        const { res } = await turnOn(w, svc);
        expect(res.ok && res.value.kind).toBe('written');
        const text = fs.readFileSync(livePath(), 'utf8');
        expect(text).toContain('project words');
        expect(text).toContain('reading words');
        const live = w.settings.aiWorkspaces[ID].live;
        expect(live).toMatchObject({ approvedSources: ['P/Pkm.md', 'P/Reading.md'], deviceId: ME, folder: drive, fileName, generation: 1 });
        expect(w.settings.aiWorkspaceLiveStatus[ID]).toMatchObject({ state: 'live' });
    });

    it('a stale review is refused: a source edited, the policy changed, or another approval in between', async () => {
        for (const change of ['edit', 'policy', 'generation'] as const) {
            const w = world();
            const svc = new LivePackService(w.env);
            const review = await svc.prepareReview(ID);
            const preview = review.ok ? await svc.previewSelection(review.value, ['P/Pkm.md']) : null;
            if (!review.ok || !preview?.ok) throw new Error('setup');
            if (change === 'edit') w.notes.set('P/Pkm.md', '# Pkm\n\nchanged\n');
            if (change === 'policy') w.policy.value = 'c'.repeat(64);
            if (change === 'generation') await svc.confirm(review.value, preview.value);
            expect(await svc.confirm(review.value, preview.value)).toEqual({ ok: false, error: 'pack-preview-stale' });
        }
    });

    it('the preview reports the selected bytes, and the project note is required', async () => {
        const w = world();
        const svc = new LivePackService(w.env);
        const review = await svc.prepareReview(ID);
        if (!review.ok) throw new Error('setup');
        const small = await svc.previewSelection(review.value, ['P/Pkm.md']);
        const big = await svc.previewSelection(review.value, ['P/Pkm.md', 'P/Reading.md']);
        expect(small.ok && big.ok && small.value.digest !== big.value.digest && big.value.held.length === 0).toBe(true);
        expect(small.ok && small.value.held).toEqual(['P/Reading.md']);
        expect(await svc.previewSelection(review.value, ['P/Reading.md'])).toEqual({ ok: false, error: 'live-needs-review' });
    });

    it('is refused on another installation\'s publication', async () => {
        const w = world();
        const svc = new LivePackService(w.env);
        await turnOn(w, svc);
        w.device.value = THEM;
        expect(await svc.prepareReview(ID)).toEqual({ ok: false, error: 'live-other-device' });
        expect(await svc.refresh(ID)).toEqual({ ok: false, error: 'live-other-device' });
    });
});

describe('refreshing', () => {
    it('writes nothing when nothing changed and the file is intact, rewrites when it was edited or deleted', async () => {
        const w = world();
        const svc = new LivePackService(w.env);
        await turnOn(w, svc);
        const mtime = fs.statSync(livePath()).mtimeMs;
        expect(await svc.refresh(ID)).toMatchObject({ ok: true, value: { kind: 'unchanged' } });
        expect(fs.statSync(livePath()).mtimeMs).toBe(mtime);
        fs.appendFileSync(livePath(), 'x');
        expect(await svc.refresh(ID)).toMatchObject({ ok: true, value: { kind: 'written' } });
        expect(fs.readFileSync(livePath(), 'utf8').endsWith('x')).toBe(false);
        fs.unlinkSync(livePath());
        await svc.refresh(ID);
        expect(fs.existsSync(livePath())).toBe(true);
    });

    it('a new shareable note is held, listed, and never included until ticked', async () => {
        const w = world();
        const svc = new LivePackService(w.env);
        await turnOn(w, svc);
        w.notes.set('P/New.md', 'new private-ish words\n');
        const res = await svc.refresh(ID);
        expect(res.ok && res.value.kind).toBe('held');
        const text = fs.readFileSync(livePath(), 'utf8');
        expect(text).not.toContain('new private-ish words');
        expect(text).toContain('- P/New.md');
        expect(w.settings.aiWorkspaceLiveStatus[ID].held).toEqual(['P/New.md']);
    });

    it('a policy change pauses it; one that removes an approved note writes the stub', async () => {
        const w = world();
        const svc = new LivePackService(w.env);
        await turnOn(w, svc);
        const before = fs.readFileSync(livePath(), 'utf8');
        w.policy.value = 'c'.repeat(64);
        expect(await svc.refresh(ID)).toMatchObject({ ok: true, value: { kind: 'needs-review' } });
        expect(fs.readFileSync(livePath(), 'utf8')).toBe(before);
        w.shared.delete('P/Reading.md');
        w.policy.value = 'd'.repeat(64);
        expect(await svc.refresh(ID)).toMatchObject({ ok: true, value: { kind: 'revoked' } });
        expect(fs.readFileSync(livePath(), 'utf8')).toContain('aio-live-state: no-longer-shared');
        expect(fs.readFileSync(livePath(), 'utf8')).not.toContain('reading words');
        expect(w.settings.aiWorkspaceLiveRevocations).toEqual([]);
        expect(w.settings.aiWorkspaceLiveStatus[ID].state).toBe('needs-review');
    });

    it('a change of policy during the source reads, or between the build and the write, writes nothing', async () => {
        for (const when of ['collect', 'commit'] as const) {
            const w = world();
            const svc = new LivePackService(w.env);
            await turnOn(w, svc);
            const before = fs.readFileSync(livePath(), 'utf8');
            w.notes.set('P/Pkm.md', '# Pkm\n\nnewer words\n');
            let calls = 0;
            w.hooks.beforeCollect = () => {
                calls++;
                // first collect = the build's read; second = the commit-time re-check
                if ((when === 'collect' && calls === 1) || (when === 'commit' && calls === 2)) { w.shared.delete('P/Reading.md'); w.policy.value = 'e'.repeat(64); svc.bumpEpoch(); }
            };
            await svc.refresh(ID, { force: true });
            const after = fs.readFileSync(livePath(), 'utf8');
            expect(after.includes('newer words') && after.includes('reading words')).toBe(false);
            expect(after === before || after.includes('aio-live-state: no-longer-shared')).toBe(true);
            w.hooks.beforeCollect = undefined;
        }
    });

    it('refreshes run one at a time and requests coalesce', async () => {
        const w = world();
        const svc = new LivePackService(w.env);
        await turnOn(w, svc);
        const a = svc.refresh(ID);
        const b = svc.refresh(ID);
        expect(a).toBe(b);
        await a;
    });
});

describe('turning off and revocation', () => {
    it('on the writing computer: stub written, approval and revocation cleared', async () => {
        const w = world();
        const svc = new LivePackService(w.env);
        await turnOn(w, svc);
        expect(await svc.turnOff(ID)).toEqual({ ok: true, value: 'stubbed' });
        expect(fs.readFileSync(livePath(), 'utf8')).toContain('aio-live-state: no-longer-shared');
        expect(w.settings.aiWorkspaces[ID].live).toBeUndefined();
        expect(w.settings.aiWorkspaceLiveRevocations).toEqual([]);
        expect(w.settings.aiWorkspaceLiveStatus[ID].state).toBe('off');
    });

    it('on another computer: the request is persisted and the owner carries it out', async () => {
        const w = world();
        const svc = new LivePackService(w.env);
        await turnOn(w, svc);
        w.device.value = THEM;
        expect(await svc.turnOff(ID)).toEqual({ ok: true, value: 'requested' });
        expect(w.settings.aiWorkspaceLiveRevocations).toHaveLength(1);
        expect(fs.readFileSync(livePath(), 'utf8')).not.toContain('aio-live-state: no-longer-shared');
        w.device.value = ME;
        const done = await svc.reconcile();
        expect(done.items).toEqual([ID]);
        expect(fs.readFileSync(livePath(), 'utf8')).toContain('aio-live-state: no-longer-shared');
        expect(w.settings.aiWorkspaceLiveRevocations).toEqual([]);
    });

    it('a stub that cannot be written stays pending; the reconciler writes stubs even with the feature off', async () => {
        const w = world();
        const svc = new LivePackService(w.env);
        await turnOn(w, svc);
        const gone = path.join(tmp, 'gone');
        fs.renameSync(drive, gone);
        const res = await svc.turnOff(ID);
        expect(res.ok).toBe(false);
        expect(w.settings.aiWorkspaceLiveRevocations).toHaveLength(1);
        fs.renameSync(gone, drive);
        const off = new LivePackService({ ...w.env, featureOn: () => false });
        expect((await off.reconcile()).items).toEqual([ID]);
        expect(fs.readFileSync(livePath(), 'utf8')).toContain('aio-live-state: no-longer-shared');
    });

    it('the start-up reconciler writes and saves nothing when nothing is pending (the off path)', async () => {
        const w = world();
        let saved = 0;
        const svc = new LivePackService({ ...w.env, featureOn: () => false, saveStatus: async () => { saved++; }, saveConsent: async () => { saved++; } });
        const res = await svc.reconcile();
        expect(res).toEqual({ items: [], errors: [], warnings: [], isPartial: false });
        expect(saved).toBe(0);
        expect(fs.readdirSync(drive)).toEqual([]);
        expect(w.settings.aiWorkspaceLiveStatus).toEqual({});
    });

    it('revokeAll reports each project', async () => {
        const w = world();
        const svc = new LivePackService(w.env);
        await turnOn(w, svc);
        const res = await svc.revokeAll('feature-off');
        expect(res).toMatchObject({ items: [ID], errors: [], isPartial: false });
    });

    it('never stubs a file that is not this project\'s', async () => {
        const w = world();
        const svc = new LivePackService(w.env);
        await turnOn(w, svc);
        fs.writeFileSync(livePath(), 'the person replaced it');
        const res = await svc.turnOff(ID);
        expect(res).toEqual({ ok: false, error: 'live-file-not-ours' });
        expect(fs.readFileSync(livePath(), 'utf8')).toBe('the person replaced it');
    });
});

describe('snapshots', () => {
    it('only the newest snapshot of a project reaches the watcher', async () => {
        const w = world();
        const svc = new LivePackService(w.env);
        const seen: number[] = [];
        svc.onSnapshot = (s) => seen.push(s.revision);
        const older = svc.collectCandidates(ID);
        const newer = svc.collectCandidates(ID);
        const [o, n] = await Promise.all([older, newer]);
        if (!o.ok || !n.ok) throw new Error('setup');
        await svc.recollect(ID);
        expect(seen.length).toBe(1);
        expect(seen[0]).toBeGreaterThan(n.value.snapshot.revision);
    });
});
