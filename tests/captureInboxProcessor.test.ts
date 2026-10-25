import { describe, it, expect, vi } from 'vitest';

vi.stubGlobal('window', globalThis);

import { runJobs, syncEntries, retryCapture, processAgain, type CaptureDeps, type ProcessorPort } from '../src/services/captureInbox/captureProcessor';
import { scanInbox, type CaptureVaultPort, type ScanOutcome, type VaultFileInfo } from '../src/services/captureInbox/captureScanner';
import { forgetSkip, getEntry, upsertEntry } from '../src/services/captureInbox/captureJournal';
import { ok, err, type Result } from '../src/core/result';
import { sha256Hex } from '../src/services/attachmentDuplicateService';
import { MAX_AWAITING_REVIEW, emptyJournal, type CaptureConfig, type CaptureJournal } from '../src/services/captureInbox/captureTypes';
import type { SweepPolicy } from '../src/services/inboxSweep/sweepGuard';
import type { PromptParts } from '../src/services/prompts/promptParts';

const baseConfig: CaptureConfig = {
  inboxFolders: ['Inbox'], destinationRoot: 'Areas', since: 0, onOpen: false, onOpenMaxPerRun: 3, maxPerRun: 10,
  maxAttachmentBytes: 1000, minWords: 3, digitiseImages: false, maxImagesPerCapture: 3, maxTextChars: 12000,
  stabilityMs: 8000, requireMarker: false,
};
const basePolicy: SweepPolicy = { excludedFolders: ['Private'], excludedTags: [], excludedProperties: [], excludedTerms: ['acme'], protectedFolders: ['Protected'], maxNoteChars: 20000 };

const NOW = 10_000_000;
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0]); // 'ID3'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]);

interface World {
  deps: CaptureDeps;
  calls: { transcribe: Array<{ bytes: Uint8Array; name: string; ext: string }>; digitise: Array<{ bytes: Uint8Array; name: string; ext: string }>; classify: PromptParts[]; reads: string[] };
  files: Map<string, { info: VaultFileInfo; text?: string; bytes?: Uint8Array }>;
  journal(): CaptureJournal;
  set: { policy: SweepPolicy; config: CaptureConfig; enabled: boolean; digitisation: boolean; swept: boolean; transcribe: () => Promise<Result<string>>; digitise: () => Promise<Result<string>>; classify: () => Promise<Result<Record<string, unknown>>>; };
  addNote(path: string, text: string, attachments?: string[]): void;
  addMedia(path: string, bytes: Uint8Array, size?: number): void;
  go(opts?: { cancelled?: () => boolean; limit?: number; passes?: number; advance?: number }): Promise<Awaited<ReturnType<typeof runJobs>>>;
}

function world(): World {
  let journal: CaptureJournal = emptyJournal();
  let clock = NOW;
  const files = new Map<string, { info: VaultFileInfo; text?: string; bytes?: Uint8Array }>();
  const calls: World['calls'] = { transcribe: [], digitise: [], classify: [], reads: [] };
  const links = new Map<string, string[]>();
  const set: World['set'] = {
    policy: basePolicy, config: baseConfig, enabled: true, digitisation: true, swept: false,
    transcribe: async () => ok('Remind me to call the plumber'),
    digitise: async () => ok('Handwritten shopping list'),
    classify: async () => ok({ tags: ['home'], suggestedTitle: 'Call plumber', suggestedFolder: 'Areas/Home' }),
  };
  const vault: CaptureVaultPort = {
    listFiles: () => [...files.values()].map((f) => f.info),
    readText: async (p) => { calls.reads.push(p); const f = files.get(p); return f ? ok(f.text ?? '') : err('capture-file-missing'); },
    resolveAttachments: (p) => ({ resolved: links.get(p) ?? [], unresolvedMedia: [] }),
    referrersOf: (p) => [...links].filter(([, l]) => l.includes(p)).map(([n]) => n),
    digestOf: async (p) => { const b = files.get(p)?.bytes; return b ? ok(await sha256Hex(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)) : err('capture-file-missing'); },
  };
  const port: ProcessorPort = {
    readBytes: async (p) => { calls.reads.push(p); const f = files.get(p); return f ? ok(f.bytes ?? new Uint8Array(0)) : err('capture-file-missing'); },
    stat: async (p) => { const f = files.get(p); return f ? { size: f.info.size, mtime: f.info.mtime } : null; },
    exists: (p) => files.has(p),
  };
  const deps: CaptureDeps = {
    journal: {
      get: () => journal,
      mutate: async (fn) => ok((journal = fn(journal))),
      mutateLazy: (fn) => { journal = fn(journal); return ok(undefined); },
    },
    config: () => set.config, policy: () => set.policy, port, vault,
    isSwept: async () => set.swept, isEnabled: () => set.enabled, now: () => clock,
    digitisationEnabled: () => set.digitisation,
    transcribe: async (bytes, name, ext) => { calls.transcribe.push({ bytes, name, ext }); return set.transcribe(); },
    digitise: async (bytes, name, ext) => { calls.digitise.push({ bytes, name, ext }); return set.digitise(); },
    classify: async (parts) => { calls.classify.push(parts); return set.classify() as Promise<Result<Record<string, unknown>>>; },
    taxonomyPrompt: () => 'TAXONOMY', language: () => 'default', maxTags: () => 5,
    formatTags: (tags) => tags.map((t) => String(t).toLowerCase()),
    listFolders: () => ['Areas', 'Areas/Home', 'Areas/Work'], folderAllowed: () => true,
  };
  const w: World = {
    deps, calls, files, set, journal: () => journal,
    addNote(path, text, attachments = []) {
      files.set(path, { info: { path, extension: 'md', ctime: NOW - 60_000, mtime: NOW - 60_000, size: text.length }, text });
      links.set(path, attachments);
    },
    addMedia(path, bytes, size = bytes.length) {
      files.set(path, { info: { path, extension: path.split('.').pop() ?? '', ctime: NOW - 60_000, mtime: NOW - 60_000, size }, bytes });
    },
    async go(opts = {}) {
      const summary = { processed: 0, awaitingReview: 0, failed: 0, skipped: 0, waiting: 0, backpressure: false };
      for (let i = 0; i < (opts.passes ?? 2); i++) {
        clock += opts.advance ?? 10_000;
        const scan = await scanOk(vault, { config: set.config, policy: set.policy, journal: journal, isSwept: deps.isSwept });
        await syncEntries(deps, scan);
        const r = await runJobs(deps, scan, { cancelled: opts.cancelled ?? (() => false) }, opts.limit ?? 10);
        summary.processed += r.processed; summary.awaitingReview += r.awaitingReview; summary.failed += r.failed; summary.skipped += r.skipped;
        summary.waiting = r.waiting; summary.backpressure = summary.backpressure || r.backpressure;
      }
      return summary;
    },
  };
  return w;
}

