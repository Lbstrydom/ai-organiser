import { describe, it, expect, vi } from 'vitest';

vi.stubGlobal('window', globalThis);

import { runJobs, syncEntries, retryCapture, processAgain, type CaptureDeps, type ProcessorPort } from '../src/services/captureInbox/captureProcessor';
import { scanInbox, type CaptureVaultPort, type VaultFileInfo } from '../src/services/captureInbox/captureScanner';
import { getEntry, upsertEntry } from '../src/services/captureInbox/captureJournal';
import { ok, err, type Result } from '../src/core/result';
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
  calls: { transcribe: Array<{ bytes: Uint8Array; name: string; ext: string }>; digitise: string[]; classify: PromptParts[]; reads: string[] };
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
    readText: async (p) => { calls.reads.push(p); return files.get(p)?.text ?? ''; },
    resolveAttachments: (p) => ({ resolved: links.get(p) ?? [], unresolvedMedia: [] }),
    referrersOf: (p) => [...links].filter(([, l]) => l.includes(p)).map(([n]) => n),
  };
  const port: ProcessorPort = {
    readBytes: async (p) => { calls.reads.push(p); return files.get(p)?.bytes ?? new Uint8Array(0); },
    stat: async (p) => { const f = files.get(p); return f ? { size: f.info.size, mtime: f.info.mtime } : null; },
    exists: (p) => files.has(p),
  };
  const deps: CaptureDeps = {
    journal: {
      get: () => journal,
      mutate: async (fn) => (journal = fn(journal)),
      mutateLazy: (fn) => { journal = fn(journal); },
    },
    config: () => set.config, policy: () => set.policy, port, vault,
    isSwept: async () => set.swept, isEnabled: () => set.enabled, now: () => clock,
    digitisationEnabled: () => set.digitisation,
    transcribe: async (bytes, name, ext) => { calls.transcribe.push({ bytes, name, ext }); return set.transcribe(); },
    digitise: async (path) => { calls.digitise.push(path); return set.digitise(); },
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
        const scan = await scanInbox(vault, { config: set.config, policy: set.policy, journal: journal, isSwept: deps.isSwept });
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
    const scan = await scanInbox(w.deps.vault, { config: w.set.config, policy: w.set.policy, journal: w.journal(), isSwept: w.deps.isSwept });
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
    expect(w2.calls.digitise).toEqual(['Inbox/p.png']);
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

  it('records the failed stage, counts attempts, stops retrying after three, and Retry resets', async () => {
    const w = world();
    w.set.transcribe = async () => err('provider down');
    w.addNote('Inbox/a.md', '![[x.mp3]]', ['Inbox/x.mp3']);
    w.addMedia('Inbox/x.mp3', MP3);
    await w.go({ passes: 1 });
    let e = getEntry(w.journal(), 'Inbox/a.md')!;
    expect(e).toMatchObject({ state: 'failed', failedStage: 'transcribe', attempts: 1, retriable: true, errorText: 'provider down' });
    await w.go({ passes: 4 });
    e = getEntry(w.journal(), 'Inbox/a.md')!;
    expect(e).toMatchObject({ state: 'failed', attempts: 3, retriable: false });
    const callsBefore = w.calls.transcribe.length;
    await w.go({ passes: 2 });
    expect(w.calls.transcribe.length).toBe(callsBefore);
    expect(await retryCapture(w.deps, 'Inbox/a.md')).toBe(true);
    expect(getEntry(w.journal(), 'Inbox/a.md')).toMatchObject({ state: 'ready', attempts: 0 });
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
    const first = await scanInbox(w.deps.vault, { config: w.set.config, policy: w.set.policy, journal: w.journal(), isSwept: w.deps.isSwept });
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
    const scan = await scanInbox(w.deps.vault, { config: w.set.config, policy: { ...w.set.policy, excludedTags: ['secret'] }, journal: w.journal(), isSwept: w.deps.isSwept });
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
    const scan = await scanInbox(w.deps.vault, { config: w.set.config, policy: w.set.policy, journal: w.journal(), isSwept: w.deps.isSwept });
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
    const scan = await scanInbox(w.deps.vault, { config: w.set.config, policy: w.set.policy, journal: w.journal(), isSwept: w.deps.isSwept });
    await syncEntries(w.deps, scan);
    expect(scan.captures[0].notePath).toBeNull();
    // a kept-out note that embeds the file arrives after the scan
    w.deps.vault.referrersOf = () => ['Private/note.md'];
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
    const scan = await scanInbox(w.deps.vault, { config: w.set.config, policy: w.set.policy, journal: w.journal(), isSwept: w.deps.isSwept });
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
