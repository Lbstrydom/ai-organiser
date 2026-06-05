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
import type { StructuralFinding } from '../chat/consultantAuditService';

const SLIDE_ANCHOR = 'aio-slide:';

function slideAnchor(slide: StoryboardSlide): string {
    // Compact machine state — id/role/visual + the full visual_data + evidence ids.
    const state = {
        id: slide.id,
        role: slide.role,
        suggested_visual: slide.suggested_visual,
        evidence_span_ids: slide.evidence_span_ids,
        visual_data: slide.visual_data,
    };
    return `<!-- ${SLIDE_ANCHOR} ${JSON.stringify(state)} -->`;
}

function findingsBlock(findings: readonly StructuralFinding[]): string {
    const relevant = findings.filter((f) => f.severity !== 'minor' || true); // show all
    if (relevant.length === 0) return '> ⚠ Storyline check: ✓ no issues';
    const lines = relevant.map((f) => `>   - [${f.severity}/${f.dimension}] ${f.message}`);
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
    out.push(`# ${options.deckName ?? 'Storyline'}`);
    out.push('');
    out.push(`> **Thesis:** ${storyboard.thesis}`);
    out.push('');
    out.push('_Review the storyline below. Edit the titles + supporting points directly, or leave `<!-- comment: … -->` notes, then run **Build slides from this storyline**. The hidden anchors carry the chart data — leave them in place._');
    out.push('');

    const deckFindings = options.bySlide?.get('') ?? [];
    if (deckFindings.length) {
        out.push(findingsBlock(deckFindings));
        out.push('');
    }

    for (const slide of storyboard.slides) {
        out.push(`## ${slide.action_title}`);
        out.push(slideAnchor(slide));
        out.push('');
        out.push(`- ${slide.core_message}`);
        out.push(`> visual: ${slide.suggested_visual}`);
        const f = options.bySlide?.get(slide.id) ?? [];
        out.push(findingsBlock(f));
        out.push('');
    }
    return out.join('\n');
}

export { SLIDE_ANCHOR };
