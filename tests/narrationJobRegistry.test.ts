/**
 * Narration job registry — typed concurrency control.
 */

import { describe, it, expect } from 'vitest';
import { NarrationJobRegistry, JobInFlightError } from '../src/services/audioNarration/narrationJobRegistry';

describe('NarrationJobRegistry', () => {
    it('starts and finishes a job', () => {
        const reg = new NarrationJobRegistry();
        expect(reg.has('a.md')).toBe(false);
        const ac = reg.start('a.md');
        expect(reg.has('a.md')).toBe(true);
        expect(ac).toBeInstanceOf(AbortController);
        reg.finish('a.md');
        expect(reg.has('a.md')).toBe(false);
    });

    it('throws JobInFlightError on duplicate start', () => {
        const reg = new NarrationJobRegistry();
        reg.start('a.md');
        expect(() => reg.start('a.md')).toThrow(JobInFlightError);
    });

    it('different files run concurrently', () => {
        const reg = new NarrationJobRegistry();
        const ac1 = reg.start('a.md');
        const ac2 = reg.start('b.md');
        expect(ac1).not.toBe(ac2);
        expect(reg.size).toBe(2);
    });

    it('cancel() aborts the controller', () => {
        const reg = new NarrationJobRegistry();
        const ac = reg.start('a.md');
        reg.cancel('a.md');
        expect(ac.signal.aborted).toBe(true);
    });

    it('finish() removes entry', () => {
        const reg = new NarrationJobRegistry();
        reg.start('a.md');
        reg.finish('a.md');
        expect(reg.size).toBe(0);
    });

    it('abortAll() aborts every job and clears the registry', () => {
        const reg = new NarrationJobRegistry();
        const ac1 = reg.start('a.md');
        const ac2 = reg.start('b.md');
        reg.abortAll();
        expect(ac1.signal.aborted).toBe(true);
        expect(ac2.signal.aborted).toBe(true);
        expect(reg.size).toBe(0);
    });

    it('finish() after rename uses captured key, not mutated TFile.path', () => {
        // Simulating G3: caller captures jobKey before mutation
        const reg = new NarrationJobRegistry();
        const file = { path: 'a.md' };
        const jobKey = file.path;
        reg.start(jobKey);
        // Simulate file rename
        file.path = 'b.md';
        // Caller must use jobKey, not file.path, for finish
        reg.finish(jobKey);
        expect(reg.size).toBe(0);
    });
});
