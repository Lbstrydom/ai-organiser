/**
 * Storyboard service (plan Cluster A): the ONE message-deciding LLM pass
 * (`generateStoryboard`) + the DETERMINISTIC `storyboard -> SlideDeckIr`
 * translator. The translator is pure code — it cannot re-decide the message; it
 * faithfully maps the storyboard's action titles + typed visual_data to IR
 * blocks. Phase 1 maps to the EXISTING block kinds; visuals whose native block
 * lands in Cluster C (waterfall/line/pyramid/2x2/harvey) fall back to
 * bar/table/bullets until then (plan H1) — never references a missing renderer.
 */
import type { Result } from '../../core/result';
import { ok, err } from '../../core/result';
import type { LLMFacadeContext } from '../llmFacade';
import { summarizeText } from '../llmFacade';
import { logger } from '../../utils/logger';
import { IR_SCHEMA_VERSION } from './slideIr';
import type { SlideDeckIr, SlideIr, Block } from './slideIr';
import { validateDeckIr } from './slideIr';
import type { ConsultantStoryboard, EvidenceSpan, StoryboardSlide, VisualData } from './consultantStoryboard';
import { parseStoryboardFromResponse } from './consultantStoryboard';
import { buildStoryboardPrompt, buildStoryboardRepairPrompt, buildStoryboardRevisionPrompt } from './storyboardPrompts';
import type { StorylineComment } from './storyboardPrompts';

export interface GenerateStoryboardOptions {
    outputLanguage?: string;
    targetLength?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    onRetryStatus?: (seconds: number) => void;
    /** Model override for a SAME-provider role (Cluster B); '' / undefined = configured main model. */
    modelOverride?: string;
}

const DEFAULT_TIMEOUT_MS = 180_000;

interface StoryboardCallOpts {
    timeoutMs: number;
    signal?: AbortSignal;
    label: string;
    onRetryStatus?: (seconds: number) => void;
    modelOverride?: string;
}

/** Shared LLM-call: send the prompt → parse → 1 repair on validation failure. */
async function runStoryboardLLM(
    context: LLMFacadeContext,
    systemPrompt: string,
    callOpts: StoryboardCallOpts,
): Promise<Result<ConsultantStoryboard>> {
    try {
        const first = await summarizeText(context, systemPrompt, callOpts);
        if (callOpts.signal?.aborted) return err('Aborted');
        if (!first.success || !first.content) return err(first.error || 'storyboard: empty LLM response');

        const parsed = parseStoryboardFromResponse(first.content);
        if (parsed.ok) return parsed;

        if (callOpts.signal?.aborted) return err('Aborted');
        logger.warn('Presentation', `storyboard validation failed, repairing: ${parsed.error}`);
        const retry = await summarizeText(context, `${systemPrompt}\n\n${buildStoryboardRepairPrompt(first.content, parsed.error)}`, callOpts);
        if (callOpts.signal?.aborted) return err('Aborted');
        if (!retry.success || !retry.content) return err(parsed.error);
        return parseStoryboardFromResponse(retry.content);
    } catch (e) {
        return err(e instanceof Error ? e.message : 'storyboard: unknown error');
    }
}

function toCallOpts(label: string, options: GenerateStoryboardOptions): StoryboardCallOpts {
    return {
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal: options.signal,
        label,
        onRetryStatus: options.onRetryStatus,
        ...(options.modelOverride ? { modelOverride: options.modelOverride } : {}),
    };
}

/**
 * Generate a ConsultantStoryboard from the user's brief + the evidence catalog.
 * Mirrors `generateDeckIr`: LLM call → parse → 1 repair on validation failure.
 */
export async function generateStoryboard(
    context: LLMFacadeContext,
    userBrief: string,
    catalog: readonly EvidenceSpan[],
    options: GenerateStoryboardOptions = {},
): Promise<Result<ConsultantStoryboard>> {
    const systemPrompt = buildStoryboardPrompt(userBrief, catalog, {
        outputLanguage: options.outputLanguage,
        targetLength: options.targetLength,
    });
    return runStoryboardLLM(context, systemPrompt, toCallOpts('presentation-storyboard', options));
}

