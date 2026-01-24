export type MeetingContext = 'internal' | 'external' | 'board';
export type OutputAudience = 'internal' | 'external';
export type ConfidentialityLevel = 'public' | 'internal' | 'confidential' | 'strictly_confidential';

export interface MeetingMetadata {
    title: string;
    date: string;
    startTime: string;
    endTime: string;
    timezone: string;
    meetingContext: MeetingContext;
    outputAudience: OutputAudience;
    confidentialityLevel: ConfidentialityLevel;
    chair: string;
    location: string;
    agenda: string[];
    dualOutput: boolean;
    obsidianTasksFormat: boolean;
    minuteTaker: string;
}

export interface Participant {
    name: string;
    role?: string;
    organisation?: string;
    attendance?: 'present' | 'apologies' | 'partial';
}

export interface TranscriptSegment {
    t?: string;
    speaker?: string;
    text: string;
}

export interface Decision {
    id: string;
    agenda_item_ref?: number | null;
    text: string;
    owner?: string;
    due_date?: string;
    verbatim_quote?: string;
    confidence: 'high' | 'medium' | 'low';
    source_timecodes?: string[];
}

export interface Action {
    id: string;
    agenda_item_ref?: number | null;
    text: string;
    owner: string;
    due_date: string;
    status?: string;
    confidence: 'high' | 'medium' | 'low';
    source_timecodes?: string[];
}

export interface Risk {
    id: string;
    text: string;
    impact?: string;
    mitigation?: string;
    owner?: string;
    confidence: 'high' | 'medium' | 'low';
}

export interface NotablePoint {
    id: string;
    agenda_item_ref?: number | null;
    text: string;
    confidence: 'high' | 'medium' | 'low';
}

export interface OpenQuestion {
    id: string;
    text: string;
    owner?: string;
    confidence: 'high' | 'medium' | 'low';
}

export interface DeferredItem {
    id: string;
    text: string;
    reason?: string;
}

export interface MinutesJSON {
    metadata: {
        title: string;
        date: string;
        start_time: string;
        end_time: string;
        timezone: string;
        meeting_context: MeetingContext;
        output_audience: OutputAudience;
        confidentiality_level: ConfidentialityLevel;
        chair: string;
        minute_taker: string;
        location: string;
        quorum_present: boolean | null;
    };
    participants: Participant[];
    agenda: string[];
    decisions: Decision[];
    actions: Action[];
    risks: Risk[];
    notable_points: NotablePoint[];
    open_questions: OpenQuestion[];
    deferred_items: DeferredItem[];
}

export interface ParsedMinutes {
    json: MinutesJSON;
    markdown: string;
    markdownExternal: string | null;
}

export const MINUTES_JSON_DELIMITER = '<<AIO_MINUTES_JSON_END>>';

