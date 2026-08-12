/**
 * Settings validator — validates Azure configuration before service initialization.
 * Blocks init on errors, shows warnings as Notices.
 */

import type { AIOrganiserSettings } from '../../core/settings';
import { isKnownModel, getCapabilities, TASK_CAPABILITY_REQUIREMENTS } from '../../core/modelCatalog';
import { ALL_TASK_TYPES } from '../../core/taskTypes';

export interface ValidationResult {
	valid: boolean;
	warnings: string[];
	errors: string[];
}

const AZURE_AI_DOMAIN_SUFFIX = '.services.ai.azure.com';
const AZURE_OPENAI_DOMAIN_SUFFIX = '.openai.azure.com';
/**
 * Azure API Management. An APIM instance can front EITHER Azure surface (often
 * both, under a base path such as `/foundry`), so it is accepted for both
 * endpoints — the direct-resource suffixes alone made an APIM-fronted tenant
 * unconfigurable.
 */
const AZURE_APIM_DOMAIN_SUFFIX = '.azure-api.net';
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Host-anchored Azure domain check. Parses the URL and matches the hostname
 * suffix so `https://evil.services.ai.azure.com.attacker.com` is rejected
 * (the attacker host does NOT end with the Azure suffix). https-only.
 *
 * Accepts any of `suffixes` — anchoring is per-suffix, so adding APIM widens
 * the allowlist without weakening the anchor.
 */
function hostMatchesAzureDomain(rawUrl: string, ...suffixes: string[]): boolean {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return false;
	}
	if (url.protocol !== 'https:') return false;
	return suffixes.some((s) => url.hostname.endsWith(s));
}

export function validateSettings(settings: AIOrganiserSettings): ValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	// Only validate Azure settings if using Azure provider
	if (!settings.cloudServiceType?.startsWith('azure')) {
		return { valid: true, warnings, errors };
	}

	// ── Endpoint validation ──────────────────────────────────────────────

	if (settings.azureAIEndpoint) {
		if (!settings.azureAIEndpoint.startsWith('https://')) {
			errors.push('Azure AI endpoint must use HTTPS');
		} else if (!hostMatchesAzureDomain(settings.azureAIEndpoint, AZURE_AI_DOMAIN_SUFFIX, AZURE_APIM_DOMAIN_SUFFIX)) {
			errors.push('Claude endpoint should use services.ai.azure.com or an azure-api.net APIM host — check Azure AI endpoint');
		}
	}

	if (settings.azureOpenAIEndpoint) {
		if (!settings.azureOpenAIEndpoint.startsWith('https://')) {
			errors.push('Azure OpenAI endpoint must use HTTPS');
		} else if (!hostMatchesAzureDomain(settings.azureOpenAIEndpoint, AZURE_OPENAI_DOMAIN_SUFFIX, AZURE_APIM_DOMAIN_SUFFIX)) {
			errors.push('OpenAI endpoint should use openai.azure.com or an azure-api.net APIM host — check Azure OpenAI endpoint');
		}
	}

	// ── API key check ────────────────────────────────────────────────────

	if (!settings.azureKeyStored && !settings.azureApiKey) {
		errors.push('Azure API key not configured — set it in AI provider settings');
	}

	// ── Whisper deployment name ──────────────────────────────────────────

	if (settings.azureWhisperDeployment && !SAFE_PATH_SEGMENT.test(settings.azureWhisperDeployment)) {
		errors.push('Whisper deployment name contains invalid characters — use only letters, numbers, hyphens, underscores');
	}

	// ── Task model validation ────────────────────────────────────────────

	if (settings.taskModels) {
		for (const task of ALL_TASK_TYPES) {
			const modelId = settings.taskModels[task as keyof typeof settings.taskModels];
			if (!modelId) continue;

			// Check if model is known
			if (!isKnownModel(modelId)) {
				warnings.push(`Model '${modelId}' for task '${task}' is not in the known model catalog — capabilities unknown, defaulting to text-only`);
				continue;
			}

			// Check capability requirements
			const requirements = TASK_CAPABILITY_REQUIREMENTS[task];
			const capabilities = getCapabilities(modelId);

			if (requirements.reasoning && !capabilities.reasoning) {
				errors.push(`Task '${task}' requires reasoning but model '${modelId}' does not support it`);
			}
			if (requirements.tools && !capabilities.tools) {
				errors.push(`Task '${task}' requires tool use but model '${modelId}' does not support it`);
			}
		}
	}

	// ── Deployment-based routing validation ───────────────────────────────

	if (settings.azureRoutingMode === 'deployment-based') {
		if (!settings.azureDeployments?.chat) {
			warnings.push('Deployment-based routing selected but no chat deployment name configured');
		}
	}

	return {
		valid: errors.length === 0,
		warnings,
		errors,
	};
}
