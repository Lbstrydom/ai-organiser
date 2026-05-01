/**
 * @vitest-environment happy-dom
 *
 * SlidePickerModal pure-function tests.
 * Plan: docs/completed/slide-authoring-followup-implementation.md (Phase H).
 */

import { describe, it, expect } from 'vitest';
import { parseSlideEntries } from '../src/ui/modals/SlidePickerModal';

describe('parseSlideEntries', () => {
    it('returns empty for empty html', () => {
        expect(parseSlideEntries('')).toEqual([]);
    });

    it('returns one entry per section.slide', () => {
        const html = `
            <div class="deck">
                <section class="slide"><h1>Title</h1></section>
                <section class="slide"><h2>Body</h2></section>
                <section class="slide"><h3>Closing</h3></section>
            </div>
        `;
        const entries = parseSlideEntries(html);
        expect(entries).toHaveLength(3);
        expect(entries[0]).toEqual({ slideIndex: 0, headingText: 'Title' });
        expect(entries[1]).toEqual({ slideIndex: 1, headingText: 'Body' });
        expect(entries[2]).toEqual({ slideIndex: 2, headingText: 'Closing' });
    });

    it('uses placeholder when slide has no heading', () => {
        const html = `<div class="deck">
            <section class="slide"><p>just text</p></section>
        </div>`;
        const entries = parseSlideEntries(html);
        expect(entries).toHaveLength(1);
        expect(entries[0].headingText).toBe('(no heading)');
    });

    it('trims whitespace in heading text', () => {
        const html = `<div class="deck">
            <section class="slide"><h1>   Trim me   </h1></section>
        </div>`;
        const entries = parseSlideEntries(html);
        expect(entries[0].headingText).toBe('Trim me');
    });

    it('picks the first heading when multiple are present', () => {
        const html = `<div class="deck">
            <section class="slide"><h1>First</h1><h2>Second</h2></section>
        </div>`;
        const entries = parseSlideEntries(html);
        expect(entries[0].headingText).toBe('First');
    });
});
