/**
 * Slide IR — the typed, Zod-validated intermediate representation that is the
 * SINGLE SOURCE OF TRUTH for a presentation deck.
 *
 * Two deterministic renderers consume it: `irToHtml` (preview) and `irToPptx`
 * (export). Nothing parses HTML. Adding a new block kind = one schema variant
 * here + one render case in each renderer (#7 strategy-over-switch).
 *
 * Pure module — no Obsidian dependencies. Validated with `validateDeckIr`,
 * which returns `Result<T>` rather than throwing so callers at the LLM I/O
 * boundary can fall back cleanly (#11, #12).
 *
 * Cross-field invariants that can't live inside a discriminated-union member
 * (table row width, custom html/image presence, unique slide ids) are enforced
 * in the deck-level `superRefine` — keeping every union member a plain
 * `ZodObject` so `z.discriminatedUnion` accepts them.
 *
 * Plan: docs/plans/presentation-structured-ir.md
 */

import { z } from 'zod';
import type { Result } from '../../core/result';
import { ok, err } from '../../core/result';

/** Bumped only on a breaking schema change. */
export const IR_SCHEMA_VERSION = 1;

// ── Size caps (memory / mobile safety — plan M3) ─────────────────────────────
const MAX_TEXT = 2_048;            // heading / paragraph / label / cell text
const MAX_SVG = 64 * 1_024;        // raw <svg> markup
const MAX_CUSTOM_HTML = 32 * 1_024;
const MAX_DATA_URI = 2_700_000;    // ≈ 2 MB binary, base64-encoded
const MAX_SLIDES = 60;
const MAX_BLOCKS_PER_SLIDE = 12;
const MAX_TABLE_ROWS = 200;
const MAX_DECK_BYTES = 12 * 1_024 * 1_024;

/** Raster image data-URIs only. `image/svg+xml` is intentionally excluded —
 *  it can carry scripts (plan H1). Vector SVG goes through the `svg` block.
 *  Anchored end + strict base64 charset (Gemini G1) so trailing junk (e.g. an
 *  injected `<svg onload=…>` after the comma) can't pass the prefix check. */
const RASTER_DATA_URI = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/i;
/** 6-digit hex, optional leading `#`. Constrains IR colour fields so invalid
 *  values can't reach inline CSS / pptxgenjs (audit H3/M13). */
const HEX_COLOR = /^#?[0-9a-fA-F]{6}$/;

const text = z.string().min(1).max(MAX_TEXT);

/** UTF-8 byte length — string `.length` undercounts multi-byte content (M3). */
function utf8Bytes(value: unknown): number {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : s.length;
}

// ── Leaf blocks (everything except two-column) — all plain ZodObject ─────────

// `.strict()` rejects unknown keys so a renamed/hallucinated LLM field
// surfaces as a validation error (→ repair/fallback) instead of being
// silently stripped (audit M7).
const headingBlock = z.object({
    kind: z.literal('heading'),
    text,
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
}).strict();

const paragraphBlock = z.object({
    kind: z.literal('paragraph'),
    text,
    emphasis: z.boolean().optional(),
}).strict();

const bulletsBlock = z.object({
    kind: z.literal('bullets'),
    items: z.array(text).min(1).max(MAX_BLOCKS_PER_SLIDE),
    ordered: z.boolean().optional(),
}).strict();

const statGridBlock = z.object({
    kind: z.literal('stat-grid'),
    cards: z.array(z.object({
        value: text,
        label: text,
        icon: z.string().max(64).optional(),
    }).strict()).min(1).max(6),
}).strict();

const barChartBlock = z.object({
    kind: z.literal('bar-chart'),
    bars: z.array(z.object({
        label: text,
        pct: z.number().min(0).max(100),
        color: z.string().regex(HEX_COLOR, 'color must be a 6-digit hex').optional(),
    }).strict()).min(1).max(12),
    caption: text.optional(),
}).strict();

