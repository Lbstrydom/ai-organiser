/**
 * Presentation structured-IR module — the single source of truth for a
 * presentation deck and its two deterministic renderers (IR→HTML, IR→PPTX).
 *
 * Self-contained + Obsidian-free so a sister team can port it wholesale.
 * Plan: docs/plans/presentation-structured-ir.md
 */

export {
    SlideDeckIrSchema, SlideIrSchema, BlockSchema, LeafBlockSchema, SlideTypeSchema,
    IR_SCHEMA_VERSION, validateDeckIr,
} from './slideIr';
export type {
    SlideDeckIr, SlideIr, Block, LeafBlock, SlideType, FidelityNotice,
} from './slideIr';

export { renderDeckToHtml } from './irToHtml';
export type { HtmlRenderOutput } from './irToHtml';

export { renderDeckToPptx } from './irToPptx';
export type { RenderPptxOptions, PptxRenderOutput, RasterizeFn } from './irToPptx';

export {
    CANVAS, CONTENT_WIDTH, CONTENT_HEIGHT, MARGIN, CONTENT_TOP, FOOTER_Y,
    splitColumns, gridColumns, estimateTextHeight, tableColumnWidths,
} from './irLayout';
