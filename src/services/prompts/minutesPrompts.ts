import { repairJsonStrings } from '../../utils/responseParser';
import type { MinutesStyle } from '../../core/constants';
import { logger } from '../../utils/logger';

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

export interface GTDAction {
    text: string;
    /** Prompt-guided context, e.g. @office, @home, @call, @computer, @agenda, @errand */
    context: string;
    owner?: string;
    /** 'medium' intentionally omitted during rendering — only low/high annotated */
    energy?: 'low' | 'medium' | 'high';
}

export interface GTDWaitingItem {
    text: string;
    waiting_on: string;
    chase_date?: string;
}

export interface GTDProcessing {
    next_actions: GTDAction[];
    waiting_for: GTDWaitingItem[];
    projects: string[];
    someday_maybe: string[];
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
        /** Minutes style used to generate this output (Phase 3 TRA) */
        style?: MinutesStyle;
    };
    participants: Participant[];
    agenda: string[];
    decisions: Decision[];
    actions: Action[];
    risks: Risk[];
    notable_points: NotablePoint[];
    open_questions: OpenQuestion[];
    deferred_items: DeferredItem[];
    gtd_processing?: GTDProcessing;
}

export interface ParsedMinutes {
    json: MinutesJSON;
    markdown: string;
    markdownExternal: string | null;
}

export const MINUTES_JSON_DELIMITER = '<<AIO_MINUTES_JSON_END>>';

// ============================================================================
// Style-based prompt system (Phase 2 TRA)
// ============================================================================

export interface MinutesStylePromptOptions {
    minutesStyle: MinutesStyle;
    outputLanguage: string;
    useGTD?: boolean;
    dualOutput?: boolean;
    dictionaryContent?: string;
    contextSummary?: string;
    styleReference?: string;       // only for 'guided' style
    meetingContext?: MeetingContext;
    outputAudience?: OutputAudience;
    customInstructions?: string;
}

/**
 * Build the complete system prompt for minutes generation based on the selected style.
 * Dispatches to style-specific core builder, then appends the shared suffix
 * (accuracy rules, GTD, schema, self-check, edge cases).
 *
 * Replaces the old buildMinutesSystemPrompt() which embedded persona instructions inline.
 */
export function getStyleSystemPrompt(options: MinutesStylePromptOptions): string {
    const styleCore = getStyleCore(options);
    const sharedSuffix = buildSharedPromptSuffix(options);
    return `${styleCore}\n\n${sharedSuffix}`;
}

function getStyleCore(options: MinutesStylePromptOptions): string {
    switch (options.minutesStyle) {
        case 'smart-brevity':
            return buildSmartBrevityStyleCore(options.outputLanguage);
        case 'detailed':
            return buildDetailedStyleCore(options.outputLanguage);
        case 'guided':
            return buildGuidedStyleCore(options.outputLanguage, options.styleReference);
        case 'standard':
        default:
            return buildStandardStyleCore(options.outputLanguage);
    }
}

function buildSmartBrevityStyleCore(outputLanguage: string): string {
    return `You are a corporate minute taker producing Smart Brevity minutes.

<<< STYLE: SMART BREVITY >>>

Adapted from Axios Smart Brevity methodology. Target 300-600 words.

Structure:
1. **The big thing** — One sentence: the single most important outcome of the meeting.
2. **Why it matters** — 2-3 sentences of context.
3. **Decisions** — Numbered list (1 sentence each). Only formally decided items.
4. **Action items** — Numbered list with owner and due date.
5. **Go deeper** — 3-5 short paragraphs covering the rest of the discussion.

Rules:
- Maximum 600 words total. No sub-lists. No tables.
- Direct active voice, present-tense labels.
- Complete sentences only — cut filler words and hedging.
- Only include formally agreed decisions and explicitly assigned actions.
- Never output confidence annotations, pipeline metadata, or status tags. If a fact is uncertain, express uncertainty in prose.

Language: ${outputLanguage}.`;
}

function buildStandardStyleCore(outputLanguage: string): string {
    return `You are a corporate minute taker producing short, clear meeting minutes.

<<< STYLE: STANDARD >>>

Maximum brevity without losing meaning. Target 300-600 words total.

Structure:
1. **Header block** — Title, date, time, attendees.
2. **Summary** — 1-2 sentences only: the single most important outcome and what happens next.
3. **Per-agenda-item sections** — For each agenda item:
   - 1-3 bullet points (one short sentence each).
   - Decisions and actions inline.
   - If an item mixes financial and operational topics, separate them with sub-headings (e.g., "### Financial", "### Operations").
4. **Opportunities and obstacles** — 3-5 items max. One sentence each.
5. **Next meeting** — Date and key carry-forward items.

Rules:
- Active voice, past tense.
- One sentence per bullet. No filler, no hedging, no repetition.
- Summarise, don't transcribe. State the conclusion, not the reasoning.
- Financial topics (budget, EBITDA, cash flow, revenue, costs, VAT) MUST be separated from operational topics (safety, production, staffing, maintenance).
- Owners by name. If unclear, "TBC".
- Never output confidence annotations, pipeline metadata, or status tags.

Language: ${outputLanguage}.`;
}

