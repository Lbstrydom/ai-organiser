/**
 * A note with a `## Handoff` section is an AI hand-back: it belongs to Review AI hand-back. While that review exists
 * (ai-workspaces AND capture-inbox on) the capture inbox leaves it alone; with either off, nothing changes.
 *
 * Why it matters: accepting a hand-back as a capture writes into the note, `handbackIdOf` hashes the whole note, so the
 * hand-back id and every item id change, and a second review adds its decisions and questions to the project again.
 */
import { describe, it, expect, vi } from 'vitest';
import { scanInbox, type CaptureVaultPort, type ScanDeps, type ScanOutcome, type VaultFileInfo } from '../src/services/captureInbox/captureScanner';
import { runJobs, syncEntries, type CaptureDeps, type ProcessorPort } from '../src/services/captureInbox/captureProcessor';
import { applyAccept } from '../src/services/captureInbox/enrichmentBlock';
import { getEntry } from '../src/services/captureInbox/captureJournal';
import { emptyJournal, type CaptureConfig, type CaptureJournal } from '../src/services/captureInbox/captureTypes';
import { captureItems, newHandbackItems } from '../src/services/process/processProjection';
import { handbackIdOf, itemId, parseHandoff } from '../src/services/aiWorkspaces/handoffParser';
import { addUnderHeading } from '../src/services/aiWorkspaces/handoffNoteEdit';
import { ok, err } from '../src/core/result';
import type { SweepPolicy } from '../src/services/inboxSweep/sweepGuard';
vi.stubGlobal('window', globalThis);

const ID = '3f2b8f4e-1c2d-4e5f-8a6b-7c8d9e0f1a2b';
const CTX = ['@computer', '@phone'];
const HANDBACK = `Chat reply saved as a note.\n\n## Handoff\nProject ID: ${ID}\nChat project: Website brain (claude)\n\n### Decisions\n- Decided: Launch in March\n\n### Questions\n- Who signs off?\n`;
const PLAIN = 'Call the plumber about the leak tomorrow morning\n';

const config: CaptureConfig = {
  inboxFolders: ['Inbox'], destinationRoot: 'Areas', since: 0, onOpen: false, onOpenMaxPerRun: 3, maxPerRun: 10,
  maxAttachmentBytes: 1000, minWords: 3, digitiseImages: false, maxImagesPerCapture: 3, maxTextChars: 12000,
  stabilityMs: 8000, requireMarker: false,
};
const policy: SweepPolicy = { excludedFolders: [], excludedTags: [], excludedProperties: [], excludedTerms: [], protectedFolders: [], maxNoteChars: 20000 };
const NOW = 10_000_000;

