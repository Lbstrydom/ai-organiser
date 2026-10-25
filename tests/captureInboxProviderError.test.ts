import { describe, it, expect } from 'vitest';
import { endSentence, friendlyProviderError } from '../src/services/captureInbox/providerErrorText';
import { titleSeed } from '../src/services/captureInbox/titleSanitiser';

describe('friendlyProviderError: no raw provider text reaches the user', () => {
  const raw = 'API error (500): {"error":{"message":"The server had an error while processing your request","type":"server_error","request_id":"req_123abc"}}';

  it('maps the common failures to one sentence that says what to do, and never echoes the raw answer', () => {
    const cases: Array<[string, RegExp]> = [
      [raw, /could not be reached or had a problem/],
      ['API error (401): {"error":{"message":"Incorrect API key provided: sk-abc"}}', /API key/],
      ['HTTP 429 Too Many Requests', /limiting requests/],
      ['413 Payload Too Large', /too large/],
      ['Failed to load image', /could not read the file/],
      ['something nobody planned for', /could not complete the request/],
    ];
    for (const [input, expected] of cases) {
      const text = friendlyProviderError(input);
      expect(text).toMatch(expected);
      expect(text).not.toMatch(/[{}]|req_|sk-abc|server_error/);
      expect(text.endsWith('.')).toBe(true);
    }
  });

  it('joins sentences properly', () => {
    expect(endSentence('Failed to load image')).toBe('Failed to load image.');
    expect(endSentence('Already done.')).toBe('Already done.');
    expect(endSentence('  ')).toBe('');
  });
});

describe('titleSeed keeps what the user wrote for a fallback title', () => {
  it('keeps a clock time (as 14.30), reduces links to their names and drops urls', () => {
    const body = 'Call Dana at 14:30 about the kickoff, see [[Project Zephyr|the plan]] and https://example.com/x for more.';
    expect(titleSeed(body, 'ignored')).toBe('Call Dana at 14.30 about the');
    expect(titleSeed('See [[Project Zephyr#Goals]] now', 'x')).toBe('See Project Zephyr now');
  });

  it('falls back to the stripped text when the note has no words of its own', () => {
    expect(titleSeed('![[clip.m4a]]\n', 'Call the plumber about the leak')).toBe('Call the plumber about the leak');
  });
});