function buildDetailedStyleCore(outputLanguage: string): string {
    return `You are a corporate minute taker producing comprehensive meeting minutes.

<<< STYLE: DETAILED >>>

Full narrative minutes suitable for board or governance meetings. Target 800-2,000 words.

Structure:
1. **Header block** — Title, date, time, location, attendees with roles.
2. **Summary** — 3-5 sentences covering the meeting's overall outcome.
3. **Per-agenda-item narratives** — Each agenda item gets:
   - A narrative paragraph summarising discussion.
   - Sub-headings where an item spans multiple domains (financial vs operational must be separated).
   - Decisions and actions for that item.
   Use formal third-person past tense (e.g., "The Board considered...", "Management presented...", "It was resolved that...").
4. **Decisions table** — Maximum 10 rows. Columns: ID, Decision, Owner, Date.
5. **Actions table** — Maximum 15 rows. Columns: ID, Action, Owner, Due Date.
6. **Optional appendix** — Risks, deferred items, and items for noting.

Rules:
- Formal third-person past tense throughout. Use governance verbs (resolved, approved, delegated, noted, referred, deferred).
- Summarise and compress discussion — do not transcribe verbatim.
- Financial topics must be separated from operational topics with sub-headings.
- Record conflicts of interest, abstentions, and quorum (if mentioned).
- Cap decisions at 10 and actions at 15; consolidate where possible.
- Prioritize governance items: approvals, resolutions, delegations, risk appetite, fiduciary matters.
- Never output confidence annotations, pipeline metadata, or status tags.

Language: ${outputLanguage}.`;
}

function buildGuidedStyleCore(outputLanguage: string, styleReference?: string): string {
    const referenceSection = styleReference
        ? `\nThe following is a distilled style guide extracted from a previous set of meeting minutes.
Apply these conventions — voice, formatting, section types — to the current meeting:

${styleReference}

Do NOT slavishly follow topic headings from the reference. Use the reference's voice and structural patterns but adapt to the current meeting's agenda. Omit reference sections if not discussed; add new sections for undiscussed topics.`
        : '\nNo style reference was provided. Fall back to Standard style conventions.';

    return `You are a corporate minute taker producing minutes guided by a reference document.

<<< STYLE: GUIDED BY REFERENCE >>>

Extract narrative style, tone, and structural patterns from the reference and apply them to the current meeting.
${referenceSection}

Rules:
- Match the reference's voice, formatting, and section types.
- The JSON schema is still required; apply the reference style when rendering text fields.
- Never output confidence annotations, pipeline metadata, or status tags. If a fact is uncertain, express uncertainty in prose.

Language: ${outputLanguage}.`;
}

