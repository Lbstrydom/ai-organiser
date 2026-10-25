import { describe, it, expect } from 'vitest';
import { outlayOf, selectForRun, type OutlayParams } from '../src/services/captureInbox/runSelection';
import type { ScannedCapture } from '../src/services/captureInbox/captureScanner';
import type { CaptureState } from '../src/services/captureInbox/captureTypes';

const cap = (id: string, ctime: number): ScannedCapture => ({ id, notePath: id, text: '', attachments: [], missingAttachments: [], fingerprint: 'f', ctime });

describe('outlayOf: what one capture really sends', () => {
  const params: OutlayParams = { minWords: 3, digitiseImagesWithText: false, digitisationEnabled: true, maxImages: 3 };
  const withFiles = (text: string, attachments: ScannedCapture['attachments']): ScannedCapture => ({ ...cap('Inbox/n.md', 1), text, attachments });
  const audio = { path: 'Inbox/a.m4a', ext: 'm4a', kind: 'audio' as const, size: 2 * 1024 * 1024 };
  const image = { path: 'Inbox/p.png', ext: 'png', kind: 'image' as const, size: 1000 };

  it('audio under a note that already has text is not sent: the text is', () => {
    expect(outlayOf(withFiles('Typed words for the note', [audio]), params)).toEqual({ sends: true, audioBytes: 0, images: 0 });
    expect(outlayOf(withFiles('', [audio]), params)).toEqual({ sends: true, audioBytes: 2 * 1024 * 1024, images: 0 });
    expect(outlayOf(withFiles('Typed words for the note', [audio]), params, true).audioBytes).toBe(2 * 1024 * 1024);
  });

  it('an image is not counted while image reading is off, and a capture with nothing to read sends nothing', () => {
    expect(outlayOf(withFiles('', [image]), { ...params, digitisationEnabled: false })).toEqual({ sends: false, audioBytes: 0, images: 0 });
    expect(outlayOf(withFiles('', [image]), params)).toEqual({ sends: true, audioBytes: 0, images: 1 });
    expect(outlayOf(withFiles('Typed words for the note', [image]), params).images).toBe(0);
  });
});

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
