/**
 * ConsultantStoryboard — the SEMANTIC layer above the presentational `SlideDeckIr`
 * (plan: consultant-quality-slides, Cluster A). This is the "ghost deck" / dot-dash:
 * the deck thesis + per-slide so-what action titles, MECE roles, evidence bindings,
 * and a typed `visual_data` payload. It is the SINGLE source of truth for message +
 * structure; the renderer (`translateStoryboardToIr`) is a faithful translator that
 * cannot re-decide the message.
 *
 * Every quantified value carries its `evidence_span_id` (grounding validates chart
 * data, not just titles). `visual_data.type` === `suggested_visual` (a refine), so the
 * declared visual and its payload can never disagree.
 *
 * Mirrors slideIr.ts conventions: `.strict()` objects (a hallucinated field → a
 * validation error → repair/fallback, never silent strip) + `z.infer` exports +
 * a `parse…FromResponse(): Result<T>` boundary.
 */
import { z } from 'zod';
import type { Result } from '../../core/result';
import { ok, err } from '../../core/result';
import { tryExtractJson } from '../../utils/responseParser';

export const STORYBOARD_SCHEMA_VERSION = 1;

const MAX_TEXT = 800;     // labels / titles / cells — short by nature
const MAX_PROSE = 1500;   // core_message / thesis — the supporting paragraph
const MAX_SLIDES = 40;
const MAX_SERIES_POINTS = 30;

/** A bounded string that TRUNCATES at a word boundary (with an ellipsis) instead of
 *  HARD-FAILING the whole storyboard on a length overage. Consultant `core_message`s
 *  routinely run past a tight cap, and every repair re-emitted an equally long one —
 *  a hard `.max()` killed the ENTIRE generation (live 2026-06-08, `slides.N.core_message:
 *  Too big`). Truncation degrades one field gracefully instead. */
function boundedText(max: number) {
    return z.string().min(1).transform((s) => {
        if (s.length <= max) return s;
        const cut = s.slice(0, max).replace(/\s+\S*$/, '').trimEnd();
        return (cut || s.slice(0, max).trimEnd()) + '…';
    });
}
const text = boundedText(MAX_TEXT);
const prose = boundedText(MAX_PROSE);
const spanId = z.string().min(1).max(120);

// ── Evidence catalog ─────────────────────────────────────────────────────────
// Spans are DERIVED from the existing resolved-source pipeline (not invented).
// `char_range` is relative to the resolved source text; `source_ref` names the
// origin (file path / url). The generator must cite real `id`s — selfCheck rejects
// any `evidence_span_id` not in the catalog (no dangling refs).
export const evidenceSpanSchema = z.object({
    id: spanId,
    source_ref: z.string().min(1).max(512),
    text: z.string().min(1).max(4000),
    char_range: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional(),
    value: z.string().max(120).optional(),
}).strict();
export type EvidenceSpan = z.infer<typeof evidenceSpanSchema>;

// ── Slide roles (MECE storyline arc) ─────────────────────────────────────────
export const slideRoleSchema = z.enum(['context', 'problem', 'insight', 'recommendation', 'proof']);
export type SlideRole = z.infer<typeof slideRoleSchema>;

// ── Per-type visual_data payloads (§2a — the COMPLETE contract) ──────────────
// Each numeric value carries its evidence_span_id so grounding validates the data.
const num = z.number();

const lineVisual = z.object({
    type: z.literal('line'),
    series: z.array(z.object({
        label: text,
        unit: text.optional(),
        points: z.array(z.object({ x: text, y: num, evidence_span_id: spanId }).strict()).min(2).max(MAX_SERIES_POINTS),
    }).strict()).min(1).max(6),
}).strict();

const waterfallVisual = z.object({
    type: z.literal('waterfall'),
    unit: text.optional(),
    base: z.object({ label: text, value: num, evidence_span_id: spanId }).strict(),
    deltas: z.array(z.object({ label: text, value: num, evidence_span_id: spanId }).strict()).min(1).max(12),
    total: z.object({ label: text }).strict().optional(),
}).strict();

const axisSchema = z.object({ label: text, low_label: text, high_label: text }).strict();
const twoByTwoVisual = z.object({
    type: z.literal('2x2'),
    x_axis: axisSchema,
    y_axis: axisSchema,
    items: z.array(z.object({
        label: text,
        quadrant: z.enum(['tl', 'tr', 'bl', 'br']),
        evidence_span_id: spanId.optional(),
    }).strict()).min(1).max(16),
}).strict();

const pyramidVisual = z.object({
    type: z.literal('pyramid'),
    levels: z.array(z.object({ label: text, detail: text.optional() }).strict()).min(2).max(6),
}).strict();

const harveyVisual = z.object({
    type: z.literal('harvey'),
    columns: z.array(text).min(1).max(8),
    rows: z.array(z.object({
        label: text,
        ratings: z.array(z.number().int().min(0).max(4)).min(1).max(8),
        evidence_span_id: spanId.optional(),
    }).strict()).min(1).max(12),
}).strict();

const barVisual = z.object({
    type: z.literal('bar'),
    unit: text.optional(),
    items: z.array(z.object({ label: text, value: num, evidence_span_id: spanId }).strict()).min(1).max(12),
}).strict();

const tableVisual = z.object({
    type: z.literal('table'),
    columns: z.array(text).min(1).max(8),
    rows: z.array(z.object({
        cells: z.array(z.object({ text, value: text.optional(), evidence_span_id: spanId.optional() }).strict()).min(1).max(8),
    }).strict()).min(1).max(20),
}).strict();

// Visuals with no numeric payload (the storyboard still declares them; translation
// pulls their content from the slide's core_message / bullets).
const proseVisual = z.object({
    type: z.enum(['bullets', 'stat-grid', 'process-flow', 'none']),
}).strict();

