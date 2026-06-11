/**
 * SSML builder tests (azure-audio plan D11/H6): untrusted note text is
 * XML-escaped, voices validated, budgets enforced, fail-closed everywhere.
 */

import { describe, it, expect } from 'vitest';
import {
    buildSsml,
    escapeXml,
    isValidAzureVoiceName,
    voiceLocale,
    MAX_SSML_TEXT_CHARS,
} from '../src/services/tts/ssmlBuilder';

describe('escapeXml', () => {
    it('escapes the five XML special characters', () => {
        expect(escapeXml(`<a & "b" 'c'>`)).toBe('&lt;a &amp; &quot;b&quot; &apos;c&apos;&gt;');
    });
});

describe('isValidAzureVoiceName', () => {
    it('accepts standard neural voices', () => {
        expect(isValidAzureVoiceName('en-US-AvaNeural')).toBe(true);
        expect(isValidAzureVoiceName('fi-FI-SelmaNeural')).toBe(true);
    });
    it('accepts variant-suffixed voices (Dragon HD)', () => {
        expect(isValidAzureVoiceName('en-US-Ava:DragonHDLatestNeural')).toBe(true);
    });
    it('rejects Gemini voice names and arbitrary strings', () => {
        expect(isValidAzureVoiceName('Charon')).toBe(false);
        expect(isValidAzureVoiceName('alloy')).toBe(false);
        expect(isValidAzureVoiceName('')).toBe(false);
        expect(isValidAzureVoiceName('en-US-Ava"Neural')).toBe(false);
        expect(isValidAzureVoiceName('en-US-Ava Neural')).toBe(false);
    });
});

describe('voiceLocale', () => {
    it('derives the locale prefix', () => {
        expect(voiceLocale('en-US-AvaNeural')).toBe('en-US');
        expect(voiceLocale('sv-SE-SofieNeural')).toBe('sv-SE');
    });
    it('returns null for malformed names', () => {
        expect(voiceLocale('Charon')).toBeNull();
    });
});

describe('buildSsml', () => {
    it('builds a single-voice document with xml:lang from the voice', () => {
        const r = buildSsml('Hello world', 'en-US-AvaNeural');
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error('unreachable');
        expect(r.value).toBe(
            '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">' +
            '<voice name="en-US-AvaNeural">Hello world</voice></speak>',
        );
    });

    it('XML-escapes untrusted note text (H6 — injection cannot break out)', () => {
        const r = buildSsml(
            `</voice></speak><speak><voice name="evil">pwned & <break time="10s"/>`,
            'en-US-AvaNeural',
        );
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error('unreachable');
        // No raw markup from the input survives.
        expect(r.value).not.toContain('</voice></speak><speak>');
        expect(r.value).not.toContain('<break');
        expect(r.value).toContain('&lt;/voice&gt;');
        expect(r.value).toContain('pwned &amp;');
    });

    it('explicit lang param wins over the voice locale', () => {
        const r = buildSsml('Hei', 'en-US-AvaNeural', 'fi-FI');
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error('unreachable');
        expect(r.value).toContain('xml:lang="fi-FI"');
    });

    it('malformed lang param falls back to the voice locale (fail-closed input handling)', () => {
        const r = buildSsml('Hi', 'en-US-AvaNeural', 'not a lang"');
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error('unreachable');
        expect(r.value).toContain('xml:lang="en-US"');
    });

    it('fails closed on empty text', () => {
        expect(buildSsml('', 'en-US-AvaNeural')).toEqual({ ok: false, error: 'empty-text' });
        expect(buildSsml('   ', 'en-US-AvaNeural')).toEqual({ ok: false, error: 'empty-text' });
    });

    it('fails closed on over-budget text', () => {
        const r = buildSsml('x'.repeat(MAX_SSML_TEXT_CHARS + 1), 'en-US-AvaNeural');
        expect(r).toEqual({ ok: false, error: 'text-too-long' });
    });

    it('fails closed on an invalid voice', () => {
        expect(buildSsml('Hello', 'Charon')).toEqual({ ok: false, error: 'invalid-voice' });
        expect(buildSsml('Hello', '"><script>')).toEqual({ ok: false, error: 'invalid-voice' });
    });
});
