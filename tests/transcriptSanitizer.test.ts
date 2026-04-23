import { describe, it, expect } from 'vitest';
import { sanitizeTranscriptPaste } from '../src/utils/transcriptSanitizer';

describe('sanitizeTranscriptPaste', () => {
    it('returns empty for empty input', () => {
        expect(sanitizeTranscriptPaste('')).toBe('');
    });

    it('preserves plain text', () => {
        const t = 'Alice: Welcome everyone.\nBob: Thanks!';
        expect(sanitizeTranscriptPaste(t)).toBe(t);
    });

    it('strips markdown image refs pointing at file://', () => {
        const t = 'Before text\n![](file:///C:/Users/User/AppData/Local/Temp/msohtmlclip1/01/clip_image076.gif)\nAfter text';
        const out = sanitizeTranscriptPaste(t);
        expect(out).not.toContain('file://');
        expect(out).not.toContain('clip_image076');
        expect(out).toContain('Before text');
        expect(out).toContain('After text');
    });

    it('strips html <img src="file://..."> tags', () => {
        const t = 'Notes <img src="file:///C:/clip_image001.gif" alt="x"> continue';
        const out = sanitizeTranscriptPaste(t);
        expect(out).not.toContain('file://');
        expect(out).not.toContain('<img');
        expect(out).toContain('Notes');
        expect(out).toContain('continue');
    });

    it('strips bare file:// URLs', () => {
        const t = 'See file:///C:/Users/User/AppData/Local/Temp/clip.gif here.';
        const out = sanitizeTranscriptPaste(t);
        expect(out).not.toContain('file://');
    });

    it('strips bare clip_image fragments left over from plain-text pastes', () => {
        const t = 'paragraph\nclip_image012.gif\nnext paragraph';
        const out = sanitizeTranscriptPaste(t);
        expect(out).not.toContain('clip_image012');
        expect(out).toContain('paragraph');
        expect(out).toContain('next paragraph');
    });

    it('collapses towers of blank lines after removal', () => {
        const t = 'a\n\n\n\n\n\nb';
        const out = sanitizeTranscriptPaste(t);
        expect(out).toBe('a\n\nb');
    });

    it('handles the pathological Office-paste case', () => {
        const t = [
            'Meeting transcript:',
            '![](file:///C:/Users/X/AppData/Local/Temp/msohtmlclip1/01/clip_image076.gif)',
            '![](file:///C:/Users/X/AppData/Local/Temp/msohtmlclip1/01/clip_image077.gif)',
            '![](file:///C:/Users/X/AppData/Local/Temp/msohtmlclip1/01/clip_image078.gif)',
            'Alice: Let\'s begin.',
        ].join('\n');
        const out = sanitizeTranscriptPaste(t);
        expect(out).toContain('Meeting transcript:');
        expect(out).toContain("Alice: Let's begin.");
        expect(out).not.toContain('file://');
        expect(out).not.toContain('clip_image');
    });
});