/** The scan outcome of a scan that must have succeeded. */
async function scanOk(...args: Parameters<typeof scanInbox>): Promise<ScanOutcome> {
  const r = await scanInbox(...args);
  if (!r.ok) throw new Error(`scan failed: ${r.error}`);
  return r.value;
}

describe('text first and the privacy order', () => {
  it('a note with usable text and audio never calls transcription, and writes nothing', async () => {
    const w = world();
    w.addNote('Inbox/a.md', 'Call the plumber about the leak tomorrow\n![[x.mp3]]', ['Inbox/x.mp3']);
    w.addMedia('Inbox/x.mp3', MP3);
    const s = await w.go();
    expect(w.calls.transcribe).toEqual([]);
    expect(s.awaitingReview).toBe(1);
    const e = getEntry(w.journal(), 'Inbox/a.md')!;
    expect(e.state).toBe('awaiting_review');
    expect(e.source).toBe('note-text');
    expect(e.noteText).toContain('plumber');
    expect(e.proposal).toMatchObject({ title: 'Call plumber', tags: ['home'], folder: 'Areas/Home' });
  });

  it('audio only: reads the bytes once, sends THOSE bytes with the right extension, and holds the transcript', async () => {
    const w = world();
    w.addNote('Inbox/v.md', '# v\n![[v.mp3]]', ['Inbox/v.mp3']);
    w.addMedia('Inbox/v.mp3', MP3);
    await w.go();
    expect(w.calls.reads.filter((p) => p === 'Inbox/v.mp3')).toHaveLength(1);
    expect(w.calls.transcribe).toHaveLength(1);
    expect(w.calls.transcribe[0].bytes).toBe(MP3);
    expect(w.calls.transcribe[0]).toMatchObject({ name: 'v.mp3', ext: 'mp3' });
    const e = getEntry(w.journal(), 'Inbox/v.md')!;
    expect(e.text).toContain('call the plumber');
    expect(e.source).toBe('transcript');
    expect(w.calls.classify[0].prompt).toContain('call the plumber');
  });

  it('a note excluded by a kept-out term reaches no provider and persists nothing', async () => {
    const w = world();
    w.addNote('Inbox/a.md', 'Call ACME about the invoice today\n![[x.mp3]]', ['Inbox/x.mp3']);
    w.addMedia('Inbox/x.mp3', MP3);
    await w.go();
    expect(w.calls.transcribe).toEqual([]);
    expect(w.calls.classify).toEqual([]);
    expect(w.calls.digitise).toEqual([]);
    expect(JSON.stringify(w.journal())).not.toContain('ACME');
  });

  it('an attachment in a kept-out folder excludes the whole capture before any call, and its bytes are never read', async () => {
    const w = world();
    w.addNote('Inbox/a.md', '![[p.mp3]]', ['Private/p.mp3']);
    w.addMedia('Private/p.mp3', MP3);
    await w.go();
    expect(w.calls.reads).not.toContain('Private/p.mp3');
    expect(w.calls.transcribe).toEqual([]);
  });

  it('refuses a renamed or truncated file without uploading it', async () => {
    const w = world();
    w.addNote('Inbox/a.md', '![[x.mp3]]', ['Inbox/x.mp3']);
    w.addMedia('Inbox/x.mp3', new Uint8Array([0x25, 0x50, 0x44, 0x46, 1]));
    await w.go();
    expect(w.calls.transcribe).toEqual([]);
    expect(w.journal().tombstones['Inbox/a.md']?.state).toBe('skipped');
    expect(w.journal().counters.skipped['invalid-media']).toBe(1);
  });

  it('refuses bytes over the cap even when the listed size was small (no upload)', async () => {
    const w = world();
    w.addNote('Inbox/a.md', '![[x.mp3]]', ['Inbox/x.mp3']);
    const big = new Uint8Array(2000); big.set(MP3);
    w.addMedia('Inbox/x.mp3', big, 10);
    await w.go();
    expect(w.calls.transcribe).toEqual([]);
    expect(w.journal().counters.skipped['too-large']).toBe(1);
  });

  it('a transcript that matches a kept-out term is discarded: nothing persisted, nothing classified', async () => {
    const w = world();
    w.set.transcribe = async () => ok('please send the contract to ACME');
    w.addNote('Inbox/a.md', '![[x.mp3]]', ['Inbox/x.mp3']);
    w.addMedia('Inbox/x.mp3', MP3);
    await w.go();
    expect(w.calls.classify).toEqual([]);
    expect(JSON.stringify(w.journal())).not.toMatch(/contract|ACME/);
    expect(w.journal().tombstones['Inbox/a.md']?.state).toBe('skipped');
  });

  it('re-checks the guard right before the call: a policy that changed after the scan stops the upload', async () => {
    const w = world();
    w.addNote('Inbox/a.md', 'Quarterly numbers for Globex\n![[x.mp3]]', ['Inbox/x.mp3']);
    w.addNote('Inbox/b.md', '![[y.mp3]]', ['Inbox/y.mp3']);
    w.addMedia('Inbox/x.mp3', MP3);
    w.addMedia('Inbox/y.mp3', MP3);
    const scan = await scanOk(w.deps.vault, { config: w.set.config, policy: w.set.policy, journal: w.journal(), isSwept: w.deps.isSwept });
    await syncEntries(w.deps, scan);
    w.set.policy = { ...basePolicy, excludedFolders: ['Private', 'Inbox'] };
    const s = await runJobs(w.deps, scan, { cancelled: () => false }, 10);
    expect(w.calls.transcribe).toEqual([]);
    expect(w.calls.classify).toEqual([]);
    expect(s.skipped).toBe(2);
  });

  it('digitises images only when the digitisation feature is on', async () => {
    const w = world();
    w.addNote('Inbox/a.md', '![[p.png]]', ['Inbox/p.png']);
    w.addMedia('Inbox/p.png', PNG);
    w.set.digitisation = false;
    await w.go();
    expect(w.calls.digitise).toEqual([]);
    expect(w.journal().counters.skipped['digitisation-off']).toBe(1);
    const w2 = world();
    w2.addNote('Inbox/a.md', '![[p.png]]', ['Inbox/p.png']);
    w2.addMedia('Inbox/p.png', PNG);
    await w2.go();
    expect(w2.calls.digitise.map((c) => c.name)).toEqual(['p.png']);
    expect(w2.calls.digitise[0].ext).toBe('png');
    expect(getEntry(w2.journal(), 'Inbox/a.md')!.source).toBe('digitised');
  });

  it('skips a note that already carries this capture\'s block (another device) or was already swept', async () => {
    const w = world();
    w.addNote('Inbox/a.md', '---\ncapture-id: Inbox/a.md\n---\nhello there friend\n<!-- aio:capture -->\nCapture inbox: transcript.\n<!-- /aio:capture -->\n![[x.mp3]]', ['Inbox/x.mp3']);
    w.addMedia('Inbox/x.mp3', MP3);
    await w.go();
    expect(w.calls.transcribe).toEqual([]);
    expect(w.journal().counters.skipped['already-captured']).toBe(1);
  });
});

