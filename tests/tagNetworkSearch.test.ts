/**
 * Tag Network Search Tests
 * Tests pure tag search utilities used by TagNetworkView
 */

import { filterSuggestions, computeFilterSets } from '../src/ui/views/TagNetworkView';
import type { NetworkEdge, NetworkNode } from '../src/utils/tagNetworkUtils';

describe('filterSuggestions', () => {
    const nodes: NetworkNode[] = [
        { id: '#coaching', label: 'coaching', size: 10, frequency: 12 },
        { id: '#leadership', label: 'leadership', size: 10, frequency: 5 },
        { id: '#coaching/skills', label: 'coaching/skills', size: 10, frequency: 8 },
        { id: '#culture', label: 'culture', size: 10, frequency: 3 }
    ];

    it('filters by substring and sorts by frequency', () => {
        const result = filterSuggestions(nodes, 'co', new Set());
        expect(result.map(r => r.id)).toEqual(['#coaching', '#coaching/skills']);
    });

    it('excludes selected ids and respects maxResults', () => {
        const selected = new Set<string>(['#coaching']);
        const result = filterSuggestions(nodes, 'c', selected, 1);
        expect(result).toEqual([
            { id: '#coaching/skills', label: 'coaching/skills', frequency: 8 }
        ]);
    });

    it('returns empty list for empty search term', () => {
        const result = filterSuggestions(nodes, '   ', new Set());
        expect(result).toEqual([]);
    });
});

describe('computeFilterSets', () => {
    const edges: NetworkEdge[] = [
        { id: 'a-b', source: '#coaching', target: '#leadership', weight: 2 },
        { id: 'b-c', source: '#leadership', target: '#culture', weight: 1 },
        { id: 'a-d', source: '#coaching', target: '#coaching/skills', weight: 3 }
    ];

    it('computes neighbors for a single selection', () => {
        const selected = new Set<string>(['#coaching']);
        const { neighborSet } = computeFilterSets(selected, edges);
        expect(Array.from(neighborSet).sort()).toEqual(['#coaching/skills', '#leadership']);
    });

    it('unions neighbors and excludes selected ids', () => {
        const selected = new Set<string>(['#coaching', '#leadership']);
        const { neighborSet } = computeFilterSets(selected, edges);
        expect(Array.from(neighborSet).sort()).toEqual(['#coaching/skills', '#culture']);
    });

    it('returns empty neighbor set when no edges', () => {
        const selected = new Set<string>(['#coaching']);
        const { neighborSet } = computeFilterSets(selected, []);
        expect(neighborSet.size).toBe(0);
    });
});
