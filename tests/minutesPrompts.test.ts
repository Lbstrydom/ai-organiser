/**
 * Minutes Prompts Tests
 * Tests for meeting minutes prompt generation and response parsing
 *
 * MECE Coverage:
 * - System prompt generation: Language, persona, meeting contexts
 * - User prompt generation: All metadata fields, optional fields
 * - Response parsing: Delimiter-based, brace-matching, dual output
 * - JSON repair: Trailing commas, unquoted keys
 */

import {
    buildMinutesUserPrompt,
    parseMinutesResponse,
    buildChunkExtractionPrompt,
    buildIntermediateMergePrompt,
    buildStyleExtractionPrompt,
    buildContextExtractionPrompt,
    getStyleSystemPrompt,
    buildStyleConsolidationPrompt,
    MINUTES_JSON_DELIMITER,
    STYLE_GUIDE_MAX_CHARS,
    CONTEXT_SUMMARY_MAX_CHARS,
    MeetingMetadata,
    Participant,
    TranscriptSegment,
    MinutesStylePromptOptions
} from '../src/services/prompts/minutesPrompts';

describe('Minutes Prompts - buildMinutesUserPrompt', () => {

    const baseMetadata: MeetingMetadata = {
        title: 'Weekly Sync',
        date: '2024-01-15',
        startTime: '09:00',
        endTime: '10:00',
        timezone: 'America/New_York',
        meetingContext: 'internal',
        outputAudience: 'internal',
        confidentialityLevel: 'internal',
        chair: 'John Smith',
        location: 'Conference Room A',
        agenda: ['Item 1', 'Item 2'],
        dualOutput: false,
        obsidianTasksFormat: true,
        minuteTaker: 'Jane Doe'
    };

    const baseParticipants: Participant[] = [
        { name: 'John Smith', role: 'Chair', attendance: 'present' },
        { name: 'Jane Doe', role: 'Secretary', attendance: 'present' }
    ];

    const baseTranscript: TranscriptSegment[] = [
        { t: '00:00', speaker: 'John', text: 'Welcome everyone.' },
        { t: '00:30', speaker: 'Jane', text: 'Thank you, John.' }
    ];

    describe('Basic Structure', () => {
        it('should return valid JSON string', () => {
            const result = buildMinutesUserPrompt(
                baseMetadata, baseParticipants, 'John, Jane', baseTranscript
            );
            expect(() => JSON.parse(result)).not.toThrow();
        });

        it('should include meeting object', () => {
            const result = buildMinutesUserPrompt(
                baseMetadata, baseParticipants, 'John, Jane', baseTranscript
            );
            const parsed = JSON.parse(result);
            expect(parsed.meeting).toBeDefined();
            expect(parsed.meeting.title).toBe('Weekly Sync');
        });

        it('should include participants array', () => {
            const result = buildMinutesUserPrompt(
                baseMetadata, baseParticipants, 'John, Jane', baseTranscript
            );
            const parsed = JSON.parse(result);
            expect(parsed.participants).toHaveLength(2);
        });

        it('should include raw participants string', () => {
            const result = buildMinutesUserPrompt(
                baseMetadata, baseParticipants, 'John Smith - Chair, Jane Doe - Secretary', baseTranscript
            );
            const parsed = JSON.parse(result);
            expect(parsed.participants_raw).toBe('John Smith - Chair, Jane Doe - Secretary');
        });

        it('should include transcript', () => {
            const result = buildMinutesUserPrompt(
                baseMetadata, baseParticipants, '', baseTranscript
            );
            const parsed = JSON.parse(result);
            expect(parsed.transcript).toHaveLength(2);
        });
    });

    describe('Meeting Metadata Fields', () => {
        it('should include all metadata fields', () => {
            const result = buildMinutesUserPrompt(
                baseMetadata, baseParticipants, '', baseTranscript
            );
            const parsed = JSON.parse(result);
            const meeting = parsed.meeting;

            expect(meeting.title).toBe('Weekly Sync');
            expect(meeting.date).toBe('2024-01-15');
            expect(meeting.start_time).toBe('09:00');
            expect(meeting.end_time).toBe('10:00');
            expect(meeting.timezone).toBe('America/New_York');
            expect(meeting.meeting_context).toBe('internal');
            expect(meeting.output_audience).toBe('internal');
            expect(meeting.confidentiality_level).toBe('internal');
            expect(meeting.chair).toBe('John Smith');
            expect(meeting.location).toBe('Conference Room A');
            expect(meeting.agenda).toEqual(['Item 1', 'Item 2']);
            expect(meeting.dual_output).toBe(false);
            expect(meeting.minute_taker).toBe('Jane Doe');
        });

        it('should handle external meeting context', () => {
            const metadata = { ...baseMetadata, meetingContext: 'external' as const };
            const result = buildMinutesUserPrompt(metadata, baseParticipants, '', baseTranscript);
            const parsed = JSON.parse(result);
            expect(parsed.meeting.meeting_context).toBe('external');
        });

        it('should handle board meeting context', () => {
            const metadata = { ...baseMetadata, meetingContext: 'board' as const };
            const result = buildMinutesUserPrompt(metadata, baseParticipants, '', baseTranscript);
            const parsed = JSON.parse(result);
            expect(parsed.meeting.meeting_context).toBe('board');
        });
    });

    describe('Optional Fields', () => {
        it('should include dictionary when provided', () => {
            const result = buildMinutesUserPrompt(
                baseMetadata, baseParticipants, '', baseTranscript,
                undefined, 'John Smith: CEO\nAcme: Client company'
            );
            const parsed = JSON.parse(result);
            expect(parsed.terminology_dictionary).toContain('John Smith');
        });

        it('should exclude dictionary when empty', () => {
            const result = buildMinutesUserPrompt(
                baseMetadata, baseParticipants, '', baseTranscript,
                undefined, ''
            );
            const parsed = JSON.parse(result);
            expect(parsed.terminology_dictionary).toBeUndefined();
        });

        it('should include context documents when provided', () => {
            const result = buildMinutesUserPrompt(
                baseMetadata, baseParticipants, '', baseTranscript,
                'Agenda:\n1. Q1 Review\n2. Budget Discussion', undefined
            );
            const parsed = JSON.parse(result);
            expect(parsed.context_documents).toContain('Q1 Review');
        });

        it('should exclude context documents when empty', () => {
            const result = buildMinutesUserPrompt(
                baseMetadata, baseParticipants, '', baseTranscript,
                '', undefined
            );
            const parsed = JSON.parse(result);
            expect(parsed.context_documents).toBeUndefined();
        });

        it('should include both dictionary and context when provided', () => {
            const result = buildMinutesUserPrompt(
                baseMetadata, baseParticipants, '', baseTranscript,
                'Context doc content', 'Dictionary content'
            );
            const parsed = JSON.parse(result);
            expect(parsed.context_documents).toBeDefined();
            expect(parsed.terminology_dictionary).toBeDefined();
        });
    });

    describe('Transcript Formats', () => {
        it('should handle transcript as segment array', () => {
            const result = buildMinutesUserPrompt(
                baseMetadata, baseParticipants, '', baseTranscript
            );
            const parsed = JSON.parse(result);
            expect(Array.isArray(parsed.transcript)).toBe(true);
            expect(parsed.transcript[0].text).toBe('Welcome everyone.');
        });

        it('should handle transcript as plain string', () => {
            const plainTranscript = 'John: Welcome everyone.\nJane: Thank you, John.';
            const result = buildMinutesUserPrompt(
                baseMetadata, baseParticipants, '', plainTranscript
            );
            const parsed = JSON.parse(result);
            expect(typeof parsed.transcript).toBe('string');
            expect(parsed.transcript).toContain('Welcome everyone');
        });
    });
});

