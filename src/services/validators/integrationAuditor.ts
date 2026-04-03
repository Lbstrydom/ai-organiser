/**
 * Integration LLM Auditor (Phase 6)
 * Optional LLM audit pass for merge/callout integration strategies.
 * DD-5: Always optional, never blocking. Fail-open on any error.
 * Advisory only — if flagged, user gets a warning notice but content is still inserted.
 */

import type { PlacementStrategy, FormatStrategy } from '../../core/constants';
import type { SummarizableLLMService } from '../types';
import type { ValidationIssue } from './types';
import type { AuditProviderConfig } from '../apiKeyHelpers';
import type { App } from 'obsidian';
import { INTEGRATION_AUDIT_TIMEOUT_MS } from './constants';
import { buildIntegrationAuditPrompt } from '../prompts/auditPrompts';
import { tryExtractJson } from '../../utils/responseParser';
import { CloudLLMService } from '../cloudService';

interface IntegrationAuditVerdict {
    verdict: 'approve' | 'flag';
    issues?: Array<{ severity: string; field: string; message: string }>;
    summary?: string;
}

export interface IntegrationAuditResult {
    approved: boolean;
    issues: ValidationIssue[];
}

/**
 * Audit integration output with an LLM for content preservation and accuracy.
 * Only runs for merge/callout strategies (highest risk).
 *
 * Flow:
 * 1. Build audit prompt with original + pending + output excerpts
 * 2. Call LLM with timeout (dedicated provider if configured)
 * 3. If verdict === 'flag': return approved=false with issues
 * 4. If verdict === 'approve' or any error: return approved=true (fail-open)
 */
export async function auditIntegrationWithLLM(
    output: string,
    originalContent: string,
    pendingContent: string,
    placement: PlacementStrategy,
    format: FormatStrategy,
    llmService: SummarizableLLMService,
    providerConfig?: AuditProviderConfig | null,
    options?: { timeoutMs?: number; app?: App }
): Promise<IntegrationAuditResult> {
    const timeoutMs = options?.timeoutMs ?? INTEGRATION_AUDIT_TIMEOUT_MS;

    try {
        const prompt = buildIntegrationAuditPrompt(output, originalContent, pendingContent, placement, format);

        // Use dedicated audit provider if configured, otherwise main service
        const service = resolveAuditService(llmService, providerConfig, options?.app);
        const response = await service.summarizeText(prompt, { timeoutMs });

        if (!response.success || !response.content) {
            return { approved: true, issues: [] };
        }

        const parsed = tryExtractJson(response.content) as IntegrationAuditVerdict | null;
        if (!parsed || !parsed.verdict) {
            return { approved: true, issues: [] };
        }

        const auditIssues: ValidationIssue[] = (parsed.issues || []).map(i => ({
            severity: (i.severity === 'warning' ? 'warning' : 'info') as 'warning' | 'info',
            field: i.field || 'audit',
            message: `[Audit] ${i.message}`
        }));

        if (parsed.verdict === 'flag') {
            return { approved: false, issues: auditIssues };
        }

        return { approved: true, issues: auditIssues };
    } catch {
        // Fail-open: any error → approved
        return { approved: true, issues: [] };
    }
}

/**
 * Resolve the LLM service for audit calls.
 * If providerConfig is provided and app is available, creates a one-shot
 * CloudLLMService (same pattern as flashcard provider in flashcardCommands.ts).
 * Otherwise falls back to the main llmService.
 */
function resolveAuditService(
    mainService: SummarizableLLMService,
    providerConfig?: AuditProviderConfig | null,
    app?: App
): SummarizableLLMService {
    if (providerConfig && app) {
        return new CloudLLMService({
            type: providerConfig.provider,
            endpoint: providerConfig.endpoint,
            apiKey: providerConfig.apiKey,
            modelName: providerConfig.model
        }, app);
    }
    return mainService;
}
