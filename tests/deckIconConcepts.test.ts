import { describe, it, expect } from 'vitest';
import { collectDeckIconConcepts } from '../src/services/presentationIr/deckIconConcepts';
import { IR_SCHEMA_VERSION, type SlideDeckIr } from '../src/services/presentationIr/slideIr';

describe('collectDeckIconConcepts', () => {
    it('collects resolved stat-grid + process-flow icon names, deduped', () => {
        const deck: SlideDeckIr = {
            schemaVersion: IR_SCHEMA_VERSION,
            slides: [{
                id: 'a', type: 'content', title: 't',
                blocks: [
                    { kind: 'stat-grid', cards: [
                        { value: '1', label: 'x', icon: 'trending-up' },
                        { value: '2', label: 'y', icon: 'Leaf' },       // casing normalised
                    ] },
                    { kind: 'process-flow', steps: [
                        { title: 's1', icon: '📈' },                    // emoji → trending-up
                        { title: 's2' },                                // no icon
                    ] },
                ],
            }],
        };
        const concepts = collectDeckIconConcepts(deck).sort();
        expect(concepts).toEqual(['leaf', 'trending-up']);   // emoji collapsed onto trending-up
    });

    it('walks two-column children', () => {
        const deck: SlideDeckIr = {
            schemaVersion: IR_SCHEMA_VERSION,
            slides: [{
                id: 'a', type: 'content', title: 't',
                blocks: [{
                    kind: 'two-column',
                    left: [{ kind: 'stat-grid', cards: [{ value: '1', label: 'x', icon: 'shield' }] }],
                    right: [{ kind: 'process-flow', steps: [{ title: 's', icon: 'cpu' }, { title: 's2' }] }],
                }],
            }],
        };
        expect(collectDeckIconConcepts(deck).sort()).toEqual(['cpu', 'shield']);
    });

    it('returns [] for an empty / null deck', () => {
        expect(collectDeckIconConcepts(null)).toEqual([]);
        expect(collectDeckIconConcepts({ schemaVersion: IR_SCHEMA_VERSION, slides: [] } as SlideDeckIr)).toEqual([]);
    });
});
