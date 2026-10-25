/**
 * The pure parts of the capture windows: what the status bar says, which rows the queue lists and what each
 * row offers, and the activity summary. (The windows themselves are checked in a real Obsidian render.)
 */
import { describe, it, expect } from 'vitest';
import { statusText } from '../src/ui/components/CaptureInboxStatusBar';
import { buildQueue, formatAge, MAX_WAITING_SHOWN, processedCount, queueCounts, rowTitle, settleSeconds, skippedSummary, splitQueue } from '../src/services/captureInbox/captureQueueModel';
import { activitySummary } from '../src/ui/settings/CaptureInboxSettingsSection';
import { upsertEntry } from '../src/services/captureInbox/captureJournal';
import { MAX_AWAITING_REVIEW, emptyCounters, emptyJournal, type CaptureEntry } from '../src/services/captureInbox/captureTypes';
import { en } from '../src/i18n/en';

const mk = (id: string, state: CaptureEntry['state'], over: Partial<CaptureEntry> = {}): CaptureEntry => ({
  id, state, fingerprint: 'f', processingVersion: 1, attempts: 0, createdAt: 1000, updatedAt: 1000, ...over,
});

describe('why a capture is waiting, failed or set aside', () => {
  const t = en.captureInbox;

  it('a settling capture says how long is left, and never a negative number', () => {
    const e = mk('Inbox/s.md', 'waiting_for_stable', { observed: { 'Inbox/s.md': { size: 5, mtime: 1, at: 100_000 } } });
    expect(settleSeconds(e, 103_000, 8000)).toBe(5);
    expect(settleSeconds(e, 200_000, 8000)).toBe(0);
    expect(settleSeconds(mk('Inbox/n.md', 'waiting_for_stable'), 5, 8000)).toBe(8);
    const row = buildQueue(upsertEntry(emptyJournal(), e), 103_000, { stabilityMs: 8000 })[0];
    expect(row.settleSeconds).toBe(5);
    expect(buildQueue(upsertEntry(emptyJournal(), e), 103_000)[0].settleSeconds).toBeUndefined();
  });

  it('a failed row carries its reason, and every stage has guidance that says what to do', () => {
    const j = upsertEntry(emptyJournal(), mk('Inbox/f.md', 'failed', { failedStage: 'transcribe', errorText: 'HTTP 503', retriable: true }));
    expect(buildQueue(j, 2000)[0]).toMatchObject({ errorText: 'HTTP 503', retriable: true });
    for (const stage of ['stability', 'read', 'transcribe', 'digitise', 'classify', 'write', 'organise'] as const) expect(t.failedHelp[stage].length).toBeGreaterThan(20);
  });

  it('a note whose audio was not transcribed because it already had text says so in the queue', () => {
    const att = [{ path: 'Inbox/v.m4a', size: 5, kind: 'audio' as const }];
    const j = upsertEntry(emptyJournal(), mk('Inbox/v.md', 'awaiting_review', { source: 'note-text', attachments: att }));
    expect(buildQueue(j, 2000)[0].audioNotTranscribed).toBe(true);
    const other = upsertEntry(emptyJournal(), mk('Inbox/w.md', 'awaiting_review', { source: 'transcript', attachments: att }));
    expect(buildQueue(other, 2000)[0].audioNotTranscribed).toBe(false);
  });

  it('a long run of waiting captures does not bury the ones that need the user', () => {
    let j = emptyJournal();
    for (let i = 0; i < 27; i++) j = upsertEntry(j, mk(`Inbox/w${i}.md`, 'ready', { createdAt: 1000 + i }));
    for (let i = 0; i < 10; i++) j = upsertEntry(j, mk(`Inbox/r${i}.md`, 'awaiting_review'));
    j = upsertEntry(j, mk('Inbox/e.md', 'waiting_for_stable', { needsConfirm: true }));
    const split = splitQueue(buildQueue(j, 5000));
    expect(split.act).toHaveLength(11);
    expect(split.waiting).toHaveLength(MAX_WAITING_SHOWN);
    expect(split.waitingHidden).toBe(27 - MAX_WAITING_SHOWN);
  });

  it('skipped captures are listed with their reason, newest first; kept-out ones are only counted', () => {
    let j = emptyJournal();
    const skip = (id: string, reason: import('../src/services/captureInbox/captureTypes').SkipReason, at: number) => {
      j = { ...j, tombstones: { ...j.tombstones, [id]: { id, fingerprintHash: 'h', state: 'skipped', at, reason } } };
    };
    skip('Inbox/big.m4a', 'too-large', 1000);
    skip('Inbox/memo.caf', 'unsupported', 2000);
    skip('Private/a.md', 'excluded', 3000);
    skip('Private/b.md', 'excluded', 3000);
    skip('Inbox/photo.png', 'digitisation-off', 500);
    j = { ...j, tombstones: { ...j.tombstones, 'Inbox/old.md': { id: 'Inbox/old.md', fingerprintHash: 'h', state: 'skipped', at: 1 } } };
    j = { ...j, tombstones: { ...j.tombstones, 'Inbox/silent.m4a': { id: 'Inbox/silent.m4a', fingerprintHash: 'h', state: 'skipped', at: 100, reason: 'nothing-to-process' } } };
    const s = skippedSummary(j, 10_000);
    expect(s.excluded).toBe(2);
    expect(s.rows.map((r) => [r.name, r.reason, r.retryable])).toEqual([
      ['memo.caf', 'unsupported', true], ['big.m4a', 'too-large', true], ['photo.png', 'digitisation-off', true],
      // read after a paid call: asking again would only pay again
      ['silent.m4a', 'nothing-to-process', false],
    ]);
    expect(s.rows[0].extension).toBe('caf');
    // every reason has text that says what to do
    for (const reason of Object.keys(t.skipHelp) as Array<keyof typeof t.skipHelp>) expect(t.skipHelp[reason].length).toBeGreaterThan(15);
  });
});