export function buildMinutesSystemPrompt(outputLanguage: string, personaInstructions: string): string {
    return `You are a corporate minute taker for professional meetings.

<<< RESPONSE FORMAT - CRITICAL >>>

Your response MUST start with a valid JSON object (no preamble, no markdown fences).
After the JSON, output exactly this delimiter on its own line:
${MINUTES_JSON_DELIMITER}
Then output the markdown minutes.

If dual_output is true, output markdown in exactly this structure after the delimiter:
## Minutes_Internal
[full detail markdown]

## Minutes_External
[sanitized markdown]

Do not add separators between sections. Use exactly these headings.

<<< LANGUAGE AND STYLE >>>

- Use ${outputLanguage} and concise corporate tone.
- Neutral, factual. No opinions, no judgmental language.
- Short sentences. Avoid em dashes; use hyphens or commas.
- Minutes are NOT verbatim. Summarize and structure.

<<< PERSONA INSTRUCTIONS >>>

${personaInstructions}

<<< ACCURACY RULES >>>

- Never invent owners, dates, numbers, or decisions.
- If unclear or missing, mark as "TBC" and add to open_questions.
- If ambiguous but important, set confidence: "low" and include source_timecodes.
- Keep names consistent with the participant list or participant list text.
- verbatim_quote: Only populate when the transcript contains a clearly stated resolution text (e.g., chair reads a resolution aloud). Otherwise leave blank and add an open question: "Confirm resolution wording for [topic]".

<<< MEETING CONTEXT BEHAVIOR >>>

meeting_context determines content depth:

internal
  - Include operational detail, internal acronyms, dependencies, resourcing constraints.

external
  - Meeting included external parties. Content may include commercially sensitive discussion.
  - Minutes should still capture full detail unless output_audience is external.

board
  - Prioritize governance: approvals, resolutions, delegations, risk appetite, fiduciary items.
  - Record conflicts of interest, abstentions, quorum (if mentioned).

<<< OUTPUT AUDIENCE BEHAVIOR >>>

output_audience determines what to include in the markdown:

internal
  - Full detail appropriate for internal circulation.

external
  - Sanitize for external sharing: remove internal tool names, internal politics, sensitive pricing, strategy commentary, individual performance notes.
  - Keep commitments, decisions, and next steps crisp.
  - When in doubt, omit.

<<< TERMINOLOGY DICTIONARY >>>

If a terminology dictionary is provided, it contains pre-verified terms for this meeting context.
Use the dictionary to:
- Ensure correct spelling of names (people, projects, organizations)
- Expand acronyms correctly using the provided definitions
- Apply consistent terminology throughout the minutes
- Match names to roles/titles as specified

The dictionary entries are authoritative - prefer dictionary spellings over transcript guesses.

<<< CONTEXT DOCUMENTS >>>

If context_documents is provided in the input, use it to:
- Identify correct spelling of names, project codes, and technical terms
- Cross-reference agenda items with supporting materials (e.g., slides, reports)
- Clarify acronyms and abbreviations mentioned in the transcript
- Verify numerical data, dates, and figures referenced in discussion

IMPORTANT: Do NOT summarize the context documents themselves. They are reference only for improving transcript accuracy.

<<< OUTPUT SCHEMA >>>

MinutesJSON (valid JSON, no markdown fences, must be first in response):

{
  "metadata": {
    "title": "",
    "date": "",
    "start_time": "",
    "end_time": "",
    "timezone": "",
    "meeting_context": "internal | external | board",
    "output_audience": "internal | external",
    "confidentiality_level": "public | internal | confidential | strictly_confidential",
    "chair": "",
    "minute_taker": "",
    "location": "",
    "quorum_present": true | false | null
  },
  "participants": [
    { "name": "", "role": "", "organisation": "", "attendance": "present | apologies | partial" }
  ],
  "agenda": ["Item 1", "Item 2"],
  "decisions": [
    {
      "id": "D1",
      "agenda_item_ref": 1,
      "text": "",
      "owner": "",
      "due_date": "",
      "verbatim_quote": "",
      "confidence": "high | medium | low",
      "source_timecodes": []
    }
  ],
  "actions": [
    {
      "id": "A1",
      "agenda_item_ref": 1,
      "text": "",
      "owner": "TBC",
      "due_date": "TBC",
      "status": "new",
      "confidence": "high | medium | low",
      "source_timecodes": []
    }
  ],
  "risks": [
    { "id": "R1", "text": "", "impact": "", "mitigation": "", "owner": "TBC", "confidence": "high | medium | low" }
  ],
  "notable_points": [
    { "id": "N1", "agenda_item_ref": null, "text": "", "confidence": "high | medium | low" }
  ],
  "open_questions": [
    { "id": "Q1", "text": "", "owner": "TBC", "confidence": "high | medium | low" }
  ],
  "deferred_items": [
    { "id": "P1", "text": "", "reason": "" }
  ]
}

Minutes (markdown) must include:
- Metadata block (title, date, time, location, chair, attendees, apologies, distribution, confidentiality)
- Agenda (numbered)
- Key points by agenda item (brief bullets)
- Decisions (numbered, cross-ref D1 etc.)
- Actions table: ID | Action | Owner | Due | Status | Notes
- Risks / Issues (if any)
- Parking lot / Deferred items
- Clarifications needed (if any open_questions exist)

<<< SELF-CHECK (run before returning) >>>

1. Response starts with { (no preamble).
2. JSON is valid (no trailing commas, all strings quoted).
3. Every action has an owner or is marked TBC.
4. Every decision references an agenda item or is flagged "no agenda ref".
5. No invented names, numbers, or dates.
6. Confidence is set for every item.
7. open_questions includes anything marked TBC.
8. verbatim_quote is empty unless resolution was explicitly read aloud.

<<< EDGE CASES >>>

- No clear decision reached: Add to open_questions with text "Decision pending: [topic]".
- Item explicitly deferred: Add to deferred_items with reason.
- Heated discussion, no resolution: Summarize positions neutrally in notable_points. Do not fabricate consensus.
- Missing agenda: Set agenda to [] and agenda_item_ref to null throughout.`;
}

export function buildMinutesUserPrompt(
    metadata: MeetingMetadata,
    participants: Participant[],
    participantsRaw: string,
    transcript: TranscriptSegment[] | string,
    contextDocuments?: string,
    dictionaryContent?: string
): string {
    const payload: Record<string, unknown> = {
        meeting: {
            title: metadata.title,
            date: metadata.date,
            start_time: metadata.startTime,
            end_time: metadata.endTime,
            timezone: metadata.timezone,
            meeting_context: metadata.meetingContext,
            output_audience: metadata.outputAudience,
            confidentiality_level: metadata.confidentialityLevel,
            chair: metadata.chair,
            location: metadata.location,
            agenda: metadata.agenda,
            dual_output: metadata.dualOutput,
            minute_taker: metadata.minuteTaker,
        },
        participants,
        participants_raw: participantsRaw,
        transcript,
    };

    // Add terminology dictionary if provided
    if (dictionaryContent && dictionaryContent.trim().length > 0) {
        payload.terminology_dictionary = dictionaryContent;
    }

    // Add context documents if provided
    if (contextDocuments && contextDocuments.trim().length > 0) {
        payload.context_documents = contextDocuments;
    }

    return JSON.stringify(payload, null, 2);
}