describe('one at a time, cancel, failure and backpressure', () => {
  it('runs jobs strictly one at a time', async () => {
    const w = world();
    let active = 0; let peak = 0;
    w.set.transcribe = async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; return ok('some spoken words here'); };
    for (const n of ['a', 'b', 'c']) { w.addNote(`Inbox/${n}.md`, `![[${n}.mp3]]`, [`Inbox/${n}.mp3`]); w.addMedia(`Inbox/${n}.mp3`, MP3); }
    const s = await w.go();
    expect(peak).toBe(1);
    expect(w.calls.transcribe).toHaveLength(3);
    expect(s.awaitingReview).toBe(3);
  });

  it('honours a limit and does not touch the rest', async () => {
    const w = world();
    for (const n of ['a', 'b', 'c']) { w.addNote(`Inbox/${n}.md`, `![[${n}.mp3]]`, [`Inbox/${n}.mp3`]); w.addMedia(`Inbox/${n}.mp3`, MP3); }
    await w.go({ limit: 1, passes: 2 });
    expect(w.calls.transcribe.length).toBe(2); // one per pass, never more than the limit per run
  });

  it('cancel during a call discards the result: back to ready, nothing persisted, attempts unchanged', async () => {
    const w = world();
    let cancelled = false;
    w.set.transcribe = async () => { cancelled = true; return ok('private spoken words here'); };
    w.addNote('Inbox/a.md', '![[x.mp3]]', ['Inbox/x.mp3']);
    w.addMedia('Inbox/x.mp3', MP3);
    await w.go({ cancelled: () => cancelled, passes: 2 });
    const e = getEntry(w.journal(), 'Inbox/a.md')!;
    expect(e.state).toBe('ready');
    expect(e.attempts).toBe(0);
    expect(JSON.stringify(w.journal())).not.toContain('private spoken');
    expect(w.calls.classify).toEqual([]);
  });

  it('turning the feature off during the tagging call discards its result too', async () => {
    const w = world();
    w.set.classify = async () => { w.set.enabled = false; return ok({ tags: ['x'], suggestedTitle: 'T' }); };
    w.addNote('Inbox/a.md', 'Some typed words about the garden', []);
    await w.go();
    const e = getEntry(w.journal(), 'Inbox/a.md')!;
    expect(e.state).toBe('ready');
    expect(e.proposal).toBeUndefined();
  });

  it('records the failed stage and stays failed until the user presses Retry; Retry resets (F11)', async () => {
    const w = world();
    w.set.transcribe = async () => err('provider down');
    w.addNote('Inbox/a.md', '![[x.mp3]]', ['Inbox/x.mp3']);
    w.addMedia('Inbox/x.mp3', MP3);
    await w.go({ passes: 1 });
    let e = getEntry(w.journal(), 'Inbox/a.md')!;
    expect(e).toMatchObject({ state: 'failed', failedStage: 'transcribe', attempts: 1, retriable: true, errorText: 'The provider could not complete the request.' });
    // Later looks at the inbox (a restart, a re-scan) never turn a failed capture back into "ready" on their own.
    const callsBefore = w.calls.transcribe.length;
    await w.go({ passes: 4 });
    e = getEntry(w.journal(), 'Inbox/a.md')!;
    expect(e).toMatchObject({ state: 'failed', attempts: 1, failedStage: 'transcribe' });
    expect(w.calls.transcribe.length).toBe(callsBefore);
    expect(await retryCapture(w.deps, 'Inbox/a.md')).toBe(true);
    expect(getEntry(w.journal(), 'Inbox/a.md')).toMatchObject({ state: 'ready', attempts: 0 });
  });

  it('a failing tagging call is recorded, so the review can say so (F2)', async () => {
    const w = world();
    w.set.classify = async () => err('model down');
    w.addNote('Inbox/a.md', 'Remember to water the plants on Friday', []);
    await w.go();
    expect(getEntry(w.journal(), 'Inbox/a.md')).toMatchObject({ state: 'awaiting_review', taggingFailed: true });
  });

  it('a tagging call that works leaves no failure mark (F2)', async () => {
    const w = world();
    w.addNote('Inbox/a.md', 'Remember to water the plants on Friday', []);
    await w.go();
    expect(getEntry(w.journal(), 'Inbox/a.md')!.taggingFailed).toBeUndefined();
  });

  it('an empty note waits for text instead of settling forever (F1)', async () => {
    const w = world();
    w.addNote('Inbox/empty.md', '', []);
    await w.go({ passes: 3 });
    const e = getEntry(w.journal(), 'Inbox/empty.md');
    expect(e).toMatchObject({ state: 'waiting_for_stable', waitReason: 'empty' });
  });

  it('a failing tagging call degrades to a reviewable proposal instead of failing the capture', async () => {
    const w = world();
    w.set.classify = async () => err('model down');
    w.addNote('Inbox/a.md', 'Remember to water the plants on Friday', []);
    await w.go();
    const e = getEntry(w.journal(), 'Inbox/a.md')!;
    expect(e.state).toBe('awaiting_review');
    expect(e.proposal!.title).toBe('Remember to water the plants on');
  });

  it('stops spending money while the review backlog is full', async () => {
    const w = world();
    // real notes, already processed and waiting for review (their fingerprints match what the scan sees)
    for (let i = 0; i < MAX_AWAITING_REVIEW; i++) w.addNote(`Inbox/old${i}.md`, `Old typed capture number ${i} waits`, []);
    const first = await scanOk(w.deps.vault, { config: w.set.config, policy: w.set.policy, journal: w.journal(), isSwept: w.deps.isSwept });
    let j = w.journal();
    for (const c of first.captures) {
      j = upsertEntry(j, { id: c.id, state: 'awaiting_review', fingerprint: c.fingerprint, processingVersion: 1, attempts: 0, createdAt: 1, updatedAt: 1 });
    }
    await w.deps.journal.mutate(() => j);
    w.addNote('Inbox/new.md', 'A brand new typed capture here', []);
    const s = await w.go();
    expect(s.backpressure).toBe(true);
    expect(w.calls.classify).toEqual([]);
  });
});

