/**
 * Configuration Service
 * Loads taxonomy and prompts from user-editable files in the vault
 * Falls back to defaults if files don't exist
 */

import { App, TFile, normalizePath } from 'obsidian';

export interface ConfigPaths {
    taxonomyFile: string;      // Main taxonomy with themes and disciplines
    excludedTags: string;      // Tags to never suggest
    writingPersonas: string;   // AI personas for note improvement/editing
    summaryPersonas: string;   // AI personas for summarization (URL, PDF, YouTube, Audio)
    basesTemplates: string;    // Bases dashboard templates
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
    icon?: string;        // Lucide icon name (optional)
}

export interface Taxonomy {
    themes: TaxonomyEntry[];
    disciplines: TaxonomyEntry[];
}

export interface BasesTemplate {
    name: string;              // Display name
    description: string;       // Short description
    fileName: string;          // Output filename (e.g., "Knowledge Base.base")
    category: 'default' | 'persona';  // Template category
    personaId?: string;        // For persona templates, links to summary persona
    icon?: string;             // Lucide icon name
    content: string;           // YAML content for .base file
}

export interface ConfigContent {
    taxonomy: Taxonomy;
    excludedTags: string[];
    personas: Persona[];           // For note improvement/editing
    summaryPersonas: Persona[];    // For summarization (URL, PDF, YouTube, Audio)
    basesTemplates: BasesTemplate[];  // Bases dashboard templates
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

// Default summary personas for summarization (URL, PDF, YouTube, Audio)
export const DEFAULT_SUMMARY_PERSONAS: Persona[] = [
    {
        id: 'student',
        name: 'Student',
        description: 'Academic study notes with hierarchical structure, analogies, and synthesis',
        icon: 'graduation-cap',
        prompt: `**Role:** Act as an expert academic analyst and master note-taker. Your goal is to convert raw information into a "Study-Ready" Executive Summary that prioritises rapid comprehension and retention.

**Core Philosophy:** Apply the Pyramid Principle. Place the conclusion and core truths at the very top (Bottom Line Up Front). Do not transcribe chronologically; synthesise hierarchically.

**Formatting Rules:**
1. **No Fluff:** Use active voice. Remove preamble. Keep sentences incisive.
2. **Scannability:** Use bolding for key terms. Use bullet points over paragraphs.
3. **Visuals:** Always use Tables for comparisons and Analogies for complex logic.
4. **Structure:** Strictly follow the four-part template below.

**The Output Template:**

### 1. The 30-Second Read
* **The Big Idea:** [A single sentence summary of the entire topic].
* **Key Takeaways:** [3-4 high-value bullet points. What must the reader remember?]

### 2. Core Terminology
* **[Term]:** [Simple, jargon-free definition].
* **[Term]:** [Simple, jargon-free definition].

### 3. The Deep Dive
*Group information by Concept, not by timeline. For every major concept, explain:*
* **The Logic:** What is it and how does it work?
* **The Evidence:** Key data or arguments.
* **The Analogy:** A real-world comparison (e.g., "Think of X like a car engine...").
* **The Comparison:** If two things are similar, create a Markdown table comparing them.

### 4. Synthesis
* **Mental Model:** How should the user visualise this system?
* **Connections:** How does this relate to broader fields or previous topics?`,
        isDefault: true
    },
    {
        id: 'executive',
        name: 'Executive',
        description: 'Business-focused briefing with ROI, risk analysis, and action items',
        icon: 'briefcase',
        prompt: `**Role:** Act as a Senior Strategy Consultant or Chief of Staff. Your goal is to synthesize raw information into a high-impact **Executive Briefing**.

**Target Audience:** A C-Level Executive (CEO, CTO, CFO). They have limited time, care about ROI/Risk, and need to make decisions, not study definitions.

**Tone & Style Guidelines:**
1. **Bottom Line Up Front (BLUF):** Start with the conclusion. Never bury the lead.
2. **Commercial, Not Academic:** Translate technical features into business outcomes (speed, cost, risk, revenue).
3. **Decisive:** Avoid wishy-washy language like "it depends." Highlight trade-offs clearly.
4. **High Signal-to-Noise:** Use active voice. Remove all filler words. Bullet points must be short and punchy.

**Strict Formatting Template:**

### 1. The Bottom Line (BLUF)
* **The Opportunity/Risk:** [1 sentence on the core value proposition or critical threat.]
* **Recommendation:** [1 sentence on the specific strategic action to take.]

### 2. Strategic Context
* **Why Now:** [What market shift, competitor move, or tech breakthrough makes this urgent?]
* **The Problem:** [The specific business friction or cost this solves.]

### 3. Critical Analysis (Business Impact)
* **Impact Area A (e.g., Efficiency/Cost):**
    * *Insight:* [Brief explanation of the mechanism.]
    * *Metric:* [Projected savings, speed increase, or revenue gain.]
* **Impact Area B (e.g., Risk/Compliance):**
    * *Insight:* [Brief explanation.]
    * *Metric:* [Cost of implementation vs. cost of inaction.]

### 4. The Decision Matrix (Comparison)
*Create a Markdown table comparing the options/technologies based on: Cost/Effort, Business Value, and Risk.*

### 5. Next Steps
* **Immediate Action:** [Who does what by when?]
* **Key Question:** [One strategic question the executive must ask to unblock progress.]`
    },
    {
        id: 'casual',
        name: 'Casual Reader',
        description: 'Fun, conversational summary with analogies and dinner party trivia',
        icon: 'coffee',
        prompt: `**Role:** Act as a popular science writer or a smart, witty friend. Your goal is to explain complex ideas in a way that is fun, memorable, and easy to read.

**Target Audience:** A casual reader who is curious but busy. They want to learn, but they get bored by dry textbooks or corporate jargon.

**Tone & Style Guidelines:**
1. **Conversational:** Write like you are talking to a friend over coffee. Use contractions ("it's" not "it is").
2. **Analogy-First:** Explain the *concept* using a real-world comparison before diving into the details.
3. **No Jargon:** If you must use a technical term, explain it immediately in plain English.
4. **Formatting:** Use emojis (sparingly) to break up text. Keep paragraphs short (2-3 sentences max).

**Strict Formatting Template:**

### 🥗 The TL;DR (Too Long; Didn't Read)
* **In a Nutshell:** [1-2 sentences summarising the whole idea simply.]
* **Why You Should Care:** [Why is this interesting or relevant to daily life?]

### 💡 The "Aha!" Moment (The Core Analogy)
*[Explain the main concept using a vivid metaphor. For example, "Think of a Neural Network like a guitar tuner..."]*

### 🔑 The 3 Key Takeaways
1. **[Point 1 Headline]:** [Explanation].
2. **[Point 2 Headline]:** [Explanation].
3. **[Point 3 Headline]:** [Explanation].

### 🧠 Dinner Party Trivia
*[One fascinating fact, stat, or insight from this text that makes the reader sound smart in conversation.]*`
    },
    {
        id: 'researcher',
        name: 'Researcher',
        description: 'Academic research notes with methodology, findings, and citations',
        icon: 'microscope',
        prompt: `**Role:** Act as a research assistant helping an academic researcher. Your goal is to extract and organise the scholarly value from the content.

**Target Audience:** A researcher who needs to understand methodology, evaluate evidence quality, and identify gaps for future work.

**Tone & Style Guidelines:**
1. **Precise:** Use exact terminology. Distinguish between claims, evidence, and speculation.
2. **Critical:** Note limitations, assumptions, and potential biases.
3. **Connective:** Identify how this relates to existing literature and research paradigms.
4. **Structured:** Follow academic conventions for presenting findings.

**Strict Formatting Template:**

### Abstract
*[2-3 sentences capturing the core contribution and significance.]*

### Key Findings
* **Finding 1:** [Statement] — *Evidence:* [Supporting data or argument]
* **Finding 2:** [Statement] — *Evidence:* [Supporting data or argument]
* **Finding 3:** [Statement] — *Evidence:* [Supporting data or argument]

### Methodology Notes
* **Approach:** [How was this investigated/built/tested?]
* **Data/Sample:** [What data or cases were examined?]
* **Limitations:** [What constraints or caveats apply?]

### Critical Assessment
* **Strengths:** [What makes this work valuable?]
* **Weaknesses:** [What limitations or gaps exist?]
* **Open Questions:** [What remains unanswered?]

### Research Connections
* **Builds On:** [Prior work this extends]
* **Contradicts/Challenges:** [Existing ideas this questions]
* **Future Directions:** [Suggested next steps for research]`
    },
    {
        id: 'technical',
        name: 'Technical',
        description: 'Developer-focused notes with implementation details and code patterns',
        icon: 'code',
        prompt: `**Role:** Act as a senior software architect documenting technical content. Your goal is to extract actionable technical knowledge.

**Target Audience:** A developer who needs to understand how something works, when to use it, and how to implement it.

**Tone & Style Guidelines:**
1. **Concrete:** Prefer specific examples over abstract descriptions.
2. **Practical:** Focus on "how to use" over "what it is."
3. **Comparative:** Show trade-offs between approaches.
4. **Code-Aware:** Use code blocks for any technical syntax or commands.

**Strict Formatting Template:**

### Quick Reference
* **What:** [One-line description of what this is]
* **When to Use:** [Specific use cases]
* **Key Benefit:** [Primary advantage]

### Core Concepts
| Concept | Description | Example |
|---------|-------------|---------|
| [Term] | [Definition] | [Concrete example] |

### Implementation Guide
* **Prerequisites:** [What you need before starting]
* **Basic Pattern:**
\`\`\`
[Code or pseudocode showing the pattern]
\`\`\`
* **Common Pitfalls:** [Mistakes to avoid]

### Architecture Decisions
* **Trade-offs:**
    * *Pro:* [Advantage]
    * *Con:* [Disadvantage]
* **Alternatives:** [Other approaches and when to prefer them]

### Quick Start Checklist
- [ ] [Step 1]
- [ ] [Step 2]
- [ ] [Step 3]`
    }
];

// Default Bases dashboard templates
// Note: Bases uses 'filters:' (plural) with and/or/not operators
// Property names use property.propname syntax for custom properties
// Folder filtering uses file.inFolder("path") - includes subfolders recursively
// Keep templates minimal - users can add more via config file
export const DEFAULT_BASES_TEMPLATES: BasesTemplate[] = [
    {
        name: 'Notes Dashboard',
        description: 'All AI-processed notes in this folder',
        fileName: 'Notes Dashboard.base',
        category: 'default',
        content: `---
name: Notes Dashboard
description: AI-processed notes with summaries and metadata
filters: 'property.aio_status == "processed"'
columns:
  - property.name
  - property.aio_summary
  - property.aio_persona
  - property.aio_type
  - property.tags
  - property.aio_processed`
    }
];

// Default folder for configuration files (within the main plugin folder)
export const DEFAULT_CONFIG_FOLDER = 'AI-Organiser/Config';

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
            excludedTags: normalizePath(`${this.configFolder}/excluded-tags.md`),
            writingPersonas: normalizePath(`${this.configFolder}/writing-personas.md`),
            summaryPersonas: normalizePath(`${this.configFolder}/summary-personas.md`),
            basesTemplates: normalizePath(`${this.configFolder}/bases-templates.md`),
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