const processFlowBlock = z.object({
    kind: z.literal('process-flow'),
    steps: z.array(z.object({
        title: text,
        sub: text.optional(),
    }).strict()).min(2).max(8),
}).strict();

const tableBlock = z.object({
    kind: z.literal('table'),
    headers: z.array(text).min(1).max(8),
    rows: z.array(z.array(text)).min(1).max(MAX_TABLE_ROWS),
    caption: text.optional(),
}).strict();

const imageBlock = z.object({
    kind: z.literal('image'),
    dataUri: z.string().max(MAX_DATA_URI).regex(RASTER_DATA_URI, 'image must be a raster data:image/* URI'),
    alt: z.string().max(MAX_TEXT).optional(),
}).strict();

const svgBlock = z.object({
    kind: z.literal('svg'),
    svg: z.string().min(1).max(MAX_SVG),
    alt: z.string().max(MAX_TEXT).optional(),
}).strict();

const calloutBlock = z.object({
    kind: z.literal('callout'),
    text,
    cite: text.optional(),
    variant: z.union([z.literal('info'), z.literal('warn')]).optional(),
}).strict();

const captionBlock = z.object({
    kind: z.literal('caption'),
    text,
}).strict();

const customBlock = z.object({
    kind: z.literal('custom'),
    html: z.string().max(MAX_CUSTOM_HTML).optional(),
    image: z.string().max(MAX_DATA_URI).regex(RASTER_DATA_URI, 'custom.image must be a raster data:image/* URI').optional(),
    fallbackText: text.optional(),
}).strict();

/** Leaf variants — usable inside a two-column block (no nested columns). */
const LEAF_MEMBERS = [
    headingBlock, paragraphBlock, bulletsBlock, statGridBlock, barChartBlock,
    processFlowBlock, tableBlock, imageBlock, svgBlock, calloutBlock,
    captionBlock, customBlock,
] as const;

export const LeafBlockSchema = z.discriminatedUnion('kind', LEAF_MEMBERS);

const twoColumnBlock = z.object({
    kind: z.literal('two-column'),
    left: z.array(LeafBlockSchema).max(MAX_BLOCKS_PER_SLIDE),
    right: z.array(LeafBlockSchema).max(MAX_BLOCKS_PER_SLIDE),
}).strict();

export const BlockSchema = z.discriminatedUnion('kind', [...LEAF_MEMBERS, twoColumnBlock]);

export const SlideTypeSchema = z.union([
    z.literal('title'), z.literal('section'), z.literal('content'), z.literal('closing'),
]);

export const SlideIrSchema = z.object({
    id: z.string().min(1).max(64),
    type: SlideTypeSchema,
    title: text.optional(),
    subtitle: text.optional(),
    blocks: z.array(BlockSchema).max(MAX_BLOCKS_PER_SLIDE),
    notes: z.string().max(8_192).optional(),
}).strict();

export const SlideDeckIrSchema = z.object({
    schemaVersion: z.literal(IR_SCHEMA_VERSION),
    title: text.optional(),
    slides: z.array(SlideIrSchema).min(1).max(MAX_SLIDES),
}).strict().superRefine((deck, ctx) => {
    // Deck-size cap enforced at the schema level too (G4) so callers using the
    // schema directly (not just validateDeckIr) get the bound.
    if (utf8Bytes(deck) > MAX_DECK_BYTES) {
        ctx.addIssue({ code: 'custom', message: `deck exceeds ${MAX_DECK_BYTES} byte cap`, path: [] });
    }
    const seen = new Set<string>();
    deck.slides.forEach((s, si) => {
        // Unique slide ids (plan M6).
        if (seen.has(s.id)) {
            ctx.addIssue({ code: 'custom', message: `duplicate slide id "${s.id}"`, path: ['slides', si, 'id'] });
        }
        seen.add(s.id);
        // Non-content slide types (title/section/closing) use title+subtitle
        // only; blocks on them would be silently dropped by the renderers, so
        // reject them at validation instead (audit H6).
        if (s.type !== 'content' && s.blocks.length > 0) {
            ctx.addIssue({ code: 'custom', message: `${s.type} slide must have no blocks (use a content slide)`, path: ['slides', si, 'blocks'] });
        }
        s.blocks.forEach((b, bi) => checkBlock(b, ctx, ['slides', si, 'blocks', bi]));
    });
});

