import { describe, it, expect } from 'vitest';
import {
  acceptCapture, createOrganisedNote, retryPendingWrites, skipCapture, ORGANISED_FROM_KEY,
  type JournalAccess, type WriterDeps, type WriterPort,
} from '../src/services/captureInbox/captureWriter';
import { getEntry, upsertEntry } from '../src/services/captureInbox/captureJournal';
import { computeFingerprint, stripCaptureInsertions, normaliseForFingerprint } from '../src/services/captureInbox/enrichmentBlock';
import { ok, err, type Result } from '../src/core/result';
import { emptyJournal, type CaptureConfig, type CaptureEntry, type CaptureJournal } from '../src/services/captureInbox/captureTypes';
import type { SweepPolicy } from '../src/services/inboxSweep/sweepGuard';

const config: CaptureConfig = {
  inboxFolders: ['Inbox'], destinationRoot: 'Areas', since: 0, onOpen: false, onOpenMaxPerRun: 3, maxPerRun: 10,
  maxAttachmentBytes: 10 * 1024 * 1024, minWords: 3, digitiseImages: false, maxImagesPerCapture: 3, maxTextChars: 12000,
  stabilityMs: 8000, requireMarker: false,
};
const policy: SweepPolicy = { excludedFolders: [], excludedTags: [], excludedProperties: [], excludedTerms: ['acme'], protectedFolders: ['Protected'], maxNoteChars: 20000 };

