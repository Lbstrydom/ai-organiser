/**
 * Evidence grounding — the load-bearing "no fabricated numbers" guarantee (plan
 * Cluster A). Our decks are built from the user's notes, so a confident but
 * ungrounded action title ("EMEA drove 60%") is the #1 failure mode.
 *
 * TIERED + deterministic-first (cheap before expensive):
 *   - exact      : the claim's numeric token appears verbatim in a cited span
 *   - numeric    : a normalised numeric match (60% ≡ 60 percent ≡ 0.60)
 *   - inferential: the claim has a number with no deterministic match → needs the
 *                  LLM judge (source says "40→64", title says "60% growth")
 *   - grounded-text : a non-numeric claim — passes deterministically (prose isn't
 *                  a fabrication risk the way a number is)
 *   - ungrounded : a number that resolves to nothing → a BLOCKER
 *
 * Only `inferential` reaches an LLM, and the audit payload is `{claim, cited_spans}`
 * ONLY — blind to the generator's rationale (true independence).
 *
 * Pure, dependency-light, fully unit-testable. The LLM inferential tier is a seam
 * (an injected judge), not baked in here.
 */
import type { ConsultantStoryboard, EvidenceSpan, StoryboardSlide, VisualData } from './consultantStoryboard';

export type GroundingTier = 'exact' | 'numeric' | 'inferential' | 'grounded-text' | 'ungrounded';

export interface ClaimCheck {
    readonly slideId: string;
    /** Where the claim text came from — for the audit + the dot-dash ⚠ marker. */
    readonly field: 'action_title' | 'core_message' | 'visual_data' | 'table-cell';
    readonly claim: string;
    /** The numeric token under scrutiny, if any (normalised display form). */
    readonly numeric?: string;
    readonly tier: GroundingTier;
    readonly citedSpanIds: readonly string[];
    /** True for `inferential` — the orchestrator routes these to the LLM judge. */
    readonly needsLlm: boolean;
}

export interface GroundingReport {
    readonly checks: readonly ClaimCheck[];
    /** evidence_span_ids cited by a slide that are NOT in the catalog (dangling). */
    readonly danglingSpanIds: readonly string[];
    readonly blockers: readonly ClaimCheck[]; // tier === 'ungrounded'
    readonly inferential: readonly ClaimCheck[]; // tier === 'inferential' (→ LLM)
}

// Captures a trailing "%" / "percent" (M6/M12) AND a magnitude suffix (k / m / b /
// t, attached or as a word) so "$50 billion" tokenises WITH its magnitude — the
// `[kmbt](?![a-z])` guard means "60 models" does NOT capture a spurious "m".
// One number token, robust to the realistic claim formats:
//  • leading-OR-dot decimals (".5", "-.25") — renderer-gate R1
//  • a MINUS even when a currency symbol separates it from the digits ("-$50") — R3,
//    so a negative value keeps its sign and can't false-match a positive source
//  • a `(?<![a-z])` lookbehind that skips letter-prefixed IDENTIFIERS ("Q3","FY24","v2") — R2
//  • a trailing %/percent or magnitude word/letter (the magnitudeKey gate) — R1
const NUMERIC_RE = /(?<![a-z])-?\s*[$€£]?\s*(?:\d[\d,]*(?:\.\d+)?|\.\d+)\s*(?:%|percent|million|billion|trillion|thousand|bn|[kmbt](?![a-z]))?/gi;

/**
 * Magnitude key of a numeric token (audit, consolidated gate H1): '$50 billion' →
 * 'b', '50k' → 'k', '50' → ''. Used as a MATCH GATE — two numbers only match when
 * their magnitudes agree, so "50 billion" can't falsely match a source's bare "50".
 * Deliberately NOT multiplied into the value (that risks mis-grounding "60 models");
 * a magnitude mismatch simply routes the claim to the inferential LLM judge.
 */
function magnitudeKey(token: string): string {
    const t = token.trim().toLowerCase();
    if (/\bbillion\b|\bbn\b|\d\s*b(?![a-z])/.test(t)) return 'b';
    if (/\btrillion\b|\d\s*t(?![a-z])/.test(t)) return 't';
    if (/\bmillion\b|\d\s*m(?![a-z])/.test(t)) return 'm';
    if (/\bthousand\b|\d\s*k(?![a-z])/.test(t)) return 'k';
    return '';
}

// A cell is a NUMBER (not a label-with-a-digit) only when the whole value is
// numeric — currency prefix + thousands + decimal + optional %/percent (audit H10).
// A WHOLLY-numeric cell, incl. a minus BEFORE the currency ("-$50", renderer-gate R2).
// Deliberately whole-cell: a prose cell ("Loss of $50") or a year ("Q3 2024") is NOT
// matched — that avoids false-positive grounding nags on identifiers/years (the
// primary title/visual claims are grounded; a number buried in prose is accepted-gap).
const NUMERIC_CELL_RE = /^\s*-?\s*[$€£]?\s*(?:\d[\d,]*(?:\.\d+)?|\.\d+)\s*(?:%|percent|million|billion|trillion|thousand|bn|[kmbt])?\s*$/i;