        const [taxonomy, excludedTags, writingPersonas, summaryPersonas, basesTemplates] = await Promise.all([
            this.loadTaxonomyFromFile(paths.taxonomyFile),
            this.loadListFromFile(paths.excludedTags, []),
            this.loadPersonasFromFile(paths.writingPersonas, DEFAULT_PERSONAS),
            this.loadPersonasFromFile(paths.summaryPersonas, DEFAULT_SUMMARY_PERSONAS),
            this.loadBasesTemplatesFromFile(paths.basesTemplates),
        ]);

        this.cachedConfig = {
            taxonomy,
            excludedTags,
            personas: writingPersonas,
            summaryPersonas,
            basesTemplates,
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
    private async loadPersonasFromFile(path: string, defaults: Persona[]): Promise<Persona[]> {
        const file = this.app.vault.getAbstractFileByPath(path);

        if (!file || !(file instanceof TFile)) {
            return defaults;
        }

        try {
            const content = await this.app.vault.read(file);
            return this.parsePersonasContent(content, defaults);
        } catch {
            return defaults;
        }
    }

    /**
     * Parse personas from markdown content
     * Format: Each persona is a ### section with metadata and prompt in code block
     */
    private parsePersonasContent(content: string, defaults: Persona[]): Persona[] {
        const personas: Persona[] = [];

        // Split by ### headers (persona sections)
        const sections = content.split(/^###\s+/m);

        for (const section of sections) {
            if (!section.trim()) continue;

            const lines = section.split('\n');
            const firstLine = lines[0]?.trim() || '';

            // Skip if it's a higher-level header or empty
            if (!firstLine || firstLine.startsWith('#')) continue;

            // Extract persona name, check for (default) marker, and extract icon
            const isDefault = firstLine.toLowerCase().includes('(default)');

            // Extract icon if present: [icon: icon-name]
            const iconMatch = firstLine.match(/\[icon:\s*([^\]]+)\]/i);
            const icon = iconMatch ? iconMatch[1].trim() : undefined;

            // Remove (default) marker and [icon: ...] from name
            const name = firstLine
                .replace(/\s*\(default\)\s*/i, '')
                .replace(/\s*\[icon:\s*[^\]]+\]\s*/i, '')
                .trim();
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
                const persona: Persona = {
                    id,
                    name,
                    description: description || `${name} persona`,
                    prompt,
                    isDefault
                };
                if (icon) {
                    persona.icon = icon;
                }
                personas.push(persona);
            }
        }

