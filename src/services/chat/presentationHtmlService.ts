/**
 * Presentation IR Service
 *
 * LLM orchestration for the structured-IR presentation engine: deck-IR
 * generation + refine, deterministic IR→HTML preview rendering, and the brand
 * audit. The deck IR is the source of truth; HTML is a rendered projection.
 * (Legacy raw-HTML generation/refine/scoped-edit was retired 2026-06.)
 */

import type { LLMFacadeContext } from '../llmFacade';
import { summarizeText } from '../llmFacade';
import type { Result } from '../../core/result';
import { ok, err } from '../../core/result';
import type { AuditResult, DomFix, PromptSource, AudienceTier } from './presentationTypes';
import type { BrandTheme } from './brandThemeService';
import {
    buildGenerationPrompt,
    buildCreationPromptWithStyle,
    buildBrandAuditPrompt,
    wrapInDocument,
} from '../prompts/presentationChatPrompts';
import { sanitizePresentation, injectCSP } from './presentationSanitizer';
import {
    GENERATION_HARD_BUDGET_MS,
    REFINEMENT_HARD_BUDGET_MS,
    AUDIT_TIMEOUT,
} from './presentationConstants';
import { tryExtractJson } from '../../utils/responseParser';
import { logger } from '../../utils/logger';
import type { ExportTheme } from '../export/exportTheme';
import type { SlideDeckIr } from '../presentationIr/slideIr';
import { renderDeckToHtml } from '../presentationIr/irToHtml';
import { buildIrSystemPrompt, buildIrRepairPrompt, buildIrRefinePrompt, parseIrFromResponse } from '../presentationIr/irPrompts';

// ── Structured-IR Generation (Phase B) ────────────────────────────────────

export interface GenerateIrOptions {
    userQuery: string;
    noteContent?: string;
    conversationHistory?: string;
    outputLanguage?: string;
    /** Target slide count from the create-panel length picker (hard requirement). */
    targetLength?: number;
    /** Resolved sources (notes, web-search results, folders) — incl. web search. */
    sources?: PromptSource[];
    /** Audience tier for density/tone guidance. */
    audience?: AudienceTier;
    signal?: AbortSignal;
}

/**
 * Generate a `SlideDeckIr` from the LLM (structured-IR engine). Owns the LLM
 * call + a single Zod-validated repair retry (the pure parser lives in
 * `irPrompts.parseIrFromResponse`). Returns `Result`; the caller falls back to
 * legacy HTML generation on failure so `this.html` is always populated.
 */
export async function generateDeckIr(
    context: LLMFacadeContext,
    options: GenerateIrOptions,
): Promise<Result<SlideDeckIr>> {
    if (options.signal?.aborted) return err('Aborted');

    const systemPrompt = buildIrSystemPrompt({ outputLanguage: options.outputLanguage, targetLength: options.targetLength });
    // When the user attached sources (notes / web-search / folders), thread
    // their resolved content + audience + length through the richer creation
    // prompt; otherwise fall back to the basic note-content prompt.
    const userPrompt = (options.sources && options.sources.length > 0)
        ? buildCreationPromptWithStyle({
            userQuery: options.userQuery,
            sources: options.sources,
            audience: options.audience ?? 'general',
            length: options.targetLength ?? 8,
            conversationHistory: options.conversationHistory,
        })
        : buildGenerationPrompt({
            userQuery: options.userQuery,
            noteContent: options.noteContent,
            conversationHistory: options.conversationHistory,
        });

    try {
        const first = await summarizeText(context, `${systemPrompt}\n\n${userPrompt}`, {
            timeoutMs: GENERATION_HARD_BUDGET_MS,
            signal: options.signal,
        });
        if (options.signal?.aborted) return err('Aborted');
        if (!first.success || !first.content) {
            return err(first.error || 'IR generation: LLM returned empty response');
        }

        const parsed = parseIrFromResponse(first.content);
        if (parsed.ok) return parsed;

        // One repair retry with the validation error fed back.
        if (options.signal?.aborted) return err('Aborted');
        logger.warn('Presentation', `IR validation failed, repairing: ${parsed.error}`);
        const repairPrompt = buildIrRepairPrompt(first.content, parsed.error);
        const retry = await summarizeText(context, `${systemPrompt}\n\n${repairPrompt}`, {
            timeoutMs: GENERATION_HARD_BUDGET_MS,
            signal: options.signal,
        });
        if (options.signal?.aborted) return err('Aborted');
        if (!retry.success || !retry.content) return err(parsed.error);
        return parseIrFromResponse(retry.content);
    } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        logger.error('Presentation', `IR generation failed: ${msg}`);
        return err(`IR generation: ${msg}`);
    }
}

/**
 * Deterministically render a deck IR to the self-contained preview HTML, then
 * run the SAME sanitize → wrap → CSP chain the HTML path uses (plan H1 — the
 * service is the only thing that produces `this.html`, always sanitized).
 */
