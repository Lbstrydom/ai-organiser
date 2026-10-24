/**
 * Excalidraw drawing notes — shared read-side helper. Synthetic fixtures (tests/helpers/excalidrawFixture.ts)
 * modelled on the layout the Excalidraw plugin (2.29) really writes.
 */

import { describe, it, expect } from 'vitest';
import { isExcalidrawNote, excalidrawIndexParts, toModelText } from '../src/utils/excalidrawContent';
import { drawingNote as drawing, BLOB_PROBE } from './helpers/excalidrawFixture';

describe('isExcalidrawNote', () => {
    it('recognises the plugin frontmatter key', () => {
        expect(isExcalidrawNote(drawing())).toBe(true);
        expect(isExcalidrawNote(drawing({ eol: '\r\n' }))).toBe(true);
        expect(isExcalidrawNote('﻿' + drawing())).toBe(true);
        expect(isExcalidrawNote(drawing({ quotedKey: true }))).toBe(true);
    });

    it('recognises a drawing whose frontmatter is much longer than the plugin writes', () => {
        const longProp = 'notes: ' + 'x'.repeat(20_000);
        const note = drawing({ extraFrontmatter: [longProp] });
        expect(isExcalidrawNote(note)).toBe(true);
        expect(toModelText(note)).toBe('Intake\nDecision');
    });

    it('does not recognise a prose note that mentions excalidraw or is tagged excalidraw', () => {
        expect(isExcalidrawNote('---\ntags: [excalidraw]\n---\nI sketched this in Excalidraw yesterday.')).toBe(false);
        expect(isExcalidrawNote('Use the excalidraw-plugin: parsed setting.\nexcalidraw-plugin: parsed')).toBe(false);
    });

    it('ignores the key when it sits in the body, not the frontmatter', () => {
        expect(isExcalidrawNote('# Title\n\n---\nexcalidraw-plugin: parsed\n---\n')).toBe(false);
    });

    it('ignores an unterminated frontmatter block', () => {
        expect(isExcalidrawNote('---\nexcalidraw-plugin: parsed\nstill going\n')).toBe(false);
    });

    it('does not trust the file name alone', () => {
        expect(isExcalidrawNote('Just some prose.', 'Notes/Plan.excalidraw.md')).toBe(false);
    });

    it('falls back to name plus drawing structure when the frontmatter is missing', () => {
        const noFm = drawing().replace(/^---[\s\S]*?---\n/, '');
        expect(isExcalidrawNote(noFm)).toBe(false);
        expect(isExcalidrawNote(noFm, 'Drawings/Map.excalidraw.md')).toBe(true);
    });
});

