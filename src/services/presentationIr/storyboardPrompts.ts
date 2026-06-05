/**
 * Storyboard generation prompts (plan Cluster A). The ONE message-deciding LLM
 * pass: turn the user's brief + the resolved evidence catalog into a
 * `ConsultantStoryboard` (action titles, MECE roles, evidence bindings, typed
 * visual_data). XML-structured per the repo prompt convention; the model MUST
 * cite real `evidence_span_id`s from the catalog and may invent NO numbers that
 * aren't in a cited span.
 */
import type { EvidenceSpan } from './consultantStoryboard';
import { STORYBOARD_SCHEMA_VERSION } from './consultantStoryboard';

export interface StoryboardPromptOptions {
    outputLanguage?: string;
    targetLength?: number;
}

/**
 * Break XML-ish envelope markers in untrusted content (audit H6/M20). A user
 * brief / evidence span / prior model output containing `</requirements>` etc.
 * could otherwise close a prompt section early and inject instructions. Inserting
 * a zero-width space after every `<` defangs the tag while staying human-readable
 * (mirrors `audioNarration`'s `neutraliseEnvelopeMarkers`).
 */
const ZWSP = '​';
function neutralise(s: string): string {
    return s.replace(/</g, `<${ZWSP}`);
}

const VISUAL_GUIDE = `Choose suggested_visual by the DATA SHAPE, and emit the matching visual_data:
- trend over time -> "line"      : {type:"line", series:[{label,unit?,points:[{x,y,evidence_span_id}]}]}
- a bridge / build-up (cost, margin, headcount) -> "waterfall" : {type:"waterfall", unit?, base:{label,value,evidence_span_id}, deltas:[{label,value,evidence_span_id}], total?:{label}}
- options on two axes -> "2x2"   : {type:"2x2", x_axis:{label,low_label,high_label}, y_axis:{...}, items:[{label,quadrant:"tl|tr|bl|br",evidence_span_id?}]}
- a hierarchy / MECE breakdown -> "pyramid" : {type:"pyramid", levels:[{label,detail?}]}
- option ratings -> "harvey"     : {type:"harvey", columns:[...], rows:[{label,ratings:[0..4],evidence_span_id?}]}
- magnitudes to compare -> "bar" : {type:"bar", unit?, items:[{label,value,evidence_span_id}]}
- structured facts -> "table"    : {type:"table", columns:[...], rows:[{cells:[{text,value?,evidence_span_id?}]}]}
- otherwise prose -> "bullets" | "stat-grid" | "process-flow" | "none" : {type:"<that>"}
EVERY numeric value MUST carry an evidence_span_id citing a span that contains that number.`;

export function buildStoryboardPrompt(
    userBrief: string,
    catalog: readonly EvidenceSpan[],
    options: StoryboardPromptOptions = {},
): string {
    const langLine = options.outputLanguage && options.outputLanguage !== 'en'
        ? `\nWrite all text in ${options.outputLanguage}.` : '';
    const countLine = options.targetLength ? `\nProduce about ${options.targetLength} content slides.` : '';
    const catalogBlock = catalog.map((s) => `[${s.id}] (${neutralise(s.source_ref)}) ${neutralise(s.text)}`).join('\n');

    return `You are a top-tier management consultant (McKinsey/BCG/Bain) writing the STORYLINE of a deck BEFORE any slides are designed.${langLine}${countLine}

<task>
Write a "ghost deck": a tight, MECE storyline where every slide's title states the SO-WHAT (the implication), supported by evidence. Output ONE JSON object — a ConsultantStoryboard — and nothing else.
</task>

<requirements>
- ACTION TITLES, not labels. The title states the implication ("EMEA drove 60% of Q3 growth"), is verb-bearing, and is quantified ONLY where a cited span supports the number. Never "Revenue by Region".
- One message per slide. Slides ladder up to the deck thesis (pyramid principle). Roles: context | problem | insight | recommendation | proof.
- GROUNDING: every number in a title or visual_data MUST trace to a cited evidence_span_id from the catalog below. If the data isn't in the catalog, do NOT invent it — use a qualitative so-what instead.
- ${VISUAL_GUIDE}
</requirements>

<evidence_catalog>
${catalogBlock || '(no sources provided — write a qualitative storyline with NO fabricated numbers)'}
</evidence_catalog>

<user_brief>
${neutralise(userBrief)}
</user_brief>

<output_format>
Return ONLY this JSON (no prose, no markdown fences):
{"schemaVersion":${STORYBOARD_SCHEMA_VERSION},"thesis":"...","slides":[{"id":"s1","role":"insight","action_title":"...","core_message":"...","evidence_span_ids":["e1"],"suggested_visual":"bar","visual_data":{"type":"bar","items":[{"label":"...","value":0,"evidence_span_id":"e1"}]}}]}
suggested_visual MUST equal visual_data.type. No unknown JSON keys (they are rejected).
</output_format>`;
}

/** Repair prompt — re-asks for corrected storyboard JSON after a validation failure. */
export function buildStoryboardRepairPrompt(badOutput: string, validationError: string): string {
    return `Your previous storyboard JSON was invalid: ${validationError}

Previous output:
${neutralise(badOutput.slice(0, 4000))}

Return the COMPLETE corrected ConsultantStoryboard as ONE JSON object conforming to the schema (schemaVersion ${STORYBOARD_SCHEMA_VERSION}). suggested_visual MUST equal visual_data.type; every numeric value needs an evidence_span_id from the catalog. No prose, no markdown fences.`;
}
