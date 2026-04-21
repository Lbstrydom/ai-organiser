/**
 * HTML → RichSlideJSON parser.
 *
 * Consumes a full presentation HTML document produced by the LLM + sanitizer
 * pipeline and extracts a structured `RichSlideJSON[]` array that preserves
 * layout intent (headings, bullets, tables, stat-cards, two-column regions,
 * images, speaker notes).
 *
 * Pure function — no Obsidian dependencies. Uses DOMParser from the hosting
 * environment (Obsidian supplies `window.DOMParser`; tests use `happy-dom`).
 *
 * Phase 2 of the sister-repo backport. Shares conventions with the existing
 * `extractSlideInfo()` in `presentationTypes.ts` (same `.slide`, `.slide-title`,
 * `.speaker-notes` class names) so decks generated today parse cleanly.
 */

import type {
    RichSlideJSON,
    SlideElement,
    SlideType,
    SlideLayout,
} from './richSlideTypes';

/** Parse the full deck HTML and return one `RichSlideJSON` per `section.slide`. */
export function htmlToRichSlides(html: string): RichSlideJSON[] {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const slides = Array.from(doc.querySelectorAll('section.slide, .slide'));
    return slides.map((slide, index) => parseSlide(slide, index));
}

function parseSlide(slide: Element, index: number): RichSlideJSON {
    const type = detectSlideType(slide);

    // Speaker notes live outside the renderable region.
    const notesEl = slide.querySelector('aside.speaker-notes, .speaker-notes');
    const speakerNotes = notesEl?.textContent?.trim() || undefined;

    // Remove notes from the DOM clone we walk so they don't leak into the
    // body extraction. Clone to avoid mutating caller-owned document.
    const working = slide.cloneNode(true) as Element;
    const notesInClone = working.querySelector('aside.speaker-notes, .speaker-notes');
    notesInClone?.remove();

    // Title / subtitle heuristics — first h1 acts as title, first h2 as subtitle
    // unless we already consumed the h1 (section + closing slides may omit h1).
    const title = firstText(working, 'h1') || firstText(working, 'h2') || undefined;
    let subtitle: string | undefined;
    if (title && firstText(working, 'h1')) {
        // title came from h1 — look for an h2 as subtitle
        subtitle = firstText(working, 'h2') || undefined;
    }

    // Layout detection: two-column container beats stats-grid beats single.
    const colContainer = working.querySelector('.col-container, .two-column, .columns');
    const statsGrid = working.querySelector('.stats-grid');
    let layout: SlideLayout = 'single';
    let elements: SlideElement[] = [];
    let leftColumn: SlideElement[] | undefined;

    if (colContainer) {
        layout = 'two-column';
        const cols = Array.from(colContainer.querySelectorAll(':scope > .col, :scope > .column'));
        const left = cols[0] ? extractElements(cols[0], { excludeHeadings: false }) : [];
        const right = cols[1] ? extractElements(cols[1], { excludeHeadings: false }) : [];
        leftColumn = left;
        elements = right;
    } else if (statsGrid) {
        layout = 'stats-grid';
        elements = Array.from(statsGrid.querySelectorAll('.stat-card')).map(toStatCard);
    } else {
        elements = extractElements(working, { excludeHeadings: true, excludeHeadingText: title });
    }

    return {
        index,
        type,
        title,
        subtitle,
        elements,
        leftColumn,
        speakerNotes,
        layout,
    };
}

function detectSlideType(slide: Element): SlideType {
    if (slide.classList.contains('slide-title')) return 'title';
    if (slide.classList.contains('slide-section')) return 'section';
    if (slide.classList.contains('slide-closing')) return 'closing';
    return 'content';
}

function firstText(root: Element, selector: string): string {
    const el = root.querySelector(selector);
    return el?.textContent?.trim() || '';
}

interface ExtractOptions {
    /** Skip h1 headings (consumed by the title slot). h2/h3 still kept. */
    excludeHeadings?: boolean;
    /** If provided, skip the first heading whose text matches. */
    excludeHeadingText?: string;
}