        // Fall back to defaults if nothing parsed
        return personas.length > 0 ? personas : defaults;
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

        // Create summary personas file
        const summaryPersonasContent = this.generateSummaryPersonasFileContent();

        // Create bases templates file
        const basesTemplatesContent = this.generateBasesTemplatesFileContent();

        // Create files if they don't exist
        await this.createFileIfNotExists(paths.taxonomyFile, taxonomyContent);
        await this.createFileIfNotExists(paths.excludedTags, excludedTagsContent);
        await this.createFileIfNotExists(paths.writingPersonas, personasContent);
        await this.createFileIfNotExists(paths.summaryPersonas, summaryPersonasContent);
        await this.createFileIfNotExists(paths.basesTemplates, basesTemplatesContent);

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
     * Generate the writing-personas.md file content
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

        return `# Writing Personas

Personas control the **writing style and tone** the AI uses when improving or editing your notes. Select a persona when using the "Improve note with AI" command to match your preferred note-taking style.

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
     * Generate the summary-personas.md file content
     */
    private generateSummaryPersonasFileContent(): string {
        const personaSections = DEFAULT_SUMMARY_PERSONAS.map(p => {
            const defaultMarker = p.isDefault ? ' (default)' : '';
            const iconMarker = p.icon ? ` [icon: ${p.icon}]` : '';
            return `### ${p.name}${defaultMarker}${iconMarker}

> ${p.description}

\`\`\`
${p.prompt}
\`\`\``;
        }).join('\n\n');

        return `# Summary Personas

These personas control how the AI summarizes content from **URLs, PDFs, YouTube videos, and Audio files**. Each persona defines a different note-taking style with its own structure and tone.

## How to Use

1. **When summarizing**: Select a persona from the dropdown in the summarization dialog
2. **Set default**: Add \`(default)\` after the persona name to make it the default
3. **Edit existing**: Modify the prompt in the code block to customize behavior
4. **Add new**: Create a new \`### Section\` following the format below

## Format

Each persona needs:
- A \`### Name\` header (add \`(default)\` to mark as default, optionally \`[icon: icon-name]\` for icon)
- A description line starting with \`>\` (shown in the selection dropdown)
- A code block with the full prompt/instructions for the AI

---

${personaSections}

---

## Tips for Custom Personas

- **Role**: Start by defining who the AI should act as
- **Target Audience**: Specify who will read the notes
- **Style Guidelines**: List formatting rules and tone
- **Output Template**: Provide a structure with markdown headers

The AI will follow your template exactly, so be specific about what sections and formatting you want.
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

    // ==========================================
    // Summary Personas (for URL, PDF, YouTube, Audio)
    // ==========================================

    /**
     * Get all summary personas
     */
    async getSummaryPersonas(): Promise<Persona[]> {
        const config = await this.loadConfig();
        return config.summaryPersonas;
    }

    /**
     * Get the default summary persona
     */
    async getDefaultSummaryPersona(): Promise<Persona> {
        const config = await this.loadConfig();
        const defaultPersona = config.summaryPersonas.find(p => p.isDefault);
        return defaultPersona || config.summaryPersonas[0] || DEFAULT_SUMMARY_PERSONAS[0];
    }

    /**
     * Get a summary persona by ID
     */
    async getSummaryPersonaById(id: string): Promise<Persona | null> {
        const config = await this.loadConfig();
        return config.summaryPersonas.find(p => p.id === id) || null;
    }

    /**
     * Get summary persona prompt formatted for injection into AI prompts
     */
    async getSummaryPersonaPrompt(personaId?: string): Promise<string> {
        let persona: Persona | null = null;

        if (personaId) {
            persona = await this.getSummaryPersonaById(personaId);
        }

        if (!persona) {
            persona = await this.getDefaultSummaryPersona();
        }

        return persona.prompt;
    }

    /**
     * Open a config file in the editor
     */
    async openConfigFile(fileType: keyof ConfigPaths): Promise<void> {
        const paths = this.getConfigPaths();
        const path = paths[fileType];

        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
            await this.app.workspace.openLinkText(path, '', false);
        }
    }

    // ==========================================
    // Bases Templates
    // ==========================================

    /**
     * Load bases templates from markdown file
     */
    private async loadBasesTemplatesFromFile(path: string): Promise<BasesTemplate[]> {
        const file = this.app.vault.getAbstractFileByPath(path);

        if (!file || !(file instanceof TFile)) {
            return DEFAULT_BASES_TEMPLATES;
        }

        try {
            const content = await this.app.vault.read(file);
            return this.parseBasesTemplatesContent(content);
        } catch {
            return DEFAULT_BASES_TEMPLATES;
        }
    }

    /**
     * Parse bases templates from markdown content
     * Format: Each template is a ### section with metadata and YAML content in code block
     *
     * ### Template Name [category: default|persona] [persona: id] [icon: icon-name]
     * > Description text
     * **File:** filename.base
     * ```yaml
     * YAML content here
     * ```
     */
    private parseBasesTemplatesContent(content: string): BasesTemplate[] {
        const templates: BasesTemplate[] = [];

        // Split by ### headers (template sections)
        const sections = content.split(/^###\s+/m);

        for (const section of sections) {
            if (!section.trim()) continue;

            const lines = section.split('\n');
            const firstLine = lines[0]?.trim() || '';

            // Skip if it's a higher-level header or empty
            if (!firstLine || firstLine.startsWith('#')) continue;

            // Extract metadata from header line
            // Format: Template Name [category: default|persona] [persona: id] [icon: icon-name]
            const categoryMatch = firstLine.match(/\[category:\s*([^\]]+)\]/i);
            const personaMatch = firstLine.match(/\[persona:\s*([^\]]+)\]/i);
            const iconMatch = firstLine.match(/\[icon:\s*([^\]]+)\]/i);

            const category = (categoryMatch?.[1]?.trim().toLowerCase() === 'persona' ? 'persona' : 'default') as 'default' | 'persona';
            const personaId = personaMatch?.[1]?.trim();
            const icon = iconMatch?.[1]?.trim();

            // Remove metadata markers from name
            const name = firstLine
                .replace(/\s*\[category:\s*[^\]]+\]\s*/gi, '')
                .replace(/\s*\[persona:\s*[^\]]+\]\s*/gi, '')
                .replace(/\s*\[icon:\s*[^\]]+\]\s*/gi, '')
                .trim();

            if (!name) continue;

            // Find description, filename, and YAML content
            let description = '';
            let fileName = `${name}.base`;
            let yamlContent = '';

            let inCodeBlock = false;
            let codeBlockLines: string[] = [];

            for (let i = 1; i < lines.length; i++) {
                const line = lines[i];
                const trimmed = line.trim();

                if (trimmed.startsWith('```')) {
                    if (inCodeBlock) {
                        // End of code block
                        yamlContent = codeBlockLines.join('\n').trim();
                        break;
                    } else {
                        // Start of code block
                        inCodeBlock = true;
                        codeBlockLines = [];
                    }
                } else if (inCodeBlock) {
                    codeBlockLines.push(line);
                } else if (trimmed.startsWith('>')) {
                    // Description line
                    description = trimmed.replace(/^>\s*/, '').trim();
                } else if (trimmed.toLowerCase().startsWith('**file:**')) {
                    // Filename line
                    fileName = trimmed.replace(/^\*\*file:\*\*\s*/i, '').trim();
                    if (!fileName.endsWith('.base')) {
                        fileName += '.base';
                    }
                }
            }

            if (name && yamlContent) {
                const template: BasesTemplate = {
                    name,
                    description: description || `${name} dashboard template`,
                    fileName,
                    category,
                    content: yamlContent
                };
                if (personaId) {
                    template.personaId = personaId;
                }
                if (icon) {
                    template.icon = icon;
                }
                templates.push(template);
            }
        }

        // Fall back to defaults if nothing parsed
        return templates.length > 0 ? templates : DEFAULT_BASES_TEMPLATES;
    }

    /**
     * Generate the bases-templates.md file content
     */
    private generateBasesTemplatesFileContent(): string {
        const templateSections = DEFAULT_BASES_TEMPLATES.map(t => {
            const categoryMarker = ` [category: ${t.category}]`;
            const personaMarker = t.personaId ? ` [persona: ${t.personaId}]` : '';
            const iconMarker = t.icon ? ` [icon: ${t.icon}]` : '';

            return `### ${t.name}${categoryMarker}${personaMarker}${iconMarker}

> ${t.description}

**File:** ${t.fileName}

\`\`\`yaml
${t.content}
\`\`\``;
        }).join('\n\n');

        return `# Bases Dashboard Templates

These templates define the structure for **Obsidian Bases dashboards** that display your AI-processed notes. Create dashboards by right-clicking a folder and selecting "Create Bases Dashboard".

## How to Use

1. **Create dashboards**: Right-click a folder → "Create Bases Dashboard"
2. **Edit existing templates**: Modify the YAML in the code blocks below
3. **Add new templates**: Create a new \`### Section\` following the format
4. **Remove templates**: Delete the entire section

## Format

Each template needs:
- A \`### Name\` header with metadata markers:
  - \`[category: default|persona]\` - Template category
  - \`[persona: id]\` - For persona templates, links to summary persona
  - \`[icon: icon-name]\` - Lucide icon name (optional)
- A description line starting with \`>\`
- A \`**File:**\` line specifying the output filename
- A \`\`\`yaml code block with the Bases configuration

## Template Categories

- **default**: General-purpose dashboards (Knowledge Base, Research Tracker, etc.)
- **persona**: Dashboards filtered by summarization persona (Student, Executive, etc.)

---

${templateSections}

---

## Creating Custom Templates

To add your own template, create a new section following the format above.
The YAML content follows Obsidian Bases format with filters, columns, sorting, and grouping.

### Available Fields

- \`name\` - Note file name
- \`tags\` - Note tags
- \`created\` - Creation date
- \`{aio_summary}\` - AI-generated summary
- \`{aio_status}\` - Processing status (pending/processed/error)
- \`{aio_type}\` - Content type (note/research/meeting/project/reference)
- \`{aio_processed}\` - Processing timestamp
- \`{aio_source}\` - Source type (url/pdf/youtube/audio)
- \`{aio_source_url}\` - Original source URL
- \`{aio_persona}\` - Summary persona used
- \`{aio_model}\` - AI model used

### Filter Operators

- \`exists\` - Field has any value
- \`equals\` - Field equals specific value
- \`contains\` - Field contains substring
`;
    }

    /**
     * Get all bases templates
     */
    async getBasesTemplates(): Promise<BasesTemplate[]> {
        const config = await this.loadConfig();
        return config.basesTemplates;
    }

    /**
     * Get bases templates by category
     */
    async getBasesTemplatesByCategory(category: 'default' | 'persona'): Promise<BasesTemplate[]> {
        const config = await this.loadConfig();
        return config.basesTemplates.filter(t => t.category === category);
    }

    /**
     * Get a bases template by name
     */
    async getBasesTemplateByName(name: string): Promise<BasesTemplate | null> {
        const config = await this.loadConfig();
        return config.basesTemplates.find(t => t.name === name) || null;
    }
}
