import { describe, it, expect } from 'vitest';
import { scanInbox, type CaptureVaultPort, type ScanOutcome, type VaultFileInfo } from '../src/services/captureInbox/captureScanner';
import { finish, upsertEntry, addAlias } from '../src/services/captureInbox/captureJournal';
import { ok, err } from '../src/core/result';
import { emptyJournal, type CaptureConfig } from '../src/services/captureInbox/captureTypes';
import type { SweepPolicy } from '../src/services/inboxSweep/sweepGuard';

const config: CaptureConfig = {
  inboxFolders: ['Inbox'], destinationRoot: 'Areas', since: 1000, onOpen: false, onOpenMaxPerRun: 3, maxPerRun: 10,
  maxAttachmentBytes: 10 * 1024 * 1024, minWords: 3, digitiseImages: false, maxImagesPerCapture: 3, maxTextChars: 12000,
  stabilityMs: 8000, requireMarker: false,
};
const policy: SweepPolicy = { excludedFolders: ['Private'], excludedTags: ['secret'], excludedProperties: [], excludedTerms: ['acme'], protectedFolders: ['Protected'], maxNoteChars: 20000 };

/** The scan outcome of a scan that must have succeeded. */
async function scanOk(...args: Parameters<typeof scanInbox>): Promise<ScanOutcome> {
  const r = await scanInbox(...args);
  if (!r.ok) throw new Error(`scan failed: ${r.error}`);
  return r.value;
}

const f = (path: string, over: Partial<VaultFileInfo> = {}): VaultFileInfo => ({ path, extension: path.split('.').pop() ?? '', ctime: 5000, mtime: 5000, size: 100, ...over });

const digests: Record<string, string> = {};
function port(files: VaultFileInfo[], texts: Record<string, string>, links: Record<string, { resolved?: string[]; unresolvedMedia?: string[] }> = {}) {
  const reads: string[] = [];
  const p: CaptureVaultPort = {
    listFiles: () => files,
    readText: async (path) => { reads.push(path); return ok(texts[path] ?? ''); },
    resolveAttachments: (path) => ({ resolved: links[path]?.resolved ?? [], unresolvedMedia: links[path]?.unresolvedMedia ?? [] }),
    referrersOf: (p) => Object.entries(links).filter(([, l]) => (l.resolved ?? []).includes(p)).map(([n]) => n),
    digestOf: async (path, size) => ok(digests[path] ?? `d:${path}:${size}`),
  };
  return { p, reads };
}
const deps = (over = {}) => ({ config, policy, journal: emptyJournal(), isSwept: async () => false, ...over });