describe('Minutes Prompts - parseMinutesResponse', () => {

    describe('Delimiter-based Parsing', () => {
        it('should parse response with delimiter', () => {
            const response = `{
  "metadata": {
    "title": "Test Meeting",
    "date": "2024-01-15",
    "start_time": "09:00",
    "end_time": "10:00",
    "timezone": "UTC",
    "meeting_context": "internal",
    "output_audience": "internal",
    "confidentiality_level": "internal",
    "chair": "John",
    "minute_taker": "Jane",
    "location": "Room A",
    "quorum_present": true
  },
  "participants": [],
  "agenda": ["Item 1"],
  "decisions": [],
  "actions": [],
  "risks": [],
  "notable_points": [],
  "open_questions": [],
  "deferred_items": []
}
${MINUTES_JSON_DELIMITER}
# Meeting Minutes

## Summary
Brief summary here.`;

            const result = parseMinutesResponse(response);

            expect(result.json.metadata.title).toBe('Test Meeting');
            expect(result.markdown).toContain('Meeting Minutes');
        });

        it('should handle delimiter with extra whitespace', () => {
            const response = `{"metadata":{"title":"Test","date":"2024-01-15","start_time":"09:00","end_time":"10:00","timezone":"UTC","meeting_context":"internal","output_audience":"internal","confidentiality_level":"internal","chair":"J","minute_taker":"J","location":"A","quorum_present":true},"participants":[],"agenda":[],"decisions":[],"actions":[],"risks":[],"notable_points":[],"open_questions":[],"deferred_items":[]}

${MINUTES_JSON_DELIMITER}

# Minutes

Content here.`;

            const result = parseMinutesResponse(response);

            expect(result.json.metadata.title).toBe('Test');
            expect(result.markdown).toContain('Minutes');
        });
    });

    describe('Brace Matching Fallback', () => {
        it('should extract JSON without delimiter', () => {
            const response = `{"metadata":{"title":"No Delimiter","date":"2024-01-15","start_time":"09:00","end_time":"10:00","timezone":"UTC","meeting_context":"internal","output_audience":"internal","confidentiality_level":"internal","chair":"J","minute_taker":"J","location":"A","quorum_present":true},"participants":[],"agenda":[],"decisions":[],"actions":[],"risks":[],"notable_points":[],"open_questions":[],"deferred_items":[]}

---

# Minutes

Content here.`;

            const result = parseMinutesResponse(response);

            expect(result.json.metadata.title).toBe('No Delimiter');
            expect(result.markdown).toContain('Content here');
        });

        it('should handle nested JSON objects', () => {
            const response = `{"metadata":{"title":"Nested","date":"2024-01-15","start_time":"09:00","end_time":"10:00","timezone":"UTC","meeting_context":"internal","output_audience":"internal","confidentiality_level":"internal","chair":"J","minute_taker":"J","location":"A","quorum_present":true},"participants":[{"name":"John","role":"Chair"}],"agenda":[],"decisions":[{"id":"D1","text":"Decision","confidence":"high"}],"actions":[],"risks":[],"notable_points":[],"open_questions":[],"deferred_items":[]}

# Minutes`;

            const result = parseMinutesResponse(response);

            expect(result.json.participants[0].name).toBe('John');
            expect(result.json.decisions[0].text).toBe('Decision');
        });
    });

    describe('Markdown Code Fence Removal', () => {
        it('should strip json code fence from response', () => {
            const response = `\`\`\`json
{"metadata":{"title":"Code Fence","date":"2024-01-15","start_time":"09:00","end_time":"10:00","timezone":"UTC","meeting_context":"internal","output_audience":"internal","confidentiality_level":"internal","chair":"J","minute_taker":"J","location":"A","quorum_present":true},"participants":[],"agenda":[],"decisions":[],"actions":[],"risks":[],"notable_points":[],"open_questions":[],"deferred_items":[]}
\`\`\`
${MINUTES_JSON_DELIMITER}
# Minutes`;

            const result = parseMinutesResponse(response);

            expect(result.json.metadata.title).toBe('Code Fence');
        });
    });

    describe('Dual Output Parsing', () => {
        it('should parse internal and external markdown sections', () => {
            const response = `{"metadata":{"title":"Dual","date":"2024-01-15","start_time":"09:00","end_time":"10:00","timezone":"UTC","meeting_context":"external","output_audience":"external","confidentiality_level":"internal","chair":"J","minute_taker":"J","location":"A","quorum_present":true},"participants":[],"agenda":[],"decisions":[],"actions":[],"risks":[],"notable_points":[],"open_questions":[],"deferred_items":[]}
${MINUTES_JSON_DELIMITER}
## Minutes_Internal
Full internal detail here.
Sensitive information included.

## Minutes_External
Sanitized external version.
No sensitive data.`;

            const result = parseMinutesResponse(response);

            expect(result.markdown).toContain('Full internal detail');
            expect(result.markdownExternal).toContain('Sanitized external');
            expect(result.markdownExternal).not.toContain('Sensitive information');
        });

        it('should return null for external when not present', () => {
            const response = `{"metadata":{"title":"Single","date":"2024-01-15","start_time":"09:00","end_time":"10:00","timezone":"UTC","meeting_context":"internal","output_audience":"internal","confidentiality_level":"internal","chair":"J","minute_taker":"J","location":"A","quorum_present":true},"participants":[],"agenda":[],"decisions":[],"actions":[],"risks":[],"notable_points":[],"open_questions":[],"deferred_items":[]}
${MINUTES_JSON_DELIMITER}
# Regular Minutes

Just one version.`;

            const result = parseMinutesResponse(response);

            expect(result.markdown).toContain('Regular Minutes');
            expect(result.markdownExternal).toBeNull();
        });
    });

    describe('JSON Repair', () => {
        it('should fix trailing commas', () => {
            const response = `{"metadata":{"title":"Trailing Comma","date":"2024-01-15","start_time":"09:00","end_time":"10:00","timezone":"UTC","meeting_context":"internal","output_audience":"internal","confidentiality_level":"internal","chair":"J","minute_taker":"J","location":"A","quorum_present":true,},"participants":[],"agenda":[],"decisions":[],"actions":[],"risks":[],"notable_points":[],"open_questions":[],"deferred_items":[],}
${MINUTES_JSON_DELIMITER}
# Minutes`;

            const result = parseMinutesResponse(response);

            expect(result.json.metadata.title).toBe('Trailing Comma');
        });

        it('should fix unquoted keys', () => {
            const response = `{metadata:{"title":"Unquoted","date":"2024-01-15","start_time":"09:00","end_time":"10:00","timezone":"UTC","meeting_context":"internal","output_audience":"internal","confidentiality_level":"internal","chair":"J","minute_taker":"J","location":"A","quorum_present":true},"participants":[],"agenda":[],"decisions":[],"actions":[],"risks":[],"notable_points":[],"open_questions":[],"deferred_items":[]}
${MINUTES_JSON_DELIMITER}
# Minutes`;

            const result = parseMinutesResponse(response);

            expect(result.json.metadata.title).toBe('Unquoted');
        });

        it('should fix literal newlines inside JSON string values', () => {
            // LLMs commonly output JSON with real newlines inside string values
            // The repairJsonStrings function should escape these before parsing
            const jsonPart = '{"metadata":{"title":"Newline Test","date":"2024-01-15","start_time":"09:00","end_time":"10:00","timezone":"UTC","meeting_context":"internal","output_audience":"internal","confidentiality_level":"internal","chair":"J","minute_taker":"J","location":"A","quorum_present":true},"participants":[],"agenda":[],"decisions":[{"id":"D1","text":"First line\nSecond line","confidence":"high"}],"actions":[],"risks":[],"notable_points":[],"open_questions":[],"deferred_items":[]}';
            const response = `${jsonPart}
${MINUTES_JSON_DELIMITER}
# Minutes`;

            const result = parseMinutesResponse(response);

            expect(result.json.metadata.title).toBe('Newline Test');
            expect(result.json.decisions[0].text).toBe('First line\nSecond line');
        });
    });

    describe('Error Handling', () => {
        it('should throw for response with no JSON', () => {
            const response = '# Just Markdown\n\nNo JSON here at all.';

            expect(() => parseMinutesResponse(response)).toThrow();
        });

        it('should throw for unbalanced braces', () => {
            const response = '{"metadata": {"title": "Unbalanced"';

            expect(() => parseMinutesResponse(response)).toThrow();
        });
    });
});

