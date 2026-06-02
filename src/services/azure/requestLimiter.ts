/**
 * Request limiter — simple counting semaphore for concurrent Azure requests.
 * Prevents burst storms during batch tagging or index rebuild.
 */

export interface RequestLimiter {
	acquire(): Promise<void>;
	release(): void;
	readonly available: number;
	readonly queueLength: number;
}

/**
 * Simple semaphore with bounded queue.
 * Callers beyond the queue limit receive an immediate rejection.
 */
export class SimpleSemaphore implements RequestLimiter {
	private permits: number;
	private readonly maxPermits: number;
	private readonly maxQueueSize: number;
	private disposed = false;
	// Each waiter carries both a resolve and a reject so a dispose/cancel can
	// clear pending acquirers without leaking a never-settled promise.
	private readonly waitQueue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

	constructor(maxConcurrent = 5, maxQueueSize = 20) {
		this.permits = maxConcurrent;
		this.maxPermits = maxConcurrent;
		this.maxQueueSize = maxQueueSize;
	}

	get available(): number {
		return this.permits;
	}

	get queueLength(): number {
		return this.waitQueue.length;
	}

	async acquire(): Promise<void> {
		if (this.disposed) {
			throw new Error('Request limiter has been disposed.');
		}

		if (this.permits > 0) {
			this.permits--;
			return;
		}

		if (this.waitQueue.length >= this.maxQueueSize) {
			throw new Error('Request queue full — too many concurrent requests. Try again later.');
		}

		// Queued acquirer: the permit is handed over directly on release(), so the
		// waiter does NOT decrement permits itself (that would double-count).
		return new Promise<void>((resolve, reject) => {
			this.waitQueue.push({ resolve, reject });
		});
	}

	release(): void {
		// Transfer the held permit directly to the next waiter when one exists:
		// net permits unchanged (one task hands off to another). Decrementing
		// inside the waiter — as the old code did — drove the counter negative.
		if (this.waitQueue.length > 0) {
			const next = this.waitQueue.shift()!;
			next.resolve();
			return;
		}

		// No waiters — return the permit to the pool, capped at the maximum.
		this.permits = Math.min(this.permits + 1, this.maxPermits);
	}

	/**
	 * Cancel all queued acquirers and block further acquires.
	 * Prevents a pending acquire() from leaking when the owning service is
	 * aborted/torn down. Already-acquired permits are unaffected.
	 */
	dispose(reason = 'Request limiter disposed before acquire could complete.'): void {
		this.disposed = true;
		const pending = this.waitQueue.splice(0, this.waitQueue.length);
		for (const waiter of pending) {
			waiter.reject(new Error(reason));
		}
	}
}
