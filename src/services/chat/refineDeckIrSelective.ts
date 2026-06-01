/**
 * Selective per-slide deck refine.
 *
 * This service replaces ONLY the user-selected slide indices with LLM output and keeps
 * every other slide byte-identical — an all-or-nothing splice contract:
 * if ANY validation layer fails, the deck is left untouched and the caller
 * gets `Result.err` (plan §2.2 invariant).
 *
 * Single LLM call, NO 1-repair (plan §2.3) — on malformed output the service
 * returns `Result.err` and the modal keeps the user's draft for a manual
 * retry. The whole-deck path keeps its 1-repair shape; the divergence is
 * intentional (plan Risk #15 / §6 migration path).
 *
 * Lives alongside `presentationHtmlService.ts` (the whole-deck `refineDeckIr`
 * owner) in `src/services/chat/` so the two refine paths sit side-by-side.
 */

import { ok, err, type Result } from '../../core/result';
import {
    SlideIrSchema, validateDeckIr,
    type SlideDeckIr, type SlideIr,
} from '../presentationIr/slideIr';
import { isContentTooLarge } from '../tokenLimits';
import { tryExtractJson } from '../../utils/responseParser';
import { summarizeText, getServiceType, type LLMFacadeContext, type LLMCallResult } from '../llmFacade';
import { buildIrSystemPrompt } from '../presentationIr/irPrompts';
import { REFINEMENT_HARD_BUDGET_MS } from './presentationConstants';
import { logger } from '../../utils/logger';
import type { QualityFinding } from './presentationTypes';
import type { RefineErrorCode } from './refineDeckIrSelectiveTypes';
import { REFINE_ERROR_CODES } from './refineDeckIrSelectiveTypes';

export type { RefineErrorCode } from './refineDeckIrSelectiveTypes';

export interface SelectiveRefineInput {
    currentDeck: SlideDeckIr;
    /** 0-based slide indices + the per-slide instruction text. Array shape
     *  (not Set) so a duplicate slideIndex is rejected explicitly. */
    selections: ReadonlyArray<{ slideIndex: number; instruction: string }>;
    /** Deck-wide findings (slideIndex === undefined) — sent as read-only
     *  context so the LLM honours whole-deck conventions while still only
     *  emitting the selected slices (plan §4.6.2). */
    deckWideFindings?: readonly QualityFinding[];
    outputLanguage?: string;
    signal?: AbortSignal;
}

/** Encode a typed code as the colon-prefix of the canonical Result error. */
function errCode(code: RefineErrorCode, detail = ''): Result<never> {
    return err(`${code}: ${detail}`);
}

/** Parse the leading "<code>:" prefix back into a `RefineErrorCode`, or null
 *  if the string isn't one of ours (caller falls back to a generic code). */
export function parseRefineErrorCode(errStr: string): RefineErrorCode | null {
    const colon = errStr.indexOf(':');
    if (colon < 0) return null;
    const cand = errStr.slice(0, colon).trim();
    return REFINE_ERROR_CODES.has(cand as RefineErrorCode) ? (cand as RefineErrorCode) : null;
}

/**
 * Refine only the selected slides of a deck IR. Never throws — every failure
 * path is a typed `Result.err('<code>: <detail>')` so the modal/handler can
 * rely on the contract (plan §4.2, audit-r2 H4).
 */