describe('Minutes Prompts - Chunk Extraction Invariants', () => {
    describe('buildChunkExtractionPrompt', () => {
        it('should include required task section', () => {
            const prompt = buildChunkExtractionPrompt();
            // Chunk extraction has task definition in prose
            expect(prompt).toContain('extracting meeting items');
            expect(prompt).toContain('Extract ALL');
        });

        it('should include JSON output format specification', () => {
            const prompt = buildChunkExtractionPrompt();
            expect(prompt).toContain('JSON');
            expect(prompt).toContain('decisions');
            expect(prompt).toContain('actions');
        });

        it('should include accuracy rules for extraction', () => {
            const prompt = buildChunkExtractionPrompt();
            // Should instruct on conservative extraction, confidence levels
            expect(prompt.toLowerCase()).toContain('confidence');
        });

        it('should be a valid string with reasonable length', () => {
            const prompt = buildChunkExtractionPrompt();
            expect(typeof prompt).toBe('string');
            expect(prompt.length).toBeGreaterThan(300);
        });

        it('should include structure for handling incomplete information', () => {
            const prompt = buildChunkExtractionPrompt();
            // Should handle chunks that don't have complete meeting info
            expect(prompt.toLowerCase()).toContain('temporary');
        });

        it('should include deferred_items in extraction schema', () => {
            const prompt = buildChunkExtractionPrompt();
            expect(prompt).toContain('deferred_items');
        });

        it('should inject meeting context when provided', () => {
            const prompt = buildChunkExtractionPrompt({
                outputLanguage: 'French',
                meetingContext: 'board',
                agenda: ['Budget approval', 'Risk review'],
                participantsRaw: 'Alice (Chair), Bob (CFO)',
                dictionaryContent: '<terms>EBITDA: earnings metric</terms>',
            });
            expect(prompt).toContain('French');
            expect(prompt).toContain('board');
            expect(prompt).toContain('governance');
            expect(prompt).toContain('Budget approval');
            expect(prompt).toContain('Alice (Chair)');
            expect(prompt).toContain('EBITDA');
        });

        it('should inject context summary when provided', () => {
            const prompt = buildChunkExtractionPrompt({
                outputLanguage: 'English',
                contextSummary: 'People: John Smith (CEO), Jane Doe (CFO)\nFigures: Q4 revenue EUR 5.2M',
            });
            expect(prompt).toContain('John Smith');
            expect(prompt).toContain('Context reference');
            expect(prompt).toContain('distilled');
        });

        it('should work without context (backward compatible)', () => {
            const prompt = buildChunkExtractionPrompt();
            expect(prompt).toContain('English'); // default language
            expect(prompt).not.toContain('Meeting type:');
            expect(prompt).not.toContain('Agenda items:');
            expect(prompt).not.toContain('Participant list');
        });
    });
});

