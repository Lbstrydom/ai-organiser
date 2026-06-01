/**
 * Selective per-slide deck refine.
 *
 * Refines ONLY the user-selected slide indices and keeps every other slide
 * byte-identical — an all-or-nothing splice contract: if ANY validation layer
 * fails, the deck is left untouched and the caller gets `Result.err`.
 *
 * Each selected slide may come back as ONE slide (in-place polish) or SEVERAL
 * (a controlled 1→N split when a slide is overloaded). The extra slides are
 * inserted at the selected position, shifting later slides; the original
 * slide.id is preserved on the first replacement and fresh unique ids are
 * assigned to the rest. Unselected slides are never touched.
 *
 * One self-repair (mirrors whole-deck `refineDeckIr`) recovers a recoverable
 * miscount/shape error before failing back to the modal.
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

/** Upper bound on slides a single selected slide may split into — keeps a
 *  "split" controlled and the deck under the schema's 60-slide cap. */
const MAX_SLIDES_PER_SPLIT = 4;

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

        // Validate + splice. The LLM commonly miscounts when a finding implies a
        // split ("slide is overloaded → split into multiple slides"), so on a
        // recoverable failure we re-ask ONCE, echoing the error + the exact
        // required indices. One repair only (mirrors whole-deck refineDeckIr).
        let result = validateAndSplice(raw.content, options, reqIndices);
        if (!result.ok && isRecoverableError(result.error) && !options.signal?.aborted) {
            const repairPrompt = buildSelectiveRepairPrompt(userPrompt, raw.content, result.error, reqIndices);
            let retry: LLMCallResult;
            try {
                retry = await summarizeText(context, `${systemPrompt}\n\n${repairPrompt}`, {
                    timeoutMs: REFINEMENT_HARD_BUDGET_MS,
                    signal: options.signal,
                    disableThinking: true,
                });
            } catch (e) {
                if (options.signal?.aborted || (e instanceof Error && e.name === 'AbortError')) {
                    return errCode('aborted', 'signal aborted during repair');
                }
                return result; // keep the original (more specific) error
            }
            if (options.signal?.aborted) return errCode('aborted', 'signal aborted during repair');
            if (retry.success && retry.content) {
                const repaired = validateAndSplice(retry.content, options, reqIndices);
                result = repaired.ok ? repaired : result; // keep first error if repair still bad
            }
        }
        return result;
    } catch (e) {
        // Defence-in-depth: any unanticipated throw → typed Result.err.
        logger.warn('Presentation', `Selective refine threw: ${e instanceof Error ? e.message : String(e)}`);
        return errCode('unexpected-exception', e instanceof Error ? e.message : String(e));
    }
}

/**
 * Shape-check the already-extracted JSON object (from `tryExtractJson`) into a
 * `{ slideIndex, slides: unknown[] }[]`. Each entry's `slides` is the 1+
 * replacement slides for that index (1 = in-place polish, >1 = split).
 * Tolerant of the singular `slide` form too, in case the LLM emits it.
 * Per-slide `SlideIrSchema` validation happens upstream in `validateAndSplice`.
 */
function parseSliceReplacements(
    json: unknown,
): Result<Array<{ slideIndex: number; slides: unknown[] }>> {
    if (json === null || typeof json !== 'object') {
        return err('no JSON object found in response');
    }
    const slices = (json as { slices?: unknown }).slices;
    if (!Array.isArray(slices)) {
        return err('missing or non-array "slices" field');
    }
    const out: Array<{ slideIndex: number; slides: unknown[] }> = [];
    for (const entry of slices) {
        if (!entry || typeof entry !== 'object') {
            return err('slice entry is not an object');
        }
        const e = entry as { slideIndex?: unknown; slides?: unknown; slide?: unknown };
        const idx = e.slideIndex;
        if (typeof idx !== 'number' || !Number.isInteger(idx)) {
            return err('slice entry missing integer "slideIndex"');
        }
        let slides: unknown[];
        if (Array.isArray(e.slides)) slides = e.slides;
        else if ('slide' in e) slides = [e.slide];          // tolerate singular form
        else return err(`slice entry for index ${idx} missing "slides"`);
        if (slides.length === 0) return err(`slice entry for index ${idx} has empty "slides"`);
        out.push({ slideIndex: idx, slides });
    }
    return ok(out);
}

/** Generate a unique slide id derived from `base`, not already in `used`. */
function freshId(base: string, used: Set<string>): string {
    const stem = base.length > 56 ? base.slice(0, 56) : base;
    for (let n = 2; n < 1000; n++) {
        const id = `${stem}-${n}`;
        if (!used.has(id)) return id;
    }
    return `${stem}-${used.size}`;
}

/**
 * Parse + layered-validate + splice one LLM response into a spliced deck.
 * Pure (no LLM call) so it can run on both the first response and the repair.
 */
