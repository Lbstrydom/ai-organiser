/**
 * Rich Slide JSON — structured representation of a presentation slide that
 * preserves layout intent (headings, lists, tables, stat-cards, two-column
 * regions, images, speaker notes) for high-fidelity PPTX rendering.
 *
 * Upstream: `htmlToRichSlideParser` (DOM → RichSlideJSON[])
 * Downstream: `richPptxRenderer` (RichSlideJSON[] → pptxgenjs)
 *
 * Phase 2 of the sister-repo backport (`docs/plans/sister-backport-impl.md`).
 */

/** Discriminated union — every element knows its own rendering rules. */
export type SlideElement =
    | { kind: 'text'; content: string; level: 'h1' | 'h2' | 'h3' | 'body' | 'caption' }
    | { kind: 'list'; items: string[]; ordered: boolean }
    | { kind: 'table'; headers: string[]; rows: string[][] }
    | { kind: 'stat-card'; label: string; value: string; icon?: string }
    | { kind: 'image'; src: string; alt?: string }
    | { kind: 'spacer' };

/** Slide type drives template choice in the renderer. */
export type SlideType = 'title' | 'section' | 'content' | 'closing';

/** Layout override — multi-column decks preserve column arrangement. */
export type SlideLayout = 'single' | 'two-column' | 'stats-grid';

export interface RichSlideJSON {
    index: number;
    type: SlideType;
    title?: string;
    subtitle?: string;
    elements: SlideElement[];
    /** Left-column elements when `layout === 'two-column'`. `elements` holds
     *  right-column content in that case; if only `elements` is populated,
     *  it's treated as single-column content regardless of layout hint. */
    leftColumn?: SlideElement[];
    speakerNotes?: string;
    layout?: SlideLayout;
}

/**
 * Type guard — validates the structural shape of `RichSlideJSON[]` at runtime.
 * Used by callers that cross an I/O boundary (e.g. deserialising a saved
 * artifact). Returns a discriminant rather than throwing so the renderer can
 * fall back cleanly.
 */
export function isRichSlideArray(value: unknown): value is RichSlideJSON[] {
    if (!Array.isArray(value)) return false;
    return value.every(isRichSlide);
}

function isRichSlide(value: unknown): value is RichSlideJSON {
    if (!value || typeof value !== 'object') return false;
    const s = value as Partial<RichSlideJSON>;
    if (typeof s.index !== 'number') return false;
    if (s.type !== 'title' && s.type !== 'section' && s.type !== 'content' && s.type !== 'closing') return false;
    if (!Array.isArray(s.elements)) return false;
    return s.elements.every(isSlideElement);
}

function isSlideElement(value: unknown): value is SlideElement {
    if (!value || typeof value !== 'object') return false;
    const e = value as { kind?: unknown };
    switch (e.kind) {
        case 'text':
        case 'list':
        case 'table':
        case 'stat-card':
        case 'image':
        case 'spacer':
            return true;
        default:
            return false;
    }
}
