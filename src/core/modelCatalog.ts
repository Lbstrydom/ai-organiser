/**
 * Model catalog — single source of truth for model capabilities, defaults, and aliases.
 * When Azure deploys new models, add them here. No other file defines model metadata.
 */

import type { TaskType } from './taskTypes';

export interface ModelCapabilities {
	vision: boolean;
	tools: boolean;
	reasoning: boolean;
	maxContextK: number;
	dimensions?: number; // for embedding models
}

export type ModelId = string & { __brand?: 'ModelId' };

interface CatalogEntry {
	id: ModelId;
	name: string;
	provider: 'azure-claude' | 'azure-openai';
	capabilities: ModelCapabilities;
}

/** Catalog version — incremented when models are added/removed/renamed */
export const CATALOG_VERSION = '2026-03-27';

/**
 * Model ID aliases for migration (old → new).
 *
 * NOTE: the `text-embedding-3-small → text-embedding-3-large` alias is
 * deliberately ABSENT (plan §7 / NOTES Q5). Those two embedding models have
 * different vector dimensions (1536 vs 3072); aliasing them would silently
 * invalidate existing Voy indexes. They stay distinct, separately selectable
 * catalog entries.
 */
export const CATALOG_ALIASES: Record<string, ModelId> = {
	'claude-sonnet-4-5': 'claude-sonnet-4-6' as ModelId,
	'claude-opus-4-5': 'claude-opus-4-6' as ModelId,
	'claude-sonnet-45-reasoning': 'claude-sonnet-4-6' as ModelId,
	'whisper-1': 'whisper' as ModelId,
};

export const MODEL_CATALOG: CatalogEntry[] = [
	{
		id: 'claude-sonnet-4-6' as ModelId,
		name: 'Claude Sonnet 4.6',
		provider: 'azure-claude',
		capabilities: { vision: true, tools: true, reasoning: true, maxContextK: 1024 },
	},
	{
		id: 'claude-opus-4-6' as ModelId,
		name: 'Claude Opus 4.6',
		provider: 'azure-claude',
		capabilities: { vision: true, tools: true, reasoning: true, maxContextK: 1024 },
	},
	{
		id: 'gpt-5.3-chat' as ModelId,
		name: 'GPT-5.3',
		provider: 'azure-openai',
		capabilities: { vision: true, tools: true, reasoning: true, maxContextK: 128 },
	},
	{
		id: 'text-embedding-3-large' as ModelId,
		name: 'Text Embedding 3 Large',
		provider: 'azure-openai',
		capabilities: { vision: false, tools: false, reasoning: false, maxContextK: 8, dimensions: 3072 },
	},
	{
		id: 'text-embedding-3-small' as ModelId,
		name: 'Text Embedding 3 Small',
		provider: 'azure-openai',
		capabilities: { vision: false, tools: false, reasoning: false, maxContextK: 8, dimensions: 1536 },
	},
	{
		id: 'whisper' as ModelId,
		name: 'Whisper',
		provider: 'azure-openai',
		capabilities: { vision: false, tools: false, reasoning: false, maxContextK: 0 },
	},
];

/** Synthetic fallback capabilities for unknown model IDs */
const UNKNOWN_MODEL_CAPABILITIES: ModelCapabilities = {
	vision: false,
	tools: false,
	reasoning: false,
	maxContextK: 8,
};

/** Pre-built Map for O(1) lookups by model ID */
const CATALOG_MAP = new Map<string, CatalogEntry>(MODEL_CATALOG.map(m => [m.id, m]));

/**
 * Get capabilities for a model ID. Returns synthetic fallback for unknown models.
 */
export function getCapabilities(modelId: string): ModelCapabilities {
	const entry = CATALOG_MAP.get(modelId);
	if (entry) return entry.capabilities;

	// Check aliases
	const aliased = CATALOG_ALIASES[modelId];
	if (aliased) {
		const aliasedEntry = CATALOG_MAP.get(aliased);
		if (aliasedEntry) return aliasedEntry.capabilities;
	}

	return { ...UNKNOWN_MODEL_CAPABILITIES };
}

/**
 * Get the provider type for a model ID.
 */
export function getProviderForModel(modelId: string): 'azure-claude' | 'azure-openai' | null {
	const entry = CATALOG_MAP.get(modelId);
	if (entry) return entry.provider;

	const aliased = CATALOG_ALIASES[modelId];
	if (aliased) {
		const aliasedEntry = MODEL_CATALOG.find(m => m.id === aliased);
		if (aliasedEntry) return aliasedEntry.provider;
	}

	return null;
}

/**
 * Check if a model ID is known in the catalog (including aliases).
 */
export function isKnownModel(modelId: string): boolean {
	return CATALOG_MAP.has(modelId) || modelId in CATALOG_ALIASES;
}

/**
 * Resolve a model ID through aliases. Returns the canonical ID.
 */
export function resolveModelId(modelId: string): ModelId {
	if (CATALOG_MAP.has(modelId)) return modelId as ModelId;
	return CATALOG_ALIASES[modelId] ?? modelId as ModelId;
}

/** Required capabilities per task type */
export const TASK_CAPABILITY_REQUIREMENTS: Record<TaskType, Partial<ModelCapabilities>> = {
	tagging: {},
	summarization: {},
	audit: { reasoning: true },
	research: { tools: true },
	chat: {},
	mermaid: {},
	embeddings: {},
	transcription: {},
};

/**
 * Get the display name for a model ID.
 */
export function getModelDisplayName(modelId: string): string {
	const entry = CATALOG_MAP.get(modelId);
	return entry?.name ?? modelId;
}