export function buildChunkExtractionPrompt(): string {
    return `You are extracting meeting items from a transcript chunk. This is part of a longer meeting.

Extract ONLY:
- Actions (with owner if stated, otherwise TBC)
- Decisions
- Risks mentioned
- Notable points
- Open questions

Return valid JSON only, no other text:

{
  "actions": [{ "id": "A1", "text": "", "owner": "TBC", "due_date": "TBC", "confidence": "high|medium|low", "source_timecodes": [] }],
  "decisions": [{ "id": "D1", "text": "", "owner": "", "confidence": "high|medium|low", "source_timecodes": [] }],
  "risks": [{ "id": "R1", "text": "", "owner": "TBC", "confidence": "high|medium|low" }],
  "notable_points": [{ "id": "N1", "text": "", "confidence": "high|medium|low" }],
  "open_questions": [{ "id": "Q1", "text": "", "owner": "TBC", "confidence": "high|medium|low" }]
}

Rules:
- Use temporary IDs (A1, D1, etc.) - they will be renumbered in consolidation.
- Do not invent items. Only extract what is clearly stated.
- If this chunk has no relevant items, return empty arrays.`;
}

export function buildConsolidationPrompt(outputLanguage: string, personaInstructions: string): string {
    return `You are consolidating meeting items extracted from multiple transcript chunks into final minutes.

You will receive:
1. Meeting metadata
2. Participant list
3. Extracted items from each chunk (may have duplicates)

Your task:
1. Deduplicate items (same action mentioned in multiple chunks = one action)
2. Renumber IDs sequentially (A1, A2... D1, D2...)
3. Produce final MinutesJSON and markdown minutes

${buildMinutesSystemPrompt(outputLanguage, personaInstructions)}`;
}

export function parseMinutesResponse(response: string): ParsedMinutes {
    let jsonPart: string;
    let markdownPart: string;

    const delimiterIndex = response.indexOf(MINUTES_JSON_DELIMITER);

    if (delimiterIndex !== -1) {
        jsonPart = response.substring(0, delimiterIndex).trim();
        markdownPart = response.substring(delimiterIndex + MINUTES_JSON_DELIMITER.length).trim();
    } else {
        jsonPart = extractJsonByBraceMatching(response);
        const jsonEndIndex = response.indexOf(jsonPart) + jsonPart.length;
        markdownPart = response.substring(jsonEndIndex).trim();
        markdownPart = markdownPart.replace(/^---+\s*/m, '').trim();
    }

    jsonPart = jsonPart.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();

    const minutesJson = parseJsonWithRepair(jsonPart);

    let markdownInternal = markdownPart;
    let markdownExternal: string | null = null;

    if (markdownPart.includes('## Minutes_Internal')) {
        const internalMatch = markdownPart.match(/## Minutes_Internal\s*([\s\S]*?)(?=## Minutes_External|$)/);
        const externalMatch = markdownPart.match(/## Minutes_External\s*([\s\S]*?)$/);

        if (internalMatch) {
            markdownInternal = internalMatch[1].trim();
        }
        if (externalMatch) {
            markdownExternal = externalMatch[1].trim();
        }
    }

    return {
        json: minutesJson,
        markdown: markdownInternal,
        markdownExternal,
    };
}

function extractJsonByBraceMatching(text: string): string {
    const start = text.indexOf('{');
    if (start === -1) {
        throw new Error('No JSON object found in response');
    }

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < text.length; i++) {
        const char = text[i];

        if (escape) {
            escape = false;
            continue;
        }

        if (char === '\\' && inString) {
            escape = true;
            continue;
        }

        if (char === '"' && !escape) {
            inString = !inString;
            continue;
        }

        if (!inString) {
            if (char === '{') depth++;
            if (char === '}') depth--;

            if (depth === 0) {
                return text.substring(start, i + 1);
            }
        }
    }

    throw new Error('Unbalanced braces in JSON');
}

function parseJsonWithRepair(jsonStr: string): MinutesJSON {
    try {
        return JSON.parse(jsonStr);
    } catch {
        // Attempt repairs below
    }

    let repaired = jsonStr;
    repaired = repaired.replace(/,\s*([}\]])/g, '$1');
    repaired = repaired.replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3');

    try {
        return JSON.parse(repaired);
    } catch (error) {
        throw new Error(`JSON parse failed after repair: ${(error as Error).message}`);
    }
}