describe('Minutes Prompts - Intermediate Merge Invariants', () => {
    describe('buildIntermediateMergePrompt', () => {
        it('should contain merge task description', () => {
            const prompt = buildIntermediateMergePrompt();
            expect(prompt).toContain('merging meeting extract batches');
        });

        it('should contain all 6 extract fields', () => {
            const prompt = buildIntermediateMergePrompt();
            expect(prompt).toContain('actions');
            expect(prompt).toContain('decisions');
            expect(prompt).toContain('risks');
            expect(prompt).toContain('notable_points');
            expect(prompt).toContain('open_questions');
            expect(prompt).toContain('deferred_items');
        });

        it('should contain deduplication instructions', () => {
            const prompt = buildIntermediateMergePrompt();
            expect(prompt.toLowerCase()).toContain('dedup');
        });

        it('should contain preservation instructions', () => {
            const prompt = buildIntermediateMergePrompt();
            expect(prompt.toLowerCase()).toContain('preserve');
        });

        it('should NOT contain MinutesJSON or meeting metadata schema when called without context', () => {
            const prompt = buildIntermediateMergePrompt();
            expect(prompt).not.toContain('MinutesJSON');
            expect(prompt).not.toContain('meeting_context');
            expect(prompt).not.toContain('PERSONA');
            expect(prompt).not.toContain('GTD');
        });

        it('should inject language and participants when context provided', () => {
            const prompt = buildIntermediateMergePrompt({
                outputLanguage: 'German',
                participantsRaw: 'Hans, Fritz',
            });
            expect(prompt).toContain('German');
            expect(prompt).toContain('Hans, Fritz');
        });

        it('should be shorter than the full consolidation prompt', () => {
            const mergePrompt = buildIntermediateMergePrompt();
            const consolidationPrompt = buildStyleConsolidationPrompt({
                minutesStyle: 'standard',
                outputLanguage: 'English',
            });
            expect(mergePrompt.length).toBeLessThan(consolidationPrompt.length);
        });

        it('should be a valid string with reasonable length', () => {
            const prompt = buildIntermediateMergePrompt();
            expect(typeof prompt).toBe('string');
            expect(prompt.length).toBeGreaterThan(200);
        });
    });
});

