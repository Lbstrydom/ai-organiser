import { describe, it, expect } from 'vitest';
import { buildTasksScript, approvedListHashOf, TASKS_SCRIPT_VERSION, TASKS_SCRIPT_MIN_SUPPORTED, MAX_TASKS_PER_REQUEST } from '../src/services/inboxSweep/tasksScriptTemplate';

describe('buildTasksScript', () => {
	const setup = buildTasksScript({ secret: 'abc123secret', approvedListId: null });
	const operational = buildTasksScript({ secret: 'abc123secret', approvedListId: 'ListId_42' });

	it('is syntactically valid JavaScript in both modes', () => {
		expect(() => new Function(setup)).not.toThrow();
		expect(() => new Function(operational)).not.toThrow();
	});

	it('differs between the two deployments only in the config block', () => {
		const strip = (s: string): string => s.replace(/var CONFIG = \{[\s\S]*?\n\};/, '');
		expect(strip(setup)).toBe(strip(operational));
		expect(setup).toContain('"APPROVED_LIST_ID": ""');
		expect(operational).toContain('"APPROVED_LIST_ID": "ListId_42"');
		expect(setup).toContain(`"SCRIPT_VERSION": ${TASKS_SCRIPT_VERSION}`);
	});

	it('contains the secret exactly once', () => {
		expect(setup.match(/abc123secret/g)).toHaveLength(1);
	});

	it('enforces the safety rules in the script itself', () => {
		expect(setup).toContain('req.secret !== CONFIG.SECRET');
		expect(setup).toContain('"not-approved", "This script is in setup mode');
		expect(setup).toContain('req.listId !== CONFIG.APPROVED_LIST_ID');
		expect(setup).toContain('LockService.getScriptLock()');
		expect(setup).toContain('tryLock(20000)');
		expect(setup).toContain('MAX_ITEMS = 25');
		expect(setup).toContain('BUDGET_MS = 240000');
		expect(setup).toContain('showCompleted: true');
		expect(setup).toContain('[aio:');
		expect(MAX_TASKS_PER_REQUEST).toBe(25);
		for (const forbidden of ['Tasks.Tasks.remove', 'Tasks.Tasks.update', 'Tasks.Tasks.patch', 'Tasks.Tasklists.insert', 'Tasks.Tasklists.remove', 'Tasks.Tasks.clear']) {
			expect(setup.includes(forbidden), forbidden).toBe(false);
		}
	});

	it('writes the marker into the task before the map entry, so a failed map write is found by the next scan', () => {
		const insertAt = setup.indexOf('Tasks.Tasks.insert(');
		const mapAt = setup.indexOf('props.setProperty(key(t.exportId), JSON.stringify({ taskId: created.id');
		expect(insertAt).toBeGreaterThan(-1);
		expect(mapAt).toBeGreaterThan(insertAt);
		expect(setup.slice(0, insertAt)).toContain('"[aio:" + t.exportId + "]"');
	});

	it('reads the property map once and scans the list only when an id is missing', () => {
		expect((setup.match(/getProperties\(\)/g) ?? []).length).toBe(1);
		expect((setup.match(/scanMarkers_\(CONFIG\.APPROVED_LIST_ID, started\)/g) ?? []).length).toBe(1);
		expect(setup).toContain('missing ? scanMarkers_');
	});

	it('refuses to build a script with no secret, and the script itself rejects an empty one', () => {
		expect(() => buildTasksScript({ secret: '', approvedListId: 'L' })).toThrow();
		expect(() => buildTasksScript({ secret: '   ', approvedListId: null })).toThrow();
		expect(setup).toContain('!CONFIG.SECRET ||');
	});

	it('escapes hostile values so config cannot break out of its string', () => {
		const evil = buildTasksScript({ secret: 'a"b\\c\n// x', approvedListId: 'id"]);alert(1);//' });
		expect(() => new Function(evil)).not.toThrow();
		const config = /var CONFIG = (\{[\s\S]*?\n\});/.exec(evil)![1];
		expect(JSON.parse(config).SECRET).toBe('a"b\\c\n// x');
		expect(JSON.parse(config).APPROVED_LIST_ID).toBe('id"]);alert(1);//');
	});

	it('reports a supported minimum no newer than the current version', () => {
		expect(TASKS_SCRIPT_MIN_SUPPORTED).toBeLessThanOrEqual(TASKS_SCRIPT_VERSION);
	});
});

