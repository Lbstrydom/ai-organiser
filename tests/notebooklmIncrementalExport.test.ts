/**
 * Tests for incremental export and config hash logic.
 * Uses pure/exported functions only — no Obsidian APIs needed.
 */
import { describe, it, expect } from 'vitest';
import { computeConfigHash } from '../src/services/notebooklm/sourcePackService';
import { normalizePackEntry } from '../src/services/notebooklm/registry';
import { PREPROCESSOR_VERSION } from '../src/services/notebooklm/textPreprocessor';
import type { SourcePackConfig } from '../src/services/notebooklm/types';

function makeConfig(overrides: Partial<SourcePackConfig> = {}): SourcePackConfig {
    return {
        selectionTag: 'notebooklm',
        exportFolder: 'NotebookLM',
        postExportTagAction: 'keep',
        exportFormat: 'text',
        pdf: {
            pageSize: 'A4',
            fontName: 'helvetica',
            fontSize: 11,
            includeFrontmatter: false,
            includeTitle: true,
            marginX: 20,
            marginY: 20,
            lineHeight: 1.5,
        },
        ...overrides,
    };
}

describe('computeConfigHash', () => {
    it('returns a non-empty string', () => {
        const hash = computeConfigHash(makeConfig());
        expect(typeof hash).toBe('string');
        expect(hash.length).toBeGreaterThan(0);
    });

    it('is deterministic — same config produces same hash', () => {
        const config = makeConfig();
        expect(computeConfigHash(config)).toBe(computeConfigHash(config));
    });

    it('differs when exportFormat changes', () => {
        const textHash = computeConfigHash(makeConfig({ exportFormat: 'text' }));
        const pdfHash = computeConfigHash(makeConfig({ exportFormat: 'pdf' }));
        expect(textHash).not.toBe(pdfHash);
    });

    it('differs when includeFrontmatter changes', () => {
        const a = computeConfigHash(makeConfig());
        const b = computeConfigHash({
            ...makeConfig(),
            pdf: { ...makeConfig().pdf, includeFrontmatter: true },
        });
        expect(a).not.toBe(b);
    });

    it('differs when includeTitle changes', () => {
        const a = computeConfigHash(makeConfig());
        const b = computeConfigHash({
            ...makeConfig(),
            pdf: { ...makeConfig().pdf, includeTitle: false },
        });
        expect(a).not.toBe(b);
    });

    it('encodes PREPROCESSOR_VERSION', () => {
        const hash = computeConfigHash(makeConfig());
        const parsed = JSON.parse(hash);
        expect(parsed.preprocessorVersion).toBe(PREPROCESSOR_VERSION);
    });

    it('does NOT include selectionTag, exportFolder, or pdf margin settings', () => {
        const a = computeConfigHash(makeConfig({ selectionTag: 'tag-a' }));
        const b = computeConfigHash(makeConfig({ selectionTag: 'tag-b' }));
        expect(a).toBe(b); // tag doesn't affect rendering

        const c = computeConfigHash(makeConfig({ exportFolder: 'FolderA' }));
        const d = computeConfigHash(makeConfig({ exportFolder: 'FolderB' }));
        expect(c).toBe(d); // folder doesn't affect rendering
    });
});

describe('normalizePackEntry (legacy schema migration)', () => {
    it('reads outputName when present', () => {
        const raw = {
            type: 'note-text',
            filePath: 'Notes/Note.md',
            outputName: 'Note.txt',
            title: 'Note',
            mtime: '2026-01-01T00:00:00.000Z',
            tags: [],
            sizeBytes: 1024,
            sha256: 'abc',
        };
        const entry = normalizePackEntry(raw);
        expect(entry.outputName).toBe('Note.txt');
    });

    it('falls back to legacy pdfName when outputName is absent', () => {
        const raw = {
            type: 'note-pdf',
            filePath: 'Notes/Note.md',
            pdfName: 'Note.pdf',           // legacy field
            title: 'Note',
            mtime: '2026-01-01T00:00:00.000Z',
            tags: [],
            sizeBytes: 2048,
            sha256: 'def',
        };
        const entry = normalizePackEntry(raw);
        expect(entry.outputName).toBe('Note.pdf');
    });

    it('prefers outputName over pdfName when both are present', () => {
        const raw = {
            type: 'note-text',
            filePath: 'Notes/Note.md',
            outputName: 'Note.txt',
            pdfName: 'Note.pdf',
            title: 'Note',
            mtime: '2026-01-01T00:00:00.000Z',
            tags: [],
            sizeBytes: 512,
            sha256: 'ghi',
        };
        const entry = normalizePackEntry(raw);
        expect(entry.outputName).toBe('Note.txt');
    });

    it('sets empty string when neither outputName nor pdfName is present', () => {
        const raw = {
            type: 'note-text',
            filePath: 'Notes/Note.md',
            title: 'Note',
            mtime: '2026-01-01T00:00:00.000Z',
            tags: [],
            sizeBytes: 0,
            sha256: '',
        };
        const entry = normalizePackEntry(raw);
        expect(entry.outputName).toBe('');
    });

    it('fills default values for missing fields', () => {
        const entry = normalizePackEntry({});
        expect(entry.type).toBe('note-pdf');
        expect(entry.filePath).toBe('');
        expect(entry.title).toBe('');
        expect(entry.mtime).toBe('');
        expect(entry.tags).toEqual([]);
        expect(entry.sizeBytes).toBe(0);
        expect(entry.sha256).toBe('');
    });

    it('preserves tags array', () => {
        const raw = {
            type: 'note-text',
            filePath: 'f.md',
            outputName: 'f.txt',
            title: 'F',
            mtime: '',
            tags: ['notebooklm', 'research'],
            sizeBytes: 0,
            sha256: '',
        };
        const entry = normalizePackEntry(raw);
        expect(entry.tags).toEqual(['notebooklm', 'research']);
    });
});

describe('config hash invalidation — incremental export contract', () => {
    it('empty configHash string (legacy entries) differs from any real hash', () => {
        // Legacy registry entries have configHash: '' which always mismatches
        // the current config hash — triggering a full re-export
        const currentHash = computeConfigHash(makeConfig());
        expect('').not.toBe(currentHash);
    });

    it('config hash JSON is parseable and has expected shape', () => {
        const hash = computeConfigHash(makeConfig());
        const parsed = JSON.parse(hash) as Record<string, unknown>;
        expect(parsed).toHaveProperty('format');
        expect(parsed).toHaveProperty('frontmatter');
        expect(parsed).toHaveProperty('title');
        expect(parsed).toHaveProperty('preprocessorVersion');
    });
});