function buildSharedPromptSuffix(options: MinutesStylePromptOptions): string {
    const { useGTD, dualOutput, styleReference, customInstructions } = options;

    // Response format
    const responseFormatSection = dualOutput
        ? `<<< RESPONSE FORMAT - CRITICAL >>>

Your response MUST contain a valid JSON object matching the schema below.
Start with { (no preamble, no markdown fences, no text before the JSON).

After the JSON object, output this delimiter on its own line:
${MINUTES_JSON_DELIMITER}
followed by dual markdown minutes using exactly this structure:

## Minutes_Internal
[full detail markdown]

## Minutes_External
[sanitized markdown — remove internal tool names, sensitive pricing, strategy commentary]`
        : `<<< RESPONSE FORMAT - CRITICAL >>>

Your response MUST be a valid JSON object matching the schema below.
Start with { — no preamble, no markdown fences, no text before or after the JSON.
Output ONLY the JSON. Markdown will be rendered from it automatically.`;

    // Meeting context behavior
    const contextSection = `<<< MEETING CONTEXT BEHAVIOR >>>

meeting_context determines content depth:

internal
  - Include operational detail, internal acronyms, dependencies, resourcing constraints.

external
  - Meeting included external parties. Content may include commercially sensitive discussion.
  - Minutes should still capture full detail unless output_audience is external.

board
  - Prioritize governance: approvals, resolutions, delegations, risk appetite, fiduciary items.
  - Record conflicts of interest, abstentions, quorum (if mentioned).`;

    // Output audience behavior
    const audienceSection = `<<< OUTPUT AUDIENCE BEHAVIOR >>>

output_audience determines what to include in the markdown:

internal
  - Full detail appropriate for internal circulation.

external
  - Sanitize for external sharing: remove internal tool names, internal politics, sensitive pricing, strategy commentary, individual performance notes.
  - Keep commitments, decisions, and next steps crisp.
  - When in doubt, omit.`;

    // Accuracy rules
    const accuracySection = `<<< ACCURACY RULES >>>

- Never invent owners, dates, numbers, or decisions.
- If unclear or missing, mark as "TBC" and add to open_questions.
- If ambiguous but important, set confidence: "low" and include source_timecodes.
- Keep names consistent with the participant list or participant list text.
- verbatim_quote: Only populate when the transcript contains a clearly stated resolution text (e.g., chair reads a resolution aloud). Otherwise leave blank and add an open question: "Confirm resolution wording for [topic]".
- Never output confidence annotations, pipeline metadata, or status tags in rendered text. Confidence values exist in JSON for auditing only.`;

    // Deadline + owner inference
    const inferenceSection = `<<< DEADLINE INFERENCE >>>

Infer due dates from context: "next meeting" → actual date if known, "two months" → approximate date, "before summer" → approximate month.
Only use TBC when absolutely no temporal reference exists.

<<< OWNER INFERENCE >>>

Assign the person explicitly asked or who volunteered.
If no individual was named, default to the most senior operational person present and note "(owner not explicitly assigned)" in the action text.`;

    // Terminology dictionary
    const dictionarySection = `<<< TERMINOLOGY DICTIONARY >>>

If a terminology dictionary is provided, it contains pre-verified terms for this meeting context.
Use the dictionary to:
- Ensure correct spelling of names (people, projects, organizations)
- Expand acronyms correctly using the provided definitions
- Apply consistent terminology throughout the minutes
- Match names to roles/titles as specified

The dictionary entries are authoritative - prefer dictionary spellings over transcript guesses.`;

    // Context documents
    const contextDocsSection = `<<< CONTEXT DOCUMENTS >>>

If context_documents is provided in the input, it contains pre-extracted reference facts
distilled from the original meeting documents (agendas, presentations, reports).
Use these facts to:
- Verify correct spelling of names, project codes, and technical terms
- Cross-reference agenda items with supporting data (figures, dates, milestones)
- Expand acronyms and abbreviations using the provided definitions
- Validate numerical data and dates referenced in the transcript

IMPORTANT: Do NOT summarize the context facts. They are reference only for improving transcript accuracy.`;

    // GTD overlay
    const gtdSchemaFragment = useGTD ? `,
  "gtd_processing": {
      "next_actions": [{ "text": "", "context": "@office|@home|@call|@computer|@agenda|@errand", "owner": "", "energy": "low|medium|high" }],
      "waiting_for": [{ "text": "", "waiting_on": "", "chase_date": "" }],
      "projects": [""],
      "someday_maybe": [""]
  }` : '';

    const gtdOverlaySection = useGTD ? `

<<< GTD OVERLAY >>>

Classify each action into a GTD context:
- @office, @home, @call, @computer, @agenda (waiting for next meeting), @errand
Set energy: low (admin), medium (routine), high (complex/creative)

Identify items where we are waiting on someone else - add to waiting_for.
Identify multi-step commitments - add to projects (just the project name).
Identify suggestions/ideas not committed to - add to someday_maybe.` : '';

    const gtdSelfCheck = useGTD ? `
9. Every action is classified with a GTD context.` : '';

    // Style reference in shared suffix (for non-guided styles — guided handles its own)
    const styleRefSection = styleReference && options.minutesStyle !== 'guided'
        ? `
<<< STYLE REFERENCE >>>

The following is a distilled style guide extracted from a previous set of meeting minutes.
Apply these conventions when generating the output:

${styleReference}

The JSON schema above is still required; apply the style when rendering markdown sections
and when choosing phrasing for JSON text fields (actions, decisions, notable_points, etc.).` : '';

    // Output schema
    const schemaSection = `<<< OUTPUT SCHEMA >>>

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
  ]${gtdSchemaFragment}
}

IMPORTANT: Ensure all notable_points, decisions, actions, risks, open_questions,
and deferred_items are complete in the JSON.`;

    // Self-check
    const selfCheckSection = `<<< SELF-CHECK (run before returning) >>>

1. Response starts with { (no preamble).
2. JSON is valid (no trailing commas, all strings quoted).
3. Every action has an owner or is marked TBC.
4. Every decision references an agenda item or is flagged "no agenda ref".
5. No invented names, numbers, or dates.
6. Confidence is set for every item.
7. open_questions includes anything marked TBC.
8. verbatim_quote is empty unless resolution was explicitly read aloud.${gtdSelfCheck}`;

    // Custom instructions from user
    const customInstructionsSection = customInstructions
        ? `<<< ADDITIONAL INSTRUCTIONS >>>\n\nADDITIONAL INSTRUCTIONS: ${customInstructions}` : '';

    // Edge cases
    const edgeCasesSection = `<<< EDGE CASES >>>

- No clear decision reached: Add to open_questions with text "Decision pending: [topic]".
- Item explicitly deferred: Add to deferred_items with reason.
- Heated discussion, no resolution: Summarize positions neutrally in notable_points. Do not fabricate consensus.
- Missing agenda: Set agenda to [] and agenda_item_ref to null throughout.`;

    return [
        responseFormatSection,
        contextSection,
        audienceSection,
        accuracySection,
        inferenceSection,
        dictionarySection,
        contextDocsSection,
        styleRefSection,
        gtdOverlaySection,
        schemaSection,
        selfCheckSection,
        edgeCasesSection,
        customInstructionsSection,
    ].filter(Boolean).join('\n\n');
}

/**
 * Build a consolidation prompt for the chunked pipeline that uses the new style system.
 * This replaces the old buildConsolidationPrompt() for callers that use MinutesStylePromptOptions.
 */