export async function refineDeckIrSelective(
    context: LLMFacadeContext,
    options: SelectiveRefineInput,
): Promise<Result<SlideDeckIr>> {
    try {
        // ── Pre-LLM validation (fail-fast, no network) ──────────────────────
        if (options.signal?.aborted) return errCode('aborted', 'signal pre-aborted');
        if (options.selections.length === 0) return errCode('empty-selections');

        const reqIndices = options.selections.map(s => s.slideIndex);
        if (new Set(reqIndices).size !== reqIndices.length) {
            return errCode('duplicate-selection-index', 'selections contains duplicate slideIndex');
        }

        const deckSize = options.currentDeck.slides.length;
        for (const sel of options.selections) {
            if (sel.slideIndex < 0 || sel.slideIndex >= deckSize || !Number.isInteger(sel.slideIndex)) {
                return errCode('selection-out-of-range', `slideIndex=${sel.slideIndex} not in [0,${deckSize})`);
            }
        }

        // Assemble the exact prompt first so the budget guard measures the FULL
        // payload that goes on the wire — system prompt + scaffolding + minified
        // deck + selections — not just the deck (audit M1, gemini-gate r3 F2/F3).
        const systemPrompt = buildIrSystemPrompt({ outputLanguage: options.outputLanguage });
        const userPrompt = buildSelectivePrompt(options.currentDeck, options.selections, options.deckWideFindings ?? []);
        const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

        // Provider-aware token-budget guard (plan §2.3 + gemini-gate). Uses the
        // SSOT `isContentTooLarge` so the limit scales with the bound provider.
        const provider = getServiceType(context).provider;
        if (isContentTooLarge(fullPrompt, provider)) {
            return errCode('deck-too-large', `${fullPrompt.length} chars exceeds ${provider} limit`);
        }

        // ── LLM call (single, no 1-repair — plan §2.3) ──────────────────────
        let raw: LLMCallResult;
        try {
            raw = await summarizeText(context, fullPrompt, {
                timeoutMs: REFINEMENT_HARD_BUDGET_MS,
                signal: options.signal,
                disableThinking: true,
            });
        } catch (e) {
            if (options.signal?.aborted || (e instanceof Error && e.name === 'AbortError')) {
                return errCode('aborted', 'signal aborted during LLM call');
            }
            return errCode('llm-call-failed', e instanceof Error ? e.message : String(e));
        }
        if (options.signal?.aborted) return errCode('aborted', 'signal aborted during LLM call');
        if (!raw.success || !raw.content) return errCode('llm-call-failed', raw.error ?? 'empty response');

        // ── Post-LLM validation (layered, fail-fast) ────────────────────────
        const parsed = parseSliceReplacements(tryExtractJson(raw.content));
        if (!parsed.ok) return errCode('malformed-json', parsed.error);
        if (parsed.value.length !== options.selections.length) {
            return errCode('shape-mismatch', `expected ${options.selections.length}, got ${parsed.value.length}`);
        }

        const retIndices = parsed.value.map(r => r.slideIndex);
        if (new Set(retIndices).size !== retIndices.length) {
            return errCode('duplicate-returned-index', `[${retIndices.join(',')}]`);
        }
        const sortedReq = [...reqIndices].sort((a, b) => a - b);
        const sortedRet = [...retIndices].sort((a, b) => a - b);
        if (sortedReq.length !== sortedRet.length || sortedReq.some((x, i) => x !== sortedRet[i])) {
            return errCode('index-set-mismatch', `req=[${sortedReq.join(',')}], got=[${sortedRet.join(',')}]`);
        }

        // Per-slice schema validation (Zod). On any failure → no splice.
        const replacementByIndex = new Map<number, SlideIr>();
        for (const r of parsed.value) {
            const sliceCheck = SlideIrSchema.safeParse(r.slide);
            if (!sliceCheck.success) {
                return errCode('invalid-slide-schema', `slideIndex=${r.slideIndex}: ${sliceCheck.error.issues[0]?.message ?? 'invalid'}`);
            }
            replacementByIndex.set(r.slideIndex, sliceCheck.data);
        }

        // Splice — shallow-copy deck + slides array, structural-share unselected
        // slides. Force-preserve the original slide.id on every replacement so
        // editor refs / version-restore correlation survive (gemini-gate r3 F1).
        const candidate: SlideDeckIr = {
            ...options.currentDeck,
            slides: options.currentDeck.slides.map((slide, i) => {
                const replacement = replacementByIndex.get(i);
                return replacement ? { ...replacement, id: slide.id } : slide;
            }),
        };

        // Deck-level invariant check — returns the project Result<T> (not Zod).
        const deckCheck = validateDeckIr(candidate);
        if (!deckCheck.ok) {
            return errCode('invalid-deck-after-splice', deckCheck.error);
        }
        return ok(deckCheck.value);
    } catch (e) {
        // Defence-in-depth: any unanticipated throw → typed Result.err.
        logger.warn('Presentation', `Selective refine threw: ${e instanceof Error ? e.message : String(e)}`);
        return errCode('unexpected-exception', e instanceof Error ? e.message : String(e));
    }
}

