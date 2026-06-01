/**
 * Prompts for the LLM-emits-IR generation path (Phase B). The model returns a
 * `SlideDeckIr` JSON object conforming to `slideIr.ts`; the renderers turn it
 * into HTML (preview) and PPTX (export) deterministically.
 *
 * `parseIrFromResponse` is PURE (extract-JSON + Zod only — NO LLM call, plan
 * M4). The service layer owns the LLM call, the 1-retry repair, and progress.
 */

import type { Result } from '../../core/result';
import { err } from '../../core/result';
import { tryExtractJson } from '../../utils/responseParser';
import { IR_SCHEMA_VERSION, validateDeckIr, type SlideDeckIr } from './slideIr';

/** A compact `(brief → IR)` example. Kept small to bound prompt cost. */
const FEW_SHOT = `<example>
Brief: "One title slide and one slide on coffee market scale with four key numbers."
IR:
{
  "schemaVersion": ${IR_SCHEMA_VERSION},
  "title": "Coffee market",
  "slides": [
    { "id": "s1", "type": "title", "title": "Coffee market", "subtitle": "Scale of the global trade", "blocks": [] },
    { "id": "s2", "type": "content", "title": "A vast market", "blocks": [
      { "kind": "paragraph", "text": "Coffee is the second most traded commodity by value." },
      { "kind": "stat-grid", "cards": [
        { "value": "$100B+", "label": "Retail market value" },
        { "value": "125M", "label": "Livelihoods supported" },
        { "value": "10B kg", "label": "Produced per year" },
        { "value": "70+", "label": "Producing countries" }
      ] }
    ] }
  ]
}
</example>`;

/**
 * System prompt instructing the model to emit a `SlideDeckIr` JSON object.
 * Enumerates the exact block vocabulary + invariants the Zod schema enforces,
 * so the first attempt validates as often as possible.
 */
export function buildIrSystemPrompt(options: { outputLanguage?: string; targetLength?: number } = {}): string {
    const langLine = options.outputLanguage ? `\nWrite all slide text in ${options.outputLanguage}.` : '';
    const countLine = options.targetLength
        ? `\nIMPORTANT: produce EXACTLY ${options.targetLength} slides in total — counting the title slide and the closing slide. This slide count is a hard requirement set by the user; do not produce more or fewer.`
        : '';
    return `You are a presentation designer. You output a STRUCTURED JSON deck (an "IR"), NOT HTML.${langLine}${countLine}

<output_format>
Return ONLY one JSON object (no prose, no markdown fences) of this shape:
{ "schemaVersion": ${IR_SCHEMA_VERSION}, "title": "Deck title", "slides": [ Slide, ... ] }

Slide = { "id": "unique-string", "type": "title"|"section"|"content"|"closing",
          "title"?: string, "subtitle"?: string, "blocks": Block[], "notes"?: string }
- title / section / closing slides MUST have "blocks": [] (use title + subtitle only).
- Only "content" slides carry blocks. Give every slide a UNIQUE id.

Block (discriminated by "kind"):
- { "kind": "heading", "text": string, "level": 1|2|3 }
- { "kind": "paragraph", "text": string, "emphasis"?: boolean }
- { "kind": "bullets", "items": string[], "ordered"?: boolean }    // 1–12 items
- { "kind": "stat-grid", "cards": [ { "value": string, "label": string } ] }   // 1–6 cards
- { "kind": "bar-chart", "bars": [ { "label": string, "pct": number, "color"?: "RRGGBB" } ], "caption"?: string }  // pct 0–100, 1–12 bars
- { "kind": "process-flow", "steps": [ { "title": string, "sub"?: string } ] }  // 2–8 steps
- { "kind": "two-column", "left": Block[], "right": Block[] }   // ONE level only — no nested two-column
- { "kind": "table", "headers": string[], "rows": string[][] }  // every row length === headers length
- { "kind": "callout", "text": string, "cite"?: string, "variant"?: "info"|"warn" }
- { "kind": "caption", "text": string }
</output_format>

<requirements>
- Use the RIGHT block for the data: numbers → stat-grid or bar-chart; steps/pipeline → process-flow; comparisons → table or two-column. Avoid walls of bullets.
- ${options.targetLength ? `Produce EXACTLY ${options.targetLength} slides total (title + content + closing) — match this count precisely.` : '6–10 slides for a normal deck unless the user asks for a specific count.'} One idea per slide.
- "color" must be a 6-digit hex WITHOUT '#'. No extra/unknown JSON keys (they are rejected).
- Output MUST be valid JSON and nothing else.
</requirements>

${FEW_SHOT}`;
}

/**
 * Refine prompt — edits an EXISTING deck IR per a user request. Sends the
 * current IR + the change and asks for the complete updated IR, so subsequent
 * rounds stay IR-backed (and exportable to faithful PPTX).
 */
export function buildIrRefinePrompt(currentDeck: SlideDeckIr, userRequest: string): string {
    return `You are editing an existing structured slide deck (IR JSON).

<current_deck>
${JSON.stringify(currentDeck)}
</current_deck>

<edit_request>
${userRequest}
</edit_request>

Apply the requested change, preserving all other slides and content unless the request says otherwise. Return the COMPLETE updated deck as ONE JSON object conforming to the same schema (schemaVersion ${IR_SCHEMA_VERSION}). No prose, no markdown fences.`;
}

/** Repair prompt — re-asks for corrected JSON after a validation failure. */
export function buildIrRepairPrompt(badOutput: string, validationError: string): string {
    const snippet = badOutput.length > 6_000 ? badOutput.slice(0, 6_000) + '\n…[truncated]' : badOutput;
    return `Your previous response was not a valid deck IR.

<validation_error>${validationError}</validation_error>

<your_previous_output>
${snippet}
</your_previous_output>

Return ONLY a corrected JSON deck object that fixes the error above and conforms exactly to the schema. No prose, no markdown fences.`;
}

/**
 * PURE parse: extract a JSON object from an LLM response and validate it as a
 * `SlideDeckIr`. No LLM call. Returns `Result` so the service can decide to
 * repair-retry or fall back.
 */
export function parseIrFromResponse(raw: string): Result<SlideDeckIr> {
    if (!raw?.trim()) return err('empty response');
    const json = tryExtractJson(raw);
    if (json === null || typeof json !== 'object') return err('no JSON object found in response');
    return validateDeckIr(json);
}
