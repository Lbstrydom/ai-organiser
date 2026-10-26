import { describe, it, expect } from 'vitest';
import { SharingSaver, type Sharing } from '../src/services/aiWorkspaces/sharingSaver';

/** A settings object, a persist that can be held, failed or released by the test, and a record of what happened. */
function rig(start: Sharing) {
  const state: Sharing = { folders: [...start.folders], optIn: start.optIn };
  const calls: Array<{ snapshot: Sharing; resolve(): void; reject(e: Error): void }> = [];
  let running = 0;
  let maxRunning = 0;
  const failures: unknown[] = [];
  const saver = new SharingSaver({
    read: () => ({ folders: [...state.folders], optIn: state.optIn }),
    write: (v) => { state.folders = [...v.folders]; state.optIn = v.optIn; },
    persist: () => new Promise<void>((resolve, reject) => {
      running++; maxRunning = Math.max(maxRunning, running);
      calls.push({ snapshot: { folders: [...state.folders], optIn: state.optIn }, resolve: () => { running--; resolve(); }, reject: (e) => { running--; reject(e); } });
    }),
    onFailed: (e) => { failures.push(e); },
  });
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  return { state, calls, saver, failures, tick, maxRunning: () => maxRunning };
}

describe('SharingSaver', () => {
  it('a failed save with nothing newer waiting restores exactly the last saved state and says so once', async () => {
    const r = rig({ folders: ['A'], optIn: false });
    r.state.folders = ['A', 'B'];
    const p = r.saver.request();
    await r.tick();
    r.calls[0].reject(new Error('disk'));
    await p;
    expect(r.state).toEqual({ folders: ['A'], optIn: false });
    expect(r.failures).toHaveLength(1);
  });

  it('saves never overlap, persist the values as they are at their turn, and a request already covered persists nothing', async () => {
    const r = rig({ folders: [], optIn: false });
    r.state.folders = ['A'];
    const first = r.saver.request();
    r.state.optIn = true;
    const second = r.saver.request();
    await r.tick();
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].snapshot).toEqual({ folders: ['A'], optIn: true });
    r.calls[0].resolve();
    await first;
    await second;
    expect(r.calls).toHaveLength(1);
    expect(r.maxRunning()).toBe(1);
    expect(r.saver.lastSaved).toEqual({ folders: ['A'], optIn: true });
    // a change made while a save is in flight is saved by the next one, after it
    r.state.folders = ['A', 'B'];
    const third = r.saver.request();
    await r.tick();
    r.state.optIn = false;
    const fourth = r.saver.request();
    r.calls[1].resolve();
    await third;
    await r.tick();
    expect(r.calls).toHaveLength(3);
    expect(r.calls[2].snapshot).toEqual({ folders: ['A', 'B'], optIn: false });
    r.calls[2].resolve();
    await fourth;
    expect(r.maxRunning()).toBe(1);
  });

  it('an older failure never undoes a newer change: the newer save is the retry and carries both', async () => {
    const r = rig({ folders: ['A'], optIn: false });
    r.state.folders = ['A', 'B'];
    const older = r.saver.request();
    r.state.optIn = true; // a newer change arrives while the older save is in flight
    const newer = r.saver.request();
    await r.tick();
    r.calls[0].reject(new Error('disk'));
    await older;
    expect(r.state).toEqual({ folders: ['A', 'B'], optIn: true }); // nothing was put back
    expect(r.failures).toHaveLength(0);
    await r.tick();
    expect(r.calls[1].snapshot).toEqual({ folders: ['A', 'B'], optIn: true });
    r.calls[1].resolve();
    await newer;
    expect(r.saver.lastSaved).toEqual({ folders: ['A', 'B'], optIn: true });
  });

  it('if the retry fails too, the last saved state comes back, once', async () => {
    const r = rig({ folders: ['A'], optIn: false });
    r.state.folders = ['A', 'B'];
    const a = r.saver.request();
    r.state.optIn = true;
    const b = r.saver.request();
    await r.tick();
    r.calls[0].reject(new Error('disk'));
    await a;
    await r.tick();
    r.calls[1].reject(new Error('disk'));
    await b;
    expect(r.state).toEqual({ folders: ['A'], optIn: false });
    expect(r.failures).toHaveLength(1);
  });

  it('an older save that succeeded then a newer one that fails restores the older, never the start', async () => {
    const r = rig({ folders: [], optIn: false });
    r.state.folders = ['A'];
    const a = r.saver.request();
    await r.tick();
    r.calls[0].resolve();
    await a;
    r.state.folders = ['A', 'B'];
    const b = r.saver.request();
    await r.tick();
    r.calls[1].reject(new Error('disk'));
    await b;
    expect(r.state).toEqual({ folders: ['A'], optIn: false });
  });

  it('a request that changes nothing persists nothing', async () => {
    const r = rig({ folders: ['A'], optIn: false });
    await r.saver.request();
    expect(r.calls).toHaveLength(0);
  });
});
