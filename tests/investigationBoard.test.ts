import { getFallbackEdgeLabel, parseEdgeLabelResponse } from '../src/services/canvas/investigationBoard';

describe('Investigation Board', () => {
    it('parseEdgeLabelResponse should parse JSON', () => {
        const result = parseEdgeLabelResponse('{"labels":[{"pairIndex":0,"label":"Core"}]}', 1);
        expect(result).toEqual(['Core']);
    });

    it('parseEdgeLabelResponse should parse code fence JSON', () => {
        const response = '```json\n{"labels":[{"pairIndex":0,"label":"Core"},{"pairIndex":1,"label":"Support"}]}\n```';
        const result = parseEdgeLabelResponse(response, 2);
        expect(result).toEqual(['Core', 'Support']);
    });

    it('parseEdgeLabelResponse should return undefineds on failure', () => {
        const result = parseEdgeLabelResponse('invalid', 3);
        expect(result).toEqual([undefined, undefined, undefined]);
    });

    it('parseEdgeLabelResponse should return undefineds for empty string', () => {
        const result = parseEdgeLabelResponse('', 2);
        expect(result).toEqual([undefined, undefined]);
    });

    it('parseEdgeLabelResponse should handle partial labels', () => {
        const response = '{"labels":[{"pairIndex":0,"label":"Core"}]}';
        const result = parseEdgeLabelResponse(response, 2);
        expect(result[0]).toBe('Core');
        expect(result[1]).toBeUndefined();
    });

    it('getFallbackEdgeLabel should map scores to labels', () => {
        expect(getFallbackEdgeLabel(0.8)).toBe('Closely related');
        expect(getFallbackEdgeLabel(0.6)).toBe('Related');
        expect(getFallbackEdgeLabel(0.2)).toBe('Loosely related');
    });

    it('getFallbackEdgeLabel boundary at 0.79', () => {
        expect(getFallbackEdgeLabel(0.79)).toBe('Related');
    });

    it('getFallbackEdgeLabel boundary at 0.59', () => {
        expect(getFallbackEdgeLabel(0.59)).toBe('Loosely related');
    });
});
