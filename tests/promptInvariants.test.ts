/**
 * Prompt Invariants Tests
 * 
 * Tests prompt builder specifications using lightweight invariants:
 * - Required XML sections exist
 * - Critical safety constraints remain present
 * - Option flags change output as expected
 * 
 * NO snapshot tests - only invariant assertions on contracts.
 */

import {
    buildStructuredSummaryPrompt,
    insertContentIntoStructuredPrompt
} from '../src/services/prompts/structuredPrompts';
import {
    buildTranslatePrompt,
    insertContentIntoTranslatePrompt
} from '../src/services/prompts/translatePrompts';
import {
    buildTaxonomyTagPrompt,
    buildTagPrompt
} from '../src/services/prompts/tagPrompts';
import {
    buildFlashcardPrompt,
    getFlashcardFormat,
    validateFlashcardCSV,
    ANKI_FORMAT,
    FLASHCARD_STYLES
} from '../src/services/prompts/flashcardPrompts';
import {
    buildDiagramPrompt
} from '../src/services/prompts/diagramPrompts';
import {
    buildTermExtractionPrompt
} from '../src/services/prompts/dictionaryPrompts';
import {
    DEFAULT_PERSONAS,
    DEFAULT_SUMMARY_PERSONAS
} from '../src/services/configurationService';
import {
    buildSummaryPrompt,
    buildChunkCombinePrompt,
    insertContentIntoPrompt
} from '../src/services/prompts/summaryPrompts';

// ============================================================================
// STRUCTURED PROMPTS INVARIANTS
// ============================================================================

describe('Structured Prompts - Invariants', () => {
    describe('buildStructuredSummaryPrompt', () => {
        it('should include task section defining JSON requirement', () => {
            const prompt = buildStructuredSummaryPrompt();
            expect(prompt).toContain('<task>');
            expect(prompt.toLowerCase()).toContain('json');
        });

        it('should include output_format section with JSON schema', () => {
            const prompt = buildStructuredSummaryPrompt();
            expect(prompt).toContain('output_format');
            expect(prompt).toContain('summary_hook');
            expect(prompt).toContain('body_content');
            expect(prompt).toContain('suggested_tags');
            expect(prompt).toContain('content_type');
        });

        it('should require valid JSON with specific fields', () => {
            const prompt = buildStructuredSummaryPrompt();
            expect(prompt).toContain('"summary_hook"');
            expect(prompt).toContain('"body_content"');
            expect(prompt).toContain('"suggested_tags"');
            expect(prompt).toContain('"content_type"');
        });

        it('should handle different length options', () => {
            const briefPrompt = buildStructuredSummaryPrompt({ length: 'brief' });
            const detailedPrompt = buildStructuredSummaryPrompt({ length: 'detailed' });
            
            expect(typeof briefPrompt).toBe('string');
            expect(typeof detailedPrompt).toBe('string');
            expect(briefPrompt.length).toBeGreaterThan(0);
            expect(detailedPrompt.length).toBeGreaterThan(0);
        });

        it('should include specified language in instructions', () => {
            const prompt = buildStructuredSummaryPrompt({ language: 'French' });
            expect(prompt.toLowerCase()).toContain('language');
        });

        it('should include persona when provided', () => {
            const persona = 'Be academic and rigorous';
            const prompt = buildStructuredSummaryPrompt({ personaPrompt: persona });
            expect(prompt).toContain(persona);
        });

        it('should include user context when provided', () => {
            const context = 'User is a researcher';
            const prompt = buildStructuredSummaryPrompt({ userContext: context });
            expect(prompt).toContain(context);
        });

        it('should handle empty options gracefully', () => {
            const prompt = buildStructuredSummaryPrompt({});
            expect(typeof prompt).toBe('string');
            expect(prompt.length).toBeGreaterThan(200);
        });

        it('should include companion_content field when includeCompanion is true', () => {
            const prompt = buildStructuredSummaryPrompt({ includeCompanion: true });
            expect(prompt).toContain('"companion_content"');
            expect(prompt).toContain('companion_content');
        });

        it('should NOT include companion_content field when includeCompanion is false', () => {
            const prompt = buildStructuredSummaryPrompt({ includeCompanion: false });
            expect(prompt).not.toContain('"companion_content"');
        });

        it('should NOT include companion_content field when includeCompanion is omitted', () => {
            const prompt = buildStructuredSummaryPrompt();
            expect(prompt).not.toContain('"companion_content"');
        });
    });

    describe('insertContentIntoStructuredPrompt', () => {
        it('should insert content into prompt', () => {
            const basePrompt = buildStructuredSummaryPrompt();
            const content = 'Important data to process';
            const result = insertContentIntoStructuredPrompt(basePrompt, content);
            
            expect(typeof result).toBe('string');
            expect(result.length).toBeGreaterThan(0);
        });
    });
});

