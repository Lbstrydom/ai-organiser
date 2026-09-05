import { describe, it, expect } from 'vitest';
import {
    stripMemoryLabelSources,
    dedupeBriefStories,
    postProcessBrief,
} from '../src/services/newsletter/briefPostProcess';

/**
 * Both inputs below are REAL generated output. Each defect was forbidden in the
 * prompt first and appeared anyway, which is why these guards exist in code.
 */

describe('stripMemoryLabelSources', () => {
    it('replaces a leaked memory label with an honest attribution', () => {
        const md = '- **Ukraine intelligence clash**: Zelensky rebuked the agency. (Sources: THEY_MISSED_THESE_ENTIRELY)';
        expect(stripMemoryLabelSources(md)).toContain('(Previously reported)');
        expect(stripMemoryLabelSources(md)).not.toContain('THEY_MISSED');
    });

    it('handles the older lowercase label wording too', () => {
        expect(stripMemoryLabelSources('- **A**: x. (Sources: continuing)')).toContain('(Previously reported)');
        expect(stripMemoryLabelSources('- **A**: x. (Sources: not yet heard)')).toContain('(Previously reported)');
    });

    it('leaves a genuine source list alone', () => {
        const md = '- **A**: x. (Sources: The Economist, Axios AI+)';
        expect(stripMemoryLabelSources(md)).toBe(md);
    });

    it('does not touch a real source whose name merely contains a label word', () => {
        const md = '- **A**: x. (Sources: The Continuing Education Weekly)';
        expect(stripMemoryLabelSources(md)).toBe(md);
    });
});

describe('dedupeBriefStories', () => {
    const dup = [
        '### Geopolitics',
        '',
        '- **Netherlands repatriates gold from the US**: Moved 86 tons out of America. (Sources: Fortune Editors)',
        '- **Ted Cruz eyes 2028**: Testing the waters. (Sources: WSJ)',
        '',
        '### Closer to home',
        '',
        '- **Netherlands repatriates gold from the US**: Moved 86 tons out, citing unrest. (Sources: Fortune Editors)',
        '- **Tram 19 extension nears completion**: Finally nearly finished. (Sources: Weekmail)',
    ].join('\n');

    it('keeps the home-region copy and drops the topical one', () => {
        // Keep-the-first would discard the local placement, since "Closer to
        // home" is rendered last — which would undo the point of the section.
        const out = dedupeBriefStories(dup);
        expect(out.match(/repatriates gold/g)).toHaveLength(1);
        const idx = out.indexOf('repatriates gold');
        expect(out.slice(0, idx)).toContain('### Closer to home');
    });

    it('leaves unrelated stories untouched', () => {
        const out = dedupeBriefStories(dup);
        expect(out).toContain('Ted Cruz eyes 2028');
        expect(out).toContain('Tram 19 extension');
    });

    it('folds near-identical titles, not just exact ones', () => {
        const md = [
            '### Geopolitics',
            '- **Netherlands repatriates 86 tonnes of gold from the US**: a. (Sources: X)',
            '### Closer to home',
            '- **Netherlands repatriates gold from the US**: b. (Sources: X)',
        ].join('\n');
        expect(dedupeBriefStories(md).match(/repatriates/g)).toHaveLength(1);
    });

    it('removes a heading left empty by de-duplication', () => {
        const md = [
            '### Geopolitics',
            '- **Only story**: a. (Sources: X)',
            '### Closer to home',
            '- **Only story**: b. (Sources: X)',
        ].join('\n');
        const out = dedupeBriefStories(md);
        expect(out).not.toContain('### Geopolitics');
        expect(out).toContain('### Closer to home');
    });

    it('drops the wrapped continuation lines of a removed bullet', () => {
        const md = [
            '### Geopolitics',
            '- **Dup story**: first line',
            '  wrapped continuation that must go too',
            '',
            '### Closer to home',
            '- **Dup story**: kept version',
        ].join('\n');
        const out = dedupeBriefStories(md);
        expect(out).not.toContain('wrapped continuation');
        expect(out).toContain('kept version');
    });

    it('is a no-op when there are no duplicates', () => {
        const md = '### A\n- **One**: x.\n- **Two**: y.';
        expect(dedupeBriefStories(md)).toBe(md);
    });

    it('handles an empty brief', () => {
        expect(dedupeBriefStories('')).toBe('');
    });
});

describe('postProcessBrief', () => {
    it('applies both guards together', () => {
        const md = [
            '### Geopolitics',
            '- **Gold move**: a. (Sources: THEY_MISSED_THESE_ENTIRELY)',
            '### Closer to home',
            '- **Gold move**: b. (Sources: Fortune Editors)',
        ].join('\n');
        const out = postProcessBrief(md);
        expect(out).not.toContain('THEY_MISSED');
        expect(out.match(/Gold move/g)).toHaveLength(1);
    });
});
