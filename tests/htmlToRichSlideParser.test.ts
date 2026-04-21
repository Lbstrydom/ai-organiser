/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect } from 'vitest';
import { htmlToRichSlides } from '../src/services/pptxExport/htmlToRichSlideParser';

function wrapDeck(...slides: string[]): string {
    return `<!doctype html><html><body><div class="deck">${slides.join('\n')}</div></body></html>`;
}

describe('htmlToRichSlides — slide typing + titles', () => {
    it('parses a title slide and a content slide', () => {
        const html = wrapDeck(
            `<section class="slide slide-title"><h1>The Deck</h1><h2>An intro subtitle</h2></section>`,
            `<section class="slide"><h2>Agenda</h2><ul><li>Alpha</li><li>Beta</li></ul></section>`,
        );
        const slides = htmlToRichSlides(html);
        expect(slides).toHaveLength(2);
        expect(slides[0].type).toBe('title');
        expect(slides[0].title).toBe('The Deck');
        expect(slides[0].subtitle).toBe('An intro subtitle');
        expect(slides[1].type).toBe('content');
        expect(slides[1].title).toBe('Agenda');
        expect(slides[1].elements).toEqual([
            { kind: 'list', items: ['Alpha', 'Beta'], ordered: false },
        ]);
    });

    it('detects section and closing slide types from CSS classes', () => {
        const html = wrapDeck(
            `<section class="slide slide-section"><h1>Part Two</h1></section>`,
            `<section class="slide slide-closing"><h1>Thank you</h1><h2>Questions?</h2></section>`,
        );
        const slides = htmlToRichSlides(html);
        expect(slides[0].type).toBe('section');
        expect(slides[1].type).toBe('closing');
        expect(slides[1].subtitle).toBe('Questions?');
    });
});

describe('htmlToRichSlides — content extraction', () => {
    it('extracts paragraphs, bullets, ordered lists', () => {
        const html = wrapDeck(
            `<section class="slide"><h2>Mixed</h2>
                <p>Intro para.</p>
                <ul><li>One</li><li>Two</li></ul>
                <ol><li>First</li><li>Second</li></ol>
            </section>`,
        );
        const [s] = htmlToRichSlides(html);
        const kinds = s.elements.map(e => e.kind);
        expect(kinds).toEqual(['text', 'list', 'list']);
        const lists = s.elements.filter(e => e.kind === 'list');
        expect(lists[0]).toMatchObject({ ordered: false, items: ['One', 'Two'] });
        expect(lists[1]).toMatchObject({ ordered: true, items: ['First', 'Second'] });
    });

    it('extracts tables with header + body rows', () => {
        const html = wrapDeck(
            `<section class="slide"><h2>Data</h2>
                <table>
                    <thead><tr><th>Q</th><th>Rev</th></tr></thead>
                    <tbody>
                        <tr><td>Q1</td><td>$1.2M</td></tr>
                        <tr><td>Q2</td><td>$1.4M</td></tr>
                    </tbody>
                </table>
            </section>`,
        );
        const [s] = htmlToRichSlides(html);
        const table = s.elements.find(e => e.kind === 'table');
        expect(table).toMatchObject({
            kind: 'table',
            headers: ['Q', 'Rev'],
            rows: [['Q1', '$1.2M'], ['Q2', '$1.4M']],
        });
    });

    it('extracts stat-cards via .stat-card class', () => {
        const html = wrapDeck(
            `<section class="slide"><h2>Stats</h2>
                <div class="stats-grid">
                    <div class="stat-card"><strong>42%</strong><small>growth</small></div>
                    <div class="stat-card"><strong>$3M</strong><small>arr</small></div>
                </div>
            </section>`,
        );
        const [s] = htmlToRichSlides(html);
        expect(s.layout).toBe('stats-grid');
        expect(s.elements).toHaveLength(2);
        expect(s.elements[0]).toMatchObject({ kind: 'stat-card', value: '42%', label: 'growth' });
        expect(s.elements[1]).toMatchObject({ kind: 'stat-card', value: '$3M', label: 'arr' });
    });

    it('detects two-column layout and puts left content in leftColumn', () => {
        const html = wrapDeck(
            `<section class="slide"><h2>Split</h2>
                <div class="col-container">
                    <div class="col"><p>Left</p></div>
                    <div class="col"><p>Right</p></div>
                </div>
            </section>`,
        );
        const [s] = htmlToRichSlides(html);
        expect(s.layout).toBe('two-column');
        expect(s.leftColumn?.[0]).toMatchObject({ kind: 'text', content: 'Left' });
        expect(s.elements[0]).toMatchObject({ kind: 'text', content: 'Right' });
    });

    it('captures speaker notes and excludes them from body extraction', () => {
        const html = wrapDeck(
            `<section class="slide"><h2>Title</h2>
                <p>Visible body.</p>
                <aside class="speaker-notes">Private notes here.</aside>
            </section>`,
        );
        const [s] = htmlToRichSlides(html);
        expect(s.speakerNotes).toBe('Private notes here.');
        // body should NOT contain the notes text
        const bodyText = s.elements.map(e => (e.kind === 'text' ? e.content : '')).join(' ');
        expect(bodyText).not.toContain('Private notes here');
    });

    it('keeps only data: URI images (matches sanitizer allowlist)', () => {
        const html = wrapDeck(
            `<section class="slide">
                <img src="data:image/png;base64,AAAA" alt="safe">
                <img src="https://evil.example.com/tracker.png" alt="blocked">
            </section>`,
        );
        const [s] = htmlToRichSlides(html);
        const images = s.elements.filter(e => e.kind === 'image');
        expect(images).toHaveLength(1);
        expect(images[0]).toMatchObject({ kind: 'image', alt: 'safe' });
    });
});

describe('htmlToRichSlides — edge cases', () => {
    it('returns empty array when deck has no .slide elements', () => {
        const html = '<!doctype html><html><body><div>nothing to see</div></body></html>';
        expect(htmlToRichSlides(html)).toEqual([]);
    });

    it('handles slide with no headings (content type, no title)', () => {
        const html = wrapDeck(`<section class="slide"><p>Body only.</p></section>`);
        const [s] = htmlToRichSlides(html);
        expect(s.type).toBe('content');
        expect(s.title).toBeUndefined();
        expect(s.elements[0]).toMatchObject({ kind: 'text', content: 'Body only.' });
    });

    it('indexes slides in document order', () => {
        const html = wrapDeck(
            `<section class="slide"><h2>A</h2></section>`,
            `<section class="slide"><h2>B</h2></section>`,
            `<section class="slide"><h2>C</h2></section>`,
        );
        const slides = htmlToRichSlides(html);
        expect(slides.map(s => s.index)).toEqual([0, 1, 2]);
    });
});
