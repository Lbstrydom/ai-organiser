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
import { buildIconReference } from './iconRegistry';
import { buildVisualSelectionGuide } from './visualSelection';
import { escapeForPrompt, jsonForPrompt } from '../../utils/promptSafe';

/**
 * One compact storyboard-slide → IR example. EVERY fact in the IR comes from the
 * evidence in the example's input (nothing is added, nothing is rounded into a new
 * claim), and it shows the pieces this prompt asks for: a subhead, a labelled chart
 * whose labels carry the real figures, and the slide-level source line. Kept small
 * to bound prompt cost. The company and figures are illustrative INPUT, not facts.
 */
const FEW_SHOT = `<example>
Input — the evidence and ONE storyboard slide. Use only what is in the input:
<evidence>
[e1] (Example Co annual report) Services revenue was 4.1 EUR bn in FY24, up 12% on FY23.
[e2] (Example Co annual report) Hardware revenue was 5.9 EUR bn in FY24, flat on FY23.
</evidence>
<storyboard_slide>
{ "id": "s2", "role": "insight", "action_title": "Services grew 12% while hardware stayed flat",
  "core_message": "Services revenue rose 12% to 4.1 EUR bn in FY24; hardware revenue was flat at 5.9 EUR bn.",
  "evidence_span_ids": ["e1", "e2"], "suggested_visual": "bar",
  "visual_data": { "type": "bar", "unit": "EUR bn", "items": [
    { "label": "Hardware", "value": 5.9, "evidence_span_id": "e2" },
    { "label": "Services", "value": 4.1, "evidence_span_id": "e1" } ] } }
</storyboard_slide>
IR (a bar's pct is its value ÷ the largest value × 100; the labels carry the real figures):
{
  "schemaVersion": ${IR_SCHEMA_VERSION},
  "title": "Revenue mix, FY24",
  "slides": [
    { "id": "s1", "type": "title", "title": "Revenue mix, FY24", "blocks": [] },
    { "id": "s2", "type": "content", "title": "Services grew 12% while hardware stayed flat", "blocks": [
      { "kind": "subhead", "text": "Services revenue rose 12% to 4.1 EUR bn" },
      { "kind": "bar-chart", "axisLabel": "Revenue, FY24 (EUR bn)", "bars": [
        { "label": "Hardware (5.9 EUR bn)", "pct": 100 },
        { "label": "Services (4.1 EUR bn)", "pct": 69 } ] }
    ], "sources": ["Example Co annual report"] }
  ]
}
</example>`;

/**
 * System prompt instructing the model to emit a `SlideDeckIr` JSON object.
 * Enumerates the exact block vocabulary + invariants the Zod schema enforces,
 * so the first attempt validates as often as possible.
 */