/**
 * Conversationally revise the CURRENT storyboard with the user's request + any
 * reviewer comments, re-supplying the catalog so revisions stay grounded.
 */
export async function generateRevisedStoryboard(
    context: LLMFacadeContext,
    current: ConsultantStoryboard,
    request: string,
    comments: readonly StorylineComment[],
    catalog: readonly EvidenceSpan[],
    options: GenerateStoryboardOptions = {},
): Promise<Result<ConsultantStoryboard>> {
    const systemPrompt = buildStoryboardRevisionPrompt(JSON.stringify(current), request, comments, catalog, {
        outputLanguage: options.outputLanguage,
    });
    return runStoryboardLLM(context, systemPrompt, toCallOpts('presentation-storyboard-revise', options));
}

// ── Deterministic translation: visual_data -> IR Block ───────────────────────

function clampPct(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
}

const HARVEY_FILLED = '●';
const HARVEY_EMPTY = '○';
function harveyGlyphs(rating: number): string {
    const r = Math.max(0, Math.min(4, Math.round(rating)));
    return HARVEY_FILLED.repeat(r) + HARVEY_EMPTY.repeat(4 - r);
}

const MAX_BARS = 12;          // bar-chart readability cap
const MAX_TABLE_ROWS_OUT = 20; // per-slide table cap (IR allows more, but a slide of 200 rows is unreadable)

/**
 * Format a numeric value WITH its unit + (optionally) sign so the bar-chart
 * fallback doesn't drop the raw number / direction (audit H8/H11) — the bar
 * length is magnitude-only (`pct`), but the LABEL keeps "EMEA (+20 €m)".
 */
function fmtValue(value: number, unit?: string, signed = false): string {
    const sign = signed && value > 0 ? '+' : '';
    const u = unit === '%' ? '%' : unit ? ` ${unit}` : '';
    return `${sign}${value}${u}`;
}

/** Cap an array to `max`, logging (not silently dropping) when it truncates (audit M6). */
function capWarn<T>(arr: readonly T[], max: number, what: string): T[] {
    if (arr.length > max) logger.warn('Presentation', `storyboard→IR: truncated ${arr.length} ${what} to ${max}`);
    return arr.slice(0, max);
}

