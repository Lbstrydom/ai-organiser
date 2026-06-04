/**
 * Min-font floor helpers — the shared home for brand min-font clamping so the
 * spec + BOTH renderers apply identical floors (preview == export). Moved out
 * of `irToPptx` (renderer-fidelity Phase 2 / D4) so it has no upward dependency
 * on a renderer; neutral data + `ExportTheme` only.
 *
 * `theme.minFont` carries the per-role floors. It is populated whenever the
 * theme defines floors — brand exports AND `resolveTheme`'s defaults — so a
 * typical export HAS floors. Only when it is genuinely absent (`undefined`) is
 * every helper a pass-through → identical output to a floor-free theme.
 */

import type { ExportTheme } from '../export/exportTheme';

export type MinFontRole = 'body' | 'caption' | 'table' | 'footer';

/** Clamp a FIXED-SIZE structural font UP to its role floor (footer/caption/
 *  table literals). No floor set → the literal is returned unchanged. */
export function clampFixedFont(theme: ExportTheme, role: MinFontRole, intended: number): number {
    const floor = theme.minFont?.[role];
    return floor === undefined ? intended : Math.max(floor, intended);
}

/** Lower-bound for a SHRINK-TO-FIT font at its role floor. No floor set →
 *  `-Infinity` so an existing shrink computation is unaffected. The caller still
 *  keeps its own overflow/truncation behaviour once it bottoms out (no new
 *  clipping). */
export function fontFloor(theme: ExportTheme, role: MinFontRole): number {
    return theme.minFont?.[role] ?? -Infinity;
}