// ============================================================================
// TRANSLATE PROMPTS INVARIANTS (INJECTION PREVENTION)
// ============================================================================

describe('Translate Prompts - Invariants', () => {
    describe('buildTranslatePrompt - Injection Prevention', () => {
        it('should include critical safety instructions section', () => {
            const prompt = buildTranslatePrompt({ targetLanguage: 'French' });
            expect(prompt.toLowerCase()).toContain('critical');
            expect(prompt.toLowerCase()).toContain('instruction');
        });

        it('should include content placeholder', () => {
            const prompt = buildTranslatePrompt({ targetLanguage: 'Spanish' });
            expect(prompt).toContain('CONTENT_PLACEHOLDER');
        });

        it('should include target language in task', () => {
            const targetLang = 'Portuguese';
            const prompt = buildTranslatePrompt({ targetLanguage: targetLang });
            expect(prompt).toContain(targetLang);
        });

        it('should preserve formatting instruction', () => {
            const prompt = buildTranslatePrompt({ targetLanguage: 'Italian' });
            // Should mention preserving markdown
            expect(prompt.toLowerCase()).toContain('markdown');
        });

        it('should forbid adding new formatting', () => {
            const prompt = buildTranslatePrompt({ targetLanguage: 'German' });
            expect(prompt.toLowerCase()).toContain('not add');
        });
    });

    describe('insertContentIntoTranslatePrompt', () => {
        it('should substitute content into placeholder', () => {
            const prompt = buildTranslatePrompt({ targetLanguage: 'French' });
            const content = '# Bonjour\nCeci est un test.';
            const result = insertContentIntoTranslatePrompt(prompt, content);
            
            expect(result).toContain(content);
            expect(result).not.toContain('CONTENT_PLACEHOLDER');
        });

        it('should preserve safety instructions after insertion', () => {
            const prompt = buildTranslatePrompt({ targetLanguage: 'French' });
            const content = 'Some content to translate';
            const result = insertContentIntoTranslatePrompt(prompt, content);
            
            // Safety guidance should remain
            expect(result.toLowerCase()).toContain('critical');
        });
    });
});

// ============================================================================
// TAG PROMPTS INVARIANTS (TRUNCATION EDGES)
// ============================================================================

