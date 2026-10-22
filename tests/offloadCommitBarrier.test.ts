import { describe, it, expect } from 'vitest';
import { evaluateBarrier, type BarrierInput } from '../src/services/offload/commitBarrier';

const good: BarrierInput = {
	referrers: [{ path: 'a.md', status: 'done' }, { path: 'b.canvas', status: 'done' }],
	remoteMatches: true,
	sourceMatches: true,
	protectionOk: true,
	remainingReferences: 0,
	coverageFailures: 0,
	unaccountedEvents: 0,
};

describe('evaluateBarrier', () => {
	it('passes only when every condition holds', () => {
		expect(evaluateBarrier(good)).toEqual({ ok: true });
		expect(evaluateBarrier({ ...good, referrers: [] })).toEqual({ ok: true });
	});

	it.each([
		['a referrer left pending', { referrers: [{ path: 'a.md', status: 'pending' as const }] }, 'referrer-not-done'],
		['a referrer in conflict', { referrers: [{ path: 'a.md', status: 'conflict' as const }] }, 'referrer-not-done'],
		['a skipped referrer', { referrers: [{ path: 'a.md', status: 'skipped' as const }] }, 'referrer-not-done'],
		['the Drive file no longer matching', { remoteMatches: false }, 'remote-mismatch'],
		['the source having changed', { sourceMatches: false }, 'source-changed'],
		['protection', { protectionOk: false }, 'protected'],
		['a coverage failure', { coverageFailures: 1 }, 'scan-incomplete'],
		['a remaining reference', { remainingReferences: 2 }, 'still-referenced'],
		['a vault event during the check', { unaccountedEvents: 1 }, 'vault-changed'],
	])('blocks on %s', (_name, patch, reason) => {
		const res = evaluateBarrier({ ...good, ...patch });
		expect(res).toMatchObject({ ok: false, reason });
	});

	it.each([NaN, -1, 1.5, Infinity, undefined as unknown as number])('does not read an invalid count (%s) as "none"', (bad) => {
		expect(evaluateBarrier({ ...good, remainingReferences: bad })).toMatchObject({ ok: false, reason: 'scan-incomplete' });
		expect(evaluateBarrier({ ...good, coverageFailures: bad })).toMatchObject({ ok: false, reason: 'scan-incomplete' });
		expect(evaluateBarrier({ ...good, unaccountedEvents: bad })).toMatchObject({ ok: false, reason: 'scan-incomplete' });
	});

	it('names the first open referrer and the reference count', () => {
		expect(evaluateBarrier({ ...good, referrers: [{ path: 'x.md', status: 'conflict' }] })).toEqual({ ok: false, reason: 'referrer-not-done', detail: 'x.md' });
		expect(evaluateBarrier({ ...good, remainingReferences: 3 })).toEqual({ ok: false, reason: 'still-referenced', detail: '3' });
	});
});