export function buildStyleConsolidationPrompt(options: MinutesStylePromptOptions): string {
    const { minutesStyle, outputLanguage, useGTD, dualOutput, styleReference, customInstructions } = options;

    // Significance classifier for standard and detailed styles (Phase 2b)
    const significanceFilter = (minutesStyle === 'standard' || minutesStyle === 'detailed')
        ? `\nSIGNIFICANCE FILTER:
Classify each extracted item as:
- DECISION: Formally decided, approved, or agreed by the group.
- NOTED: The group was informed or acknowledged.
- ACTION: A specific person was assigned a task.
- BACKGROUND: Discussion detail, exploratory questions, technical explanation.
Only DECISION, NOTED, and ACTION items appear in the main minutes. BACKGROUND may appear in an appendix.
`
        : '';

    // Cross-referencing instruction (Phase 2e)
    const crossReferencing = `CROSS-REFERENCING: After extraction, review each item. If an item's content better matches a different agenda item, reassign its agenda_item_ref.`;

    const gtdSchemaFragment = useGTD ? `,
  "gtd_processing": {
      "next_actions": [{ "text": "", "context": "@office|@home|@call|@computer|@agenda|@errand", "owner": "", "energy": "low|high" }],
      "waiting_for": [{ "text": "", "waiting_on": "", "chase_date": "" }],
      "projects": [""],
      "someday_maybe": [""]
  }` : '';

    const gtdInstructions = useGTD ? `\nGTD OVERLAY: Classify each action into a GTD context (@office, @home, @call, @computer, @agenda, @errand). Set energy: low (admin) or high (complex). Add waiting_for, projects, someday_maybe as appropriate.` : '';

    const responseInstruction = dualOutput
        ? `RESPONSE: Valid JSON first. Start with { — no preamble, no markdown fences.
After the JSON, output the delimiter ${MINUTES_JSON_DELIMITER} then dual markdown:

## Minutes_Internal
[full detail markdown]

## Minutes_External
[sanitized markdown — remove internal tool names, sensitive pricing, strategy commentary]`
        : `RESPONSE: Valid JSON only. Start with { — no preamble, no markdown fences, no text after the JSON.`;

    // Style-specific consolidation instructions
    let styleInstruction = '';
    switch (minutesStyle) {
        case 'smart-brevity':
            styleInstruction = '\nSTYLE: Smart Brevity — target 300-600 words. Direct, active voice. Only formal decisions and explicitly assigned actions.';
            break;
        case 'detailed':
            styleInstruction = '\nSTYLE: Detailed — target 800-2,000 words. Formal third-person past tense. Governance verbs. Narrative paragraphs per agenda item. Separate financial from operational sub-topics. Cap decisions at 10, actions at 15, risks at 6.';
            break;
        case 'guided':
            styleInstruction = styleReference
                ? `\nSTYLE: Guided by reference — apply these conventions:\n${styleReference}`
                : '\nSTYLE: Standard format (no reference provided).';
            break;
        case 'standard':
        default:
            styleInstruction = '\nSTYLE: Standard — target 300-600 words. Maximum brevity: 1 short sentence per notable_point, max 1-3 per agenda item. Separate financial from operational. "Opportunities and obstacles" (3-5 items, 1 sentence each). Cap risks at 6.';
            break;
    }

    return `You are consolidating meeting items extracted from multiple transcript chunks into final minutes.

You receive pre-extracted items (actions, decisions, risks, notable_points, open_questions, deferred_items) plus meeting metadata.

TASK:
1. Deduplicate items (same action mentioned in multiple chunks = one action)
2. Renumber IDs sequentially (A1, A2... D1, D2...)
3. Link every item to its agenda_item_ref (1-based number matching the agenda array index). Use incoming refs from extraction; verify and correct against the agenda list. Set to null only when an item genuinely does not relate to any agenda topic.
4. Copy the agenda array from the input meeting metadata into the output JSON verbatim — do not rewrite or omit agenda items.
5. COMPRESS and SUMMARISE — the goal is concise, clear minutes, not a transcript reproduction. Merge similar notable_points covering the same sub-topic into one. Remove redundant detail. Each notable_point should be 1-2 sentences.
6. Cap risks at 6 maximum — keep only the most significant. Merge similar risks.
7. Group notable_points by sub-topic within each agenda item. Where an agenda item covers multiple sub-topics (e.g., a performance review covering safety, operations, finance), ensure notable_points for distinct sub-topics are grouped together and ordered logically.
${crossReferencing}
${significanceFilter}
RULES:
- Use ${outputLanguage}, concise corporate tone. Neutral, factual. No opinions.
- Never invent owners, dates, numbers. Use "TBC" if unclear and add to open_questions.
- Keep names consistent with the participant list or terminology dictionary.
- verbatim_quote: Only if a resolution was read aloud; otherwise leave empty.
- Quality over quantity for notable_points — concise summaries of what was discussed, not full reasoning chains. Discard low-value BACKGROUND items.
- Respect meeting_context in metadata (board = prioritize governance items, resolutions, fiduciary matters).
- Respect output_audience in metadata (internal = full detail, external = sanitize for sharing).
- Mark unclear items TBC and add to open_questions.
- If context_documents is included in the input payload, use those reference facts to verify names, dates, and figures.
- Never output confidence annotations, pipeline metadata, or status tags in rendered text.
${customInstructions ? `\nADDITIONAL INSTRUCTIONS: ${customInstructions}` : ''}${styleInstruction}${gtdInstructions}

${responseInstruction}

JSON SCHEMA:
{
  "metadata": { "title": "", "date": "", "start_time": "", "end_time": "", "timezone": "", "meeting_context": "", "output_audience": "", "confidentiality_level": "", "chair": "", "minute_taker": "", "location": "", "quorum_present": null },
  "participants": [{ "name": "", "role": "", "organisation": "", "attendance": "present|apologies|partial" }],
  "agenda": [],
  "decisions": [{ "id": "D1", "agenda_item_ref": null, "text": "", "owner": "", "due_date": "", "verbatim_quote": "", "confidence": "high|medium|low" }],
  "actions": [{ "id": "A1", "agenda_item_ref": null, "text": "", "owner": "TBC", "due_date": "TBC", "status": "new", "confidence": "high|medium|low" }],
  "risks": [{ "id": "R1", "text": "", "impact": "", "mitigation": "", "owner": "TBC", "confidence": "high|medium|low" }],
  "notable_points": [{ "id": "N1", "agenda_item_ref": null, "text": "", "confidence": "high|medium|low" }],
  "open_questions": [{ "id": "Q1", "text": "", "owner": "TBC", "confidence": "high|medium|low" }],
  "deferred_items": [{ "id": "P1", "text": "", "reason": "" }]${gtdSchemaFragment}
}`;
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

    return JSON.stringify(payload);
}