function world(notes: Record<string, string>) {
  let journal: CaptureJournal = emptyJournal();
  let clock = NOW;
  const classified: string[] = [];
  const reads: string[] = [];
  const info = (path: string): VaultFileInfo => ({ path, extension: 'md', ctime: NOW - 60_000, mtime: NOW - 60_000, size: notes[path].length });
  const vault: CaptureVaultPort = {
    listFiles: () => Object.keys(notes).map(info),
    readText: async (p) => { reads.push(p); return p in notes ? ok(notes[p]) : err('capture-file-missing'); },
    resolveAttachments: () => ({ resolved: [], unresolvedMedia: [] }),
    referrersOf: () => [],
    digestOf: async () => err('capture-file-missing'),
  };
  const port: ProcessorPort = {
    readBytes: async () => err('capture-file-missing'),
    stat: async (p) => (p in notes ? { size: notes[p].length, mtime: NOW - 60_000 } : null),
    exists: (p) => p in notes,
  };
  const make = (skipHandbacks: (() => boolean) | undefined): CaptureDeps => ({
    journal: { get: () => journal, mutate: async (fn) => ok((journal = fn(journal))), mutateLazy: (fn) => { journal = fn(journal); return ok(undefined); } },
    config: () => config, policy: () => policy, port, vault,
    isSwept: async () => false, isEnabled: () => true, now: () => clock,
    ...(skipHandbacks ? { skipHandbacks } : {}),
    digitisationEnabled: () => false,
    transcribe: async () => ok(''), digitise: async () => ok(''),
    classify: async (parts) => { classified.push(parts.prompt); return ok({ tags: ['x'], suggestedTitle: 'T', suggestedFolder: 'Areas' }); },
    taxonomyPrompt: () => '', language: () => 'default', maxTags: () => 5,
    formatTags: (tags) => tags.map(String), listFolders: () => ['Areas'], folderAllowed: () => true,
  });
  return {
    notes, classified, reads, journal: () => journal,
    /** Two scan + sync + run passes, as the runtime does them. */
    async go(skipHandbacks?: () => boolean): Promise<ScanOutcome> {
      const deps = make(skipHandbacks);
      let last: ScanOutcome | null = null;
      for (let i = 0; i < 2; i++) {
        clock += 10_000;
        const scanDeps: ScanDeps = { config, policy, journal, isSwept: deps.isSwept, ...(skipHandbacks ? { skipHandbacks } : {}) };
        const r = await scanInbox(vault, scanDeps);
        if (!r.ok) throw new Error(r.error);
        last = r.value;
        await syncEntries(deps, last);
        await runJobs(deps, last, { cancelled: () => false }, 10);
      }
      return last!;
    },
    /** Scan and sync with one gate, then run the jobs with another: the run's own check on the live note decides. */
    async scanThenRun(scanSkip: () => boolean, runSkip: () => boolean) {
      clock += 10_000;
      const r = await scanInbox(vault, { config, policy, journal, isSwept: async () => false, skipHandbacks: scanSkip });
      if (!r.ok) throw new Error(r.error);
      await syncEntries(make(scanSkip), r.value);
      return runJobs(make(runSkip), r.value, { cancelled: () => false }, 10);
    },
  };
}

