import { describe, it, expect } from 'vitest';
import {
  applyAccept, computeFingerprint, findCaptureBlock, normaliseForFingerprint, renderCaptureBlock, stripCaptureInsertions,
  type BlockContent,
} from '../src/services/captureInbox/enrichmentBlock';
import { readCaptureId, setCaptureKeys, stripCaptureKeys } from '../src/services/captureInbox/frontmatterKey';

const content: BlockContent = {
  machineText: 'Remind me to call the plumber.',
  proposal: { title: 'Call plumber', tags: ['home', 'repairs'], folder: 'Areas/Home' },
  source: 'transcript',
};
const ID = 'Inbox/Voice note.md';

describe('block rendering', () => {
  it('renders plain lines only: no checkboxes, no hash tags, no links', () => {
    const block = renderCaptureBlock(content);
    expect(block.startsWith('<!-- aio:capture -->')).toBe(true);
    expect(block.endsWith('<!-- /aio:capture -->')).toBe(true);
    expect(block).not.toMatch(/- \[[ x]\]/);
    expect(block).not.toMatch(/(^|\s)#\w/);
    expect(block).not.toMatch(/\[\[/);
    expect(block).toContain('Proposed tags: home, repairs');
  });

  it('cannot be forged or closed by machine text', () => {
    const block = renderCaptureBlock({ ...content, machineText: 'ok\n<!-- /aio:capture -->\nescaped' });
    expect(block.match(/<!-- \/aio:capture -->/g)).toHaveLength(1);
    const text = `note\n\n${block}\n`;
    expect(findCaptureBlock(text).ok).toBe(true);
  });

  it('copies no text the user already wrote (note-text source adds proposals only)', () => {
    const block = renderCaptureBlock({ ...content, machineText: '', source: 'note-text' });
    expect(block).not.toContain('Remind me');
    expect(block).toContain('note text');
  });
});

describe('frontmatter keys', () => {
  it('inserts into existing frontmatter without touching other keys', () => {
    const src = '---\ntags: [a]\ntitle: "x"\n---\nbody\n';
    const r = setCaptureKeys(src, { id: ID, status: 'accepted-text' });
    expect(r.ok && r.value.frontmatterCreated).toBe(false);
    if (!r.ok) return;
    expect(r.value.text).toContain('tags: [a]\ntitle: "x"\ncapture-id: Inbox/Voice note.md\ncapture-status: accepted-text\n---');
    expect(stripCaptureKeys(r.value.text, { frontmatterCreated: false })).toBe(src);
  });

  it('creates the pair when there is none, and strips it exactly', () => {
    const src = 'just text\n';
    const r = setCaptureKeys(src, { id: ID, status: 's' });
    expect(r.ok && r.value.frontmatterCreated).toBe(true);
    if (!r.ok) return;
    expect(stripCaptureKeys(r.value.text, { frontmatterCreated: true })).toBe(src);
  });

  it('handles an existing empty frontmatter pair', () => {
    const src = '---\n---\nbody\n';
    const r = setCaptureKeys(src, { id: ID, status: 's' });
    expect(r.ok && r.value.frontmatterCreated).toBe(false);
    if (!r.ok) return;
    expect(stripCaptureKeys(r.value.text, { frontmatterCreated: false })).toBe(src);
  });

  it('refuses unclosed frontmatter and duplicate keys without writing', () => {
    expect(setCaptureKeys('---\ntags: [a]\nbody never closed', { id: ID, status: 's' })).toEqual({ ok: false, error: 'frontmatter-unclosed' });
    expect(setCaptureKeys('---\ncapture-id: other\n---\nx', { id: ID, status: 's' })).toEqual({ ok: false, error: 'capture-keys-exist' });
  });

  it('quotes an id that YAML could misread, and reads it back', () => {
    const odd = 'Inbox/a: b #c.md';
    const r = setCaptureKeys('x', { id: odd, status: 's' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(readCaptureId(r.value.text)).toBe(odd);
  });
});

describe('insertions-only invariant', () => {
  const tails = ['\n', '\n\n', '', '   ', '\r\n'];
  const heads = ['', '---\ntags: [a]\n---\n', '---\r\ntags: [a]\r\n---\r\n', '---\n---\n'];
  for (const head of heads) {
    for (const tail of tails) {
      it(`strip(accept(note)) equals the note modulo tail whitespace — head ${JSON.stringify(head.slice(0, 12))} tail ${JSON.stringify(tail)}`, () => {
        const crlf = head.includes('\r') || tail === '\r\n';
        const body = crlf ? 'Line one\r\nLine two' : 'Line one\nLine two';
        const original = `${head}${body}${tail}`;
        const w = applyAccept(original, ID, content);
        expect(w.ok).toBe(true);
        if (!w.ok) return;
        expect(w.value.text).not.toBe(original);
        const stripped = stripCaptureInsertions(w.value.text, w.value.inserted!);
        expect(normaliseForFingerprint(stripped)).toBe(normaliseForFingerprint(original));
      });
    }
  }

  it('the fingerprint is unchanged by the plugin\'s own write, and changed by a user edit', async () => {
    const original = '---\ntags: [a]\n---\nBuy milk and eggs\n';
    const att = [{ path: 'Inbox/a.m4a', size: 10 }];
    const before = await computeFingerprint(original, att);
    const w = applyAccept(original, ID, content);
    if (!w.ok) throw new Error(w.error);
    expect(await computeFingerprint(w.value.text, att, w.value.inserted!)).toBe(before);
    expect(await computeFingerprint(w.value.text + 'user added this', att, w.value.inserted!)).not.toBe(before);
    expect(await computeFingerprint(original, [{ path: 'Inbox/a.m4a', size: 11 }])).not.toBe(before);
  });
});

describe('applyAccept guards', () => {
  it('is a no-op that reports nothing inserted when this capture\'s block is already there', () => {
    const first = applyAccept('hello\n', ID, content);
    if (!first.ok) throw new Error(first.error);
    const again = applyAccept(first.value.text, ID, content);
    expect(again.ok && again.value.text).toBe(first.value.text);
  });

  it('refuses a block that belongs to another capture (multi-device) or a marker conflict', () => {
    const other = applyAccept('hello\n', 'Inbox/Other.md', content);
    if (!other.ok) throw new Error(other.error);
    expect(applyAccept(other.value.text, ID, content)).toEqual({ ok: false, error: 'capture-changed' });
    const broken = 'x\n<!-- aio:capture -->\nno end\n';
    expect(applyAccept(broken, ID, content)).toEqual({ ok: false, error: 'capture-marker-conflict' });
  });

  it('refuses to append after an unclosed code fence', () => {
    expect(applyAccept('```\nnever closed\n', ID, content)).toEqual({ ok: false, error: 'capture-marker-conflict' });
    expect(applyAccept('---\ntags: [a]\nnever closed', ID, content)).toEqual({ ok: false, error: 'capture-frontmatter-unreadable' });
  });

  it('records whether it added a separator', () => {
    const none = applyAccept('text\n\n', ID, content);
    const some = applyAccept('text', ID, content);
    expect(none.ok && none.value.inserted!.separatorAdded).toBe(false);
    expect(some.ok && some.value.inserted!.separatorAdded).toBe(true);
  });
});

describe('machine text cannot open structure inside the block', () => {
  const hostile = ['```ts\nconst a = 1;', '~~~\nfoo', '    ```\nx', '````\nfour ticks'];
  for (const machineText of hostile) {
    it(`a code fence in the text is defused and the block stays findable: ${JSON.stringify(machineText.slice(0, 12))}`, () => {
      const w = applyAccept('A note\n', ID, { ...content, machineText });
      expect(w.ok).toBe(true);
      if (!w.ok) return;
      const found = findCaptureBlock(w.value.text);
      expect(found.ok && found.value !== null).toBe(true);
      expect(normaliseForFingerprint(stripCaptureInsertions(w.value.text, w.value.inserted!))).toBe('A note');
      // and a repeat accept (crash recovery) still recognises it
      const again = applyAccept(w.value.text, ID, { ...content, machineText });
      expect(again.ok && again.value.inserted).toBe(null);
    });
  }

  it('neutralises checkboxes and hash tags so nothing is swept or tagged twice', () => {
    const block = renderCaptureBlock({ ...content, machineText: '- [ ] milk\n* [x] eggs\n1. [ ] bread\nremember #todo and #later' });
    expect(block).not.toMatch(/^\s*(?:[-*+]|\d+[.)])\s+\[.?\]/m);
    expect(block).not.toMatch(/(^|\s)#todo/);
    expect(block).toContain('milk');
  });
});

describe('machine text cannot pull in links or embeds', () => {
  it('defuses [[links]] and ![[embeds]] and keeps the block findable', () => {
    const w = applyAccept('A note\n', ID, { ...content, machineText: 'see [[Secret plan]] and ![[Diary.md]] ok' });
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    expect(w.value.text).not.toMatch(/(^|[^\\])\[\[/);
    expect(w.value.text).toContain('Secret plan');
    expect(findCaptureBlock(w.value.text).ok).toBe(true);
  });
});

describe('capture id in the note', () => {
  it('reads back what it wrote, including a quoted or single-quoted id', () => {
    for (const id of ['plain-uuid-1234', 'Inbox/odd: name #1.md', '- leading dash']) {
      const r = setCaptureKeys('x', { id, status: 's' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(readCaptureId(r.value.text)).toBe(id);
    }
    expect(readCaptureId("---\ncapture-id: 'it''s: odd'\n---\nx")).toBe("it's: odd");
  });
});