export function buildIrSystemPrompt(options: { outputLanguage?: string; targetLength?: number } = {}): string {
    const langLine = options.outputLanguage ? `\nWrite all slide text in ${escapeForPrompt(options.outputLanguage)}.` : '';
    // Validate targetLength to a sane integer range before interpolation (D5 —
    // negative/NaN/fraction/huge values would produce impossible instructions).
    const len = typeof options.targetLength === 'number' && Number.isInteger(options.targetLength)
        && options.targetLength >= 1 && options.targetLength <= 50
        ? options.targetLength
        : undefined;
    const countLine = len
        ? `\nIMPORTANT: produce EXACTLY ${len} slides in total — counting the title slide and the closing slide. This slide count is a hard requirement set by the user; do not produce more or fewer.`
        : '';
    return `You are a presentation designer. You output a STRUCTURED JSON deck (an "IR"), NOT HTML.${langLine}${countLine}

<output_format>
Return ONLY one JSON object (no prose, no markdown fences) of this shape:
{ "schemaVersion": ${IR_SCHEMA_VERSION}, "title": "Deck title", "slides": [ Slide, ... ] }

Slide = { "id": "unique-string", "type": "title"|"section"|"content"|"closing",
          "title"?: string, "subtitle"?: string, "background"?: "RRGGBB", "blocks": Block[], "notes"?: string,
          "sources"?: string[], "footnotes"?: string[] }
- title / section / closing slides MUST have "blocks": [] (use title + subtitle only).
- Only "content" slides carry blocks. Give every slide a UNIQUE id.
- "sources" = where the slide's figures come from, as bare origins (e.g. "IEA, 2024"); the renderer prints them as one "Source: …" line. Set it on a slide that shows numbers WHEN the input names where they come from; if the input names no origin, omit it — never invent one. "footnotes" = short qualifying notes (e.g. "Excludes one-off items"), at most 4.
- "background" is an OPTIONAL per-slide background colour (6-digit hex, no '#', e.g. "ffffff" for white). Set it only when the user asks to change a slide's background; text colour adapts automatically for contrast. Omit it to use the theme.

Block (discriminated by "kind"):
- { "kind": "heading", "text": string, "level": 1|2|3 }
- { "kind": "subhead", "text": string }                            // a sub-headline / kicker: ONE short line that leads a slide or a group of content. Use this — never a bold paragraph — for a sub-headline
- { "kind": "paragraph", "text": string }
- { "kind": "bullets", "items": string[], "ordered"?: boolean }    // 1–12 items
- { "kind": "stat-grid", "cards": [ { "value": string, "label": string, "icon"?: "trending-up" } ] }   // 1–6 cards; icon = a NAME from <icons>
- { "kind": "bar-chart", "bars": [ { "label": string, "pct": number, "color"?: "RRGGBB" } ], "axisLabel"?: string, "source"?: string, "caption"?: string }  // pct 0–100, 1–12 bars. ALWAYS set "axisLabel" with the metric + unit (e.g. "Relative CO₂ per kWh (diesel = 100)") so an index chart is interpretable; add "source" when the data has a provenance.
- { "kind": "waterfall", "base": { "label": string, "value": number }, "deltas": [ { "label": string, "value": number } ], "total"?: { "label": string }, "unit"?: string, "caption"?: string }  // a build-up; 1–10 deltas
- { "kind": "line-chart", "series": [ { "label": string, "points": [ { "x": string, "y": number } ] } ], "unit"?: string, "caption"?: string }  // a time series; 1–4 series, 2–20 points each
- { "kind": "pyramid", "levels": [ { "label": string, "detail"?: string } ], "caption"?: string }  // a hierarchy; 2–6 levels
- { "kind": "process-flow", "steps": [ { "title": string, "sub"?: string, "icon"?: "rocket" } ] }  // 2–8 steps; icon = a NAME from <icons>
- { "kind": "two-column", "left": Block[], "right": Block[] }   // ONE level only — no nested two-column
- { "kind": "table", "headers": string[], "rows": string[][] }  // every row length === headers length
- { "kind": "callout", "text": string, "cite"?: string, "variant"?: "info"|"warn" }
- { "kind": "caption", "text": string }
</output_format>

<requirements>
- Use the RIGHT block for the content. Headline figures (a few key numbers) → stat-grid; steps/pipeline → process-flow; side-by-side prose → two-column. Avoid walls of bullets.
- ${buildVisualSelectionGuide('ir')}
- If the input includes a storyboard, keep each slide's action title as its slide title and every figure as given. In every case add no facts, numbers or claims that are not in the input.
- Every bar-chart MUST carry an "axisLabel" naming the metric + unit (charts with bare numbers are uninterpretable); cite a "source" when the figures have a provenance. Write a sub-headline as a "subhead" block, not as an emphasised paragraph.
- Add an "icon" on a stat-grid card or process-flow step ONLY where it distinguishes one concept from another or makes the sequence clearer — not as decoration; leave it out when it adds nothing. Use ONLY names from the <icons> list below — never emoji or freeform text.
- ${len ? `Produce EXACTLY ${len} slides total (title + content + closing) — match this count precisely.` : '6–10 slides for a normal deck unless the user asks for a specific count.'} One idea per slide.
- "color" must be a 6-digit hex WITHOUT '#'. No extra/unknown JSON keys (they are rejected).
- Output MUST be valid JSON and nothing else.
</requirements>

<icons>
Use ONLY these icon names (grouped by theme) for any "icon" field:
${buildIconReference()}
</icons>

${FEW_SHOT}`;
}

/**
 * Refine prompt — edits an EXISTING deck IR per a user request. Sends the
 * current IR + the change and asks for the complete updated IR, so subsequent
 * rounds stay IR-backed (and exportable to faithful PPTX).
 */
export function buildIrRefinePrompt(
    currentDeck: SlideDeckIr,
    userRequest: string,
    extraSources?: ReadonlyArray<{ ref: string; content: string }>,
): string {
    // Mid-conversation web research the user pulled in via `/search` — offered as
    // reference material the edit may draw on (it does NOT force new slides).
    const referenceBlock = extraSources && extraSources.length > 0
        ? `\n<reference_material>\nFresh research the user added while iterating — use it to ground the edit where relevant; do not invent facts beyond it:\n${extraSources.map(s => `## ${escapeForPrompt(s.ref)}\n${escapeForPrompt(s.content)}`).join('\n\n')}\n</reference_material>\n`
        : '';
    return `You are editing an existing structured slide deck (IR JSON).

<current_deck>
${jsonForPrompt(currentDeck)}
</current_deck>
${referenceBlock}
<edit_request>
${escapeForPrompt(userRequest)}
</edit_request>

Apply the requested change, preserving all other slides and content unless the request says otherwise. Return the COMPLETE updated deck as ONE JSON object conforming to the same schema (schemaVersion ${IR_SCHEMA_VERSION}). No prose, no markdown fences.`;
}

/** Repair prompt — re-asks for corrected JSON after a validation failure. */
export function buildIrRepairPrompt(badOutput: string, validationError: string): string {
    const snippet = badOutput.length > 6_000 ? badOutput.slice(0, 6_000) + '\n…[truncated]' : badOutput;
    return `Your previous response was not a valid deck IR.

<validation_error>${escapeForPrompt(validationError)}</validation_error>

<your_previous_output>
${escapeForPrompt(snippet)}
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
