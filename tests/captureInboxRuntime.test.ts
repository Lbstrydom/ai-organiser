import { describe, it, expect, vi } from 'vitest';

vi.stubGlobal('window', globalThis);

import { CaptureRuntime, HINT_DEBOUNCE_MS, MIN_AUTO_INTERVAL_MS, type RuntimeDeps } from '../src/services/captureInbox/captureRuntime';
import { acceptCapture, type WriterDeps, type WriterPort } from '../src/services/captureInbox/captureWriter';
import { getEntry, upsertEntry } from '../src/services/captureInbox/captureJournal';
import { computeFingerprint } from '../src/services/captureInbox/enrichmentBlock';
import { extractLinkTargets, withoutCode } from '../src/services/captureInbox/captureVaultPort';
import { sha256Hex } from '../src/services/attachmentDuplicateService';
import { ok, err, type Result } from '../src/core/result';
import { emptyJournal, type CaptureConfig, type CaptureEntry, type CaptureJournal } from '../src/services/captureInbox/captureTypes';
import type { SweepPolicy } from '../src/services/inboxSweep/sweepGuard';

const config: CaptureConfig = {
  inboxFolders: ['Inbox'], destinationRoot: 'Areas', since: 0, onOpen: true, onOpenMaxPerRun: 1, maxPerRun: 10,
  maxAttachmentBytes: 1000, minWords: 3, digitiseImages: false, maxImagesPerCapture: 3, maxTextChars: 12000,
  stabilityMs: 8000, requireMarker: false,
};
const policy: SweepPolicy = { excludedFolders: [], excludedTags: [], excludedProperties: [], excludedTerms: [], protectedFolders: [], maxNoteChars: 20000 };

function setup(over: { enabled?: () => boolean; visible?: () => boolean; allowed?: () => boolean; blocker?: () => string | null } = {}) {
  let journal: CaptureJournal = emptyJournal();
  let clock = 50_000_000;
  const files = new Map<string, { size: number; text?: string }>();
  const transcribe = vi.fn(async (): Promise<Result<string>> => ok('spoken words'));
  const classify = vi.fn(async () => ok({ tags: ['a'], suggestedTitle: 'T' }));
  const access = { get: () => journal, mutate: async (fn: (j: CaptureJournal) => CaptureJournal) => (journal = fn(journal)), mutateLazy: (fn: (j: CaptureJournal) => CaptureJournal) => { journal = fn(journal); } };
  const writerPort: WriterPort = {
    readNote: async (p) => files.get(p)?.text ?? null,
    editNote: async (p, _b, recompute) => { const r = recompute(files.get(p)!.text!); if (!r.ok) return err<void>(r.error); files.get(p)!.text = r.value.content; return ok(undefined); },
    createNote: async (p, c) => { files.set(p, { size: c.length, text: c }); return ok(p); },
    pathExists: (p) => files.has(p), folderExists: () => true, fileSize: async (p) => files.get(p)?.size ?? null, fileDigest: async () => null,
    findNoteByFrontmatter: () => null,
  };
  const writer: WriterDeps = { port: writerPort, journal: access, config: () => config, policy: () => policy, isSwept: async () => false, protectedFolders: () => [], outputRoots: () => [], now: () => clock };
  const deps: RuntimeDeps = {
    journal: access, config: () => config, policy: () => policy, now: () => clock,
    port: { readBytes: async () => new Uint8Array([0x49, 0x44, 0x33, 4]), stat: async (p) => { const f = files.get(p); return f ? { size: f.size, mtime: 1 } : null; }, exists: (p) => files.has(p) },
    vault: {
      listFiles: () => [...files].map(([path, f]) => ({ path, extension: path.split('.').pop()!, ctime: 1, mtime: 1, size: f.size })),
      readText: async (p) => files.get(p)?.text ?? '',
      resolveAttachments: (p) => ({ resolved: p === 'Inbox/a.md' ? ['Inbox/a.mp3'] : [], unresolvedMedia: [] }),
      referrersOf: () => [],
      digestOf: async () => sha256Hex(new Uint8Array([0x49, 0x44, 0x33, 4]).buffer),
    },
    isSwept: async () => false, isEnabled: over.enabled ?? (() => true),
    digitisationEnabled: () => true, transcribe, digitise: async () => ok('x'), classify,
    taxonomyPrompt: () => 'T', language: () => 'default', maxTags: () => 3, formatTags: (t) => t.map(String),
    listFolders: () => ['Areas'], folderAllowed: () => true,
    writer, isVisible: over.visible ?? (() => true), autoRunAllowed: over.allowed ?? (() => true), blocker: over.blocker ?? (() => null),
  };
  files.set('Inbox/a.md', { size: 20, text: '![[a.mp3]]' });
  files.set('Inbox/a.mp3', { size: 100 });
  return { deps, journal: () => journal, set: (j: CaptureJournal) => { journal = j; }, transcribe, classify, tick: (ms: number) => { clock += ms; }, files, writerPort };
}

