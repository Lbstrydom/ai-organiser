import { describe, it, expect } from 'vitest';
import { assess, observationsChanged, recordSelfWrite, sameAsObserved } from '../src/services/captureInbox/stabilityTracker';

const W = 8000;

describe('stability tracker', () => {
  it('waits on first sight of a fresh file, then becomes ready once unchanged for the window', () => {
    const first = assess(undefined, { 'a.md': { size: 10, mtime: 1000 } }, 1500, W);
    expect(first.verdict).toEqual({ kind: 'waiting', reason: 'first-sight' });
    const early = assess(first.observed, { 'a.md': { size: 10, mtime: 1000 } }, 1500 + W - 1, W);
    expect(early.verdict).toEqual({ kind: 'waiting', reason: 'window' });
    const later = assess(early.observed, { 'a.md': { size: 10, mtime: 1000 } }, 1500 + W, W);
    expect(later.verdict).toEqual({ kind: 'ready' });
  });

  it('keeps the original observation time so the window can actually elapse', () => {
    const first = assess(undefined, { 'a.md': { size: 10, mtime: 1000 } }, 1500, W);
    const second = assess(first.observed, { 'a.md': { size: 10, mtime: 1000 } }, 3000, W);
    expect(second.observed['a.md'].at).toBe(1500);
  });

  it('treats a file already untouched for the whole window as stable at first sight (cold start)', () => {
    const r = assess(undefined, { 'a.md': { size: 10, mtime: 1000 } }, 1000 + W + 1, W);
    expect(r.verdict).toEqual({ kind: 'ready' });
  });

  it('resets the window when size or mtime changed', () => {
    const first = assess(undefined, { 'a.md': { size: 10, mtime: 1000 } }, 1000 + W + 1, W);
    const changed = assess(first.observed, { 'a.md': { size: 20, mtime: 1000 } }, 20000, W);
    expect(changed.verdict).toEqual({ kind: 'waiting', reason: 'changed' });
    expect(changed.observed['a.md'].at).toBe(20000);
  });

  it('waits for an attachment that has not arrived yet, or is zero bytes', () => {
    const base = { 'a.md': { size: 10, mtime: 1 } };
    expect(assess(undefined, { ...base, 'a.m4a': null }, 99999, W).verdict).toEqual({ kind: 'waiting', reason: 'missing' });
    expect(assess(undefined, { ...base, 'a.m4a': { size: 0, mtime: 1 } }, 99999, W).verdict).toEqual({ kind: 'waiting', reason: 'empty' });
  });

  it('needs EVERY file stable, not just the note', () => {
    const now = 100000;
    const r = assess(undefined, { 'a.md': { size: 1, mtime: 1 }, 'a.m4a': { size: 5, mtime: now - 10 } }, now, W);
    expect(r.verdict.kind).toBe('waiting');
  });

  it('no files at all is not ready', () => {
    expect(assess(undefined, {}, 99999, W).verdict).toEqual({ kind: 'waiting', reason: 'empty' });
  });

  it('a file event hint does not trust an old mtime (a half-synced file keeps the source mtime)', () => {
    const old = { 'a.m4a': { size: 10, mtime: 1000 } };
    expect(assess(undefined, old, 1000 + W + 1, W, true).verdict).toEqual({ kind: 'ready' });
    expect(assess(undefined, old, 1000 + W + 1, W, false).verdict).toEqual({ kind: 'waiting', reason: 'first-sight' });
  });

  it('does not treat an unknown mtime as proof of stability', () => {
    const r = assess(undefined, { 'a.md': { size: 10, mtime: 0 } }, 99999, W);
    expect(r.verdict).toEqual({ kind: 'waiting', reason: 'first-sight' });
  });

  it('suppresses the plugin\'s own write: a recorded self-write matches and counts as old', () => {
    const obs = recordSelfWrite({}, 'a.md', { size: 50, mtime: 777 });
    expect(sameAsObserved(obs['a.md'], { size: 50, mtime: 777 })).toBe(true);
    expect(sameAsObserved(obs['a.md'], { size: 51, mtime: 777 })).toBe(false);
    expect(assess(obs, { 'a.md': { size: 50, mtime: 777 } }, 1_000_000, W).verdict).toEqual({ kind: 'ready' });
  });

  it('coalesces persistence: only a size or mtime difference is worth a write', () => {
    const a = { 'a.md': { size: 1, mtime: 1, at: 10 } };
    expect(observationsChanged(a, { 'a.md': { size: 1, mtime: 1, at: 20 } })).toBe(false);
    expect(observationsChanged(a, { 'a.md': { size: 2, mtime: 1, at: 20 } })).toBe(true);
    expect(observationsChanged(undefined, a)).toBe(true);
  });
});
