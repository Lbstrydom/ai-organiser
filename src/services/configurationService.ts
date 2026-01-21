/**
 * Configuration Service
 * Loads taxonomy and prompts from user-editable files in the vault
 * Falls back to defaults if files don't exist
 */

import { App, TFile, normalizePath } from 'obsidian';

export interface ConfigPaths {
    taxonomyFile: string;      // Main taxonomy with themes and disciplines
    summaryPrompt: string;     // Summary prompt template
    excludedTags: string;      // Tags to never suggest
    personas: string;          // AI personas for different note-taking styles
}

export interface TaxonomyEntry {
    name: string;
    description: string;
    useWhen: string;
}

export interface Persona {
    id: string;           // Unique identifier (kebab-case)
    name: string;         // Display name
    description: string;  // Short description for selection UI
    prompt: string;       // The actual prompt/instructions for the AI
    isDefault?: boolean;  // Mark one as default
}

export interface Taxonomy {
    themes: TaxonomyEntry[];
    disciplines: TaxonomyEntry[];
}

export interface ConfigContent {
    taxonomy: Taxonomy;
    summaryPromptTemplate: string | null;
    excludedTags: string[];
    personas: Persona[];
}

// Default taxonomy with descriptions for AI context
export const DEFAULT_TAXONOMY: Taxonomy = {
    themes: [
        { name: 'Technology', description: 'Software, hardware, digital tools and systems', useWhen: 'Content about tech, software development, digital transformation' },
        { name: 'Strategy', description: 'Business strategy, planning, competitive analysis', useWhen: 'Strategic planning, market positioning, business models' },
        { name: 'Leadership', description: 'Management, team leadership, executive skills', useWhen: 'Leading teams, management practices, organizational leadership' },
        { name: 'AI', description: 'Artificial intelligence, machine learning, LLMs', useWhen: 'ML models, AI applications, neural networks, automation' },
        { name: 'Business', description: 'General business operations and practices', useWhen: 'Business processes, entrepreneurship, organizational topics' },
        { name: 'Finance', description: 'Financial management, accounting, investments', useWhen: 'Money management, budgeting, financial analysis' },
        { name: 'Marketing', description: 'Marketing strategies, branding, customer acquisition', useWhen: 'Campaigns, brand building, market research, advertising' },
        { name: 'Personal-Development', description: 'Self-improvement, productivity, learning', useWhen: 'Personal growth, habits, skills development' },
        { name: 'Science', description: 'Scientific research and discoveries', useWhen: 'Research findings, scientific methods, experiments' },
        { name: 'Health', description: 'Health, wellness, medical topics', useWhen: 'Physical health, mental wellness, medical information' },
        { name: 'Creativity', description: 'Creative processes, art, design', useWhen: 'Creative work, artistic expression, design thinking' },
        { name: 'Communication', description: 'Communication skills, writing, presenting', useWhen: 'Writing, public speaking, interpersonal communication' },
    ],
    disciplines: [
        { name: 'computer-science', description: 'Programming, algorithms, data structures', useWhen: 'Coding, software architecture, computational concepts' },
        { name: 'mathematics', description: 'Mathematical concepts and applications', useWhen: 'Formulas, proofs, statistical analysis, logic' },
        { name: 'product-management', description: 'Product development and lifecycle', useWhen: 'Product roadmaps, user research, feature prioritization' },
        { name: 'data-science', description: 'Data analysis and visualization', useWhen: 'Data pipelines, analytics, visualization, insights' },
        { name: 'psychology', description: 'Human behavior and mental processes', useWhen: 'Behavioral patterns, cognitive processes, mental health' },
        { name: 'economics', description: 'Economic theories and markets', useWhen: 'Market dynamics, economic policy, supply and demand' },
        { name: 'project-management', description: 'Managing projects and teams', useWhen: 'Project planning, agile methods, team coordination' },
        { name: 'design', description: 'Visual and UX design principles', useWhen: 'UI/UX, graphic design, design systems' },
    ]
};

