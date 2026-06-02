import { describe, it, expect } from 'vitest';
import {
	getCapabilities,
	resolveModelId,
	getProviderForModel,
	isKnownModel,
	CATALOG_ALIASES,
	MODEL_CATALOG,
} from '../src/core/modelCatalog';

describe('modelCatalog.getCapabilities', () => {
	it('returns capabilities for a known model', () => {
		const caps = getCapabilities('claude-opus-4-6');
		expect(caps.reasoning).toBe(true);
		expect(caps.tools).toBe(true);
		expect(caps.vision).toBe(true);
	});

	it('resolves an alias to the aliased model capabilities', () => {
		// claude-sonnet-4-5 is an alias for claude-sonnet-4-6
		const aliased = getCapabilities('claude-sonnet-4-5');
		const canonical = getCapabilities('claude-sonnet-4-6');
		expect(aliased).toEqual(canonical);
	});

	it('falls back to text-only synthetic capabilities for unknown models', () => {
		const caps = getCapabilities('totally-made-up-model');
		expect(caps.vision).toBe(false);
		expect(caps.tools).toBe(false);
		expect(caps.reasoning).toBe(false);
	});
});

describe('modelCatalog.resolveModelId', () => {
	it('returns the canonical id unchanged for a known model', () => {
		expect(resolveModelId('gpt-5.3-chat')).toBe('gpt-5.3-chat');
	});

	it('resolves an alias to its canonical id', () => {
		expect(resolveModelId('claude-sonnet-4-5')).toBe('claude-sonnet-4-6');
		expect(resolveModelId('whisper-1')).toBe('whisper');
	});

	it('returns an unknown id unchanged', () => {
		expect(resolveModelId('unknown-x')).toBe('unknown-x');
	});

	it('does NOT alias cross-family ids (gpt-4o, gpt-5.2)', () => {
		// These aliased DISTINCT real model families — removed for the public repo
		// so pricing/behaviour are never silently changed.
		expect(CATALOG_ALIASES['gpt-4o']).toBeUndefined();
		expect(CATALOG_ALIASES['gpt-5.2']).toBeUndefined();
		expect(resolveModelId('gpt-4o')).toBe('gpt-4o');
		expect(resolveModelId('gpt-5.2')).toBe('gpt-5.2');
		expect(isKnownModel('gpt-4o')).toBe(false);
		expect(isKnownModel('gpt-5.2')).toBe(false);
	});
});

describe('modelCatalog.getProviderForModel', () => {
	it('returns the provider for known models', () => {
		expect(getProviderForModel('claude-opus-4-6')).toBe('azure-claude');
		expect(getProviderForModel('gpt-5.3-chat')).toBe('azure-openai');
	});

	it('resolves provider through an alias', () => {
		expect(getProviderForModel('claude-sonnet-4-5')).toBe('azure-claude');
	});

	it('returns null for an unknown model', () => {
		expect(getProviderForModel('nope')).toBeNull();
	});
});

describe('modelCatalog.isKnownModel', () => {
	it('is true for catalog ids and aliases', () => {
		expect(isKnownModel('whisper')).toBe(true);
		expect(isKnownModel('whisper-1')).toBe(true); // alias
	});

	it('is false for unknown ids', () => {
		expect(isKnownModel('mystery-model')).toBe(false);
	});
});

describe('embedding model distinctness (plan §7)', () => {
	it('does NOT alias text-embedding-3-small to -large', () => {
		expect(CATALOG_ALIASES['text-embedding-3-small']).toBeUndefined();
		// resolving small stays small (not redirected to large)
		expect(resolveModelId('text-embedding-3-small')).toBe('text-embedding-3-small');
	});

	it('keeps small=1536 and large=3072 dimensions distinct', () => {
		const small = MODEL_CATALOG.find(m => m.id === 'text-embedding-3-small');
		const large = MODEL_CATALOG.find(m => m.id === 'text-embedding-3-large');
		expect(small?.capabilities.dimensions).toBe(1536);
		expect(large?.capabilities.dimensions).toBe(3072);
	});
});
