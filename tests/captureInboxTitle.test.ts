import { describe, it, expect } from 'vitest';
import { sanitiseTitle, uniquePath } from '../src/services/captureInbox/titleSanitiser';

describe('sanitiseTitle', () => {
  it('strips path, link and file-system structure', () => {
    expect(sanitiseTitle('../../etc/passwd')).toBe('etc passwd');
    expect(sanitiseTitle('A [[link]] #tag: ^block | pipe?')).toBe('A link tag block pipe');
    expect(sanitiseTitle('C:\\Windows\\System32')).toBe('C Windows System32');
  });

  it('removes control and bidi characters and collapses whitespace', () => {
    expect(sanitiseTitle('a\u0000b\u202ec\n\td')).toBe('a b c d');
  });

  it('falls back for empty, dot-only, reserved or non-string input', () => {
    expect(sanitiseTitle('')).toBe('Capture');
    expect(sanitiseTitle('...')).toBe('Capture');
    expect(sanitiseTitle('CON')).toBe('Capture');
    expect(sanitiseTitle('nul.txt', 'Voice note')).toBe('Voice note');
    expect(sanitiseTitle(42, 'Fallback')).toBe('Fallback');
    expect(sanitiseTitle('///', '///')).toBe('Capture');
  });

  it('caps the length by characters, not UTF-16 units', () => {
    const t = sanitiseTitle('😀'.repeat(200));
    expect([...t].length).toBeLessThanOrEqual(80);
  });
});

describe('uniquePath', () => {
  it('never overwrites: adds _2, _3...', () => {
    const taken = new Set(['A/T.md', 'A/T_2.md']);
    expect(uniquePath('A', 'T', 'md', (p) => taken.has(p))).toBe('A/T_3.md');
    expect(uniquePath('A/', 'Free', 'md', () => false)).toBe('A/Free.md');
    expect(uniquePath('', 'Root', 'md', () => false)).toBe('Root.md');
  });
});
