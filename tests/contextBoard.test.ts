import type { TFile } from 'obsidian';
import { mapContentTypeToNode } from '../src/services/canvas/contextBoard';
import type { DetectedContent } from '../src/utils/embeddedContentDetector';

describe('Context Board', () => {
    it('mapContentTypeToNode should map youtube to link', () => {
        const item: DetectedContent = {
            type: 'youtube',
            originalText: '',
            url: 'https://youtube.com/watch?v=1',
            displayName: 'Video',
            isEmbedded: false,
            isExternal: true,
            lineNumber: 1
        };

        const node = mapContentTypeToNode(item);
        expect(node.type).toBe('link');
        expect(node.url).toBe('https://youtube.com/watch?v=1');
    });

    it('mapContentTypeToNode should map resolved pdf to file', () => {
        const file = { path: 'Docs/test.pdf' } as TFile;
        const item: DetectedContent = {
            type: 'pdf',
            originalText: '',
            url: 'Docs/test.pdf',
            displayName: 'test.pdf',
            isEmbedded: false,
            isExternal: false,
            resolvedFile: file,
            lineNumber: 1
        };

        const node = mapContentTypeToNode(item);
        expect(node.type).toBe('file');
        expect(node.file).toBe('Docs/test.pdf');
    });

    it('mapContentTypeToNode should map missing internal link to text', () => {
        const item: DetectedContent = {
            type: 'internal-link',
            originalText: '',
            url: 'Missing.md',
            displayName: 'Missing',
            isEmbedded: false,
            isExternal: false,
            lineNumber: 1
        };

        const node = mapContentTypeToNode(item);
        expect(node.type).toBe('text');
        expect(node.text).toContain('Missing');
    });
});
