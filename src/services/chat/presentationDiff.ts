/**
 * Presentation Diff
 *
 * Drift classification + slide comparison for the targeted slide editing
 * feature. Operates on CANONICAL HTML — never on projected HTML — so editor
 * instrumentation (data-element attributes added by presentationDomDecorator)
 * never registers as drift.
 *
 * Pure DOM-only utility — no LLM, no Obsidian APIs.
 *
 * Plan: docs/completed/slide-authoring-editing-backend.md §"Whitespace handling"
 */

import type {
    SelectionScope,
    ScopedDiff,
    SlideDiff,
    StructuralIntegrity,
    DriftSeverity,
} from './presentationTypes';
import { computeLineDiff } from '../../utils/mermaidDiff';
import { extractScopedFragment } from './presentationDomDecorator';
import { SLIDE_SELECTOR } from './presentationConstants';

// ── Slide comparison ────────────────────────────────────────────────────────

/**
 * Whitespace-tolerant slide comparison. Returns the most significant
 * difference detected:
 *
 *   'identical'    — bytes match after whitespace normalisation
 *   'whitespace'   — only whitespace formatting differs
 *   'text'         — text content differs (visible to readers)
 *   'structural'   — tag names / attributes / hierarchy differs
 *
 * Whitespace-only drift is filtered out of `outOfScopeDrift` upstream so
 * users don't see noise from LLM formatting variations.
 */
export function compareSlides(oldHtml: string, newHtml: string): DriftSeverity {
    if (oldHtml === newHtml) return 'identical';

    // Cheap whitespace check — collapse runs and trim, compare again.
    const normalised = (s: string) => s.replaceAll(/\s+/g, ' ').trim();
    const oldNorm = normalised(oldHtml);
    const newNorm = normalised(newHtml);
    if (oldNorm === newNorm) return 'whitespace';

    // Structural compare: parse, walk in lockstep.
    const parser = new DOMParser();
    const oldDoc = parser.parseFromString(`<div>${oldHtml}</div>`, 'text/html');
    const newDoc = parser.parseFromString(`<div>${newHtml}</div>`, 'text/html');

    const oldRoot = oldDoc.body.firstElementChild;
    const newRoot = newDoc.body.firstElementChild;
    if (!oldRoot || !newRoot) return 'structural';

    return walkCompare(oldRoot, newRoot);
}

/** Recursive lockstep walk of two element trees. */
function walkCompare(a: Element, b: Element): DriftSeverity {
    if (a.tagName !== b.tagName) return 'structural';
    if (!attributesMatch(a, b)) return 'structural';

    const aKids = Array.from(a.children);
    const bKids = Array.from(b.children);
    if (aKids.length !== bKids.length) return 'structural';

    // Severity rank: identical=0, whitespace=1, text=2, structural=3 (early return).
    let rank = 0;
    const update = (sub: DriftSeverity): void => {
        if (sub === 'whitespace' && rank < 1) rank = 1;
        else if (sub === 'text' && rank < 2) rank = 2;
    };
    for (let i = 0; i < aKids.length; i++) {
        const sub = walkCompare(aKids[i], bKids[i]);
        if (sub === 'structural') return 'structural';
        update(sub);
    }

    // Compare text nodes (excluding child elements that we already walked).
    const aText = directTextContent(a);
    const bText = directTextContent(b);
    if (aText !== bText) {
        const aNorm = aText.replaceAll(/\s+/g, ' ').trim();
        const bNorm = bText.replaceAll(/\s+/g, ' ').trim();
        update(aNorm === bNorm ? 'whitespace' : 'text');
    }

    if (rank === 2) return 'text';
    if (rank === 1) return 'whitespace';
    return 'identical';
}

/** Compare attribute sets — sorted, names case-insensitive, value-equal. */
function attributesMatch(a: Element, b: Element): boolean {
    const aAttrs = collectAttrs(a);
    const bAttrs = collectAttrs(b);
    if (aAttrs.length !== bAttrs.length) return false;
    for (let i = 0; i < aAttrs.length; i++) {
        if (aAttrs[i][0] !== bAttrs[i][0]) return false;
        // class attribute: compare token sets (order-insensitive).
        if (aAttrs[i][0] === 'class') {
            const aSet = new Set(aAttrs[i][1].split(/\s+/).filter(Boolean));
            const bSet = new Set(bAttrs[i][1].split(/\s+/).filter(Boolean));
            if (aSet.size !== bSet.size) return false;
            for (const t of aSet) if (!bSet.has(t)) return false;
            continue;
        }
        if (aAttrs[i][1] !== bAttrs[i][1]) return false;
    }
    return true;
}

