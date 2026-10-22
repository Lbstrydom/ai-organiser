import { describe, it, expect, vi } from 'vitest';
import { SetupFlow } from '../src/ui/setup/setupFlow';
import { ok, err } from '../src/core/result';

const steps = (...validators: Array<(() => ReturnType<typeof ok<void>> | ReturnType<typeof err<void>>) | undefined>) =>
	validators.map((validate, i) => ({ id: `s${i}`, validate }));

describe('SetupFlow', () => {
	it('walks forward, back, and finishes exactly once', async () => {
		const onFinish = vi.fn(async () => ok(undefined));
		const flow = new SetupFlow(steps(undefined, undefined, undefined), onFinish);
		expect(flow.stepIndex).toBe(0);
		expect((await flow.next()).ok).toBe(true);
		expect((await flow.next()).ok).toBe(true);
		expect(flow.isLast).toBe(true);
		flow.back();
		expect(flow.stepIndex).toBe(1);
		await flow.next();
		const first = await flow.finish();
		const second = await flow.finish();
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(false);
		expect(onFinish).toHaveBeenCalledTimes(1);
		expect(flow.isFinished).toBe(true);
	});

	it('stays on the step and reports the code when local validation fails', async () => {
		const flow = new SetupFlow(steps(() => err('validation-failed'), undefined), async () => ok(undefined));
		const res = await flow.next();
		expect(res).toEqual({ ok: false, error: 'validation-failed' });
		expect(flow.stepIndex).toBe(0);
	});

	it('treats a throwing validator as a failure, not a crash', async () => {
		const flow = new SetupFlow([{ id: 'a', validate: () => { throw new Error('boom'); } }, { id: 'b' }], async () => ok(undefined));
		expect((await flow.next()).ok).toBe(false);
		expect(flow.stepIndex).toBe(0);
	});

	it('never saves after cancel', async () => {
		const onFinish = vi.fn(async () => ok(undefined));
		const flow = new SetupFlow(steps(undefined), onFinish);
		flow.cancel();
		const res = await flow.finish();
		expect(res.ok).toBe(false);
		expect(onFinish).not.toHaveBeenCalled();
		expect(flow.isCancelled).toBe(true);
	});

	it('does not save on Next, only at Finish (single save)', async () => {
		const onFinish = vi.fn(async () => ok(undefined));
		const flow = new SetupFlow(steps(undefined, undefined), onFinish);
		await flow.next();
		expect(onFinish).not.toHaveBeenCalled();
		await flow.finish();
		expect(onFinish).toHaveBeenCalledTimes(1);
	});

	it('lets the user retry after a failed save', async () => {
		let calls = 0;
		const flow = new SetupFlow(steps(undefined), async () => (++calls === 1 ? err('write-failed') : ok(undefined)));
		expect((await flow.finish()).ok).toBe(false);
		expect(flow.isFinished).toBe(false);
		expect((await flow.finish()).ok).toBe(true);
	});

	it('refuses Next on the last step and Finish before it', async () => {
		const flow = new SetupFlow(steps(undefined, undefined), async () => ok(undefined));
		expect((await flow.finish()).ok).toBe(false);
		await flow.next();
		expect((await flow.next()).ok).toBe(false);
	});

	it('requires at least one step', () => {
		expect(() => new SetupFlow([], async () => ok(undefined))).toThrow();
	});
});
