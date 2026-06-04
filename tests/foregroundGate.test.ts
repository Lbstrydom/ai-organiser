/**
 * ForegroundGate (D3) — ref-count, leak-safe lease (try/finally release on
 * throw), nested ops, onIdle end→idle transition + unsubscribe.
 */
import { describe, it, expect, vi } from 'vitest';
import { ForegroundGate } from '../src/services/foregroundGate';

describe('ForegroundGate', () => {
    it('isActive flips true during withForeground, false after', async () => {
        const gate = new ForegroundGate();
        expect(gate.isActive()).toBe(false);
        let activeDuring = false;
        await gate.withForeground(async () => { activeDuring = gate.isActive(); });
        expect(activeDuring).toBe(true);
        expect(gate.isActive()).toBe(false);
    });

    it('releases the count even when the op throws (no leak, R1-M3)', async () => {
        const gate = new ForegroundGate();
        await expect(gate.withForeground(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        expect(gate.isActive()).toBe(false);
    });

    it('propagates the resolved value', async () => {
        const gate = new ForegroundGate();
        const v = await gate.withForeground(async () => 42);
        expect(v).toBe(42);
    });

    it('nested ops keep the gate active until the outermost ends', async () => {
        const gate = new ForegroundGate();
        const states: boolean[] = [];
        await gate.withForeground(async () => {
            await gate.withForeground(async () => { /* inner */ });
            states.push(gate.isActive()); // still active after inner ends
        });
        expect(states).toEqual([true]);
        expect(gate.isActive()).toBe(false);
    });

    it('onIdle fires once on the end→idle transition, not on inner release', async () => {
        const gate = new ForegroundGate();
        const idle = vi.fn();
        gate.onIdle(idle);
        await gate.withForeground(async () => {
            await gate.withForeground(async () => { /* inner release: not idle */ });
            expect(idle).not.toHaveBeenCalled();
        });
        expect(idle).toHaveBeenCalledTimes(1);
    });

    it('onIdle unsubscribe stops further notifications', async () => {
        const gate = new ForegroundGate();
        const idle = vi.fn();
        const off = gate.onIdle(idle);
        await gate.withForeground(async () => { /* op */ });
        expect(idle).toHaveBeenCalledTimes(1);
        off();
        await gate.withForeground(async () => { /* op */ });
        expect(idle).toHaveBeenCalledTimes(1);
    });

    it('a throwing idle listener does not strand the gate', async () => {
        const gate = new ForegroundGate();
        gate.onIdle(() => { throw new Error('listener boom'); });
        await gate.withForeground(async () => { /* op */ });
        expect(gate.isActive()).toBe(false);
    });
});