/** Editor-instrumentation attributes ignored by attributesMatch (audit
 *  Gemini-r4-G1) — these are added by `presentationDomDecorator` and the
 *  Item 4 hover affordance, not user content. Comparing them as drift would
 *  flag every reprojection as structural. */
const INSTRUMENTATION_ATTRS = new Set(['data-element', 'data-bg-hover-label']);

function collectAttrs(el: Element): Array<[string, string]> {
    const result: Array<[string, string]> = [];
    for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (INSTRUMENTATION_ATTRS.has(name) || name.startsWith('data-pres-')) continue;
        result.push([name, attr.value]);
    }
    result.sort((x, y) => x[0].localeCompare(y[0]));
    return result;
}

/** Text directly inside `el`, excluding text inside child elements. */
function directTextContent(el: Element): string {
    let text = '';
    for (const node of Array.from(el.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? '';
    }
    return text;
}

// ── Drift classification ────────────────────────────────────────────────────

/**
 * Compare an old + new deck under a given scope, separating the user's
 * intended change ('scopeDiff') from any unwanted drift on slides outside
 * the scope ('outOfScopeDrift'). Whitespace-only drift is filtered out.
 *
 * Returns new fields per audit Items 2/3 + Gemini-r4-G1:
 *   - siblingDrift: same-slide changes outside the user's element scope
 *   - textChangedLocations: count for the design-mode banner check
 *
 * HTML inputs may be projected (annotated with `data-element` paths) — the
 * function uses paths internally for sibling drift and assessStructure
 * element-path-set check; user-visible textDiffs strip instrumentation.
 */
export function classifyDiff(
    oldHtml: string,
    newHtml: string,
    scope: SelectionScope,
): {
    scopeDiff: ScopedDiff;
    outOfScopeDrift: SlideDiff[];
    siblingDrift: SlideDiff | null;
    textChangedLocations: number;
    structuralIntegrity: StructuralIntegrity;
} {
    const parser = new DOMParser();
    const oldDoc = parser.parseFromString(oldHtml, 'text/html');
    const newDoc = parser.parseFromString(newHtml, 'text/html');

    const oldSlides = Array.from(oldDoc.querySelectorAll(SLIDE_SELECTOR));
    const newSlides = Array.from(newDoc.querySelectorAll(SLIDE_SELECTOR));

    const scopeDiff = buildScopeDiff(oldHtml, newHtml, scope);
    const structuralIntegrity = assessStructure(oldSlides, newSlides);

    return {
        scopeDiff,
        outOfScopeDrift: collectOutOfScopeDrift(oldSlides, newSlides, scope),
        siblingDrift: buildSiblingDrift(oldSlides, newSlides, scope, structuralIntegrity),
        textChangedLocations: countTextChangedLocations(scopeDiff),
        structuralIntegrity,
    };
}

function assessStructure(oldSlides: Element[], newSlides: Element[]): StructuralIntegrity {
    if (newSlides.length > oldSlides.length) return 'slides-added';
    if (newSlides.length < oldSlides.length) return 'slides-removed';
    if (slidesClassesChanged(oldSlides, newSlides)) return 'class-changed';
    // Audit G1 + Gemini-r7-G1 corrected: only flag when paths were REMOVED
    // (oldPaths ⊄ newPaths). Adding paths is the sibling-drift use case
    // and must not trigger the banner.
    if (slidesElementPathsRemoved(oldSlides, newSlides)) return 'element-paths-changed';
    return 'preserved';
}

/** Collect all `data-element` path strings on a slide (depth-first). */
function collectElementPaths(slide: Element): Set<string> {
    const paths = new Set<string>();
    const walker = slide.ownerDocument.createTreeWalker(slide, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode as Element | null;
    while (node) {
        if (node instanceof Element && node.hasAttribute('data-element')) {
            const path = node.getAttribute('data-element');
            if (path) paths.add(path);
        }
        node = walker.nextNode() as Element | null;
    }
    return paths;
}

/** True iff any old slide has a `data-element` path missing in the new slide. */
function slidesElementPathsRemoved(oldSlides: Element[], newSlides: Element[]): boolean {
    const len = Math.min(oldSlides.length, newSlides.length);
    for (let i = 0; i < len; i++) {
        const oldPaths = collectElementPaths(oldSlides[i]);
        if (oldPaths.size === 0) continue;  // canonical input — skip path check
        const newPaths = collectElementPaths(newSlides[i]);
        for (const p of oldPaths) {
            if (!newPaths.has(p)) return true;
        }
    }
    return false;
}

function collectOutOfScopeDrift(
    oldSlides: Element[],
    newSlides: Element[],
    scope: SelectionScope,
): SlideDiff[] {
    const inScope = scopedSlideIndices(scope);
    const drift: SlideDiff[] = [];
    const compareCount = Math.min(oldSlides.length, newSlides.length);
    for (let i = 0; i < compareCount; i++) {
        if (inScope.has(i)) continue;
        const slideDrift = describeSlideDrift(i, oldSlides[i], newSlides[i]);
        if (slideDrift) drift.push(slideDrift);
    }
    return drift;
}

function describeSlideDrift(index: number, oldSlide: Element, newSlide: Element): SlideDiff | null {
    const oldSlideHtml = oldSlide.outerHTML;
    const newSlideHtml = newSlide.outerHTML;
    const severity = compareSlides(oldSlideHtml, newSlideHtml);
    if (severity === 'identical' || severity === 'whitespace') return null;
    return {
        slideIndex: index,
        oldHtml: oldSlideHtml,
        newHtml: newSlideHtml,
        textDiff: computeLineDiff(oldSlideHtml, newSlideHtml),
        severity,
    };
}

function slidesClassesChanged(oldSlides: Element[], newSlides: Element[]): boolean {
    const sortClasses = (cls: string): string =>
        cls.split(/\s+/).filter(Boolean).sort((x, y) => x.localeCompare(y)).join(' ');
    for (let i = 0; i < oldSlides.length; i++) {
        const a = sortClasses(oldSlides[i].getAttribute('class') ?? '');
        const b = sortClasses(newSlides[i].getAttribute('class') ?? '');
        if (a !== b) return true;
    }
    return false;
}

/**
 * Map a SelectionScope to the set of in-scope slide indices.
 *
 * **v1 limitation** (H9 audit finding 2026-04-25): for `kind: 'element'`,
 * the entire containing slide is treated as in-scope. This means same-slide
 * drift OUTSIDE the selected element is NOT surfaced to the user — if the
 * LLM changes bullet 5 while the user only asked to edit bullet 2, that
 * silently lands.
 *
 * This is acceptable for v1 because:
 *   1. The scoped content prompt sends only the affected element subtree,
 *      so the LLM physically can't see/rewrite other bullets.
 *   2. Element-granular drift detection would need a parallel slide-level
 *      DOM comparison and per-data-element correlation — non-trivial scope.
 *
 * v2 path: extend drift detection to compare in-scope vs out-of-scope
 * REGIONS within the same slide using data-element paths as anchors. Trigger
 * for v2 is "users report unwanted same-slide drift in scoped element edits".
 */
function scopedSlideIndices(scope: SelectionScope): Set<number> {
    const set = new Set<number>();
    if (scope.kind === 'range') {
        const end = scope.slideEndIndex ?? scope.slideIndex;
        for (let i = scope.slideIndex; i <= end; i++) set.add(i);
    } else {
        set.add(scope.slideIndex);
    }
    return set;
}

function buildScopeDiff(oldHtml: string, newHtml: string, scope: SelectionScope): ScopedDiff {
    const oldFragment = extractScopedFragment(oldHtml, scope);
    const newFragment = extractScopedFragment(newHtml, scope);
    // Strip instrumentation before user-visible textDiff (audit Gemini-r5-G1).
    // Internal classification keeps the unstripped fragments so paths remain.
    const textDiff = computeLineDiff(
        stripInstrumentationAttrs(oldFragment),
        stripInstrumentationAttrs(newFragment),
    );
    return { scope, oldFragment, newFragment, textDiff };
}

/** Strip editor-instrumentation attributes (`data-element`, `data-bg-hover-label`,
 *  any `data-pres-*`) from an HTML string before showing it to the user.
 *  Audit Gemini-r5-G1 + r6-G2: every user-visible textDiff path uses this. */
export function stripInstrumentationAttrs(html: string): string {
    return html.replaceAll(/\s+(data-element|data-bg-hover-label|data-pres-[a-z-]+)="[^"]*"/g, '');
}

/** Count subtree locations whose normalised text content changed. v1
 *  implementation: 0 or 1 (single-subtree comparison via the existing
 *  scopeDiff). The modal reads its own `editMode` and decides whether
 *  to render the design-mode banner — pure DOM utility, no UI state
 *  leak (audit Gemini-r2-G4). */
export function countTextChangedLocations(scopeDiff: ScopedDiff): number {
    const oldText = normaliseTextOfHtml(scopeDiff.oldFragment);
    const newText = normaliseTextOfHtml(scopeDiff.newFragment);
    return oldText === newText ? 0 : 1;
}

function normaliseTextOfHtml(html: string): string {
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<div>${html}</div>`, 'text/html');
    const root = doc.body.firstElementChild;
    const text = root?.textContent ?? '';
    return text.replaceAll(/\s+/g, ' ').trim();
}

/** Build a sibling-drift SlideDiff: same-slide changes OUTSIDE the user's
 *  element scope (audit Item 3 + G1 + Gemini-r3-G3 + r7-G1).
 *
 *  Returns null when:
 *    - scope.kind !== 'element' (sibling drift only meaningful for element scope)
 *    - structuralIntegrity === 'element-paths-changed' (LLM destroyed identity;
 *      Gemini-r3-G3: assessStructure variant is the sole banner-driving signal)
 *    - the slide had no sibling-level changes
 *    - sibling changes are whitespace-only
 *
 *  Walks the slide's `[data-element]` descendants and identifies entries
 *  whose path is a sibling (same parent path, different leaf) of `scope.elementPath`.
 *  Only those subtrees contribute to the textDiff. */
function buildSiblingDrift(
    oldSlides: Element[],
    newSlides: Element[],
    scope: SelectionScope,
    integrity: StructuralIntegrity,
): SlideDiff | null {
    if (scope.kind !== 'element' || !scope.elementPath) return null;
    if (integrity === 'element-paths-changed') return null;
    const idx = scope.slideIndex;
    if (idx < 0 || idx >= oldSlides.length || idx >= newSlides.length) return null;

    const oldSlide = oldSlides[idx];
    const newSlide = newSlides[idx];
    const scopePath = scope.elementPath;
    const parentPrefix = parentPathOf(scopePath);  // 'slide-3.list-0' for 'slide-3.list-0.item-1'

    const oldSiblings = findSiblingHtmls(oldSlide, scopePath, parentPrefix);
    const newSiblings = findSiblingHtmls(newSlide, scopePath, parentPrefix);
    if (oldSiblings === newSiblings) return null;

    const sevOld = stripInstrumentationAttrs(oldSiblings);
    const sevNew = stripInstrumentationAttrs(newSiblings);
    if (sevOld === sevNew) return null;
    const oldNorm = sevOld.replaceAll(/\s+/g, ' ').trim();
    const newNorm = sevNew.replaceAll(/\s+/g, ' ').trim();
    if (oldNorm === newNorm) return null;  // whitespace-only

    const textDiff = computeLineDiff(sevOld, sevNew);

    return {
        slideIndex: idx,
        oldHtml: oldSiblings,
        newHtml: newSiblings,
        textDiff,
        // Severity is text-or-structural; fold sibling-drift severity into 'text'
        // unless the underlying compareSlides reports structural.
        severity: 'text',
    };
}

/** Concatenate the outerHTML of every `[data-element]` whose path is a
 *  sibling of `scopePath` under `parentPrefix`, sorted by path for
 *  determinism. Returns empty string when no siblings exist. */
function findSiblingHtmls(slide: Element, scopePath: string, parentPrefix: string): string {
    const out: Array<{ path: string; html: string }> = [];
    const walker = slide.ownerDocument.createTreeWalker(slide, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode as Element | null;
    while (node) {
        if (node instanceof Element && node.hasAttribute('data-element')) {
            const path = node.getAttribute('data-element') ?? '';
            if (path !== scopePath && parentPathOf(path) === parentPrefix) {
                out.push({ path, html: node.outerHTML });
            }
        }
        node = walker.nextNode() as Element | null;
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out.map(o => o.html).join('\n');
}

function parentPathOf(path: string): string {
    const dot = path.lastIndexOf('.');
    return dot < 0 ? '' : path.slice(0, dot);
}
