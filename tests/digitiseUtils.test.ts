/**
 * digitiseUtils Tests
 */
import { describe, it, expect, vi } from 'vitest';
import { TFile } from 'obsidian';
import { createTFile } from './mocks/obsidian';
import {
    buildDigitiseMarkdown,
    resolveImageFile,
    extractImageText
} from '../src/utils/digitiseUtils';
import type { DigitiseResult } from '../src/services/visionService';

// --- Helpers ---

function makeMockTFile(path: string) {
    return createTFile(path);
}

function makeMockApp(linkResult: TFile | null, directResult: TFile | null) {
    return {
        metadataCache: {
            getFirstLinkpathDest: vi.fn().mockReturnValue(linkResult)
        },
        vault: {
            getAbstractFileByPath: vi.fn().mockReturnValue(directResult)
        }
    } as any;
}

function makeMockVisionService(result: any) {
    return {
        digitise: vi.fn().mockResolvedValue(result)
    } as any;
}

// --- buildDigitiseMarkdown ---

describe('buildDigitiseMarkdown', () => {
    it('returns extractedText only when no diagram/uncertainties', () => {
        const result: DigitiseResult = {
            extractedText: 'Hello world',
            rawResponse: ''
        };
        expect(buildDigitiseMarkdown(result)).toBe('Hello world');
    });

    it('returns extractedText + diagram section when diagram present', () => {
        const result: DigitiseResult = {
            extractedText: 'Some text',
            diagram: 'graph TD\nA-->B',
            rawResponse: ''
        };
        const md = buildDigitiseMarkdown(result);
        expect(md).toContain('Some text');
        expect(md).toContain('## Diagram');
        expect(md).toContain('```mermaid');
        expect(md).toContain('graph TD\nA-->B');
        expect(md).toContain('```');
        expect(md).not.toContain('## Uncertainties');
    });

    it('returns extractedText + uncertainties section when uncertainties present', () => {
        const result: DigitiseResult = {
            extractedText: 'Some text',
            uncertainties: ['Illegible word at line 3', 'Smudged area'],
            rawResponse: ''
        };
        const md = buildDigitiseMarkdown(result);
        expect(md).toContain('Some text');
        expect(md).toContain('## Uncertainties');
        expect(md).toContain('- Illegible word at line 3');
        expect(md).toContain('- Smudged area');
        expect(md).not.toContain('## Diagram');
    });

    it('returns all sections when all fields present', () => {
        const result: DigitiseResult = {
            extractedText: 'Full content',
            diagram: 'flowchart LR\nX-->Y',
            uncertainties: ['Unclear symbol'],
            rawResponse: ''
        };
        const md = buildDigitiseMarkdown(result);
        expect(md).toContain('Full content');
        expect(md).toContain('## Diagram');
        expect(md).toContain('```mermaid');
        expect(md).toContain('flowchart LR\nX-->Y');
        expect(md).toContain('## Uncertainties');
        expect(md).toContain('- Unclear symbol');
    });

    it('returns empty string when all fields are empty/undefined', () => {
        const result: DigitiseResult = {
            extractedText: '',
            rawResponse: ''
        };
        expect(buildDigitiseMarkdown(result)).toBe('');
    });

    it('handles empty uncertainties array (no section rendered)', () => {
        const result: DigitiseResult = {
            extractedText: 'Text only',
            uncertainties: [],
            rawResponse: ''
        };
        const md = buildDigitiseMarkdown(result);
        expect(md).toBe('Text only');
        expect(md).not.toContain('## Uncertainties');
    });
});

// --- resolveImageFile ---

describe('resolveImageFile', () => {
    it('returns TFile when getFirstLinkpathDest finds it', () => {
        const file = makeMockTFile('images/photo.png');
        const app = makeMockApp(file, null);

        const result = resolveImageFile(app, 'photo.png');
        expect(result).toBe(file);
        expect(app.vault.getAbstractFileByPath).not.toHaveBeenCalled();
    });

    it('falls back to getAbstractFileByPath when getFirstLinkpathDest returns null', () => {
        const file = makeMockTFile('images/photo.png');
        const app = makeMockApp(null, file);

        const result = resolveImageFile(app, 'images/photo.png');
        expect(result).toBe(file);
        expect(app.metadataCache.getFirstLinkpathDest).toHaveBeenCalled();
        expect(app.vault.getAbstractFileByPath).toHaveBeenCalledWith('images/photo.png');
    });

    it('returns null when both methods return null', () => {
        const app = makeMockApp(null, null);

        const result = resolveImageFile(app, 'missing.png');
        expect(result).toBeNull();
    });

    it('passes contextPath to getFirstLinkpathDest', () => {
        const file = makeMockTFile('images/photo.png');
        const app = makeMockApp(file, null);

        resolveImageFile(app, 'photo.png', 'notes/my-note.md');
        expect(app.metadataCache.getFirstLinkpathDest).toHaveBeenCalledWith(
            'photo.png',
            'notes/my-note.md'
        );
    });
});

// --- extractImageText ---

describe('extractImageText', () => {
    it('returns text and file on success', async () => {
        const file = makeMockTFile('images/scan.png');
        const app = makeMockApp(file, null);
        const visionService = makeMockVisionService({
            extractedText: 'Digitised content',
            rawResponse: 'raw'
        });

        const result = await extractImageText(visionService, app, 'scan.png');
        expect(result).toHaveProperty('text', 'Digitised content');
        expect(result).toHaveProperty('file', file);
        expect(visionService.digitise).toHaveBeenCalledWith(file);
    });

    it('returns error when file not found', async () => {
        const app = makeMockApp(null, null);
        const visionService = makeMockVisionService({});

        const result = await extractImageText(visionService, app, 'missing.png');
        expect(result).toEqual({ error: 'Image file not found in vault' });
        expect(visionService.digitise).not.toHaveBeenCalled();
    });

    it('includes diagram in returned text when present', async () => {
        const file = makeMockTFile('images/whiteboard.jpg');
        const app = makeMockApp(file, null);
        const visionService = makeMockVisionService({
            extractedText: 'Notes from whiteboard',
            diagram: 'graph TD\nA-->B-->C',
            rawResponse: 'raw'
        });

        const result = await extractImageText(visionService, app, 'whiteboard.jpg');
        expect(result).toHaveProperty('text');
        const text = (result as { text: string }).text;
        expect(text).toContain('Notes from whiteboard');
        expect(text).toContain('## Diagram');
        expect(text).toContain('graph TD\nA-->B-->C');
    });
});
