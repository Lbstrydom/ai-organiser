import { describe, it, expect } from 'vitest';
import { buildIrSystemPrompt, buildIrRepairPrompt, buildIrRefinePrompt, parseIrFromResponse } from '../src/services/presentationIr/irPrompts';
import { IR_SCHEMA_VERSION, type SlideDeckIr } from '../src/services/presentationIr/slideIr';

const validDeck = JSON.stringify({
    schemaVersion: IR_SCHEMA_VERSION,
    title: 'T',
    slides: [
        { id: 's1', type: 'title', title: 'Hello', subtitle: 'World', blocks: [] },
        { id: 's2', type: 'content', title: 'Body', blocks: [{ kind: 'paragraph', text: 'hi' }] },
    ],
});

describe('buildIrSystemPrompt', () => {
    it('documents the schema version + the core block vocabulary', () => {
        const p = buildIrSystemPrompt();
        expect(p).toContain(`"schemaVersion": ${IR_SCHEMA_VERSION}`);
        for (const kind of ['stat-grid', 'bar-chart', 'process-flow', 'two-column', 'table', 'bullets']) {
            expect(p).toContain(kind);
        }
        expect(p.toLowerCase()).toContain('json');
    });
    it('threads the output language when given', () => {
        expect(buildIrSystemPrompt({ outputLanguage: 'French' })).toContain('French');
    });

    it('#3/#4: guides chart axisLabel/source + restrained emphasis', () => {
        const p = buildIrSystemPrompt();
        expect(p).toContain('axisLabel');
        expect(p).toContain('source');
        expect(p.toLowerCase()).toContain('emphasis');
        // emphasis guidance warns against bolding a whole passage
        expect(p.toLowerCase()).toMatch(/whole|multi-line|single short/);
    });

    it('enforces an exact slide count when targetLength is given', () => {
        const p = buildIrSystemPrompt({ targetLength: 11 });
        expect(p).toContain('EXACTLY 11 slides');
    });
});

describe('buildIrRefinePrompt', () => {
    it('embeds the current deck + the edit request and asks for full updated IR', () => {
        const deck = JSON.parse(validDeck) as SlideDeckIr;
        const p = buildIrRefinePrompt(deck, 'make slide 2 more concise');
        expect(p).toContain('make slide 2 more concise');
        expect(p).toContain('"id":"s2"');
        expect(p).toContain('COMPLETE updated deck');
    });
});

describe('parseIrFromResponse', () => {
    it('parses a bare JSON object', () => {
        const r = parseIrFromResponse(validDeck);
        expect(r.ok).toBe(true);
    });
    it('parses JSON inside a ```json code fence', () => {
        const r = parseIrFromResponse('Here you go:\n```json\n' + validDeck + '\n```');
        expect(r.ok).toBe(true);
    });
    it('parses JSON with surrounding prose', () => {
        const r = parseIrFromResponse('Sure! ' + validDeck + ' Done.');
        expect(r.ok).toBe(true);
    });
    it('errors on non-JSON', () => {
        expect(parseIrFromResponse('not json at all').ok).toBe(false);
    });
    it('errors on empty', () => {
        expect(parseIrFromResponse('   ').ok).toBe(false);
    });
    it('errors on structurally-invalid IR (caught by Zod)', () => {
        const bad = JSON.stringify({ schemaVersion: IR_SCHEMA_VERSION, slides: [{ id: 'x', type: 'content', blocks: [{ kind: 'nope' }] }] });
        expect(parseIrFromResponse(bad).ok).toBe(false);
    });
});

describe('buildIrRepairPrompt', () => {
    it('includes the validation error and truncates long output', () => {
        const p = buildIrRepairPrompt('x'.repeat(10_000), 'invalid deck IR at slides.0.blocks');
        expect(p).toContain('invalid deck IR at slides.0.blocks');
        expect(p).toContain('[truncated]');
    });
});
