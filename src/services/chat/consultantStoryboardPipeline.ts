/**
 * Consultant storyboard pipeline (plan Cluster A) — the thin orchestrator that
 * composes the pure content-spine services into the two seams the presentation
 * handler calls:
 *
 *   1. `runStoryboardStage` — brief + evidence → generate storyboard → ground →
 *      structural-audit → render the dot-dash storyline `.md`. (The pre-IR stage.)
 *   2. `buildDeckFromStoryline` — the user-edited storyline `.md` → parse → re-ground
 *      → re-audit → DETERMINISTIC translate → `SlideDeckIr`. (After sign-off.)
 *
 * Extracted (not inlined into the 1500-line handler) so the composition is pure +
 * unit-testable; the handler keeps only the UI gate (write note / open / command).
 * The LLM judge is an injected seam (Cluster D supplies the cross-family critic).
 */
import type { Result } from '../../core/result';
import { ok } from '../../core/result';
import type { LLMFacadeContext } from '../llmFacade';
import type { SlideDeckIr } from '../presentationIr/slideIr';
import type { ConsultantStoryboard, EvidenceSpan } from '../presentationIr/consultantStoryboard';
import type { GroundingReport } from '../presentationIr/evidenceGrounding';
import { selfCheckStoryboard } from '../presentationIr/evidenceGrounding';
import { generateStoryboard, translateStoryboardToIr } from '../presentationIr/storyboardService';
import type { GenerateStoryboardOptions } from '../presentationIr/storyboardService';
import { storyboardToMarkdown } from '../presentationIr/dotDashSerializer';
import { markdownToStoryboard } from '../presentationIr/dotDashParser';
import type { StructuralAuditResult, StoryboardJudge } from './consultantAuditService';
import { auditStoryboard, auditStoryboardWithJudge } from './consultantAuditService';

export interface StoryboardStageOptions extends GenerateStoryboardOptions {
    deckName?: string;
    /** Optional LLM judge for the MECE/laddering residue (Cluster D critic). */
    judge?: StoryboardJudge;
}

export interface StoryboardStageResult {
    readonly storyboard: ConsultantStoryboard;
    readonly grounding: GroundingReport;
    readonly audit: StructuralAuditResult;
    /** The dot-dash storyline note (written to the vault for the review gate). */
    readonly storylineMarkdown: string;
}

/**
 * The pre-IR stage: generate a grounded, audited storyboard and render the
 * storyline `.md`. The handler writes `storylineMarkdown` to a note for sign-off
 * (gate='review'), or proceeds straight to `translateStoryboardToIr` (gate='auto-build').
 */
export async function runStoryboardStage(
    context: LLMFacadeContext,
    brief: string,
    catalog: readonly EvidenceSpan[],
    options: StoryboardStageOptions = {},
): Promise<Result<StoryboardStageResult>> {
    const generated = await generateStoryboard(context, brief, catalog, options);
    if (!generated.ok) return generated;
    const grounding = selfCheckStoryboard(generated.value, catalog);
    const audit = await auditStoryboardWithJudge(generated.value, grounding, options.judge);
    const storylineMarkdown = storyboardToMarkdown(generated.value, { bySlide: audit.bySlide, deckName: options.deckName });
    return ok({ storyboard: generated.value, grounding, audit, storylineMarkdown });
}

export interface DeckFromStorylineResult {
    readonly deck: SlideDeckIr;
    readonly grounding: GroundingReport;
    readonly audit: StructuralAuditResult;
    readonly comments: ReadonlyArray<{ slideId: string; comment: string }>;
}

/**
 * After sign-off: turn the (possibly edited) storyline `.md` into a `SlideDeckIr`.
 * Re-grounds + re-audits the edited storyboard (the user may have changed claims),
 * then deterministically translates. Returns the comments so the caller can route
 * them to a targeted revision instead of a full rebuild. Pure (no LLM).
 */
export function buildDeckFromStoryline(
    storylineMarkdown: string,
    catalog: readonly EvidenceSpan[],
): Result<DeckFromStorylineResult> {
    const parsed = markdownToStoryboard(storylineMarkdown);
    if (!parsed.ok) return parsed;
    const grounding = selfCheckStoryboard(parsed.value.storyboard, catalog);
    const audit = auditStoryboard(parsed.value.storyboard, grounding);
    const deck = translateStoryboardToIr(parsed.value.storyboard);
    if (!deck.ok) return deck;
    return ok({ deck: deck.value, grounding, audit, comments: parsed.value.comments });
}

/** auto-build path: storyboard → IR directly (no markdown round-trip). */
export function buildDeckFromStoryboard(storyboard: ConsultantStoryboard): Result<SlideDeckIr> {
    return translateStoryboardToIr(storyboard);
}
