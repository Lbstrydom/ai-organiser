import { describe, it, expect } from 'vitest';
import { SimpleSemaphore } from '../src/services/azure/requestLimiter';

describe('SimpleSemaphore', () => {
	it('acquires down to zero permits', async () => {
		const sem = new SimpleSemaphore(2, 10);
		expect(sem.available).toBe(2);
		await sem.acquire();
		expect(sem.available).toBe(1);
		await sem.acquire();
		expect(sem.available).toBe(0);
	});

	it('queues an acquire when permits are exhausted and resolves it on release', async () => {
		const sem = new SimpleSemaphore(1, 10);
		await sem.acquire(); // permits -> 0
		expect(sem.available).toBe(0);

		let resolved = false;
		const queued = sem.acquire().then(() => {
			resolved = true;
		});
		expect(sem.queueLength).toBe(1);
		expect(resolved).toBe(false);

		sem.release(); // hands the permit to the queued waiter
		await queued;
		expect(resolved).toBe(true);
		// Permit transferred (net unchanged): still held by the waiter, none returned to pool.
		expect(sem.available).toBe(0);
		expect(sem.queueLength).toBe(0);
	});

	it('never exceeds max permits across release with no waiters', () => {
		const sem = new SimpleSemaphore(2, 10);
		// Releasing without ever acquiring must not inflate the pool.
		sem.release();
		sem.release();
		sem.release();
		expect(sem.available).toBe(2);
	});

	it('never goes negative across interleaved acquire/release', async () => {
		const sem = new SimpleSemaphore(2, 10);
		await sem.acquire(); // 1
		await sem.acquire(); // 0

		// Two queued acquirers while at zero.
		let aResolved = false;
		let bResolved = false;
		const a = sem.acquire().then(() => { aResolved = true; });
		const b = sem.acquire().then(() => { bResolved = true; });
		expect(sem.queueLength).toBe(2);
		expect(sem.available).toBe(0);

		sem.release(); // transfers to A
		await a;
		expect(aResolved).toBe(true);
		expect(sem.available).toBe(0); // still no spare permit — never negative
		expect(sem.queueLength).toBe(1);

		sem.release(); // transfers to B
		await b;
		expect(bResolved).toBe(true);
		expect(sem.available).toBe(0);
		expect(sem.queueLength).toBe(0);

		// Now everyone "finishes" — 3 holders release with no waiters.
		sem.release();
		sem.release();
		sem.release();
		// 4 acquires happened (2 immediate + 2 queued); all finishing returns to max, capped.
		expect(sem.available).toBe(2);
		expect(sem.available).toBeGreaterThanOrEqual(0);
	});

	it('rejects when the queue is full', async () => {
		const sem = new SimpleSemaphore(1, 1);
		await sem.acquire(); // permits -> 0
		const queued = sem.acquire(); // fills the single queue slot
		expect(sem.queueLength).toBe(1);
		await expect(sem.acquire()).rejects.toThrow(/queue full/i);
		// settle the queued one to avoid an unhandled pending promise
		sem.release();
		await queued;
	});

	it('dispose() rejects queued acquirers and blocks further acquires', async () => {
		const sem = new SimpleSemaphore(1, 10);
		await sem.acquire(); // permits -> 0
		const queued = sem.acquire();
		expect(sem.queueLength).toBe(1);

		sem.dispose();
		await expect(queued).rejects.toThrow(/dispose/i);
		expect(sem.queueLength).toBe(0);

		// Further acquires are blocked.
		await expect(sem.acquire()).rejects.toThrow(/disposed/i);
	});
});