export interface ChunkExtractionContext {
    outputLanguage?: string;
    meetingContext?: MeetingContext;
    agenda?: string[];
    participantsRaw?: string;
    dictionaryContent?: string;
    /** Distilled context summary extracted from meeting documents */
    contextSummary?: string;
}

export function buildChunkExtractionPrompt(context?: ChunkExtractionContext): string {
    const lang = context?.outputLanguage || 'English';

    // Build optional context sections that help the LLM extract accurately
    const meetingContextSection = context?.meetingContext
        ? `\nMeeting type: ${context.meetingContext}${context.meetingContext === 'board' ? ' (prioritize governance items: approvals, resolutions, delegations, fiduciary matters)' : ''}`
        : '';

    const agendaSection = context?.agenda?.length
        ? `\nAgenda items:\n${context.agenda.map((item, i) => `${i + 1}. ${item}`).join('\n')}`
        : '';

    const participantsSection = context?.participantsRaw?.trim()
        ? `\nParticipant list (use for consistent name spelling):\n${context.participantsRaw}`
        : '';

    const dictionarySection = context?.dictionaryContent?.trim()
        ? `\nTerminology dictionary (use for correct spelling of names, acronyms, and terms):\n${context.dictionaryContent}`
        : '';

    const contextSection = context?.contextSummary?.trim()
        ? `\nContext reference (distilled from meeting documents — use for verifying names, dates, figures):\n${context.contextSummary}`
        : '';

    return `You are extracting meeting items from a transcript chunk. This is part of a longer meeting.

Output language: ${lang}
${meetingContextSection}${agendaSection}${participantsSection}${dictionarySection}${contextSection}

Extract ALL of the following categories:
- **Actions**: Tasks assigned to someone (owner if stated, otherwise TBC)
- **Decisions**: Conclusions reached or choices made by the group
- **Risks**: Only items the group explicitly identified as risks, or items from a formal risk register under review. Do not elevate discussion questions, historical events, or casual observations to risk status. If in doubt, classify as a notable point. Maximum 6 risks — keep only the most significant.
- **Notable points**: Key discussion topics and important context. Each notable point MUST be 1-2 sentences maximum — capture WHAT was discussed, not the full detail. Think headlines, not paragraphs.
- **Open questions**: Unresolved items, items marked TBC, or topics needing follow-up
- **Deferred items**: Topics explicitly postponed or tabled for a future meeting

Return valid JSON only, no other text:

{
  "actions": [{ "id": "A1", "agenda_item_ref": null, "text": "", "owner": "TBC", "due_date": "TBC", "confidence": "high|medium|low", "source_timecodes": [] }],
  "decisions": [{ "id": "D1", "agenda_item_ref": null, "text": "", "owner": "", "confidence": "high|medium|low", "source_timecodes": [] }],
  "risks": [{ "id": "R1", "text": "", "impact": "", "owner": "TBC", "confidence": "high|medium|low" }],
  "notable_points": [{ "id": "N1", "text": "", "agenda_item_ref": null, "confidence": "high|medium|low" }],
  "open_questions": [{ "id": "Q1", "text": "", "owner": "TBC", "confidence": "high|medium|low" }],
  "deferred_items": [{ "id": "P1", "text": "", "reason": "" }]
}

Rules:
- Use temporary IDs (A1, D1, etc.) — they will be renumbered in consolidation.
- Do not invent items. Only extract what is clearly stated or strongly implied.
- If an owner or date is unclear, use "TBC" and add a matching open_question.
- Keep names consistent with the participant list. Prefer dictionary spellings.
- For notable_points, write concise 1-2 sentence summaries — what was discussed and concluded, not the full reasoning. Do NOT reproduce transcript detail.
- If this chunk has no relevant items for a category, return an empty array for that category.
- Set confidence: "high" for explicitly stated items, "medium" for strongly implied, "low" for ambiguous.
- If agenda items are provided, set agenda_item_ref to the matching item number (1-based). If no clear match, set to null.`;
}

export interface IntermediateMergeContext {
    outputLanguage?: string;
    participantsRaw?: string;
}