export function buildHtmlFromDeckIr(
    deck: SlideDeckIr,
    exportTheme: ExportTheme,
    brandCss: string,
    language?: string,
): Result<string> {
    const rendered = renderDeckToHtml(deck, exportTheme);
    if (!rendered.ok) return rendered;

    const sanitized = sanitizePresentation(rendered.value.html);
    if (!sanitized.hasDeckRoot) return err('IR→HTML: missing .deck root element');
    if (!sanitized.hasSlides) return err('IR→HTML: no .slide elements found');

    const wrapped = wrapInDocument(sanitized.html, brandCss, language);
    return ok(injectCSP(wrapped));
}

export interface RefineIrOptions {
    currentDeck: SlideDeckIr;
    userRequest: string;
    outputLanguage?: string;
    signal?: AbortSignal;
}

/**
 * Refine an existing deck IR per a user request (subsequent rounds). Same
 * LLM-call + validate + 1-repair shape as `generateDeckIr`; keeps the deck
 * IR-backed so export stays faithful after edits.
 */
export async function refineDeckIr(
    context: LLMFacadeContext,
    options: RefineIrOptions,
): Promise<Result<SlideDeckIr>> {
    if (options.signal?.aborted) return err('Aborted');

    const systemPrompt = buildIrSystemPrompt({ outputLanguage: options.outputLanguage });
    const userPrompt = buildIrRefinePrompt(options.currentDeck, options.userRequest);

    try {
        const first = await summarizeText(context, `${systemPrompt}\n\n${userPrompt}`, {
            timeoutMs: REFINEMENT_HARD_BUDGET_MS,
            signal: options.signal,
        });
        if (options.signal?.aborted) return err('Aborted');
        if (!first.success || !first.content) {
            return err(first.error || 'IR refine: LLM returned empty response');
        }

        const parsed = parseIrFromResponse(first.content);
        if (parsed.ok) return parsed;

        if (options.signal?.aborted) return err('Aborted');
        logger.warn('Presentation', `IR refine validation failed, repairing: ${parsed.error}`);
        const repairPrompt = buildIrRepairPrompt(first.content, parsed.error);
        const retry = await summarizeText(context, `${systemPrompt}\n\n${repairPrompt}`, {
            timeoutMs: REFINEMENT_HARD_BUDGET_MS,
            signal: options.signal,
        });
        if (options.signal?.aborted) return err('Aborted');
        if (!retry.success || !retry.content) return err(parsed.error);
        return parseIrFromResponse(retry.content);
    } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        logger.error('Presentation', `IR refine failed: ${msg}`);
        return err(`IR refine: ${msg}`);
    }
}

// ── Brand Audit (H3 fix — explicit status, not fail-open) ──────────────────

export async function runBrandAudit(
    context: LLMFacadeContext,
    html: string,
    theme: BrandTheme,
    signal?: AbortSignal
): Promise<Result<AuditResult>> {
    if (signal?.aborted) return err('Aborted');

    if (!theme.auditChecklist.length) {
        return ok({ status: 'passed', passed: ['all'], violations: [] });
    }

    const prompt = buildBrandAuditPrompt(html, theme.auditChecklist);

    let result;
    try {
        result = await summarizeText(context, prompt, {
            timeoutMs: AUDIT_TIMEOUT,
            signal,
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        logger.error('PresentationAudit', `Brand audit LLM call threw: ${msg}`);
        return ok({ status: 'unavailable', passed: [], violations: [] });
    }

    if (signal?.aborted) return err('Aborted');

    if (!result.success || !result.content) {
        // H3 fix: explicit 'unavailable' status instead of pretending pass
        logger.warn('PresentationAudit', `Audit LLM call failed: ${result.error}`);
        return ok({ status: 'unavailable', passed: [], violations: [] });
    }

    const parsed = tryExtractJson(result.content);
    if (!parsed || typeof parsed !== 'object') {
        return ok({ status: 'failed', passed: [], violations: [] });
    }

    const obj = parsed as Record<string, unknown>;
    const passed = Array.isArray(obj.passed) ? obj.passed.map(String) : [];
    const violations: DomFix[] = [];

    if (Array.isArray(obj.violations)) {
        for (const v of obj.violations) {
            if (!v || typeof v !== 'object') continue;
            const fix = v as Record<string, unknown>;
            if (typeof fix.selector === 'string' && typeof fix.property === 'string' && typeof fix.value === 'string') {
                violations.push({
                    selector: fix.selector,
                    property: fix.property,
                    value: fix.value,
                    reason: typeof fix.reason === 'string' ? fix.reason : '',
                });
            }
        }
    }

    const status = violations.length > 0 ? 'violations' : 'passed';
    return ok({ status, passed, violations });
}

