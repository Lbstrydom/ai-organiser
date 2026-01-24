/**
 * Dictionary Service
 * Manages terminology dictionaries for meeting minutes transcription accuracy
 * Dictionaries are stored as markdown files in the vault for cross-device sync
 */

import { App, TFile, TFolder, normalizePath } from 'obsidian';

export interface DictionaryEntry {
    term: string;
    category: 'person' | 'acronym' | 'term' | 'project' | 'organization';
    definition?: string;
    aliases?: string[];
}

export interface Dictionary {
    id: string;
    name: string;
    description: string;
    entries: DictionaryEntry[];
    createdAt: string;
    updatedAt: string;
}

export interface DictionaryExtractionResult {
    success: boolean;
    entries?: DictionaryEntry[];
    error?: string;
}

// Default dictionary folder within the config folder
const DICTIONARY_FOLDER = 'dictionaries';

export class DictionaryService {
    private app: App;
    private configFolder: string;

    constructor(app: App, configFolder: string) {
        this.app = app;
        this.configFolder = configFolder;
    }

    /**
     * Get the path to the dictionaries folder
     */
    getDictionariesFolder(): string {
        return normalizePath(`${this.configFolder}/${DICTIONARY_FOLDER}`);
    }

    /**
     * Ensure the dictionaries folder exists
     */
    async ensureDictionariesFolder(): Promise<void> {
        const folderPath = this.getDictionariesFolder();
        const folder = this.app.vault.getAbstractFileByPath(folderPath);

        if (!folder) {
            try {
                await this.app.vault.createFolder(folderPath);
            } catch {
                // Folder may already exist
                console.debug(`[AI Organiser] Dictionaries folder "${folderPath}" already exists or could not be created`);
            }
        }
    }

    /**
     * List all available dictionaries
     */
    async listDictionaries(): Promise<Dictionary[]> {
        await this.ensureDictionariesFolder();

        const folderPath = this.getDictionariesFolder();
        const folder = this.app.vault.getAbstractFileByPath(folderPath);

        if (!folder || !(folder instanceof TFolder)) {
            return [];
        }

        const dictionaries: Dictionary[] = [];

        for (const child of folder.children) {
            if (child instanceof TFile && child.extension === 'md') {
                try {
                    const dictionary = await this.loadDictionary(child.path);
                    if (dictionary) {
                        dictionaries.push(dictionary);
                    }
                } catch {
                    console.warn(`[AI Organiser] Failed to load dictionary: ${child.path}`);
                }
            }
        }

        // Sort by name
        return dictionaries.sort((a, b) => a.name.localeCompare(b.name));
    }

    /**
     * Load a dictionary from a file path
     */
    async loadDictionary(path: string): Promise<Dictionary | null> {
        const file = this.app.vault.getAbstractFileByPath(path);

        if (!file || !(file instanceof TFile)) {
            return null;
        }

        try {
            const content = await this.app.vault.read(file);
            return this.parseDictionaryContent(content, file.basename);
        } catch {
            return null;
        }
    }

    /**
     * Load a dictionary by ID (filename without extension)
     */
    async getDictionaryById(id: string): Promise<Dictionary | null> {
        const path = normalizePath(`${this.getDictionariesFolder()}/${id}.md`);
        return this.loadDictionary(path);
    }

    /**
     * Save a dictionary to the vault
     */
    async saveDictionary(dictionary: Dictionary): Promise<string> {
        await this.ensureDictionariesFolder();

        const path = normalizePath(`${this.getDictionariesFolder()}/${dictionary.id}.md`);
        const content = this.generateDictionaryContent(dictionary);

        const existingFile = this.app.vault.getAbstractFileByPath(path);

        if (existingFile instanceof TFile) {
            await this.app.vault.modify(existingFile, content);
        } else {
            await this.app.vault.create(path, content);
        }

        return path;
    }

    /**
     * Delete a dictionary
     */
    async deleteDictionary(id: string): Promise<boolean> {
        const path = normalizePath(`${this.getDictionariesFolder()}/${id}.md`);
        const file = this.app.vault.getAbstractFileByPath(path);

        if (file instanceof TFile) {
            await this.app.vault.delete(file);
            return true;
        }

        return false;
    }

    /**
     * Create a new empty dictionary
     */
    createEmptyDictionary(name: string, description: string = ''): Dictionary {
        const id = name.toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');

        const now = new Date().toISOString();

        return {
            id,
            name,
            description,
            entries: [],
            createdAt: now,
            updatedAt: now
        };
    }

    /**
     * Add entries to a dictionary
     */
    async addEntries(dictionaryId: string, entries: DictionaryEntry[]): Promise<Dictionary | null> {
        const dictionary = await this.getDictionaryById(dictionaryId);

        if (!dictionary) {
            return null;
        }

        // Merge entries, avoiding duplicates by term (case-insensitive)
        const existingTerms = new Set(dictionary.entries.map(e => e.term.toLowerCase()));

        for (const entry of entries) {
            if (!existingTerms.has(entry.term.toLowerCase())) {
                dictionary.entries.push(entry);
                existingTerms.add(entry.term.toLowerCase());
            }
        }

        dictionary.updatedAt = new Date().toISOString();
        await this.saveDictionary(dictionary);

        return dictionary;
    }

