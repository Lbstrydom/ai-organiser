import { describe, it, expect } from 'vitest';
import { validateDeckIr, IR_SCHEMA_VERSION } from '../src/services/presentationIr/slideIr';
import { coffeeDeckIr } from './fixtures/coffeeDeckIr';

// Negative tests pass intentionally-malformed payloads, so the input is typed
// `unknown[]` rather than the strict slide union (Gemini H2 — don't fight the
// domain model for validator negative cases).
function baseDeck(slides: unknown[]): unknown {
    return { schemaVersion: IR_SCHEMA_VERSION, slides };
}

describe('validateDeckIr — acceptance', () => {
    it('accepts the golden coffee fixture', () => {
        const r = validateDeckIr(coffeeDeckIr);
        expect(r.ok).toBe(true);
    });

    it('accepts a minimal one-slide deck', () => {
        const r = validateDeckIr(baseDeck([{ id: 'a', type: 'content', blocks: [{ kind: 'paragraph', text: 'hi' }] }]));
        expect(r.ok).toBe(true);
    });
});

describe('validateDeckIr — rejection', () => {
    it('rejects an unknown block kind', () => {
        const r = validateDeckIr(baseDeck([{ id: 'a', type: 'content', blocks: [{ kind: 'pie-chart', data: [] }] }]));
        expect(r.ok).toBe(false);
    });

    it('rejects a wrong schemaVersion', () => {
        const r = validateDeckIr({ schemaVersion: 999, slides: [{ id: 'a', type: 'content', blocks: [] }] });
        expect(r.ok).toBe(false);
    });

    it('rejects an empty slides array (min 1)', () => {
        const r = validateDeckIr(baseDeck([]));
        expect(r.ok).toBe(false);
    });

    it('rejects bar-chart pct out of range', () => {
        const r = validateDeckIr(baseDeck([{ id: 'a', type: 'content', blocks: [
            { kind: 'bar-chart', bars: [{ label: 'x', pct: 150 }] },
        ] }]));
        expect(r.ok).toBe(false);
    });

    it('rejects a table whose row width != header count', () => {
        const r = validateDeckIr(baseDeck([{ id: 'a', type: 'content', blocks: [
            { kind: 'table', headers: ['A', 'B'], rows: [['only-one']] },
        ] }]));
        expect(r.ok).toBe(false);
    });

    it('rejects a custom block with neither html nor image', () => {
        const r = validateDeckIr(baseDeck([{ id: 'a', type: 'content', blocks: [
            { kind: 'custom', fallbackText: 'nope' },
        ] }]));
        expect(r.ok).toBe(false);
    });

    it('rejects an svg+xml data-URI in an image block (H1 security)', () => {
        const r = validateDeckIr(baseDeck([{ id: 'a', type: 'content', blocks: [
            { kind: 'image', dataUri: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' },
        ] }]));
        expect(r.ok).toBe(false);
    });

    it('accepts a raster data-URI in an image block', () => {
        const r = validateDeckIr(baseDeck([{ id: 'a', type: 'content', blocks: [
            { kind: 'image', dataUri: 'data:image/png;base64,iVBORw0KGgo=' },
        ] }]));
        expect(r.ok).toBe(true);
    });

    it('rejects a data-URI with trailing non-base64 junk (Gemini G1 anchor)', () => {
        const r = validateDeckIr(baseDeck([{ id: 'a', type: 'content', blocks: [
            { kind: 'image', dataUri: 'data:image/png;base64,iVBOR<svg onload=alert(1)>' },
        ] }]));
        expect(r.ok).toBe(false);
    });

    it('rejects duplicate slide ids', () => {
        const r = validateDeckIr(baseDeck([
            { id: 'dup', type: 'content', blocks: [] },
            { id: 'dup', type: 'content', blocks: [] },
        ]));
        expect(r.ok).toBe(false);
    });

    it('rejects a nested two-column (single-depth invariant)', () => {
        const r = validateDeckIr(baseDeck([{ id: 'a', type: 'content', blocks: [
            { kind: 'two-column', left: [{ kind: 'two-column', left: [], right: [] }], right: [] },
        ] }]));
        expect(r.ok).toBe(false);
    });

    it('accepts a valid one-level two-column', () => {
        const r = validateDeckIr(baseDeck([{ id: 'a', type: 'content', blocks: [
            { kind: 'two-column', left: [{ kind: 'paragraph', text: 'L' }], right: [{ kind: 'paragraph', text: 'R' }] },
        ] }]));
        expect(r.ok).toBe(true);
    });

    it('rejects blocks on a title slide (H6 — would be silently dropped)', () => {
        const r = validateDeckIr(baseDeck([
            { id: 't', type: 'title', title: 'T', blocks: [{ kind: 'paragraph', text: 'x' }] },
            { id: 'c', type: 'content', blocks: [{ kind: 'paragraph', text: 'y' }] },
        ]));
        expect(r.ok).toBe(false);
    });

    it('rejects an unknown key on a block (M7 strict)', () => {
        const r = validateDeckIr(baseDeck([{ id: 'a', type: 'content', blocks: [
            { kind: 'paragraph', text: 'hi', colour: 'red' },
        ] }]));
        expect(r.ok).toBe(false);
    });

    it('rejects a non-hex bar colour (H3)', () => {
        const r = validateDeckIr(baseDeck([{ id: 'a', type: 'content', blocks: [
            { kind: 'bar-chart', bars: [{ label: 'x', pct: 10, color: 'red' }] },
        ] }]));
        expect(r.ok).toBe(false);
    });

    it('accepts a 6-hex bar colour with or without #', () => {
        const r = validateDeckIr(baseDeck([{ id: 'a', type: 'content', blocks: [
            { kind: 'bar-chart', bars: [{ label: 'x', pct: 10, color: '#ff8800' }, { label: 'y', pct: 20, color: 'aabbcc' }] },
        ] }]));
        expect(r.ok).toBe(true);
    });
});