describe('audit regressions', () => {
  it('a tag added to the note after the scan stops the upload (the guard judges the note as it is now)', async () => {
    const w = world();
    w.addNote('Inbox/a.md', '![[x.mp3]]', ['Inbox/x.mp3']);
    w.addMedia('Inbox/x.mp3', MP3);
    const scan = await scanOk(w.deps.vault, { config: w.set.config, policy: { ...w.set.policy, excludedTags: ['secret'] }, journal: w.journal(), isSwept: w.deps.isSwept });
    w.set.policy = { ...w.set.policy, excludedTags: ['secret'] };
    await syncEntries(w.deps, scan);
    w.files.get('Inbox/a.md')!.text = '![[x.mp3]]\n#secret';
    await runJobs(w.deps, scan, { cancelled: () => false }, 10);
    expect(w.calls.transcribe).toEqual([]);
    expect(w.calls.classify).toEqual([]);
  });

  it('a note edited after the scan is dropped, not processed on stale text', async () => {
    const w = world();
    w.addNote('Inbox/a.md', 'Original words typed here', []);
    const scan = await scanOk(w.deps.vault, { config: w.set.config, policy: w.set.policy, journal: w.journal(), isSwept: w.deps.isSwept });
    await syncEntries(w.deps, scan);
    w.files.get('Inbox/a.md')!.text = 'Edited words typed here';
    await runJobs(w.deps, scan, { cancelled: () => false }, 10);
    expect(w.calls.classify).toEqual([]);
    expect(getEntry(w.journal(), 'Inbox/a.md')!.state).toBe('ready');
  });

  it('a keep-out rule added while a capture awaits review drops its held text at once', async () => {
    const w = world();
    w.addNote('Inbox/a.md', 'Quarterly numbers for Globex today', []);
    await w.go();
    expect(getEntry(w.journal(), 'Inbox/a.md')!.noteText).toContain('Globex');
    w.set.policy = { ...basePolicy, excludedTerms: ['globex'] };
    await w.go();
    expect(JSON.stringify(w.journal())).not.toContain('Globex');
    expect(getEntry(w.journal(), 'Inbox/a.md')).toBeUndefined();
  });

  it('a capture still missing its attachment after a day is set aside, so it stops holding the sweep off the note', async () => {
    const w = world();
    w.addNote('Inbox/a.md', '![[later.m4a]]', []);
    const orig = w.deps.vault.resolveAttachments;
    w.deps.vault.resolveAttachments = (p, t) => ({ ...orig(p, t), unresolvedMedia: ['later.m4a'] });
    await w.go({ passes: 2 });
    expect(getEntry(w.journal(), 'Inbox/a.md')!.state).toBe('waiting_for_stable');
    await w.go({ passes: 1, advance: 25 * 60 * 60 * 1000 });
    expect(getEntry(w.journal(), 'Inbox/a.md')).toBeUndefined();
    expect(w.journal().counters.skipped['attachment-missing']).toBe(1);
  });

  it('an auth failure is not retried and does not use up attempts', async () => {
    const w = world();
    w.set.transcribe = async () => err('API error (401): invalid api key');
    w.addNote('Inbox/a.md', '![[x.mp3]]', ['Inbox/x.mp3']);
    w.addMedia('Inbox/x.mp3', MP3);
    await w.go({ passes: 4 });
    expect(w.calls.transcribe).toHaveLength(1);
    expect(getEntry(w.journal(), 'Inbox/a.md')).toMatchObject({ state: 'failed', retriable: false, attempts: 0 });
  });

  it('a second edit of a capture that waits for confirmation does not skip the confirmation', async () => {
    const w = world();
    w.addNote('Inbox/a.md', 'First typed words for review', []);
    await w.go();
    w.files.get('Inbox/a.md')!.text = 'Second typed words for review';
    await w.go({ passes: 3 });
    expect(getEntry(w.journal(), 'Inbox/a.md')).toMatchObject({ state: 'waiting_for_stable', needsConfirm: true });
    w.files.get('Inbox/a.md')!.text = 'Third typed words for review';
    await w.go({ passes: 3 });
    expect(getEntry(w.journal(), 'Inbox/a.md')).toMatchObject({ state: 'waiting_for_stable', needsConfirm: true });
    expect(await processAgain(w.deps, 'Inbox/a.md')).toBe(true);
    await w.go({ passes: 2 });
    expect(getEntry(w.journal(), 'Inbox/a.md')!.state).toBe('awaiting_review');
  });

  it('every new entry gets a stable uid, kept across renames', async () => {
    const w = world();
    w.addNote('Inbox/a.md', 'Some typed words about the garden', []);
    await w.go();
    expect(getEntry(w.journal(), 'Inbox/a.md')!.uid).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('final-gate regressions (processor)', () => {
  it('a held capture whose note was deleted or moved out of the inbox loses its text and stops holding the sweep', async () => {
    const w = world();
    w.addNote('Inbox/a.md', 'Quarterly numbers for Globex today', []);
    w.addNote('Inbox/b.md', 'Another typed note about gardening', []);
    await w.go();
    expect(getEntry(w.journal(), 'Inbox/a.md')!.noteText).toContain('Globex');
    w.files.delete('Inbox/a.md');
    const moved = w.files.get('Inbox/b.md')!;
    w.files.delete('Inbox/b.md');
    w.files.set('Elsewhere/b.md', { ...moved, info: { ...moved.info, path: 'Elsewhere/b.md' } });
    await w.go({ passes: 1 });
    expect(getEntry(w.journal(), 'Inbox/a.md')).toBeUndefined();
    expect(getEntry(w.journal(), 'Inbox/b.md')).toBeUndefined();
    expect(JSON.stringify(w.journal())).not.toContain('Globex');
  });

  it('audio that gains an embedding note during the stability wait is not uploaded as a bare capture', async () => {
    const w = world();
    w.addMedia('Inbox/m.mp3', MP3);
    const scan = await scanOk(w.deps.vault, { config: w.set.config, policy: w.set.policy, journal: w.journal(), isSwept: w.deps.isSwept });
    await syncEntries(w.deps, scan);
    expect(scan.captures[0].notePath).toBeNull();
    // a kept-out note that embeds the file arrives after the scan
    w.deps.vault.referrersOf = () => ['Private/note.md'];
    await runJobs(w.deps, scan, { cancelled: () => false }, 10);
    expect(w.calls.transcribe).toEqual([]);
  });
});

describe('a failure shows a friendly sentence, never the raw provider answer', () => {
  it('keeps the provider JSON out of the journal', async () => {
    const w = world();
    w.set.transcribe = async () => err('API error (500): {"error":{"message":"boom","request_id":"req_9"}}');
    w.addNote('Inbox/a.md', '![[x.mp3]]', ['Inbox/x.mp3']);
    w.addMedia('Inbox/x.mp3', MP3);
    await w.go({ passes: 1 });
    const e = getEntry(w.journal(), 'Inbox/a.md')!;
    expect(e.state).toBe('failed');
    expect(e.errorText).toBe('The provider could not be reached or had a problem. This is often temporary.');
    expect(JSON.stringify(w.journal())).not.toContain('req_9');
  });

  it('a capture whose attachment has not arrived waits for it, says so, and the reason clears once it is there', async () => {
    const w = world();
    w.addNote('Inbox/a.md', 'Some words about the plan ![[late.mp3]]', []);
    w.deps.vault.resolveAttachments = () => ({ resolved: [], unresolvedMedia: ['late.mp3'] });
    await w.go({ passes: 1 });
    expect(getEntry(w.journal(), 'Inbox/a.md')).toMatchObject({ state: 'waiting_for_stable', waitReason: 'attachment' });
    // the file arrives: the reason is gone and the capture settles
    w.addMedia('Inbox/late.mp3', MP3);
    w.deps.vault.resolveAttachments = () => ({ resolved: ['Inbox/late.mp3'], unresolvedMedia: [] });
    await w.go({ passes: 3 });
    const e = getEntry(w.journal(), 'Inbox/a.md')!;
    expect(e.waitReason).toBeUndefined();
    expect(['ready', 'processing', 'awaiting_review', 'accepted', 'organised']).toContain(e.state);
  });

  it('the fallback title keeps the clock time the user wrote', async () => {
    const w = world();
    w.set.classify = async () => ok({});
    w.addNote('Inbox/d.md', 'Call Dana at 14:30 about the kickoff plan please');
    await w.go({ passes: 2 });
    expect(getEntry(w.journal(), 'Inbox/d.md')?.proposal?.title).toBe('Call Dana at 14.30 about the');
  });
});

describe('skipped captures are remembered with their reason and can be looked at again', () => {
  it('an oversized or unsupported file leaves a tombstone that names why, and Try again re-offers it', async () => {
    const w = world();
    w.set.config = { ...w.set.config, maxAttachmentBytes: 100 };
    w.addMedia('Inbox/big.mp3', MP3, 500);
    await w.go({ passes: 1 });
    expect(w.journal().tombstones['Inbox/big.mp3']).toMatchObject({ state: 'skipped', reason: 'too-large' });
    // nothing is offered while it is skipped ...
    await w.go({ passes: 1 });
    expect(Object.keys(w.journal().entries)).toEqual([]);
    // ... until the limit is raised and the user asks again
    w.set.config = { ...w.set.config, maxAttachmentBytes: 10_000 };
    w.deps.journal.mutate((j) => forgetSkip(j, 'Inbox/big.mp3'));
    await w.go({ passes: 1 });
    expect(w.journal().tombstones['Inbox/big.mp3']).toBeUndefined();
    expect(w.journal().entries['Inbox/big.mp3']).toBeDefined();
  });
});

describe('the capture keeps the user\'s text intact', () => {
  const EXAMPLE = 'Call Dana at 14:30 on 2026-10-30 about the room, spec is at https://example.com/spec and see [[Project Zephyr migration]] for the plan.';

  it('holds the note text exactly as written; only the prompt gets the stripped words', async () => {
    const w = world();
    w.addNote('Inbox/d.md', EXAMPLE);
    await w.go({ passes: 2 });
    const e = Object.values(w.journal().entries)[0];
    expect(e.state).toBe('awaiting_review');
    expect(e.noteText).toBe(EXAMPLE);
    const prompt = JSON.stringify(w.calls.classify[0]);
    expect(prompt).toContain('Call Dana at');
    expect(prompt).not.toContain('https://example.com/spec');
    expect(prompt).not.toContain('Project Zephyr migration');
    expect(prompt).not.toContain('14:30');
  });
});

describe('an unreadable file is a result, not a crash', () => {
  it('an attachment that cannot be read fails the capture as retriable and sends nothing', async () => {
    const w = world();
    w.addNote('Inbox/a.md', 'spoken words', ['Inbox/v.mp3']);
    w.addMedia('Inbox/v.mp3', new Uint8Array([0x49, 0x44, 0x33, 4]));
    w.deps.port.readBytes = async () => err('capture-read-failed');
    await w.go({ passes: 2 });
    expect(w.calls.transcribe).toEqual([]);
    const e = Object.values(w.journal().entries)[0];
    expect(e.state).toBe('failed');
    expect(e.retriable).toBe(true);
  });

  it('an attachment that is gone is skipped as invalid media, never retried', async () => {
    const w = world();
    w.addNote('Inbox/a.md', 'spoken words', ['Inbox/v.mp3']);
    w.addMedia('Inbox/v.mp3', new Uint8Array([0x49, 0x44, 0x33, 4]));
    w.deps.port.readBytes = async () => err('capture-file-missing');
    await w.go({ passes: 2 });
    expect(w.calls.transcribe).toEqual([]);
    const e = Object.values(w.journal().entries)[0] ?? Object.values(w.journal().tombstones)[0];
    expect(e.state).toBe('skipped');
    expect((e as { skipReason?: string }).skipReason ?? 'invalid-media').toBe('invalid-media');
  });

  it('a note that cannot be re-read before an upload drops the job: nothing is sent and the capture stays ready', async () => {
    const w = world();
    w.addNote('Inbox/a.md', 'spoken words', ['Inbox/v.mp3']);
    w.addMedia('Inbox/v.mp3', new Uint8Array([0x49, 0x44, 0x33, 4]));
    const realRead = w.deps.vault.readText;
    let scanned = false;
    w.deps.vault.readText = async (p) => (scanned ? err('capture-read-failed') : realRead(p));
    const realBytes = w.deps.port.readBytes;
    w.deps.port.readBytes = async (p) => { scanned = true; return realBytes(p); };
    await w.go({ passes: 3 });
    expect(w.calls.transcribe).toEqual([]);
    expect(Object.values(w.journal().entries)[0].state).toBe('ready');
  });
});

describe('the image pipeline gets the validated bytes', () => {
  it('a file swapped between validation and the pipeline is never digitised: the pipeline receives the bytes that were checked', async () => {
    const w = world();
    w.addNote('Inbox/a.md', '![[p.png]]', ['Inbox/p.png']);
    w.addMedia('Inbox/p.png', PNG);
    const swapped = new Uint8Array(PNG.length); swapped.set(PNG); swapped[PNG.length - 1] ^= 0xff;
    // the live guard before the call re-reads the note: the file is swapped right there, after validation
    const realRead = w.deps.vault.readText;
    const realBytes = w.deps.port.readBytes;
    let validated = false;
    w.deps.port.readBytes = async (p) => { const b = await realBytes(p); validated = true; return b; };
    w.deps.vault.readText = async (p) => { if (validated) w.files.get('Inbox/p.png')!.bytes = swapped; return realRead(p); };
    await w.go({ passes: 1 });
    expect(w.calls.digitise).toHaveLength(1);
    expect(Array.from(w.calls.digitise[0].bytes)).toEqual(Array.from(PNG));
    expect(Array.from(w.calls.digitise[0].bytes)).not.toEqual(Array.from(swapped));
  });
});

describe('digest check before upload', () => {
  it('a file swapped for another of the same size after the scan is not uploaded; the job is dropped', async () => {
    const w = world();
    w.addNote('Inbox/a.md', '![[x.mp3]]', ['Inbox/x.mp3']);
    w.addMedia('Inbox/x.mp3', MP3);
    const scan = await scanOk(w.deps.vault, { config: w.set.config, policy: w.set.policy, journal: w.journal(), isSwept: w.deps.isSwept });
    await syncEntries(w.deps, scan);
    const swapped = new Uint8Array(MP3.length); swapped.set(MP3); swapped[MP3.length - 1] ^= 0xff; // same size, same header, different bytes
    w.files.get('Inbox/x.mp3')!.bytes = swapped;
    await runJobs(w.deps, scan, { cancelled: () => false }, 10);
    expect(w.calls.transcribe).toEqual([]);
    expect(getEntry(w.journal(), 'Inbox/a.md')!.state).toBe('ready');
  });
});

describe('audit round 3 regressions (processor)', () => {
  it('a policy change during the taxonomy await stops the tagging call (nothing awaits between the last guard and the call)', async () => {
    const w = world();
    w.addNote('Inbox/a.md', 'Quarterly numbers for Globex today', []);
    w.deps.taxonomyPrompt = async () => { w.set.policy = { ...basePolicy, excludedTerms: ['globex'] }; return 'TAXONOMY'; };
    await w.go();
    expect(w.calls.classify).toEqual([]);
  });

  it('only a capture that is still ready starts: one that left ready while an earlier job ran is skipped', async () => {
    const w = world();
    w.addNote('Inbox/a.md', 'First typed capture words here', []);
    w.addNote('Inbox/b.md', 'Second typed capture words here', []);
    const scan = await scanOk(w.deps.vault, { config: w.set.config, policy: w.set.policy, journal: w.journal(), isSwept: w.deps.isSwept });
    await syncEntries(w.deps, scan);
    // while the first job is in its provider call the second entry is skipped by the user
    w.set.classify = async () => { await w.deps.journal.mutate((j) => { const e = getEntry(j, 'Inbox/b.md'); return e ? upsertEntry(j, { ...e, state: 'waiting_for_stable' }) : j; }); return ok({ tags: ['x'], suggestedTitle: 'T' }); };
    await runJobs(w.deps, scan, { cancelled: () => false }, 10);
    expect(w.calls.classify).toHaveLength(1);
  });

  it('a stage marker that lands on no entry stops the job before anything is sent', async () => {
    const w = world();
    w.addNote('Inbox/a.md', '![[x.mp3]]', ['Inbox/x.mp3']);
    w.addMedia('Inbox/x.mp3', MP3);
    const scan = await scanOk(w.deps.vault, { config: w.set.config, policy: w.set.policy, journal: w.journal(), isSwept: w.deps.isSwept });
    await syncEntries(w.deps, scan);
    const real = w.deps.journal.mutate;
    w.deps.journal.mutate = async (fn, o) => real((j) => { const next = fn(j); return Object.keys(next.entries).length === Object.keys(j.entries).length && getEntry(j, 'Inbox/a.md')?.state === 'ready' ? { ...next, entries: {} } : next; }, o);
    await runJobs(w.deps, scan, { cancelled: () => false }, 10);
    expect(w.calls.transcribe).toEqual([]);
  });
});

describe('proposal validation', () => {
  it('drops a folder the model made up and falls back to a folder whose words match the text', async () => {
    const w = world();
    w.set.classify = async () => ok({ tags: ['a'], suggestedTitle: 'T', suggestedFolder: 'Elsewhere/Secret' });
    w.addNote('Inbox/a.md', 'Planning the work roadmap for next quarter', []);
    await w.go();
    expect(getEntry(w.journal(), 'Inbox/a.md')!.proposal!.folder).toBe('Areas/Work');
  });

  it('puts only the capture text and the offered folders into the model prompt', async () => {
    const w = world();
    w.addNote('Inbox/a.md', 'Some typed words about the garden', []);
    await w.go();
    const prompt = w.calls.classify[0];
    expect(prompt.stablePrefix).toContain('Areas/Home');
    expect(prompt.stablePrefix).toContain('Existing tags used in this scope: None');
    expect(prompt.prompt).toContain('garden');
  });
});

describe('syncEntries (stability and edits)', () => {
  it('creates a waiting entry on first sight of a fresh note, then promotes it once stable', async () => {
    const w = world();
    w.addNote('Inbox/a.md', 'Fresh typed capture words here', []);
    w.files.get('Inbox/a.md')!.info.mtime = NOW - 1000;
    const scan = await scanOk(w.deps.vault, { config: w.set.config, policy: w.set.policy, journal: w.journal(), isSwept: w.deps.isSwept });
    await syncEntries(w.deps, scan);
    expect(getEntry(w.journal(), 'Inbox/a.md')!.state).toBe('waiting_for_stable');
  });

  it('waits for a note whose attachment has not arrived', async () => {
    const w = world();
    w.addNote('Inbox/a.md', '![[x.mp3]]', ['Inbox/x.mp3']);
    w.addMedia('Inbox/x.mp3', MP3, 0);
    await w.go({ passes: 3 });
    expect(getEntry(w.journal(), 'Inbox/a.md')!.state).toBe('waiting_for_stable');
    expect(w.calls.transcribe).toEqual([]);
  });

  it('a capture edited while awaiting review drops its results and never re-processes without asking', async () => {
    const w = world();
    w.addNote('Inbox/a.md', 'Original typed words for review', []);
    await w.go();
    expect(getEntry(w.journal(), 'Inbox/a.md')!.state).toBe('awaiting_review');
    const calls = w.calls.classify.length;
    w.files.get('Inbox/a.md')!.text = 'Original typed words for review, now edited';
    await w.go({ passes: 3 });
    const e = getEntry(w.journal(), 'Inbox/a.md')!;
    expect(e).toMatchObject({ state: 'waiting_for_stable', needsConfirm: true });
    expect(e.proposal).toBeUndefined();
    expect(w.calls.classify.length).toBe(calls);
  });

  it('requireMarker keeps a capture waiting until the completion marker exists', async () => {
    const w = world();
    w.set.config = { ...baseConfig, requireMarker: true };
    w.addNote('Inbox/a.md', 'Typed capture words here now', []);
    await w.go({ passes: 3 });
    expect(getEntry(w.journal(), 'Inbox/a.md')!.state).toBe('waiting_for_stable');
    w.addNote('Inbox/a.md', '---\ncapture-complete: true\n---\nTyped capture words here now', []);
    await w.go({ passes: 3 });
    expect(getEntry(w.journal(), 'Inbox/a.md')!.state).toBe('awaiting_review');
  });
});
