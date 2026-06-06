/**
 * Dot-dash serializer (plan §2b): render a `ConsultantStoryboard` (+ its
 * structural-audit findings) as a human-readable storyline `.md` the user reviews
 * BEFORE any slides are designed — the consulting "storyline sign-off" gate.
 *
 * The HUMAN-EDITABLE surface is the prose (action titles `##`, supporting dot-dash
 * bullets). The MACHINE STATE (slide id, role, suggested_visual, the full
 * visual_data, evidence ids) rides in a hidden `<!-- aio-slide: {…} -->` anchor so
 * the round-trip parser reconstructs identity + evidence bindings even after heavy
 * editing (plan: provenance across the round-trip). The ⚠ Storyline check shows
 * the audit findings inline so the user reviews WITH the checks visible.
 */
import type { ConsultantStoryboard, StoryboardSlide } from './consultantStoryboard';
// Neutral, same-layer type import (audit M16 — no upward dependency on chat/).
import type { StructuralFinding } from './structuralAuditTypes';
import { DECK_LEVEL_KEY } from './structuralAuditTypes';
import { encodeAnchor, encodeMetaComment, SLIDE_ANCHOR } from './dotDashAnchor';

function slideAnchor(slide: StoryboardSlide): string {
    // Compact machine state — id/role/visual + the full visual_data + evidence ids.
    // base64-encoded by encodeAnchor so a value containing `-->` can't break the
    // comment fence (audit H5/H9).
    return encodeAnchor({
        id: slide.id,
        role: slide.role,
        suggested_visual: slide.suggested_visual,
        evidence_span_ids: slide.evidence_span_ids,
        visual_data: slide.visual_data,
    });
}

/**
 * Collapse newlines to spaces so a title / message / finding can't inject a new
 * `##` heading or `>`/`-` line that the parser would mis-split (audit H9). The
 * machine state rides the base64 anchor, so the human prose lines must stay single-line.
 */
function oneLine(s: string): string {
    return s
        .replace(/\s*\n+\s*/g, ' ')
        // Defang HTML-comment tokens (audit H5) so a human field can't forge a
        // hidden `<!-- aio-slide … -->` anchor that the parser would trust.
        .replace(/<!--/g, '< !--')
        .replace(/-->/g, '-- >')
        .trim();
}

function findingsBlock(findings: readonly StructuralFinding[]): string {
    if (findings.length === 0) return '> ⚠ Storyline check: ✓ no issues';
    const lines = findings.map((f) => `>   - [${f.severity}/${f.dimension}] ${oneLine(f.message)}`);
    return ['> ⚠ Storyline check:', ...lines].join('\n');
}

export interface SerializeOptions {
    /** Per-slide audit findings (slideId → findings), e.g. from `auditStoryboard().bySlide`. */
    bySlide?: ReadonlyMap<string, readonly StructuralFinding[]>;
    /** Deck title for the note. */
    deckName?: string;
}

/**
 * Serialize a storyboard to the dot-dash `.md`. Pure (no fs). Round-trips with
 * `markdownToStoryboard`.
 */
export function storyboardToMarkdown(storyboard: ConsultantStoryboard, options: SerializeOptions = {}): string {
    const out: string[] = [];
    out.push(`# ${oneLine(options.deckName ?? 'Storyline')}`);
    out.push('');
    out.push(`> **Thesis:** ${oneLine(storyboard.thesis)}`);
    // Preserve the LLM's section groupings across the round-trip (renderer-gate MEDIUM —
    // they have no visible prose form, so they ride a hidden deck-level meta comment).
    if (storyboard.sections?.length) out.push(encodeMetaComment('aio-sections', storyboard.sections));
    out.push('');
    out.push('_Review the storyline below. Edit the titles + supporting points directly, or leave `<!-- comment: … -->` notes, then run **Build slides from this storyline**. The hidden anchors carry the chart data — leave them in place. The `> visual:` line is display-only; to change a chart, describe it in chat (e.g. "make slide 3 a 2×2")._');
    out.push('');

    const deckFindings = options.bySlide?.get(DECK_LEVEL_KEY) ?? [];
    if (deckFindings.length) {
        out.push(findingsBlock(deckFindings));
        out.push('');
    }

    for (const slide of storyboard.slides) {
        out.push(`## ${oneLine(slide.action_title)}`);
        out.push(slideAnchor(slide));
        out.push('');
        out.push(`- ${oneLine(slide.core_message)}`);
        out.push(`> visual: ${slide.suggested_visual}`);
        const f = options.bySlide?.get(slide.id) ?? [];
        out.push(findingsBlock(f));
        out.push('');
    }
    return out.join('\n');
}

export { SLIDE_ANCHOR };