describe('status bar text', () => {
  const t = en.captureInbox;
  it('counts failed captures, which need the user', () => {
    expect(statusText({ toReview: 2, waiting: 0, failed: 1 }, t)).toBe('2 captures to review · 1 failed');
    expect(statusText({ toReview: 0, waiting: 0, failed: 1 }, t)).toBe('1 failed');
  });

  it('is hidden when there is nothing to say', () => {
    expect(statusText({ toReview: 0, waiting: 0 }, t)).toBeNull();
  });
  it('says how many are to review and how many are waiting, pluralised', () => {
    expect(statusText({ toReview: 1, waiting: 0 }, t)).toBe('1 capture to review');
    expect(statusText({ toReview: 3, waiting: 0 }, t)).toBe('3 captures to review');
    expect(statusText({ toReview: 2, waiting: 4 }, t)).toBe('2 captures to review · 4 waiting');
    expect(statusText({ toReview: 0, waiting: 2 }, t)).toBe('2 waiting');
  });
});

describe('queue rows', () => {
  it('lists what the user can act on, awaiting review first, and hides finished work', () => {
    let j = emptyJournal();
    j = upsertEntry(j, mk('Inbox/w.md', 'waiting_for_stable', { createdAt: 5000 }));
    j = upsertEntry(j, mk('Inbox/f.md', 'failed', { failedStage: 'transcribe', attempts: 2 }));
    j = upsertEntry(j, mk('Inbox/r.md', 'awaiting_review', { source: 'transcript' }));
    j = upsertEntry(j, mk('Inbox/o.md', 'organised'));
    j = upsertEntry(j, mk('Inbox/s.md', 'skipped'));
    const rows = buildQueue(j, 10_000);
    // an organised capture whose original still sits in the inbox stays listed until the user marks it processed
    expect(rows.map((r) => r.id)).toEqual(['Inbox/r.md', 'Inbox/f.md', 'Inbox/o.md', 'Inbox/w.md']);
    expect(rows.find((r) => r.id === 'Inbox/o.md')).toMatchObject({ reviewable: true, skippable: false });
  });

  it('marked rows come back on request, last, so the mark can be undone', () => {
    let j = emptyJournal();
    j = upsertEntry(j, mk('Inbox/o.md', 'organised', { processedAt: 5 }));
    j = upsertEntry(j, mk('Inbox/b.md', 'accepted'));
    expect(processedCount(j)).toBe(1);
    const rows = buildQueue(j, 10_000, { includeProcessed: true });
    expect(rows.map((r) => [r.id, r.processed])).toEqual([['Inbox/b.md', false], ['Inbox/o.md', true]]);
    expect(rows[1]).toMatchObject({ reviewable: true });
  });

  it('a capture marked processed drops out of the queue', () => {
    let j = emptyJournal();
    j = upsertEntry(j, mk('Inbox/o.md', 'organised', { processedAt: 5 }));
    j = upsertEntry(j, mk('Inbox/a.md', 'accepted', { processedAt: 5 }));
    j = upsertEntry(j, mk('Inbox/b.md', 'accepted'));
    expect(buildQueue(j, 10_000).map((r) => r.id)).toEqual(['Inbox/b.md']);
  });

  it('offers only the actions that fit the state', () => {
    let j = emptyJournal();
    j = upsertEntry(j, mk('Inbox/r.md', 'awaiting_review'));
    j = upsertEntry(j, mk('Inbox/f.md', 'failed'));
    j = upsertEntry(j, mk('Inbox/a.md', 'accepted'));
    j = upsertEntry(j, mk('Inbox/p.md', 'processing'));
    const by = Object.fromEntries(buildQueue(j, 2000).map((r) => [r.id, r]));
    expect(by['Inbox/r.md']).toMatchObject({ reviewable: true, skippable: true, retriable: false });
    expect(by['Inbox/f.md']).toMatchObject({ reviewable: false, skippable: true, retriable: true });
    expect(by['Inbox/a.md']).toMatchObject({ reviewable: true, skippable: false });
    expect(by['Inbox/p.md']).toMatchObject({ reviewable: false, skippable: false, retriable: false });
  });

  it('a capture edited while it was reviewed is reachable: it can be reviewed (Process again) or skipped', () => {
    const j = upsertEntry(emptyJournal(), mk('Inbox/e.md', 'waiting_for_stable', { needsConfirm: true }));
    expect(buildQueue(j, 2000)[0]).toMatchObject({ reviewable: true, skippable: true, needsConfirm: true });
    const plain = upsertEntry(emptyJournal(), mk('Inbox/w.md', 'waiting_for_stable'));
    expect(buildQueue(plain, 2000)[0]).toMatchObject({ reviewable: false, skippable: false });
  });

  it('titles a row by its note name, or its companion note for a bare capture', () => {
    expect(rowTitle(mk('Inbox/Voice note 2026-10-24.md', 'ready'))).toBe('Voice note 2026-10-24');
    expect(rowTitle(mk('Inbox/memo.m4a', 'accepted', { companionPath: 'Inbox/memo (capture).md' }))).toBe('memo (capture)');
  });

  it('counts, and reports the review backlog limit', () => {
    let j = emptyJournal();
    for (let i = 0; i < MAX_AWAITING_REVIEW; i++) j = upsertEntry(j, mk(`Inbox/r${i}.md`, 'awaiting_review'));
    j = upsertEntry(j, mk('Inbox/w.md', 'waiting_for_stable'));
    j = upsertEntry(j, mk('Inbox/x.md', 'ready'));
    expect(queueCounts(j)).toEqual({ toReview: MAX_AWAITING_REVIEW, failed: 0, settling: 1, ready: 1, waiting: 2, backpressure: true });
    expect(queueCounts(upsertEntry(emptyJournal(), mk('Inbox/n.md', 'new')))).toMatchObject({ settling: 1, waiting: 1 });
    expect(queueCounts(emptyJournal())).toEqual({ toReview: 0, failed: 0, settling: 0, ready: 0, waiting: 0, backpressure: false });
  });

  it('formats ages briefly', () => {
    expect(formatAge(5_000)).toBe('just now');
    expect(formatAge(5 * 60_000)).toBe('5 min');
    expect(formatAge(3 * 3_600_000)).toBe('3 h');
    expect(formatAge(72 * 3_600_000)).toBe('3 d');
  });
});

describe('activity summary', () => {
  it('shows counts only, nothing about content', () => {
    const c = { ...emptyCounters(), processed: 7, acceptedUnchanged: 3, acceptedEdited: 1, rejected: 2, failed: { transcribe: 1, classify: 2 } };
    expect(activitySummary(c, en.captureInbox.activityLine)).toBe('7 processed, 4 accepted, 2 skipped by you, 3 failed.');
  });
});

describe('strings', () => {
  it('every capture string is sentence case (no Title Case Words in a label)', () => {
    const t = en.captureInbox;
    const labels = [t.sectionTitle, t.setupButton, t.runNow, t.reviewButton, t.acceptText, t.runSweep, t.processNow, t.transcribeAnyway, t.processAgain];
    for (const label of labels) {
      const words = label.replace(/\(.*\)/, '').split(' ').slice(1);
      expect(words.filter((w) => /^[A-Z][a-z]/.test(w)), label).toEqual([]);
    }
  });
});