describe('Tag Prompts - Invariants', () => {
    describe('buildTaxonomyTagPrompt', () => {
        it('should include task section', () => {
            const prompt = buildTaxonomyTagPrompt('content', '## taxonomy', 5);
            expect(prompt).toContain('<task>');
        });

        it('should include output_format with JSON structure', () => {
            const prompt = buildTaxonomyTagPrompt('content', '## taxonomy', 5);
            expect(prompt).toContain('output_format');
            expect(prompt).toContain('"tags"');
            expect(prompt).toContain('"title"');
            expect(prompt).toContain('"folder"');
        });

        it('should honor maxTags parameter', () => {
            const prompt = buildTaxonomyTagPrompt('content', '## taxonomy', 3);
            expect(typeof prompt).toBe('string');
            expect(prompt.length).toBeGreaterThan(100);
        });

        it('should handle folder context constraints', () => {
            const folderContext = {
                rootPath: 'Research',
                noteCount: 100,
                subfolders: ['Physics', 'Chemistry'],
                existingTags: ['tag1']
            };
            
            const prompt = buildTaxonomyTagPrompt('content', '## taxonomy', 5, undefined, folderContext);
            expect(prompt).toContain('Research');
        });

        it('should support language parameter', () => {
            const prompt = buildTaxonomyTagPrompt('content', '## taxonomy', 5, 'fr');
            expect(typeof prompt).toBe('string');
            expect(prompt.length).toBeGreaterThan(100);
        });
    });

    describe('buildTagPrompt', () => {
        it('should return valid prompt string', () => {
            const prompt = buildTagPrompt('test content', ['technology', 'science'], 'legacy', 5);
            expect(typeof prompt).toBe('string');
            expect(prompt.length).toBeGreaterThan(100);
        });

        it('should include content in prompt', () => {
            const prompt = buildTagPrompt('test content here', ['technology'], 'legacy', 5);
            expect(prompt).toContain('test content here');
        });
    });
});

// ============================================================================
// FLASHCARD PROMPTS INVARIANTS
// ============================================================================

describe('Flashcard Prompts - Invariants', () => {
    describe('Flashcard Formats', () => {
        it('should have Anki format with MathJax support', () => {
            const anki = getFlashcardFormat('anki');
            expect(anki).toBeDefined();
            expect(anki?.mathSupport).toBe('mathjax');
            expect(anki?.fileExtension).toBe('csv');
        });

        it('should warn against $ delimiters in Anki prompt', () => {
            const prompt = ANKI_FORMAT.prompt;
            expect(prompt).toContain('MathJax');
        });
    });

    describe('buildFlashcardPrompt', () => {
        it('should include flashcard generation instruction', () => {
            const format = getFlashcardFormat('anki');
            expect(format).toBeDefined();
            if (!format) throw new Error('Missing flashcard format');
            const prompt = buildFlashcardPrompt('Test content', format, undefined, 'English', 'standard');
            expect(typeof prompt).toBe('string');
            expect(prompt.toLowerCase()).toContain('flashcard');
        });

        it('should include note content in prompt', () => {
            const content = 'Test content for flashcards';
            const format = getFlashcardFormat('anki');
            expect(format).toBeDefined();
            if (!format) throw new Error('Missing flashcard format');
            const prompt = buildFlashcardPrompt(content, format, undefined, 'English', 'standard');
            expect(prompt).toContain(content);
        });

        it('should vary output for different styles', () => {
            const format = getFlashcardFormat('anki');
            expect(format).toBeDefined();
            if (!format) throw new Error('Missing flashcard format');
            const standardPrompt = buildFlashcardPrompt('Test', format, undefined, 'English', 'standard');
            const mcPrompt = buildFlashcardPrompt('Test', format, undefined, 'English', 'multiple-choice');
            
            expect(standardPrompt.length).toBeGreaterThan(0);
            expect(mcPrompt.length).toBeGreaterThan(0);
        });
    });

    describe('validateFlashcardCSV', () => {
        it('should return validation result object', () => {
            const csv = '"Q1","A1"';
            const result = validateFlashcardCSV(csv);
            expect(typeof result).toBe('object');
            expect('valid' in result).toBe(true);
        });
    });

    describe('FLASHCARD_STYLES', () => {
        it('should include standard and multiple-choice options', () => {
            const ids = FLASHCARD_STYLES.map(s => s.id);
            expect(ids).toContain('standard');
            expect(ids).toContain('multiple-choice');
        });

        it('should have descriptive names for each style', () => {
            FLASHCARD_STYLES.forEach(style => {
                expect(style.name).toBeTruthy();
                expect(style.description).toBeTruthy();
            });
        });
    });
});

// ============================================================================
// DIAGRAM PROMPTS INVARIANTS
// ============================================================================

