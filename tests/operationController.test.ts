import { describe, it, expect } from 'vitest';
import { OperationController } from '../src/services/agentConnectors/operationController';
import { ok, err } from '../src/core/result';

function harness() {
	const pending = new Map<number, () => void>();
	let next = 1;
	const controller = new OperationController({
		set: (fn) => { pending.set(next, fn); return next++; },
		clear: (id) => { pending.delete(id); },
	});
	return { controller, fire: () => { for (const fn of [...pending.values()]) fn(); }, pending };
}

const deferred = <T>() => {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
};

const opts = { limitMs: 1000, timeoutError: 'timed-out' };

describe('OperationController', () => {
	it('moves idle, running, done and keeps the value to show', async () => {
		const h = harness();
		const d = deferred<ReturnType<typeof ok<string>>>();
		expect(h.controller.state('a')).toEqual({ status: 'idle' });
		const run = h.controller.run('a', () => d.promise, opts);
		expect(h.controller.state('a')).toEqual({ status: 'running' });
		d.resolve(ok('v1'));
		expect(await run).toBe(true);
		expect(h.controller.state('a')).toEqual({ status: 'done', value: 'v1' });
		expect(h.pending.size).toBe(0); // the timer is cleared
	});

	it('keeps a failure and its code', async () => {
		const h = harness();
		await h.controller.run('a', async () => err('connector-node-missing'), opts);
		expect(h.controller.state('a')).toEqual({ status: 'failed', error: 'connector-node-missing' });
	});

	it('ignores a repeated click while the same action runs', async () => {
		const h = harness();
		const d = deferred<ReturnType<typeof ok<number>>>();
		let starts = 0;
		const first = h.controller.run('a', () => { starts++; return d.promise; }, opts);
		expect(await h.controller.run('a', () => { starts++; return d.promise; }, opts)).toBe(false);
		d.resolve(ok(1));
		await first;
		expect(starts).toBe(1);
		expect(await h.controller.run('a', async () => ok(2), opts)).toBe(true); // runnable again afterwards
	});

	it('blocks conflicting actions in the same group but not others', async () => {
		const h = harness();
		const d = deferred<ReturnType<typeof ok<number>>>();
		const writing = h.controller.run('export', () => d.promise, { ...opts, group: 'writes' });
		expect(h.controller.isBusy('create-files', 'writes')).toBe(true);
		expect(await h.controller.run('create-files', async () => ok(1), { ...opts, group: 'writes' })).toBe(false);
		expect(await h.controller.run('node', async () => ok(1), opts)).toBe(true);
		d.resolve(ok(1));
		await writing;
		expect(h.controller.isBusy('create-files', 'writes')).toBe(false);
	});

	it('ends as failed when the limit passes, and drops a late result', async () => {
		const h = harness();
		const d = deferred<ReturnType<typeof ok<string>>>();
		const run = h.controller.run('a', () => d.promise, opts);
		h.fire();
		expect(h.controller.state('a')).toEqual({ status: 'failed', error: 'timed-out' });
		d.resolve(ok('late'));
		await run;
		expect(h.controller.state('a')).toEqual({ status: 'failed', error: 'timed-out' });
	});

	it('keeps a timed-out job in its group until the job really ends', async () => {
		const h = harness();
		const d = deferred<ReturnType<typeof ok<string>>>();
		const run = h.controller.run('export', () => d.promise, { ...opts, group: 'writes' });
		h.fire();
		expect(h.controller.state('export')).toEqual({ status: 'failed', error: 'timed-out' });
		expect(h.controller.isBusy('create-files', 'writes')).toBe(true); // the writer is still going
		expect(await h.controller.run('create-files', async () => ok(1), { ...opts, group: 'writes' })).toBe(false);
		d.resolve(ok('late'));
		await run;
		expect(h.controller.isBusy('create-files', 'writes')).toBe(false);
		expect(await h.controller.run('create-files', async () => ok(1), { ...opts, group: 'writes' })).toBe(true);
	});

	it('forgets a finished result on reset, but not one that is still running', async () => {
		const h = harness();
		await h.controller.run('files', async () => ok('v'), opts);
		h.controller.reset('files');
		expect(h.controller.state('files')).toEqual({ status: 'idle' });
		const d = deferred<ReturnType<typeof ok<string>>>();
		const run = h.controller.run('files', () => d.promise, opts);
		h.controller.reset('files');
		expect(h.controller.state('files')).toEqual({ status: 'running' });
		d.resolve(ok('x'));
		await run;
	});

	it('turns a throwing job into a failure and survives a throwing listener', async () => {
		const h = harness();
		const seen: string[] = [];
		h.controller.onChange(() => { throw new Error('listener'); });
		h.controller.onChange(() => seen.push(h.controller.state('a').status));
		await h.controller.run('a', async () => { throw new Error('boom'); }, opts);
		expect(h.controller.state('a')).toEqual({ status: 'failed', error: 'timed-out' });
		expect(seen).toEqual(['running', 'failed', 'failed']); // the second is the release after the job ended
	});
});

describe('OperationController: group membership belongs to one run', () => {
	it('does not keep an old group after the action ends or is run again without one', async () => {
		const h = harness();
		await h.controller.run('export', async () => ok(1), { ...opts, group: 'writes' });
		const d = deferred<ReturnType<typeof ok<number>>>();
		const ungrouped = h.controller.run('export', () => d.promise, opts);
		expect(h.controller.isBusy('create-files', 'writes')).toBe(false); // the earlier grouped run left no trace
		d.resolve(ok(2));
		await ungrouped;
	});
});
