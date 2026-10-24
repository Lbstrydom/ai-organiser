import { describe, it, expect } from 'vitest';
import { checkSignature, classifyByExtension, extensionOf } from '../src/services/captureInbox/mediaSignature';
import { SUPPORTED_AUDIO_FORMATS } from '../src/services/audioTranscriptionService';

const bytes = (...b: number[]) => new Uint8Array(b);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

describe('media signature', () => {
  it('knows exactly the audio formats the transcription service supports', () => {
    for (const ext of SUPPORTED_AUDIO_FORMATS) expect(classifyByExtension(`x.${ext}`)).toBe('audio');
    expect(classifyByExtension('x.aac')).toBeNull();
    expect(classifyByExtension('x.caf')).toBeNull();
    expect(classifyByExtension('x.amr')).toBeNull();
  });

  it('accepts real signatures', () => {
    expect(checkSignature('a.mp3', bytes(...ascii('ID3'), 4, 0))).toEqual({ ok: true, kind: 'audio' });
    expect(checkSignature('a.mp3', bytes(0xff, 0xfb, 0x90))).toEqual({ ok: true, kind: 'audio' });
    expect(checkSignature('a.wav', bytes(...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')))).toEqual({ ok: true, kind: 'audio' });
    expect(checkSignature('a.m4a', bytes(0, 0, 0, 0x20, ...ascii('ftypM4A ')))).toEqual({ ok: true, kind: 'audio' });
    expect(checkSignature('a.ogg', bytes(...ascii('OggS'), 0))).toEqual({ ok: true, kind: 'audio' });
    expect(checkSignature('a.webm', bytes(0x1a, 0x45, 0xdf, 0xa3))).toEqual({ ok: true, kind: 'audio' });
    expect(checkSignature('p.png', bytes(0x89, ...ascii('PNG')))).toEqual({ ok: true, kind: 'image' });
    expect(checkSignature('p.JPG', bytes(0xff, 0xd8, 0xff, 0xe0))).toEqual({ ok: true, kind: 'image' });
    expect(checkSignature('p.heic', bytes(0, 0, 0, 0x18, ...ascii('ftypheic')))).toEqual({ ok: true, kind: 'image' });
    expect(checkSignature('p.webp', bytes(...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP')))).toEqual({ ok: true, kind: 'image' });
  });

  it('accepts an m4a that starts with a wide or free atom', () => {
    expect(checkSignature('a.m4a', bytes(0, 0, 0, 8, ...ascii('wide')))).toEqual({ ok: true, kind: 'audio' });
    expect(checkSignature('a.m4a', bytes(0, 0, 0, 8, ...ascii('free')))).toEqual({ ok: true, kind: 'audio' });
  });

  it('refuses a renamed or truncated file before anything is uploaded', () => {
    expect(checkSignature('a.mp3', bytes(...ascii('%PDF-1.7')))).toEqual({ ok: false, reason: 'mismatch' });
    expect(checkSignature('a.m4a', bytes(1, 2))).toEqual({ ok: false, reason: 'mismatch' });
    expect(checkSignature('p.png', bytes(0xff, 0xd8, 0xff))).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('refuses a zero-byte file and an unsupported or markup format', () => {
    expect(checkSignature('a.mp3', new Uint8Array(0))).toEqual({ ok: false, reason: 'empty' });
    expect(checkSignature('a.amr', bytes(1))).toEqual({ ok: false, reason: 'unsupported' });
    expect(checkSignature('drawing.svg', bytes(...ascii('<svg')))).toEqual({ ok: false, reason: 'unsupported' });
    expect(checkSignature('noext', bytes(1))).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('reads the extension from the last path segment only', () => {
    expect(extensionOf('Inbox/v1.2/clip')).toBe('');
    expect(extensionOf('Inbox/clip.M4A')).toBe('m4a');
    expect(extensionOf('Inbox/.hidden')).toBe('');
  });
});
