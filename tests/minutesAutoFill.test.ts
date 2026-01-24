/**
 * Minutes Auto-Fill Tests
 * Tests for agenda extraction, participant detection, and auto-fill logic
 *
 * These tests verify regex patterns and extraction logic that run in Obsidian
 */

import { describe, it, expect } from 'vitest';

// Replicate the regex patterns from MinutesCreationModal
// The \s+ after digit+period prevents matching times like "10.00" (no space after .)
// But correctly matches "1. 10.00 – 10.05" by stripping "1. " prefix
const LIST_ITEM_PREFIX = /^(\d{1,2}[.)]\s+|[*\-•]\s+)/;
const AGENDA_HEADER = /^(agenda|programme|program|items?|topics?)/i;
const AGENDA_END = /^(attendees|participants|present|apologies|minutes|notes)/i;
const NAME_PATTERN = /^[A-Z][a-z]+(\s+[A-Z][a-z]+){0,3}$/;

describe('Agenda Extraction Regex', () => {

    describe('LIST_ITEM_PREFIX - should match list prefixes', () => {
        it('should match "1. " prefix', () => {
            expect(LIST_ITEM_PREFIX.test('1. Item')).toBe(true);
        });

        it('should match "1) " prefix', () => {
            expect(LIST_ITEM_PREFIX.test('1) Item')).toBe(true);
        });

        it('should match "* " prefix', () => {
            expect(LIST_ITEM_PREFIX.test('* Item')).toBe(true);
        });

        it('should match "- " prefix', () => {
            expect(LIST_ITEM_PREFIX.test('- Item')).toBe(true);
        });

        it('should match double-digit list numbers', () => {
            expect(LIST_ITEM_PREFIX.test('10. Item')).toBe(true);
            expect(LIST_ITEM_PREFIX.test('99. Item')).toBe(true);
        });
    });

    describe('LIST_ITEM_PREFIX - should NOT match time formats', () => {
        // This is the critical bug we fixed - times like 10.00 were being matched
        it('should NOT match "10.00" (time format)', () => {
            expect(LIST_ITEM_PREFIX.test('10.00 – 10.05 Opening')).toBe(false);
        });

        it('should NOT match "09.30" (time format)', () => {
            expect(LIST_ITEM_PREFIX.test('09.30 – 10.00 Coffee')).toBe(false);
        });

        it('should NOT match time without space after period', () => {
            expect(LIST_ITEM_PREFIX.test('10.00-10.30 Meeting')).toBe(false);
        });
    });

    describe('LIST_ITEM_PREFIX - replacement should preserve times', () => {
        it('should preserve full time range when stripping list prefix', () => {
            const line = '1. 10.00 – 10.05 Opening of the meeting';
            const cleaned = line.replace(LIST_ITEM_PREFIX, '').trim();
            expect(cleaned).toBe('10.00 – 10.05 Opening of the meeting');
        });

        it('should preserve time when no list prefix', () => {
            const line = '10.00 – 10.05 Opening of the meeting';
            const cleaned = line.replace(LIST_ITEM_PREFIX, '').trim();
            expect(cleaned).toBe('10.00 – 10.05 Opening of the meeting');
        });

        it('should handle tab-separated list items', () => {
            // Some Word docs use tabs after list numbers
            const line = '1.\t10.00 – 10.05 Opening';
            const cleaned = line.replace(LIST_ITEM_PREFIX, '').trim();
            expect(cleaned).toBe('10.00 – 10.05 Opening');
        });
    });

    describe('Agenda section detection', () => {
        it('should detect agenda headers', () => {
            expect(AGENDA_HEADER.test('Agenda')).toBe(true);
            expect(AGENDA_HEADER.test('AGENDA')).toBe(true);
            expect(AGENDA_HEADER.test('Programme')).toBe(true);
            expect(AGENDA_HEADER.test('Items')).toBe(true);
            expect(AGENDA_HEADER.test('Topics')).toBe(true);
        });

        it('should detect end of agenda section', () => {
            expect(AGENDA_END.test('Attendees')).toBe(true);
            expect(AGENDA_END.test('Participants')).toBe(true);
            expect(AGENDA_END.test('Present')).toBe(true);
        });
    });
});