export function buildIntermediateMergePrompt(context?: IntermediateMergeContext): string {
    const lang = context?.outputLanguage ? `\nOutput language: ${context.outputLanguage}` : '';
    const participants = context?.participantsRaw?.trim()
        ? `\nParticipant list (use for consistent name spelling):\n${context.participantsRaw}`
        : '';

    return `You are merging meeting extract batches. You receive multiple JSON extracts from consecutive transcript chunks.
${lang}${participants}
Your task:
1. Deduplicate semantically similar items (same action/decision described differently = keep a single, concise version)
2. Combine related items from adjacent chunks (e.g., a decision in one chunk and its rationale in another = merge into one concise item)
3. Compress notable_points — merge points covering the same sub-topic into a single 1-2 sentence summary. Remove redundant or low-value points.
4. Normalize participant names to be consistent (use participant list if available)
5. Cap risks at 8 per merge batch — keep only the most significant

Return valid JSON only, no other text. You MUST include ALL 6 fields even if empty:

{
  "actions": [{ "id": "A1", "agenda_item_ref": null, "text": "", "owner": "TBC", "due_date": "TBC", "confidence": "high|medium|low", "source_timecodes": [] }],
  "decisions": [{ "id": "D1", "agenda_item_ref": null, "text": "", "owner": "", "confidence": "high|medium|low", "source_timecodes": [] }],
  "risks": [{ "id": "R1", "text": "", "impact": "", "owner": "TBC", "confidence": "high|medium|low" }],
  "notable_points": [{ "id": "N1", "text": "", "agenda_item_ref": null, "confidence": "high|medium|low" }],
  "open_questions": [{ "id": "Q1", "text": "", "owner": "TBC", "confidence": "high|medium|low" }],
  "deferred_items": [{ "id": "P1", "text": "", "reason": "" }]
}

Rules:
- Use temporary IDs (A1, D1, etc.) — they will be renumbered in final consolidation.
- Do not invent items. Only merge and deduplicate what is provided.
- If an item appears in multiple chunks with different detail, merge into one concise version.
- Notable_points should be 1-2 sentences each. Merge points on the same sub-topic. Discard points that merely repeat a decision or action already captured.
- Preserve agenda_item_ref values during merge. If two merged items have different refs, keep the more specific one.`;
}

