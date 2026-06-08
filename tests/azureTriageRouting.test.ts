/**
 * Azure nano-triage routing (Phase 3) — proves the deployment-based route
 * REACHES the fast deployment instead of being silently dropped by
 * `blockOverride`, and that both routing modes + both surfaces resolve a
 * correct endpoint/model/type (or null when triage shouldn't apply).
 */

import { describe, it, expect } from 'vitest';
import {
    resolveAzureTriageRoute,
    type AzureTriageSettings,
} from '../src/services/azure/azureTriageRouting';

const OPENAI_HOST = 'https://my-resource.openai.azure.com';
const FOUNDRY_HOST = 'https://my-resource.services.ai.azure.com';

function base(overrides: Partial<AzureTriageSettings> = {}): AzureTriageSettings {
    return {
        cloudServiceType: 'azure-openai',
        azureFastModel: { openai: 'gpt-5.4-nano', claude: 'claude-haiku-4-5' },
        azureAIEndpoint: FOUNDRY_HOST,
        azureOpenAIEndpoint: OPENAI_HOST,
        azureRoutingMode: 'model-based',
        ...overrides,
    };
}

describe('resolveAzureTriageRoute', () => {
    it('returns null when not in Azure mode', () => {
        expect(resolveAzureTriageRoute(base({ cloudServiceType: 'claude' }))).toBeNull();
    });

    it('returns null when no fast model is configured for the active surface', () => {
        expect(resolveAzureTriageRoute(base({ azureFastModel: {} }))).toBeNull();
        expect(resolveAzureTriageRoute(base({ azureFastModel: { claude: 'x' } }))).toBeNull(); // openai surface, claude-only
    });

    it('azure-openai model-based → generic URL, fast model in the body', () => {
        const route = resolveAzureTriageRoute(base({ azureRoutingMode: 'model-based' }));
        expect(route).not.toBeNull();
        expect(route!.type).toBe('azure-openai');
        expect(route!.modelName).toBe('gpt-5.4-nano');
        expect(route!.endpoint).toBe(`${OPENAI_HOST}/openai/v1/chat/completions`);
    });

    it('azure-openai deployment-based → URL TARGETS the fast deployment (not dropped)', () => {
        const route = resolveAzureTriageRoute(base({
            azureRoutingMode: 'deployment-based',
            azureDeployments: { chat: 'gpt-5.5' }, // main chat deployment
            azureGPTModel: 'gpt-5.5',
        }));
        expect(route).not.toBeNull();
        expect(route!.type).toBe('azure-openai');
        expect(route!.modelName).toBe('gpt-5.4-nano');
        // The crux: the fast deployment is in the URL, NOT the main gpt-5.5.
        expect(route!.endpoint).toContain('/openai/deployments/gpt-5.4-nano/chat/completions');
        expect(route!.endpoint).not.toContain('gpt-5.5');
    });

    it('azure-claude → generic Claude messages URL, fast model in the body', () => {
        const route = resolveAzureTriageRoute(base({ cloudServiceType: 'azure-claude' }));
        expect(route).not.toBeNull();
        expect(route!.type).toBe('azure-claude');
        expect(route!.modelName).toBe('claude-haiku-4-5');
        expect(route!.endpoint).toBe(`${FOUNDRY_HOST}/anthropic/v1/messages`);
    });

    it('azure-claude is unaffected by routing mode (deployment never in URL)', () => {
        const route = resolveAzureTriageRoute(base({
            cloudServiceType: 'azure-claude',
            azureRoutingMode: 'deployment-based',
        }));
        expect(route!.endpoint).toBe(`${FOUNDRY_HOST}/anthropic/v1/messages`);
    });

    it('returns null (never throws) on a missing/invalid endpoint', () => {
        expect(resolveAzureTriageRoute(base({ azureOpenAIEndpoint: '' }))).toBeNull();
        expect(resolveAzureTriageRoute(base({ azureOpenAIEndpoint: 'not-a-url' }))).toBeNull();
        const claude = base({ cloudServiceType: 'azure-claude', azureAIEndpoint: 'http://insecure.example' });
        expect(resolveAzureTriageRoute(claude)).toBeNull(); // non-HTTPS rejected by normalizeEndpointUrl
    });

    it('trims a whitespace-padded fast deployment name', () => {
        const route = resolveAzureTriageRoute(base({ azureFastModel: { openai: '  gpt-5.4-nano  ' } }));
        expect(route!.modelName).toBe('gpt-5.4-nano');
    });
});
