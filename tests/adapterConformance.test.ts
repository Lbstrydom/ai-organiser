/**
 * Adapter Conformance Suite.
 *
 * Registry-driven — iterates ALL_ADAPTERS directly and constructs every
 * adapter via the real createAdapter() factory, the same code path
 * CloudLLMService uses. A 17th adapter added to the registry is
 * automatically covered with zero edits to this file.
 *
 * Structural, not behavioural: required-method presence, response-
 * normalisation safety net, and "declared capability => overridden code
 * path actually does something". No live keys, no network — adapters
 * never perform I/O themselves (see docs/adapter-conformance-contract.md).
 *
 * See docs/adapter-conformance-contract.md for the full derived contract
 * with file:line citations.
 */

import { describe, it, expect } from 'vitest';
import { createAdapter, type AdapterType } from '../src/services/adapters';
import { BaseAdapter } from '../src/services/adapters/baseAdapter';
import { ALL_ADAPTERS, PROVIDER_ENDPOINT, PROVIDER_DEFAULT_MODEL } from '../src/services/adapters/providerRegistry';
import type { AdapterConfig, MultimodalCapability } from '../src/services/adapters/types';

const VALID_CAPABILITIES: readonly MultimodalCapability[] = ['text-only', 'image', 'document', 'image+document'];

// Reads directly from the real registry — no fallback substitution. The
// registry is typed `Record<AdapterType, string>`, so every key genuinely
// has a value today; azure-claude/azure-openai's deliberate `''` (vault-
// config-resolved) is the correct real value, not a gap to paper over. A
// fallback here would silently mask an accidentally-emptied registry entry
// for a NON-azure provider — exactly the defect this suite exists to catch
// (audit-caught: an earlier draft used `|| 'https://example.test'`).
function baseConfig(type: AdapterType): AdapterConfig {
	return {
		endpoint: PROVIDER_ENDPOINT[type],
		apiKey: 'test-key-not-real',
		modelName: PROVIDER_DEFAULT_MODEL[type],
	};
}

const IMAGE_SENTINEL = 'IMG_SENTINEL_9f3a2b1c';
const DOC_SENTINEL = 'DOC_SENTINEL_7e4d5c6b';

describe.each(ALL_ADAPTERS)('%s adapter conformance', (type) => {
	const adapter = createAdapter(type, baseConfig(type));

	it(`[${type}][required-methods] all required methods are present and are functions`, () => {
		const required = [
			'getEndpoint', 'getHeaders', 'validateConfig', 'formatRequest',
			'parseResponseContent', 'parseResponse', 'getMultimodalCapability', 'formatMultimodalRequest',
		] as const;
		for (const method of required) {
			expect(
				typeof (adapter as unknown as Record<string, unknown>)[method],
				`[${type}][required-methods] expected "${method}" to be a function; observed ${typeof (adapter as unknown as Record<string, unknown>)[method]}`,
			).toBe('function');
		}
	});

	it(`[${type}][parseResponseContent-safety] never throws and always returns a string on malformed input`, () => {
		for (const garbage of [null, undefined, {}, 'garbage', 42, []]) {
			let result: unknown;
			expect(
				() => { result = adapter.parseResponseContent(garbage); },
				`[${type}][parseResponseContent-safety] expected parseResponseContent(${JSON.stringify(garbage)}) not to throw; it threw`,
			).not.toThrow();
			expect(
				typeof result,
				`[${type}][parseResponseContent-safety] expected a string for input ${JSON.stringify(garbage)}; observed ${typeof result}`,
			).toBe('string');
		}
	});

	it(`[${type}][capability-enum] getMultimodalCapability() returns one of the 4 valid values`, () => {
		const capability = adapter.getMultimodalCapability();
		expect(
			VALID_CAPABILITIES.includes(capability),
			`[${type}][capability-enum] expected one of ${JSON.stringify(VALID_CAPABILITIES)}; observed ${JSON.stringify(capability)}`,
		).toBe(true);
	});

	it(`[${type}][multimodal-capability-matches-code-path] declared capability implies an overridden formatMultimodalRequest, and the declared modality's sentinel survives`, () => {
		const capability = adapter.getMultimodalCapability();
		if (capability === 'text-only') {
			return; // nothing further required for text-only adapters
		}
		// Reference-inequality against the actual BaseAdapter.prototype method,
		// not `hasOwnProperty` on the leaf class — this correctly handles a
		// FUTURE shared intermediate base class implementing the override for
		// several providers (would incorrectly fail hasOwnProperty despite
		// genuinely not being the BaseAdapter default; audit-caught).
		expect(
			adapter.formatMultimodalRequest !== BaseAdapter.prototype.formatMultimodalRequest,
			`[${type}][multimodal-capability-matches-code-path] expected formatMultimodalRequest to be overridden for capability "${capability}"; observed the inherited BaseAdapter default`,
		).toBe(true);

		if (capability === 'image' || capability === 'image+document') {
			const body = adapter.formatMultimodalRequest([{ type: 'image', data: IMAGE_SENTINEL, mediaType: 'image/png' }]);
			expect(
				JSON.stringify(body).includes(IMAGE_SENTINEL),
				`[${type}][multimodal-capability-matches-code-path] expected the image sentinel to survive into the serialised request; it was dropped`,
			).toBe(true);
		}
		if (capability === 'document' || capability === 'image+document') {
			const body = adapter.formatMultimodalRequest([{ type: 'document', data: DOC_SENTINEL, mediaType: 'application/pdf' }]);
			expect(
				JSON.stringify(body).includes(DOC_SENTINEL),
				`[${type}][multimodal-capability-matches-code-path] expected the document sentinel to survive into the serialised request; it was dropped`,
			).toBe(true);
		}
	});

	it(`[${type}][streaming-capability-matches-code-path] declared streaming support implies both gated methods exist and the request has the correct shape`, () => {
		if (!adapter.supportsStreaming?.()) {
			return; // capability-gated, not universally required
		}
		expect(
			typeof adapter.formatStreamingRequest,
			`[${type}][streaming-capability-matches-code-path] expected formatStreamingRequest to be a function when supportsStreaming() is true; observed ${typeof adapter.formatStreamingRequest}`,
		).toBe('function');
		expect(
			typeof adapter.parseStreamingChunk,
			`[${type}][streaming-capability-matches-code-path] expected parseStreamingChunk to be a function when supportsStreaming() is true; observed ${typeof adapter.parseStreamingChunk}`,
		).toBe('function');

		// Primary: family-agnostic shape — true regardless of wire format.
		const req = adapter.formatStreamingRequest!('test prompt');
		expect(req, `[${type}][streaming-capability-matches-code-path] expected formatStreamingRequest() to return an object`).toBeTruthy();
		expect(typeof req.url, `[${type}][streaming-capability-matches-code-path] expected .url`).toBe('string');
		expect(typeof req.headers, `[${type}][streaming-capability-matches-code-path] expected .headers`).toBe('object');
		expect(req.body, `[${type}][streaming-capability-matches-code-path] expected .body`).toBeTruthy();

		// Secondary: today's shared stream:true convention (11 OpenAI-compatible
		// adapters + Claude/AzureClaude's independent bespoke implementations —
		// see docs/adapter-conformance-contract.md for why this is a labelled
		// convention check, not a universal interface requirement).
		expect(
			(req.body as Record<string, unknown>).stream,
			`[${type}][streaming-capability-matches-code-path] expected body.stream === true (today's shared convention); observed ${JSON.stringify((req.body as Record<string, unknown>).stream)}`,
		).toBe(true);
	});

	it(`[${type}][validateConfig-safety] returns a string or null, never throws, even with an empty apiKey`, () => {
		const emptyKeyAdapter = createAdapter(type, { ...baseConfig(type), apiKey: '' });
		let result: unknown;
		expect(() => { result = emptyKeyAdapter.validateConfig(); }).not.toThrow();
		expect(result === null || typeof result === 'string', `[${type}][validateConfig-safety] expected null or string; observed ${typeof result}`).toBe(true);
	});
});

