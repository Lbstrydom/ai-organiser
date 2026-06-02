/**
 * Shared render-isolation helpers (debt plan D1). Gives both renderers ONE
 * "isolate a failed slide → notice + placeholder" vocabulary so HTML and PPTX
 * degrade a broken slide identically instead of one sinking the whole deck
 * (HTML, pre-D1) and the other shipping a silent partial slide (PPTX, pre-D1).
 *
 * Each renderer renders DIRECTLY to its surface (preserving the per-op fallbacks
 * that need a synchronous throw — native-chart→bars, svg-image→solid) and, on an
 * uncaught slide-scaffolding error, emits a visible placeholder + this notice.
 * Per-block errors are already isolated inside each renderer's block loop.
 *
 * Pure — no Obsidian, no pptxgenjs.
 */

import type { FidelityNotice } from './slideIr';

/** Neutral default for the user-visible placeholder card. The caller
 *  (presentationHtmlService, which has plugin.t) injects a localised label via
 *  render options; this is the fallback when none is provided. */
export const DEFAULT_PLACEHOLDER_LABEL = 'This slide could not be rendered.';

/** Shared notice factory so both renderers describe an isolated slide failure
 *  the same way (diagnostic / developer-facing — surfaced via logger.warn). */
export function slideFailureNotice(slideIndex: number, phase: 'build' | 'replay', err: unknown): FidelityNotice {
    const detail = err instanceof Error ? err.message : String(err);
    return {
        slideIndex,
        blockKind: 'paragraph',
        severity: 'substantive',
        description: `slide ${slideIndex} ${phase} failed: ${detail}`,
    };
}
