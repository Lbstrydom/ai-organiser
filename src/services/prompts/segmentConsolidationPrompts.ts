/**
 * Multi-segment consolidation prompts (R3-M4 — XML-structured).
 *
 * `buildSegmentConsolidationPrompt` takes per-segment `SegmentExtract`s
 * and produces a prompt that yields a `MinutesJSON` whose `sections[]`
 * preserves each original section's identity. NEVER flattens across
 * segments — Gemini-G1 fix preserves section provenance through
 * hierarchical reduce.
 */

import type {
    SegmentExtract,
    MeetingMetadata,
} from '../minutes/minutesTypes';
import type { MinutesStyle } from '../../core/constants';

/**
 * H4/H15 fix: transform MeetingMetadata (camelCase service shape) into the
 * snake_case shape expected by MinutesJSON.metadata. Prevents the LLM from
 * echoing camelCase field names that the parser/frontmatter writer can't
 * interpret.
 */
function toSnakeCaseMetadata(m: MeetingMetadata): Record<string, unknown> {
    return {
        title: m.title,
        date: m.date,
        start_time: m.startTime,
        end_time: m.endTime,
        timezone: m.timezone,
        meeting_context: m.meetingContext,
        output_audience: m.outputAudience,
        confidentiality_level: m.confidentialityLevel,
        chair: m.chair,
        minute_taker: m.minuteTaker,
        location: m.location,
        quorum_present: null,
    };
}

export interface ConsolidationPromptOptions {
    minutesStyle: MinutesStyle;
    outputLanguage: string;
    meetingMetadata: MeetingMetadata;
    participantsRaw: string;
    useGTD?: boolean;
    dictionaryContent?: string;
    /** H5 fix: user-defined customisation flows through to consolidation. */
    customInstructions?: string;
    /** H5 fix: style-reference document flows through to consolidation. */
    styleReference?: string;
}

/**
 * Build the cross-segment consolidation prompt. Output is `MinutesJSON`
 * with `sections[]` retaining one entry per input segment (LLM is
 * instructed to preserve sectionId + name verbatim from input).
 */
export function buildSegmentConsolidationPrompt(
    extracts: SegmentExtract[],
    opts: ConsolidationPromptOptions,
): string {
    const lang = opts.outputLanguage || 'English';
    const gtdNote = opts.useGTD
        ? `Additionally emit a "gtd_processing" object rolling up next_actions, waiting_for, projects, someday_maybe across ALL sections.`
        : `Do NOT emit a "gtd_processing" object.`;
    const dictNote = opts.dictionaryContent
        ? `\n  <dictionary>\n${opts.dictionaryContent}\n  </dictionary>`
        : '';
    const customInstr = opts.customInstructions?.trim()
        ? `\n  <custom_instructions>\n${opts.customInstructions.trim()}\n  </custom_instructions>`
        : '';
    const styleRef = opts.styleReference?.trim()
        ? `\n  <style_reference>\n${opts.styleReference.trim()}\n  </style_reference>`
        : '';

    const sectionsJson = JSON.stringify(
        extracts.map((e) => ({
            sectionId: e.sectionId,
            sectionName: e.sectionName,
            actions: e.actions,
            decisions: e.decisions,
            risks: e.risks,
            notable_points: e.notable_points,
            open_questions: e.open_questions,
            deferred_items: e.deferred_items,
        })),
        null,
        2,
    );

    return `<task>
Consolidate per-section meeting extracts into a single MinutesJSON document.
You MUST preserve each section's identity (sectionId + name) in the output's "sections" array.
You MUST also emit global rolled-up arrays (actions, decisions, risks, notable_points,
open_questions, deferred_items) across all sections, with each item carrying its
"segmentId" field pointing back to its origin section.
</task>

<requirements>
- Output language: ${lang}.
- Style: ${opts.minutesStyle}.
- Preserve each input section's sectionId AND sectionName verbatim in the "sections" array.
- For each section in the input, emit ONE corresponding entry in output.sections with kind="content".
- Each section entry includes a brief summary (1-2 sentences) plus the section's actions/decisions/risks/notable_points/open_questions/deferred_items.
- Global rollup arrays MUST include EVERY item from every section, each with "segmentId" = its origin sectionId.
- Deduplicate semantically identical items within a section AND across sections (same action described differently → keep one, attach all originating segmentIds in a comma-separated string for the most-comprehensive segmentId field).
- Do NOT invent items. Only consolidate what is provided.
- ${gtdNote}
- Cap risks at 8 globally (keep highest-impact).
- Cap notable_points at 30 globally.${dictNote}${customInstr}${styleRef}
</requirements>

<output_format>
Return valid JSON only, no other text. Schema:

{
  "metadata": { /* echo the meeting metadata fields */ },
  "participants": [...],
  "agenda": [...],
  "sections": [
    {
      "kind": "content",
      "sectionId": "<verbatim from input>",
      "name": "<verbatim from input>",
      "summary": "1-2 sentence summary of this section",
      "actions": [...],
      "decisions": [...],
      "risks": [...],
      "notable_points": [...],
      "open_questions": [...],
      "deferred_items": [...]
    }
  ],
  "decisions": [ { "id": "D1", "segmentId": "<origin sectionId>", ... } ],
  "actions":   [ { "id": "A1", "segmentId": "<origin sectionId>", ... } ],
  "risks":     [ { "id": "R1", "segmentId": "<origin sectionId>", ... } ],
  "notable_points": [ { "id": "N1", "segmentId": "<origin sectionId>", ... } ],
  "open_questions": [ { "id": "Q1", "segmentId": "<origin sectionId>", ... } ],
  "deferred_items": [ { "id": "P1", "segmentId": "<origin sectionId>", ... } ]${opts.useGTD ? `,
  "gtd_processing": { "next_actions": [...], "waiting_for": [...], "projects": [...], "someday_maybe": [...] }` : ''}
}

Meeting metadata (use these exact snake_case keys in your output's "metadata" object — do NOT translate to camelCase):
${JSON.stringify(toSnakeCaseMetadata(opts.meetingMetadata), null, 2)}

Participants: ${opts.participantsRaw}

Per-section extracts to consolidate:
${sectionsJson}
</output_format>`;
}
