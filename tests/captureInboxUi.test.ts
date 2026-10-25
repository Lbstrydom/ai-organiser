/**
 * The pure parts of the capture windows: what the status bar says, which rows the queue lists and what each
 * row offers, and the activity summary. (The windows themselves are checked in a real Obsidian render.)
 */
import { describe, it, expect } from 'vitest';
import { statusText } from '../src/ui/components/CaptureInboxStatusBar';
import { buildQueue, formatAge, processedCount, queueCounts, rowTitle } from '../src/services/captureInbox/captureQueueModel';
import { activitySummary } from '../src/ui/settings/CaptureInboxSettingsSection';
import { upsertEntry } from '../src/services/captureInbox/captureJournal';
import { MAX_AWAITING_REVIEW, emptyCounters, emptyJournal, type CaptureEntry } from '../src/services/captureInbox/captureTypes';
import { en } from '../src/i18n/en';

const mk = (id: string, state: CaptureEntry['state'], over: Partial<CaptureEntry> = {}): CaptureEntry => ({
  id, state, fingerprint: 'f', processingVersion: 1, attempts: 0, createdAt: 1000, updatedAt: 1000, ...over,
});

describe('status bar text', () => {
  const t = en.captureInbox;
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
    expect(queueCounts(j)).toEqual({ toReview: MAX_AWAITING_REVIEW, waiting: 2, backpressure: true });
    expect(queueCounts(emptyJournal())).toEqual({ toReview: 0, waiting: 0, backpressure: false });
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