// Default personas for different note-taking styles
export const DEFAULT_PERSONAS: Persona[] = [
    {
        id: 'balanced',
        name: 'Balanced',
        description: 'Clear, informative notes that balance detail with readability',
        prompt: `You are a skilled note-taker creating clear, well-organized notes.

Style guidelines:
- Use clear, straightforward language
- Balance detail with readability
- Include relevant examples where helpful
- Organize with appropriate headings
- Highlight key points and takeaways`,
        isDefault: true
    },
    {
        id: 'academic',
        name: 'Academic',
        description: 'Formal, rigorous notes with citations and structured arguments',
        prompt: `You are an academic researcher creating scholarly notes.

Style guidelines:
- Use formal, precise academic language
- Present arguments with clear logical structure
- Note methodologies and limitations
- Include relevant citations and references
- Distinguish between facts, interpretations, and hypotheses
- Use discipline-appropriate terminology`
    },
    {
        id: 'practical',
        name: 'Practical',
        description: 'Action-oriented notes focused on "how-to" and applications',
        prompt: `You are a practical knowledge worker creating actionable notes.

Style guidelines:
- Focus on "how-to" and practical applications
- Use bullet points and numbered steps
- Include concrete examples and use cases
- Highlight tools, techniques, and best practices
- Keep theory minimal - emphasize what's actionable
- Note any prerequisites or warnings`
    },
    {
        id: 'concise',
        name: 'Concise',
        description: 'Brief, dense notes that capture essence without elaboration',
        prompt: `You are creating highly condensed notes that maximize information density.

Style guidelines:
- Be extremely brief - every word must earn its place
- Use abbreviations and shorthand where clear
- Bullet points over prose
- Only essential information - no elaboration
- Perfect for quick reference and review`
    },
    {
        id: 'creative',
        name: 'Creative',
        description: 'Exploratory notes with analogies, connections, and questions',
        prompt: `You are a creative thinker capturing ideas and connections.

Style guidelines:
- Draw analogies and unexpected connections
- Pose questions and explore possibilities
- Use metaphors to explain complex concepts
- Note inspirations and creative tangents
- Keep an exploratory, curious tone
- Connect to other fields and ideas`
    },
    {
        id: 'socratic',
        name: 'Socratic',
        description: 'Question-driven notes that encourage deeper thinking',
        prompt: `You are a Socratic learner creating notes that promote deeper understanding.

Style guidelines:
- Frame content through questions
- Challenge assumptions and explore "why"
- Note contradictions and tensions
- Identify what's uncertain or debatable
- Include questions for further exploration
- Encourage critical thinking`
    }
];

// Default folder for configuration files
export const DEFAULT_CONFIG_FOLDER = 'AI-Organiser-Config';

export class ConfigurationService {
    private app: App;
    private configFolder: string;
    private cachedConfig: ConfigContent | null = null;
    private lastLoadTime: number = 0;
    private readonly CACHE_TTL = 30000; // 30 seconds cache

    constructor(app: App, configFolder?: string) {
        this.app = app;
        this.configFolder = configFolder || DEFAULT_CONFIG_FOLDER;
    }

    /**
     * Get the configuration folder path
     */
    getConfigFolder(): string {
        return this.configFolder;
    }

    /**
     * Set the configuration folder path
     */
    setConfigFolder(folder: string): void {
        this.configFolder = folder;
        this.cachedConfig = null; // Invalidate cache
    }

    /**
     * Get default file paths within the config folder
     */
    getConfigPaths(): ConfigPaths {
        return {
            taxonomyFile: normalizePath(`${this.configFolder}/taxonomy.md`),
            summaryPrompt: normalizePath(`${this.configFolder}/summary-prompt.md`),
            excludedTags: normalizePath(`${this.configFolder}/excluded-tags.md`),
            personas: normalizePath(`${this.configFolder}/personas.md`),
        };
    }

