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
import { generateStoryboard, generateRevisedStoryboard, translateStoryboardToIr } from '../presentationIr/storyboardService';
import type { GenerateStoryboardOptions } from '../presentationIr/storyboardService';
import type { StorylineComment } from '../presentationIr/storyboardPrompts';
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
    const audit = await auditStoryboardWithJudge(generated.value, grounding, options.judge, { outputLanguage: options.outputLanguage });
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
    outputLanguage?: string,
): Result<DeckFromStorylineResult> {
    const parsed = markdownToStoryboard(storylineMarkdown);
    if (!parsed.ok) return parsed;
    const grounding = selfCheckStoryboard(parsed.value.storyboard, catalog);
    const audit = auditStoryboard(parsed.value.storyboard, grounding, { outputLanguage });
    const deck = translateStoryboardToIr(parsed.value.storyboard);
    if (!deck.ok) return deck;
    return ok({ deck: deck.value, grounding, audit, comments: parsed.value.comments });
}

/** auto-build path: storyboard → IR directly (no markdown round-trip). */
export function buildDeckFromStoryboard(storyboard: ConsultantStoryboard): Result<SlideDeckIr> {
    return translateStoryboardToIr(storyboard);
}

/**
 * Conversational revision step: apply the user's request (+ reviewer comments) to
 * the current storyboard, then re-ground + re-audit + re-render the storyline. The
 * caller writes the new markdown back to the note and stays in review. Same
 * `StoryboardStageResult` shape as `runStoryboardStage`.
 */
export async function reviseStoryboard(
    context: LLMFacadeContext,
    current: ConsultantStoryboard,
    request: string,
    comments: readonly StorylineComment[],
    catalog: readonly EvidenceSpan[],
    options: StoryboardStageOptions = {},
): Promise<Result<StoryboardStageResult>> {
    const revised = await generateRevisedStoryboard(context, current, request, comments, catalog, options);
    if (!revised.ok) return revised;
    const grounding = selfCheckStoryboard(revised.value, catalog);
    const audit = await auditStoryboardWithJudge(revised.value, grounding, options.judge, { outputLanguage: options.outputLanguage });
    const storylineMarkdown = storyboardToMarkdown(revised.value, { bySlide: audit.bySlide, deckName: options.deckName });
    return ok({ storyboard: revised.value, grounding, audit, storylineMarkdown });
}

// Bare approval / build commands → commit to slides. Anything else (incl. a
// change request like "make slide 2 a 2x2") → revise the storyline.
// The slides matcher is anchored at the START (a leading build verb + a
// slides/deck/presentation noun) but allows TRAILING words, so the phrase the
// storyline note instructs — "Build slides from this storyline" — triggers a
// build instead of being misread as a revision. `make slide 3 a 2x2` still
// revises (no leading build verb); `create a 2x2 deck` still revises (the 2x2
// breaks the verb→noun adjacency).
const BUILD_SLIDES_RE = /^(build|generate|create)\s+(the\s+|a\s+|this\s+)?(slides?|deck|presentation)\b/;
const BUILD_APPROVE_RE = /^(build|go|proceed|done|approve|ship it|go ahead|looks good|perfect|yes|ok|okay)( it)?$/;

/** True when the message is a clear "build the slides now" / approval (not a revision request). */
export function looksLikeBuildCommand(message: string): boolean {
    const m = message.trim().toLowerCase().replace(/[.!]+$/, '').replace(/\s+/g, ' ');
    return BUILD_SLIDES_RE.test(m) || BUILD_APPROVE_RE.test(m);
}