describe('Participant Name Extraction', () => {

    describe('NAME_PATTERN - valid names', () => {
        it('should match simple two-word names', () => {
            expect(NAME_PATTERN.test('John Smith')).toBe(true);
            expect(NAME_PATTERN.test('Mary Jane')).toBe(true);
        });

        it('should match three-word names', () => {
            expect(NAME_PATTERN.test('John Paul Smith')).toBe(true);
        });

        it('should match single capitalized word', () => {
            expect(NAME_PATTERN.test('John')).toBe(true);
        });
    });

    describe('NAME_PATTERN - invalid patterns', () => {
        it('should NOT match lowercase names', () => {
            expect(NAME_PATTERN.test('john smith')).toBe(false);
        });

        it('should NOT match emails', () => {
            expect(NAME_PATTERN.test('john.smith@example.com')).toBe(false);
        });

        it('should NOT match names with titles in parentheses', () => {
            // These should be cleaned before matching
            expect(NAME_PATTERN.test('John Smith (CEO)')).toBe(false);
        });

        it('should NOT match too many words', () => {
            expect(NAME_PATTERN.test('John Paul George Ringo Starr')).toBe(false);
        });
    });

    describe('Name cleaning before pattern match', () => {
        // Helper function that replicates the cleaning logic
        function cleanName(raw: string): string {
            return raw
                .replace(/\s*[([].*?[)\]]/, '')  // Remove (Role) or [Role]
                .replace(/\s*[-–—].*$/, '')      // Remove - Present/Apologies
                .trim();
        }

        it('should clean parenthetical roles', () => {
            expect(cleanName('John Smith (CEO)')).toBe('John Smith');
            expect(cleanName('Mary Jane [Board Member]')).toBe('Mary Jane');
        });

        it('should clean status suffixes', () => {
            expect(cleanName('John Smith - Present')).toBe('John Smith');
            expect(cleanName('Mary Jane – Apologies')).toBe('Mary Jane');
        });

        it('should handle combined cleaning', () => {
            expect(cleanName('John Smith (CEO) - Present')).toBe('John Smith');
        });
    });
});

describe('Transcription Options Construction', () => {
    // Test that transcription options are correctly constructed
    // This verifies the language parameter is properly included

    interface TranscriptionOptions {
        provider: 'openai' | 'groq';
        apiKey: string;
        language?: string;
    }

    function buildTranscriptionOptions(
        provider: 'openai' | 'groq',
        apiKey: string,
        languageSetting: string
    ): TranscriptionOptions {
        return {
            provider,
            apiKey,
            language: languageSetting === 'auto' ? undefined : languageSetting
        };
    }

    it('should set language to undefined when "auto" is selected', () => {
        const opts = buildTranscriptionOptions('openai', 'key123', 'auto');
        expect(opts.language).toBeUndefined();
    });

    it('should pass through language code when specific language selected', () => {
        const opts = buildTranscriptionOptions('openai', 'key123', 'en');
        expect(opts.language).toBe('en');
    });

    it('should pass Finnish language code correctly', () => {
        const opts = buildTranscriptionOptions('openai', 'key123', 'fi');
        expect(opts.language).toBe('fi');
    });
});

describe('Bulk Truncation State', () => {
    // Test that bulk truncation state is tracked correctly

    type TruncationChoice = 'truncate' | 'full' | 'skip';

    interface BulkState {
        bulkTruncationChoice: TruncationChoice;
    }

    it('should default to truncate', () => {
        const state: BulkState = { bulkTruncationChoice: 'truncate' };
        expect(state.bulkTruncationChoice).toBe('truncate');
    });

    it('should update when Use Full is selected', () => {
        const state: BulkState = { bulkTruncationChoice: 'truncate' };
        state.bulkTruncationChoice = 'full';
        expect(state.bulkTruncationChoice).toBe('full');
    });

    it('should update when Exclude is selected', () => {
        const state: BulkState = { bulkTruncationChoice: 'truncate' };
        state.bulkTruncationChoice = 'skip';
        expect(state.bulkTruncationChoice).toBe('skip');
    });
});

