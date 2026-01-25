/**
 * Dictionary Controller Tests
 * Comprehensive tests for state management, CRUD, term extraction, and merging
 */

import { vi } from 'vitest';
import { DictionaryController } from '../src/ui/controllers/DictionaryController';
import { DictionaryService, Dictionary, DictionaryEntry } from '../src/services/dictionaryService';
import { LLMService } from '../src/services/types';

// Mock DictionaryService
const mockDictionaryService = {
    listDictionaries: vi.fn() as ReturnType<typeof vi.fn>,
    loadDictionary: vi.fn() as ReturnType<typeof vi.fn>,
    getDictionaryById: vi.fn() as ReturnType<typeof vi.fn>,
    saveDictionary: vi.fn() as ReturnType<typeof vi.fn>,
    deleteDictionary: vi.fn() as ReturnType<typeof vi.fn>,
    createEmptyDictionary: vi.fn() as ReturnType<typeof vi.fn>,
    addEntries: vi.fn() as ReturnType<typeof vi.fn>,
    formatForPrompt: vi.fn() as ReturnType<typeof vi.fn>
};

// Mock LLMService
const mockLLMService = {
    analyzeTags: vi.fn() as ReturnType<typeof vi.fn>
};

// Sample test data
const testDictionary: Dictionary = {
    id: 'test-dict',
    name: 'Test Dictionary',
    description: 'Test dictionary',
    entries: [
        { term: 'John Smith', category: 'person', definition: 'CEO', aliases: ['JS', 'Johnny'] },
        { term: 'API', category: 'acronym', definition: 'Application Programming Interface' }
    ],
    createdAt: '2025-01-24T12:00:00Z',
    updatedAt: '2025-01-24T12:00:00Z'
};

const testDictionary2: Dictionary = {
    id: 'test-dict-2',
    name: 'Team Dictionary',
    description: 'Team terminology',
    entries: [
        { term: 'Sprint', category: 'term', definition: 'Development sprint' }
    ],
    createdAt: '2025-01-24T12:00:00Z',
    updatedAt: '2025-01-24T12:00:00Z'
};

// Helper to create fresh dictionary copies
function createTestDict(): Dictionary {
    return JSON.parse(JSON.stringify(testDictionary));
}

function createTestDict2(): Dictionary {
    return JSON.parse(JSON.stringify(testDictionary2));
}

