/**
 * Presentation Quality Service
 *
 * Two-pass async quality review for HTML slide decks:
 * Pass 1 (fast scan): cheap model checks colour, typography, overflow, density, gestalt, consistency
 * Pass 2 (deep scan): main model checks spacing, contrast, alignment, visual balance
 */

import type { LLMFacadeContext } from '../llmFacade';
import { summarizeText } from '../llmFacade';
import type { Result } from '../../core/result';
import { ok, err } from '../../core/result';
import type { QualityFinding, QualityFindingCategory, FindingSeverity } from './presentationTypes';
import { buildFastScanPrompt, buildDeepScanPrompt } from '../prompts/presentationQualityPrompts';
import { LARGE_DECK_THRESHOLD } from './presentationConstants';
import { tryExtractJson } from '../../utils/responseParser';
import { logger } from '../../utils/logger';

// ── Constants ──────────────────────────────────────────────────────────────

const FAST_SCAN_TOKEN_BUDGET = 4096;
const DEEP_SCAN_TOKEN_BUDGET = 8192;
// LARGE_DECK_THRESHOLD imported from presentationConstants (H1 SSOT fix)
const SAMPLE_FIRST = 10;
const SAMPLE_TAIL = 5;
const SAMPLE_MIDDLE = 5;

// ── Types ──────────────────────────────────────────────────────────────────

export interface QualityScanResult {
    findings: QualityFinding[];
    pass: 'fast' | 'deep';
}

// ── Valid category sets (for validation) ───────────────────────────────────

const VALID_CATEGORIES = new Set<string>([
    'colour', 'typography', 'overflow', 'density', 'gestalt', 'consistency',
    'spacing', 'contrast', 'alignment', 'visual-balance',
]);

const VALID_SEVERITIES = new Set<string>(['HIGH', 'MEDIUM', 'LOW']);

// ── Public API ─────────────────────────────────────────────────────────────

/** Run fast visual scan using a cheap model. */
export async function runFastScan(
    context: LLMFacadeContext,
    html: string,
    slideCount: number,
    signal?: AbortSignal
): Promise<Result<QualityScanResult>> {
    return runScan(context, html, slideCount, 'fast', signal);
}

/** Run deep spatial analysis using the main model. */
export async function runDeepScan(
    context: LLMFacadeContext,
    html: string,
    slideCount: number,
    signal?: AbortSignal
): Promise<Result<QualityScanResult>> {
    return runScan(context, html, slideCount, 'deep', signal);
}

/** Deduplicate findings from two passes. Pass 2 (deep) takes precedence on collision. */
export function deduplicateFindings(
    pass1: QualityFinding[],
    pass2: QualityFinding[]
): QualityFinding[] {
    const map = new Map<string, QualityFinding>();

    for (const f of pass1) {
        map.set(findingKey(f), f);
    }
    // Pass 2 overwrites on collision
    for (const f of pass2) {
        map.set(findingKey(f), f);
    }

    return Array.from(map.values());
}

export interface SampledDeck {
    /** Sampled HTML with data-original-index injected on each slide. */
    html: string;
    /** Maps sampled position (0-based) to original slide index. */
    indexMap: number[];
}

/**
 * For large decks (>LARGE_DECK_THRESHOLD slides), sample representative slides.
 * Returns original HTML unchanged for small decks.
 * Injects data-original-index attributes so LLM findings reference correct positions (H11 fix).
 */
export function sampleLargeDeck(html: string, slideCount: number): SampledDeck | string {
    if (slideCount <= LARGE_DECK_THRESHOLD) return html;

    // H5/H10 fix: match <section class="slide ..."> not <div class="slide">
    const slideRegex = /<section\b[^>]*\bclass="[^"]*\bslide\b[^"]*"[^>]*>[\s\S]*?<\/section>/g;
    const slides: { content: string }[] = [];
    let match: RegExpExecArray | null;

    while ((match = slideRegex.exec(html)) !== null) {
        slides.push({ content: match[0] });
    }

    // Fallback: if regex didn't capture enough, return original
    if (slides.length < LARGE_DECK_THRESHOLD) return html;

    const selectedIndices = new Set<number>();

    // First N slides
    for (let i = 0; i < Math.min(SAMPLE_FIRST, slides.length); i++) {
        selectedIndices.add(i);
    }

    // Last N slides
    for (let i = Math.max(0, slides.length - SAMPLE_TAIL); i < slides.length; i++) {
        selectedIndices.add(i);
    }

    // Evenly spaced from middle
    const middleStart = SAMPLE_FIRST;
    const middleEnd = slides.length - SAMPLE_TAIL;
    if (middleEnd > middleStart) {
        const step = Math.max(1, Math.floor((middleEnd - middleStart) / (SAMPLE_MIDDLE + 1)));
        for (let i = 0; i < SAMPLE_MIDDLE; i++) {
            const target = middleStart + step * (i + 1);
            if (target < middleEnd) selectedIndices.add(target);
        }
    }

    const sorted = Array.from(selectedIndices).sort((a, b) => a - b);
    const indexMap: number[] = sorted;

    // H11 fix: inject data-original-index so findings reference the full-deck position
    const sampledSlides = sorted.map((originalIdx, sampleIdx) => {
        const content = slides[originalIdx].content;
        // Inject data-original-index onto the opening <section> tag
        return content.replace(/^(<section\b[^>]*)>/, `$1 data-original-index="${originalIdx}" data-sample-index="${sampleIdx}">`);
    });

    // Extract head/wrapper and rebuild
    const bodyStart = html.indexOf('<body');
    const hasBody = bodyStart >= 0;
    const prefix = hasBody ? html.slice(0, html.indexOf('>', bodyStart) + 1) : '';
    // M2 fix: only emit closing tags when source had a body element
    const suffix = hasBody ? '</body></html>' : '';
    // M6 fix: preserve the original deck opening tag (with data-title etc.) rather than hardcoding
    const deckOpenMatch = /<div\b[^>]*\bclass="[^"]*\bdeck\b[^"]*"[^>]*>/i.exec(html);
    const deckOpen = deckOpenMatch ? deckOpenMatch[0] : '<div class="deck">';
    const deckClose = '</div>';

    return {
        html: `${prefix}${deckOpen}${sampledSlides.join('\n')}${deckClose}${suffix}`,
        indexMap,
    };
}