describe('Agenda Extraction Prompt', () => {
    // Dynamic import to match the module
    let buildAgendaExtractionPrompt: typeof import('../src/services/prompts/minutesPrompts').buildAgendaExtractionPrompt;
    let parseAgendaExtractionResponse: typeof import('../src/services/prompts/minutesPrompts').parseAgendaExtractionResponse;

    beforeAll(async () => {
        const mod = await import('../src/services/prompts/minutesPrompts');
        buildAgendaExtractionPrompt = mod.buildAgendaExtractionPrompt;
        parseAgendaExtractionResponse = mod.parseAgendaExtractionResponse;
    });

    describe('buildAgendaExtractionPrompt', () => {
        it('should include document text in prompt', () => {
            const prompt = buildAgendaExtractionPrompt('Board Meeting Agenda\nDate: 2026-03-15');
            expect(prompt).toContain('Board Meeting Agenda');
            expect(prompt).toContain('2026-03-15');
        });

        it('should request JSON output format', () => {
            const prompt = buildAgendaExtractionPrompt('Some text');
            expect(prompt).toContain('JSON');
            expect(prompt).toContain('agendaItems');
        });

        it('should include all required field names in output format', () => {
            const prompt = buildAgendaExtractionPrompt('test');
            expect(prompt).toContain('title');
            expect(prompt).toContain('date');
            expect(prompt).toContain('startTime');
            expect(prompt).toContain('endTime');
            expect(prompt).toContain('location');
            expect(prompt).toContain('participants');
            expect(prompt).toContain('agendaItems');
        });

        it('should use XML-style structure', () => {
            const prompt = buildAgendaExtractionPrompt('test');
            expect(prompt).toContain('<task>');
            expect(prompt).toContain('</task>');
            expect(prompt).toContain('<document>');
            expect(prompt).toContain('</document>');
        });
    });

    describe('parseAgendaExtractionResponse', () => {
        it('should parse valid JSON response', () => {
            const json = JSON.stringify({
                title: 'Board Meeting',
                date: '2026-03-15',
                startTime: '14:00',
                endTime: '16:00',
                location: 'Boardroom A',
                participants: ['Alice (Chair)', 'Bob', 'Carol'],
                agendaItems: ['Welcome', 'Financial report', 'AOB']
            });
            const result = parseAgendaExtractionResponse(json);
            expect(result.title).toBe('Board Meeting');
            expect(result.date).toBe('2026-03-15');
            expect(result.startTime).toBe('14:00');
            expect(result.endTime).toBe('16:00');
            expect(result.location).toBe('Boardroom A');
            expect(result.participants).toEqual(['Alice (Chair)', 'Bob', 'Carol']);
            expect(result.agendaItems).toEqual(['Welcome', 'Financial report', 'AOB']);
        });

        it('should parse JSON in code fence', () => {
            const response = '```json\n{"title":"Test","date":"","startTime":"","endTime":"","location":"","agendaItems":["Item 1"]}\n```';
            const result = parseAgendaExtractionResponse(response);
            expect(result.title).toBe('Test');
            expect(result.agendaItems).toEqual(['Item 1']);
        });

        it('should parse JSON embedded in text', () => {
            const response = 'Here is the extraction:\n{"title":"Meeting","date":"2026-01-01","startTime":"09:00","endTime":"10:00","location":"Room 1","agendaItems":["A","B"]}';
            const result = parseAgendaExtractionResponse(response);
            expect(result.title).toBe('Meeting');
            expect(result.agendaItems).toEqual(['A', 'B']);
        });

        it('should return empty result for empty response', () => {
            const result = parseAgendaExtractionResponse('');
            expect(result.title).toBe('');
            expect(result.participants).toEqual([]);
            expect(result.agendaItems).toEqual([]);
        });

        it('should return empty result for unparseable response', () => {
            const result = parseAgendaExtractionResponse('This is not JSON at all');
            expect(result.title).toBe('');
            expect(result.participants).toEqual([]);
            expect(result.agendaItems).toEqual([]);
        });

        it('should handle partial JSON (missing fields)', () => {
            const json = JSON.stringify({ title: 'Partial', agendaItems: ['One'] });
            const result = parseAgendaExtractionResponse(json);
            expect(result.title).toBe('Partial');
            expect(result.date).toBe('');
            expect(result.location).toBe('');
            expect(result.participants).toEqual([]);
            expect(result.agendaItems).toEqual(['One']);
        });

        it('should filter out empty agenda items', () => {
            const json = JSON.stringify({ title: '', date: '', startTime: '', endTime: '', location: '', participants: [], agendaItems: ['Valid', '', '  ', 'Also valid'] });
            const result = parseAgendaExtractionResponse(json);
            expect(result.agendaItems).toEqual(['Valid', 'Also valid']);
        });

        it('should handle non-string agenda items gracefully', () => {
            const json = JSON.stringify({ title: '', date: '', startTime: '', endTime: '', location: '', participants: [], agendaItems: ['Real', 42, null, 'Also real'] });
            const result = parseAgendaExtractionResponse(json);
            expect(result.agendaItems).toEqual(['Real', 'Also real']);
        });

        it('should extract participants from response', () => {
            const json = JSON.stringify({
                title: 'Sprint Planning',
                date: '2026-03-01',
                startTime: '10:00',
                endTime: '11:30',
                location: 'Meeting Room 3',
                participants: ['John Smith (Chair)', 'Jane Doe', 'Bob Wilson (Secretary)'],
                agendaItems: ['Sprint review', 'Backlog grooming']
            });
            const result = parseAgendaExtractionResponse(json);
            expect(result.participants).toEqual(['John Smith (Chair)', 'Jane Doe', 'Bob Wilson (Secretary)']);
        });

        it('should filter empty/non-string participants', () => {
            const json = JSON.stringify({ title: '', date: '', startTime: '', endTime: '', location: '', participants: ['Alice', '', 42, null, 'Bob'], agendaItems: [] });
            const result = parseAgendaExtractionResponse(json);
            expect(result.participants).toEqual(['Alice', 'Bob']);
        });

        it('should return empty participants when field is missing', () => {
            const json = JSON.stringify({ title: 'Test', agendaItems: [] });
            const result = parseAgendaExtractionResponse(json);
            expect(result.participants).toEqual([]);
        });
    });
});