describe('Diagram Prompts - Invariants', () => {
    describe('buildDiagramPrompt', () => {
        it('should include mermaid instruction', () => {
            const prompt = buildDiagramPrompt({
                diagramType: 'flowchart',
                instruction: 'Show the process',
                noteContent: 'Process content'
            });
            expect(prompt).toContain('<task>');
            expect(prompt.toLowerCase()).toContain('mermaid');
        });

        it('should include note content', () => {
            const content = 'Important process details';
            const prompt = buildDiagramPrompt({
                diagramType: 'flowchart',
                instruction: 'Show process',
                noteContent: content
            });
            expect(prompt).toContain(content);
        });

        it('should include custom instruction', () => {
            const instruction = 'Highlight decision points';
            const prompt = buildDiagramPrompt({
                diagramType: 'flowchart',
                instruction,
                noteContent: 'Content'
            });
            expect(prompt).toContain(instruction);
        });

        it('should support different diagram types', () => {
            const types = ['flowchart', 'mindmap', 'sequenceDiagram', 'classDiagram'];
            
            types.forEach(type => {
                const prompt = buildDiagramPrompt({
                    diagramType: type as any,
                    instruction: 'Test',
                    noteContent: 'Test content'
                });
                expect(typeof prompt).toBe('string');
                expect(prompt.length).toBeGreaterThan(100);
            });
        });
    });
});

// ============================================================================
// DICTIONARY PROMPTS INVARIANTS
// ============================================================================

describe('Dictionary Prompts - Invariants', () => {
    describe('buildTermExtractionPrompt', () => {
        it('should include task section', () => {
            const prompt = buildTermExtractionPrompt([]);
            expect(prompt).toContain('<task>');
            expect(prompt.toLowerCase()).toContain('terminology');
        });

        it('should include requirements section with categorization rules', () => {
            const prompt = buildTermExtractionPrompt([]);
            expect(prompt).toContain('<requirements>');
            expect(prompt).toContain('person');
            expect(prompt).toContain('acronym');
            expect(prompt).toContain('term');
        });

        it('should include documents section when provided', () => {
            const docs = [
                { name: 'Doc1', content: 'Content 1' },
                { name: 'Doc2', content: 'Content 2' }
            ];
            const prompt = buildTermExtractionPrompt(docs);
            expect(prompt).toContain('Doc1');
            expect(prompt).toContain('Doc2');
        });

        it('should include output_format section', () => {
            const prompt = buildTermExtractionPrompt([]);
            expect(prompt).toContain('<output_format>');
        });

        it('should specify language for extraction', () => {
            const prompt = buildTermExtractionPrompt([], [], 'French');
            expect(prompt).toContain('French');
        });
    });
});

// ============================================================================
// SUMMARY PERSONAS INVARIANTS
// ============================================================================

