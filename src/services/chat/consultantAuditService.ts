/**
 * Consultant-structural audit (plan Cluster A) — separate from the visual-quality
 * audit. Runs on the STORYBOARD (+ its grounding report), NOT the rendered layout:
 * it asks "does it ARGUE well?" (so-what titles, evidence-fit, one-message,
 * chart-appropriateness, MECE/laddering), where the visual audit asks "does it
 * LOOK good?".
 *
 * Mostly DETERMINISTIC schema checks (cheap, reliable); the genuinely semantic
 * residue (is the storyline MECE, do titles ladder to the thesis) is an OPTIONAL
 * injected LLM judge seam — never baked in (so the deterministic core is pure +
 * unit-testable, and the independent cross-family critic plugs in at Cluster D).
 */
import type { ConsultantStoryboard, StoryboardSlide } from '../presentationIr/consultantStoryboard';
import type { GroundingReport } from '../presentationIr/evidenceGrounding';

export type StructuralDimension =
    | 'grounding' | 'action-title' | 'one-message' | 'chart-appropriateness' | 'mece' | 'laddering';
export type Severity = 'blocker' | 'major' | 'minor';

export interface StructuralFinding {
    readonly slideId?: string; // absent → deck-level
    readonly dimension: StructuralDimension;
    readonly severity: Severity;
    readonly message: string;
}

export interface StructuralAuditResult {
    readonly findings: readonly StructuralFinding[];
    /** slideId → findings (deck-level findings under the empty key). */
    readonly bySlide: ReadonlyMap<string, readonly StructuralFinding[]>;
}

// Common action verbs / verb-ish tokens — a light heuristic (M6: a FLAG, not a gate).
const VERBS = /\b(grew|grow|grows|drove|drive|drives|rose|rise|fell|fall|cut|cuts|gained|lost|led|leads|leading|added|adds|reduced|raises?|raised|improved|expand(?:ed|s)?|launch(?:ed|es)?|win|wins|won|delivered?|delivers?|outpaced?|doubled?|tripled?|shift(?:ed|s)?|enabl(?:ed|es)|unlock(?:ed|s)?|requires?|should|must|will|increased?|decreased?|accelerat(?:ed|es))\b/i;
const LABEL_PATTERNS = /(^|\s)(overview|summary|breakdown|introduction|agenda|results?|by (region|segment|product|quarter|year))(\s|$)/i;

function isLabelLike(title: string): boolean {
    if (VERBS.test(title)) return false;
    if (LABEL_PATTERNS.test(title)) return true;
    // ≤3 words with no verb → probably a noun-phrase label.
    return title.trim().split(/\s+/).length <= 3;
}

function visualDataPointCount(slide: StoryboardSlide): number {
    const v = slide.visual_data;
    switch (v.type) {
        case 'bar': return v.items.length;
        case 'line': return v.series.reduce((n, s) => n + s.points.length, 0);
        case 'waterfall': return 1 + v.deltas.length;
        case '2x2': return v.items.length;
        case 'harvey': return v.rows.length;
        case 'table': return v.rows.length;
        case 'pyramid': return v.levels.length;
        default: return 0;
    }
}

/**
 * Deterministic structural audit. Pure. The orchestrator treats `blocker`
 * findings as ship-blocking (route to storyboard repair); `minor` are advisory
 * flags surfaced in the dot-dash ⚠ Storyline check.
 */
export function auditStoryboard(storyboard: ConsultantStoryboard, grounding: GroundingReport): StructuralAuditResult {
    const findings: StructuralFinding[] = [];

    // Grounding → blockers (ungrounded numbers + dangling evidence refs).
    for (const b of grounding.blockers) {
        findings.push({ slideId: b.slideId, dimension: 'grounding', severity: 'blocker', message: `Unsupported number in ${b.field}: "${b.claim}" — no cited source contains it.` });
    }
    for (const id of grounding.danglingSpanIds) {
        findings.push({ dimension: 'grounding', severity: 'blocker', message: `Dangling evidence reference "${id}" — not in the source catalog.` });
    }

    for (const slide of storyboard.slides) {
        // Action-title quality (heuristic flag, M6).
        if (isLabelLike(slide.action_title)) {
            findings.push({ slideId: slide.id, dimension: 'action-title', severity: 'minor', message: `Title may be a label, not a so-what: "${slide.action_title}". State the implication.` });
        }
        // One-message discipline (heuristic): two clauses joined by "; " or " and … and ".
        if (/;|(\band\b.*\band\b)/i.test(slide.action_title)) {
            findings.push({ slideId: slide.id, dimension: 'one-message', severity: 'minor', message: `Title may carry more than one message: "${slide.action_title}".` });
        }
        // Chart appropriateness: a chart with <2 data points isn't a chart.
        const isChart = ['bar', 'line', 'waterfall', '2x2', 'harvey'].includes(slide.visual_data.type);
        if (isChart && visualDataPointCount(slide) < 2) {
            findings.push({ slideId: slide.id, dimension: 'chart-appropriateness', severity: 'minor', message: `A ${slide.visual_data.type} chart with <2 data points; consider a stat or a sentence.` });
        }
    }

    const bySlide = new Map<string, StructuralFinding[]>();
    for (const f of findings) {
        const key = f.slideId ?? '';
        const arr = bySlide.get(key) ?? [];
        arr.push(f);
        bySlide.set(key, arr);
    }
    return { findings, bySlide };
}

/** The semantic residue an LLM judge answers (deck-level): MECE + laddering. */
export interface JudgeVerdict { readonly findings: readonly StructuralFinding[]; }
export type StoryboardJudge = (storyboard: ConsultantStoryboard) => Promise<JudgeVerdict>;

/**
 * Full audit = deterministic core + optional LLM judge for MECE/laddering.
 * The judge is injected (Cluster D supplies the independent cross-family critic);
 * when absent, only the deterministic findings are returned. Never throws — a
 * failing judge degrades to the deterministic result.
 */
export async function auditStoryboardWithJudge(
    storyboard: ConsultantStoryboard,
    grounding: GroundingReport,
    judge?: StoryboardJudge,
): Promise<StructuralAuditResult> {
    const base = auditStoryboard(storyboard, grounding);
    if (!judge) return base;
    let extra: readonly StructuralFinding[] = [];
    try {
        extra = (await judge(storyboard)).findings;
    } catch {
        return base; // graceful: judge failure → deterministic result
    }
    const findings = [...base.findings, ...extra];
    const bySlide = new Map<string, StructuralFinding[]>();
    for (const f of findings) {
        const key = f.slideId ?? '';
        const arr = bySlide.get(key) ?? [];
        arr.push(f);
        bySlide.set(key, arr);
    }
    return { findings, bySlide };
}