describe('CaptureRuntime', () => {
  it('a manual run scans, settles and processes; a refresh never calls a provider', async () => {
    const s = setup();
    const rt = new CaptureRuntime(s.deps);
    await rt.refresh();
    expect(s.transcribe).not.toHaveBeenCalled();
    s.tick(10_000); // the capture has now stayed unchanged for longer than the stability window
    const r = await rt.runOnce({ trigger: 'manual' });
    expect(r?.summary.awaitingReview).toBe(1);
    expect(s.transcribe).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the feature is off or Obsidian is not visible', async () => {
    const off = setup({ enabled: () => false });
    expect(await new CaptureRuntime(off.deps).runOnce({ trigger: 'manual' })).toBeNull();
    expect(await new CaptureRuntime(off.deps).refresh()).toBeNull();
    const hidden = setup({ visible: () => false });
    expect(await new CaptureRuntime(hidden.deps).runOnce({ trigger: 'manual' })).toBeNull();
    expect(off.transcribe).not.toHaveBeenCalled();
    expect(hidden.transcribe).not.toHaveBeenCalled();
  });

  it('automatic runs need the one-time confirmation, the opt-in, a bounded size and spacing', async () => {
    const notYet = setup({ allowed: () => false });
    expect(await new CaptureRuntime(notYet.deps).runOnce({ trigger: 'auto' })).toBeNull();
    const s = setup();
    const rt = new CaptureRuntime(s.deps);
    expect(await rt.runOnce({ trigger: 'auto' })).not.toBeNull();
    expect(await rt.runOnce({ trigger: 'auto' })).toBeNull();
    s.tick(MIN_AUTO_INTERVAL_MS + 1);
    expect(await rt.runOnce({ trigger: 'auto' })).not.toBeNull();
  });

  it('does not run two jobs at once', async () => {
    const s = setup();
    let release: (() => void) | undefined;
    s.transcribe.mockImplementation(() => new Promise<Result<string>>((resolve) => { release = () => resolve(ok('words here')); }));
    const rt = new CaptureRuntime(s.deps);
    const first = rt.runOnce({ trigger: 'manual' });
    for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 20));

    expect(rt.isRunning()).toBe(true);
    expect(await rt.runOnce({ trigger: 'manual' })).toBeNull();
    release!();
    await first;
    expect(s.transcribe).toHaveBeenCalledTimes(1);
  });

  it('cancel discards an in-flight result', async () => {
    const s = setup();
    const rt = new CaptureRuntime(s.deps);
    s.transcribe.mockImplementation(async () => { rt.cancel(); return ok('secret words'); });
    await rt.runOnce({ trigger: 'manual' });
    expect(getEntry(s.journal(), 'Inbox/a.md')!.state).toBe('ready');
    expect(JSON.stringify(s.journal())).not.toContain('secret words');
  });

  it('a file event is only a hint: it refreshes after the debounce and never processes', async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      const rt = new CaptureRuntime(s.deps);
      rt.hint(); rt.hint(); rt.hint();
      await vi.advanceTimersByTimeAsync(HINT_DEBOUNCE_MS + 10);
      vi.useRealTimers(); // the refresh hashes with native crypto, which fake timers cannot flush
      await new Promise((r) => setTimeout(r, 100));
      expect(s.transcribe).not.toHaveBeenCalled();
      expect(getEntry(s.journal(), 'Inbox/a.md')).toBeDefined();
      rt.dispose();
    } finally { vi.useRealTimers(); }
  });

  it('dispose stops everything', async () => {
    const s = setup();
    const rt = new CaptureRuntime(s.deps);
    rt.dispose();
    expect(await rt.runOnce({ trigger: 'manual' })).toBeNull();
  });
});