    /**
     * Load all configuration from files
     */
    async loadConfig(forceReload: boolean = false): Promise<ConfigContent> {
        const now = Date.now();

        // Return cached config if still valid
        if (!forceReload && this.cachedConfig && (now - this.lastLoadTime) < this.CACHE_TTL) {
            return this.cachedConfig;
        }

        const paths = this.getConfigPaths();

        const [taxonomy, summaryPrompt, excludedTags, personas] = await Promise.all([
            this.loadTaxonomyFromFile(paths.taxonomyFile),
            this.loadTextFromFile(paths.summaryPrompt),
            this.loadListFromFile(paths.excludedTags, []),
            this.loadPersonasFromFile(paths.personas),
        ]);

        this.cachedConfig = {
            taxonomy,
            summaryPromptTemplate: summaryPrompt,
            excludedTags,
            personas,
        };
        this.lastLoadTime = now;

        return this.cachedConfig;
    }

    /**
     * Load taxonomy from markdown file with table format
     */
    private async loadTaxonomyFromFile(path: string): Promise<Taxonomy> {
        const file = this.app.vault.getAbstractFileByPath(path);

        if (!file || !(file instanceof TFile)) {
            return DEFAULT_TAXONOMY;
        }

        try {
            const content = await this.app.vault.read(file);
            return this.parseTaxonomyContent(content);
        } catch {
            return DEFAULT_TAXONOMY;
        }
    }