describe('buildStyleExtractionPrompt', () => {
    const sampleMinutes = `## Board Meeting Minutes
1. Opening of the Meeting
COB opened the meeting at 10:00. Quorum confirmed.
2. Previous minutes
The minutes of the previous meeting were approved.
3. Financial review
The CFO presented the Q4 results. Revenue was EUR 5.2M.`;

    it('should include the reference document', () => {
        const prompt = buildStyleExtractionPrompt(sampleMinutes);
        expect(prompt).toContain(sampleMinutes);
    });

    it('should ask for format/style aspects not content', () => {
        const prompt = buildStyleExtractionPrompt(sampleMinutes);
        expect(prompt.toLowerCase()).toContain('heading structure');
        expect(prompt.toLowerCase()).toContain('tone');
        expect(prompt.toLowerCase()).toContain('formality');
        expect(prompt.toLowerCase()).toContain('participant references');
    });

    it('should instruct NOT to reproduce facts or names', () => {
        const prompt = buildStyleExtractionPrompt(sampleMinutes);
        expect(prompt.toLowerCase()).toMatch(/do not reproduce|do not.*quote|do not.*reference any specific facts/i);
    });

    it('should enforce a character limit', () => {
        const prompt = buildStyleExtractionPrompt(sampleMinutes);
        expect(prompt).toContain(String(STYLE_GUIDE_MAX_CHARS));
    });

    it('should request plain text output (no JSON, no code fences)', () => {
        const prompt = buildStyleExtractionPrompt(sampleMinutes);
        expect(prompt.toLowerCase()).toContain('no json');
        expect(prompt.toLowerCase()).toContain('no code fences');
    });

    it('should be a reasonable length', () => {
        const prompt = buildStyleExtractionPrompt(sampleMinutes);
        // Prompt itself should be moderate — not exceed 3x the reference length
        expect(prompt.length).toBeGreaterThan(500);
        expect(prompt.length).toBeLessThan(sampleMinutes.length * 3 + 2000);
    });
});