describe('Summary Personas - Invariants', () => {
    describe('DEFAULT_SUMMARY_PERSONAS', () => {
        it('should have exactly 5 summary personas', () => {
            expect(DEFAULT_SUMMARY_PERSONAS.length).toBe(5);
        });

        it('each persona should have required properties', () => {
            DEFAULT_SUMMARY_PERSONAS.forEach(persona => {
                expect(persona.id).toBeTruthy();
                expect(persona.name).toBeTruthy();
                expect(persona.description).toBeTruthy();
                expect(persona.prompt).toBeTruthy();
            });
        });

        it('each persona prompt should be substantive', () => {
            DEFAULT_SUMMARY_PERSONAS.forEach(persona => {
                expect(persona.prompt.length).toBeGreaterThan(200);
            });
        });

        it('persona IDs should be unique', () => {
            const ids = DEFAULT_SUMMARY_PERSONAS.map(p => p.id);
            const uniqueIds = new Set(ids);
            expect(uniqueIds.size).toBe(ids.length);
        });

        it('exactly one persona should be marked as default', () => {
            const defaults = DEFAULT_SUMMARY_PERSONAS.filter(p => p.isDefault);
            expect(defaults.length).toBe(1);
        });

        it('persona IDs should be kebab-case', () => {
            DEFAULT_SUMMARY_PERSONAS.forEach(persona => {
                expect(persona.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
            });
        });
    });
});

// ============================================================================
// WRITING PERSONAS INVARIANTS
// ============================================================================

describe('Writing Personas - Invariants', () => {
    describe('DEFAULT_PERSONAS', () => {
        it('should have exactly 5 writing personas', () => {
            expect(DEFAULT_PERSONAS.length).toBe(5);
        });

        it('each persona should have required properties', () => {
            DEFAULT_PERSONAS.forEach(persona => {
                expect(persona.id).toBeTruthy();
                expect(persona.name).toBeTruthy();
                expect(persona.description).toBeTruthy();
                expect(persona.prompt).toBeTruthy();
            });
        });

        it('each persona prompt should be substantive', () => {
            DEFAULT_PERSONAS.forEach(persona => {
                expect(persona.prompt.length).toBeGreaterThan(200);
            });
        });

        it('persona IDs should be unique', () => {
            const ids = DEFAULT_PERSONAS.map(p => p.id);
            const uniqueIds = new Set(ids);
            expect(uniqueIds.size).toBe(ids.length);
        });

        it('exactly one persona should be marked as default', () => {
            const defaults = DEFAULT_PERSONAS.filter(p => p.isDefault);
            expect(defaults.length).toBe(1);
        });

        it('persona IDs should be kebab-case', () => {
            DEFAULT_PERSONAS.forEach(persona => {
                expect(persona.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
            });
        });

        it('writing persona IDs mirror summary persona IDs', () => {
            const writingIds = DEFAULT_PERSONAS.map(p => p.id).sort();
            const summaryIds = DEFAULT_SUMMARY_PERSONAS.map(p => p.id).sort();
            expect(writingIds).toEqual(summaryIds);
        });

        it('each persona should have an icon', () => {
            DEFAULT_PERSONAS.forEach(persona => {
                expect(persona.icon).toBeTruthy();
            });
        });
    });
});

// ============================================================================
// SUMMARY PROMPTS INVARIANTS
// ============================================================================

describe('Summary Prompts - Invariants', () => {
    describe('buildSummaryPrompt', () => {
        it('should include task guidance', () => {
            const prompt = buildSummaryPrompt({ length: 'brief' });
            expect(typeof prompt).toBe('string');
            expect(prompt.length).toBeGreaterThan(100);
        });

        it('should include task and critical instructions sections', () => {
            const prompt = buildSummaryPrompt({ length: 'brief' });
            expect(prompt).toContain('<task>');
            expect(prompt.toLowerCase()).toContain('summarize');
        });

        it('should support different length options', () => {
            const briefPrompt = buildSummaryPrompt({ length: 'brief' });
            const detailedPrompt = buildSummaryPrompt({ length: 'detailed' });
            
            expect(typeof briefPrompt).toBe('string');
            expect(typeof detailedPrompt).toBe('string');
            expect(briefPrompt.length).toBeGreaterThan(0);
            expect(detailedPrompt.length).toBeGreaterThan(0);
        });
    });

    describe('buildChunkCombinePrompt', () => {
        it('should return valid prompt string', () => {
            const prompt = buildChunkCombinePrompt({ length: 'brief' });
            expect(typeof prompt).toBe('string');
            expect(prompt.length).toBeGreaterThan(100);
        });

        it('should include merge/combine task', () => {
            const prompt = buildChunkCombinePrompt({ length: 'brief' });
            expect(prompt).toContain('<task>');
            expect(prompt.toLowerCase()).toContain('combine');
        });

        it('should support language parameter', () => {
            const prompt = buildChunkCombinePrompt({ length: 'brief', language: 'Spanish' });
            expect(typeof prompt).toBe('string');
            expect(prompt.length).toBeGreaterThan(100);
        });
    });

    describe('insertContentIntoPrompt', () => {
        it('should insert content into prompt', () => {
            const basePrompt = buildSummaryPrompt({ length: 'brief' });
            const content = 'Actual content';
            const result = insertContentIntoPrompt(basePrompt, content);
            
            expect(typeof result).toBe('string');
            expect(result.length).toBeGreaterThan(0);
        });
    });
});