describe('recovery after a crash', () => {
  const base = { processingVersion: 1, attempts: 0, createdAt: 1, updatedAt: 1, hasNote: true } as const;

  it('fails an interrupted job at its stage and leaves entries that are only waiting alone', async () => {
    const s = setup();
    let j = upsertEntry(emptyJournal(), { ...base, id: 'Inbox/p.md', state: 'processing', stage: 'transcribe', fingerprint: 'f' });
    j = upsertEntry(j, { ...base, id: 'Inbox/r.md', state: 'awaiting_review', fingerprint: 'f', text: 'held transcript' });
    j = upsertEntry(j, { ...base, id: 'Inbox/w.md', state: 'waiting_for_stable', fingerprint: 'f' });
    s.set(j);
    await new CaptureRuntime(s.deps).recoverOnStart();
    expect(getEntry(s.journal(), 'Inbox/p.md')).toMatchObject({ state: 'failed', failedStage: 'transcribe', attempts: 1 });
    expect(getEntry(s.journal(), 'Inbox/r.md')).toMatchObject({ state: 'awaiting_review', text: 'held transcript' });
    expect(getEntry(s.journal(), 'Inbox/w.md')!.state).toBe('waiting_for_stable');
    expect(s.transcribe).not.toHaveBeenCalled();
  });

  async function pending(withBlock: boolean) {
    const s = setup();
    const text = 'Typed words for the note\n';
    s.files.set('Inbox/n.md', { size: text.length, text });
    const fingerprint = await computeFingerprint(text, []);
    s.set(upsertEntry(emptyJournal(), { ...base, id: 'Inbox/n.md', state: 'awaiting_review', fingerprint, source: 'transcript', text: 'machine words', attachments: [], proposal: { title: 'T', tags: [], folder: null } }));
    // run the real accept, then simulate a crash that left the journal at accept_pending_write
    const r = await acceptCapture(s.deps.writer, 'Inbox/n.md');
    expect(r.ok).toBe(true);
    const written = s.files.get('Inbox/n.md')!.text!;
    s.set(upsertEntry(s.journal(), { ...getEntry(s.journal(), 'Inbox/n.md')!, state: 'accept_pending_write' }));
    if (!withBlock) s.files.get('Inbox/n.md')!.text = text;
    return { s, written, text };
  }

  it('an Accept that was written but not recorded is marked accepted without a second write', async () => {
    const { s } = await pending(true);
    const before = s.files.get('Inbox/n.md')!.text;
    await new CaptureRuntime(s.deps).recoverOnStart();
    expect(s.files.get('Inbox/n.md')!.text).toBe(before);
    expect(getEntry(s.journal(), 'Inbox/n.md')?.state).toBe('accepted');
  });

  it('an Accept that never reached the note is retried once, and only that write', async () => {
    const { s, text } = await pending(false);
    expect(s.files.get('Inbox/n.md')!.text).toBe(text);
    await new CaptureRuntime(s.deps).recoverOnStart();
    expect(s.files.get('Inbox/n.md')!.text).toContain('<!-- aio:capture -->');
    expect(getEntry(s.journal(), 'Inbox/n.md')!.state).toBe('accepted');
  });
});