describe('toModelText', () => {
    it('keeps the text elements, strips block ids, drops the banner and the blob', () => {
        const out = toModelText(drawing({ blobChars: 4000 }));
        expect(out).toBe('Intake\nDecision');
        expect(out).not.toContain(BLOB_PROBE);
        expect(out).not.toContain('EXCALIDRAW VIEW');
    });

    it('handles CRLF files', () => {
        expect(toModelText(drawing({ eol: '\r\n' }))).toBe('Intake\nDecision');
    });

    it('drops an uncompressed JSON drawing and keeps only the text elements', () => {
        const out = toModelText(drawing({ json: true }));
        expect(out).toBe('Intake\nDecision');
        expect(out).not.toContain('SECRET-JSON-TEXT');
    });

    it('returns empty text, not the blob, when the text section is missing', () => {
        expect(toModelText(drawing({ omitTextSection: true }))).toBe('');
    });

    it('returns empty text for a drawing with an empty Text Elements section', () => {
        expect(toModelText(drawing({ elements: [] }))).toBe('');
    });

    it('keeps multi-line labels, links and math, and strips only the trailing block id', () => {
        const out = toModelText(drawing({
            elements: ['Line one\nLine two ^AAAAAAAA', 'See [[Other note]] ^BBBBBBBB', '$$x^2 + y^2$$ ^CCCCCCCC'],
        }));
        expect(out).toBe('Line one\nLine two\nSee [[Other note]]\n$$x^2 + y^2$$');
    });

    it('strips only the plugin\'s 8-character block id', () => {
        const out = toModelText(drawing({ elements: ['Cost ^abcdefghij', 'Next ^AAAAAAAA'] }));
        expect(out).toBe('Cost ^abcdefghij\nNext');
    });

    it('keeps heading-looking labels instead of ending the section early', () => {
        const out = toModelText(drawing({ elements: ['# Deployment steps ^AAAAAAAA', 'Roll back ^BBBBBBBB'] }));
        expect(out).toBe('# Deployment steps\nRoll back');
    });

    it('stops at the plugin delimiters (fail-safe) when a label is literally a delimiter line', () => {
        const out = toModelText(drawing({ elements: ['Before ^AAAAAAAA', '%%', 'After ^BBBBBBBB'] }));
        expect(out).toBe('Before');
        expect(out).not.toContain(BLOB_PROBE);
    });

    it('supports the older "# Text Elements" / "# Drawing" layout', () => {
        const old = ['---', 'excalidraw-plugin: parsed', '---', '# Text Elements', 'Old label ^abcdefgh', '', '%%', '# Drawing', '```json', '{"elements":[]}', '```', '%%'].join('\n');
        expect(toModelText(old)).toBe('Old label');
    });

    it('stops at the Embedded Files section', () => {
        expect(toModelText(drawing({ embeds: ['f1: [[pic.png]]'] }))).toBe('Intake\nDecision');
    });

    it('keeps the user prose the plugin preserves above its data, and ignores the banner', () => {
        const out = toModelText(drawing({ preface: 'Why this map exists: onboarding.' }));
        expect(out).toBe('Why this map exists: onboarding.\n\nIntake\nDecision');
    });

    it('does not mistake a user heading in that prose for the generated Text Elements section', () => {
        const out = toModelText(drawing({ preface: '## Text Elements\nmy own notes ^ZZZZZZZZ' }));
        expect(out).toBe('## Text Elements\nmy own notes ^ZZZZZZZZ\n\nIntake\nDecision');
    });

    it('returns the SAME string for a normal note (byte-identical)', () => {
        const notes = [
            'Plain note about Excalidraw.',
            '---\ntags: [excalidraw]\n---\nbody',
            '',
            '# Excalidraw Data\n\n## Text Elements\nnot a drawing ^abcdefgh\n%%\n## Drawing\n```compressed-json\nxyz\n```\n%%',
        ];
        for (const n of notes) expect(toModelText(n)).toBe(n);
    });

    it('is idempotent', () => {
        const once = toModelText(drawing());
        expect(toModelText(once)).toBe(once);
    });

    it('is fast and blob-free on a huge drawing', () => {
        const big = drawing({ blobChars: 5_000_000 });
        const t0 = performance.now();
        const out = toModelText(big);
        expect(performance.now() - t0).toBeLessThan(1000);
        expect(out).toBe('Intake\nDecision');
    });
});

describe('excalidrawIndexParts', () => {
    it('is null for a normal note', () => {
        expect(excalidrawIndexParts('hello')).toBeNull();
    });

    it('exposes the embedded files list without the blob', () => {
        const parts = excalidrawIndexParts(drawing({ embeds: ['f1: [[pic.png]]', 'f2: [[Report.pdf]]'], blobChars: 3000 }));
        expect(parts).not.toBeNull();
        expect(parts!.embeds).toBe('f1: [[pic.png]]\nf2: [[Report.pdf]]');
        expect(parts!.text).toBe('Intake\nDecision');
    });

    it('reports empty embeds when the section is absent', () => {
        expect(excalidrawIndexParts(drawing())!.embeds).toBe('');
    });
});