/** Walk direct + semi-direct children, emitting one SlideElement per block. */
function extractElements(root: Element, opts: ExtractOptions = {}): SlideElement[] {
    const out: SlideElement[] = [];
    let skipHeadingText = opts.excludeHeadingText;

    // Walk the flattened block-level children — we accept nested wrappers
    // (`<div>`, `<article>`) by recursing only when the node has no direct
    // rendering semantics.
    for (const child of walkBlockChildren(root)) {
        const tag = child.tagName.toLowerCase();

        if ((tag === 'h1' || tag === 'h2' || tag === 'h3')) {
            const text = child.textContent?.trim() || '';
            if (!text) continue;
            if (skipHeadingText && text === skipHeadingText) {
                skipHeadingText = undefined;
                continue;
            }
            if (tag === 'h1' && opts.excludeHeadings) continue;
            out.push({ kind: 'text', content: text, level: tag });
            continue;
        }

        if (tag === 'p') {
            const text = child.textContent?.trim() || '';
            if (text) out.push({ kind: 'text', content: text, level: 'body' });
            continue;
        }

        if (tag === 'ul' || tag === 'ol') {
            const items = Array.from(child.querySelectorAll(':scope > li'))
                .map(li => li.textContent?.trim() || '')
                .filter(s => s.length > 0);
            if (items.length > 0) {
                out.push({ kind: 'list', items, ordered: tag === 'ol' });
            }
            continue;
        }

        if (tag === 'table') {
            const table = toTable(child);
            if (table) out.push(table);
            continue;
        }

        if (child.classList.contains('stat-card')) {
            out.push(toStatCard(child));
            continue;
        }

        if (tag === 'img') {
            const src = child.getAttribute('src') || '';
            // Data URIs only — matches the presentation sanitizer allowlist.
            if (src.startsWith('data:image/')) {
                out.push({
                    kind: 'image',
                    src,
                    alt: child.getAttribute('alt') || undefined,
                });
            }
            continue;
        }

        if (tag === 'figure') {
            const img = child.querySelector('img');
            const figSrc = img?.getAttribute('src') || '';
            if (figSrc.startsWith('data:image/')) {
                out.push({
                    kind: 'image',
                    src: figSrc,
                    alt: img?.getAttribute('alt') || child.querySelector('figcaption')?.textContent?.trim() || undefined,
                });
            }
            continue;
        }

        if (tag === 'hr') {
            out.push({ kind: 'spacer' });
            continue;
        }

        // Caption / small text
        if (tag === 'small' || tag === 'em' || tag === 'i') {
            const text = child.textContent?.trim() || '';
            if (text) out.push({ kind: 'text', content: text, level: 'caption' });
            continue;
        }

        // Blockquote flattens to body text — pptxgenjs has no dedicated quote style.
        if (tag === 'blockquote') {
            const text = child.textContent?.trim() || '';
            if (text) out.push({ kind: 'text', content: text, level: 'body' });
            continue;
        }
    }

    return out;
}

/**
 * Yield each meaningful block child of a slide body, descending through
 * transparent wrappers (div/article/section without known semantics).
 */
function walkBlockChildren(root: Element): Element[] {
    const out: Element[] = [];
    for (const child of Array.from(root.children)) {
        if (isSemanticBlock(child)) {
            out.push(child);
        } else if (child.tagName.toLowerCase() === 'div' || child.tagName.toLowerCase() === 'article' || child.tagName.toLowerCase() === 'section') {
            // Transparent wrapper — descend.
            out.push(...walkBlockChildren(child));
        }
    }
    return out;
}

const SEMANTIC_TAGS = new Set([
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'ul', 'ol', 'table', 'img', 'figure', 'hr', 'blockquote',
    'small', 'em', 'i',
]);

function isSemanticBlock(el: Element): boolean {
    const tag = el.tagName.toLowerCase();
    if (SEMANTIC_TAGS.has(tag)) return true;
    if (el.classList.contains('stat-card')) return true;
    return false;
}

function toTable(el: Element): SlideElement | null {
    const headerRow = el.querySelector('thead tr') || el.querySelector('tr');
    if (!headerRow) return null;

    const headers = Array.from(headerRow.querySelectorAll('th, td'))
        .map(c => c.textContent?.trim() || '');

    const bodyRows = el.querySelectorAll('tbody tr').length > 0
        ? Array.from(el.querySelectorAll('tbody tr'))
        : Array.from(el.querySelectorAll('tr')).slice(1);

    const rows = bodyRows.map(tr =>
        Array.from(tr.querySelectorAll('td, th')).map(c => c.textContent?.trim() || ''),
    );

    if (headers.length === 0 && rows.length === 0) return null;
    return { kind: 'table', headers, rows };
}

function toStatCard(el: Element): SlideElement {
    const value = firstText(el, '.stat-value, .value, strong') || el.querySelector('h1, h2, h3')?.textContent?.trim() || '';
    const label = firstText(el, '.stat-label, .label, small, p') || '';
    const icon = el.querySelector('.stat-icon, .icon')?.textContent?.trim() || undefined;
    return {
        kind: 'stat-card',
        value,
        label,
        icon,
    };
}