describe('Response normalisation (BaseAdapter.parseResponse tag coercion)', () => {
	// NOT per-adapter, despite an earlier draft attempting exactly that
	// (Gemini final-gate review G1 suggested moving this inside the
	// registry loop for future-proofing). Reverted after live implementation
	// showed the reasoning didn't survive contact with the actual code:
	// 12 of 16 adapters (deepseek, aliyun, claude, groq, vertex, openrouter,
	// bedrock, requesty, cohere, grok, openai-compatible, azure-claude) parse
	// their OWN provider-specific raw response envelope shape — most by
	// overriding parseResponse() outright, and even a few relying on the
	// BaseAdapter default (claude, azure-claude) fail against a generic
	// OpenAI-shaped fixture because their `this.provider.responseFormat`
	// config expects a different envelope. Testing this per-adapter would
	// require 16 provider-shaped fixtures — exactly the "per-provider
	// request/response fixture" work the plan's own addendum explicitly
	// scoped out. Only openai/gemini/mistral/azure-openai pass a generic
	// OpenAI-shaped fixture; 'openai' is used below as the representative
	// example of BaseAdapter's inherited normalisation logic
	// (baseAdapter.ts:73-87), which is what this test actually exercises.
	it('coerces a non-array matchedTags field to an empty array (not a single-element array)', () => {
		const adapter = createAdapter('openai', baseConfig('openai'));
		const raw = {
			choices: [{ message: { content: '{"matchedTags": "not-an-array", "newTags": [], "text": "hi"}' } }],
		};
		const result = adapter.parseResponse(raw);
		expect(result.matchedExistingTags).toEqual([]);
	});

	it('preserves valid tag values and trims whitespace, rather than only checking array-ness', () => {
		const adapter = createAdapter('openai', baseConfig('openai'));
		const raw = {
			choices: [{ message: { content: '{"matchedTags": ["exact", "  padded  "], "newTags": ["  new-padded  ", "clean"], "text": "hi"}' } }],
		};
		const result = adapter.parseResponse(raw);
		expect(result.matchedExistingTags).toEqual(['exact', 'padded']);
		expect(result.suggestedTags).toEqual(['new-padded', 'clean']);
	});
});

describe('ALL_ADAPTERS registry sanity', () => {
	// No hardcoded length assertion here (audit-caught: an earlier draft
	// asserted ALL_ADAPTERS.length === 16, which would need manual updating
	// for every future addition — directly undercutting this suite's core
	// "zero test-file edits for a new adapter" promise). The compile-time
	// exhaustiveness assertion in providerRegistry.ts already guards the
	// registry's own correctness; this block only proves every entry is
	// actually constructible.
	it('every entry constructs successfully via the real createAdapter() factory', () => {
		for (const type of ALL_ADAPTERS) {
			expect(() => createAdapter(type, baseConfig(type)), `[${type}] createAdapter() threw`).not.toThrow();
		}
	});
});
