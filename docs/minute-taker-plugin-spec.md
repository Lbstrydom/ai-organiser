# Minute Taker Persona - AI Organiser Integration

**Version:** 1.1  
**Date:** 23 January 2026  
**Target:** AI Organiser plugin v1.0.15+  
**Changelog:** v1.1 incorporates review feedback (type/audience split, parser robustness, chunking, JSON recovery, language settings, verbatim quote guardrails, first-class personas)

---

## 1. Overview

Add a "Meeting Minutes" command to AI Organiser that processes meeting transcripts and produces structured minutes. Follows the existing persona pattern used by summarization and note improvement.

### Fits into existing architecture

```
src/
├── commands/
│   └── minutesCommand.ts              # NEW: Register minutes command
├── services/
│   └── prompts/
│       └── minutesPrompt.ts           # NEW: System prompt + input builder
│   └── minutesChunker.ts              # NEW: Long transcript chunking
├── ui/
│   └── modals/
│       └── MinutesModal.ts            # NEW: Meeting metadata + transcript input
└── i18n/
    ├── en.ts                          # Add minutes strings
    └── zh-CN.ts                       # Add minutes strings
```

Config file (user-editable, first-class):

```
AI-Organiser/
└── Config/
    └── minutes-personas.md            # NEW: Meeting type templates (required)
```

---

## 2. Key concepts (revised)

### 2.1 Separation of concerns

Three distinct concepts, independently set:

| Concept | Field | Values | Meaning |
|---------|-------|--------|---------|
| **Meeting context** | `meeting_context` | `internal`, `external`, `board` | Who is in the meeting |
| **Output audience** | `output_audience` | `internal`, `external` | Who will read this document |
| **Confidentiality** | `confidentiality_level` | `public`, `internal`, `confidential`, `strictly_confidential` | Distribution constraints |

**Examples:**

- External client meeting, internal-only minutes → `meeting_context: external`, `output_audience: internal`
- Board meeting with investor excerpt → `meeting_context: board`, `output_audience: external` (dual output)
- Internal team sync, shareable summary → `meeting_context: internal`, `output_audience: external` (dual output)

### 2.2 Output language

Output language follows existing plugin language settings. No hard-coded "British English". The prompt dynamically inserts:

```
Use {outputLanguage} and concise corporate tone.
```

Where `{outputLanguage}` comes from `settings.outputLanguage` or defaults to "American English" for consistency with the rest of the app.

---

## 3. Command registration

### `src/commands/minutesCommand.ts`

```typescript
import { Plugin, Notice } from 'obsidian';
import { MinutesModal } from '../ui/modals/MinutesModal';

export function registerMinutesCommand(plugin: Plugin) {
  plugin.addCommand({
    id: 'generate-meeting-minutes',
    name: 'Generate meeting minutes',
    callback: () => {
      new MinutesModal(plugin.app, plugin).open();
    },
  });
}
```

Register in `main.ts` alongside existing commands.

---

## 4. Modal

### `src/ui/modals/MinutesModal.ts`

Collect meeting metadata and transcript. Similar pattern to existing summarization modals.

**Fields:**

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| Title | text | yes | - | |
| Date | date picker | yes | today | |
| Start time | time | yes | - | |
| End time | time | yes | - | |
| Location | text | yes | - | |
| Meeting context | dropdown | yes | internal | Who was in the meeting |
| Output audience | dropdown | yes | internal | Who will read this |
| Confidentiality | dropdown | yes | internal | |
| Chair | text | yes | - | |
| Persona | dropdown | yes | Corporate minutes | From minutes-personas.md |
| Agenda | textarea | no | - | One item per line |
| Participants | textarea | yes | - | `Name, Role, Org, present/apologies` |
| Transcript | textarea or file | yes | - | Paste or select .md/.txt |
| Generate external version | toggle | no | false | Creates sanitized second output |
| Obsidian Tasks format | toggle | no | false | Actions as `- [ ] ...` |

**Privacy warning (shown when `output_audience: external` or dual output enabled):**

> ⚠️ Transcripts may contain confidential information. External output will be sanitized but should be reviewed before sharing.