describe('audit regressions (runtime)', () => {
  it('a file event that arrives while a run is active is looked at when the run ends, not dropped', async () => {
    const s = setup();
    let release: (() => void) | null = null;
    s.transcribe.mockImplementation(() => new Promise<Result<string>>((resolve) => { release = () => resolve(ok('words here')); }));
    const rt = new CaptureRuntime(s.deps);
    const run = rt.runOnce({ trigger: 'manual' });
    for (let i = 0; i < 100 && release === null; i++) await new Promise((r) => setTimeout(r, 20));
    expect(release).not.toBeNull();
    s.files.set('Inbox/late.md', { size: 30, text: 'a late arriving typed note' });
    expect(await rt.refresh()).toBeNull(); // busy: deferred, not dropped
    release!();
    await run;
    await new Promise((r) => setTimeout(r, HINT_DEBOUNCE_MS + 600));
    expect(getEntry(s.journal(), 'Inbox/late.md')).toBeDefined();
    rt.dispose();
  });

  it('neither a manual nor an automatic run starts while the run precondition fails (keep-out emptied after the first run)', async () => {
    const s = setup({ blocker: () => 'capture-keepout-required' });
    const rt = new CaptureRuntime(s.deps);
    expect(await rt.runOnce({ trigger: 'auto' })).toBeNull();
    expect(await rt.runOnce({ trigger: 'manual' })).toBeNull();
    expect(s.transcribe).not.toHaveBeenCalled();
  });

  it('an automatic run never widens its scope to existing notes, whatever the caller asks', async () => {
    const s = setup();
    const seen: Array<boolean | undefined> = [];
    const orig = s.deps.vault.listFiles;
    s.deps.vault.listFiles = () => orig().map((f) => ({ ...f, ctime: 1 }));
    const rt = new CaptureRuntime({ ...s.deps, config: () => ({ ...config, since: 1000 }) });
    const r = await rt.runOnce({ trigger: 'auto', includeExisting: true });
    seen.push(r?.scan.olderIgnored === 0 ? true : false);
    expect(r?.scan.captures).toEqual([]);
    expect(r?.scan.olderIgnored).toBeGreaterThan(0);
  });

  it('recovery waits for a run in flight instead of failing its jobs', async () => {
    const s = setup();
    let release: (() => void) | undefined;
    s.transcribe.mockImplementation(() => new Promise<Result<string>>((resolve) => { release = () => resolve(ok('words here')); }));
    const rt = new CaptureRuntime(s.deps);
    const run = rt.runOnce({ trigger: 'manual' });
    for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 20));
    await rt.recoverOnStart();
    expect(getEntry(s.journal(), 'Inbox/a.md')!.state).toBe('processing');
    release!();
    await run;
  });

  it('a bare-media Accept that reached the companion completes its journal half on recovery (no duplicate capture)', async () => {
    const s = setup();
    s.files.set('Inbox/memo.m4a', { size: 100 });
    const media = 'Inbox/memo.m4a';
    const companion = 'Inbox/memo (capture).md';
    const uid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    s.files.set(companion, { size: 50, text: `---\ncapture-id: ${uid}\n---\n![[${media}]]\n<!-- aio:capture -->\nCapture inbox: transcript.\n<!-- /aio:capture -->\n` });
    s.set(upsertEntry(emptyJournal(), { id: media, uid, state: 'accept_pending_write', fingerprint: 'f', processingVersion: 1, attempts: 0, createdAt: 1, updatedAt: 1, hasNote: false, companionPath: companion, text: 'x', attachments: [] }));
    await new CaptureRuntime(s.deps).recoverOnStart();
    const j = s.journal();
    expect(j.aliases[media]).toBe(companion);
    expect(getEntry(j, companion)?.state).toBe('accepted');
    expect(j.counters.acceptedUnchanged + j.counters.acceptedEdited).toBe(0);
    // the scanner now settles the companion instead of offering it as a new capture
    const again = await new CaptureRuntime(s.deps).runOnce({ trigger: 'manual' });
    expect(again?.scan.captures.map((c) => c.id)).not.toContain(companion);
    expect(again?.scan.captures.map((c) => c.id)).not.toContain(media);
  });
});

describe('links in code are text, not attachments', () => {
  it('ignores fenced code (backticks and tildes, any length) and inline code', () => {
    const text = ['![[real.m4a]]', '```md', '![[in-fence.m4a]]', '```', '~~~~', '![](in-tilde.png)', '~~~~', 'use `![[inline.m4a]]` like so', '![[after.m4a]]'].join('\n');
    expect(extractLinkTargets(text).sort()).toEqual(['after.m4a', 'real.m4a']);
  });

  it('an unclosed fence hides the rest, and a shorter or different closing fence does not end it', () => {
    expect(extractLinkTargets('![[a.m4a]]\n```\n![[b.m4a]]')).toEqual(['a.m4a']);
    expect(extractLinkTargets('````\n```\n![[b.m4a]]\n````\n![[c.m4a]]')).toEqual(['c.m4a']);
    expect(extractLinkTargets('```\n~~~\n![[b.m4a]]\n```\n![[c.m4a]]')).toEqual(['c.m4a']);
  });

  it('ignores multi-backtick code spans and brackets this plugin escaped itself', () => {
    expect(extractLinkTargets('Literal ``![[voice.m4a]]`` and ```![[two.m4a]]``` and \\[[escaped.m4a]] but ![[real.m4a]]')).toEqual(['real.m4a']);
  });

  it('withoutCode keeps line structure', () => {
    expect(withoutCode('a\n```\nx\n```\nb').split('\n')).toHaveLength(5);
  });
});

describe('extractLinkTargets (bounded and complete)', () => {
  it('reads angle-bracket destinations that contain spaces', () => {
    expect(extractLinkTargets('![](<voice memo.m4a>) ![x](plain.png "title")').sort()).toEqual(['plain.png', 'voice memo.m4a']);
  });

  it('stays fast on long runs of unmatched brackets', () => {
    const t0 = Date.now();
    extractLinkTargets('[['.repeat(80_000));
    extractLinkTargets('!['.repeat(80_000));
    extractLinkTargets('[x]('.repeat(40_000));
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe('extractLinkTargets', () => {
  it('reads wiki and markdown links, strips alias and heading, skips web links', () => {
    expect(extractLinkTargets('![[a.m4a]] [[Note#Head|alias]] ![x](img%20one.png) [web](https://x.com/y.png) [[ ]]').sort()).toEqual(['Note', 'a.m4a', 'img one.png']);
  });
});

void ({} as CaptureEntry);
