/**
 * Model catalog — single source of truth for model capabilities, defaults, and aliases.
 * When Azure deploys new models, add them here. No other file defines model metadata.
 */

import type { TaskType } from './taskTypes';
import { parseClaudeModel, type ClaudeModelParts } from '../services/adapters/modelCapabilities';

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
export const CATALOG_VERSION = '2026-06-08';

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
		id: 'claude-opus-4-7' as ModelId,
		name: 'Claude Opus 4.7',
		provider: 'azure-claude',
		// 1M context — deep research/audit over long PDF reports.
		capabilities: { vision: true, tools: true, reasoning: true, maxContextK: 1024 },
	},
	{
		id: 'gpt-5.3-chat' as ModelId,
		name: 'GPT-5.3',
		provider: 'azure-openai',
		capabilities: { vision: true, tools: true, reasoning: true, maxContextK: 128 },
	},
	{
		id: 'gpt-5.5' as ModelId,
		name: 'GPT-5.5',
		provider: 'azure-openai',
		capabilities: { vision: true, tools: true, reasoning: true, maxContextK: 128 },
	},
	{
		id: 'gpt-5.4-nano' as ModelId,
		name: 'GPT-5.4 nano',
		provider: 'azure-openai',
		// Fast/cheap triage + classification tier — non-reasoning for speed.
		capabilities: { vision: true, tools: true, reasoning: false, maxContextK: 128 },
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

/** Catalog `azure-claude` Opus ids, newest version first — derived from the
 *  MODEL_CATALOG SSOT (no loose hardcoding). An Opus version bump is a catalog
 *  edit, picked up here automatically. */
function azureClaudeOpusIdsNewestFirst(): string[] {
	return MODEL_CATALOG
		.filter(m => m.provider === 'azure-claude')
		.map(m => ({ id: m.id as string, parts: parseClaudeModel(m.id) }))
		.filter((x): x is { id: string; parts: ClaudeModelParts } => x.parts?.tier === 'opus')
		.sort((a, b) => a.parts.major !== b.parts.major
			? b.parts.major - a.parts.major
			: b.parts.minor - a.parts.minor)
		.map(x => x.id);
}

/**
 * Depth-tier model resolver for the presentation Speed pill
 * (presentation-depth-controls D4). Returns a CONCRETE model id to use as a
 * per-call `modelOverride`, or `''` meaning "no upgrade — use the configured main
 * model". The returned id is the INPUT to `resolveModelOverride`, never sent raw.
 *
 *  - tier `'fast'` → `''` (always; Fast = your main model, no upgrade).
 *  - tier `'quality'`:
 *      - direct `claude` → `'latest-opus'` (the idiomatic sentinel;
 *        `resolveModelOverride` resolves it to the newest concrete claude-opus
 *        against the live/static pool — never dropped, a concrete opus always exists).
 *      - `azure-claude` → the newest catalog Opus PRESENT in `availableIds` (the
 *        tenant's actual deployments), so a tenant on opus-4-6 still gets Deep.
 *        `availableIds` non-empty but NO Opus → `''` (graceful Fast). `availableIds`
 *        EMPTY (live cache never refreshed — static catalog is NOT tenant truth) →
 *        the newest catalog Opus as an ATTEMPT (a genuinely-missing deployment then
 *        surfaces as a clear API error, not a silent downgrade).
 *      - other providers → `''`.
 */
export function resolveDepthModel(args: {
	adapterType: string;
	tier: 'fast' | 'quality';
	availableIds: string[];
}): string {
	const { adapterType, tier, availableIds } = args;
	if (tier === 'fast') return '';
	if (adapterType === 'claude') return 'latest-opus';
	if (adapterType === 'azure-claude') {
		const opusNewestFirst = azureClaudeOpusIdsNewestFirst();
		if (availableIds.length === 0) return opusNewestFirst[0] ?? '';
		for (const id of opusNewestFirst) {
			if (availableIds.includes(id)) return id;
		}
		return '';
	}
	return '';
}
