/**
 * Detects an Azure API Management gateway in front of the OpenAI endpoint and
 * recommends the settings such a gateway usually needs.
 *
 * Field-caught 2026-10-05: a user pointed the OpenAI endpoint at an APIM host
 * (`*.azure-api.net`) and left the defaults, so chat/embeddings 404'd (the
 * default model-based routing calls `/openai/v1/...`, which gateways that only
 * publish named-deployment operations do not expose) and Claude / Claude web
 * search returned "unauthorized" (Claude went to the native Foundry host with
 * the APIM subscription key). The plugin cannot know the gateway's operations,
 * so this is ADVICE the user applies with one click — never an automatic
 * change to a configuration that may already be working.
 *
 * Pure (no I/O): settings in, recommendations out.
 */

export type GatewayFix = 'routing' | 'claude-gateway' | 'chat-deployment' | 'embeddings-deployment';

/** The subset of settings the advisor reads and (in `applyGatewayFixes`) writes. */
export interface GatewayAdvisorSettings {
	azureOpenAIEndpoint?: string;
	azureRoutingMode?: 'model-based' | 'deployment-based';
	azureClaudeViaOpenAIGateway?: boolean;
	azureDeployments?: { chat?: string; embeddings?: string };
	azureGPTModel?: string;
	embeddingModel?: string;
}

/** True when the endpoint's host is an Azure API Management gateway. */
export function isApimGatewayEndpoint(endpoint: string | undefined): boolean {
	if (typeof endpoint !== 'string' || !endpoint.trim()) return false;
	try {
		return new URL(endpoint.trim()).hostname.toLowerCase().endsWith('.azure-api.net');
	} catch {
		return false;
	}
}

const isBlank = (v: string | undefined): boolean => typeof v !== 'string' || v.trim() === '';

/** Fixes still outstanding for a gateway setup; empty when not a gateway or all set. */
export function adviseGatewaySettings(s: GatewayAdvisorSettings): GatewayFix[] {
	if (!isApimGatewayEndpoint(s.azureOpenAIEndpoint)) return [];
	const fixes: GatewayFix[] = [];
	if (s.azureRoutingMode !== 'deployment-based') fixes.push('routing');
	if (s.azureClaudeViaOpenAIGateway !== true) fixes.push('claude-gateway');
	if (isBlank(s.azureDeployments?.chat) && !isBlank(s.azureGPTModel)) fixes.push('chat-deployment');
	if (isBlank(s.azureDeployments?.embeddings) && !isBlank(s.embeddingModel)) fixes.push('embeddings-deployment');
	return fixes;
}

/**
 * Apply the outstanding fixes in place. Deployment names are seeded from the
 * model fields the user already set (only when blank), never invented.
 * Returns the fixes that were applied.
 */
export function applyGatewayFixes(s: GatewayAdvisorSettings): GatewayFix[] {
	const fixes = adviseGatewaySettings(s);
	for (const fix of fixes) {
		switch (fix) {
			case 'routing':
				s.azureRoutingMode = 'deployment-based';
				break;
			case 'claude-gateway':
				s.azureClaudeViaOpenAIGateway = true;
				break;
			case 'chat-deployment':
				s.azureDeployments = { ...s.azureDeployments, chat: (s.azureGPTModel ?? '').trim() };
				break;
			case 'embeddings-deployment':
				s.azureDeployments = { ...s.azureDeployments, embeddings: (s.embeddingModel ?? '').trim() };
				break;
		}
	}
	return fixes;
}