describe('script behaviour (run against a fake Tasks service)', () => {
	function run(config: { approvedListId: string | null }, state: { tasks: Array<{ id: string; title: string; notes?: string }>; props: Record<string, string> }, request: unknown) {
		const script = buildTasksScript({ secret: 'S', approvedListId: config.approvedListId });
		let seq = 0;
		const scans = { n: 0 };
		const sandbox = {
			ContentService: { createTextOutput: (s: string) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
			Utilities: { computeDigest: () => [0], DigestAlgorithm: { SHA_256: 'x' } },
			LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
			PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ ...state.props }), setProperty: (k: string, v: string) => { state.props[k] = v; } }) },
			Tasks: {
				Tasklists: { list: () => ({ items: [{ id: 'ListId_42', title: 'Inbox' }] }) },
				Tasks: {
					list: () => { scans.n++; return { items: state.tasks }; },
					insert: (body: { title: string; notes: string }) => { const t = { id: `t${++seq}`, title: body.title, notes: body.notes }; state.tasks.push(t); return t; },
				},
			},
		};
		const fn = new Function('sandbox', `with (sandbox) { ${script}; return doPost; }`);
		const doPost = fn(sandbox) as (e: unknown) => { s: string };
		const out = JSON.parse(doPost({ postData: { contents: JSON.stringify({ secret: 'S', ...(request as object) }) } }).s);
		return { out, scans };
	}
	const id = (n: number): string => `aio-${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
	const upsert = (tasks: unknown[], listId = 'ListId_42') => ({ op: 'upsert', listId, tasks });

	it('setup mode answers ping and lists but never creates', () => {
		const state = { tasks: [], props: {} };
		expect(run({ approvedListId: null }, state, { op: 'ping' }).out).toMatchObject({ ok: true, approvedListId: null });
		expect(run({ approvedListId: null }, state, { op: 'lists' }).out.lists).toEqual([{ id: 'ListId_42', title: 'Inbox' }]);
		expect(run({ approvedListId: null }, state, upsert([{ exportId: id(1), title: 'X' }])).out.error.code).toBe('not-approved');
		expect(state.tasks).toHaveLength(0);
	});

	it('rejects any other list before touching Google Tasks', () => {
		const state = { tasks: [], props: {} };
		expect(run({ approvedListId: 'ListId_42' }, state, upsert([{ exportId: id(1), title: 'X' }], 'Other')).out.error.code).toBe('not-approved');
		expect(state.tasks).toHaveLength(0);
	});

	it('creates once and reports exists on a repeat, without duplicating', () => {
		const state = { tasks: [] as Array<{ id: string; title: string; notes?: string }>, props: {} as Record<string, string> };
		const first = run({ approvedListId: 'ListId_42' }, state, upsert([{ exportId: id(1), title: 'Call' }, { exportId: id(2), title: 'Write' }]));
		expect(first.out.results.map((r: { status: string }) => r.status)).toEqual(['created', 'created']);
		expect(state.tasks).toHaveLength(2);
		expect(state.tasks[0].notes).toContain(`[aio:${id(1)}]`);
		const again = run({ approvedListId: 'ListId_42' }, state, upsert([{ exportId: id(1), title: 'Call' }, { exportId: id(2), title: 'Write' }]));
		expect(again.out.results.map((r: { status: string }) => r.status)).toEqual(['exists', 'exists']);
		expect(state.tasks).toHaveLength(2);
		expect(again.scans.n).toBe(0); // everything was in the map: no list read at all
	});

	it('finds a task whose map write was lost, by its marker, with one scan', () => {
		const state = { tasks: [{ id: 'old1', title: 'Call', notes: `[aio:${id(1)}]` }, { id: 'old2', title: 'Write', notes: `[aio:${id(2)}]` }], props: {} as Record<string, string> };
		const res = run({ approvedListId: 'ListId_42' }, state, upsert([{ exportId: id(1), title: 'Call' }, { exportId: id(2), title: 'Write' }, { exportId: id(3), title: 'New' }]));
		expect(res.out.results.map((r: { status: string }) => r.status)).toEqual(['exists', 'exists', 'created']);
		expect(res.scans.n).toBe(1);
		expect(state.tasks).toHaveLength(3);
	});

	it('answers conflict, and changes nothing, when an id is reused with another title', () => {
		const state = { tasks: [] as Array<{ id: string; title: string; notes?: string }>, props: {} as Record<string, string> };
		run({ approvedListId: 'ListId_42' }, state, upsert([{ exportId: id(1), title: 'Call' }]));
		const res = run({ approvedListId: 'ListId_42' }, state, upsert([{ exportId: id(1), title: 'Something else' }]));
		expect(res.out.results[0].status).toBe('conflict');
		expect(state.tasks).toHaveLength(1);
	});

	it('keeps idempotency records per list, so redeploying for another list never reuses them', () => {
		const state = { tasks: [] as Array<{ id: string; title: string; notes?: string }>, props: {} as Record<string, string> };
		run({ approvedListId: 'ListId_42' }, state, upsert([{ exportId: id(1), title: 'Call' }]));
		expect(Object.keys(state.props)).toEqual([`x:ListId_42:${id(1)}`]);
		// The same project redeployed for another list: the old list's record does not count.
		const other = run({ approvedListId: 'ListId_99' }, state, upsert([{ exportId: id(1), title: 'Call' }], 'ListId_99'));
		expect(other.out.results[0].status).toBe('exists'); // found by its marker in the (shared fake) list, not by the old record
		expect(Object.keys(state.props).sort()).toEqual([`x:ListId_42:${id(1)}`, `x:ListId_99:${id(1)}`]);
	});

	it('refuses a request that repeats an id, so one request cannot create twice', () => {
		const state = { tasks: [] as Array<{ id: string; title: string; notes?: string }>, props: {} as Record<string, string> };
		const res = run({ approvedListId: 'ListId_42' }, state, upsert([{ exportId: id(1), title: 'A' }, { exportId: id(1), title: 'A' }]));
		expect(res.out.error.code).toBe('bad-request');
		expect(state.tasks).toHaveLength(0);
	});

	it('only the marker on the last line of a task counts as its identity', () => {
		const state = { tasks: [{ id: 'old', title: 'Call', notes: `copied text [aio:${id(1)}] and more text` }], props: {} as Record<string, string> };
		const res = run({ approvedListId: 'ListId_42' }, state, upsert([{ exportId: id(1), title: 'Call' }]));
		expect(res.out.results[0].status).toBe('created'); // a marker inside user text is not identity
		const real = { tasks: [{ id: 'old', title: 'Call', notes: `user text\n[aio:${id(2)}]` }], props: {} as Record<string, string> };
		expect(run({ approvedListId: 'ListId_42' }, real, upsert([{ exportId: id(2), title: 'Call' }])).out.results[0].status).toBe('exists');
	});

	it('answers retry, and creates nothing, when the recovery scan runs out of time', () => {
		const state = { tasks: [{ id: 'old', title: 'Call', notes: `[aio:${id(3)}]` }], props: {} as Record<string, string> };
		const real = Date.now;
		let calls = 0;
		Date.now = () => (++calls > 1 ? real() + 10 * 60_000 : real());
		try {
			const res = run({ approvedListId: 'ListId_42' }, state, upsert([{ exportId: id(3), title: 'Call' }, { exportId: id(4), title: 'New' }]));
			expect(res.out.results.map((r: { status: string }) => r.status)).toEqual(['retry', 'retry']);
			expect(state.tasks).toHaveLength(1);
		} finally {
			Date.now = real;
		}
	});

	it('validates the request: size, ids, titles and the secret', () => {
		const state = { tasks: [], props: {} };
		const op = (tasks: unknown[]) => run({ approvedListId: 'ListId_42' }, state, upsert(tasks)).out.error?.code;
		expect(op([])).toBe('bad-request');
		expect(op(Array.from({ length: 26 }, (_, i) => ({ exportId: id(i), title: 'x' })))).toBe('bad-request');
		expect(op([{ exportId: 'nope', title: 'x' }])).toBe('bad-request');
		expect(op([{ exportId: id(1), title: '' }])).toBe('bad-request');
		expect(run({ approvedListId: 'ListId_42' }, state, { secret: 'WRONG', op: 'ping' }).out.error?.code).toBe('auth');
		expect(state.tasks).toHaveLength(0);
	});
});

describe('approvedListHashOf', () => {
	it('is a sha256 hex of the list id, and of the empty string for setup mode', async () => {
		expect(await approvedListHashOf('x')).toMatch(/^[0-9a-f]{64}$/);
		expect(await approvedListHashOf(null)).toBe(await approvedListHashOf(''));
		expect(await approvedListHashOf('a')).not.toBe(await approvedListHashOf('b'));
	});
});