export const visualDataSchema = z.discriminatedUnion('type', [
    lineVisual, waterfallVisual, twoByTwoVisual, pyramidVisual, harveyVisual, barVisual, tableVisual, proseVisual,
]);
export type VisualData = z.infer<typeof visualDataSchema>;

export const suggestedVisualSchema = z.enum([
    'line', 'waterfall', '2x2', 'pyramid', 'harvey', 'bar', 'table', 'bullets', 'stat-grid', 'process-flow', 'none',
]);
export type SuggestedVisual = z.infer<typeof suggestedVisualSchema>;

// ── Storyboard slide + deck ──────────────────────────────────────────────────
export const storyboardSlideSchema = z.object({
    id: z.string().min(1).max(80),
    role: slideRoleSchema,
    /** The so-what. Verb-bearing; quantified WHERE the data supports it; NOT a label. */
    action_title: text,
    core_message: prose,
    /** ids into the deck's evidence catalog backing the title's claims. */
    evidence_span_ids: z.array(spanId).max(40).default([]),
    suggested_visual: suggestedVisualSchema,
    visual_data: visualDataSchema,
}).strict().refine(
    (s) => s.suggested_visual === s.visual_data.type,
    { message: 'suggested_visual must equal visual_data.type', path: ['visual_data'] },
).superRefine((s, ctx) => {
    // Table/harvey rows must match their column count (consolidated gate MEDIUM) so a
    // ragged LLM table is rejected at the storyboard boundary, not silently padded later.
    const v = s.visual_data;
    if (v.type === 'table') {
        v.rows.forEach((r, i) => {
            if (r.cells.length !== v.columns.length) ctx.addIssue({ code: 'custom', message: `table row ${i} has ${r.cells.length} cells but ${v.columns.length} columns`, path: ['visual_data', 'rows', i] });
        });
    } else if (v.type === 'harvey') {
        v.rows.forEach((r, i) => {
            if (r.ratings.length !== v.columns.length) ctx.addIssue({ code: 'custom', message: `harvey row ${i} has ${r.ratings.length} ratings but ${v.columns.length} columns`, path: ['visual_data', 'rows', i] });
        });
    }
});
export type StoryboardSlide = z.infer<typeof storyboardSlideSchema>;

export const consultantStoryboardSchema = z.object({
    schemaVersion: z.literal(STORYBOARD_SCHEMA_VERSION).default(STORYBOARD_SCHEMA_VERSION),
    thesis: prose,
    sections: z.array(z.object({ label: text, slide_ids: z.array(z.string()).min(1) }).strict()).optional(),
    slides: z.array(storyboardSlideSchema).min(1).max(MAX_SLIDES),
}).strict().superRefine((sb, ctx) => {
    // M4/M15: slide ids must be unique, and every section slide_id must exist.
    const ids = new Set<string>();
    sb.slides.forEach((s, i) => {
        if (ids.has(s.id)) ctx.addIssue({ code: 'custom', message: `duplicate slide id "${s.id}"`, path: ['slides', i, 'id'] });
        ids.add(s.id);
    });
    sb.sections?.forEach((sec, si) => {
        sec.slide_ids.forEach((id, idi) => {
            if (!ids.has(id)) ctx.addIssue({ code: 'custom', message: `section references unknown slide id "${id}"`, path: ['sections', si, 'slide_ids', idi] });
        });
    });
});
export type ConsultantStoryboard = z.infer<typeof consultantStoryboardSchema>;

/** Zero-width chars (ZWSP/ZWNJ/ZWJ/BOM) never carry meaning in storyboard content
 *  and otherwise ACCUMULATE across revision cycles (Gemini-gate): the prompt builder
 *  defangs `<` with a ZWSP, the LLM copies unchanged slides verbatim, and the echoed
 *  ZWSP re-enters the stored storyboard → re-defanged next cycle. Strip them at the
 *  parse boundary so the in-memory storyboard + rendered deck stay clean. */
const ZERO_WIDTH_RE = /[​-‍﻿]/g;
function stripZeroWidthDeep(value: unknown): unknown {
    if (typeof value === 'string') return value.replace(ZERO_WIDTH_RE, '');
    if (Array.isArray(value)) return value.map(stripZeroWidthDeep);
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) out[k] = stripZeroWidthDeep(v);
        return out;
    }
    return value;
}

/** Validate an already-parsed object against the storyboard schema (e.g. a
 *  persisted snapshot being restored). Same strict Zod gate as the LLM parser. */
export function validateStoryboard(value: unknown): Result<ConsultantStoryboard> {
    const parsed = consultantStoryboardSchema.safeParse(stripZeroWidthDeep(value));
    if (!parsed.success) {
        const first = parsed.error.issues[0];
        return err(`storyboard: schema validation failed — ${first.path.join('.')}: ${first.message}`);
    }
    return ok(parsed.data);
}

/**
 * Parse + validate an LLM storyboard response. Mirrors `parseIrFromResponse`:
 * tolerant JSON extraction (direct → fence → object-search) then a strict Zod
 * gate. Returns `Result` — the caller repairs/falls back on `err`.
 */
export function parseStoryboardFromResponse(raw: string): Result<ConsultantStoryboard> {
    const extracted = tryExtractJson(raw);
    if (!extracted) return err('storyboard: no JSON object found in response');
    const parsed = consultantStoryboardSchema.safeParse(stripZeroWidthDeep(extracted));
    if (!parsed.success) {
        const first = parsed.error.issues[0];
        return err(`storyboard: schema validation failed — ${first.path.join('.')}: ${first.message}`);
    }
    return ok(parsed.data);
}
