import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	checkAgentIndex: vi.fn(),
	buildAgentIndex: vi.fn(),
	checkPair: vi.fn(),
	scanNotes: vi.fn(),
	analyseDuplicates: vi.fn(),
}));

vi.mock('../src/services/agentIndex/agentIndexService', () => ({ checkAgentIndex: mocks.checkAgentIndex, buildAgentIndex: mocks.buildAgentIndex }));
vi.mock('../src/services/cloudInventory/cloudInventoryService', () => ({
	checkPair: mocks.checkPair,
	hubNotePath: (pair: { vaultFolder: string }) => ({ ok: true, value: `${pair.vaultFolder} — Drive.md` }),
	makeLister: () => async () => ({ status: 'complete', files: [], foldersVisited: 1 }),
}));
vi.mock('../src/services/embedScanService', () => ({ scanNotes: mocks.scanNotes }));
vi.mock('../src/services/attachmentDuplicateService', () => ({ analyseDuplicates: mocks.analyseDuplicates }));

import { UpkeepController, availability, previewUpkeep, snapshotConfig } from '../src/services/upkeep/upkeepRuntime';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import type { JobClock } from '../src/services/upkeep/intervalJob';
import { en } from '../src/i18n/en';
import { Platform, TFile } from './mocks/obsidian';

vi.stubGlobal('window', globalThis);

const URL_OK = 'https://script.google.com/macros/s/AKfycbxTEST/exec';
const pair = { id: 'p1', vaultFolder: 'Projects', driveFolderId: 'DriveFolder_01', placement: 'beside' as const };

function makeClock() {
	let now = Date.now();
	const timers = new Map<number, () => void>();
	let next = 1;
	const clock: JobClock = { now: () => now, setInterval: (fn) => { const id = next++; timers.set(id, fn); return id; }, clearInterval: (id) => { timers.delete(id); } };
	return { clock, timers, advance: (ms: number) => { now += ms; } };
}

function makePlugin(over: Record<string, unknown> = {}) {
	const writes: string[] = [];
	const trap = (name: string) => async () => { writes.push(name); };
	const intervals: number[] = [];
	const settings = {
		...structuredClone(DEFAULT_SETTINGS),
		featureFlags: { 'vault-upkeep': true, 'agent-index': true, 'cloud-inventory': true, 'embed-scan': true },
		upkeepInterval: 'daily',
		upkeepTasks: { agentIndex: true, inventories: true, attachments: true },
		cloudInventoryScriptUrl: URL_OK,
		cloudInventoryPairs: [pair],
		...over,
	} as typeof DEFAULT_SETTINGS;
	const file = (path: string, size = 10): TFile => { const f = new TFile(); f.path = path; f.stat = { mtime: 1, ctime: 1, size }; return f; };
	const saves = { n: 0 };
	const plugin = {
		settings,
		t: en,
		foregroundGate: { isActive: () => false },
		registerInterval: (id: number) => { intervals.push(id); return id; },
		saveSettings: async () => { saves.n++; },
		secretStorageService: { getSecret: async () => 'S' },
		app: {
			vault: {
				getMarkdownFiles: () => [file('Projects/a.md'), file('Course/b.md')],
				getFiles: () => [],
				getAbstractFileByPath: () => null,
				readBinary: async () => new ArrayBuffer(0),
				// Any write to the vault is recorded: a run must never make one.
				create: trap('create'), modify: trap('modify'), process: trap('process'), delete: trap('delete'), rename: trap('rename'), createFolder: trap('createFolder'), append: trap('append'),
			},
			fileManager: { trashFile: trap('trashFile'), processFrontMatter: trap('processFrontMatter') },
			commands: { executeCommandById: vi.fn() },
		},
	};
	return { plugin: plugin as never, settings, writes, intervals, saves };
}

