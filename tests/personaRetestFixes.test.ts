/**
 * Fixes from the independent persona re-test of 1.1.1 (F1-F10; F3 and F11 are pinned beside the code they change).
 * Pure parts only: the windows themselves are checked in a real Obsidian render.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.stubGlobal('window', globalThis);
vi.mock('obsidian', async () => await import('./mocks/obsidian'));

import { CaptureRuntime, SETTLE_RESCAN_SLACK_MS, type RuntimeDeps } from '../src/services/captureInbox/captureRuntime';
import { buildQueue, queueCounts, settleRemainingMs } from '../src/services/captureInbox/captureQueueModel';
import { statusText } from '../src/ui/components/CaptureInboxStatusBar';
import { getEntry, upsertEntry } from '../src/services/captureInbox/captureJournal';
import { runNoticeLines } from '../src/services/captureInbox/runNotice';
import { describeError, formatGuidance, formatGuidanceInSetup } from '../src/core/friendlyErrors';
import { appendSection, findSection, renderSection } from '../src/services/inboxSweep/sweepReport';
import { itemKeys, reportedMatch } from '../src/services/inboxSweep/sweepItemIdentity';
import { buildCandidateIndex } from '../src/services/embedScanService';
import { emptyJournal, type CaptureConfig, type CaptureEntry, type CaptureJournal } from '../src/services/captureInbox/captureTypes';
import { ok, err } from '../src/core/result';
import { en } from '../src/i18n/en';
import type { SweepPolicy } from '../src/services/inboxSweep/sweepGuard';

const t = en.captureInbox;
const mk = (id: string, state: CaptureEntry['state'], over: Partial<CaptureEntry> = {}): CaptureEntry => ({
  id, state, fingerprint: 'f', processingVersion: 1, attempts: 0, createdAt: 1000, updatedAt: 1000, ...over,
});

const config: CaptureConfig = {
  inboxFolders: ['Inbox'], destinationRoot: '', since: 0, onOpen: false, onOpenMaxPerRun: 1, maxPerRun: 10,
  maxAttachmentBytes: 1000, minWords: 3, digitiseImages: false, maxImagesPerCapture: 3, maxTextChars: 12000,
  stabilityMs: 8000, requireMarker: false,
};
const policy: SweepPolicy = { excludedFolders: [], excludedTags: [], excludedProperties: [], excludedTerms: [], protectedFolders: [], maxNoteChars: 20000 };

function world(noteText: string) {
  let journal: CaptureJournal = emptyJournal();
  let clock = 50_000_000;
  const access = {
    get: () => journal,
    mutate: async (fn: (j: CaptureJournal) => CaptureJournal) => ok((journal = fn(journal))),
    mutateLazy: (fn: (j: CaptureJournal) => CaptureJournal) => { journal = fn(journal); return ok(undefined); },
  };
  const deps = {
    journal: access, config: () => config, policy: () => policy, now: () => clock,
    port: { readBytes: async () => ok(new Uint8Array()), stat: async () => ({ size: noteText.length, mtime: 1 }), exists: () => true },
    vault: {
      listFiles: () => [{ path: 'Inbox/a.md', extension: 'md', ctime: 1, mtime: 1, size: noteText.length }],
      readText: async () => ok(noteText), resolveAttachments: () => ({ resolved: [], unresolvedMedia: [] }), referrersOf: () => [],
      digestOf: async () => ok('d'),
    },
    isSwept: async () => false, isEnabled: () => true, digitisationEnabled: () => false, transcribe: async () => err('x'), digitise: async () => err('x'),
    classify: async () => ok({}), taxonomyPrompt: () => '', language: () => 'default', maxTags: () => 3, formatTags: (x: unknown[]) => x.map(String),
    listFolders: () => [], folderAllowed: () => true, writer: {}, isVisible: () => true, autoRunAllowed: () => true, blocker: () => null,
  } as unknown as RuntimeDeps;
  return { deps, journal: () => journal, tick: (ms: number) => { clock += ms; } };
}

afterEach(() => { vi.useRealTimers(); });

describe('F1: a settling capture matures on its own', () => {
  it('re-scans when the window ends: settling becomes ready without Process now', async () => {
    vi.useFakeTimers();
    const w = world('Remember to water the plants');
    const rt = new CaptureRuntime(w.deps);
    await rt.refresh();
    expect(getEntry(w.journal(), 'Inbox/a.md')?.state).toBe('waiting_for_stable');
    // The window ends, and the plugin looks again by itself.
    w.tick(8000);
    await vi.advanceTimersByTimeAsync(8000 + SETTLE_RESCAN_SLACK_MS + 50);
    // The scan hashes with the platform's crypto, which fake timers do not drive: wait for it to land.
    await vi.waitFor(() => expect(getEntry(w.journal(), 'Inbox/a.md')?.state).toBe('ready'));
    rt.dispose();
  });

  it('does not keep re-scanning once nothing is counting down (no loop)', async () => {
    vi.useFakeTimers();
    const w = world('Remember to water the plants');
    const rt = new CaptureRuntime(w.deps);
    await rt.refresh();
    w.tick(8000);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(getEntry(w.journal(), 'Inbox/a.md')?.state).toBe('ready'));
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
    rt.dispose();
  });

  it('an empty note gets its own state and reason, and never arms a re-scan', async () => {
    vi.useFakeTimers();
    const w = world('');
    const rt = new CaptureRuntime(w.deps);
    await rt.refresh();
    const e = getEntry(w.journal(), 'Inbox/a.md')!;
    expect(e).toMatchObject({ state: 'waiting_for_stable', waitReason: 'empty' });
    expect(vi.getTimerCount()).toBe(0);
    const row = buildQueue(w.journal(), 60_000_000, { stabilityMs: 8000 })[0];
    expect(row.waitingForText).toBe(true);
    expect(row.settleSeconds).toBeUndefined();
    // It is neither "settling" nor "working": the status bar has nothing to say about it.
    const counts = queueCounts(w.journal());
    expect(counts).toMatchObject({ settling: 0, waiting: 0, ready: 0 });
    expect(statusText(counts, t)).toBeNull();
    rt.dispose();
  });

  it('settleRemainingMs is the exact figure behind the seconds shown', () => {
    const e = mk('Inbox/s.md', 'waiting_for_stable', { observed: { 'Inbox/s.md': { size: 5, mtime: 1, at: 100_000 } } });
    expect(settleRemainingMs(e, 103_000, 8000)).toBe(5000);
    expect(settleRemainingMs(e, 200_000, 8000)).toBe(0);
  });

  it('the empty-note line says why the note waits', () => {
    expect(t.waitingEmpty).toMatch(/empty/i);
  });
});

describe('F2: a failed tagging step is said plainly', () => {
  it('has guidance with a next step, and a queue flag for the review', () => {
    const g = describeError(en, 'capture-tagging-failed');
    expect(g.message).toMatch(/tags and a folder/);
    expect(g.nextStep.length).toBeGreaterThan(20);
    const failed = upsertEntry(emptyJournal(), mk('Inbox/a.md', 'awaiting_review', { taggingFailed: true }));
    expect(buildQueue(failed, 2000)[0].taggingFailed).toBe(true);
    const fine = upsertEntry(emptyJournal(), mk('Inbox/b.md', 'awaiting_review'));
    expect(buildQueue(fine, 2000)[0].taggingFailed).toBe(false);
  });
});

describe('F4/F5: the run notice and a fresh drop', () => {
  const lines = (review: number, failed: number, skipped: number, ready: number, settling: number, capped: boolean) =>
    runNoticeLines(t, { awaitingReview: review, failed }, skipped, { ready, settling }, capped).join(' ');

  it('a failed capture is not counted as processed', () => {
    const text = lines(0, 1, 0, 0, 0, false);
    expect(text).toBe('0 to review, 1 failed, 0 skipped.');
    expect(text).not.toMatch(/processed/);
  });

  it('"beyond this run\'s limit" is only said when the run really held some back', () => {
    expect(lines(1, 0, 0, 1, 0, true)).toMatch(/beyond this run's limit/);
    const matured = lines(1, 0, 0, 1, 0, false);
    expect(matured).not.toMatch(/limit/);
    expect(matured).toMatch(/1 more is ready now/);
  });

  it('asking for the look yourself trusts a file that sat untouched for the whole window', async () => {
    // mtime 1 is far older than the window: trusted on a look the user asked for, not on a file-event hint.
    const hint = world('Remember to water the plants');
    const hinted = new CaptureRuntime(hint.deps);
    await hinted.refresh();
    expect(getEntry(hint.journal(), 'Inbox/a.md')?.state).toBe('waiting_for_stable');
    const asked = world('Remember to water the plants');
    const askedRt = new CaptureRuntime(asked.deps);
    await askedRt.refresh({ trustMtime: true });
    expect(getEntry(asked.journal(), 'Inbox/a.md')?.state).toBe('ready');
    hinted.dispose();
    askedRt.dispose();
  });
});

describe('F6: the keep-out error inside the setup', () => {
  it('drops the "if you are not in the setup" sentence there, and keeps it on a notice', () => {
    for (const code of ['capture-keepout-required', 'sweep-keepout-required', 'capture-no-folders', 'sweep-no-folders']) {
      const entry = describeError(en, code);
      expect(formatGuidance(entry)).toMatch(/not in the setup/);
      const inside = formatGuidanceInSetup(entry);
      expect(inside).not.toMatch(/not in the setup/);
      expect(inside.startsWith(entry.message)).toBe(true);
      expect(inside.endsWith('.')).toBe(true);
    }
    // Guidance without that sentence is unchanged.
    const plain = describeError(en, 'capture-changed');
    expect(formatGuidanceInSetup(plain)).toBe(formatGuidance(plain));
  });
});

describe('F7: a reworded line, and repeated report headings', () => {
  const known = (quote: string, text: string) => new Set(itemKeys({ text, evidence: quote }));

  it('the same task under a reworded quoted line is flagged as similar, not offered as brand new', () => {
    const before = known('Book the venue', 'Book the venue');
    expect(reportedMatch(before, itemKeys({ text: 'Book the venue (Berlin)', evidence: 'Book the venue (Berlin)' }))).toBe('similar');
    expect(reportedMatch(before, itemKeys({ text: 'Book the venue', evidence: 'book the venue' }))).toBe('exact');
  });

  it('unrelated or very short wording is not flagged', () => {
    const before = known('Book the venue', 'Book the venue');
    expect(reportedMatch(before, itemKeys({ text: 'Call the plumber', evidence: 'Call the plumber' }))).toBeNull();
    expect(reportedMatch(known('Pay', 'Pay rent'), itemKeys({ text: 'Pay tax', evidence: 'Pay tax' }))).toBeNull();
  });

  it('a second section on the same day is numbered, the first stays as it was, and both read back', () => {
    const task = (n: number) => ({ id: `aio-00000000-0000-4000-8000-00000000000${n}`, text: `Task ${n}`, context: '', sourcePath: 'Inbox/n.md' });
    const a = renderSection('run-aaaaaa', '2026-10-25T08:00:00Z', [task(1)]);
    const b = renderSection('run-bbbbbb', '2026-10-25T09:00:00Z', [task(2)]);
    const c = renderSection('run-cccccc', '2026-10-26T09:00:00Z', [task(3)]);
    if (!a.ok || !b.ok || !c.ok) throw new Error('render');
    const first = appendSection('# Report\n', 'run-aaaaaa', a.value);
    if (!first.ok) throw new Error('append');
    const second = appendSection(first.value, 'run-bbbbbb', b.value);
    if (!second.ok) throw new Error('append');
    const third = appendSection(second.value, 'run-cccccc', c.value);
    if (!third.ok) throw new Error('append');
    const headings = third.value.split('\n').filter((l) => l.startsWith('## Sweep'));
    expect(headings).toEqual(['## Sweep 2026-10-25', '## Sweep 2026-10-25 (2)', '## Sweep 2026-10-26']);
    expect(findSection(third.value, 'run-bbbbbb')).toMatchObject({ state: 'ok', ids: [task(2).id] });
    // Idempotent: writing the same run again changes nothing.
    expect(appendSection(third.value, 'run-bbbbbb', b.value)).toEqual({ ok: true, value: third.value });
  });
});

describe('F9: "./" and "../" spellings still name the file', () => {
  it('keeps a file that a note names with a leading ./ or ../ (fail closed)', () => {
    const candidates = buildCandidateIndex(['Attachments/x.pdf', 'Other/y.pdf']);
    expect(candidates('./Attachments/x.pdf')).toEqual(['Attachments/x.pdf']);
    expect(candidates('../Attachments/x.pdf')).toEqual(['Attachments/x.pdf']);
    expect(candidates('../../Attachments/x.pdf')).toEqual(['Attachments/x.pdf']);
    expect(candidates('./x.pdf')).toEqual(['Attachments/x.pdf']);
    expect(candidates('./Elsewhere/x.pdf')).toEqual([]);
  });
});

describe('F7: heading numbering is by the highest number used', () => {
  it('sparse or edited numbering never repeats a number', () => {
    const task = { id: 'aio-00000000-0000-4000-8000-000000000001', text: 'T', context: '', sourcePath: 'Inbox/n.md' };
    const sec = renderSection('run-dddddd', '2026-10-25T09:00:00Z', [task]);
    if (!sec.ok) throw new Error('render');
    const base = '# Report\n\n## Sweep 2026-10-25\n\n## Sweep 2026-10-25 (3)\n';
    const out = appendSection(base, 'run-dddddd', sec.value);
    if (!out.ok) throw new Error('append');
    expect(out.value).toContain('## Sweep 2026-10-25 (4)');
  });
});

describe('F6: every guidance entry is covered', () => {
  it('no guidance next step keeps an "if you are not in the setup" sentence inside the setup', () => {
    for (const entry of Object.values(en.guidance)) expect(formatGuidanceInSetup(entry as { message: string; nextStep: string })).not.toMatch(/not in the setup/i);
  });
});

describe('queue: no countdown once the window has elapsed', () => {
  it('shows no "about 1 s left" for a capture whose window is over', () => {
    const e = mk('Inbox/s.md', 'waiting_for_stable', { observed: { 'Inbox/s.md': { size: 5, mtime: 1, at: 100_000 } } });
    const j = upsertEntry(emptyJournal(), e);
    expect(buildQueue(j, 103_000, { stabilityMs: 8000 })[0].settleSeconds).toBe(5);
    expect(buildQueue(j, 109_000, { stabilityMs: 8000 })[0].settleSeconds).toBeUndefined();
  });
});

describe('F10: the result says what the confirmation said', () => {
  it('"moved to the trash", not "deleted"', () => {
    expect(en.embedScan.deleteSuccess).toMatch(/moved to the trash/);
    expect(en.embedScan.deleteConfirmMessage).toMatch(/moved to trash/);
  });
});