describe('the capture inbox leaves AI hand-backs to their own review', () => {
  it('while the hand-back review is active: no capture, no provider call, a hand-back skip', async () => {
    const w = world({ 'Inbox/handback.md': HANDBACK, 'Inbox/plain.md': PLAIN });
    const scan = await w.go(() => true);
    expect(scan.captures.map((c) => c.id)).toEqual(['Inbox/plain.md']);
    expect(scan.skipped).toEqual([{ id: 'Inbox/handback.md', reason: 'handback' }]);
    expect(w.classified).toHaveLength(1);
    expect(w.classified[0]).not.toContain('Launch in March');
    expect(getEntry(w.journal(), 'Inbox/handback.md')).toBeUndefined();
    expect(w.journal().tombstones['Inbox/handback.md']).toMatchObject({ state: 'skipped', reason: 'handback' });
  });

  it('Process lists the hand-back only under hand-backs, never under captures', async () => {
    const w = world({ 'Inbox/handback.md': HANDBACK, 'Inbox/plain.md': PLAIN });
    await w.go(() => true);
    const captures = captureItems(w.journal(), NOW + 60_000, config.stabilityMs).map((i) => i.sourceId);
    expect(captures).toEqual(['Inbox/plain.md']);
    expect(newHandbackItems([{ path: 'Inbox/handback.md' }], {}).map((i) => [i.group, i.sourceId])).toEqual([['handbacks', 'new:Inbox/handback.md']]);
  });

  it('a hand-back already queued as a capture leaves the queue once the review is active', async () => {
    const w = world({ 'Inbox/handback.md': HANDBACK });
    await w.go();
    expect(getEntry(w.journal(), 'Inbox/handback.md')?.state).toBe('awaiting_review');
    await w.go(() => true);
    expect(getEntry(w.journal(), 'Inbox/handback.md')).toBeUndefined();
    expect(w.journal().tombstones['Inbox/handback.md']).toMatchObject({ state: 'skipped', reason: 'handback' });
    expect(captureItems(w.journal(), NOW + 60_000, config.stabilityMs)).toEqual([]);
  });

  it('either feature off (skipHandbacks false or absent): byte-identical, the hand-back is an ordinary capture', async () => {
    const absent = world({ 'Inbox/handback.md': HANDBACK, 'Inbox/plain.md': PLAIN });
    const off = world({ 'Inbox/handback.md': HANDBACK, 'Inbox/plain.md': PLAIN });
    const a = await absent.go();
    const b = await off.go(() => false);
    expect(a.captures.map((c) => c.id)).toEqual(['Inbox/handback.md', 'Inbox/plain.md']);
    expect(a.skipped).toEqual([]);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    // The journal matches entry for entry (each entry's random capture id aside).
    const shape = (j: CaptureJournal) => Object.values(j.entries).map((e) => [e.id, e.state, e.fingerprint, e.proposal]);
    expect(shape(off.journal())).toEqual(shape(absent.journal()));
    expect(off.journal().tombstones).toEqual(absent.journal().tombstones);
    expect(off.classified).toEqual(absent.classified);
    expect(absent.classified).toHaveLength(2);
    expect(getEntry(absent.journal(), 'Inbox/handback.md')?.state).toBe('awaiting_review');
  });

  it('the check on the live note before the provider call skips a hand-back the scan let through', async () => {
    const w = world({ 'Inbox/handback.md': HANDBACK });
    const summary = await w.scanThenRun(() => false, () => true);
    expect(summary.skipped).toBe(1);
    expect(w.classified).toEqual([]);
    expect(w.journal().tombstones['Inbox/handback.md']).toMatchObject({ state: 'skipped', reason: 'handback' });
  });

  it('a skipped hand-back comes back as a capture when the review is turned off', async () => {
    const w = world({ 'Inbox/handback.md': HANDBACK });
    await w.go(() => true);
    const scan = await w.go(() => false);
    expect(scan.captures.map((c) => c.id)).toEqual(['Inbox/handback.md']);
  });
});

describe('why: accepting a hand-back as a capture re-adds its decisions on a later review', () => {
  /** What Review AI hand-back writes into the project note for a hand-back note's text. */
  async function review(handbackText: string, projectNote: string): Promise<string> {
    const p = parseHandoff(handbackText, CTX);
    const hid = await handbackIdOf(handbackText);
    const decisions = await Promise.all(p.decisions.map(async (d) => ({ id: await itemId(hid, d), text: d.text })));
    const questions = await Promise.all(p.questions.map(async (q) => ({ id: await itemId(hid, q), text: q.text })));
    const withDecisions = addUnderHeading(projectNote, 'Decisions', decisions);
    if (!withDecisions.ok) throw new Error(withDecisions.error);
    const out = addUnderHeading(withDecisions.value, 'Open questions', questions);
    if (!out.ok) throw new Error(out.error);
    return out.value;
  }
  const count = (text: string, needle: string): number => text.split(needle).length - 1;

  it('reviewing the same hand-back twice adds nothing the second time', async () => {
    const once = await review(HANDBACK, '# Website\n');
    expect(await review(HANDBACK, once)).toBe(once);
  });

  it('the capture Accept write changes the hand-back id and item ids, so the decision and question land twice', async () => {
    const accepted = applyAccept(HANDBACK, 'cap-1', { machineText: '', proposal: { title: 'T', tags: ['x'], folder: 'Areas' }, source: 'note-text' });
    if (!accepted.ok) throw new Error(accepted.error);
    expect(accepted.value.text).not.toBe(HANDBACK);
    expect(await handbackIdOf(accepted.value.text)).not.toBe(await handbackIdOf(HANDBACK));

    const first = await review(HANDBACK, '# Website\n');
    const second = await review(accepted.value.text, first);
    expect(count(second, 'Launch in March')).toBe(2);
    expect(count(second, 'Who signs off?')).toBe(2);
  });
});
