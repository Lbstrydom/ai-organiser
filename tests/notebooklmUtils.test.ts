import { describe, it, expect } from 'vitest';
import { formatBytes, sanitizeFilename, resolveOutputName } from '../src/services/notebooklm/notebooklmUtils';

describe('formatBytes', () => {
    it('formats bytes under 1 KB', () => {
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(512)).toBe('512 B');
        expect(formatBytes(1023)).toBe('1023 B');
    });

    it('formats KB range', () => {
        expect(formatBytes(1024)).toBe('1.0 KB');
        expect(formatBytes(1536)).toBe('1.5 KB');
        expect(formatBytes(10240)).toBe('10.0 KB');
        expect(formatBytes(1024 * 1024 - 1)).toBe('1024.0 KB');
    });

    it('formats MB range', () => {
        expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
        expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
        expect(formatBytes(200 * 1024 * 1024)).toBe('200.0 MB');
    });
});

describe('sanitizeFilename', () => {
    it('replaces invalid path characters with dashes and collapses them', () => {
        // 9 consecutive invalid chars → 9 dashes → collapsed to 1 dash by the /-+/g rule
        expect(sanitizeFilename('file<>:"/\\|?*name')).toBe('file-name');
    });

    it('replaces spaces with underscores', () => {
        expect(sanitizeFilename('my note title')).toBe('my_note_title');
    });

    it('collapses consecutive dashes', () => {
        expect(sanitizeFilename('file---name')).toBe('file-name');
    });

    it('trims leading and trailing dashes', () => {
        expect(sanitizeFilename('-leading')).toBe('leading');
        expect(sanitizeFilename('trailing-')).toBe('trailing');
    });

    it('limits length to 200 characters', () => {
        const long = 'a'.repeat(300);
        expect(sanitizeFilename(long).length).toBe(200);
    });

    it('handles empty string', () => {
        expect(sanitizeFilename('')).toBe('');
    });

    it('preserves dots in filenames', () => {
        expect(sanitizeFilename('my.note')).toBe('my.note');
    });
});

describe('resolveOutputName', () => {
    it('returns base name when no collision', () => {
        const used = new Set<string>();
        const result = resolveOutputName('My Note', 'txt', used);
        expect(result).toBe('My_Note.txt');
        expect(used.has('my_note.txt')).toBe(true);
    });

    it('appends counter on first collision', () => {
        const used = new Set<string>(['my_note.txt']);
        const result = resolveOutputName('My Note', 'txt', used);
        expect(result).toBe('My_Note-2.txt');
    });

    it('increments counter until unique', () => {
        const used = new Set<string>(['my_note.txt', 'my_note-2.txt', 'my_note-3.txt']);
        const result = resolveOutputName('My Note', 'txt', used);
        expect(result).toBe('My_Note-4.txt');
    });

    it('is case-insensitive for collision detection', () => {
        // The used set must be pre-populated with lowercase (the function always adds lowercase)
        const used = new Set<string>(['my_note.txt']);
        const result = resolveOutputName('My Note', 'txt', used);
        expect(result).toBe('My_Note-2.txt');
    });

    it('mutates the used set with the resolved name', () => {
        const used = new Set<string>();
        resolveOutputName('Note A', 'txt', used);
        resolveOutputName('Note A', 'txt', used);
        expect(used.size).toBe(2);
        expect(used.has('note_a.txt')).toBe(true);
        expect(used.has('note_a-2.txt')).toBe(true);
    });

    it('handles pdf extension', () => {
        const used = new Set<string>();
        const result = resolveOutputName('My Note', 'pdf', used);
        expect(result).toBe('My_Note.pdf');
    });

    it('notes and sidecars share the used set', () => {
        const used = new Set<string>();
        const noteResult = resolveOutputName('Document', 'txt', used);
        const sidecarResult = resolveOutputName('Document', 'pdf', used);
        expect(noteResult).toBe('Document.txt');
        expect(sidecarResult).toBe('Document.pdf');
        expect(used.size).toBe(2);
    });
});
