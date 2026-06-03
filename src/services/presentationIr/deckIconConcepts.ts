/**
 * Extract the icon concepts a deck actually references (plan §5a G1).
 *
 * Walks the IR for `stat-grid` card icons + `process-flow` step icons, resolves
 * each through the shared `resolvePresentationIcon` (so emoji/casing variance
 * collapses to the same canonical name the renderer + brand-asset lookup use),
 * and returns the unique set. The brand resolver uses this to bound
 * rasterization to only the icons on the slides — never the whole vault folder.
 *
 * Pure module — no Obsidian, no pptxgenjs.
 */

import type { Block, SlideDeckIr } from './slideIr';
import { resolvePresentationIcon } from './iconRegistry';

function blockConcepts(block: Block, out: Set<string>): void {
    switch (block.kind) {
        case 'stat-grid':
            for (const card of block.cards) {
                const ic = resolvePresentationIcon(card.icon);
                if (ic.kind === 'svg') out.add(ic.name);
            }
            break;
        case 'process-flow':
            for (const step of block.steps) {
                const ic = resolvePresentationIcon(step.icon);
                if (ic.kind === 'svg') out.add(ic.name);
            }
            break;
        case 'two-column':
            for (const c of block.left) blockConcepts(c, out);
            for (const c of block.right) blockConcepts(c, out);
            break;
        default:
            break;
    }
}

/** Unique, resolved icon concept names referenced by the deck. */
export function collectDeckIconConcepts(deck: SlideDeckIr | null | undefined): string[] {
    if (!deck || !Array.isArray(deck.slides)) return [];
    const out = new Set<string>();
    for (const slide of deck.slides) {
        for (const block of slide.blocks) blockConcepts(block, out);
    }
    return Array.from(out);
}