const staleCheck = { ok: true, value: { added: [], removed: [], changed: ['a.md'], fresh: false, scopeChanged: false, missing: false, unreadable: 0, unstable: false } };
const freshCheck = { ok: true, value: { added: [], removed: [], changed: [], fresh: true, scopeChanged: false, missing: false, unreadable: 0, unstable: false } };

beforeEach(() => {
	mocks.checkAgentIndex.mockReset().mockResolvedValue(staleCheck);
	mocks.buildAgentIndex.mockReset().mockResolvedValue({ ok: true, value: { path: '.ai-organiser/agent-index.jsonl' } });
	mocks.checkPair.mockReset().mockResolvedValue({ ok: true, value: { pairId: 'p1', path: 'Hub.md', changed: true, status: 'complete' } });
	mocks.scanNotes.mockReset().mockResolvedValue({ targets: [], possiblyOrphaned: [], cancelled: false, coverageFailures: [], ambiguousPaths: [] });
	mocks.analyseDuplicates.mockReset().mockResolvedValue({ ok: true, value: { groups: [], cancelled: false } });
});
afterEach(() => { Platform.isMobile = false; vi.unstubAllGlobals(); vi.stubGlobal('window', globalThis); });

describe('availability and the config snapshot', () => {
	it('a check is available only when its feature is on, and the Drive check also needs a link and a pair', () => {
		const h = makePlugin();
		expect(availability(h.plugin)).toEqual({ agentIndex: true, inventories: true, attachments: true });
		const off = makePlugin({ featureFlags: { 'vault-upkeep': true } });
		expect(availability(off.plugin)).toEqual({ agentIndex: false, inventories: false, attachments: false });
		const noPair = makePlugin({ cloudInventoryPairs: [] });
		expect(availability(noPair.plugin).inventories).toBe(false);
		const badUrl = makePlugin({ cloudInventoryScriptUrl: 'https://evil.example.com/x' });
		expect(availability(badUrl.plugin).inventories).toBe(false);
	});

	it('copies the selections so later edits cannot change a running snapshot', () => {
		const h = makePlugin();
		const snap = snapshotConfig(h.plugin);
		h.settings.upkeepTasks.agentIndex = false;
		expect(snap.tasks.agentIndex).toBe(true);
		expect(snap.task.largeBytes).toBe(h.settings.attachmentLargeFileMB * 1024 * 1024);
	});
});

describe('UpkeepController: off path and lifecycle', () => {
	it('registers no timer and refuses to run while the feature is off', async () => {
		const h = makePlugin({ featureFlags: { 'vault-upkeep': false } });
		const c = makeClock();
		const controller = new UpkeepController(h.plugin, c.clock);
		controller.start();
		expect(c.timers.size).toBe(0);
		expect(h.intervals).toEqual([]);
		expect(await controller.runNow()).toEqual({ ok: false, error: 'upkeep-feature-off' });
		expect(controller.nextRun()).toBeNull();
		expect(mocks.checkAgentIndex).not.toHaveBeenCalled();
	});

	it('registers its interval with the plugin for cleanup, and stop() clears it', () => {
		const h = makePlugin({ upkeepLastRun: { startedAt: new Date().toISOString(), endedAt: Date.now(), durationMs: 1, trigger: 'manual', outcomes: [], totals: {}, status: 'ok' } });
		const c = makeClock();
		const controller = new UpkeepController(h.plugin, c.clock);
		controller.start();
		expect(c.timers.size).toBe(1);
		expect(h.intervals).toHaveLength(1); // registerInterval: Obsidian clears it on unload
		controller.stop();
		expect(c.timers.size).toBe(0);
	});

	it('automatic runs off means no timer even with the feature on', () => {
		const h = makePlugin({ upkeepInterval: 'off' });
		const c = makeClock();
		new UpkeepController(h.plugin, c.clock).start();
		expect(c.timers.size).toBe(0);
		expect(new UpkeepController(h.plugin, c.clock).nextRun()).toBeNull();
	});
});