/** Cross-field block checks that can't live inside a union member (M6). */
function checkBlock(block: unknown, ctx: z.RefinementCtx, path: (string | number)[]): void {
    if (!block || typeof block !== 'object') return;
    const b = block as { kind?: string; headers?: unknown[]; rows?: unknown[][]; html?: unknown; image?: unknown; left?: unknown[]; right?: unknown[] };
    if (b.kind === 'table' && Array.isArray(b.headers) && Array.isArray(b.rows)) {
        b.rows.forEach((row, i) => {
            if (Array.isArray(row) && row.length !== b.headers!.length) {
                ctx.addIssue({
                    code: 'custom',
                    message: `table row ${i} has ${row.length} cells but ${b.headers!.length} headers`,
                    path: [...path, 'rows', i],
                });
            }
        });
    }
    if (b.kind === 'custom' && !b.html && !b.image) {
        ctx.addIssue({ code: 'custom', message: 'custom block requires at least one of `html` or `image`', path });
    }
    if (b.kind === 'two-column') {
        (b.left ?? []).forEach((c, i) => checkBlock(c, ctx, [...path, 'left', i]));
        (b.right ?? []).forEach((c, i) => checkBlock(c, ctx, [...path, 'right', i]));
    }
}

// ── Inferred types ───────────────────────────────────────────────────────────

export type LeafBlock = z.infer<typeof LeafBlockSchema>;
export type Block = z.infer<typeof BlockSchema>;
export type SlideType = z.infer<typeof SlideTypeSchema>;
export type SlideIr = z.infer<typeof SlideIrSchema>;
export type SlideDeckIr = z.infer<typeof SlideDeckIrSchema>;

/** A per-block downgrade surfaced by either renderer (plan H3/M2). */
export interface FidelityNotice {
    slideIndex: number;
    blockKind: Block['kind'];
    severity: 'info' | 'substantive';
    description: string;
}

/**
 * Validate an untrusted value as a `SlideDeckIr`. Returns `Result` (never
 * throws) so the LLM-boundary caller can fall back to the legacy HTML path.
 * Enforces the deck-byte cap before schema work to bound memory (plan M3).
 *
 * SECURITY CONTRACT (audit H3): this is **structural** validation only — it
 * checks shape, caps, and field formats, and intentionally permits raw `svg`
 * markup / `custom.html` (their presence is structurally valid). **Content
 * sanitization is owned by the renderers**, which is where the trust boundary
 * sits: `irToHtml` runs `sanitizeSvgMarkup` on every `svg` block + strips
 * dangerous markup from `custom.html`, and its output additionally re-enters
 * the central `sanitizePresentation` allowlist at the service before reaching
 * the preview; `irToPptx` embeds only sanitized SVG and never executes
 * `custom.html` (it rasterizes/placeholders). A validated deck is therefore
 * NOT "safe to inject" on its own — render it through the IR renderers.
 */
export function validateDeckIr(value: unknown): Result<SlideDeckIr> {
    let bytes: number;
    try {
        bytes = utf8Bytes(value);
    } catch {
        return err('deck is not serializable');
    }
    if (bytes > MAX_DECK_BYTES) {
        return err(`deck exceeds ${MAX_DECK_BYTES} byte cap (${bytes})`);
    }
    const parsed = SlideDeckIrSchema.safeParse(value);
    if (!parsed.success) {
        const first = parsed.error.issues[0];
        const path = first?.path?.join('.') ?? '';
        return err(`invalid deck IR${path ? ` at ${path}` : ''}: ${first?.message ?? 'unknown'}`);
    }
    return ok(parsed.data);
}