describe('buildContextExtractionPrompt', () => {
    const sampleDocs = `AGENDA
1. Opening and apologies
2. Q4 Financial Review (CFO: Jane Doe)
3. Hamina LNG Terminal Update (Project Director: Matti Virtanen)
4. Risk Register Review

FINANCIAL SUMMARY
Revenue: EUR 12.4M (up 8% YoY)
EBITDA: EUR 3.1M
Net debt: EUR 15.7M
Capex budget remaining: EUR 2.3M

PARTICIPANTS
John Smith - CEO
Jane Doe - CFO
Matti Virtanen - Project Director, Hamina LNG
Satu Korhonen - General Counsel`;

    it('should include the context documents', () => {
        const prompt = buildContextExtractionPrompt(sampleDocs);
        expect(prompt).toContain(sampleDocs);
    });

    it('should ask for facts not narrative', () => {
        const prompt = buildContextExtractionPrompt(sampleDocs);
        expect(prompt.toLowerCase()).toContain('people');
        expect(prompt.toLowerCase()).toContain('dates');
        expect(prompt.toLowerCase()).toContain('figures');
        expect(prompt.toLowerCase()).toContain('acronyms');
    });

    it('should instruct to preserve exact spellings', () => {
        const prompt = buildContextExtractionPrompt(sampleDocs);
        expect(prompt.toLowerCase()).toMatch(/exact.*spell|preserve.*exact/i);
    });

    it('should instruct to omit narrative prose', () => {
        const prompt = buildContextExtractionPrompt(sampleDocs);
        expect(prompt.toLowerCase()).toContain('omit narrative');
    });

    it('should enforce a character limit', () => {
        const prompt = buildContextExtractionPrompt(sampleDocs);
        expect(prompt).toContain(String(CONTEXT_SUMMARY_MAX_CHARS));
    });

    it('should request plain text output (no JSON, no code fences)', () => {
        const prompt = buildContextExtractionPrompt(sampleDocs);
        expect(prompt.toLowerCase()).toContain('no json');
        expect(prompt.toLowerCase()).toContain('no code fences');
    });

    it('should instruct not to infer or extrapolate', () => {
        const prompt = buildContextExtractionPrompt(sampleDocs);
        expect(prompt.toLowerCase()).toMatch(/do not.*infer|do not.*extrapolate/i);
    });

    it('should be a reasonable length', () => {
        const prompt = buildContextExtractionPrompt(sampleDocs);
        expect(prompt.length).toBeGreaterThan(500);
        expect(prompt.length).toBeLessThan(sampleDocs.length * 3 + 2000);
    });
});

// ============================================================================
// Phase 2 TRA: getStyleSystemPrompt + buildStyleConsolidationPrompt tests
// ============================================================================