**Meeting context options:** `internal`, `external`, `board`

**Output audience options:** `internal`, `external`

**Confidentiality options:** `public`, `internal`, `confidential`, `strictly_confidential`

**On submit:**
1. Check transcript length → if > threshold, use chunked path
2. Build prompt with selected persona
3. Call LLM via existing CloudService/LocalService
4. Parse response with recovery logic
5. Create output note(s)

---

## 5. Personas (first-class)

### `AI-Organiser/Config/minutes-personas.md`

User-editable file, same pattern as `summary-personas.md` and `writing-personas.md`.

**Default content:**

```markdown
# Minutes Personas

## Corporate minutes
Standard corporate minutes with decisions, actions, risks, and key discussion points. Suitable for most internal and external meetings.

## Board governance
Emphasizes governance items: resolutions, approvals, delegations, risk appetite, fiduciary matters. Records conflicts of interest, abstentions, and quorum. Uses formal resolution language.

## Action register only
Minimal output focused on actions and decisions. Skips detailed discussion summaries. Best for operational syncs where only follow-ups matter.

## Client MoM short
Brief meeting summary for client circulation. Focuses on agreed commitments and next steps. Omits internal context and detailed discussion.

## Technical review
Detailed technical minutes capturing architecture decisions, trade-offs discussed, and technical debt items. Includes risk and dependency tracking.
```

**Loader:** Parse headings as persona names, body as persona instructions. Inject selected persona into system prompt.

---

## 6. Prompt engineering (revised)

### `src/services/prompts/minutesPrompt.ts`

```typescript
export interface MeetingMetadata {
  title: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:MM
  endTime: string; // HH:MM
  timezone: string;
  meetingContext: 'internal' | 'external' | 'board';
  outputAudience: 'internal' | 'external';
  confidentialityLevel: 'public' | 'internal' | 'confidential' | 'strictly_confidential';
  chair: string;
  location: string;
  agenda: string[];
  dualOutput: boolean;
  obsidianTasksFormat: boolean;
}

export interface Participant {
  name: string;
  role?: string;
  organisation?: string;
  attendance: 'present' | 'apologies' | 'partial';
}

export interface TranscriptSegment {
  t?: string;
  speaker?: string;
  text: string;
}

const DELIMITER = '<<AIO_MINUTES_JSON_END>>';

export function buildMinutesSystemPrompt(
  outputLanguage: string,
  personaInstructions: string
): string {
  return `You are a corporate minute taker for professional meetings.

<<< RESPONSE FORMAT - CRITICAL >>>

Your response MUST start with a valid JSON object (no preamble, no markdown fences).
After the JSON, output exactly this delimiter on its own line:
${DELIMITER}
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
- Keep names consistent with the participant list.
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
  transcript: TranscriptSegment[] | string
): string {
  const payload = {
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
      minute_taker: 'AI Organiser',
    },
    participants,
    transcript,
  };
  return JSON.stringify(payload, null, 2);
}
```

---

## 7. Response parsing (robust)

### `src/services/prompts/minutesPrompt.ts` (continued)

```typescript
const DELIMITER = '<<AIO_MINUTES_JSON_END>>';

export interface ParsedMinutes {
  json: MinutesJSON;
  markdown: string;
  markdownExternal: string | null;
}

/**
 * Parse minutes response with recovery logic.
 * 
 * Strategy:
 * 1. Try clean parse (JSON + delimiter + markdown)
 * 2. If delimiter missing, try to extract JSON by brace matching
 * 3. If JSON invalid, attempt basic repairs
 * 4. Throw only if unrecoverable
 */
