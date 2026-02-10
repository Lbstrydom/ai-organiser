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
    buildMinutesSystemPrompt,
    buildMinutesUserPrompt,
    parseMinutesResponse,
    buildChunkExtractionPrompt,
    buildConsolidationPrompt,
    MINUTES_JSON_DELIMITER,
    MeetingMetadata,
    Participant,
    TranscriptSegment
} from '../src/services/prompts/minutesPrompts';

describe('Minutes Prompts - buildMinutesSystemPrompt', () => {

    describe('Language Handling', () => {
        it('should include specified output language', () => {
            const prompt = buildMinutesSystemPrompt({ outputLanguage: 'English', personaInstructions: 'Be professional.' });
            expect(prompt).toContain('English');
        });

        it('should handle Chinese language', () => {
            const prompt = buildMinutesSystemPrompt({ outputLanguage: 'Chinese (Simplified)', personaInstructions: 'Be professional.' });
            expect(prompt).toContain('Chinese (Simplified)');
        });

        it('should handle German language', () => {
            const prompt = buildMinutesSystemPrompt({ outputLanguage: 'German', personaInstructions: 'Be professional.' });
            expect(prompt).toContain('German');
        });
    });

    describe('Persona Instructions', () => {
        it('should include persona instructions', () => {
            const persona = 'Focus on action items and decisions. Be concise.';
            const prompt = buildMinutesSystemPrompt({ outputLanguage: 'English', personaInstructions: persona });
            expect(prompt).toContain(persona);
        });

        it('should handle empty persona instructions', () => {
            const prompt = buildMinutesSystemPrompt({ outputLanguage: 'English', personaInstructions: '' });
            expect(prompt).toContain('PERSONA INSTRUCTIONS');
            // Should not break even with empty persona
        });

        it('should handle multiline persona instructions', () => {
            const persona = `Line 1
Line 2
Line 3`;
            const prompt = buildMinutesSystemPrompt({ outputLanguage: 'English', personaInstructions: persona });
            expect(prompt).toContain('Line 1');
            expect(prompt).toContain('Line 3');
        });
    });

    describe('Required Sections', () => {
        it('should include response format section', () => {
            const prompt = buildMinutesSystemPrompt({ outputLanguage: 'English', personaInstructions: '' });
            expect(prompt).toContain('RESPONSE FORMAT');
        });

        it('should include JSON delimiter', () => {
            const prompt = buildMinutesSystemPrompt({ outputLanguage: 'English', personaInstructions: '' });
            expect(prompt).toContain(MINUTES_JSON_DELIMITER);
        });

        it('should include accuracy rules', () => {
            const prompt = buildMinutesSystemPrompt({ outputLanguage: 'English', personaInstructions: '' });
            expect(prompt).toContain('ACCURACY RULES');
        });

        it('should include meeting context behavior', () => {
            const prompt = buildMinutesSystemPrompt({ outputLanguage: 'English', personaInstructions: '' });
            expect(prompt).toContain('MEETING CONTEXT BEHAVIOR');
            expect(prompt).toContain('internal');
            expect(prompt).toContain('external');
            expect(prompt).toContain('board');
        });

        it('should include output schema', () => {
            const prompt = buildMinutesSystemPrompt({ outputLanguage: 'English', personaInstructions: '' });
            expect(prompt).toContain('OUTPUT SCHEMA');
            expect(prompt).toContain('MinutesJSON');
        });

        it('should include self-check section', () => {
            const prompt = buildMinutesSystemPrompt({ outputLanguage: 'English', personaInstructions: '' });
            expect(prompt).toContain('SELF-CHECK');
        });

        it('should include dictionary instructions', () => {
            const prompt = buildMinutesSystemPrompt({ outputLanguage: 'English', personaInstructions: '' });
            expect(prompt).toContain('TERMINOLOGY DICTIONARY');
        });

        it('should include context documents instructions', () => {
            const prompt = buildMinutesSystemPrompt({ outputLanguage: 'English', personaInstructions: '' });
            expect(prompt).toContain('CONTEXT DOCUMENTS');
        });
    });
});

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

describe('Minutes Prompts - MINUTES_JSON_DELIMITER', () => {
    it('should be a unique delimiter string', () => {
        expect(MINUTES_JSON_DELIMITER).toBe('<<AIO_MINUTES_JSON_END>>');
    });

    it('should not appear in normal text', () => {
        const normalText = 'This is a normal meeting transcript with various content.';
        expect(normalText.includes(MINUTES_JSON_DELIMITER)).toBe(false);
    });
});