describe('Minutes Prompts - getStyleSystemPrompt (Phase 2 Style System)', () => {
    const baseOptions: MinutesStylePromptOptions = {
        minutesStyle: 'standard',
        outputLanguage: 'American English',
    };

    describe('style dispatch', () => {
        it('returns Smart Brevity style core for smart-brevity', () => {
            const prompt = getStyleSystemPrompt({ ...baseOptions, minutesStyle: 'smart-brevity' });
            expect(prompt).toContain('SMART BREVITY');
            expect(prompt).toContain('big thing');
            expect(prompt).toContain('600 words');
        });

        it('returns Standard style core for standard', () => {
            const prompt = getStyleSystemPrompt({ ...baseOptions, minutesStyle: 'standard' });
            expect(prompt).toContain('STANDARD');
            expect(prompt).toContain('brevity');
        });

        it('returns Detailed style core for detailed', () => {
            const prompt = getStyleSystemPrompt({ ...baseOptions, minutesStyle: 'detailed' });
            expect(prompt).toContain('DETAILED');
            expect(prompt).toContain('governance');
        });

        it('returns Guided style core for guided with reference', () => {
            const prompt = getStyleSystemPrompt({
                ...baseOptions,
                minutesStyle: 'guided',
                styleReference: 'Use bullet lists. Keep items grouped by topic.',
            });
            expect(prompt).toContain('GUIDED');
            expect(prompt).toContain('bullet lists');
        });

        it('defaults to standard for unknown style', () => {
            const prompt = getStyleSystemPrompt({ ...baseOptions, minutesStyle: 'nonexistent' as any });
            expect(prompt).toContain('STANDARD');
        });
    });

    describe('shared suffix', () => {
        it('always includes output schema', () => {
            const prompt = getStyleSystemPrompt(baseOptions);
            expect(prompt).toContain('OUTPUT SCHEMA');
            expect(prompt).toContain('"metadata"');
            expect(prompt).toContain('"decisions"');
            expect(prompt).toContain('"actions"');
        });

        it('always includes accuracy rules', () => {
            const prompt = getStyleSystemPrompt(baseOptions);
            expect(prompt).toContain('ACCURACY RULES');
            expect(prompt).toContain('Never invent');
        });

        it('always includes self-check', () => {
            const prompt = getStyleSystemPrompt(baseOptions);
            expect(prompt).toContain('SELF-CHECK');
        });

        it('always includes edge cases', () => {
            const prompt = getStyleSystemPrompt(baseOptions);
            expect(prompt).toContain('EDGE CASES');
        });

        it('includes "no confidence annotations" rule', () => {
            const prompt = getStyleSystemPrompt(baseOptions);
            expect(prompt).toContain('Never output confidence annotations');
        });
    });

    describe('GTD overlay', () => {
        it('includes GTD schema and instructions when useGTD is true', () => {
            const prompt = getStyleSystemPrompt({ ...baseOptions, useGTD: true });
            expect(prompt).toContain('GTD OVERLAY');
            expect(prompt).toContain('gtd_processing');
            expect(prompt).toContain('@office');
        });

        it('excludes GTD when useGTD is false or undefined', () => {
            const prompt = getStyleSystemPrompt({ ...baseOptions, useGTD: false });
            expect(prompt).not.toContain('GTD OVERLAY');
            expect(prompt).not.toContain('gtd_processing');
        });
    });

    describe('custom instructions', () => {
        it('includes custom instructions when provided', () => {
            const prompt = getStyleSystemPrompt({
                ...baseOptions,
                customInstructions: 'Always use formal titles.',
            });
            expect(prompt).toContain('USER INSTRUCTIONS');
            expect(prompt).toContain('Always use formal titles.');
        });

        it('excludes custom instructions section when empty', () => {
            const prompt = getStyleSystemPrompt({ ...baseOptions, customInstructions: '' });
            expect(prompt).not.toContain('USER INSTRUCTIONS');
        });

        it('excludes custom instructions section when undefined', () => {
            const prompt = getStyleSystemPrompt(baseOptions);
            expect(prompt).not.toContain('USER INSTRUCTIONS');
        });
    });

    describe('dictionary injection', () => {
        it('includes terminology dictionary section', () => {
            const prompt = getStyleSystemPrompt(baseOptions);
            expect(prompt).toContain('TERMINOLOGY DICTIONARY');
        });
    });

    describe('meeting context behavior', () => {
        it('includes meeting context behavior section', () => {
            const prompt = getStyleSystemPrompt(baseOptions);
            expect(prompt).toContain('MEETING CONTEXT BEHAVIOR');
            expect(prompt).toContain('board');
            expect(prompt).toContain('external');
            expect(prompt).toContain('internal');
        });
    });

    describe('output language', () => {
        it('embeds the output language in the prompt', () => {
            const prompt = getStyleSystemPrompt({ ...baseOptions, outputLanguage: 'German' });
            expect(prompt).toContain('German');
        });
    });
});

describe('Minutes Prompts - buildStyleConsolidationPrompt (Phase 2)', () => {
    const baseOptions: MinutesStylePromptOptions = {
        minutesStyle: 'standard',
        outputLanguage: 'American English',
    };

    it('includes significance filter for standard style', () => {
        const prompt = buildStyleConsolidationPrompt({ ...baseOptions, minutesStyle: 'standard' });
        expect(prompt).toContain('SIGNIFICANCE FILTER');
        expect(prompt).toContain('DECISION');
        expect(prompt).toContain('BACKGROUND');
    });

    it('includes significance filter for detailed style', () => {
        const prompt = buildStyleConsolidationPrompt({ ...baseOptions, minutesStyle: 'detailed' });
        expect(prompt).toContain('SIGNIFICANCE FILTER');
    });

    it('excludes significance filter for smart-brevity style', () => {
        const prompt = buildStyleConsolidationPrompt({ ...baseOptions, minutesStyle: 'smart-brevity' });
        expect(prompt).not.toContain('SIGNIFICANCE FILTER');
    });

    it('includes cross-referencing instruction', () => {
        const prompt = buildStyleConsolidationPrompt(baseOptions);
        expect(prompt).toContain('CROSS-REFERENCING');
        expect(prompt).toContain('reassign its agenda_item_ref');
    });

    it('includes custom instructions when provided', () => {
        const prompt = buildStyleConsolidationPrompt({
            ...baseOptions,
            customInstructions: 'Focus on compliance items.',
        });
        expect(prompt).toContain('USER INSTRUCTIONS');
        expect(prompt).toContain('Focus on compliance items.');
    });
});
