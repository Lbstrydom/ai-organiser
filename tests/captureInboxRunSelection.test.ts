import { describe, it, expect } from 'vitest';
import { selectForRun } from '../src/services/captureInbox/runSelection';
import type { ScannedCapture } from '../src/services/captureInbox/captureScanner';
import type { CaptureState } from '../src/services/captureInbox/captureTypes';

const cap = (id: string, ctime: number): ScannedCapture => ({ id, notePath: id, text: '', attachments: [], missingAttachments: [], fingerprint: 'f', ctime });

describe('selectForRun: what a run would really send', () => {
  const states: Record<string, CaptureState> = { a: 'ready', b: 'ready', c: 'waiting_for_stable', d: 'awaiting_review', e: 'failed' };
  const all = [cap('e', 5), cap('c', 4), cap('b', 2), cap('a', 1), cap('d', 3)];

  it('counts only settled captures, oldest first: settling, reviewed and failed ones are not sent', () => {
    const r = selectForRun(all, (id) => states[id], 10);
    expect(r.sent.map((c) => c.id)).toEqual(['a', 'b']);
    expect(r.later).toBe(0);
  });

  it('honours the per-run limit and says how many are left for the next run', () => {
    const many = Array.from({ length: 28 }, (_, i) => cap(`n${i}`, i));
    const r = selectForRun(many, () => 'ready', 10);
    expect(r.sent).toHaveLength(10);
    expect(r.later).toBe(18);
    expect(r.sent[0].id).toBe('n0');
  });

  it('a capture with no entry yet (what the existing-notes box adds) counts as ready', () => {
    const r = selectForRun([cap('old1', 1), cap('a', 2)], (id) => states[id], 10);
    expect(r.sent.map((c) => c.id)).toEqual(['old1', 'a']);
  });

  it('a limit that is not a finite number sends nothing', () => {
    expect(selectForRun(all, (id) => states[id], Number.NaN).sent).toEqual([]);
    expect(selectForRun(all, (id) => states[id], Number.POSITIVE_INFINITY).sent).toEqual([]);
  });

  it('a limit of zero or less sends nothing', () => {
    expect(selectForRun(all, (id) => states[id], 0).sent).toEqual([]);
    expect(selectForRun(all, (id) => states[id], -3).later).toBe(2);
  });
});
