import { cosineSimilarity } from '../src/services/vector/vectorMath';

describe('cosineSimilarity', () => {
    it('returns 1.0 for identical vectors', () => {
        const a = [1, 2, 3];
        expect(cosineSimilarity(a, a)).toBeCloseTo(1, 6);
    });

    it('returns 0 for orthogonal vectors', () => {
        const a = [1, 0];
        const b = [0, 1];
        expect(cosineSimilarity(a, b)).toBeCloseTo(0, 6);
    });

    it('returns 0 for dimension mismatch', () => {
        expect(cosineSimilarity([1, 2], [1])).toBe(0);
    });

    it('returns 0 for zero-magnitude vectors', () => {
        expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
        expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
    });

    it('returns expected value for known vectors', () => {
        const a = [1, 0];
        const b = [1, 1];
        expect(cosineSimilarity(a, b)).toBeCloseTo(Math.SQRT1_2, 6);
    });
});
