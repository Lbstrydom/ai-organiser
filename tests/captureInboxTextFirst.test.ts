import { describe, it, expect } from 'vitest';
import { planSources, usableText, userText, wordCount, type TextFirstInput } from '../src/services/captureInbox/textFirst';

const base: TextFirstInput = {
  body: '', fileName: 'Voice note 2026-10-24.md', audioCount: 0, imageCount: 0, unsupportedCount: 0,
  minWords: 3, digitiseImagesWithText: false, digitisationEnabled: true, maxImages: 3,
};
const plan = (o: Partial<TextFirstInput>) => planSources({ ...base, ...o });

describe('usableText', () => {
  it('ignores frontmatter, embeds, links, urls, dates, times, the plugin block and a filename heading', () => {
    const body = [
      '---', 'tags: [a]', '---',
      '# Voice note 2026-10-24', '![[clip.m4a]]', '[[Some page]] 10:32', 'https://example.com/x 2026-10-24',
      '<!-- aio:capture -->', 'Capture inbox: transcript.', 'words words words words', '<!-- /aio:capture -->',
    ].join('\n');
    expect(wordCount(usableText(body, 'Voice note 2026-10-24.md'))).toBe(0);
  });

  it('counts the words the user wrote, in any script', () => {
    expect(wordCount(usableText('Buy milk tomorrow', 'x.md'))).toBe(3);
    expect(wordCount(usableText('明天 买 牛奶', 'x.md'))).toBe(5);
  });
});

const EXAMPLE = 'Call Dana at 14:30 on 2026-10-30 about the room, spec is at https://example.com/spec and see [[Project Zephyr migration]] for the plan.';

describe('userText keeps what the user wrote', () => {
  it('leaves links, urls, dates and clock times exactly as typed', () => {
    expect(userText(EXAMPLE, 'Call Dana.md')).toBe(EXAMPLE);
    expect(userText(`${EXAMPLE}\n\nSee [[Another page]].`, 'x.md')).toBe(`${EXAMPLE}\n\nSee [[Another page]].`);
    // the word count and the prompt still use the stripped words
    expect(usableText(EXAMPLE, 'x.md')).not.toContain('14:30');
    expect(usableText(EXAMPLE, 'x.md')).not.toContain('[[');
  });

  it('still drops what is not the user\'s: frontmatter, the plugin block and a heading that repeats the file name', () => {
    const body = ['---', 'tags: [a]', '---', '# Call Dana', EXAMPLE, '<!-- aio:capture -->', 'Capture inbox: transcript.', 'machine words', '<!-- /aio:capture -->'].join('\n');
    expect(userText(body, 'Call Dana.md')).toBe(EXAMPLE);
  });
});

describe('userText is not a word-count pipeline', () => {
  it('keeps Windows line endings, indentation, a long note and a plain line that equals the file name', () => {
    const body = 'Call Dana\r\n    indented line with 14:30\r\n\r\nlast line https://example.com\r\n';
    expect(userText(body, 'Call Dana.md')).toBe('Call Dana\r\n    indented line with 14:30\r\n\r\nlast line https://example.com');
    const long = `${'word '.repeat(40_000)}tail [[Link]]`;
    expect(userText(long, 'x.md')).toBe(long);
  });

  it('keeps trailing spaces on the last line (a Markdown line break) and a heading that differs by a date', () => {
    expect(userText('first line  \nlast with break  \n\n', 'x.md')).toBe('first line  \nlast with break  ');
    expect(userText('# Meeting 2026-10-31\nnotes\n', 'Meeting 2026-10-30.md')).toBe('# Meeting 2026-10-31\nnotes');
    // an opener with trailing spaces is frontmatter, as the writer reads it
    expect(userText('--- \ntags: [a]\n---\nbody\n', 'x.md')).toBe('body');
  });

  it('keeps a heading shown inside a code fence, and an empty frontmatter block is still frontmatter', () => {
    const body = 'Example:\n```md\n# Draft\n```\n';
    expect(userText(body, 'Draft.md')).toBe('Example:\n```md\n# Draft\n```');
    expect(userText('---\n---\nbody\n', 'x.md')).toBe('body');
    // a longer fence is not closed by a shorter run inside it
    const nested = 'Example:\n````md\n```\n# Draft\n````\nafter\n';
    expect(userText(nested, 'Draft.md')).toBe('Example:\n````md\n```\n# Draft\n````\nafter');
  });

  it('drops a heading that repeats the file name, and only a heading', () => {
    expect(userText('# Call Dana\nbody 14:30\n', 'Call Dana.md')).toBe('body 14:30');
    expect(userText('Call Dana\nbody\n', 'Call Dana.md')).toBe('Call Dana\nbody');
  });
});

