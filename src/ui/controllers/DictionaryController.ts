/**
 * DictionaryController
 * Manages dictionary state, CRUD operations, term extraction, and merging
 * Responsible for handling all dictionary interactions in UI modals
 */

import type AIOrganiserPlugin from '../../main';
import { DictionaryService, Dictionary, DictionaryEntry } from '../../services/dictionaryService';
import { LLMService, type LanguageCode } from '../../services/types';
import { buildTermExtractionPrompt } from '../../services/prompts/dictionaryPrompts';
import { TaggingMode } from '../../services/prompts/types';

export interface TermExtractionOptions {
    documents: Array<{ name: string; content: string }>;
    existingTerms?: string[];
    language?: LanguageCode;
}

export interface DictionaryResult<T> {
    value?: T;
    errors: string[];
}

export class DictionaryController {
    private dictionaryService: DictionaryService;
    private plugin: AIOrganiserPlugin;
    private currentDictionary: Dictionary | null = null;
    private dictionaryNames: string[] = [];

    constructor(dictionaryService: DictionaryService, plugin: AIOrganiserPlugin) {
        this.dictionaryService = dictionaryService;
        this.plugin = plugin;
    }

    /**
     * Get the current loaded dictionary
     */
    getCurrent(): Dictionary | null {
        return this.currentDictionary ? { ...this.currentDictionary } : null;
    }

    /**
     * Get current dictionary name (for UI display)
     */
    getCurrentName(): string | null {
        return this.currentDictionary?.name || null;
    }

    /**
     * Get current dictionary ID
     */
    getCurrentId(): string | null {
        return this.currentDictionary?.id || null;
    }

    /**
     * List all available dictionary names
     * Cached after first load
     */
    async listDictionaries(): Promise<string[]> {
        try {
            const dictionaries = await this.dictionaryService.listDictionaries();
            this.dictionaryNames = dictionaries.map(d => d.name);
            return this.dictionaryNames;
        } catch (error) {
            console.error('[AI Organiser] Failed to list dictionaries:', error);
            return [];
        }
    }