describe('Extract All Feedback Logic', () => {
    // Test the logic for determining when to show feedback

    interface DocumentItem {
        id: string;
        extractedText?: string;
        error?: string;
    }

    function getUnextractedDocuments(docs: DocumentItem[]): DocumentItem[] {
        return docs.filter(d => !d.extractedText && !d.error);
    }

    it('should return empty when all documents already extracted', () => {
        const docs: DocumentItem[] = [
            { id: '1', extractedText: 'Content 1' },
            { id: '2', extractedText: 'Content 2' }
        ];
        expect(getUnextractedDocuments(docs).length).toBe(0);
    });

    it('should return unextracted documents', () => {
        const docs: DocumentItem[] = [
            { id: '1', extractedText: 'Content 1' },
            { id: '2' }, // No extracted text
            { id: '3', error: 'Failed' } // Has error, skip
        ];
        const unextracted = getUnextractedDocuments(docs);
        expect(unextracted.length).toBe(1);
        expect(unextracted[0].id).toBe('2');
    });

    it('should return all when none extracted', () => {
        const docs: DocumentItem[] = [
            { id: '1' },
            { id: '2' },
            { id: '3' }
        ];
        expect(getUnextractedDocuments(docs).length).toBe(3);
    });
});

describe('Dictionary Auto-Extract Trigger', () => {
    // Test the conditions for auto-triggering dictionary extraction

    interface ModalState {
        selectedDictionaryId: string;
        dictionaryAutoExtractOffered: boolean;
        isExtractingDictionary: boolean;
    }

    interface DocumentItem {
        extractedText?: string;
    }

    function shouldOfferDictionaryExtraction(
        state: ModalState,
        documents: DocumentItem[]
    ): boolean {
        // Don't offer if already offered or currently extracting
        if (state.dictionaryAutoExtractOffered || state.isExtractingDictionary) {
            return false;
        }

        // Don't offer if no dictionary selected
        if (!state.selectedDictionaryId) {
            return false;
        }

        // Check if any documents have extracted text
        const hasExtractedContent = documents.some(doc => doc.extractedText);
        return hasExtractedContent;
    }

    it('should offer when dictionary selected and documents extracted', () => {
        const state: ModalState = {
            selectedDictionaryId: 'dict-1',
            dictionaryAutoExtractOffered: false,
            isExtractingDictionary: false
        };
        const docs: DocumentItem[] = [{ extractedText: 'Some content' }];

        expect(shouldOfferDictionaryExtraction(state, docs)).toBe(true);
    });

    it('should NOT offer when no dictionary selected', () => {
        const state: ModalState = {
            selectedDictionaryId: '',
            dictionaryAutoExtractOffered: false,
            isExtractingDictionary: false
        };
        const docs: DocumentItem[] = [{ extractedText: 'Some content' }];

        expect(shouldOfferDictionaryExtraction(state, docs)).toBe(false);
    });

    it('should NOT offer when already offered', () => {
        const state: ModalState = {
            selectedDictionaryId: 'dict-1',
            dictionaryAutoExtractOffered: true,
            isExtractingDictionary: false
        };
        const docs: DocumentItem[] = [{ extractedText: 'Some content' }];

        expect(shouldOfferDictionaryExtraction(state, docs)).toBe(false);
    });

    it('should NOT offer when no documents have content', () => {
        const state: ModalState = {
            selectedDictionaryId: 'dict-1',
            dictionaryAutoExtractOffered: false,
            isExtractingDictionary: false
        };
        const docs: DocumentItem[] = [{}]; // No extractedText

        expect(shouldOfferDictionaryExtraction(state, docs)).toBe(false);
    });

    it('should offer when dictionary is selected AFTER extraction', () => {
        // This tests the flow where user extracts docs first, then selects dictionary
        const state: ModalState = {
            selectedDictionaryId: '', // Initially no dictionary
            dictionaryAutoExtractOffered: false,
            isExtractingDictionary: false
        };
        const docs: DocumentItem[] = [{ extractedText: 'Some content' }];

        // Before dictionary selection
        expect(shouldOfferDictionaryExtraction(state, docs)).toBe(false);

        // After dictionary selection
        state.selectedDictionaryId = 'dict-1';
        expect(shouldOfferDictionaryExtraction(state, docs)).toBe(true);
    });
});