    /**
     * Parse dictionary content from markdown
     *
     * Format:
     * ---
     * name: Dictionary Name
     * description: Optional description
     * created: 2025-01-24T12:00:00Z
     * updated: 2025-01-24T12:00:00Z
     * ---
     *
     * ## People
     * - **John Smith** - CEO, Project sponsor
     * - **Jane Doe** (JD) - Project Manager
     *
     * ## Acronyms
     * - **API** - Application Programming Interface
     * - **KPI** - Key Performance Indicator
     *
     * ## Projects
     * - **Project Phoenix** - Digital transformation initiative
     *
     * ## Organizations
     * - **ACME Corp** - Main client
     *
     * ## Terms
     * - **Sprint velocity** - Measure of work completed per sprint
     */
    private parseDictionaryContent(content: string, filename: string): Dictionary {
        const lines = content.split('\n');

        let name = filename;
        let description = '';
        let createdAt = new Date().toISOString();
        let updatedAt = new Date().toISOString();
        const entries: DictionaryEntry[] = [];

        let inFrontmatter = false;
        let frontmatterEnded = false;
        let currentCategory: DictionaryEntry['category'] | null = null;

        for (const line of lines) {
            const trimmed = line.trim();

            // Handle frontmatter
            if (trimmed === '---') {
                if (!frontmatterEnded) {
                    inFrontmatter = !inFrontmatter;
                    if (!inFrontmatter) {
                        frontmatterEnded = true;
                    }
                }
                continue;
            }

            if (inFrontmatter) {
                const match = trimmed.match(/^(\w+):\s*(.+)$/);
                if (match) {
                    const [, key, value] = match;
                    switch (key.toLowerCase()) {
                        case 'name':
                            name = value;
                            break;
                        case 'description':
                            description = value;
                            break;
                        case 'created':
                            createdAt = value;
                            break;
                        case 'updated':
                            updatedAt = value;
                            break;
                    }
                }
                continue;
            }

            // Parse section headers
            if (trimmed.startsWith('## ')) {
                const sectionName = trimmed.substring(3).toLowerCase();
                if (sectionName.includes('people') || sectionName.includes('person')) {
                    currentCategory = 'person';
                } else if (sectionName.includes('acronym')) {
                    currentCategory = 'acronym';
                } else if (sectionName.includes('project')) {
                    currentCategory = 'project';
                } else if (sectionName.includes('organization') || sectionName.includes('organisation')) {
                    currentCategory = 'organization';
                } else if (sectionName.includes('term')) {
                    currentCategory = 'term';
                } else {
                    currentCategory = 'term'; // Default
                }
                continue;
            }

            // Parse entries (list items)
            if (currentCategory && trimmed.startsWith('- ')) {
                const entry = this.parseEntryLine(trimmed.substring(2), currentCategory);
                if (entry) {
                    entries.push(entry);
                }
            }
        }

        const id = filename.toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');

        return {
            id,
            name,
            description,
            entries,
            createdAt,
            updatedAt
        };
    }

    /**
     * Parse a single entry line
     * Formats supported:
     * - **Term** - Definition
     * - **Term** (Alias1, Alias2) - Definition
     * - **Term**
     */
    private parseEntryLine(line: string, category: DictionaryEntry['category']): DictionaryEntry | null {
        // Match: **Term** optionally followed by (aliases) and/or - definition
        const match = line.match(/^\*\*([^*]+)\*\*(?:\s*\(([^)]+)\))?\s*(?:-\s*(.+))?$/);