export function parseMinutesResponse(response: string): ParsedMinutes {
  let jsonPart: string;
  let markdownPart: string;

  const delimiterIndex = response.indexOf(DELIMITER);

  if (delimiterIndex !== -1) {
    // Clean case: delimiter present
    jsonPart = response.substring(0, delimiterIndex).trim();
    markdownPart = response.substring(delimiterIndex + DELIMITER.length).trim();
  } else {
    // Fallback: extract JSON by brace matching
    jsonPart = extractJsonByBraceMatching(response);
    // Everything after the JSON is markdown
    const jsonEndIndex = response.indexOf(jsonPart) + jsonPart.length;
    markdownPart = response.substring(jsonEndIndex).trim();
    // Clean up any accidental delimiter fragments or markdown fences
    markdownPart = markdownPart.replace(/^---+\s*/m, '').trim();
  }

  // Remove markdown fences if present
  jsonPart = jsonPart.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();

  // Attempt JSON parse with repair
  const minutesJson = parseJsonWithRepair(jsonPart);

  // Parse dual output
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

/**
 * Extract JSON object by finding first { and matching closing }.
 */
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

/**
 * Attempt to parse JSON with common repairs.
 */
function parseJsonWithRepair(jsonStr: string): MinutesJSON {
  // First try clean parse
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    // Attempt repairs
  }

  let repaired = jsonStr;

  // Remove trailing commas before } or ]
  repaired = repaired.replace(/,\s*([}\]])/g, '$1');

  // Fix unquoted property names (common with some models)
  repaired = repaired.replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3');

  // Second attempt
  try {
    return JSON.parse(repaired);
  } catch (e) {
    throw new Error(`JSON parse failed after repair: ${(e as Error).message}`);
  }
}
```

---

## 8. Long transcript chunking

### `src/services/minutesChunker.ts`

For transcripts exceeding context limits, use a 2-pass approach (mirrors existing audio chunking pattern).

```typescript
import { TranscriptSegment, MinutesJSON, Action, Decision, Risk, NotablePoint, OpenQuestion } from './prompts/minutesPrompt';

const CHUNK_TOKEN_LIMIT = 6000; // Leave room for prompt + response
const APPROX_CHARS_PER_TOKEN = 4;
const CHUNK_CHAR_LIMIT = CHUNK_TOKEN_LIMIT * APPROX_CHARS_PER_TOKEN;

export interface ChunkExtract {
  chunkIndex: number;
  actions: Action[];
  decisions: Decision[];
  risks: Risk[];
  notable_points: NotablePoint[];
  open_questions: OpenQuestion[];
}

/**
 * Check if transcript needs chunking.
 */
export function needsChunking(transcript: TranscriptSegment[] | string): boolean {
  const text = typeof transcript === 'string' 
    ? transcript 
    : transcript.map(s => s.text).join(' ');
  return text.length > CHUNK_CHAR_LIMIT;
}

/**
 * Split transcript into chunks with overlap for context.
 */
