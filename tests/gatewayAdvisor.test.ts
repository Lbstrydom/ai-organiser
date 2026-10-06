import { describe, it, expect } from 'vitest';
import {
	isApimGatewayEndpoint,
	adviseGatewaySettings,
	applyGatewayFixes,
	type GatewayAdvisorSettings,
} from '../src/services/azure/gatewayAdvisor';

const APIM = 'https://my-apim.azure-api.net/foundry';

function make(overrides: Partial<GatewayAdvisorSettings> = {}): GatewayAdvisorSettings {
	return {
		azureOpenAIEndpoint: APIM,
		azureRoutingMode: 'model-based',
		azureClaudeViaOpenAIGateway: false,
		azureDeployments: {},
		azureGPTModel: 'gpt-5.5',
		embeddingModel: 'text-embedding-3-large',
		...overrides,
	};
}

describe('isApimGatewayEndpoint', () => {
	it('matches *.azure-api.net hosts only', () => {
		expect(isApimGatewayEndpoint(APIM)).toBe(true);
		expect(isApimGatewayEndpoint('https://MY-APIM.AZURE-API.NET')).toBe(true);
		expect(isApimGatewayEndpoint('https://res.openai.azure.com')).toBe(false);
		expect(isApimGatewayEndpoint('https://azure-api.net.evil.com/x')).toBe(false);
		expect(isApimGatewayEndpoint('https://evil.com/?h=x.azure-api.net')).toBe(false);
	});

	it('is false for empty or malformed input', () => {
		expect(isApimGatewayEndpoint(undefined)).toBe(false);
		expect(isApimGatewayEndpoint('')).toBe(false);
		expect(isApimGatewayEndpoint('not a url')).toBe(false);
	});
});

describe('adviseGatewaySettings', () => {
	it('recommends all four fixes for an APIM gateway left on the defaults', () => {
		expect(adviseGatewaySettings(make())).toEqual([
			'routing', 'claude-gateway', 'chat-deployment', 'embeddings-deployment',
		]);
	});

	it('advises nothing for a non-gateway endpoint (byte-identical when not applicable)', () => {
		expect(adviseGatewaySettings(make({ azureOpenAIEndpoint: 'https://res.openai.azure.com' }))).toEqual([]);
	});

	it('advises nothing once the gateway is configured', () => {
		const done = make({
			azureRoutingMode: 'deployment-based',
			azureClaudeViaOpenAIGateway: true,
			azureDeployments: { chat: 'gpt-x', embeddings: 'emb-x' },
		});
		expect(adviseGatewaySettings(done)).toEqual([]);
	});

	it('does not suggest a deployment name it cannot derive', () => {
		const fixes = adviseGatewaySettings(make({ azureGPTModel: '', embeddingModel: '  ' }));
		expect(fixes).toEqual(['routing', 'claude-gateway']);
	});
});

describe('applyGatewayFixes', () => {
	it('applies routing + Claude toggle and seeds blank deployments from the model fields', () => {
		const s = make({ azureGPTModel: 'gpt-6.1-sol' });
		const applied = applyGatewayFixes(s);
		expect(applied).toHaveLength(4);
		expect(s.azureRoutingMode).toBe('deployment-based');
		expect(s.azureClaudeViaOpenAIGateway).toBe(true);
		expect(s.azureDeployments).toEqual({ chat: 'gpt-6.1-sol', embeddings: 'text-embedding-3-large' });
		expect(adviseGatewaySettings(s)).toEqual([]);
	});

	it('never overwrites a deployment name the user already set', () => {
		const s = make({ azureDeployments: { chat: 'my-chat' } });
		applyGatewayFixes(s);
		expect(s.azureDeployments?.chat).toBe('my-chat');
		expect(s.azureDeployments?.embeddings).toBe('text-embedding-3-large');
	});

	it('is a no-op for a non-gateway endpoint', () => {
		const s = make({ azureOpenAIEndpoint: 'https://res.openai.azure.com' });
		const before = JSON.stringify(s);
		expect(applyGatewayFixes(s)).toEqual([]);
		expect(JSON.stringify(s)).toBe(before);
	});
});