// ── Internal ───────────────────────────────────────────────────────────────

async function runScan(
    context: LLMFacadeContext,
    html: string,
    slideCount: number,
    pass: 'fast' | 'deep',
    signal?: AbortSignal
): Promise<Result<QualityScanResult>> {
    if (signal?.aborted) return err('Aborted');

    // H5/H11 fix: sampleLargeDeck returns SampledDeck (with indexMap) or plain string
    const sampled = sampleLargeDeck(html, slideCount);
    const scannedHtml = typeof sampled === 'string' ? sampled : sampled.html;
    const indexMap = typeof sampled === 'string' ? null : sampled.indexMap;

    const prompt = pass === 'fast'
        ? buildFastScanPrompt(scannedHtml, slideCount)
        : buildDeepScanPrompt(scannedHtml, slideCount);

    const tokenBudget = pass === 'fast' ? FAST_SCAN_TOKEN_BUDGET : DEEP_SCAN_TOKEN_BUDGET;

    try {
        const result = await summarizeText(context, prompt, {
            maxTokens: tokenBudget,
            signal, // M6/M24 fix: forward AbortSignal
        });

        if (signal?.aborted) return err('Aborted');

        if (!result.success || !result.content) {
            // H12 fix: fail-closed — return err so callers know the scan did not run
            logger.warn('PresentationQuality', `${pass} scan LLM call failed: ${result.error}`);
            return err(`Quality ${pass} scan unavailable: ${result.error ?? 'LLM returned empty response'}`);
        }

        // H3/M9 fix: parseFindings returns null when response cannot be parsed as valid JSON.
        // Treat that as scan-unavailable (fail-closed) rather than silently returning no findings.
        const findings = parseFindings(result.content);
        if (findings === null) {
            logger.warn('PresentationQuality', `${pass} scan returned unparseable response`);
            return err(`Quality ${pass} scan unavailable: LLM returned invalid JSON`);
        }

        // H11 fix: translate sampled slideIndex back to original deck position
        let translatedFindings = findings;
        if (indexMap) {
            translatedFindings = findings.map(f => {
                if (f.slideIndex !== undefined && f.slideIndex < indexMap.length) {
                    return { ...f, slideIndex: indexMap[f.slideIndex] };
                }
                return f;
            });
        }

        logger.debug('PresentationQuality', `${pass} scan found ${translatedFindings.length} issue(s)`);
        return ok({ findings: translatedFindings, pass });
    } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        logger.error('PresentationQuality', `${pass} scan failed: ${msg}`);
        return err(`Quality ${pass} scan: ${msg}`);
    }
}

/**
 * Parse LLM response into findings.
 * Returns null when the response cannot be parsed as structured JSON (signals scan failure).
 * Returns empty array when parsed successfully but no findings were reported (clean deck).
 */
function parseFindings(content: string): QualityFinding[] | null {
    const parsed = tryExtractJson(content);
    if (!parsed || typeof parsed !== 'object') return null;

    const obj = parsed as Record<string, unknown>;
    const rawFindings = Array.isArray(obj.findings) ? obj.findings : [];
    const findings: QualityFinding[] = [];

    for (const raw of rawFindings) {
        if (!raw || typeof raw !== 'object') continue;
        const f = raw as Record<string, unknown>;

        // Required fields
        if (typeof f.issue !== 'string' || typeof f.suggestion !== 'string') continue;
        if (typeof f.severity !== 'string' || !VALID_SEVERITIES.has(f.severity)) continue;

        const finding: QualityFinding = {
            issue: f.issue,
            suggestion: f.suggestion,
            severity: f.severity as FindingSeverity,
        };

        // Optional fields
        if (typeof f.slideIndex === 'number' && Number.isInteger(f.slideIndex) && f.slideIndex >= 0) {
            finding.slideIndex = f.slideIndex;
        }
        if (typeof f.category === 'string' && VALID_CATEGORIES.has(f.category)) {
            finding.category = f.category as QualityFindingCategory;
        }

        findings.push(finding);
    }

    return findings;
}

function findingKey(f: QualityFinding): string {
    const slideKey = f.slideIndex === undefined ? '*' : String(f.slideIndex);
    const categoryKey = f.category || 'unknown';
    const issueKey = f.issue.toLowerCase().slice(0, 80);
    return `${slideKey}:${categoryKey}:${issueKey}`;
}