describe('UpkeepController: a run', () => {
	it('proposes and retains, and never writes to the vault', async () => {
		const h = makePlugin();
		mocks.scanNotes.mockResolvedValue({
			targets: [{ file: Object.assign(new TFile(), { path: 'A/big.pdf' }), sizeBytes: 50_000_000, references: [{}, {}] }],
			possiblyOrphaned: [Object.assign(new TFile(), { path: 'A/old.png', stat: { mtime: 1, ctime: 1, size: 10 } })],
			cancelled: false, coverageFailures: [], ambiguousPaths: [],
		});
		const controller = new UpkeepController(h.plugin, makeClock().clock);
		const res = await controller.runNow();
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.value.summary.status).toBe('ok');
		expect(res.value.summary.totals).toMatchObject({ 'agent-index-stale': 1, 'inventory-differs': 1, 'attachment-unreferenced': 1, 'attachment-large': 1 });
		expect(h.writes).toEqual([]); // no create, modify, process, delete, rename, trash or append
		expect(mocks.buildAgentIndex).not.toHaveBeenCalled(); // the auto-refresh opt-in is off
		expect(h.settings.upkeepLastRun).toMatchObject({ status: 'ok', trigger: 'manual' });
		expect(h.settings.upkeepLastProposals?.items.length).toBe(4);
		expect(controller.last).toBe(res.value);
		expect(h.saves.n).toBeGreaterThan(0);
	});

	it('refreshes the index only with the opt-in, and then it is the only write', async () => {
		const h = makePlugin({ upkeepAutoRefreshIndex: true, upkeepTasks: { agentIndex: true, inventories: false, attachments: false } });
		const res = await new UpkeepController(h.plugin, makeClock().clock).runNow();
		expect(mocks.buildAgentIndex).toHaveBeenCalledTimes(1);
		expect(res.ok && res.value.proposals).toEqual([{ kind: 'agent-index-refreshed', path: '.ai-organiser/agent-index.jsonl' }]);
		expect(h.writes).toEqual([]);
	});

	it('is single-flight: a second run while one is active is refused, and the mutex is released afterwards', async () => {
		const h = makePlugin({ upkeepTasks: { agentIndex: true, inventories: false, attachments: false } });
		let release: () => void = () => undefined;
		mocks.checkAgentIndex.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(freshCheck); }));
		const controller = new UpkeepController(h.plugin, makeClock().clock);
		const first = controller.runNow();
		await new Promise((r) => setTimeout(r, 0));
		expect(controller.running).toBe(true);
		expect(await controller.runNow()).toEqual({ ok: false, error: 'upkeep-running' });
		release();
		expect((await first).ok).toBe(true);
		expect(controller.running).toBe(false);
		expect((await controller.runNow()).ok).toBe(true);
	});

	it('refuses a run with no check selected', async () => {
		const h = makePlugin({ upkeepTasks: { agentIndex: false, inventories: false, attachments: false } });
		expect(await new UpkeepController(h.plugin, makeClock().clock).runNow()).toEqual({ ok: false, error: 'upkeep-no-tasks' });
	});

	it('makes no network call unless the Drive check is selected', async () => {
		const h = makePlugin({ upkeepTasks: { agentIndex: true, inventories: false, attachments: true } });
		await new UpkeepController(h.plugin, makeClock().clock).runNow();
		expect(mocks.checkPair).not.toHaveBeenCalled();
		const withDrive = makePlugin();
		await new UpkeepController(withDrive.plugin, makeClock().clock).runNow();
		expect(mocks.checkPair).toHaveBeenCalledTimes(1);
	});

	it('a failed check is a failed task, not an empty result', async () => {
		const h = makePlugin({ upkeepTasks: { agentIndex: true, inventories: true, attachments: false } });
		mocks.checkPair.mockResolvedValue({ ok: false, error: 'script-network' });
		const res = await new UpkeepController(h.plugin, makeClock().clock).runNow();
		expect(res.ok && res.value.summary.status).toBe('partial');
		expect(res.ok && res.value.summary.outcomes[1]).toMatchObject({ task: 'inventories', status: 'failed', reason: 'script-network' });
	});
});