    /**
     * Load a dictionary by name
     * Updates current dictionary
     * Returns errors if load fails
     */
    async loadDictionary(name: string): Promise<DictionaryResult<Dictionary>> {
        const errors: string[] = [];

        try {
            const dictionaries = await this.dictionaryService.listDictionaries();
            const dict = dictionaries.find(d => d.name === name);

            if (!dict) {
                errors.push(`Dictionary "${name}" not found`);
                return { errors };
            }

            this.currentDictionary = dict;
            return { value: { ...dict }, errors };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`Failed to load dictionary: ${message}`);
            return { errors };
        }
    }

    /**
     * Create a new empty dictionary
     * Saves to vault and sets as current
     * Returns errors if creation fails
     */
    async createDictionary(
        name: string,
        description: string = ''
    ): Promise<DictionaryResult<Dictionary>> {
        const errors: string[] = [];

        try {
            const dictionary = this.dictionaryService.createEmptyDictionary(name, description);
            await this.dictionaryService.saveDictionary(dictionary);
            this.currentDictionary = dictionary;

            // Update cached names
            this.dictionaryNames.push(name);

            return { value: { ...dictionary }, errors };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`Failed to create dictionary: ${message}`);
            return { errors };
        }
    }

    /**
     * Delete the current dictionary
     * Clears current if successful
     */
    async deleteCurrent(): Promise<DictionaryResult<void>> {
        const errors: string[] = [];

        if (!this.currentDictionary) {
            errors.push('No dictionary currently loaded');
            return { errors };
        }

        try {
            const success = await this.dictionaryService.deleteDictionary(this.currentDictionary.id);

            if (!success) {
                errors.push(`Failed to delete dictionary: ${this.currentDictionary.name}`);
                return { errors };
            }

            // Update cached names
            this.dictionaryNames = this.dictionaryNames.filter(
                name => name !== this.currentDictionary?.name
            );

            this.currentDictionary = null;
            return { errors };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`Failed to delete dictionary: ${message}`);
            return { errors };
        }
    }

    /**
     * Extract terms from document contents using LLM
     * Returns errors array if extraction fails
     * Does NOT modify current dictionary
     */
    async extractTermsFromContent(
        options: TermExtractionOptions,
        llmService: LLMService
    ): Promise<DictionaryResult<DictionaryEntry[]>> {
        const errors: string[] = [];

        if (options.documents.length === 0) {
            errors.push('No documents provided for term extraction');
            return { errors };
        }

        try {
            // Build extraction prompt with existing terms for context
            const prompt = buildTermExtractionPrompt(
                options.documents,
                options.existingTerms || [],
                options.language
            );

            // Call LLM service
            const response = await llmService.analyzeTags(
                prompt,
                [],
                TaggingMode.GenerateNew,
                50,
                options.language || 'en'
            );

            if (!response.suggestedTags || response.suggestedTags.length === 0) {
                errors.push('LLM did not extract any terms');
                return { errors };
            }

            // Parse extracted terms into entries
            // LLM returns tags in format: "term-person" or "term" or "term-acronym"
            const entries: DictionaryEntry[] = [];
            const seenTerms = new Set<string>();

            for (const tag of response.suggestedTags) {
                const parts = tag.split('-');
                const isCategory = parts.length > 1 &&
                    ['person', 'acronym', 'term', 'project', 'organization'].includes(parts[parts.length - 1]);

                if (isCategory) {
                    const category = parts[parts.length - 1] as DictionaryEntry['category'];
                    const term = parts.slice(0, -1).join('-');

                    if (!seenTerms.has(term.toLowerCase())) {
                        entries.push({
                            term,
                            category,
                            definition: undefined,
                            aliases: undefined
                        });
                        seenTerms.add(term.toLowerCase());
                    }
                } else {
                    // No category suffix, default to 'term'
                    if (!seenTerms.has(tag.toLowerCase())) {
                        entries.push({
                            term: tag,
                            category: 'term',
                            definition: undefined,
                            aliases: undefined
                        });
                        seenTerms.add(tag.toLowerCase());
                    }
                }
            }

            return { value: entries, errors };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`Term extraction failed: ${message}`);
            return { errors };
        }
    }

    /**
     * Merge entries into current dictionary
     * Uses case-insensitive deduplication on term
     * Returns errors if merge fails or no dictionary loaded
     */
    async mergeEntries(entries: DictionaryEntry[]): Promise<DictionaryResult<void>> {
        const errors: string[] = [];

        if (!this.currentDictionary) {
            errors.push('No dictionary currently loaded');
            return { errors };
        }

        try {
            // Perform merge with case-insensitive deduplication
            const existingTermsLower = new Set(
                this.currentDictionary.entries.map(e => e.term.toLowerCase())
            );

            const entriesToAdd: DictionaryEntry[] = [];

            for (const entry of entries) {
                if (!existingTermsLower.has(entry.term.toLowerCase())) {
                    entriesToAdd.push(entry);
                }
            }

            if (entriesToAdd.length === 0) {
                // No new entries to add, still return success
                return { errors };
            }

            // Add entries and save
            const updated = await this.dictionaryService.addEntries(
                this.currentDictionary.id,
                entriesToAdd
            );

            if (!updated) {
                errors.push('Failed to update dictionary');
                return { errors };
            }

            // Update current dictionary with new entries
            this.currentDictionary = updated;

            return { errors };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`Failed to merge entries: ${message}`);
            return { errors };
        }
    }

    /**
     * Add custom entries to current dictionary
     * Similar to mergeEntries but for user-added entries
     */
    async addCustomEntries(entries: DictionaryEntry[]): Promise<DictionaryResult<void>> {
        const errors: string[] = [];

        if (!this.currentDictionary) {
            errors.push('No dictionary currently loaded');
            return { errors };
        }

        if (entries.length === 0) {
            errors.push('No entries provided to add');
            return { errors };
        }

        try {
            const updated = await this.dictionaryService.addEntries(
                this.currentDictionary.id,
                entries
            );

            if (!updated) {
                errors.push('Failed to add entries to dictionary');
                return { errors };
            }

            this.currentDictionary = updated;
            return { errors };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`Failed to add entries: ${message}`);
            return { errors };
        }
    }

    /**
     * Format current dictionary for LLM prompt injection
     * Returns empty string if no dictionary loaded
     */
    formatForPrompt(): string {
        if (!this.currentDictionary) {
            return '';
        }

        return this.dictionaryService.formatForPrompt(this.currentDictionary);
    }

    /**
     * Get entry count from current dictionary
     */
    getEntryCount(): number {
        return this.currentDictionary?.entries.length || 0;
    }

    /**
     * Get entries by category from current dictionary
     */
    getEntriesByCategory(
        category: DictionaryEntry['category']
    ): DictionaryEntry[] {
        if (!this.currentDictionary) {
            return [];
        }

        return this.currentDictionary.entries
            .filter(e => e.category === category)
            .map(e => ({ ...e }));
    }

    /**
     * Search for entries by term (substring match, case-insensitive)
     */
    searchEntries(searchTerm: string): DictionaryEntry[] {
        if (!this.currentDictionary) {
            return [];
        }

        const lowerSearch = searchTerm.toLowerCase();

        return this.currentDictionary.entries
            .filter(e => e.term.toLowerCase().includes(lowerSearch))
            .map(e => ({ ...e }));
    }

    /**
     * Clear current dictionary (sets to null)
     * Does not delete from vault
     */
    clear(): void {
        this.currentDictionary = null;
    }

    /**
     * Check if a dictionary is currently loaded
     */
    isLoaded(): boolean {
        return this.currentDictionary !== null;
    }
}
