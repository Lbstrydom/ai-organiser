import { describe, it, expect, vi, beforeEach } from 'vitest';

// Controllable requestUrl mock. Each test sets `mockResponse` (or a queue).
const requestUrlMock = vi.fn();

vi.mock('obsidian', async () => {
	const actual = await vi.importActual<Record<string, unknown>>('../tests/mocks/obsidian');
	return {
		...actual,
		requestUrl: (params: unknown) => requestUrlMock(params),
	};
});

import { OpenAIEmbeddingService } from '../src/services/embeddings/openaiEmbeddingService';

const SMALL_DIMS = 1536;

function vec(seed: number, dims = SMALL_DIMS): number[] {
	return new Array(dims).fill(seed);
}

function okBatch(embeddings: number[][]) {
	return {
		status: 200,
		json: {
			data: embeddings.map((embedding, index) => ({ index, embedding })),
			usage: { total_tokens: 10 },
		},
	};
}

describe('OpenAIEmbeddingService.batchGenerateEmbeddings index alignment', () => {
	beforeEach(() => requestUrlMock.mockReset());

	it('returns an output of the SAME length as the input with empties as zero-vectors', async () => {
		const svc = new OpenAIEmbeddingService({ apiKey: 'k', model: 'text-embedding-3-small' });
		// Inputs: [real, empty, real, "   " (whitespace), real]
		const inputs = ['alpha', '', 'beta', '   ', 'gamma'];
		// Provider only sees the 3 non-empty inputs.
		requestUrlMock.mockResolvedValueOnce(okBatch([vec(1), vec(2), vec(3)]));

		const result = await svc.batchGenerateEmbeddings(inputs);
		expect(result.success).toBe(true);
		expect(result.embeddings).toBeDefined();
		expect(result.embeddings!.length).toBe(inputs.length);

		// Non-empty slots carry the real embeddings, in order.
		expect(result.embeddings![0][0]).toBe(1); // alpha
		expect(result.embeddings![2][0]).toBe(2); // beta
		expect(result.embeddings![4][0]).toBe(3); // gamma

		// Empty/whitespace slots are zero-vectors of the right dimension.
		expect(result.embeddings![1]).toEqual(new Array(SMALL_DIMS).fill(0));
		expect(result.embeddings![3]).toEqual(new Array(SMALL_DIMS).fill(0));
	});

	it('aligns across multiple batches with interleaved empties', async () => {
		const svc = new OpenAIEmbeddingService({
			apiKey: 'k',
			model: 'text-embedding-3-small',
			authHeaderType: 'api-key', // Azure path → batch size 16
		});
		// 18 non-empty + scattered empties → spans 2 batches (16 + 2).
		const inputs: string[] = [];
		const expectedSeeds: (number | null)[] = [];
		let seed = 1;
		for (let i = 0; i < 20; i++) {
			if (i === 5 || i === 11) {
				inputs.push('');
				expectedSeeds.push(null);
			} else {
				inputs.push(`t${i}`);
				expectedSeeds.push(seed++);
			}
		}
		const nonEmptyCount = expectedSeeds.filter(s => s !== null).length; // 18
		const firstBatch = Array.from({ length: 16 }, (_, k) => vec(k + 1));
		const secondBatch = Array.from({ length: nonEmptyCount - 16 }, (_, k) => vec(16 + k + 1));
		requestUrlMock
			.mockResolvedValueOnce(okBatch(firstBatch))
			.mockResolvedValueOnce(okBatch(secondBatch));

		const result = await svc.batchGenerateEmbeddings(inputs);
		expect(result.success).toBe(true);
		expect(result.embeddings!.length).toBe(inputs.length);

		// Each slot matches its expected seed (or zero for empties).
		expectedSeeds.forEach((s, i) => {
			if (s === null) {
				expect(result.embeddings![i]).toEqual(new Array(SMALL_DIMS).fill(0));
			} else {
				expect(result.embeddings![i][0]).toBe(s);
			}
		});
	});

	it('fails on a dimension mismatch from the provider', async () => {
		const svc = new OpenAIEmbeddingService({ apiKey: 'k', model: 'text-embedding-3-small' });
		requestUrlMock.mockResolvedValueOnce(okBatch([vec(1, 999)])); // wrong dims
		const result = await svc.batchGenerateEmbeddings(['x']);
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/dimension mismatch/i);
	});

	it('fails when the provider omits an input (missing index → no silent misalign)', async () => {
		const svc = new OpenAIEmbeddingService({ apiKey: 'k', model: 'text-embedding-3-small' });
		// 3 inputs but provider only returns indices 0 and 2 — index 1 missing.
		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			json: {
				data: [
					{ index: 0, embedding: vec(1) },
					{ index: 2, embedding: vec(3) },
				],
				usage: { total_tokens: 5 },
			},
		});
		const result = await svc.batchGenerateEmbeddings(['a', 'b', 'c']);
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/missing/i);
	});

	it('fails when the provider returns a duplicate index', async () => {
		const svc = new OpenAIEmbeddingService({ apiKey: 'k', model: 'text-embedding-3-small' });
		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			json: {
				data: [
					{ index: 0, embedding: vec(1) },
					{ index: 0, embedding: vec(2) },
				],
				usage: { total_tokens: 5 },
			},
		});
		const result = await svc.batchGenerateEmbeddings(['a', 'b']);
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/duplicate/i);
	});

	it('fails when the provider returns an out-of-range index', async () => {
		const svc = new OpenAIEmbeddingService({ apiKey: 'k', model: 'text-embedding-3-small' });
		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			json: {
				data: [
					{ index: 0, embedding: vec(1) },
					{ index: 5, embedding: vec(2) },
				],
				usage: { total_tokens: 5 },
			},
		});
		const result = await svc.batchGenerateEmbeddings(['a', 'b']);
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/out of range/i);
	});
});

describe('OpenAIEmbeddingService.generateEmbedding dimension validation', () => {
	beforeEach(() => requestUrlMock.mockReset());

	it('throws on a wrong-dimension embedding', async () => {
		const svc = new OpenAIEmbeddingService({ apiKey: 'k', model: 'text-embedding-3-small' });
		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			json: { data: [{ index: 0, embedding: vec(1, 10) }], usage: { total_tokens: 1 } },
		});
		const result = await svc.generateEmbedding('hello');
		// thrown error is caught and surfaced as a failed result by generateEmbedding's try/catch
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/dimension mismatch/i);
	});

	it('returns a correctly-sized embedding on success', async () => {
		const svc = new OpenAIEmbeddingService({ apiKey: 'k', model: 'text-embedding-3-small' });
		requestUrlMock.mockResolvedValueOnce({
			status: 200,
			json: { data: [{ index: 0, embedding: vec(7) }], usage: { total_tokens: 1 } },
		});
		const result = await svc.generateEmbedding('hello');
		expect(result.success).toBe(true);
		expect(result.embedding!.length).toBe(SMALL_DIMS);
	});
});