describe('UpkeepController: scheduled runs', () => {
	it('runs an overdue job at start, then stays quiet until it is due again', async () => {
		const h = makePlugin();
		const c = makeClock();
		const controller = new UpkeepController(h.plugin, c.clock);
		controller.start();
		await new Promise((r) => setTimeout(r, 20));
		expect(mocks.checkAgentIndex).toHaveBeenCalledTimes(1);
		expect(h.settings.upkeepLastRun?.trigger).toBe('scheduled');
		c.advance(60 * 60_000);
		for (const fn of c.timers.values()) fn();
		await new Promise((r) => setTimeout(r, 20));
		expect(mocks.checkAgentIndex).toHaveBeenCalledTimes(1); // not due yet: daily
	});

	it('skips while the page is hidden, on mobile without opt-in, and while interactive work is in flight', async () => {
		const attempt = async (setup: (h: ReturnType<typeof makePlugin>) => void) => {
			mocks.checkAgentIndex.mockClear();
			const h = makePlugin();
			setup(h);
			new UpkeepController(h.plugin, makeClock().clock).start();
			await new Promise((r) => setTimeout(r, 20));
			return mocks.checkAgentIndex.mock.calls.length;
		};
		vi.stubGlobal('document', { visibilityState: 'hidden' });
		expect(await attempt(() => undefined)).toBe(0);
		vi.stubGlobal('document', { visibilityState: 'visible' });
		Platform.isMobile = true;
		expect(await attempt(() => undefined)).toBe(0);
		expect(await attempt((h) => { h.settings.upkeepRunOnMobile = true; })).toBe(1);
		Platform.isMobile = false;
		expect(await attempt((h) => { (h.plugin as unknown as { foregroundGate: { isActive: () => boolean } }).foregroundGate.isActive = () => true; })).toBe(0);
		expect(await attempt(() => undefined)).toBe(1);
	});

	it('announces a scheduled run with proposals once, and counts consecutive failures for the backoff', async () => {
		const h = makePlugin({ upkeepTasks: { agentIndex: true, inventories: false, attachments: false } });
		const controller = new UpkeepController(h.plugin, makeClock().clock);
		controller.start();
		await new Promise((r) => setTimeout(r, 20));
		expect(h.settings.upkeepLastNotified).not.toBe('');
		expect(h.settings.upkeepFailures).toBe(0);

		mocks.checkAgentIndex.mockResolvedValue({ ok: false, error: 'scan-incomplete' });
		const failing = makePlugin({ upkeepTasks: { agentIndex: true, inventories: false, attachments: false } });
		new UpkeepController(failing.plugin, makeClock().clock).start();
		await new Promise((r) => setTimeout(r, 20));
		expect(failing.settings.upkeepFailures).toBe(1);
		expect(failing.settings.upkeepLastRun?.status).toBe('failed');
	});
});

describe('previewUpkeep (the setup dry run)', () => {
	it('uses the draft selections, never publishes the index, never saves and retains nothing', async () => {
		const h = makePlugin({ upkeepAutoRefreshIndex: true, upkeepTasks: { agentIndex: false, inventories: false, attachments: false } });
		const run = await previewUpkeep(h.plugin, { agentIndex: true, inventories: false, attachments: false });
		expect(run.summary.trigger).toBe('preview');
		expect(run.proposals).toEqual([{ kind: 'agent-index-stale', added: 0, removed: 0, changed: 1, unreadable: 0, unstable: false }]);
		expect(mocks.buildAgentIndex).not.toHaveBeenCalled();
		expect(h.saves.n).toBe(0);
		expect(h.settings.upkeepLastRun).toBeNull();
		expect(h.settings.upkeepTasks.agentIndex).toBe(false); // the unsaved draft did not leak into the settings
		expect(h.writes).toEqual([]);
	});
});
