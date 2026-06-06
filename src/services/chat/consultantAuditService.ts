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
import type { StructuralDimension, Severity, StructuralFinding, StructuralAuditResult } from '../presentationIr/structuralAuditTypes';
import { DECK_LEVEL_KEY } from '../presentationIr/structuralAuditTypes';
import { logger } from '../../utils/logger';

export type { StructuralDimension, Severity, StructuralFinding, StructuralAuditResult };

export interface AuditStoryboardOptions {
    /** Output language; the English-only title heuristics are skipped for others (audit M23). */
    outputLanguage?: string;
}

// Common action verbs / verb-ish tokens — a light heuristic (M6: a FLAG, not a gate).
const VERBS = /\b(grew|grow|grows|drove|drive|drives|rose|rise|fell|fall|cut|cuts|gained|lost|led|leads|leading|added|adds|reduced|raises?|raised|improved|expand(?:ed|s)?|launch(?:ed|es)?|win|wins|won|delivered?|delivers?|outpaced?|doubled?|tripled?|shift(?:ed|s)?|enabl(?:ed|es)|unlock(?:ed|s)?|requires?|should|must|will|increased?|decreased?|accelerat(?:ed|es))\b/i;
const LABEL_PATTERNS = /(^|\s)(overview|summary|breakdown|introduction|agenda|results?|by (region|segment|product|quarter|year))(\s|$)/i;

/** English heuristics only run for English output (audit M23). */
function isEnglishOutput(lang: string | undefined): boolean {
    return !lang || lang === 'en' || lang.toLowerCase().startsWith('en');
}

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
        case 'harvey': return v.rows.length * v.columns.length; // a matrix: each rating is a data point (renderer-gate R4 — a 1×4 harvey has 4, not 1)
        case 'table': return v.rows.length;
        case 'pyramid': return v.levels.length;
        default: return 0;
    }
}

function groupBySlide(findings: readonly StructuralFinding[]): Map<string, StructuralFinding[]> {
    const bySlide = new Map<string, StructuralFinding[]>();
    for (const f of findings) {
        const key = f.slideId ?? DECK_LEVEL_KEY;
        const arr = bySlide.get(key) ?? [];
        arr.push(f);
        bySlide.set(key, arr);
    }
    return bySlide;
}

/**
 * Deterministic structural audit. Pure. The orchestrator treats `blocker`
 * findings as ship-blocking (route to storyboard repair); `minor` are advisory
 * flags surfaced in the dot-dash ⚠ Storyline check.
 */
export function auditStoryboard(storyboard: ConsultantStoryboard, grounding: GroundingReport, options: AuditStoryboardOptions = {}): StructuralAuditResult {
    const findings: StructuralFinding[] = [];
    const english = isEnglishOutput(options.outputLanguage);

    // Grounding → blockers (ungrounded numbers + dangling evidence refs).
    for (const b of grounding.blockers) {
        findings.push({ slideId: b.slideId, dimension: 'grounding', severity: 'blocker', message: `Unsupported number in ${b.field}: "${b.claim}" — no cited source contains it.` });
    }
    for (const id of grounding.danglingSpanIds) {
        findings.push({ dimension: 'grounding', severity: 'blocker', message: `Dangling evidence reference "${id}" — not in the source catalog.` });
    }
    // Inferential numbers (cited, but not verbatim in the source) are surfaced as
    // ADVISORY (audit H4/H10) so an unverified number is never silently "grounded".
    // The injected LLM judge (Cluster D) upgrades these to a verified verdict.
    for (const inf of grounding.inferential) {
        findings.push({ slideId: inf.slideId, dimension: 'grounding', severity: 'minor', message: `Number in ${inf.field} ("${inf.claim}") isn't verbatim in the cited source — confirm before sharing.` });
    }

    for (const slide of storyboard.slides) {
        if (english) {
            // Action-title quality (heuristic flag, M6).
            if (isLabelLike(slide.action_title)) {
                findings.push({ slideId: slide.id, dimension: 'action-title', severity: 'minor', message: `Title may be a label, not a so-what: "${slide.action_title}". State the implication.` });
            }
            // One-message discipline (heuristic): two clauses joined by "; " or " and … and ".
            if (/;|(\band\b.*\band\b)/i.test(slide.action_title)) {
                findings.push({ slideId: slide.id, dimension: 'one-message', severity: 'minor', message: `Title may carry more than one message: "${slide.action_title}".` });
            }
        }
        // Chart appropriateness is language-agnostic.
        const isChart = ['bar', 'line', 'waterfall', '2x2', 'harvey'].includes(slide.visual_data.type);
        if (isChart && visualDataPointCount(slide) < 2) {
            findings.push({ slideId: slide.id, dimension: 'chart-appropriateness', severity: 'minor', message: `A ${slide.visual_data.type} chart with <2 data points; consider a stat or a sentence.` });
        }
    }

    return { findings, bySlide: groupBySlide(findings) };
}

/** The semantic residue an LLM judge answers (deck-level): MECE + laddering. */
export interface JudgeVerdict { readonly findings: readonly StructuralFinding[]; }
export type StoryboardJudge = (storyboard: ConsultantStoryboard) => Promise<JudgeVerdict>;

const DIMENSIONS: readonly StructuralDimension[] = ['grounding', 'action-title', 'one-message', 'chart-appropriateness', 'mece', 'laddering'];
const SEVERITIES: readonly Severity[] = ['blocker', 'major', 'minor'];

/** Runtime-validate an LLM judge finding (audit M12 — the seam is LLM-fed). */
export function isValidFinding(f: unknown): f is StructuralFinding {
    if (!f || typeof f !== 'object') return false;
    const x = f as Record<string, unknown>;
    return DIMENSIONS.includes(x.dimension as StructuralDimension)
        && SEVERITIES.includes(x.severity as Severity)
        && typeof x.message === 'string' && x.message.length > 0
        && (x.slideId === undefined || typeof x.slideId === 'string');
}

/**
 * Full audit = deterministic core + optional LLM judge for MECE/laddering.
 * The judge is injected (Cluster D supplies the independent cross-family critic);
 * when absent, only the deterministic findings are returned. Never throws — a
 * failing judge logs a warning and degrades to the deterministic result, and
 * malformed judge findings are dropped (not trusted blindly).
 */
export async function auditStoryboardWithJudge(
    storyboard: ConsultantStoryboard,
    grounding: GroundingReport,
    judge?: StoryboardJudge,
    options: AuditStoryboardOptions = {},
): Promise<StructuralAuditResult> {
    const base = auditStoryboard(storyboard, grounding, options);
    if (!judge) return base;
    let extra: readonly StructuralFinding[] = [];
    try {
        const verdict = await judge(storyboard);
        const valid = (verdict.findings ?? []).filter(isValidFinding);
        if (valid.length !== (verdict.findings ?? []).length) {
            logger.warn('Presentation', `storyboard judge: dropped ${(verdict.findings?.length ?? 0) - valid.length} malformed finding(s)`);
        }
        extra = valid;
    } catch (e) {
        logger.warn('Presentation', `storyboard judge failed, using deterministic audit only: ${e instanceof Error ? e.message : String(e)}`);
        return base;
    }
    const findings = [...base.findings, ...extra];
    return { findings, bySlide: groupBySlide(findings) };
}