/** Normalise a numeric token to a canonical numeric value for matching:
 *  "60%"→0.6, "60 percent"→0.6, "0.60"→0.6, "1,234"→1234, "64"→64. */
export function normaliseNumeric(token: string): number | null {
    // Strip thousands commas AND the currency symbol so a minus that sits BEFORE the
    // symbol ("-$50") stays attached to the digits (renderer-gate R3 — else the
    // sign-less "50" would false-match a positive source).
    const t = token.trim().toLowerCase().replace(/[,$€£]/g, '');
    const pct = /%|percent/.test(t);
    const m = t.match(/-?(?:\d+(?:\.\d+)?|\.\d+)/);
    if (!m) return null;
    let n = parseFloat(m[0]);
    if (Number.isNaN(n)) return null;
    if (pct) n = n / 100;
    return n;
}

function spanText(span: EvidenceSpan): string {
    return (span.text + ' ' + (span.value ?? '')).toLowerCase();
}

/**
 * Does a numeric appear in any cited span? TOKEN-based (audit H10): the claim token
 * is matched against each span's tokenized numbers, NOT by substring — so "60" no
 * longer falsely matches "160". `exact` = a verbatim numeric token; `numeric` = a
 * normalised-value match (60% ≡ 0.60).
 */
function numericInSpans(rawToken: string, spans: readonly EvidenceSpan[]): 'exact' | 'numeric' | null {
    const rawNorm = rawToken.trim().toLowerCase().replace(/\s+/g, '');
    const rawMag = magnitudeKey(rawToken);
    const target = normaliseNumeric(rawToken);
    let numericHit = false;
    for (const s of spans) {
        const toks = spanText(s).match(NUMERIC_RE) || [];
        for (const tk of toks) {
            if (magnitudeKey(tk) !== rawMag) continue; // magnitude/unit must agree (H1: "50 billion" ≠ "50")
            if (tk.trim().toLowerCase().replace(/\s+/g, '') === rawNorm) return 'exact'; // verbatim token (bounded)
            if (target !== null) {
                const v = normaliseNumeric(tk);
                if (v !== null && Math.abs(v - target) < 1e-9) numericHit = true;
            }
        }
    }
    return numericHit ? 'numeric' : null;
}

/** Check one textual claim against its cited spans. */
export function checkClaim(
    claim: string,
    citedSpans: readonly EvidenceSpan[],
    meta: { slideId: string; field: ClaimCheck['field'] },
): ClaimCheck {
    const numbers = claim.match(NUMERIC_RE)?.map((s) => s.trim()).filter((s) => /\d/.test(s)) ?? [];
    const base = { slideId: meta.slideId, field: meta.field, claim, citedSpanIds: citedSpans.map((s) => s.id) };
    if (numbers.length === 0) {
        return { ...base, tier: 'grounded-text', needsLlm: false };
    }
    // A claim is only as grounded as its WEAKEST number.
    let worst: GroundingTier = 'exact';
    const rank: Record<GroundingTier, number> = { exact: 0, numeric: 1, 'grounded-text': 1, inferential: 2, ungrounded: 3 };
    let firstNumeric: string | undefined;
    for (const tok of numbers) {
        firstNumeric ??= tok;
        const hit = numericInSpans(tok, citedSpans);
        const tier: GroundingTier = hit ?? (citedSpans.length > 0 ? 'inferential' : 'ungrounded');
        if (rank[tier] > rank[worst]) worst = tier;
    }
    return { ...base, numeric: firstNumeric, tier: worst, needsLlm: worst === 'inferential' };
}

/** Pull the evidence ids a visual_data payload references (for resolving spans). */
function visualEvidenceIds(v: VisualData): string[] {
    const ids: string[] = [];
    switch (v.type) {
        case 'bar': for (const i of v.items) ids.push(i.evidence_span_id); break;
        case 'waterfall': ids.push(v.base.evidence_span_id); for (const d of v.deltas) ids.push(d.evidence_span_id); break;
        case 'line': for (const s of v.series) for (const p of s.points) ids.push(p.evidence_span_id); break;
        case '2x2': for (const it of v.items) if (it.evidence_span_id) ids.push(it.evidence_span_id); break;
        case 'harvey': for (const r of v.rows) if (r.evidence_span_id) ids.push(r.evidence_span_id); break;
        case 'table': for (const r of v.rows) for (const c of r.cells) if (c.evidence_span_id) ids.push(c.evidence_span_id); break;
        default: break;
    }
    return ids;
}

