import { describe, it, expect } from 'vitest';
import {
    addAlias, alreadyHandled, awaitingCount, bump, bumpBucket, canStartProcessing, decodeJournal, finish,
    getEntry, heldPaths, reconcile, rekey, upsertEntry,
} from '../src/services/captureInbox/captureJournal';
import { MAX_ATTEMPTS, MAX_AWAITING_REVIEW, emptyJournal } from '../src/services/captureInbox/captureTypes';
import type { CaptureEntry, CaptureState } from '../src/services/captureInbox/captureTypes';

const mk = (id: string, state: CaptureState, extra: Partial<CaptureEntry> = {}): CaptureEntry => ({
    id, state, fingerprint: `fp-${id}`, processingVersion: 1, attempts: 0, createdAt: 1, updatedAt: 1, ...extra,
});

describe('capture journal', () => {
    it('upserts and reads entries, resolving a companion alias', () => {
        let j = upsertEntry(emptyJournal(), mk('Inbox/a.md', 'ready'));
        j = addAlias(j, 'Inbox/a.m4a', 'Inbox/a.md');
        expect(getEntry(j, 'Inbox/a.m4a')?.id).toBe('Inbox/a.md');
        expect(getEntry(j, 'Inbox/none.md')).toBeUndefined();
    });

    it('re-keys entries, tombstones and aliases on rename, and is a no-op for unknown ids', () => {
        let j = upsertEntry(emptyJournal(), mk('Inbox/a.md', 'awaiting_review'));
        j = upsertEntry(j, mk('Inbox/b.md', 'accepted'));
        j = finish(j, 'Inbox/b.md', 'accepted', 5);
        j = addAlias(j, 'Inbox/a.m4a', 'Inbox/a.md');
        const r = rekey(j, 'Inbox/a.md', 'Inbox2/a.md');
        expect(r.entries['Inbox2/a.md']?.id).toBe('Inbox2/a.md');
        expect(r.entries['Inbox/a.md']).toBeUndefined();
        expect(r.aliases['Inbox/a.m4a']).toBe('Inbox2/a.md');
        const t = rekey(r, 'Inbox/b.md', 'Inbox2/b.md');
        expect(t.tombstones['Inbox2/b.md']?.id).toBe('Inbox2/b.md');
        expect(rekey(t, 'Nope', 'Other')).toBe(t);
    });

    it('applies backpressure at the awaiting-review limit and counts only waiting entries', () => {
        let j = emptyJournal();
        for (let i = 0; i < MAX_AWAITING_REVIEW - 1; i++) j = upsertEntry(j, mk(`n${i}.md`, 'awaiting_review'));
        j = upsertEntry(j, mk('ready.md', 'ready'));
        expect(awaitingCount(j)).toBe(MAX_AWAITING_REVIEW - 1);
        expect(canStartProcessing(j)).toBe(true);
        j = upsertEntry(j, mk('last.md', 'accept_pending_write'));
        expect(canStartProcessing(j)).toBe(false);
    });

    it('reports held paths: everything before accepted, nothing after', () => {
        let j = emptyJournal();
        j = upsertEntry(j, mk('a.md', 'awaiting_review'));
        j = upsertEntry(j, mk('b.md', 'failed'));
        j = upsertEntry(j, mk('c.md', 'accepted'));
        expect(heldPaths(j).sort()).toEqual(['a.md', 'b.md']);
    });

    it('finish() keeps a compact tombstone with no text', () => {
        let j = upsertEntry(emptyJournal(), mk('a.md', 'awaiting_review', { text: 'secret transcript' }));
        j = finish(j, 'a.md', 'skipped_by_user', 7);
        expect(j.entries['a.md']).toBeUndefined();
        expect(JSON.stringify(j)).not.toContain('secret transcript');
        expect(j.tombstones['a.md']).toMatchObject({ state: 'skipped_by_user', fingerprintHash: 'fp-a.md' });
    });

    it('alreadyHandled: accepted ignores edits; skipped is re-offered only when the fingerprint changes', () => {
        let j = upsertEntry(emptyJournal(), mk('a.md', 'ready'));
        j = finish(j, 'a.md', 'accepted', 1);
        expect(alreadyHandled(j, 'a.md', 'whatever')).toBe(true);
        let k = upsertEntry(emptyJournal(), mk('b.md', 'ready'));
        k = finish(k, 'b.md', 'skipped_by_user', 1);
        expect(alreadyHandled(k, 'b.md', 'fp-b.md')).toBe(true);
        expect(alreadyHandled(k, 'b.md', 'changed')).toBe(false);
        expect(alreadyHandled(k, 'never.md', 'x')).toBe(false);
    });

    it('re-offers a capture skipped under an older exclusion policy when the policy changed', () => {
    let j = upsertEntry(emptyJournal(), mk('a.md', 'ready'));
    j = finish(j, 'a.md', 'skipped', 1, 'rev1');
    expect(alreadyHandled(j, 'a.md', 'fp-a.md', 'rev1')).toBe(true);
    expect(alreadyHandled(j, 'a.md', 'fp-a.md', 'rev2')).toBe(false);
  });

  it('a policy change re-offers a policy skip, but never a capture the user skipped', () => {
    let j = upsertEntry(emptyJournal(), mk('a.md', 'ready'));
    j = finish(j, 'a.md', 'skipped_by_user', 1, 'rev1');
    expect(alreadyHandled(j, 'a.md', 'fp-a.md', 'rev2')).toBe(true);
  });

  it('when tombstones overflow, accepted ones outlive skipped ones', () => {
    let j = upsertEntry(emptyJournal(), mk('keep.md', 'ready'));
    j = finish(j, 'keep.md', 'accepted', 0);
    for (let i = 0; i < 2100; i++) {
      j = upsertEntry(j, mk(`t${i}.md`, 'ready'));
      j = finish(j, `t${i}.md`, 'skipped', i + 10);
    }
    expect(j.tombstones['keep.md']?.state).toBe('accepted');
  });

  it('re-entering an entry removes its tombstone', () => {
        let j = upsertEntry(emptyJournal(), mk('a.md', 'ready'));
        j = finish(j, 'a.md', 'skipped', 1);
        j = upsertEntry(j, mk('a.md', 'new'));
        expect(j.tombstones['a.md']).toBeUndefined();
    });

    it('never prunes non-terminal entries however many tombstones exist', () => {
        let j = upsertEntry(emptyJournal(), mk('keep.md', 'awaiting_review'));
        for (let i = 0; i < 2100; i++) {
            j = upsertEntry(j, mk(`t${i}.md`, 'ready'));
            j = finish(j, `t${i}.md`, 'skipped', i);
        }
        expect(j.entries['keep.md']).toBeDefined();
        expect(Object.keys(j.tombstones).length).toBeLessThanOrEqual(2000);
    });

    it('counts outcomes', () => {
        let j = bump(emptyJournal(), 'processed');
        j = bumpBucket(j, 'failed', 'transcribe');
        j = bumpBucket(j, 'failed', 'transcribe');
        expect(j.counters.processed).toBe(1);
        expect(j.counters.failed.transcribe).toBe(2);
    });

    describe('reconcile', () => {
        it('writes only from accept_pending_write, never from awaiting_review', () => {
            let j = upsertEntry(emptyJournal(), mk('review.md', 'awaiting_review'));
            j = upsertEntry(j, mk('pending.md', 'accept_pending_write'));
            const r = reconcile(j, () => false, 9);
            expect(r.retryWrites).toEqual(['pending.md']);
            expect(r.journal.entries['review.md'].state).toBe('awaiting_review');
        });

        it('marks accept_pending_write accepted when the block is already there, and waits when it cannot tell', () => {
            const j = upsertEntry(emptyJournal(), mk('p.md', 'accept_pending_write'));
            // The entry stays (with its text) so the organised note can still be created; it is simply accepted now.
            expect(reconcile(j, () => true, 9).journal.entries['p.md'].state).toBe('accepted');
            const unsure = reconcile(j, () => undefined, 9);
            expect(unsure.retryWrites).toEqual([]);
            expect(unsure.journal.entries['p.md'].state).toBe('accept_pending_write');
        });

        it('fails an interrupted job at its recorded stage and caps attempts', () => {
            let j = upsertEntry(emptyJournal(), mk('p.md', 'processing', { stage: 'transcribe', attempts: 0 }));
            let r = reconcile(j, () => false, 9);
            expect(r.journal.entries['p.md']).toMatchObject({ state: 'failed', failedStage: 'transcribe', attempts: 1, retriable: true });
            j = upsertEntry(emptyJournal(), mk('q.md', 'processing', { stage: 'classify', attempts: MAX_ATTEMPTS - 1 }));
            r = reconcile(j, () => false, 9);
            expect(r.journal.entries['q.md'].retriable).toBe(false);
        });
    });

  it('decodeJournal FAILS CLOSED on anything stored that it cannot fully read (never an empty journal)', () => {
    const good = { version: 1, entries: { 'a.md': mk('a.md', 'ready') }, tombstones: { ok: { id: 'ok', fingerprintHash: 'h', state: 'accepted', at: 1 } }, aliases: { m: 'a.md' }, counters: { processed: 2, failed: { a: 1 }, skipped: {} } };
    const decoded = decodeJournal(JSON.parse(JSON.stringify(good)));
    expect(decoded.status).toBe('ok');
    const bad: Array<[string, unknown]> = [
      ['not an object', 'garbage'],
      ['an array', []],
      ['unsupported version', { version: 2, entries: {} }],
      ['no entries', { version: 1 }],
      ['null entry', { ...good, entries: { ...good.entries, bad: null } }],
      ['entry without state', { ...good, entries: { 'a.md': { id: 'a.md' } } }],
      ['unknown state', { ...good, entries: { 'a.md': { id: 'a.md', state: 'bogus' } } }],
      ['bad tombstone', { ...good, tombstones: { t: { id: 't' } } }],
      ['bad alias', { ...good, aliases: { m: 7 } }],
      ['bad counter', { ...good, counters: { processed: 'x' } }],
      ['bad counter bucket', { ...good, counters: { failed: { a: 'no' } } }],
    ];
    for (const [name, raw] of bad) expect(decodeJournal(raw).status, name).toBe('corrupt');
  });

  it('nothing stored is a fresh start, and missing optional parts default', () => {
    expect(decodeJournal(undefined).status).toBe('empty');
    expect(decodeJournal(null).status).toBe('empty');
    const minimal = decodeJournal({ version: 1, entries: {} });
    expect(minimal.status).toBe('ok');
    if (minimal.status === 'ok') expect(minimal.journal.counters.processed).toBe(0);
  });

  it('never prunes an accepted tombstone however many skipped ones there are', () => {
    let j = upsertEntry(emptyJournal(), mk('keep.md', 'ready'));
    j = finish(j, 'keep.md', 'accepted', 0);
    for (let i = 0; i < 2100; i++) { j = upsertEntry(j, mk(`s${i}.md`, 'ready')); j = finish(j, `s${i}.md`, 'skipped', i + 5); }
    for (let i = 0; i < 150; i++) { j = upsertEntry(j, mk(`a${i}.md`, 'ready')); j = finish(j, `a${i}.md`, 'accepted', i + 5); }
    expect(j.tombstones['keep.md']?.state).toBe('accepted');
    expect(Object.values(j.tombstones).filter((t) => t.state === 'accepted')).toHaveLength(151);
    expect(Object.values(j.tombstones).filter((t) => t.state === 'skipped').length).toBeLessThanOrEqual(2000);
  });

});
