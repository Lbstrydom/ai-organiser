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
}

const DEFAULT_TIMEOUT_MS = 180_000;

interface StoryboardCallOpts {
    timeoutMs: number;
    signal?: AbortSignal;
    label: string;
    onRetryStatus?: (seconds: number) => void;
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
        case 'waterfall': {
            // Fallback (no native waterfall until Cluster C): bars for base + deltas.
            // Bar length is magnitude-only; the label keeps the signed value so a
            // negative delta isn't rendered as a positive bar (audit H11).
            const all = capWarn([v.base, ...v.deltas], MAX_BARS, 'waterfall steps');
            const max = Math.max(1, ...all.map((d) => Math.abs(d.value)));
            return {
                kind: 'bar-chart',
                bars: all.map((d, idx) => ({ label: `${d.label} (${fmtValue(d.value, v.unit, idx > 0)})`, pct: clampPct((Math.abs(d.value) / max) * 100) })),
                ...(v.unit ? { axisLabel: v.unit } : {}),
            };
        }
        case 'line':
            // Fallback (no native line until Cluster C): a table of points.
            return {
                kind: 'table',
                headers: ['Series', 'x', 'y'],
                rows: capWarn(v.series.flatMap((s) => s.points.map((p) => [s.label, p.x, String(p.y)])), MAX_TABLE_ROWS_OUT, 'line points'),
            };
        case '2x2':
            // Fallback (no native 2x2 until Cluster C): item × quadrant table.
            return {
                kind: 'table',
                headers: ['Item', `${v.y_axis.label} / ${v.x_axis.label}`],
                rows: v.items.slice(0, 12).map((it) => [it.label, quadrantLabel(it.quadrant, v)]),
            };
        case 'pyramid':
            // Fallback (no native pyramid until Cluster C): ordered bullets top→bottom.
            return { kind: 'bullets', ordered: true, items: v.levels.map((l) => (l.detail ? `${l.label} — ${l.detail}` : l.label)) };
        case 'harvey':
            return {
                kind: 'table',
                headers: ['', ...v.columns.slice(0, 7)],
                rows: v.rows.slice(0, 12).map((row) => [row.label, ...row.ratings.slice(0, v.columns.length).map(harveyGlyphs)]),
            };
        default:
            return null; // 'bullets' | 'stat-grid' | 'process-flow' | 'none' → carried by core_message paragraph
    }
}

function quadrantLabel(q: 'tl' | 'tr' | 'bl' | 'br', v: Extract<VisualData, { type: '2x2' }>): string {
    const yHi = q === 'tl' || q === 'tr';
    const xHi = q === 'tr' || q === 'br';
    return `${v.y_axis.label}: ${yHi ? v.y_axis.high_label : v.y_axis.low_label}; ${v.x_axis.label}: ${xHi ? v.x_axis.high_label : v.x_axis.low_label}`;
}

function slideToIr(slide: StoryboardSlide): SlideIr {
    const blocks: Block[] = [];
    // Supporting line first (Gestalt: title carries the message, body supports).
    if (slide.core_message && slide.core_message !== slide.action_title) {
        blocks.push({ kind: 'paragraph', text: slide.core_message });
    }
    const visual = visualDataToBlock(slide.visual_data);
    if (visual) blocks.push(visual);
    return { id: slide.id, type: 'content', title: slide.action_title, blocks };
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