/** Numeric claims carried by a visual_data payload (label + value pairs). */
function visualNumericClaims(v: VisualData): Array<{ claim: string; spanId?: string }> {
    const out: Array<{ claim: string; spanId?: string }> = [];
    const push = (label: string, value: number, spanId: string, unit?: string) =>
        out.push({ claim: `${label}: ${value}${unit === '%' ? '%' : unit ? ' ' + unit : ''}`, spanId });
    switch (v.type) {
        case 'bar': for (const i of v.items) push(i.label, i.value, i.evidence_span_id, v.unit); break;
        case 'waterfall': push(v.base.label, v.base.value, v.base.evidence_span_id, v.unit); for (const d of v.deltas) push(d.label, d.value, d.evidence_span_id, v.unit); break;
        case 'line': for (const s of v.series) for (const p of s.points) push(`${s.label} ${p.x}`, p.y, p.evidence_span_id, s.unit); break;
        case 'table':
            // WHOLLY-numeric table cells are factual claims (audit H4/H8/H10): cited →
            // grounded against its span; UNCITED → no span → ungrounded blocker. Label
            // cells that merely contain a digit ("Q3", "FY24") are NOT numbers — skipped.
            for (const row of v.rows) for (const c of row.cells) {
                const cellText = (c.value ?? c.text).trim();
                if (NUMERIC_CELL_RE.test(cellText)) out.push({ claim: cellText, spanId: c.evidence_span_id });
            }
            break;
        case '2x2':
            // A 2×2 item LABEL that carries a number ("$50M revenue") is a factual
            // claim (consolidated gate H3) — ground it against the item's citation.
            for (const it of v.items) if (/\d/.test(it.label)) out.push({ claim: it.label, spanId: it.evidence_span_id });
            break;
        case 'harvey':
            // Same for a harvey ROW label that carries a number (the 0-4 ratings are
            // subjective scores, not source figures — not grounded).
            for (const r of v.rows) if (/\d/.test(r.label)) out.push({ claim: r.label, spanId: r.evidence_span_id });
            break;
        default: break; // pyramid carries concept labels with no citations — grounded as text
    }
    return out;
}

/**
 * Deterministic self-check over a whole storyboard against its evidence catalog.
 * (1) every cited evidence_span_id must exist (no dangling); (2) each rendered
 * factual claim (title + core_message + visual_data numerics) is tiered.
 * Pure — no LLM. The orchestrator routes `inferential` to the judge + treats
 * `ungrounded` / dangling as blockers.
 */
export function selfCheckStoryboard(storyboard: ConsultantStoryboard, catalog: readonly EvidenceSpan[]): GroundingReport {
    const byId = new Map(catalog.map((s) => [s.id, s]));
    const checks: ClaimCheck[] = [];
    const dangling = new Set<string>();

    const resolve = (ids: readonly string[]): EvidenceSpan[] => {
        const spans: EvidenceSpan[] = [];
        for (const id of ids) { const s = byId.get(id); if (s) spans.push(s); else dangling.add(id); }
        return spans;
    };

    for (const slide of storyboard.slides) {
        const titleSpans = resolve(slide.evidence_span_ids);
        checks.push(checkClaim(slide.action_title, titleSpans, { slideId: slide.id, field: 'action_title' }));
        checks.push(checkClaim(slide.core_message, titleSpans, { slideId: slide.id, field: 'core_message' }));
        // visual_data numerics resolve against THEIR own per-value spans.
        const vIds = visualEvidenceIds(slide.visual_data);
        resolve(vIds); // surfaces dangling visual ids
        for (const vc of visualNumericClaims(slide.visual_data)) {
            // An uncited numeric claim resolves to NO spans → ungrounded (audit H10).
            checks.push(checkClaim(vc.claim, vc.spanId ? resolve([vc.spanId]) : [], { slideId: slide.id, field: 'visual_data' }));
        }
    }

    return {
        checks,
        danglingSpanIds: [...dangling],
        blockers: checks.filter((c) => c.tier === 'ungrounded'),
        inferential: checks.filter((c) => c.tier === 'inferential'),
    };
}

/** Blind audit payload for the LLM inferential tier — `{claim, cited_spans}` ONLY. */
export function buildGroundingAuditPayload(check: ClaimCheck, catalog: readonly EvidenceSpan[]): { claim: string; cited_spans: string[] } {
    const byId = new Map(catalog.map((s) => [s.id, s]));
    return { claim: check.claim, cited_spans: check.citedSpanIds.map((id) => byId.get(id)?.text ?? '').filter(Boolean) };
}

/** A slide is shippable when no rendered number is a blocker. */
export function slideIsGrounded(report: GroundingReport, slide: StoryboardSlide): boolean {
    // Conservative (audit H3/H6 — no fail-open): grounded only when the slide has no
    // blocker, no dangling ref, AND no INFERENTIAL (cited-but-unverified) number — an
    // inferential claim needs the LLM judge's verdict before it can be called grounded.
    return !report.blockers.some((b) => b.slideId === slide.id)
        && !report.inferential.some((c) => c.slideId === slide.id)
        && !report.danglingSpanIds.length; // dangling anywhere is a contract break
}