        if (!match) {
            // Try simpler format without bold
            const simpleMatch = line.match(/^([^-]+?)(?:\s*\(([^)]+)\))?\s*(?:-\s*(.+))?$/);
            if (simpleMatch) {
                const [, term, aliasStr, definition] = simpleMatch;
                const aliases = aliasStr
                    ? aliasStr.split(',').map(a => a.trim()).filter(a => a)
                    : undefined;
                return {
                    term: term.trim(),
                    category,
                    definition: definition?.trim(),
                    aliases: aliases && aliases.length > 0 ? aliases : undefined
                };
            }
            return null;
        }

        const [, term, aliasStr, definition] = match;
        const aliases = aliasStr
            ? aliasStr.split(',').map(a => a.trim()).filter(a => a)
            : undefined;

        return {
            term: term.trim(),
            category,
            definition: definition?.trim(),
            aliases: aliases && aliases.length > 0 ? aliases : undefined
        };
    }

    /**
     * Generate markdown content for a dictionary
     */
    private generateDictionaryContent(dictionary: Dictionary): string {
        const lines: string[] = [];

        // Frontmatter
        lines.push('---');
        lines.push(`name: ${dictionary.name}`);
        if (dictionary.description) {
            lines.push(`description: ${dictionary.description}`);
        }
        lines.push(`created: ${dictionary.createdAt}`);
        lines.push(`updated: ${dictionary.updatedAt}`);
        lines.push('---');
        lines.push('');

        // Group entries by category
        const categories: Record<DictionaryEntry['category'], DictionaryEntry[]> = {
            person: [],
            acronym: [],
            project: [],
            organization: [],
            term: []
        };

        for (const entry of dictionary.entries) {
            categories[entry.category].push(entry);
        }

        // Generate sections
        const categoryTitles: Record<DictionaryEntry['category'], string> = {
            person: 'People',
            acronym: 'Acronyms',
            project: 'Projects',
            organization: 'Organizations',
            term: 'Terms'
        };

        for (const [category, title] of Object.entries(categoryTitles)) {
            const entries = categories[category as DictionaryEntry['category']];
            if (entries.length > 0) {
                lines.push(`## ${title}`);
                lines.push('');
                for (const entry of entries) {
                    lines.push(this.formatEntryLine(entry));
                }
                lines.push('');
            }
        }

        return lines.join('\n');
    }

    /**
     * Format a single entry as a markdown list item
     */
    private formatEntryLine(entry: DictionaryEntry): string {
        let line = `- **${entry.term}**`;

        if (entry.aliases && entry.aliases.length > 0) {
            line += ` (${entry.aliases.join(', ')})`;
        }

        if (entry.definition) {
            line += ` - ${entry.definition}`;
        }

        return line;
    }

    /**
     * Format dictionary entries for injection into prompts
     */
    formatForPrompt(dictionary: Dictionary): string {
        if (dictionary.entries.length === 0) {
            return '';
        }

        const lines: string[] = [];
        lines.push(`<dictionary name="${dictionary.name}">`);

        // Group by category for cleaner output
        const categories: Record<string, DictionaryEntry[]> = {};
        for (const entry of dictionary.entries) {
            if (!categories[entry.category]) {
                categories[entry.category] = [];
            }
            categories[entry.category].push(entry);
        }

        for (const [category, entries] of Object.entries(categories)) {
            lines.push(`<${category}s>`);
            for (const entry of entries) {
                let entryLine = entry.term;
                if (entry.aliases && entry.aliases.length > 0) {
                    entryLine += ` (${entry.aliases.join(', ')})`;
                }
                if (entry.definition) {
                    entryLine += `: ${entry.definition}`;
                }
                lines.push(`- ${entryLine}`);
            }
            lines.push(`</${category}s>`);
        }

        lines.push('</dictionary>');
        return lines.join('\n');
    }

    /**
     * Build the prompt for extracting dictionary entries from documents
     */
    buildExtractionPrompt(): string {
        return `You are analyzing documents to extract a terminology dictionary for meeting transcription.

Extract the following types of entries:

1. **People**: Names of individuals mentioned (with roles/titles if available)
2. **Acronyms**: Abbreviations and their full forms
3. **Projects**: Project names or codenames
4. **Organizations**: Company names, departments, teams
5. **Terms**: Technical terms, jargon, or domain-specific vocabulary

Return a valid JSON array with this structure:
[
  {
    "term": "The exact term or name",
    "category": "person|acronym|project|organization|term",
    "definition": "Optional brief description or full form",
    "aliases": ["optional", "alternative", "names"]
  }
]

Rules:
- Extract ONLY terms that appear in the document
- For acronyms, the definition should be the full form
- For people, include role/title in definition if mentioned
- Do not invent or assume - only extract what is explicitly stated
- Keep definitions brief (under 100 characters)
- Return an empty array [] if no relevant terms found

Return ONLY the JSON array, no other text.`;
    }

    /**
     * Parse extraction response from LLM
     */
    parseExtractionResponse(response: string): DictionaryExtractionResult {
        try {
            // Try to find JSON array in response
            let jsonStr = response.trim();

            // Remove markdown code fences if present
            jsonStr = jsonStr.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');

            // Find array brackets
            const start = jsonStr.indexOf('[');
            const end = jsonStr.lastIndexOf(']');

            if (start === -1 || end === -1 || end <= start) {
                return { success: false, error: 'No valid JSON array found in response' };
            }

            jsonStr = jsonStr.substring(start, end + 1);

            const parsed = JSON.parse(jsonStr);

            if (!Array.isArray(parsed)) {
                return { success: false, error: 'Response is not an array' };
            }

            // Validate and normalize entries
            const entries: DictionaryEntry[] = [];
            const validCategories = ['person', 'acronym', 'project', 'organization', 'term'];

            for (const item of parsed) {
                if (!item.term || !item.category) {
                    continue;
                }

                const category = item.category.toLowerCase();
                if (!validCategories.includes(category)) {
                    continue;
                }

                entries.push({
                    term: String(item.term).trim(),
                    category: category as DictionaryEntry['category'],
                    definition: item.definition ? String(item.definition).trim() : undefined,
                    aliases: Array.isArray(item.aliases)
                        ? item.aliases.map((a: unknown) => String(a).trim()).filter((a: string) => a)
                        : undefined
                });
            }

            return { success: true, entries };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to parse extraction response'
            };
        }
    }
}