function validateAndSplice(
    content: string,
    options: SelectiveRefineInput,
    reqIndices: number[],
): Result<SlideDeckIr> {
    const parsed = parseSliceReplacements(tryExtractJson(content));
    if (!parsed.ok) return errCode('malformed-json', parsed.error);
    // Exactly one ENTRY per requested slideIndex (each entry may carry 1+ slides).
    if (parsed.value.length !== options.selections.length) {
        return errCode('shape-mismatch', `expected ${options.selections.length} slice entries, got ${parsed.value.length}`);
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

    // Validate each replacement slide; collect index → validated slides[] (1+).
    const replacementByIndex = new Map<number, SlideIr[]>();
    for (const entry of parsed.value) {
        if (entry.slides.length > MAX_SLIDES_PER_SPLIT) {
            return errCode('shape-mismatch', `slideIndex=${entry.slideIndex} returned ${entry.slides.length} slides (max ${MAX_SLIDES_PER_SPLIT} per split)`);
        }
        const validated: SlideIr[] = [];
        for (const rawSlide of entry.slides) {
            const check = SlideIrSchema.safeParse(rawSlide);
            if (!check.success) {
                return errCode('invalid-slide-schema', `slideIndex=${entry.slideIndex}: ${check.error.issues[0]?.message ?? 'invalid'}`);
            }
            validated.push(check.data);
        }
        replacementByIndex.set(entry.slideIndex, validated);
    }

    // Splice with expansion: at each selected index, insert the 1+ replacement
    // slides (shifting later slides). The FIRST replacement keeps the original
    // slide.id (stable editor/version refs); extras get fresh unique ids.
    const usedIds = new Set(options.currentDeck.slides.map(s => s.id));
    const newSlides: SlideIr[] = [];
    options.currentDeck.slides.forEach((slide, i) => {
        const repl = replacementByIndex.get(i);
        if (!repl) { newSlides.push(slide); return; }
        repl.forEach((rs, k) => {
            if (k === 0) {
                newSlides.push({ ...rs, id: slide.id });
            } else {
                const id = freshId(slide.id, usedIds);
                usedIds.add(id);
                newSlides.push({ ...rs, id });
            }
        });
    });

    const candidate: SlideDeckIr = { ...options.currentDeck, slides: newSlides };
    const deckCheck = validateDeckIr(candidate);
    if (!deckCheck.ok) return errCode('invalid-deck-after-splice', deckCheck.error);
    return ok(deckCheck.value);
}

/** Post-LLM failures that a single corrective re-ask can plausibly fix (shape /
 *  index / JSON / schema). Transport + pre-LLM codes are NOT retried here. */
const RECOVERABLE_CODES: ReadonlySet<RefineErrorCode> = new Set([
    'malformed-json', 'shape-mismatch', 'duplicate-returned-index',
    'index-set-mismatch', 'invalid-slide-schema', 'invalid-deck-after-splice',
]);
function isRecoverableError(errStr: string): boolean {
    const code = parseRefineErrorCode(errStr);
    return code !== null && RECOVERABLE_CODES.has(code);
}

/** Corrective re-ask: echo the validation error + the exact required indices and
 *  restate the fixed-count / no-split contract. */
function buildSelectiveRepairPrompt(
    originalUserPrompt: string,
    badOutput: string,
    errorStr: string,
    reqIndices: number[],
): string {
    const snippet = badOutput.length > 6_000 ? `${badOutput.slice(0, 6_000)}\n…[truncated]` : badOutput;
    const sortedReq = [...reqIndices].sort((a, b) => a - b);
    return `Your previous response did not satisfy the selective-refine contract.

<validation_error>${errorStr}</validation_error>

<your_previous_output>
${snippet}
</your_previous_output>

Return ONE JSON object with a "slices" array containing EXACTLY ${reqIndices.length} entries — one entry per slideIndex in [${sortedReq.join(', ')}]: no extra indices, no missing indices, no duplicates. Each entry is { "slideIndex": number, "slides": [ Slide, ... ] }; the "slides" array holds the 1+ replacement slides for that index (use more than one only to split a genuinely overloaded slide). Do NOT touch any other slide. No code fences, no prose.

Original request, for reference:
${originalUserPrompt}`;
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
- Modify ONLY the slides listed in <selected_slides>. The slideIndex value shown there is the 0-based key you must use in the "slices" output array. NEVER add, remove, or modify any slide that is not listed there.
- Use the deck in <read_only_context> for tone, terminology, and structural consistency, but do NOT emit replacements for those slides.
- Output a single JSON object with one top-level field "slices", an array of { "slideIndex": number, "slides": [ Slide, ... ] }.
- Return EXACTLY one entry per requested slideIndex (${selections.length} entries total) — no extra indices, no missing indices, no duplicates.
- Each entry's "slides" array normally holds ONE replacement slide (an in-place polish). Return MORE than one ONLY when the slide is genuinely overloaded and the instruction asks to split it — then divide its content across 2-3 well-balanced slides (max ${MAX_SLIDES_PER_SPLIT}). Do not split unnecessarily; prefer condensing for minor overflow.
- Every replacement slide MUST conform to the SlideIr schema (same Slide shape described above).
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
{ "slices": [ { "slideIndex": 0, "slides": [ { /* Slide */ } ] } ] }
</output_format>`;
}