    /**
     * Parse taxonomy from markdown content with tables
     * Supports markdown table format:
     * | Name | Description | Use When |
     * |------|-------------|----------|
     * | Technology | ... | ... |
     */
    private parseTaxonomyContent(content: string): Taxonomy {
        const themes: TaxonomyEntry[] = [];
        const disciplines: TaxonomyEntry[] = [];

        // Split into sections
        const sections = content.split(/^##\s+/m);

        for (const section of sections) {
            const lines = section.split('\n');
            const sectionTitle = lines[0]?.trim().toLowerCase() || '';

            // Determine which array to populate
            const targetArray = sectionTitle.includes('theme') ? themes :
                               sectionTitle.includes('discipline') ? disciplines : null;

            if (!targetArray) continue;

            // Find table rows (skip header and separator)
            let inTable = false;
            let headerPassed = false;

            for (const line of lines) {
                const trimmed = line.trim();

                // Detect table start
                if (trimmed.startsWith('|') && trimmed.includes('|')) {
                    inTable = true;

                    // Skip header row and separator row
                    if (trimmed.includes('---') || trimmed.toLowerCase().includes('name')) {
                        headerPassed = trimmed.includes('---');
                        continue;
                    }

                    if (!headerPassed) continue;

                    // Parse table row
                    const cells = trimmed.split('|')
                        .map(c => c.trim())
                        .filter(c => c.length > 0);

                    if (cells.length >= 3) {
                        targetArray.push({
                            name: cells[0],
                            description: cells[1],
                            useWhen: cells[2]
                        });
                    } else if (cells.length >= 1) {
                        // Minimal entry with just name
                        targetArray.push({
                            name: cells[0],
                            description: cells[1] || '',
                            useWhen: cells[2] || ''
                        });
                    }
                } else if (inTable && !trimmed.startsWith('|')) {
                    // End of table
                    inTable = false;
                    headerPassed = false;
                }
            }
        }

        // Fall back to defaults if nothing was parsed
        return {
            themes: themes.length > 0 ? themes : DEFAULT_TAXONOMY.themes,
            disciplines: disciplines.length > 0 ? disciplines : DEFAULT_TAXONOMY.disciplines
        };
    }

    /**
     * Load personas from markdown file
     */
    private async loadPersonasFromFile(path: string): Promise<Persona[]> {
        const file = this.app.vault.getAbstractFileByPath(path);

        if (!file || !(file instanceof TFile)) {
            return DEFAULT_PERSONAS;
        }

        try {
            const content = await this.app.vault.read(file);
            return this.parsePersonasContent(content);
        } catch {
            return DEFAULT_PERSONAS;
        }
    }

    /**
     * Parse personas from markdown content
     * Format: Each persona is a ### section with metadata and prompt in code block
     */
    private parsePersonasContent(content: string): Persona[] {
        const personas: Persona[] = [];

        // Split by ### headers (persona sections)
        const sections = content.split(/^###\s+/m);

        for (const section of sections) {
            if (!section.trim()) continue;

            const lines = section.split('\n');
            const firstLine = lines[0]?.trim() || '';

            // Skip if it's a higher-level header or empty
            if (!firstLine || firstLine.startsWith('#')) continue;

            // Extract persona name and check for (default) marker
            const isDefault = firstLine.toLowerCase().includes('(default)');
            const name = firstLine.replace(/\s*\(default\)\s*/i, '').trim();
            const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

            if (!id) continue;

            // Find description (first paragraph after name)
            let description = '';
            let prompt = '';

            // Look for description (text before code block)
            let inCodeBlock = false;
            let codeBlockLines: string[] = [];

            for (let i = 1; i < lines.length; i++) {
                const line = lines[i];

                if (line.trim().startsWith('```')) {
                    if (inCodeBlock) {
                        // End of code block
                        prompt = codeBlockLines.join('\n').trim();
                        break;
                    } else {
                        // Start of code block
                        inCodeBlock = true;
                        codeBlockLines = [];
                    }
                } else if (inCodeBlock) {
                    codeBlockLines.push(line);
                } else if (line.trim() && !description) {
                    // First non-empty line is description
                    description = line.trim().replace(/^>\s*/, ''); // Remove blockquote marker if present
                }
            }

            if (name && prompt) {
                personas.push({
                    id,
                    name,
                    description: description || `${name} persona`,
                    prompt,
                    isDefault
                });
            }
        }

        // Fall back to defaults if nothing parsed
        return personas.length > 0 ? personas : DEFAULT_PERSONAS;
    }

    /**
     * Load a list of items from a markdown file
     */
    private async loadListFromFile(path: string, defaultValues: string[]): Promise<string[]> {
        const file = this.app.vault.getAbstractFileByPath(path);

        if (!file || !(file instanceof TFile)) {
            return defaultValues;
        }

        try {
            const content = await this.app.vault.read(file);
            return this.parseListContent(content, defaultValues);
        } catch {
            return defaultValues;
        }
    }

    /**
     * Parse list content from markdown
     */
    private parseListContent(content: string, defaultValues: string[]): string[] {
        const lines = content.split('\n');
        const items: string[] = [];

        for (const line of lines) {
            const trimmed = line.trim();

            // Skip empty lines and markdown headers
            if (!trimmed || trimmed.startsWith('#')) {
                continue;
            }

            // Remove bullet points or numbers
            let cleaned = trimmed
                .replace(/^[-*]\s+/, '')      // Remove - or * bullets
                .replace(/^\d+\.\s+/, '')     // Remove numbered list
                .replace(/^>\s+/, '')         // Remove blockquotes
                .trim();

            // Handle comma-separated values in a single line
            if (cleaned.includes(',')) {
                const subItems = cleaned.split(',').map(s => s.trim()).filter(s => s);
                items.push(...subItems);
            } else if (cleaned) {
                items.push(cleaned);
            }
        }

        return items.length > 0 ? items : defaultValues;
    }

    /**
     * Load text content from a markdown file
     */
    private async loadTextFromFile(path: string): Promise<string | null> {
        const file = this.app.vault.getAbstractFileByPath(path);

        if (!file || !(file instanceof TFile)) {
            return null;
        }

        try {
            const content = await this.app.vault.read(file);
            // Remove YAML frontmatter if present
            const cleanedContent = content.replace(/^---[\s\S]*?---\n?/, '').trim();
            return cleanedContent || null;
        } catch {
            return null;
        }
    }

    /**
     * Ensure the config folder exists
     */
    async ensureConfigFolder(): Promise<void> {
        const folder = this.app.vault.getAbstractFileByPath(this.configFolder);

        if (!folder) {
            try {
                await this.app.vault.createFolder(this.configFolder);
            } catch {
                // Folder may already exist due to race condition or stale cache - safe to ignore
                console.debug(`[AI Organiser] Config folder "${this.configFolder}" already exists or could not be created`);
            }
        }
    }

    /**
     * Check if config files exist
     */
    async configFilesExist(): Promise<boolean> {
        const paths = this.getConfigPaths();
        const taxonomyFile = this.app.vault.getAbstractFileByPath(paths.taxonomyFile);
        return taxonomyFile !== null;
    }

    /**
     * Create default configuration files
     */
    async createDefaultConfigFiles(): Promise<void> {
        await this.ensureConfigFolder();
        const paths = this.getConfigPaths();

        // Create taxonomy file with table format
        const taxonomyContent = this.generateTaxonomyFileContent();

        // Create summary prompt file
        const summaryPromptContent = `# Summary Prompt

Customize how the AI summarizes web articles and PDFs.

---

## Instructions

Summarize the document content provided.

### Requirements
- Focus on the main thesis, key arguments, and conclusions
- Preserve important facts, statistics, and quotes
- Maintain objectivity - do not add opinions or interpretations
- Keep the summary clear and well-structured

### Style Guidelines
- Use clear, concise language
- Highlight key takeaways
- Preserve the original meaning and intent

---
*Note: Summary length (brief/detailed/comprehensive) is controlled in plugin settings.*
`;

        // Create excluded tags file
        const excludedTagsContent = `# Excluded Tags

Tags listed here will **never be suggested** by the AI when tagging your notes.

> **Note:** This is different from "Excluded Folders" in Settings, which controls which folders are skipped during batch tagging. This file controls which tag names the AI should never output.

## Excluded Tags List

- todo
- draft
- temp
- wip
- untitled

---
*Add tags you want to exclude, one per line or comma-separated.*
`;

        // Create personas file
        const personasContent = this.generatePersonasFileContent();

        // Create files if they don't exist
        await this.createFileIfNotExists(paths.taxonomyFile, taxonomyContent);
        await this.createFileIfNotExists(paths.summaryPrompt, summaryPromptContent);
        await this.createFileIfNotExists(paths.excludedTags, excludedTagsContent);
        await this.createFileIfNotExists(paths.personas, personasContent);

        // Invalidate cache after creating files
        this.cachedConfig = null;
    }

    /**
     * Generate the taxonomy.md file content
     */
    private generateTaxonomyFileContent(): string {
        const themesTable = DEFAULT_TAXONOMY.themes
            .map(t => `| ${t.name} | ${t.description} | ${t.useWhen} |`)
            .join('\n');

        const disciplinesTable = DEFAULT_TAXONOMY.disciplines
            .map(d => `| ${d.name} | ${d.description} | ${d.useWhen} |`)
            .join('\n');

        return `# Taxonomy

This file defines your tag taxonomy. The AI uses this to categorize your notes with a consistent structure.

## How It Works

The AI assigns tags in a **3-level hierarchy**:
1. **Theme** - The primary category from the Themes table below
2. **Discipline** - The academic/professional field from the Disciplines table
3. **Topics** - Specific concepts extracted from the content

## Themes

Top-level categories for organizing all your notes. Edit this table to customize your themes.

| Name | Description | Use When |
|------|-------------|----------|
${themesTable}

## Disciplines

Second-level tags representing academic or professional fields. These help bridge themes to specific topics.

| Name | Description | Use When |
|------|-------------|----------|
${disciplinesTable}

---

## Tips for Customization

1. **Add new themes**: Insert a new row with a unique name and clear description
2. **Remove unused themes**: Delete rows you don't need
3. **Be specific in "Use When"**: This helps the AI understand when to apply each tag
4. **Use kebab-case for disciplines**: e.g., \`data-science\` not \`Data Science\`

The AI reads the "Description" and "Use When" columns to understand how to apply each tag.
`;
    }

    /**
     * Generate the personas.md file content
     */
    private generatePersonasFileContent(): string {
        const personaSections = DEFAULT_PERSONAS.map(p => {
            const defaultMarker = p.isDefault ? ' (default)' : '';
            return `### ${p.name}${defaultMarker}

> ${p.description}

\`\`\`
${p.prompt}
\`\`\``;
        }).join('\n\n');

        return `# AI Personas

Personas control the **writing style and tone** the AI uses when creating or editing your notes. Select a persona when using AI commands to match your preferred note-taking style.

## How to Use

1. **In AI commands**: Click the persona button to change from the default
2. **Edit existing personas**: Modify the prompt in the code block below
3. **Add new personas**: Create a new \`### Section\` with a description and code block
4. **Set default**: Add \`(default)\` after the persona name

## Format

Each persona needs:
- A \`### Name\` header (add \`(default)\` to mark as default)
- A description line (shown in the selection menu)
- A code block with the prompt/instructions for the AI

---

${personaSections}

---

## Creating Custom Personas

To add your own persona, create a new section following the format above.
The AI will follow your custom instructions when processing content.
`;
    }

    /**
     * Create a file if it doesn't exist
     */
    private async createFileIfNotExists(path: string, content: string): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(path);

        if (!file) {
            try {
                await this.app.vault.create(path, content);
            } catch {
                // File may already exist due to race condition or stale cache - safe to ignore
                console.debug(`[AI Organiser] Config file "${path}" already exists or could not be created`);
            }
        }
    }

    /**
     * Get full taxonomy for tagging
     */
    async getTaxonomy(): Promise<Taxonomy> {
        const config = await this.loadConfig();
        return config.taxonomy;
    }

    /**
     * Get theme names only (for backward compatibility)
     */
    async getThemes(): Promise<string[]> {
        const config = await this.loadConfig();
        return config.taxonomy.themes.map(t => t.name);
    }

    /**
     * Get taxonomy formatted for AI prompt
     * Returns a string that can be inserted into the prompt
     */
    async getTaxonomyForPrompt(): Promise<string> {
        const config = await this.loadConfig();
        const { themes, disciplines } = config.taxonomy;

        let prompt = '<available_themes>\n';
        for (const theme of themes) {
            prompt += `- ${theme.name}: ${theme.description}`;
            if (theme.useWhen) {
                prompt += ` (Use when: ${theme.useWhen})`;
            }
            prompt += '\n';
        }
        prompt += '</available_themes>\n\n';

        prompt += '<available_disciplines>\n';
        for (const discipline of disciplines) {
            prompt += `- ${discipline.name}: ${discipline.description}`;
            if (discipline.useWhen) {
                prompt += ` (Use when: ${discipline.useWhen})`;
            }
            prompt += '\n';
        }
        prompt += '</available_disciplines>';

        return prompt;
    }

    /**
     * Get excluded tags
     */
    async getExcludedTags(): Promise<string[]> {
        const config = await this.loadConfig();
        return config.excludedTags;
    }

    /**
     * Get custom summary prompt template (if any)
     */
    async getSummaryPromptTemplate(): Promise<string | null> {
        const config = await this.loadConfig();
        return config.summaryPromptTemplate;
    }

    /**
     * Get all personas
     */
    async getPersonas(): Promise<Persona[]> {
        const config = await this.loadConfig();
        return config.personas;
    }

    /**
     * Get the default persona
     */
    async getDefaultPersona(): Promise<Persona> {
        const config = await this.loadConfig();
        const defaultPersona = config.personas.find(p => p.isDefault);
        return defaultPersona || config.personas[0] || DEFAULT_PERSONAS[0];
    }

    /**
     * Get a persona by ID
     */
    async getPersonaById(id: string): Promise<Persona | null> {
        const config = await this.loadConfig();
        return config.personas.find(p => p.id === id) || null;
    }

    /**
     * Get persona prompt formatted for injection into AI prompts
     */
    async getPersonaPrompt(personaId?: string): Promise<string> {
        let persona: Persona | null = null;

        if (personaId) {
            persona = await this.getPersonaById(personaId);
        }

        if (!persona) {
            persona = await this.getDefaultPersona();
        }

        return `<persona>
${persona.prompt}
</persona>`;
    }

    /**
     * Invalidate the configuration cache
     */
    invalidateCache(): void {
        this.cachedConfig = null;
        this.lastLoadTime = 0;
    }
}