class FakePort implements WriterPort {
  files = new Map<string, string>();
  folders = new Set<string>(['Areas', 'Areas/Home', 'Protected', 'Inbox']);
  sizes = new Map<string, number>();
  creates: string[] = [];
  edits = 0;
  /** Simulates a concurrent edit landing between the pre-check and the commit */
  raceEdit: ((text: string) => string) | null = null;
  async readNote(p: string) { return this.files.get(p) ?? null; }
  async editNote(p: string, baseline: string, recompute: (c: string) => Result<{ content: string }>) {
    if (this.raceEdit) this.files.set(p, this.raceEdit(this.files.get(p) ?? ''));
    const r = recompute(this.files.get(p) ?? '');
    if (!r.ok) return err<void>(r.error);
    this.files.set(p, r.value.content);
    this.edits++;
    void baseline;
    return ok(undefined);
  }
  async createNote(p: string, content: string) {
    if (this.files.has(p)) return err<string>('capture-write-failed');
    this.files.set(p, content);
    this.creates.push(p);
    return ok(p);
  }
  pathExists(p: string) { return this.files.has(p); }
  folderExists(p: string) { return this.folders.has(p); }
  async fileSize(p: string) { return this.sizes.get(p) ?? null; }
  async fileDigest(p: string) { return this.sizes.has(p) ? `d:${this.sizes.get(p)}` : null; }
  findNoteByFrontmatter(key: string, value: string) {
    for (const [path, text] of this.files) if (new RegExp(`^${key}: ${JSON.stringify(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|^${key}: ${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(text)) return path;
    return null;
  }
}

function setup(over: { swept?: boolean; port?: FakePort } = {}) {
  const port = over.port ?? new FakePort();
  let journal: CaptureJournal = emptyJournal();
  const access: JournalAccess = { get: () => journal, mutate: async (fn) => (journal = fn(journal)) };
  const deps: WriterDeps = {
    port, journal: access, config: () => config, policy: () => policy, isSwept: async () => !!over.swept,
    protectedFolders: () => ['Protected'], outputRoots: () => ['Sweep Reports'], now: () => 1234,
  };
  return { port, deps, access, get journal() { return journal; }, set(j: CaptureJournal) { journal = j; } };
}

async function seedNote(s: ReturnType<typeof setup>, over: Partial<CaptureEntry> = {}, text = 'Buy milk and eggs tomorrow\n') {
  const id = 'Inbox/Voice note.md';
  s.port.files.set(id, text);
  s.port.sizes.set('Inbox/Voice note.m4a', 99);
  const attachments = [{ path: 'Inbox/Voice note.m4a', size: 99, kind: 'audio' as const }];
  const fingerprint = await computeFingerprint(text, attachments);
  const entry: CaptureEntry = {
    id, state: 'awaiting_review', fingerprint, processingVersion: 1, attempts: 0, createdAt: 1, updatedAt: 1, hasNote: true,
    source: 'transcript', text: 'Remind me to call the plumber', noteText: 'Buy milk and eggs tomorrow', attachments,
    proposal: { title: 'Call plumber', tags: ['home'], folder: 'Areas/Home' }, ...over,
  };
  s.set(upsertEntry(s.journal, entry));
  return { id, text, entry };
}

describe('acceptCapture (note)', () => {
  it('writes one block and two keys, by insertion only, and marks the capture accepted', async () => {
    const s = setup();
    const { id, text } = await seedNote(s);
    const r = await acceptCapture(s.deps, id);
    expect(r.ok).toBe(true);
    const after = s.port.files.get(id)!;
    expect(after).toContain('<!-- aio:capture -->');
    expect(after).toContain('capture-id: Inbox/Voice note.md');
    expect(after).toContain('Remind me to call the plumber');
    expect(s.port.edits).toBe(1);
    expect(normaliseForFingerprint(stripCaptureInsertions(after, getEntry(s.journal, id)!.inserted!))).toBe(normaliseForFingerprint(text));
    expect(getEntry(s.journal, id)!.state).toBe('accepted');
    expect(s.journal.counters.acceptedUnchanged).toBe(1);
  });

  it('counts an edited accept separately and writes the EDITED text', async () => {
    const s = setup();
    const { id } = await seedNote(s);
    await acceptCapture(s.deps, id, { machineText: 'Call the plumber on Tuesday' });
    expect(s.port.files.get(id)).toContain('Call the plumber on Tuesday');
    expect(s.journal.counters.acceptedEdited).toBe(1);
  });

  it('refuses and writes nothing when the note was edited after processing', async () => {
    const s = setup();
    const { id } = await seedNote(s);
    s.port.files.set(id, 'Buy milk and eggs tomorrow\nand bread\n');
    const r = await acceptCapture(s.deps, id);
    expect(r).toEqual({ ok: false, error: 'capture-changed' });
    expect(s.port.files.get(id)).toBe('Buy milk and eggs tomorrow\nand bread\n');
    expect(getEntry(s.journal, id)!.state).toBe('awaiting_review');
    expect(s.port.edits).toBe(0);
  });

  it('refuses when an attachment was replaced (size changed) or is gone', async () => {
    const s = setup();
    const { id } = await seedNote(s);
    s.port.sizes.set('Inbox/Voice note.m4a', 100);
    expect(await acceptCapture(s.deps, id)).toEqual({ ok: false, error: 'capture-changed' });
    s.port.sizes.delete('Inbox/Voice note.m4a');
    expect(await acceptCapture(s.deps, id)).toEqual({ ok: false, error: 'capture-changed' });
    expect(s.port.edits).toBe(0);
  });

  it('refuses when the inbox sweep read the note in the meantime', async () => {
    const s = setup({ swept: true });
    const { id } = await seedNote(s);
    expect(await acceptCapture(s.deps, id)).toEqual({ ok: false, error: 'capture-swept' });
    expect(s.port.edits).toBe(0);
  });

  it('skips (and writes nothing) when the edited machine text now matches a kept-out term', async () => {
    const s = setup();
    const { id } = await seedNote(s);
    const r = await acceptCapture(s.deps, id, { machineText: 'Call ACME about the invoice' });
    expect(r.ok).toBe(false);
    expect(s.port.edits).toBe(0);
    expect(getEntry(s.journal, id)).toBeUndefined();
    expect(s.journal.tombstones[id].state).toBe('skipped');
  });

  it('refuses inside the atomic commit when the text changed after the pre-check (race)', async () => {
    const s = setup();
    const { id } = await seedNote(s);
    s.port.raceEdit = (t) => `${t}typed while accepting\n`;
    const r = await acceptCapture(s.deps, id);
    expect(r).toEqual({ ok: false, error: 'capture-changed' });
    expect(s.port.files.get(id)).not.toContain('aio:capture');
    expect(getEntry(s.journal, id)!.state).toBe('awaiting_review');
  });

  it('refuses a foreign block (another device accepted first) and a marker conflict', async () => {
    const s = setup();
    const { id } = await seedNote(s);
    s.port.files.set(id, 'Buy milk and eggs tomorrow\n<!-- aio:capture -->\nno end\n');
    const r = await acceptCapture(s.deps, id);
    expect(r.ok).toBe(false);
    expect(s.port.edits).toBe(0);
  });

  it('only accepts an entry that is awaiting review', async () => {
    const s = setup();
    const { id } = await seedNote(s, { state: 'ready' });
    expect(await acceptCapture(s.deps, id)).toEqual({ ok: false, error: 'capture-changed' });
    expect(await acceptCapture(s.deps, 'Inbox/none.md')).toEqual({ ok: false, error: 'capture-changed' });
  });

  it('recovers a write that was in flight: a pending entry is accepted again, writing once', async () => {
    const s = setup();
    const { id } = await seedNote(s, { state: 'accept_pending_write' });
    await retryPendingWrites(s.deps, [id]);
    expect(s.port.edits).toBe(1);
    expect(getEntry(s.journal, id)!.state).toBe('accepted');
    await retryPendingWrites(s.deps, [id]);
    expect(s.port.edits).toBe(1);
  });
});

describe('audit regressions (writer)', () => {
  it('a double click writes once and leaves the capture accepted (no regression to review)', async () => {
    const s = setup();
    const { id } = await seedNote(s);
    const [a, b] = await Promise.all([acceptCapture(s.deps, id), acceptCapture(s.deps, id)]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(b.ok ? a : b).toEqual({ ok: false, error: 'capture-busy' });
    expect(s.port.edits).toBe(1);
    expect(getEntry(s.journal, id)!.state).toBe('accepted');
    expect(s.journal.counters.acceptedUnchanged).toBe(1);
  });

  it('two organise clicks create one note', async () => {
    const s = setup();
    const { id } = await seedNote(s);
    await acceptCapture(s.deps, id);
    const results = await Promise.all([createOrganisedNote(s.deps, id), createOrganisedNote(s.deps, id)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(s.port.creates.filter((p) => p.startsWith('Areas/'))).toHaveLength(1);
  });

  it('only recovery may resume a pending write; a normal Accept refuses it', async () => {
    const s = setup();
    const { id } = await seedNote(s, { state: 'accept_pending_write' });
    expect(await acceptCapture(s.deps, id)).toEqual({ ok: false, error: 'capture-changed' });
    expect(s.port.edits).toBe(0);
  });

  it('does not write when the write-ahead marker could not be saved', async () => {
    const s = setup();
    const { id } = await seedNote(s);
    const realMutate = s.access.mutate;
    s.access.mutate = async (fn, opts) => {
      if (opts?.durable) throw new Error('capture-journal-unsaved');
      return realMutate(fn, opts);
    };
    const r = await acceptCapture(s.deps, id);
    expect(r).toEqual({ ok: false, error: 'capture-write-failed' });
    expect(s.port.edits).toBe(0);
    expect(getEntry(s.journal, id)!.state).toBe('awaiting_review');
  });

  it('writes the stable uid, not the path, into the note', async () => {
    const s = setup();
    const { id } = await seedNote(s, { uid: '11111111-2222-3333-4444-555555555555' });
    await acceptCapture(s.deps, id);
    expect(s.port.files.get(id)).toContain('capture-id: 11111111-2222-3333-4444-555555555555');
  });

  it('recovers after a rename between the write and the journal update: the uid still matches', async () => {
    const s = setup();
    const { id } = await seedNote(s, { uid: '11111111-2222-3333-4444-555555555555' });
    await acceptCapture(s.deps, id);
    const text = s.port.files.get(id)!;
    s.port.files.delete(id);
    s.port.files.set('Inbox/Renamed.md', text);
    expect(text).toContain('11111111-2222-3333-4444-555555555555');
    // a second device or a retry sees the block and the same uid: a no-op, not a conflict
    const entry = { ...getEntry(s.journal, id)!, id: 'Inbox/Renamed.md', state: 'awaiting_review' as const };
    s.set(upsertEntry(emptyJournal(), entry));
    s.port.sizes.set('Inbox/Voice note.m4a', 99);
    const r = await acceptCapture(s.deps, 'Inbox/Renamed.md');
    expect(r.ok).toBe(true);
    expect(s.port.edits).toBe(1);
  });
});

describe('acceptCapture (bare media)', () => {
  async function seedMedia(s: ReturnType<typeof setup>) {
    const id = 'Inbox/memo.m4a';
    s.port.sizes.set(id, 500);
    const attachments = [{ path: id, size: 500, kind: 'audio' as const }];
    const fingerprint = await computeFingerprint('', attachments);
    s.set(upsertEntry(s.journal, {
      id, state: 'awaiting_review', fingerprint, processingVersion: 1, attempts: 0, createdAt: 1, updatedAt: 1, hasNote: false,
      source: 'transcript', text: 'Remember the dentist', attachments, proposal: { title: 'Dentist', tags: [], folder: null },
    }));
    return id;
  }

  it('creates the companion note once, with the embed, block and keys; the media is never touched', async () => {
    const s = setup();
    const id = await seedMedia(s);
    const r = await acceptCapture(s.deps, id);
    expect(r.ok).toBe(true);
    expect(s.port.creates).toEqual(['Inbox/memo (capture).md']);
    const note = s.port.files.get('Inbox/memo (capture).md')!;
    expect(note).toContain('![[Inbox/memo.m4a]]');
    expect(note).toContain('Remember the dentist');
    expect(note).toContain('capture-id: Inbox/memo.m4a');
    expect(s.journal.aliases[id]).toBe('Inbox/memo (capture).md');
    expect(getEntry(s.journal, 'Inbox/memo (capture).md')!.state).toBe('accepted');
    expect(s.port.edits).toBe(0);
  });

  it('never overwrites an existing file and finds its own companion after a crash', async () => {
    const s = setup();
    const id = await seedMedia(s);
    s.port.files.set('Inbox/memo (capture).md', 'someone else');
    await acceptCapture(s.deps, id);
    expect(s.port.files.get('Inbox/memo (capture).md')).toBe('someone else');
    expect(s.port.creates).toEqual(['Inbox/memo (capture)_2.md']);
  });

  it('does not adopt a foreign file that merely sits at the journalled companion path', async () => {
    const s = setup();
    const id = await seedMedia(s);
    s.set(upsertEntry(s.journal, { ...getEntry(s.journal, id)!, companionPath: 'Inbox/memo (capture).md' }));
    s.port.files.set('Inbox/memo (capture).md', 'a note someone else wrote');
    await acceptCapture(s.deps, id);
    expect(s.port.files.get('Inbox/memo (capture).md')).toBe('a note someone else wrote');
    expect(s.port.creates).toEqual(['Inbox/memo (capture)_2.md']);
  });

  it('adopts an existing companion found by capture-id instead of creating a second', async () => {
    const s = setup();
    const id = await seedMedia(s);
    s.port.files.set('Inbox/memo (capture).md', '---\ncapture-id: Inbox/memo.m4a\n---\nalready here\n');
    await acceptCapture(s.deps, id);
    expect(s.port.creates).toEqual([]);
    expect(s.journal.aliases[id]).toBe('Inbox/memo (capture).md');
  });
});

describe('createOrganisedNote', () => {
  async function accepted(s: ReturnType<typeof setup>) {
    const { id } = await seedNote(s);
    await acceptCapture(s.deps, id);
    return id;
  }

  it('creates a new note with the text, tags and a back-link, and leaves the original alone', async () => {
    const s = setup();
    const id = await accepted(s);
    const original = s.port.files.get(id);
    const r = await createOrganisedNote(s.deps, id);
    expect(r).toEqual({ ok: true, value: 'Areas/Home/Call plumber.md' });
    const note = s.port.files.get('Areas/Home/Call plumber.md')!;
    expect(note).toContain(`${ORGANISED_FROM_KEY}: "Inbox/Voice note.md"`);
    expect(note).toContain('tags: ["home"]');
    expect(note).toContain('Buy milk and eggs tomorrow');
    expect(note).toContain('Remind me to call the plumber');
    expect(note).toContain('Source: [[Inbox/Voice note.md]]');
    expect(s.port.files.get(id)).toBe(original);
    expect(getEntry(s.journal, id)!.state).toBe('organised');
  });

  it('is idempotent: a double click or a crash creates one note', async () => {
    const s = setup();
    const id = await accepted(s);
    await createOrganisedNote(s.deps, id);
    await createOrganisedNote(s.deps, id);
    expect(s.port.creates.filter((p) => p.startsWith('Areas/'))).toHaveLength(1);
    // crash after create, before the journal update: the note is found by its frontmatter key
    const s2 = setup();
    const id2 = await accepted(s2);
    s2.port.files.set('Areas/Home/Call plumber.md', `---\n${ORGANISED_FROM_KEY}: "Inbox/Voice note.md"\n---\nx`);
    const r = await createOrganisedNote(s2.deps, id2);
    expect(r).toEqual({ ok: true, value: 'Areas/Home/Call plumber.md' });
    expect(s2.port.creates.filter((p) => p.startsWith('Areas/'))).toHaveLength(0);
  });

  it('never overwrites an unrelated note with the same title', async () => {
    const s = setup();
    const id = await accepted(s);
    s.port.files.set('Areas/Home/Call plumber.md', 'mine');
    const r = await createOrganisedNote(s.deps, id);
    expect(r).toEqual({ ok: true, value: 'Areas/Home/Call plumber_2.md' });
    expect(s.port.files.get('Areas/Home/Call plumber.md')).toBe('mine');
  });

  it('refuses a destination outside the root, protected, missing, inside the inbox, or none', async () => {
    const s = setup();
    const id = await accepted(s);
    for (const folder of ['Elsewhere', 'Protected', 'Areas/Nope', 'Inbox', null]) {
      expect(await createOrganisedNote(s.deps, id, { folder })).toEqual({ ok: false, error: 'capture-destination-refused' });
    }
    expect(s.port.creates.filter((p) => p.startsWith('Areas/'))).toHaveLength(0);
  });

  it('sanitises a hostile title', async () => {
    const s = setup();
    const id = await accepted(s);
    const r = await createOrganisedNote(s.deps, id, { title: '../../Protected/evil: [[x]]' });
    expect(r.ok && r.value).toBe('Areas/Home/Protected evil x.md');
  });

  it('needs an accepted capture', async () => {
    const s = setup();
    const { id } = await seedNote(s);
    expect(await createOrganisedNote(s.deps, id)).toEqual({ ok: false, error: 'capture-changed' });
  });
});

describe('same-size attachment swap (writer)', () => {
  it('Accept refuses when an attachment now has different bytes of the same size', async () => {
    const s = setup();
    const id = 'Inbox/Voice note.md';
    const text = 'Buy milk and eggs tomorrow\n';
    s.port.files.set(id, text);
    s.port.sizes.set('Inbox/Voice note.m4a', 99);
    const attachments = [{ path: 'Inbox/Voice note.m4a', size: 99, kind: 'audio' as const, digest: 'digest-one' }];
    const fingerprint = await computeFingerprint(text, attachments);
    s.set(upsertEntry(s.journal, { id, state: 'awaiting_review', fingerprint, processingVersion: 1, attempts: 0, createdAt: 1, updatedAt: 1, hasNote: true, source: 'transcript', text: 'x y z', attachments, proposal: { title: 'T', tags: [], folder: null } }));
    (s.port as unknown as { fileDigest: (p: string) => Promise<string> }).fileDigest = async () => 'digest-two';
    expect(await acceptCapture(s.deps, id)).toEqual({ ok: false, error: 'capture-changed' });
    expect(s.port.edits).toBe(0);
    (s.port as unknown as { fileDigest: (p: string) => Promise<string> }).fileDigest = async () => 'digest-one';
    expect((await acceptCapture(s.deps, id)).ok).toBe(true);
  });
});

describe('final-gate regressions (writer)', () => {
  async function accepted(s: ReturnType<typeof setup>) {
    const { id } = await seedNote(s);
    await acceptCapture(s.deps, id);
    return id;
  }

  it('refuses to create a note in a folder the user keeps out now', async () => {
    const s = setup();
    const id = await accepted(s);
    s.port.folders.add('Areas/Clients');
    s.deps.policy = () => ({ ...policy, excludedFolders: ['Areas/Clients'] });
    expect(await createOrganisedNote(s.deps, id, { folder: 'Areas/Clients' })).toEqual({ ok: false, error: 'capture-destination-refused' });
    expect(s.port.creates.filter((p) => p.startsWith('Areas/'))).toEqual([]);
  });

  it('refuses to copy the text when the source note is kept out now (tagged or reworded after Accept)', async () => {
    const s = setup();
    const id = await accepted(s);
    s.deps.policy = () => ({ ...policy, excludedTerms: ['milk'] });
    expect(await createOrganisedNote(s.deps, id)).toEqual({ ok: false, error: 'capture-source-excluded' });
    expect(s.port.creates.filter((p) => p.startsWith('Areas/'))).toEqual([]);
  });

  it('also judges the user\'s own held text before copying it (the noteText the body is built from)', async () => {
    const s = setup();
    const id = await accepted(s);
    s.set(upsertEntry(s.journal, { ...getEntry(s.journal, id)!, noteText: 'secret plan for ACME' }));
    expect(await createOrganisedNote(s.deps, id)).toEqual({ ok: false, error: 'capture-source-excluded' });
  });

  it('an action that throws returns a failure instead of rejecting', async () => {
    const s = setup();
    const { id } = await seedNote(s);
    s.port.readNote = async () => { throw new Error('disk gone'); };
    const r = await acceptCapture(s.deps, id);
    expect(r).toEqual({ ok: false, error: 'capture-write-failed' });
  });

  it('refuses when the source note is gone', async () => {
    const s = setup();
    const id = await accepted(s);
    s.port.files.delete(id);
    expect(await createOrganisedNote(s.deps, id)).toEqual({ ok: false, error: 'capture-source-excluded' });
  });

  it('a capture waiting for confirmation after an edit can be skipped', async () => {
    const s = setup();
    const { id } = await seedNote(s, { state: 'waiting_for_stable', needsConfirm: true });
    expect((await skipCapture(s.deps, id)).ok).toBe(true);
    expect(s.journal.tombstones[id].state).toBe('skipped_by_user');
  });
});

describe('skipCapture', () => {
  it('writes nothing and remembers the decision', async () => {
    const s = setup();
    const { id, text } = await seedNote(s);
    expect((await skipCapture(s.deps, id)).ok).toBe(true);
    expect(s.port.files.get(id)).toBe(text);
    expect(s.port.edits).toBe(0);
    expect(s.journal.tombstones[id].state).toBe('skipped_by_user');
    expect(s.journal.counters.rejected).toBe(1);
  });
});
