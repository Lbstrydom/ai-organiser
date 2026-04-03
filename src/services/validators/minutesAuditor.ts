/**
 * Minutes LLM Auditor (Phase 5)
 * Optional LLM audit pass after deterministic validation.
 * DD-5: Always optional, never blocking. Fail-open on any error.
 * DD-6: Returns ValidationResult<MinutesJSON>.
 */

import type { MinutesJSON } from '../prompts/minutesPrompts';
import type { SummarizableLLMService } from '../types';
import type { ValidationResult, ValidationIssue } from './types';
import type { AuditProviderConfig } from '../apiKeyHelpers';
import type { MinutesValidationOptions } from './minutesValidator';
import type { App } from 'obsidian';
import { MINUTES_AUDIT_TIMEOUT_MS } from './constants';
import { buildMinutesAuditPrompt } from '../prompts/auditPrompts';
import { validateMinutesJSON } from './minutesValidator';
import { tryExtractJson } from '../../utils/responseParser';
import { CloudLLMService } from '../cloudService';

interface MinutesAuditVerdict {
    verdict: 'approve' | 'optimize' | 'flag';
    issues?: Array<{ severity: string; field: string; message: string }>;
    optimized?: MinutesJSON | null;
}

/**
 * Audit minutes JSON with an LLM for semantic checks the algorithm can't do.
 *
 * Flow:
 * 1. Build audit prompt with JSON + transcript excerpt + existing issues
 * 2. Call LLM with timeout (dedicated provider if configured)
 * 3. If verdict === 'optimize': re-validate optimized output with deterministic validator
 *    - If passes → return optimized JSON
 *    - If fails → downgrade to flag, return original
 * 4. If verdict === 'flag' or 'approve': return original JSON with audit issues
 * 5. On any error → return original JSON unchanged (fail-open)
 */
export async function auditMinutesWithLLM(
    json: MinutesJSON,
    transcript: string,
    validationIssues: ValidationIssue[],
    llmService: SummarizableLLMService,
    providerConfig?: AuditProviderConfig | null,
    options?: { timeoutMs?: number; validationOptions?: MinutesValidationOptions; app?: App }
): Promise<ValidationResult<MinutesJSON>> {
    const timeoutMs = options?.timeoutMs ?? MINUTES_AUDIT_TIMEOUT_MS;

    try {
        const prompt = buildMinutesAuditPrompt(json, transcript, validationIssues);

        // Use dedicated audit provider if configured, otherwise main service
        const service = resolveAuditService(llmService, providerConfig, options?.app);
        const response = await service.summarizeText(prompt, { timeoutMs });

        if (!response.success || !response.content) {
            return makeSkipResult(json);
        }

        const parsed = tryExtractJson(response.content) as MinutesAuditVerdict | null;
        if (!parsed || !parsed.verdict) {
            return makeSkipResult(json);
        }

        const auditIssues: ValidationIssue[] = (parsed.issues || []).map(i => ({
            severity: (i.severity === 'warning' ? 'warning' : 'info') as 'warning' | 'info',
            field: i.field || 'audit',
            message: `[Audit] ${i.message}`
        }));

        if (parsed.verdict === 'optimize' && parsed.optimized) {
            // Re-validate the optimized output through deterministic validator
            // Pass the same options (useGTD, participants) as the initial validation
            const revalidation = validateMinutesJSON(parsed.optimized, options?.validationOptions);
            if (revalidation.valid) {
                return {
                    valid: true,
                    data: revalidation.data,
                    issues: [...auditIssues, ...revalidation.issues]
                };
            }
            // Optimized output failed integrity — downgrade to flag
            auditIssues.push({
                severity: 'info',
                field: 'audit',
                message: 'Audit optimization failed integrity check — using original'
            });
        }

        // approve or flag — return original JSON with audit issues
        return {
            valid: true,
            data: json,
            issues: auditIssues
        };
    } catch {
        return makeSkipResult(json);
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

function makeSkipResult(json: MinutesJSON): ValidationResult<MinutesJSON> {
    return {
        valid: true,
        data: json,
        issues: [{
            severity: 'info',
            field: 'audit',
            message: 'LLM audit skipped'
        }]
    };
}