/**
 * Shape-check the already-extracted JSON object (from `tryExtractJson`) into a
 * `{ slideIndex, slide }[]`. Per-slice `SlideIrSchema.parse` happens upstream
 * (Layer c) — this only verifies the envelope is structurally a slices array.
 */
function parseSliceReplacements(
    json: unknown,
): Result<Array<{ slideIndex: number; slide: unknown }>> {
    if (json === null || typeof json !== 'object') {
        return err('no JSON object found in response');
    }
    const slices = (json as { slices?: unknown }).slices;
    if (!Array.isArray(slices)) {
        return err('missing or non-array "slices" field');
    }
    const out: Array<{ slideIndex: number; slide: unknown }> = [];
    for (const entry of slices) {
        if (!entry || typeof entry !== 'object') {
            return err('slice entry is not an object');
        }
        const idx = (entry as { slideIndex?: unknown }).slideIndex;
        if (typeof idx !== 'number' || !Number.isInteger(idx)) {
            return err('slice entry missing integer "slideIndex"');
        }
        if (!('slide' in entry)) {
            return err(`slice entry for index ${idx} missing "slide"`);
        }
        out.push({ slideIndex: idx, slide: (entry as { slide: unknown }).slide });
    }
    return ok(out);
}

/** Format one finding as a single instruction line. */
function formatFinding(f: QualityFinding): string {
    return `[${f.severity}] ${f.issue} → ${f.suggestion}`;
}

/**
 * Build the selective-refine user prompt (plan §4.6.3). Tagged-section style;
 * the deck IR is minified read-only context, the selected slices carry 0-based
 * `slideIndex` keys matching the required JSON output (gemini-gate r2 F1).
 */
export function buildSelectivePrompt(
    deck: SlideDeckIr,
    selections: ReadonlyArray<{ slideIndex: number; instruction: string }>,
    deckWideFindings: readonly QualityFinding[],
): string {
    const deckWide = deckWideFindings.length > 0
        ? deckWideFindings.map(formatFinding).join('\n')
        : '(none)';
    const deckWideNote = deckWideFindings.length > 0
        ? '- Honour the whole-deck issues in <deck_wide_findings> for tone/consistency, but still emit replacements ONLY for the selected slides.'
        : '';
    const selectedBlocks = selections.map(sel => {
        const slide = deck.slides[sel.slideIndex];
        const label = `Slide ${sel.slideIndex + 1}: ${slide?.title ?? '(untitled)'}`;
        const instruction = sel.instruction.trim() || '(no specific instruction — improve clarity, hierarchy, and concision)';
        return `slideIndex: ${sel.slideIndex}    (${label})\nInstruction:\n${instruction}`;
    }).join('\n\n');

    return `<task>
Polish specific slides in a presentation deck while preserving the rest of the deck verbatim.
</task>

<requirements>
- Modify ONLY the slides listed in <selected_slides>. The slideIndex value shown there is the 0-based key you must use in the "slices" output array.
- Use the deck in <read_only_context> for tone, terminology, and structural consistency, but do NOT emit replacements for those slides.
- Each replacement slide MUST conform to the SlideIr schema (same Slide shape described above).
- Output a single JSON object with one top-level field "slices", an array of { "slideIndex": number, "slide": Slide }.
- The "slices" array MUST contain exactly one entry per requested slideIndex, in any order.
- Do NOT wrap the output in code fences. Do NOT include explanatory prose before or after the JSON.
${deckWideNote}
</requirements>

<read_only_context>
${JSON.stringify(deck)}
</read_only_context>

<deck_wide_findings>
${deckWide}
</deck_wide_findings>

<selected_slides>
${selectedBlocks}
</selected_slides>

<output_format>
{ "slices": [ { "slideIndex": 0, "slide": { /* Slide */ } } ] }
</output_format>`;
}