describe('Minutes Prompts - GTD Schema Injection', () => {
    it('should NOT include gtd_processing schema when useGTD is false', () => {
        const prompt = buildMinutesSystemPrompt({ outputLanguage: 'English', personaInstructions: '', useGTD: false });
        expect(prompt).not.toContain('gtd_processing');
    });

    it('should NOT include gtd_processing schema when useGTD is undefined', () => {
        const prompt = buildMinutesSystemPrompt({ outputLanguage: 'English', personaInstructions: '' });
        expect(prompt).not.toContain('gtd_processing');
    });

    it('should include gtd_processing schema when useGTD is true', () => {
        const prompt = buildMinutesSystemPrompt({ outputLanguage: 'English', personaInstructions: '', useGTD: true });
        expect(prompt).toContain('gtd_processing');
        expect(prompt).toContain('next_actions');
        expect(prompt).toContain('waiting_for');
        expect(prompt).toContain('someday_maybe');
    });

    it('should include GTD context instructions when useGTD is true', () => {
        const prompt = buildMinutesSystemPrompt({ outputLanguage: 'English', personaInstructions: '', useGTD: true });
        expect(prompt).toContain('@office');
        expect(prompt).toContain('@home');
    });

    it('should include GTD self-check when useGTD is true', () => {
        const prompt = buildMinutesSystemPrompt({ outputLanguage: 'English', personaInstructions: '', useGTD: true });
        expect(prompt).toContain('GTD context');
    });

    it('should NOT include GTD self-check when useGTD is false', () => {
        const prompt = buildMinutesSystemPrompt({ outputLanguage: 'English', personaInstructions: '', useGTD: false });
        expect(prompt).not.toContain('GTD OVERLAY');
    });
});

describe('Minutes Prompts - Chunk Extraction Invariants', () => {
    describe('buildChunkExtractionPrompt', () => {
        it('should include required task section', () => {
            const prompt = buildChunkExtractionPrompt();
            // Chunk extraction has task definition in prose
            expect(prompt).toContain('extracting meeting items');
            expect(prompt).toContain('Extract ONLY');
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
    });
});

describe('Minutes Prompts - Consolidation Invariants', () => {
    describe('buildConsolidationPrompt', () => {
        it('should include required task section', () => {
            const prompt = buildConsolidationPrompt({ outputLanguage: 'English', personaInstructions: 'Be professional' });
            // Task defined in prose, not XML
            expect(prompt).toContain('consolidating meeting items');
            expect(prompt).toContain('Deduplicate');
        });

        it('should include output language in consolidation rules', () => {
            const engPrompt = buildConsolidationPrompt({ outputLanguage: 'English', personaInstructions: '' });
            expect(engPrompt).toContain('English');

            const frPrompt = buildConsolidationPrompt({ outputLanguage: 'French', personaInstructions: '' });
            expect(frPrompt).toContain('French');
        });

        it('should include persona instructions in output', () => {
            const persona = 'Focus on action items and risks';
            const prompt = buildConsolidationPrompt({ outputLanguage: 'English', personaInstructions: persona });
            expect(prompt).toContain(persona);
        });

        it('should include deduplication guidance for combining chunks', () => {
            const prompt = buildConsolidationPrompt({ outputLanguage: 'English', personaInstructions: '' });
            // Should mention merging, combining, or deduplication
            expect(prompt.toLowerCase()).toMatch(/merge|combine|dedup|duplicate/);
        });

        it('should specify expected JSON structure for output', () => {
            const prompt = buildConsolidationPrompt({ outputLanguage: 'English', personaInstructions: '' });
            // Should reference MinutesJSON structure
            expect(prompt).toContain('participants');
            expect(prompt).toContain('decisions');
            expect(prompt).toContain('actions');
        });

        it('should handle empty persona gracefully', () => {
            const prompt = buildConsolidationPrompt({ outputLanguage: 'English', personaInstructions: '' });
            expect(typeof prompt).toBe('string');
            expect(prompt.length).toBeGreaterThan(500);
        });

        it('should handle multiline persona instructions', () => {
            const persona = `Line 1
Line 2
Line 3`;
            const prompt = buildConsolidationPrompt({ outputLanguage: 'English', personaInstructions: persona });
            expect(prompt).toContain('Line 1');
            expect(prompt).toContain('Line 3');
        });

        it('should be a valid string with reasonable length', () => {
            const prompt = buildConsolidationPrompt({ outputLanguage: 'English', personaInstructions: 'Be concise' });
            expect(typeof prompt).toBe('string');
            expect(prompt.length).toBeGreaterThan(500);
        });
    });
});