export function chunkTranscript(
  transcript: TranscriptSegment[] | string,
  overlapSegments: number = 2
): (TranscriptSegment[] | string)[] {
  if (typeof transcript === 'string') {
    return chunkPlainText(transcript);
  }

  const chunks: TranscriptSegment[][] = [];
  let currentChunk: TranscriptSegment[] = [];
  let currentLength = 0;

  for (let i = 0; i < transcript.length; i++) {
    const segment = transcript[i];
    const segmentLength = segment.text.length;

    if (currentLength + segmentLength > CHUNK_CHAR_LIMIT && currentChunk.length > 0) {
      chunks.push(currentChunk);
      // Start new chunk with overlap
      const overlapStart = Math.max(0, currentChunk.length - overlapSegments);
      currentChunk = currentChunk.slice(overlapStart);
      currentLength = currentChunk.reduce((sum, s) => sum + s.text.length, 0);
    }

    currentChunk.push(segment);
    currentLength += segmentLength;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function chunkPlainText(text: string): string[] {
  const chunks: string[] = [];
  const overlapChars = 500;

  for (let i = 0; i < text.length; i += CHUNK_CHAR_LIMIT - overlapChars) {
    chunks.push(text.substring(i, i + CHUNK_CHAR_LIMIT));
  }

  return chunks;
}

/**
 * Build extraction-only prompt for Pass 1.
 */
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

/**
 * Build consolidation prompt for Pass 2.
 */
export function buildConsolidationPrompt(
  outputLanguage: string,
  personaInstructions: string
): string {
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

/**
 * Merge chunk extracts, removing obvious duplicates.
 */
export function mergeChunkExtracts(extracts: ChunkExtract[]): ChunkExtract {
  const merged: ChunkExtract = {
    chunkIndex: -1,
    actions: [],
    decisions: [],
    risks: [],
    notable_points: [],
    open_questions: [],
  };

  const seenActions = new Set<string>();
  const seenDecisions = new Set<string>();

  for (const extract of extracts) {
    for (const action of extract.actions) {
      const key = normalizeForDedup(action.text);
      if (!seenActions.has(key)) {
        seenActions.add(key);
        merged.actions.push(action);
      }
    }

    for (const decision of extract.decisions) {
      const key = normalizeForDedup(decision.text);
      if (!seenDecisions.has(key)) {
        seenDecisions.add(key);
        merged.decisions.push(decision);
      }
    }

    // Risks, notable points, open questions: less likely to duplicate, include all
    merged.risks.push(...extract.risks);
    merged.notable_points.push(...extract.notable_points);
    merged.open_questions.push(...extract.open_questions);
  }

  return merged;
}

function normalizeForDedup(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim().substring(0, 100);
}
```

---

## 9. Output handling

### Obsidian Tasks format (optional)

When `obsidianTasksFormat: true`, append actions as Obsidian Tasks after the table:

```typescript
function formatActionsAsObsidianTasks(actions: Action[]): string {
  return actions.map(a => {
    const owner = a.owner !== 'TBC' ? ` (${a.owner})` : '';
    const due = a.due_date !== 'TBC' ? ` 📅 ${a.due_date}` : '';
    return `- [ ] ${a.text}${owner}${due}`;
  }).join('\n');
}
```

### Save output

```typescript
async function saveMinutesOutput(
  plugin: Plugin,
  parsed: ParsedMinutes,
  metadata: MeetingMetadata,
  outputFolder: string
): Promise<void> {
  const { json, markdown, markdownExternal } = parsed;
  const dateStr = json.metadata.date;
  const safeTitle = json.metadata.title.replace(/[\\/:*?"<>|]/g, '-');

  // Ensure folder exists
  await ensureFolderExists(plugin.app.vault, outputFolder);

  // Build frontmatter
  const frontmatter = buildFrontmatter(json);
  
  // Append Obsidian Tasks if enabled
  let fullMarkdown = markdown;
  if (metadata.obsidianTasksFormat && json.actions.length > 0) {
    fullMarkdown += '\n\n## Tasks\n\n' + formatActionsAsObsidianTasks(json.actions);
  }

  const fullContent = `---\n${frontmatter}---\n\n${fullMarkdown}`;

  // Main minutes note
  const mainFileName = `${dateStr} ${safeTitle}.md`;
  const mainPath = `${outputFolder}/${mainFileName}`;
  await plugin.app.vault.create(mainPath, fullContent);

  // External version (if dual output)
  if (markdownExternal) {
    const extFileName = `${dateStr} ${safeTitle} (External).md`;
    const extPath = `${outputFolder}/${extFileName}`;
    await plugin.app.vault.create(extPath, markdownExternal);
  }

  // JSON sidecar
  const jsonFileName = `${dateStr} ${safeTitle}.json`;
  const jsonPath = `${outputFolder}/${jsonFileName}`;
  await plugin.app.vault.create(jsonPath, JSON.stringify(json, null, 2));

  new Notice(`Minutes saved: ${mainFileName}`);
}

function buildFrontmatter(json: MinutesJSON): string {
  const hasTbc = json.actions.some(a => a.owner === 'TBC' || a.due_date === 'TBC') ||
                 json.open_questions.length > 0;

  return `aio_type: minutes
aio_meeting_context: ${json.metadata.meeting_context}
aio_output_audience: ${json.metadata.output_audience}
aio_date: ${json.metadata.date}
aio_chair: ${json.metadata.chair}
aio_confidentiality: ${json.metadata.confidentiality_level}
aio_actions_count: ${json.actions.length}
aio_decisions_count: ${json.decisions.length}
aio_has_tbc: ${hasTbc}
aio_quorum: ${json.metadata.quorum_present ?? 'null'}
`;
}
```

---

## 10. Settings

Add to `src/core/settings.ts`:

```typescript
// Add to AIOSettings interface
minutesOutputFolder: string;
minutesDefaultTimezone: string;
minutesDefaultPersona: string;
minutesObsidianTasksFormat: boolean;

// Defaults
minutesOutputFolder: 'Meetings',
minutesDefaultTimezone: 'Europe/Amsterdam',
minutesDefaultPersona: 'Corporate minutes',
minutesObsidianTasksFormat: false,
```

Settings section in `src/ui/settings/MinutesSettingsSection.ts`:

```typescript
containerEl.createEl('h3', { text: 'Meeting Minutes' });

new Setting(containerEl)
  .setName('Output folder')
  .setDesc('Where to save generated minutes')
  .addText(text => text
    .setPlaceholder('Meetings')
    .setValue(settings.minutesOutputFolder)
    .onChange(async (value) => {
      settings.minutesOutputFolder = value;
      await plugin.saveSettings();
    }));

new Setting(containerEl)
  .setName('Default timezone')
  .setDesc('IANA timezone (e.g., Europe/Amsterdam)')
  .addText(text => text
    .setPlaceholder('Europe/Amsterdam')
    .setValue(settings.minutesDefaultTimezone)
    .onChange(async (value) => {
      settings.minutesDefaultTimezone = value;
      await plugin.saveSettings();
    }));

new Setting(containerEl)
  .setName('Default persona')
  .setDesc('Default minutes style from minutes-personas.md')
  .addDropdown(dropdown => {
    // Populate from parsed personas file
    personas.forEach(p => dropdown.addOption(p.name, p.name));
    dropdown.setValue(settings.minutesDefaultPersona);
    dropdown.onChange(async (value) => {
      settings.minutesDefaultPersona = value;
      await plugin.saveSettings();
    });
  });

new Setting(containerEl)
  .setName('Obsidian Tasks format')
  .setDesc('Add actions as Obsidian Tasks (- [ ] format) below the table')
  .addToggle(toggle => toggle
    .setValue(settings.minutesObsidianTasksFormat)
    .onChange(async (value) => {
      settings.minutesObsidianTasksFormat = value;
      await plugin.saveSettings();
    }));
```

---

## 11. i18n strings

### `src/i18n/en.ts`

```typescript
minutes: {
  commandName: 'Generate meeting minutes',
  modalTitle: 'Meeting Minutes',
  fieldTitle: 'Meeting title',
  fieldDate: 'Date',
  fieldStartTime: 'Start time',
  fieldEndTime: 'End time',
  fieldLocation: 'Location',
  fieldMeetingContext: 'Meeting context',
  fieldMeetingContextInternal: 'Internal',
  fieldMeetingContextExternal: 'External (client/partner)',
  fieldMeetingContextBoard: 'Board',
  fieldOutputAudience: 'Output audience',
  fieldOutputAudienceInternal: 'Internal only',
  fieldOutputAudienceExternal: 'External (shareable)',
  fieldConfidentiality: 'Confidentiality',
  fieldChair: 'Chair',
  fieldPersona: 'Minutes style',
  fieldAgenda: 'Agenda (one item per line)',
  fieldParticipants: 'Participants (Name, Role, Org, present/apologies)',
  fieldTranscript: 'Transcript',
  fieldDualOutput: 'Generate external version',
  fieldDualOutputDesc: 'Creates sanitized version for external sharing',
  fieldObsidianTasks: 'Obsidian Tasks format',
  fieldObsidianTasksDesc: 'Add actions as - [ ] checkboxes',
  privacyWarning: 'Transcripts may contain confidential information. External output will be sanitized but should be reviewed before sharing.',
  generating: 'Generating minutes...',
  generatingChunk: 'Processing chunk {current}/{total}...',
  consolidating: 'Consolidating minutes...',
  saved: 'Minutes saved',
  errorParsing: 'Failed to parse minutes response',
  errorMissingFields: 'Please fill in all required fields',
  errorNoPersonas: 'No personas found. Create AI-Organiser/Config/minutes-personas.md',
},
```

### `src/i18n/zh-CN.ts`

```typescript
minutes: {
  commandName: '生成会议纪要',
  modalTitle: '会议纪要',
  fieldTitle: '会议标题',
  fieldDate: '日期',
  fieldStartTime: '开始时间',
  fieldEndTime: '结束时间',
  fieldLocation: '地点',
  fieldMeetingContext: '会议类型',
  fieldMeetingContextInternal: '内部会议',
  fieldMeetingContextExternal: '外部会议（客户/合作伙伴）',
  fieldMeetingContextBoard: '董事会',
  fieldOutputAudience: '输出受众',
  fieldOutputAudienceInternal: '仅内部',
  fieldOutputAudienceExternal: '外部（可分享）',
  fieldConfidentiality: '保密级别',
  fieldChair: '主持人',
  fieldPersona: '纪要风格',
  fieldAgenda: '议程（每行一项）',
  fieldParticipants: '参会人员（姓名, 职位, 组织, present/apologies）',
  fieldTranscript: '会议记录',
  fieldDualOutput: '生成外部版本',
  fieldDualOutputDesc: '创建可供外部分享的精简版本',
  fieldObsidianTasks: 'Obsidian Tasks 格式',
  fieldObsidianTasksDesc: '以 - [ ] 复选框格式添加行动项',
  privacyWarning: '会议记录可能包含机密信息。外部输出将被脱敏处理，但分享前应进行审核。',
  generating: '正在生成会议纪要...',
  generatingChunk: '正在处理第 {current}/{total} 块...',
  consolidating: '正在整合会议纪要...',
  saved: '会议纪要已保存',
  errorParsing: '解析会议纪要失败',
  errorMissingFields: '请填写所有必填字段',
  errorNoPersonas: '未找到风格模板。请创建 AI-Organiser/Config/minutes-personas.md',
},
```

---

## 12. Test cases

| # | Scenario | Expected |
|---|----------|----------|
| 1 | Internal meeting, basic transcript | Minutes note + JSON sidecar created |
| 2 | External context, internal audience | Full detail minutes (not sanitized) |
| 3 | Internal context, external audience | Sanitized minutes |
| 4 | Board meeting | Resolutions, conflicts, quorum captured; verbatim_quote only if explicit |
| 5 | Dual output enabled | Two markdown files created |
| 6 | Missing owner in transcript | `owner: "TBC"`, `aio_has_tbc: true` |
| 7 | No agenda provided | `agenda: []`, all refs null |
| 8 | Transcript from file | File content loaded and processed |
| 9 | LLM returns malformed JSON | Repair attempted, fallback to error only if unrecoverable |
| 10 | LLM omits delimiter | JSON extracted by brace matching |
| 11 | Long transcript (> 6K tokens) | Chunked processing with progress notifications |
| 12 | Obsidian Tasks format enabled | Actions appended as `- [ ]` items |
| 13 | No minutes-personas.md | Error notice with instructions |
| 14 | Output folder doesn't exist | Folder created automatically |
| 15 | Mobile | Modal renders, no vector store calls |
| 16 | Resolution read aloud in board meeting | verbatim_quote populated |
| 17 | Resolution implied but not read aloud | verbatim_quote empty, open_question added |

---

## 13. Files to create/modify

| File | Action |
|------|--------|
| `src/commands/minutesCommand.ts` | Create |
| `src/services/prompts/minutesPrompt.ts` | Create |
| `src/services/minutesChunker.ts` | Create |
| `src/ui/modals/MinutesModal.ts` | Create |
| `src/ui/settings/MinutesSettingsSection.ts` | Create |
| `src/core/settings.ts` | Add fields |
| `src/main.ts` | Register command, settings section |
| `src/i18n/en.ts` | Add strings |
| `src/i18n/zh-CN.ts` | Add strings |
| `AI-Organiser/Config/minutes-personas.md` | Create (first-class config) |

---

## 14. Version history

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 23 Jan 2026 | Initial spec |
| 1.1 | 23 Jan 2026 | Review fixes: type/audience split, robust parser, chunking, JSON recovery, language settings, verbatim quote guardrails, first-class personas, Obsidian Tasks format, privacy warning |