/** Map a typed visual_data to a single IR block (Phase-1 existing kinds + H1 fallbacks). */
export function visualDataToBlock(v: VisualData): Block | null {
    switch (v.type) {
        case 'bar': {
            const items = capWarn(v.items, MAX_BARS, 'bar items');
            const max = Math.max(1, ...items.map((i) => Math.abs(i.value)));
            return {
                kind: 'bar-chart',
                bars: items.map((i) => ({ label: `${i.label} (${fmtValue(i.value, v.unit)})`, pct: clampPct((Math.abs(i.value) / max) * 100) })),
                ...(v.unit ? { axisLabel: v.unit } : {}),
            };
        }
        case 'table':
            return {
                kind: 'table',
                headers: v.columns.slice(0, 8),
                rows: capWarn(v.rows, MAX_TABLE_ROWS_OUT, 'table rows').map((r) => r.cells.slice(0, 8).map((c) => c.value ?? c.text)),
            };
        case 'waterfall':
            // Cluster C: native waterfall block (HTML bridge bars / PPTX shapes).
            return {
                kind: 'waterfall',
                base: { label: v.base.label, value: v.base.value },
                deltas: capWarn(v.deltas, 10, 'waterfall deltas').map((d) => ({ label: d.label, value: d.value })),
                ...(v.total ? { total: { label: v.total.label } } : {}),
                ...(v.unit ? { unit: v.unit } : {}),
            };
        case 'line':
            // Cluster C: native line-chart block (HTML SVG polyline / PPTX line chart).
            return {
                kind: 'line-chart',
                series: capWarn(v.series, 4, 'line series').map((sr) => ({
                    label: sr.label,
                    points: capWarn(sr.points, 20, 'line points').map((p) => ({ x: p.x, y: p.y })),
                })),
                ...(v.series[0]?.unit ? { unit: v.series[0].unit } : {}),
            };
        case '2x2': {
            // Cluster C: a 3×3 styled matrix table — header row = x-axis labels, first
            // column = y-axis labels, the 4 data cells = quadrant regions.
            const byQuadrant = (q: 'tl' | 'tr' | 'bl' | 'br') => v.items.filter((it) => it.quadrant === q).map((it) => it.label).join(', ') || '—';
            return {
                kind: 'table',
                style: 'matrix-2x2',
                headers: [`${v.y_axis.label} / ${v.x_axis.label}`, v.x_axis.low_label, v.x_axis.high_label],
                rows: [
                    [v.y_axis.high_label, byQuadrant('tl'), byQuadrant('tr')],
                    [v.y_axis.low_label, byQuadrant('bl'), byQuadrant('br')],
                ],
            };
        }
        case 'pyramid':
            // Cluster C: native pyramid block (stacked levels).
            return {
                kind: 'pyramid',
                levels: capWarn(v.levels, 6, 'pyramid levels').map((l) => ({ label: l.label, ...(l.detail ? { detail: l.detail } : {}) })),
            };
        case 'harvey': {
            // Cap columns ONCE so headers and every row's rating cells stay the same
            // width (audit M5 — was headers→7 but ratings→columns.length).
            const cols = v.columns.slice(0, 7);
            return {
                kind: 'table',
                style: 'rating', // Cluster C: renderers add a visually-hidden a11y text alternative
                // First header must be non-empty ('text' is min(1), else validateDeckIr
                // rejects the whole deck — latent since Cluster A, caught by the Cluster C test).
                headers: ['Option', ...cols],
                rows: capWarn(v.rows, MAX_TABLE_ROWS_OUT, 'harvey rows').map((row) => [row.label, ...row.ratings.slice(0, cols.length).map(harveyGlyphs)]),
            };
        }
        default:
            return null; // 'bullets' | 'stat-grid' | 'process-flow' | 'none' → carried by core_message paragraph
    }
}

function slideToIr(slide: StoryboardSlide): SlideIr {
    const blocks: Block[] = [];
    // Supporting line first (Gestalt: title carries the message, body supports).
    if (slide.core_message && slide.core_message !== slide.action_title) {
        blocks.push({ kind: 'paragraph', text: slide.core_message });
    }
    const visual = visualDataToBlock(slide.visual_data);
    if (visual) blocks.push(visual);
    // Provenance (Cluster C): renderers can surface the action title; audits/repair
    // trace a rendered slide back to its storyboard origin.
    return { id: slide.id, type: 'content', title: slide.action_title, blocks, action_title: slide.action_title, storyboard_slide_id: slide.id };
}

/**
 * DETERMINISTIC translate: ConsultantStoryboard -> SlideDeckIr. Pure; introduces
 * no new numbers. A title slide (the deck thesis) precedes the content slides.
 * Returns `Result` — `validateDeckIr` is the final gate (so a malformed mapping
 * surfaces as an err, never a broken render).
 */
export function translateStoryboardToIr(storyboard: ConsultantStoryboard): Result<SlideDeckIr> {
    // Pick a title-slide id that can't collide with a storyboard slide id (audit M4).
    const usedIds = new Set(storyboard.slides.map((s) => s.id));
    let titleId = 'title';
    for (let n = 1; usedIds.has(titleId); n++) titleId = `title_${n}`;
    const titleSlide: SlideIr = { id: titleId, type: 'title', title: storyboard.thesis, blocks: [] };
    const content = storyboard.slides.map(slideToIr);
    const deck: SlideDeckIr = { schemaVersion: IR_SCHEMA_VERSION, slides: [titleSlide, ...content] };
    return validateDeckIr(deck);
}

export { ok, err };
