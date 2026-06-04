/**
 * Tests for NoteMutation — pure string composition for the note-edit write seam.
 */

import {
    NoteMutation,
    cleanupSourcesText,
    ensureStructureText,
    addReferenceText,
    replaceMainContentText,
    insertBeforeTrailingSectionsText,
    insertAtAnchorText,
    replaceAnchoredSelectionText,
} from '../src/services/noteEdit/noteMutation';
import type { SourceReference } from '../src/utils/noteStructure';

const webRef: SourceReference = {
    type: 'web',
    title: 'Example',
    link: 'https://example.com/article',
    date: '2026-06-04',
    isInternal: false,
};

describe('addReferenceText', () => {
    it('creates a References section when none exists and inserts the ref', () => {
        const out = addReferenceText('Body text.', webRef);
        expect(out).toContain('## References');
        expect(out).toContain('[Example](https://example.com/article)');
        expect(out.startsWith('Body text.')).toBe(true);
    });

    it('inserts into an existing References section without duplicating it', () => {
        const content = 'Body.\n\n---\n## References\n\n> **Note:** [[existing]]\n';
        const out = addReferenceText(content, webRef);
        expect((out.match(/## References/g) || []).length).toBe(1);
        expect(out).toContain('[Example](https://example.com/article)');
        expect(out).toContain('[[existing]]');
    });
});

describe('ensureStructureText', () => {
    it('is a no-op when disabled', () => {
        expect(ensureStructureText('Body', false)).toBe('Body');
    });

    it('adds both References and Pending Integration when enabled and missing', () => {
        const out = ensureStructureText('Body', true);
        expect(out).toContain('## References');
        expect(out).toContain('## Pending Integration');
    });

    it('is idempotent (does not add a second copy)', () => {
        const once = ensureStructureText('Body', true);
        const twice = ensureStructureText(once, true);
        expect(twice).toBe(once);
    });
});

describe('replaceMainContentText', () => {
    it('returns the new main content when there are no trailing sections', () => {
        expect(replaceMainContentText('Old body', 'New body')).toBe('New body');
    });

    it('preserves trailing References when replacing main content', () => {
        const content = 'Old body\n\n---\n## References\n\n> **Web:** [x](https://x)\n';
        const out = replaceMainContentText(content, 'New body');
        expect(out.startsWith('New body')).toBe(true);
        expect(out).toContain('## References');
        expect(out).toContain('[x](https://x)');
        expect(out).not.toContain('Old body');
    });
});

describe('insertBeforeTrailingSectionsText', () => {
    it('appends at end when no trailing sections', () => {
        expect(insertBeforeTrailingSectionsText('Body', '\n\nMore')).toBe('Body\n\nMore');
    });

    it('inserts before the References section', () => {
        const content = 'Body\n\n## References\n- s';
        const out = insertBeforeTrailingSectionsText(content, '\n\nAdded');
        expect(out.indexOf('Added')).toBeLessThan(out.indexOf('## References'));
    });
});

describe('insertAtAnchorText', () => {
    it('prepends when the anchor is empty (cursor at start)', () => {
        const r = insertAtAnchorText('Body', '', 'X');
        expect(r.ok && r.value.content).toBe('XBody');
    });

    it('inserts after the located anchor', () => {
        const r = insertAtAnchorText('alpha beta gamma', 'beta', '!');
        expect(r.ok && r.value.content).toBe('alpha beta! gamma');
    });

    it('degrades to append with an info code when the anchor is lost', () => {
        const r = insertAtAnchorText('Body without anchor', 'NONEXISTENT', '\n\nX');
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.info).toBe('degraded-append');
            expect(r.value.content).toContain('X');
        }
    });

    it('degrades to append when the anchor is AMBIGUOUS (multiple occurrences)', () => {
        const r = insertAtAnchorText('foo bar foo bar', 'foo ', '!');
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.info).toBe('degraded-append');
            // appended at end, NOT inserted at one of the ambiguous anchors
            expect(r.value.content.endsWith('!')).toBe(true);
        }
    });
});

describe('replaceAnchoredSelectionText', () => {
    it('replaces a uniquely located selection', () => {
        const r = replaceAnchoredSelectionText('one two three', { before: 'one ', selected: 'two', after: ' three' }, 'TWO');
        expect(r.ok && r.value.content).toBe('one TWO three');
    });

    it('aborts (range-invalid) when the span is not found', () => {
        const r = replaceAnchoredSelectionText('one two three', { before: 'XX', selected: 'YY', after: 'ZZ' }, 'Z');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe('range-invalid');
    });

    it('aborts (range-invalid) when the span is ambiguous', () => {
        const r = replaceAnchoredSelectionText('ab ab ab', { before: '', selected: 'ab', after: '' }, 'X');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe('range-invalid');
    });
});

describe('cleanupSourcesText', () => {
    it('is a no-op when there is nothing to remove', () => {
        expect(cleanupSourcesText('Body', [], [])).toBe('Body');
    });
});

describe('NoteMutation builder', () => {
    it('composes steps in order and carries the last advisory info', () => {
        const recompute = new NoteMutation()
            .insertAtAnchor('NONEXISTENT', '\n\nAppended')
            .ensureStructure(false)
            .build();
        const r = recompute('Body');
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.content).toContain('Appended');
            expect(r.value.info).toBe('degraded-append');
        }
    });

    it('aborts the whole composite when a step errors (all-or-nothing)', () => {
        const recompute = new NoteMutation()
            .replaceSelection({ before: 'X', selected: 'Y', after: 'Z' }, 'Q')
            .appendToEnd('SHOULD NOT APPEAR')
            .build();
        const r = recompute('content without that span');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe('range-invalid');
    });

    it('appendToEnd trims trailing whitespace and adds one newline before the text', () => {
        const recompute = new NoteMutation().appendToEnd('TAIL').build();
        const r = recompute('Body   \n\n');
        expect(r.ok && r.value.content).toBe('Body\nTAIL');
    });
});
