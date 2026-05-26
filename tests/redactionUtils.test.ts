import { describe, it, expect } from 'vitest';
import { redactPII } from '../src/utils/redactionUtils';

describe('redactPII', () => {
    it('redacts email addresses', () => {
        expect(redactPII('contact me at foo@example.com please', 500))
            .toBe('contact me at [email] please');
    });

    it('redacts URLs', () => {
        expect(redactPII('see https://example.com/path?q=1 for details', 500))
            .toBe('see [url] for details');
    });

    it('redacts phone numbers with ≥7 digits', () => {
        const out = redactPII('call +1 555-867-5309 today', 500);
        expect(out).toContain('[phone]');
        expect(out).not.toContain('5309');
    });

    it('does NOT false-positive on dates like 12-05-2026', () => {
        const out = redactPII('on 12-05-2026 we met', 500);
        expect(out).toContain('12-05-2026');
        expect(out).not.toContain('[phone]');
    });

    it('does NOT false-positive on version strings like 2.5.0', () => {
        const out = redactPII('upgrade to 2.5.0 today', 500);
        expect(out).toContain('2.5.0');
    });

    it('truncates AFTER redaction (PII never sneaks past)', () => {
        const long = 'foo@example.com ' + 'a'.repeat(300);
        const out = redactPII(long, 30);
        expect(out.length).toBeLessThanOrEqual(30);
        expect(out).not.toContain('foo@example.com');
        expect(out.endsWith('…')).toBe(true);
    });

    it('returns empty string for empty input', () => {
        expect(redactPII('', 100)).toBe('');
    });

    it('passes plain text through unchanged when under cap', () => {
        expect(redactPII('plain text', 100)).toBe('plain text');
    });
});