describe('DictionaryController', () => {
    let controller: DictionaryController;

    beforeEach(() => {
        vi.clearAllMocks();
        controller = new DictionaryController(
            mockDictionaryService as DictionaryService
        );
    });

    describe('getCurrent', () => {
        it('should return null when no dictionary loaded', () => {
            expect(controller.getCurrent()).toBeNull();
        });

        it('should return current dictionary when loaded', async () => {
            mockDictionaryService.listDictionaries.mockResolvedValue([testDictionary]);
            mockDictionaryService.addEntries.mockResolvedValue(testDictionary);

            const result = await controller.loadDictionary('Test Dictionary');

            expect(result.errors).toEqual([]);
            expect(controller.getCurrent()).toEqual(testDictionary);
        });

        it('should return a copy of current dictionary (not reference)', async () => {
            mockDictionaryService.listDictionaries.mockResolvedValue([testDictionary]);
            mockDictionaryService.addEntries.mockResolvedValue(testDictionary);

            await controller.loadDictionary('Test Dictionary');
            const current = controller.getCurrent();

            expect(current).toEqual(testDictionary);
            if (current) {
                // Test name immutability
                current.name = 'Modified';
                expect(controller.getCurrent()?.name).toBe('Test Dictionary');

                // Test entries array immutability (Issue 2 test)
                current.entries.push({ term: 'Injected', category: 'term' });
                expect(controller.getCurrent()?.entries.length).toBe(2); // Still original count

                // Test entry mutation doesn't affect original
                if (current.entries[0]) {
                    current.entries[0].term = 'Mutated';
                    expect(controller.getCurrent()?.entries[0].term).toBe('John Smith');
                }

                // Test aliases array immutability
                if (current.entries[0]?.aliases) {
                    current.entries[0].aliases.push('NewAlias');
                    // Original should not have this alias
                    const original = controller.getCurrent();
                    expect(original?.entries[0].aliases?.includes('NewAlias')).toBe(false);
                }
            }
        });
    });

    describe('getCurrentName', () => {
        it('should return null when no dictionary loaded', () => {
            expect(controller.getCurrentName()).toBeNull();
        });

        it('should return current dictionary name', async () => {
            mockDictionaryService.listDictionaries.mockResolvedValue([testDictionary]);

            await controller.loadDictionary('Test Dictionary');

            expect(controller.getCurrentName()).toBe('Test Dictionary');
        });
    });

    describe('getCurrentId', () => {
        it('should return null when no dictionary loaded', () => {
            expect(controller.getCurrentId()).toBeNull();
        });

        it('should return current dictionary ID', async () => {
            mockDictionaryService.listDictionaries.mockResolvedValue([testDictionary]);

            await controller.loadDictionary('Test Dictionary');

            expect(controller.getCurrentId()).toBe('test-dict');
        });
    });

    describe('listDictionaries', () => {
        it('should return empty array when no dictionaries exist', async () => {
            mockDictionaryService.listDictionaries.mockResolvedValue([]);

            const result = await controller.listDictionaries();

            expect(result).toEqual([]);
        });

        it('should return list of dictionary names', async () => {
            mockDictionaryService.listDictionaries.mockResolvedValue([
                testDictionary,
                testDictionary2
            ]);

            const result = await controller.listDictionaries();

            expect(result).toEqual(['Test Dictionary', 'Team Dictionary']);
        });

        it('should cache dictionary names', async () => {
            mockDictionaryService.listDictionaries.mockResolvedValue([testDictionary]);

            await controller.listDictionaries();
            const result = await controller.listDictionaries();

            expect(mockDictionaryService.listDictionaries).toHaveBeenCalledTimes(2);
            expect(result).toEqual(['Test Dictionary']);
        });

        it('should return empty array on error', async () => {
            mockDictionaryService.listDictionaries.mockRejectedValue(
                new Error('Service error')
            );

            const result = await controller.listDictionaries();

            expect(result).toEqual([]);
        });
    });

    describe('loadDictionary', () => {
        it('should load dictionary by name', async () => {
            mockDictionaryService.listDictionaries.mockResolvedValue([testDictionary]);

            const result = await controller.loadDictionary('Test Dictionary');

            expect(result.errors).toEqual([]);
            expect(result.value).toEqual(testDictionary);
            expect(controller.getCurrent()).toEqual(testDictionary);
        });

        it('should return error when dictionary not found', async () => {
            mockDictionaryService.listDictionaries.mockResolvedValue([testDictionary]);

            const result = await controller.loadDictionary('Non-existent');

            expect(result.errors).toContain('Dictionary "Non-existent" not found');
            expect(result.value).toBeUndefined();
        });

        it('should return error on service failure', async () => {
            mockDictionaryService.listDictionaries.mockRejectedValue(
                new Error('Service error')
            );

            const result = await controller.loadDictionary('Test Dictionary');

            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.errors[0]).toContain('Failed to load dictionary');
        });
    });

    describe('createDictionary', () => {
        it('should create new dictionary with name and description', async () => {
            const newDict: Dictionary = {
                id: 'new-dict',
                name: 'New Dictionary',
                description: 'A new dictionary',
                entries: [],
                createdAt: '2025-01-24T12:00:00Z',
                updatedAt: '2025-01-24T12:00:00Z'
            };

            mockDictionaryService.createEmptyDictionary.mockReturnValue(newDict);
            mockDictionaryService.saveDictionary.mockResolvedValue('path/to/dict.md');

            const result = await controller.createDictionary('New Dictionary', 'A new dictionary');

            expect(result.errors).toEqual([]);
            expect(result.value?.name).toBe('New Dictionary');
            expect(controller.getCurrent()).toEqual(newDict);
        });

        it('should create dictionary without description', async () => {
            const newDict: Dictionary = {
                id: 'new-dict',
                name: 'New Dictionary',
                description: '',
                entries: [],
                createdAt: '2025-01-24T12:00:00Z',
                updatedAt: '2025-01-24T12:00:00Z'
            };

            mockDictionaryService.createEmptyDictionary.mockReturnValue(newDict);
            mockDictionaryService.saveDictionary.mockResolvedValue('path/to/dict.md');

            const result = await controller.createDictionary('New Dictionary');

            expect(result.errors).toEqual([]);
            expect(result.value?.name).toBe('New Dictionary');
        });

        it('should return error on creation failure', async () => {
            mockDictionaryService.createEmptyDictionary.mockReturnValue(testDictionary);
            mockDictionaryService.saveDictionary.mockRejectedValue(
                new Error('Save failed')
            );

            const result = await controller.createDictionary('New Dictionary');

            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.errors[0]).toContain('Failed to create dictionary');
        });
    });

    describe('deleteCurrent', () => {
        it('should delete current dictionary', async () => {
            mockDictionaryService.listDictionaries.mockResolvedValue([testDictionary]);
            mockDictionaryService.deleteDictionary.mockResolvedValue(true);

            await controller.loadDictionary('Test Dictionary');
            const result = await controller.deleteCurrent();

            expect(result.errors).toEqual([]);
            expect(controller.getCurrent()).toBeNull();
        });

        it('should return error when no dictionary loaded', async () => {
            const result = await controller.deleteCurrent();

            expect(result.errors).toContain('No dictionary currently loaded');
        });

        it('should return error if deletion fails', async () => {
            mockDictionaryService.listDictionaries.mockResolvedValue([testDictionary]);
            mockDictionaryService.deleteDictionary.mockResolvedValue(false);

            await controller.loadDictionary('Test Dictionary');
            const result = await controller.deleteCurrent();

            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.errors[0]).toContain('Failed to delete dictionary');
        });
    });

    describe('extractTermsFromContent', () => {
        it('should extract terms from documents', async () => {
            mockLLMService.analyzeTags.mockResolvedValue({
                suggestedTags: ['john-smith-person', 'api-acronym'],
                matchedExistingTags: []
            });

            const result = await controller.extractTermsFromContent(
                {
                    documents: [
                        { name: 'doc1.txt', content: 'John Smith is the CEO' }
                    ],
                    language: 'English'
                },
                mockLLMService as any
            );

            expect(result.errors).toEqual([]);
            expect(result.value?.length).toBe(2);
            expect(result.value?.[0].term).toBe('john-smith');
            expect(result.value?.[0].category).toBe('person');
            expect(result.value?.[1].term).toBe('api');
            expect(result.value?.[1].category).toBe('acronym');
        });

        it('should handle terms without category suffix', async () => {
            mockLLMService.analyzeTags.mockResolvedValue({
                suggestedTags: ['project-phoenix', 'database'],
                matchedExistingTags: []
            });

            const result = await controller.extractTermsFromContent(
                {
                    documents: [{ name: 'doc1.txt', content: 'Project Phoenix database' }],
                    language: 'English'
                },
                mockLLMService as any
            );

            expect(result.errors).toEqual([]);
            expect(result.value?.length).toBe(2);
        });

        it('should deduplicate extracted terms (case-insensitive)', async () => {
            mockLLMService.analyzeTags.mockResolvedValue({
                suggestedTags: ['john-smith-person', 'John-Smith-person', 'api-acronym'],
                matchedExistingTags: []
            });

            const result = await controller.extractTermsFromContent(
                {
                    documents: [{ name: 'doc1.txt', content: 'John Smith API' }],
                    language: 'English'
                },
                mockLLMService as any
            );

            expect(result.errors).toEqual([]);
            expect(result.value?.length).toBe(2);
        });

        it('should return error when no documents provided', async () => {
            const result = await controller.extractTermsFromContent(
                { documents: [], language: 'English' },
                mockLLMService as any
            );

            expect(result.errors).toContain('No documents provided for term extraction');
            expect(result.value).toBeUndefined();
        });

        it('should return error when LLM returns no tags', async () => {
            mockLLMService.analyzeTags.mockResolvedValue({
                suggestedTags: [],
                matchedExistingTags: []
            });

            const result = await controller.extractTermsFromContent(
                {
                    documents: [{ name: 'doc1.txt', content: 'Some content' }],
                    language: 'English'
                },
                mockLLMService as any
            );

            expect(result.errors).toContain('LLM did not extract any terms');
        });

        it('should return error on LLM failure', async () => {
            mockLLMService.analyzeTags.mockRejectedValue(
                new Error('LLM error')
            );

            const result = await controller.extractTermsFromContent(
                {
                    documents: [{ name: 'doc1.txt', content: 'Some content' }],
                    language: 'English'
                },
                mockLLMService as any
            );

            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.errors[0]).toContain('Term extraction failed');
        });
    });

    describe('mergeEntries', () => {
        it('should merge new entries into dictionary', async () => {
            const updatedDict = {
                ...testDictionary,
                entries: [
                    ...testDictionary.entries,
                    { term: 'New Term', category: 'term' as const }
                ]
            };

            mockDictionaryService.listDictionaries.mockResolvedValue([testDictionary]);
            mockDictionaryService.addEntries.mockResolvedValue(updatedDict);

            await controller.loadDictionary('Test Dictionary');

            const result = await controller.mergeEntries([
                { term: 'New Term', category: 'term' }
            ]);

            expect(result.errors).toEqual([]);
            expect(controller.getCurrent()?.entries.length).toBe(3);
        });

        it('should use case-insensitive deduplication', async () => {
            mockDictionaryService.listDictionaries.mockResolvedValue([testDictionary]);
            mockDictionaryService.addEntries.mockResolvedValue(testDictionary);

            await controller.loadDictionary('Test Dictionary');

            // Try to merge "john smith" (lowercase) when "John Smith" exists
            const result = await controller.mergeEntries([
                { term: 'john smith', category: 'person' }
            ]);

            expect(result.errors).toEqual([]);
            // Should not add duplicate
            expect(mockDictionaryService.addEntries).not.toHaveBeenCalled();
        });

        it('should return error when no dictionary loaded', async () => {
            const result = await controller.mergeEntries([
                { term: 'New Term', category: 'term' }
            ]);

            expect(result.errors).toContain('No dictionary currently loaded');
        });

        it('should handle merge failure', async () => {
            mockDictionaryService.listDictionaries.mockResolvedValue([testDictionary]);

            await controller.loadDictionary('Test Dictionary');

            mockDictionaryService.addEntries.mockResolvedValue(null);

            const result = await controller.mergeEntries([
                { term: 'New Term', category: 'term' }
            ]);

            expect(result.errors).toContain('Failed to update dictionary');
        });

        it('should handle merge service error', async () => {
            mockDictionaryService.listDictionaries.mockResolvedValue([testDictionary]);

            await controller.loadDictionary('Test Dictionary');

            mockDictionaryService.addEntries.mockRejectedValue(
                new Error('Service error')
            );

            const result = await controller.mergeEntries([
                { term: 'New Term', category: 'term' }
            ]);

            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.errors[0]).toContain('Failed to merge entries');
        });
    });

    describe('addCustomEntries', () => {
        it('should add custom entries to dictionary', async () => {
            const updatedDict = {
                ...testDictionary,
                entries: [
                    ...testDictionary.entries,
                    { term: 'Custom Term', category: 'term' as const, definition: 'Custom def' }
                ]
            };

            mockDictionaryService.listDictionaries.mockResolvedValue([testDictionary]);
            mockDictionaryService.addEntries.mockResolvedValue(updatedDict);

            await controller.loadDictionary('Test Dictionary');

            const result = await controller.addCustomEntries([
                { term: 'Custom Term', category: 'term', definition: 'Custom def' }
            ]);

            expect(result.errors).toEqual([]);
            expect(mockDictionaryService.addEntries).toHaveBeenCalled();
        });

        it('should return error when no dictionary loaded', async () => {
            const result = await controller.addCustomEntries([
                { term: 'Custom Term', category: 'term' }
            ]);

            expect(result.errors).toContain('No dictionary currently loaded');
        });

        it('should return error when no entries provided', async () => {
            mockDictionaryService.listDictionaries.mockResolvedValue([testDictionary]);

            await controller.loadDictionary('Test Dictionary');

            const result = await controller.addCustomEntries([]);

            expect(result.errors).toContain('No entries provided to add');
        });
    });

    describe('formatForPrompt', () => {
        it('should return formatted dictionary for prompt', async () => {
            mockDictionaryService.listDictionaries.mockResolvedValue([testDictionary]);
            mockDictionaryService.formatForPrompt.mockReturnValue('Formatted: Test Dictionary');

            await controller.loadDictionary('Test Dictionary');

            const result = controller.formatForPrompt();

            expect(result).toBe('Formatted: Test Dictionary');
        });

        it('should return empty string when no dictionary loaded', () => {
            const result = controller.formatForPrompt();

            expect(result).toBe('');
        });
    });

    describe('getEntryCount', () => {
        it('should return entry count of current dictionary', async () => {
            mockDictionaryService.listDictionaries.mockResolvedValue([testDictionary]);

            await controller.loadDictionary('Test Dictionary');

            expect(controller.getEntryCount()).toBe(2);
        });

        it('should return 0 when no dictionary loaded', () => {
            expect(controller.getEntryCount()).toBe(0);
        });
    });

    describe('getEntriesByCategory', () => {
        it('should return entries filtered by category', async () => {
            mockDictionaryService.listDictionaries.mockResolvedValue([testDictionary]);

            await controller.loadDictionary('Test Dictionary');

            const people = controller.getEntriesByCategory('person');

            expect(people.length).toBe(1);
            expect(people[0].term).toBe('John Smith');
        });

        it('should return empty array when no entries in category', async () => {
            mockDictionaryService.listDictionaries.mockResolvedValue([testDictionary]);

            await controller.loadDictionary('Test Dictionary');

            const projects = controller.getEntriesByCategory('project');

            expect(projects).toEqual([]);
        });

        it('should return empty array when no dictionary loaded', () => {
            const result = controller.getEntriesByCategory('person');

            expect(result).toEqual([]);
        });
    });

    describe('searchEntries', () => {
        it('should search entries by term (substring match)', async () => {
            mockDictionaryService.listDictionaries.mockResolvedValue([testDictionary]);

            await controller.loadDictionary('Test Dictionary');

            const results = controller.searchEntries('john');

            expect(results.length).toBe(1);
            expect(results[0].term).toBe('John Smith');
        });

        it('should perform case-insensitive search', async () => {
            mockDictionaryService.listDictionaries.mockResolvedValue([testDictionary]);

            await controller.loadDictionary('Test Dictionary');

            const results = controller.searchEntries('JOHN');

            expect(results.length).toBe(1);
        });

        it('should search by aliases (Issue 8 test)', async () => {
            mockDictionaryService.listDictionaries.mockResolvedValue([testDictionary]);

            await controller.loadDictionary('Test Dictionary');

            // Search for alias 'JS'
            const results1 = controller.searchEntries('JS');
            expect(results1.length).toBe(1);
            expect(results1[0].term).toBe('John Smith');

            // Search for alias 'Johnny'
            const results2 = controller.searchEntries('johnny');
            expect(results2.length).toBe(1);
            expect(results2[0].term).toBe('John Smith');
        });

        it('should return empty array when no matches', async () => {
            mockDictionaryService.listDictionaries.mockResolvedValue([testDictionary]);

            await controller.loadDictionary('Test Dictionary');

            const results = controller.searchEntries('nonexistent');

            expect(results).toEqual([]);
        });

        it('should return empty array when no dictionary loaded', () => {
            const results = controller.searchEntries('john');

            expect(results).toEqual([]);
        });

        it('should return immutable copies of entries', async () => {
            mockDictionaryService.listDictionaries.mockResolvedValue([testDictionary]);

            await controller.loadDictionary('Test Dictionary');

            const results = controller.searchEntries('john');
            if (results[0]?.aliases) {
                results[0].aliases.push('Mutated');
                const results2 = controller.searchEntries('john');
                expect(results2[0].aliases?.includes('Mutated')).toBe(false);
            }
        });
    });

    describe('removeEntry', () => {
        it('should remove entry by term', async () => {
            const freshDict = createTestDict();
            mockDictionaryService.listDictionaries.mockResolvedValue([freshDict]);
            mockDictionaryService.saveDictionary.mockResolvedValue('path/to/dict.md');

            await controller.loadDictionary('Test Dictionary');

            const result = await controller.removeEntry('John Smith');

            expect(result.errors).toEqual([]);
            expect(mockDictionaryService.saveDictionary).toHaveBeenCalled();
            // Verify entry count decreased
            expect(controller.getEntryCount()).toBe(1);
        });

        it('should use case-insensitive matching', async () => {
            const freshDict = createTestDict();
            mockDictionaryService.listDictionaries.mockResolvedValue([freshDict]);
            mockDictionaryService.saveDictionary.mockResolvedValue('path/to/dict.md');

            await controller.loadDictionary('Test Dictionary');

            const result = await controller.removeEntry('john smith');

            expect(result.errors).toEqual([]);
            expect(mockDictionaryService.saveDictionary).toHaveBeenCalled();
        });

        it('should return error when no dictionary loaded', async () => {
            const result = await controller.removeEntry('John Smith');

            expect(result.errors).toContain('No dictionary currently loaded');
        });

        it('should return error when entry not found', async () => {
            const freshDict = createTestDict();
            mockDictionaryService.listDictionaries.mockResolvedValue([freshDict]);

            await controller.loadDictionary('Test Dictionary');

            const result = await controller.removeEntry('Nonexistent');

            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.errors[0]).toContain('not found');
        });

        it('should handle save failure', async () => {
            const freshDict = createTestDict();
            mockDictionaryService.listDictionaries.mockResolvedValue([freshDict]);
            mockDictionaryService.saveDictionary.mockRejectedValue(new Error('Save failed'));

            await controller.loadDictionary('Test Dictionary');

            const result = await controller.removeEntry('John Smith');

            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.errors[0]).toContain('Failed to remove entry');
        });
    });

    describe('clear', () => {
        it('should clear current dictionary', async () => {
            mockDictionaryService.listDictionaries.mockResolvedValue([testDictionary]);

            await controller.loadDictionary('Test Dictionary');
            expect(controller.isLoaded()).toBe(true);

            controller.clear();

            expect(controller.isLoaded()).toBe(false);
            expect(controller.getCurrent()).toBeNull();
        });
    });

    describe('isLoaded', () => {
        it('should return false when no dictionary loaded', () => {
            expect(controller.isLoaded()).toBe(false);
        });

        it('should return true when dictionary loaded', async () => {
            mockDictionaryService.listDictionaries.mockResolvedValue([testDictionary]);

            await controller.loadDictionary('Test Dictionary');

            expect(controller.isLoaded()).toBe(true);
        });

        it('should return false after clearing', async () => {
            mockDictionaryService.listDictionaries.mockResolvedValue([testDictionary]);

            await controller.loadDictionary('Test Dictionary');
            controller.clear();

            expect(controller.isLoaded()).toBe(false);
        });
    });
});
