/**
 * Without a live model list, `latest-*` resolves from the static registry. A model
 * added to the catalog or the Azure defaults but not to the registry silently sends
 * those users to an older generation.
 */
import { describe, it, expect } from 'vitest';
import { AZURE_DEFAULT_CLAUDE_HEAVY_MODEL, AZURE_DEFAULT_CLAUDE_MODEL } from '../src/core/azureDefaults';
import { MODEL_CATALOG } from '../src/core/modelCatalog';
import { pickNewestClaude, resolveLatestModel, type ClaudeTier } from '../src/services/adapters/modelCapabilities';
import { PROVIDER_MODELS } from '../src/services/adapters/modelRegistry';

const registryIds = Object.keys(PROVIDER_MODELS.claude ?? {}).filter(id => !id.startsWith('latest-'));
const knownIds: string[] = [
    ...MODEL_CATALOG.map(entry => entry.id as string),
    AZURE_DEFAULT_CLAUDE_MODEL,
    AZURE_DEFAULT_CLAUDE_HEAVY_MODEL,
];

describe('offline Claude latest-* resolution', () => {
    it.each<ClaudeTier>(['opus', 'sonnet'])('latest-%s is not older than any model the plugin names', tier => {
        const newest = pickNewestClaude([...registryIds, ...knownIds], tier);
        expect(resolveLatestModel('claude', `latest-${tier}`, registryIds)).toBe(newest);
    });

    it('latest-haiku resolves to Haiku 5.5', () => {
        expect(resolveLatestModel('claude', 'latest-haiku', registryIds)).toBe('claude-haiku-5-5');
    });
});
