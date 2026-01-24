import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('obsidian', async () => await import('./mocks/obsidian'));

import { detectEmbeddedContent, getExtractableContent } from '../src/utils/embeddedContentDetector';
import { App, TFile } from './mocks/obsidian';

function createResolver(app: App, files: Record<string, TFile>) {
    app.metadataCache.getFirstLinkpathDest = (link: string) => files[link] ?? null;
}

describe('embeddedContentDetector (production)', () => {
    let app: App;

    beforeEach(() => {
        app = new App();
    });

    it('detects embedded audio with resolved file', () => {
        const file = new TFile('audio/meeting.mp3');
        createResolver(app, { 'audio/meeting.mp3': file });

        const result = detectEmbeddedContent(app, '![[audio/meeting.mp3]]');

        expect(result.items).toHaveLength(1);
        expect(result.items[0].type).toBe('audio');
        expect(result.items[0].resolvedFile).toBe(file);
        expect(result.items[0].isEmbedded).toBe(true);
    });

    it('detects external YouTube links', () => {
        const content = '![Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)';
        const result = detectEmbeddedContent(app, content);

        expect(result.items).toHaveLength(1);
        expect(result.items[0].type).toBe('youtube');
        expect(result.items[0].isExternal).toBe(true);
    });

    it('detects bare URLs and strips trailing punctuation', () => {
        const content = 'See https://example.com/test.';
        const result = detectEmbeddedContent(app, content);

        expect(result.items).toHaveLength(1);
        expect(result.items[0].type).toBe('web-link');
        expect(result.items[0].url).toBe('https://example.com/test');
    });

    it('detects external document URLs by extension', () => {
        const content = 'Doc: https://example.com/report.docx';
        const result = detectEmbeddedContent(app, content);

        expect(result.items).toHaveLength(1);
        expect(result.items[0].type).toBe('document');
        expect(result.items[0].isExternal).toBe(true);
    });

    it('deduplicates repeated bare URLs', () => {
        const content = 'https://example.com https://example.com';
        const result = detectEmbeddedContent(app, content);

        expect(result.items).toHaveLength(1);
        expect(result.items[0].url).toBe('https://example.com');
    });

    it('getExtractableContent excludes internal links', () => {
        const file = new TFile('notes/note.md');
        createResolver(app, { 'notes/note.md': file });

        const content = '[[notes/note.md]]';
        const result = detectEmbeddedContent(app, content);
        const extractable = getExtractableContent(result);

        expect(result.items).toHaveLength(1);
        expect(result.items[0].type).toBe('internal-link');
        expect(extractable).toHaveLength(0);
    });
});