export function parseMinutesResponse(response: string): ParsedMinutes {

    // Strip code fences BEFORE any parsing (LLMs often wrap in ```json despite instructions)
    // Remove opening ```json and its matching closing ``` (may be mid-response, not just at end)
    let cleaned = response.trim();
    if (/^```json?\s*\n/i.test(cleaned)) {
        cleaned = cleaned.replace(/^```json?\s*\n/i, '');
        // Remove the first standalone ``` (closing fence)
        cleaned = cleaned.replace(/\n```\s*(?:\n|$)/, '\n');
    }
    cleaned = cleaned.trim();

    let jsonPart: string;
    let markdownPart: string;

    const delimiterIndex = cleaned.indexOf(MINUTES_JSON_DELIMITER);

    if (delimiterIndex !== -1) {
        jsonPart = cleaned.substring(0, delimiterIndex).trim();
        markdownPart = cleaned.substring(delimiterIndex + MINUTES_JSON_DELIMITER.length).trim();
    } else {
        jsonPart = extractJsonByBraceMatching(cleaned);
        const jsonEndIndex = cleaned.indexOf(jsonPart) + jsonPart.length;
        markdownPart = cleaned.substring(jsonEndIndex).trim();
        markdownPart = markdownPart.replace(/^---+\s*/m, '').trim();
    }

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
    let lastBalancedEnd = -1;

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
            if (char === '}') {
                depth--;
                if (depth === 0) {
                    return text.substring(start, i + 1);
                }
                // Track last point where we closed a nested object at depth 1
                // (useful for repairing truncated responses)
                if (depth === 1) {
                    lastBalancedEnd = i;
                }
            }
        }
    }

    // Truncated response — close at last balanced nested object
    if (lastBalancedEnd > start) {
        logger.warn('Minutes', 'extractJsonByBraceMatching — truncated JSON, repairing at position', lastBalancedEnd);
        // Find the content up to the last complete nested object, then close the root
        const partial = text.substring(start, lastBalancedEnd + 1);
        // Remove any trailing comma after the last complete value
        const trimmed = partial.replace(/,\s*$/, '');
        // Count unclosed brackets [ in the partial (ignoring those inside strings)
        let unclosedBrackets = 0;
        let inStr = false;
        let esc = false;
        for (let j = 0; j < trimmed.length; j++) {
            const c = trimmed[j];
            if (esc) { esc = false; continue; }
            if (c === '\\' && inStr) { esc = true; continue; }
            if (c === '"') { inStr = !inStr; continue; }
            if (!inStr) {
                if (c === '[') unclosedBrackets++;
                if (c === ']') unclosedBrackets--;
            }
        }
        const closingBrackets = ']'.repeat(Math.max(0, unclosedBrackets));
        return trimmed + closingBrackets + '}';
    }

    throw new Error('Unbalanced braces in JSON');
}

function parseJsonWithRepair(jsonStr: string): MinutesJSON {
    try {
        return JSON.parse(jsonStr);
    } catch {
        // Attempt repairs below
    }

    // Repair 1: Fix literal newlines/tabs inside JSON string values (common LLM failure)
    const newlineRepaired = repairJsonStrings(jsonStr);
    if (newlineRepaired !== jsonStr) {
        try { return JSON.parse(newlineRepaired); } catch { /* continue */ }
    }

    // Repair 2: Trailing commas + unquoted keys
    let repaired = newlineRepaired;
    repaired = repaired.replace(/,\s*([}\]])/g, '$1');
    repaired = repaired.replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3');

    try {
        return JSON.parse(repaired);
    } catch (error) {
        throw new Error(`JSON parse failed after repair: ${(error as Error).message}`);
    }
}

/**
 * Response shape returned by agenda document extraction.
 */
export interface AgendaExtractionResult {
    title: string;
    date: string;
    startTime: string;
    endTime: string;
    location: string;
    participants: string[];
    agendaItems: string[];
}

/**
 * Builds a prompt that extracts meeting metadata and agenda items from a document.
 * Returns structured JSON so we can auto-fill form fields.
 */
export function buildAgendaExtractionPrompt(documentText: string): string {
    return `<task>
Extract meeting metadata and agenda items from the following document.
</task>

<requirements>
- Extract the meeting title, date, start time, end time, location, participants/attendees, and agenda items.
- Date must be ISO format YYYY-MM-DD (e.g. 2026-02-15). If no year, assume the current or next occurrence.
- Times must be HH:MM in 24-hour format (e.g. 14:00). Convert from AM/PM if needed.
- Participants: extract names of attendees, invitees, members, or participants. Include roles/titles if mentioned (e.g. "Jane Smith (Chair)"). One person per array entry.
- Agenda items should be concise single-line descriptions, one per item.
- If a field is not found in the document, return an empty string (or empty array for agendaItems/participants).
- Do NOT invent information that is not in the document.
</requirements>

<output_format>
Return ONLY valid JSON, no markdown fences, no commentary:
{
  "title": "Meeting title or empty string",
  "date": "YYYY-MM-DD or empty string",
  "startTime": "HH:MM or empty string",
  "endTime": "HH:MM or empty string",
  "location": "Location or empty string",
  "participants": ["Name (Role)", "Name"],
  "agendaItems": ["Item 1", "Item 2"]
}
</output_format>

<document>
${documentText}
</document>`;
}

/**
 * Parses the LLM response from the agenda extraction prompt.
 * Uses the 3-tier JSON extraction approach (direct → code fence → object search).
 */
export function parseAgendaExtractionResponse(response: string): AgendaExtractionResult {
    const empty: AgendaExtractionResult = { title: '', date: '', startTime: '', endTime: '', location: '', participants: [], agendaItems: [] };

    if (!response?.trim()) return empty;

    const parsed = tryParseAgendaJson(response);
    if (!parsed) return empty;

    return {
        title: typeof parsed.title === 'string' ? parsed.title : '',
        date: typeof parsed.date === 'string' ? parsed.date : '',
        startTime: typeof parsed.startTime === 'string' ? parsed.startTime : '',
        endTime: typeof parsed.endTime === 'string' ? parsed.endTime : '',
        location: typeof parsed.location === 'string' ? parsed.location : '',
        participants: Array.isArray(parsed.participants)
            ? parsed.participants.filter((i: unknown) => typeof i === 'string' && (i).trim())
            : [],
        agendaItems: Array.isArray(parsed.agendaItems)
            ? parsed.agendaItems.filter((i: unknown) => typeof i === 'string' && (i).trim())
            : [],
    };
}

/** Maximum character length for a distilled style guide. */
export const STYLE_GUIDE_MAX_CHARS = 1500;

/** Maximum character length for distilled context document summaries. */
export const CONTEXT_SUMMARY_MAX_CHARS = 5000;

/**
 * Builds a prompt that asks the LLM to distill a previous set of meeting minutes
 * into a concise style guide. The output is a short description of formatting conventions
 * that can be injected into the main minutes system prompt — much cheaper than embedding
 * the entire reference document verbatim.
 */
export function buildStyleExtractionPrompt(referenceDocument: string): string {
    return `You are analyzing a previous set of meeting minutes to extract a reusable style guide.

<task>
Read the reference document below and produce a concise style guide that captures
the formatting conventions, tone, and structure — but NONE of the actual content.
</task>

<requirements>
Describe each of these aspects in 1-3 bullet points:
1. **Heading structure**: How sections are numbered/named (e.g., "1. Opening", "## Decisions")
2. **Participant references**: How people are mentioned (full name, surname only, title + name, role-first)
3. **Tone & formality**: Register (formal/semi-formal), passive vs active voice, third person usage
4. **Action/decision phrasing**: How actions and resolutions are expressed (e.g., "The Board decided...", "Action: X to do Y by Z")
5. **Detail level**: Verbose or concise — how much context accompanies each agenda item
6. **Numbering conventions**: Bullet style, numbered lists, sub-numbering patterns
7. **Temporal references**: How dates and deadlines are formatted
8. **Notable patterns**: Any other distinctive formatting choices (appendices, standing items, opening/closing formulae)
</requirements>

<output_format>
Plain text with section headers. No JSON. No code fences. Keep under ${STYLE_GUIDE_MAX_CHARS} characters total.
Do NOT reproduce, quote, or reference any specific facts, names, decisions, numbers, or dates from the document.
The guide should be entirely transferable to a different meeting on a different topic.
</output_format>

Reference document:
---
${referenceDocument}
---`;
}

/**
 * Builds a prompt that asks the LLM to distill context documents (agendas, presentations,
 * spreadsheets) into a concise reference of meeting-relevant facts. The output replaces the
 * raw documents in the minutes prompt — dramatically reducing token usage while preserving
 * all verifiable facts the minutes LLM needs.
 */
export function buildContextExtractionPrompt(contextDocuments: string): string {
    return `You are preparing a reference sheet for a meeting minute-taker.

<task>
Read the context documents below and produce a concise reference sheet
that extracts ONLY meeting-relevant facts. The minute-taker will use this to verify names,
dates, figures, and terminology — not to summarize the documents themselves.
</task>

<requirements>
Extract and organize:
1. **People**: Full names, titles, roles, organizational affiliations — exactly as written
2. **Dates & deadlines**: All dates, timeframes, milestones, fiscal periods mentioned
3. **Figures & data**: Financial numbers, KPIs, statistics, percentages, quantities
4. **Agenda items & topics**: Numbered/listed items with their key points
5. **Projects & initiatives**: Names, codes, status, dependencies
6. **Acronyms & terms**: Abbreviations with expansions, technical vocabulary
7. **Decisions & proposals**: Items up for approval, motions, recommendations
8. **Action items**: Pre-existing tasks, follow-ups from previous meetings

Critical rules:
- Preserve EXACT spellings of names, project codes, and figures — do not paraphrase numbers
- Use the same language as the source documents
- Omit narrative prose, background explanations, and filler text
- Group by category (use the numbered categories above as headers)
- If a document is an agenda, preserve the agenda structure
- If a fact appears in multiple documents, include it once with the most complete version
</requirements>

<output_format>
Plain text with category headers. No JSON. No code fences.
Keep under ${CONTEXT_SUMMARY_MAX_CHARS} characters total.
Every fact must be traceable to the source documents — do not infer or extrapolate.
</output_format>

Context documents:
---
${contextDocuments}
---`;
}

/** 3-tier JSON extraction: direct → code fence → object search */
function tryParseAgendaJson(response: string): Record<string, unknown> | null {
    // Tier 1: Direct parse
    try { return JSON.parse(response.trim()); } catch { /* continue */ }

    // Tier 2: Code fence
    const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)```/.exec(response);
    if (fenceMatch) {
        try { return JSON.parse(fenceMatch[1].trim()); } catch { /* continue */ }
    }

    // Tier 3: Object search
    const objMatch = /\{[\s\S]*\}/.exec(response);
    if (objMatch) {
        try { return JSON.parse(objMatch[0]); } catch { /* continue */ }
    }

    return null;
}

// ============================================================================
// Speaker Labelling Prompt (Phase 4a — TRA Plan)
// ============================================================================

/**
 * Build a prompt that asks the LLM to label unlabelled transcript lines with
 * speaker names inferred from context, participant list, and conversational cues.
 *
 * The LLM returns the same transcript text with "Speaker Name: " prefixed to
 * each line where a speaker can be inferred.
 */
export function buildSpeakerLabellingPrompt(
    participants: string[],
    meetingContext?: string,
    previousContext?: string,
    transcriptSegment?: string
): string {
    const participantList = participants.length > 0
        ? `Known participants:\n${participants.map(p => `- ${p}`).join('\n')}`
        : 'No participant list available. Infer speaker names from context clues.';

    const contextHint = meetingContext
        ? `\nMeeting context: ${meetingContext}`
        : '';

    const continuitySection = previousContext
        ? `\nFor continuity, here is the end of the previous labelled segment:\n---\n${previousContext}\n---\n`
        : '';

    return `You are a transcript editor. Your task is to add speaker labels to an unlabelled meeting transcript.

${participantList}${contextHint}
${continuitySection}
<task>
Read the transcript below and add speaker labels to each line or paragraph.
Output the same text with "Speaker Name: " prepended to each speaker turn.
</task>

<requirements>
- Use the participant names from the list above when you can identify who is speaking.
- Use conversational cues to identify speakers: self-introductions, being addressed by name, role-specific language, turn-taking patterns.
- If you cannot identify a speaker, use "Unknown Speaker" as the label.
- Do NOT change the transcript content. Only add speaker labels.
- Do NOT add commentary, explanations, or formatting beyond the speaker labels.
- Keep the original line breaks and paragraph structure.
- If a speaker continues across multiple lines/sentences without interruption, label only the first line of their turn.
- When a new speaker starts, always add a label even if consecutive lines are from the same speaker.
</requirements>

<output_format>
Return ONLY the labelled transcript. No preamble, no explanation, no code fences.

Example input:
Good morning everyone. Let's start with the budget review.
I think we should increase the Q3 allocation.
Agreed. Let's put that to a vote.

Example output:
Alice: Good morning everyone. Let's start with the budget review.
Bob: I think we should increase the Q3 allocation.
Alice: Agreed. Let's put that to a vote.
</output_format>

Transcript to label:
---
${transcriptSegment || ''}
---`;
}
