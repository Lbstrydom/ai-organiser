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
import { tryExtractJson } from '../../utils/responseParser';
import { logger } from '../../utils/logger';

// ── Constants ──────────────────────────────────────────────────────────────

const FAST_SCAN_TOKEN_BUDGET = 4096;
const DEEP_SCAN_TOKEN_BUDGET = 8192;
const LARGE_DECK_THRESHOLD = 30;
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

/** For large decks (>30 slides), sample representative slides. Returns reduced HTML. */
export function sampleLargeDeck(html: string, slideCount: number): string {
    if (slideCount <= LARGE_DECK_THRESHOLD) return html;

    const slideRegex = /<div[^>]*class="[^"]*\bslide\b[^"]*"[^>]*>[\s\S]*?(?=<div[^>]*class="[^"]*\bslide\b|<\/div>\s*<\/div>\s*<\/body>|$)/g;
    const slides: { content: string; index: number }[] = [];
    let match: RegExpExecArray | null;
    let idx = 0;

    while ((match = slideRegex.exec(html)) !== null) {
        slides.push({ content: match[0], index: idx });
        idx++;
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
    const sampledSlides = sorted.map(i => slides[i].content);

    // Extract head/wrapper and rebuild
    const bodyStart = html.indexOf('<body');
    const prefix = bodyStart >= 0 ? html.slice(0, html.indexOf('>', bodyStart) + 1) : '';
    const suffix = '</body></html>';
    const deckOpen = '<div class="deck">';
    const deckClose = '</div>';

    return `${prefix}${deckOpen}${sampledSlides.join('\n')}${deckClose}${suffix}`;
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

    const scannedHtml = sampleLargeDeck(html, slideCount);
    const prompt = pass === 'fast'
        ? buildFastScanPrompt(scannedHtml, slideCount)
        : buildDeepScanPrompt(scannedHtml, slideCount);

    const tokenBudget = pass === 'fast' ? FAST_SCAN_TOKEN_BUDGET : DEEP_SCAN_TOKEN_BUDGET;

    try {
        const result = await summarizeText(context, prompt, {
            maxTokens: tokenBudget,
        });

        if (signal?.aborted) return err('Aborted');

        if (!result.success || !result.content) {
            logger.warn('PresentationQuality', `${pass} scan LLM call failed: ${result.error}`);
            return ok({ findings: [], pass });
        }

        const findings = parseFindings(result.content);
        logger.debug('PresentationQuality', `${pass} scan found ${findings.length} issue(s)`);
        return ok({ findings, pass });
    } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        logger.error('PresentationQuality', `${pass} scan failed: ${msg}`);
        return err(`Quality ${pass} scan: ${msg}`);
    }
}

function parseFindings(content: string): QualityFinding[] {
    const parsed = tryExtractJson(content);
    if (!parsed || typeof parsed !== 'object') return [];

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
    const slideKey = f.slideIndex !== undefined ? String(f.slideIndex) : '*';
    const categoryKey = f.category || 'unknown';
    const issueKey = f.issue.toLowerCase().slice(0, 80);
    return `${slideKey}:${categoryKey}:${issueKey}`;
}