describe('scanInbox', () => {
  it('finds notes in the inbox and its subfolders only, never elsewhere', async () => {
    const { p } = port([f('Inbox/a.md'), f('Inbox/sub/b.md'), f('Elsewhere/c.md'), f('InboxLike/d.md')], { 'Inbox/a.md': 'hello world today', 'Inbox/sub/b.md': 'more words here' });
    const r = await scanOk(p, deps());
    expect(r.captures.map((c) => c.id).sort()).toEqual(['Inbox/a.md', 'Inbox/sub/b.md']);
  });

  it('never reads the text of a note whose path is protected or kept out', async () => {
    const q = port([f('Private/x.md'), f('Protected/y.md')], {});
    const r = await scanOk(q.p, deps({ config: { ...config, inboxFolders: ['Private', 'Protected'] } }));
    expect(q.reads).toEqual([]);
    expect(r.skipped.map((s) => s.reason)).toEqual(['excluded', 'excluded']);
  });

  it('excludes by tag or term after reading, and records the skip', async () => {
    const { p } = port([f('Inbox/t.md'), f('Inbox/w.md')], { 'Inbox/t.md': 'x #secret', 'Inbox/w.md': 'call ACME' });
    const r = await scanOk(p, deps());
    expect(r.captures).toEqual([]);
    expect(r.skipped).toEqual([{ id: 'Inbox/t.md', reason: 'excluded' }, { id: 'Inbox/w.md', reason: 'excluded' }]);
  });

  it('excludes the whole capture when ANY attachment sits in a kept-out folder', async () => {
    const { p } = port([f('Inbox/n.md'), f('Private/a.m4a')], { 'Inbox/n.md': 'text here now' }, { 'Inbox/n.md': { resolved: ['Private/a.m4a'] } });
    const r = await scanOk(p, deps());
    expect(r.skipped).toEqual([{ id: 'Inbox/n.md', reason: 'excluded' }]);
  });

  it('a kept-out note keeps its media out: the file it embeds is never listed as a bare capture', async () => {
    const files = [f('Inbox/t.md'), f('Inbox/a.m4a'), f('Inbox/p.m4a'), f('Private/n.md'), f('Inbox/q.m4a')];
    const { p } = port(files, { 'Inbox/t.md': 'call acme today' }, {
      'Inbox/t.md': { resolved: ['Inbox/a.m4a'] },
      'Private/n.md': { resolved: ['Inbox/p.m4a'] },
    });
    const r = await scanOk(p, deps());
    expect(r.captures.map((c) => c.id)).toEqual(['Inbox/q.m4a']);
    expect(r.captures.map((c) => c.id)).not.toContain('Inbox/p.m4a');
    expect(r.captures.map((c) => c.id)).not.toContain('Inbox/a.m4a');
  });

  it('ignores notes older than the setup cutoff (counted) unless the user asks for all', async () => {
    const files = [f('Inbox/old.md', { ctime: 10 }), f('Inbox/new.md')];
    const { p } = port(files, { 'Inbox/old.md': 'old words here', 'Inbox/new.md': 'new words here' });
    const r = await scanOk(p, deps());
    expect(r.captures.map((c) => c.id)).toEqual(['Inbox/new.md']);
    expect(r.olderIgnored).toBe(1);
    const all = await scanOk(p, deps({ includeExisting: true }));
    expect(all.captures).toHaveLength(2);
  });

  it('attaches referenced media (even outside the inbox) and does not list it again as a bare capture', async () => {
    const files = [f('Inbox/n.md'), f('Inbox/a.m4a', { size: 500 }), f('Elsewhere/p.png', { size: 700 })];
    const { p } = port(files, { 'Inbox/n.md': '![[a.m4a]] ![[p.png]]' }, { 'Inbox/n.md': { resolved: ['Inbox/a.m4a', 'Elsewhere/p.png', 'Other note.md'] } });
    const r = await scanOk(p, deps());
    expect(r.captures).toHaveLength(1);
    expect(r.captures[0].attachments.map((a) => [a.path, a.kind, a.size])).toEqual([['Inbox/a.m4a', 'audio', 500], ['Elsewhere/p.png', 'image', 700]]);
  });

  it('turns a bare media file into a note-less capture, and skips one that already has a companion', async () => {
    const files = [f('Inbox/memo.m4a'), f('Inbox/done.m4a')];
    const j = addAlias(emptyJournal(), 'Inbox/done.m4a', 'Inbox/done (capture).md');
    const { p } = port(files, {});
    const r = await scanOk(p, deps({ journal: j }));
    expect(r.captures.map((c) => [c.id, c.notePath])).toEqual([['Inbox/memo.m4a', null]]);
  });

  it('names an unsupported media format instead of ignoring it, and skips an oversized attachment without reading it', async () => {
    const files = [f('Inbox/x.caf'), f('Inbox/big.m4a', { size: 11 * 1024 * 1024 })];
    const { p, reads } = port(files, {});
    const r = await scanOk(p, deps());
    expect(r.skipped).toEqual([{ id: 'Inbox/x.caf', reason: 'unsupported' }, { id: 'Inbox/big.m4a', reason: 'too-large' }]);
    expect(reads).toEqual([]);
  });

  it('reports media that is referenced but not resolvable yet, so the capture waits', async () => {
    const { p } = port([f('Inbox/n.md')], { 'Inbox/n.md': '![[later.m4a]]' }, { 'Inbox/n.md': { unresolvedMedia: ['later.m4a'] } });
    const r = await scanOk(p, deps());
    expect(r.captures[0].missingAttachments).toEqual(['later.m4a']);
  });

  it('skips an already-swept note', async () => {
    const { p } = port([f('Inbox/s.md')], { 'Inbox/s.md': 'swept words here' });
    const r = await scanOk(p, deps({ isSwept: async () => true }));
    expect(r.skipped).toEqual([{ id: 'Inbox/s.md', reason: 'already-swept' }]);
  });

  it('never re-offers an accepted capture, and re-offers a skipped one only when it changed', async () => {
    const { p } = port([f('Inbox/a.md'), f('Inbox/b.md')], { 'Inbox/a.md': 'aaa bbb ccc', 'Inbox/b.md': 'ddd eee fff' });
    const first = await scanOk(p, deps());
    const [a, b] = first.captures;
    const base = { processingVersion: 1, attempts: 0, createdAt: 1, updatedAt: 1 } as const;
    let j = upsertEntry(emptyJournal(), { ...base, id: a.id, state: 'accepted', fingerprint: a.fingerprint });
    j = finish(j, a.id, 'accepted', 1);
    j = upsertEntry(j, { ...base, id: b.id, state: 'skipped_by_user', fingerprint: b.fingerprint });
    j = finish(j, b.id, 'skipped_by_user', 1);
    expect((await scanOk(p, deps({ journal: j }))).captures).toEqual([]);
    const edited = port([f('Inbox/a.md'), f('Inbox/b.md')], { 'Inbox/a.md': 'aaa bbb ccc EDITED', 'Inbox/b.md': 'ddd eee fff EDITED' });
    const r = await scanOk(edited.p, deps({ journal: j }));
    expect(r.captures.map((c) => c.id)).toEqual(['Inbox/b.md']);
  });

  it('an accepted note\'s media is not offered again as a bare capture (entry or tombstone)', async () => {
    const files = [f('Inbox/n.md'), f('Inbox/a.m4a')];
    const links = { 'Inbox/n.md': { resolved: ['Inbox/a.m4a'] } };
    const { p } = port(files, { 'Inbox/n.md': 'accepted words here' }, links);
    const base = { processingVersion: 1, attempts: 0, createdAt: 1, updatedAt: 1, fingerprint: 'f' } as const;
    const withEntry = upsertEntry(emptyJournal(), { ...base, id: 'Inbox/n.md', state: 'accepted' });
    expect((await scanOk(p, deps({ journal: withEntry }))).captures).toEqual([]);
    const withTomb = finish(upsertEntry(emptyJournal(), { ...base, id: 'Inbox/n.md', state: 'accepted' }), 'Inbox/n.md', 'accepted', 1);
    expect((await scanOk(p, deps({ journal: withTomb }))).captures).toEqual([]);
  });

  it('when one attachment is kept out, the note\'s other attachments are not listed as bare either', async () => {
    const files = [f('Inbox/n.md'), f('Private/a.m4a'), f('Inbox/b.m4a')];
    const { p } = port(files, { 'Inbox/n.md': 'text here now' }, { 'Inbox/n.md': { resolved: ['Private/a.m4a', 'Inbox/b.m4a'] } });
    const r = await scanOk(p, deps());
    expect(r.captures).toEqual([]);
    expect(r.skipped).toEqual([{ id: 'Inbox/n.md', reason: 'excluded' }]);
  });

  it('media embedded by ANY note elsewhere is that note\'s, whatever the note contains (it is never read)', async () => {
    const files = [f('Elsewhere/secret.md'), f('Inbox/a.m4a')];
    const { p, reads } = port(files, { 'Elsewhere/secret.md': 'x #secret' }, { 'Elsewhere/secret.md': { resolved: ['Inbox/a.m4a'] } });
    const r = await scanOk(p, deps());
    expect(r.captures).toEqual([]);
    expect(reads).toEqual([]);
  });

  it('falls back to the modification time when the platform gives no creation time', async () => {
    const files = [f('Inbox/old.md', { ctime: 0, mtime: 10 }), f('Inbox/new.md', { ctime: 0, mtime: 9000 })];
    const { p } = port(files, { 'Inbox/old.md': 'old words here', 'Inbox/new.md': 'new words here' });
    const r = await scanOk(p, deps());
    expect(r.captures.map((c) => c.id)).toEqual(['Inbox/new.md']);
    expect(r.olderIgnored).toBe(1);
  });

  it('a same-size attachment swap changes the fingerprint (content, not just length, identifies a capture)', async () => {
    const files = [f('Inbox/n.md'), f('Inbox/a.m4a', { size: 500 })];
    const links = { 'Inbox/n.md': { resolved: ['Inbox/a.m4a'] } };
    const { p } = port(files, { 'Inbox/n.md': 'typed words here now' }, links);
    digests['Inbox/a.m4a'] = 'digest-one';
    const first = await scanOk(p, deps());
    digests['Inbox/a.m4a'] = 'digest-two';
    const second = await scanOk(p, deps());
    delete digests['Inbox/a.m4a'];
    expect(first.captures[0].attachments[0]).toMatchObject({ size: 500, digest: 'digest-one' });
    expect(second.captures[0].fingerprint).not.toBe(first.captures[0].fingerprint);
  });

  it('never reads (digests) a file that is kept out or too large', async () => {
    const read: string[] = [];
    const files = [f('Inbox/n.md'), f('Private/a.m4a'), f('Inbox/big.m4a', { size: 11 * 1024 * 1024 }), f('Inbox/m.md'), f('Inbox/ok.m4a', { size: 5 })];
    const base = port(files, { 'Inbox/n.md': 'x words here now', 'Inbox/m.md': 'y words here now' }, { 'Inbox/n.md': { resolved: ['Private/a.m4a', 'Inbox/big.m4a'] }, 'Inbox/m.md': { resolved: ['Inbox/ok.m4a'] } });
    base.p.digestOf = async (path) => { read.push(path); return ok('d'); };
    await scanOk(base.p, deps());
    expect(read).toEqual(['Inbox/ok.m4a']);
  });

  it('a failing vault read is a scan error, never a rejection', async () => {
    const { p } = port([f('Inbox/n.md')], {});
    p.listFiles = () => { throw new Error('index is rebuilding'); };
    expect(await scanInbox(p, deps())).toEqual({ ok: false, error: 'capture-scan-failed' });
  });

  it('a note that cannot be read is left for the next scan; the other captures still scan and its media is not offered bare', async () => {
    const files = [f('Inbox/bad.md'), f('Inbox/good.md'), f('Inbox/a.m4a', { size: 5 })];
    const { p } = port(files, { 'Inbox/good.md': 'typed words here now' }, { 'Inbox/bad.md': { resolved: ['Inbox/a.m4a'] } });
    const real = p.readText;
    p.readText = async (path) => (path === 'Inbox/bad.md' ? err('capture-read-failed') : real(path));
    const r = await scanOk(p, deps());
    expect(r.captures.map((c) => c.id)).toEqual(['Inbox/good.md']);
  });

  it('a capture whose attachment cannot be read yet waits instead of being judged on an unknown identity', async () => {
    const files = [f('Inbox/n.md'), f('Inbox/a.m4a', { size: 500 })];
    const { p } = port(files, { 'Inbox/n.md': 'typed words here now' }, { 'Inbox/n.md': { resolved: ['Inbox/a.m4a'] } });
    p.digestOf = async () => err('capture-read-failed');
    const r = await scanOk(p, deps());
    expect(r.captures[0].missingAttachments).toEqual(['Inbox/a.m4a']);
    const bare = port([f('Inbox/m.m4a')], {});
    bare.p.digestOf = async () => err('capture-read-failed');
    expect((await scanOk(bare.p, deps())).captures).toEqual([]);
  });

  it('an attachment the snapshot does not list yet is still arriving: the capture waits, with no guessed size', async () => {
    const files = [f('Inbox/n.md')];
    const { p } = port(files, { 'Inbox/n.md': 'typed words here now' }, { 'Inbox/n.md': { resolved: ['Inbox/arriving.m4a'] } });
    const r = await scanOk(p, deps());
    expect(r.captures[0].attachments).toEqual([]);
    expect(r.captures[0].missingAttachments).toEqual(['Inbox/arriving.m4a']);
  });

  it('does nothing without an inbox folder', async () => {
    const { p, reads } = port([f('Inbox/a.md')], {});
    const r = await scanOk(p, deps({ config: { ...config, inboxFolders: [] } }));
    expect(r).toEqual({ captures: [], skipped: [], olderIgnored: 0 });
    expect(reads).toEqual([]);
  });
});