describe('planSources', () => {
  it('dictation or typed text with no attachments uses the note text only', () => {
    expect(plan({ body: 'Call the plumber about the leak' })).toMatchObject({ source: 'note-text', useNoteText: true, transcribeAudio: false });
  });

  it('usable text plus audio: no audio upload, and the review says so', () => {
    const p = plan({ body: 'Twenty words of typed context about the meeting', audioCount: 1 });
    expect(p).toMatchObject({ source: 'note-text', transcribeAudio: false, audioSkippedBecauseText: true });
  });

  it('the explicit "transcribe anyway" action transcribes despite text', () => {
    const p = plan({ body: 'Some typed context here', audioCount: 1, forceTranscribe: true });
    expect(p).toMatchObject({ source: 'mixed', transcribeAudio: true, audioSkippedBecauseText: false });
  });

  it('filename-only note with audio transcribes', () => {
    expect(plan({ body: '# Voice note 2026-10-24\n![[a.m4a]]', audioCount: 1 })).toMatchObject({ source: 'transcript', transcribeAudio: true, useNoteText: false });
  });

  it('image only is digitised, capped, and needs the digitisation feature', () => {
    expect(plan({ imageCount: 5 })).toMatchObject({ source: 'digitised', digitiseImages: 3 });
    expect(plan({ imageCount: 2, digitisationEnabled: false })).toMatchObject({ source: null, skip: 'digitisation-off' });
  });

  it('audio and image with no text processes both', () => {
    expect(plan({ audioCount: 1, imageCount: 1 })).toMatchObject({ source: 'mixed', transcribeAudio: true, digitiseImages: 1 });
  });

  it('images attached to a note with text are digitised only when the opt-in is on', () => {
    const t = { body: 'Whiteboard from the planning meeting today', imageCount: 2 };
    expect(plan(t)).toMatchObject({ source: 'note-text', digitiseImages: 0 });
    expect(plan({ ...t, digitiseImagesWithText: true })).toMatchObject({ source: 'mixed', digitiseImages: 2 });
    expect(plan({ ...t, digitiseImagesWithText: true, digitisationEnabled: false }).digitiseImages).toBe(0);
  });

  it('minWords of zero or less cannot make an empty body usable (the audio is still transcribed)', () => {
    expect(plan({ body: '', audioCount: 1, minWords: 0 })).toMatchObject({ source: 'transcript', transcribeAudio: true });
    expect(plan({ body: '', audioCount: 1, minWords: -5 })).toMatchObject({ transcribeAudio: true });
  });

  it('counts unspaced CJK text by characters and ignores raw html tags', () => {
    expect(wordCount('今天买牛奶')).toBe(5);
    expect(plan({ body: '今天买牛奶', audioCount: 1 })).toMatchObject({ source: 'note-text', transcribeAudio: false });
    expect(wordCount(usableText('<audio src="a.m4a" controls>', 'x.md'))).toBe(0);
  });

  it('counts CJK characters inside a run that also holds latin letters', () => {
    expect(wordCount('abc日本語')).toBe(4);
    expect(wordCount('hello世界')).toBe(3);
  });

  it('stays fast on a hostile note full of unclosed brackets', () => {
    const t0 = Date.now();
    usableText('[['.repeat(60_000), 'x.md');
    usableText('!['.repeat(60_000), 'x.md');
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('names an unsupported-only capture and an empty one', () => {
    expect(plan({ unsupportedCount: 1 })).toMatchObject({ source: null, skip: 'unsupported' });
    expect(plan({})).toMatchObject({ source: null, skip: 'nothing-to-process' });
  });
});
