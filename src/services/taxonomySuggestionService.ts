/**
 * Taxonomy Suggestion Service
 * Analyzes vault folder structure (especially PARA areas) and uses AI
 * to suggest meaningful disciplines for the taxonomy
 */

import { App, TFolder, TFile } from 'obsidian';
import { logger } from '../utils/logger';
import { LLMService } from './types';

export interface FolderAnalysis {
    paraAreas: string[];      // Top-level PARA folders (Projects, Areas, Resources, Archive)
    subfolders: string[];     // Key subfolders that indicate disciplines/topics
    folderTree: string[];     // Full tree representation for AI context
    noteTitles: string[];     // Sample of note titles for additional context
    depth: number;            // Max folder depth analyzed
}

export interface SuggestedDiscipline {
    name: string;
    description: string;
    useWhen: string;
}

// Alias for themes - same structure
export type SuggestedTheme = SuggestedDiscipline;

/**
 * Represents a suggested change to an existing taxonomy item
 */
export interface TaxonomyChange {
    action: 'add' | 'modify' | 'remove';
    item: SuggestedDiscipline | SuggestedTheme;
    originalName?: string;  // For modify/remove - the original item name
    reason?: string;        // AI's reason for suggesting this change
}

export class TaxonomySuggestionService {
    constructor(
        private readonly app: App,
        private readonly llmService: LLMService
    ) {}

    /**
     * Check if a folder name matches PARA pattern
     */
    private isParaFolder(name: string): boolean {
        return /^(\d+\s+)?(Projects?|Areas?|Resources?|References?|Archives?|Inbox)/i.test(name);
    }

    /**
     * Analyze vault folder structure to understand the organization
     * Looks at PARA folders and 2 levels of subfolders below them
     */
    analyzeVaultStructure(): FolderAnalysis {
        const rootFolder = this.app.vault.getRoot();
        const allFolders = this.getAllFolders(rootFolder);

        // Identify PARA-style top-level folders
        const paraAreas = allFolders
            .filter(f => f.path.split('/').length === 1)
            .filter(f => this.isParaFolder(f.name))
            .map(f => f.name);

        // Collect meaningful subfolders
        const subfolders = this.collectSubfolders(allFolders, paraAreas);

        // Build a clean tree representation
        const treeLines = this.buildFolderTreeString(rootFolder, 0, 4, paraAreas);

        // Sample note titles from meaningful folders
        const noteTitles = this.sampleNoteTitles(allFolders, paraAreas);

        return {
            paraAreas,
            subfolders: Array.from(subfolders).sort((a, b) => a.localeCompare(b)),
            folderTree: treeLines,
            noteTitles,
            depth: 4
        };
    }

    /**
     * Sample note titles from meaningful folders to provide additional context
     * Returns up to 500 note titles, prioritizing PARA area subfolders
     */
    private sampleNoteTitles(allFolders: TFolder[], paraAreas: string[]): string[] {
        const titles: string[] = [];
        const maxTitles = 500;
        const maxPerFolder = 15; // Allow more titles per folder for richer context

        // Prioritize folders under PARA areas
        const priorityFolders = allFolders
            .filter(f => {
                const pathParts = f.path.split('/');
                // Skip root-level and utility folders
                if (pathParts.length < 2) return false;
                if (this.shouldSkipFolder(f.name)) return false;
                // Prioritize PARA subfolders
                return paraAreas.some(para => f.path.startsWith(para + '/'));
            })
            .slice(0, 50); // Check more folders for broader coverage

        // Also include some non-PARA folders for variety
        const otherFolders = allFolders
            .filter(f => {
                const pathParts = f.path.split('/');
                if (pathParts.length < 2) return false;
                if (this.shouldSkipFolder(f.name)) return false;
                return !paraAreas.some(para => f.path.startsWith(para + '/'));
            })
            .slice(0, 30);

        const foldersToSample = [...priorityFolders, ...otherFolders];

        for (const folder of foldersToSample) {
            if (titles.length >= maxTitles) break;

            // Get markdown files in this folder (not recursive)
            const mdFiles = folder.children
                .filter((child): child is TFile =>
                    child instanceof TFile && child.extension === 'md'
                )
                .slice(0, maxPerFolder);

            for (const file of mdFiles) {
                if (titles.length >= maxTitles) break;
                // Get title without .md extension
                const title = file.basename;
                // Skip very short or generic titles
                if (title.length > 3 && !this.isGenericTitle(title)) {
                    titles.push(title);
                }
            }
        }

        return titles;
    }

    /**
     * Check if a note title is too generic to be useful
     */
    private isGenericTitle(title: string): boolean {
        const genericPatterns = [
            /^untitled/i,
            /^note\s*\d*$/i,
            /^new\s*(note|file)/i,
            /^\d{4}-\d{2}-\d{2}$/, // Date-only titles
            /^index$/i,
            /^readme$/i,
            /^todo$/i,
            /^temp$/i,
        ];
        return genericPatterns.some(p => p.test(title));
    }

    /**
     * Collect meaningful subfolder names from the vault
     */
    private collectSubfolders(allFolders: TFolder[], paraAreas: string[]): Set<string> {
        const subfolders = new Set<string>();

        for (const folder of allFolders) {
            const pathParts = folder.path.split('/');

            // Skip hidden folders and config folders
            if (pathParts.some(p => p.startsWith('.') || p.toLowerCase().includes('ai-organiser'))) {
                continue;
            }

            const folderName = pathParts.at(-1) || '';
            if (this.shouldSkipFolder(folderName)) {
                continue;
            }

            // Check if this folder is under a PARA area
            const isUnderPara = paraAreas.some(para => folder.path.startsWith(para + '/'));

            // Collect folders at depth 2-4, or up to 5 if under PARA
            const maxDepth = isUnderPara ? 5 : 4;
            if (pathParts.length >= 2 && pathParts.length <= maxDepth) {
                subfolders.add(folderName);
            }
        }

        return subfolders;
    }

    /**
     * Check if folder name matches skip patterns
     */
    private shouldSkipFolder(folderName: string): boolean {
        const skipPatterns = [
            /^attachments?$/i,
            /^assets?$/i,
            /^images?$/i,
            /^templates?$/i,
            /^_/,
            /^\./,
            /^daily/i,
            /^weekly/i,
            /^monthly/i,
            /^inbox$/i,
            /^clippings?$/i,
            /^excalidraw$/i,
            /^readwise$/i,
            /^zotero/i,
        ];
        return skipPatterns.some(p => p.test(folderName));
    }

    /**
     * Build a hierarchical tree string representation of folders
     */
    private buildFolderTreeString(folder: TFolder, currentDepth: number, maxDepth: number, paraAreas: string[]): string[] {
        const lines: string[] = [];

        if (currentDepth > maxDepth) return lines;

        const children = folder.children
            .filter((child): child is TFolder => child instanceof TFolder)
            .filter(f => {
                const name = f.name;
                // Skip hidden and utility folders
                if (name.startsWith('.') || name.startsWith('_')) return false;
                if (/^(attachments?|assets?|templates?|excalidraw|clippings?)$/i.test(name)) return false;
                if (name.toLowerCase().includes('ai-organiser')) return false;
                return true;
            })
            .sort((a, b) => a.name.localeCompare(b.name));

        for (const child of children) {
            const indent = '  '.repeat(currentDepth);
            lines.push(`${indent}- ${child.name}`);

            // Go deeper for PARA areas
            const isParaArea = paraAreas.includes(child.name);
            const effectiveMaxDepth = isParaArea ? maxDepth + 1 : maxDepth;

            lines.push(...this.buildFolderTreeString(child, currentDepth + 1, effectiveMaxDepth, paraAreas));
        }

        return lines;
    }

    /**
     * Get all folders in the vault recursively
     */
    private getAllFolders(folder: TFolder): TFolder[] {
        const folders: TFolder[] = [];

        for (const child of folder.children) {
            if (child instanceof TFolder) {
                folders.push(child, ...this.getAllFolders(child));
            }
        }

        return folders;
    }

    /**
     * Build a prompt for the AI to suggest disciplines
     * @param analysis - The folder analysis result
     * @param userContext - Optional user-provided context about their focus areas
     * @param existingThemes - Optional existing themes to align disciplines with
     */
    buildSuggestionPrompt(analysis: FolderAnalysis, userContext?: string, existingThemes?: SuggestedTheme[]): string {
        // Use the tree structure for better context
        const folderTree = analysis.folderTree.slice(0, 100).join('\n');
        const noteTitles = analysis.noteTitles.slice(0, 500).join(', ');

        let prompt = `<task>
Analyze this Obsidian vault's folder structure and suggest 8-15 meaningful "disciplines" (academic/professional fields) that would help categorize notes in this vault.

Disciplines are the SECOND level of the tag hierarchy, sitting below Themes. They represent specific fields of study or professional domains.
</task>

<vault_structure>
PARA Areas found: ${analysis.paraAreas.join(', ') || 'None identified'}

Folder hierarchy (showing how content is organized):
${folderTree}
</vault_structure>`;

        // Add existing themes if available
        if (existingThemes && existingThemes.length > 0) {
            const themesList = existingThemes
                .map(t => `- ${t.name}: ${t.description} (Use when: ${t.useWhen})`)
                .join('\n');
            prompt += `

<existing_themes>
The user has these top-level THEMES. Disciplines should logically fit under one or more of these themes:
${themesList}
</existing_themes>`;
        }

        // Add note titles if available
        if (noteTitles) {
            prompt += `

<sample_note_titles>
These are sample note titles from the vault that indicate specific topics:
${noteTitles}
</sample_note_titles>`;
        }

        // Add user context if provided
        if (userContext?.trim()) {
            prompt += `

<user_context>
The user has provided this context about their focus areas and interests:
${userContext.trim()}
</user_context>`;
        }

        // Build requirements list dynamically
        const requirements = [
            '1. Suggest disciplines that are SPECIFIC to this vault\'s content based on the folder names and note titles',
            '2. Each discipline should represent an academic field, professional domain, or skill area',
            '3. Use kebab-case for names (e.g., "machine-learning" not "Machine Learning")',
            '4. Provide a clear description and "use when" guidance for each',
            '5. Focus on disciplines that would help distinguish between different types of notes',
            '6. Avoid overly broad disciplines like "technology" or "business" (those are themes, not disciplines)',
            '7. Look at the subfolder names AND note titles to understand what specific topics the user cares about'
        ];

        let reqNum = 8;
        if (existingThemes && existingThemes.length > 0) {
            requirements.push(`${reqNum}. Ensure each discipline logically relates to at least one of the existing themes`);
            reqNum++;
        }
        if (userContext) {
            requirements.push(`${reqNum}. Pay special attention to the user context to tailor suggestions to their needs`);
        }

        prompt += `

<requirements>
${requirements.join('\n')}
</requirements>

<output_format>
Return a JSON array with objects containing:
- name: kebab-case discipline name
- description: What this discipline covers (1 sentence)
- useWhen: When to apply this tag (1 sentence)

Example format:
[
  {"name": "product-management", "description": "Product development, roadmaps, and user research", "useWhen": "Content about building products, feature prioritization, or user needs"},
  {"name": "personal-finance", "description": "Budgeting, investing, and financial planning", "useWhen": "Notes about money management, investments, or financial goals"}
]

Return ONLY the JSON array, no other text or markdown formatting.
</output_format>`;

        return prompt;
    }

    /**
     * Use AI to suggest disciplines based on vault structure
     * @param userContext - Optional user-provided context about their focus areas
     * @param existingThemes - Optional existing themes to align disciplines with
     */
    async suggestDisciplines(userContext?: string, existingThemes?: SuggestedTheme[]): Promise<SuggestedDiscipline[]> {
        // Analyze vault structure
        const analysis = this.analyzeVaultStructure();

        if (analysis.subfolders.length === 0) {
            throw new Error('No meaningful folders found in vault to analyze');
        }

        // Build and send prompt
        const prompt = this.buildSuggestionPrompt(analysis, userContext, existingThemes);

        console.debug('[AI Organiser] Analyzing vault with folders:', analysis.subfolders.slice(0, 20));
        console.debug('[AI Organiser] Folder tree sample:', analysis.folderTree.slice(0, 30));
        console.debug('[AI Organiser] Sample note titles:', analysis.noteTitles.slice(0, 10));
        if (existingThemes) {
            console.debug('[AI Organiser] Aligning with themes:', existingThemes.map(t => t.name));
        }
        if (userContext) {
            console.debug('[AI Organiser] User context provided:', userContext.substring(0, 100));
        }

        const response = await this.llmService.generateTags(prompt);

        if (!response.success) {
            throw new Error(response.error || 'Failed to generate discipline suggestions');
        }

        // Check if we have any response content
        if (!response.rawResponse && (!response.tags || response.tags.length === 0)) {
            throw new Error('No content received from AI. Please check your LLM connection.');
        }

        console.debug('[AI Organiser] Raw response preview:', response.rawResponse?.substring(0, 300));

        // Parse the response - it may come as tags array or raw JSON
        const disciplines = this.parseAIResponse(response.tags || [], response.rawResponse);

        if (disciplines.length === 0) {
            // Provide more helpful error with response preview
            const preview = response.rawResponse?.substring(0, 200) || 'No response';
            throw new Error(`AI did not return valid discipline format. Response preview: ${preview}`);
        }

        console.debug('[AI Organiser] Parsed disciplines:', disciplines);
        return disciplines;
    }

    /**
     * Use AI to suggest ADDITIONAL disciplines to add to an existing list
     * @param existingDisciplines - Current disciplines to keep
     * @param userContext - User-provided context about what to add
     */
    async suggestAdditionalDisciplines(
        existingDisciplines: SuggestedDiscipline[],
        userContext: string
    ): Promise<SuggestedDiscipline[]> {
        const analysis = this.analyzeVaultStructure();

        const prompt = this.buildAddDisciplinesPrompt(analysis, existingDisciplines, userContext);

        console.debug('[AI Organiser] Adding disciplines with context:', userContext.substring(0, 100));
        console.debug('[AI Organiser] Existing disciplines:', existingDisciplines.map(d => d.name));

        const response = await this.llmService.generateTags(prompt);

        if (!response.success) {
            throw new Error(response.error || 'Failed to generate additional discipline suggestions');
        }

        if (!response.rawResponse && (!response.tags || response.tags.length === 0)) {
            throw new Error('No content received from AI. Please check your LLM connection.');
        }

        const newDisciplines = this.parseAIResponse(response.tags || [], response.rawResponse);

        console.debug('[AI Organiser] Parsed new disciplines:', newDisciplines);
        return newDisciplines;
    }

    /**
     * Build a prompt for adding disciplines to an existing list
     */
    private buildAddDisciplinesPrompt(
        analysis: FolderAnalysis,
        existingDisciplines: SuggestedDiscipline[],
        userContext: string
    ): string {
        const folderTree = analysis.folderTree.slice(0, 100).join('\n');
        const noteTitles = analysis.noteTitles.slice(0, 500).join(', ');

        const existingList = existingDisciplines
            .map(d => `- ${d.name}: ${d.description}`)
            .join('\n');

        return `<task>
The user has an existing list of disciplines and wants to ADD more disciplines based on their feedback. Suggest ONLY NEW disciplines that complement the existing list.
</task>

<existing_disciplines>
The user already has these disciplines (DO NOT duplicate these):
${existingList}
</existing_disciplines>

<user_request>
The user wants to add:
${userContext}
</user_request>

<vault_structure>
PARA Areas found: ${analysis.paraAreas.join(', ') || 'None identified'}

Folder hierarchy:
${folderTree}
</vault_structure>

${noteTitles ? `<sample_note_titles>
${noteTitles}
</sample_note_titles>` : ''}

<requirements>
1. Suggest ONLY NEW disciplines that don't already exist in the list
2. Focus specifically on what the user requested to add
3. Use optimal naming in kebab-case that fits well with the existing disciplines
4. Each discipline should represent an academic field, professional domain, or skill area
5. Provide clear descriptions and "use when" guidance
6. Suggest 1-5 new disciplines based on the user's request (don't over-add)
</requirements>

<output_format>
Return a JSON array with ONLY the NEW disciplines to add:
[
  {"name": "discipline-name", "description": "What this covers", "useWhen": "When to apply this tag"}
]

Return ONLY the JSON array, no other text.
</output_format>`;
    }

    /**
     * Parse AI response into discipline objects
     */
    private parseAIResponse(tags: string[], rawResponse?: string): SuggestedDiscipline[] {
        // First try to parse raw response if available
        if (rawResponse) {
            const parsed = this.tryParseJson(rawResponse);
            if (parsed.length > 0) return parsed;
        }

        // Try to parse from tags array
        if (tags.length > 0) {
            // Check if the first tag is actually JSON
            const firstTag = tags[0];
            if (firstTag.startsWith('[') || firstTag.startsWith('{')) {
                const parsed = this.tryParseJson(firstTag);
                if (parsed.length > 0) return parsed;
            }

            // Try joining all tags as they might be parts of JSON
            const joined = tags.join('');
            const parsed = this.tryParseJson(joined);
            if (parsed.length > 0) return parsed;

            // Fallback: convert simple tag strings to discipline objects
            return tags.slice(0, 15).map(tag => ({
                name: tag.toLowerCase().replace(/\s+/g, '-'),
                description: `Topics related to ${tag}`,
                useWhen: `Content about ${tag}`
            }));
        }

        return [];
    }

    /**
     * Try to parse JSON from a string, handling markdown code blocks
     */
    private tryParseJson(text: string): SuggestedDiscipline[] {
        if (!text) return [];

        // Remove markdown code blocks if present
        let cleaned = text.trim();
        cleaned = cleaned.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');

        // Find JSON array in the text
        const jsonMatch = /\[[\s\S]*\]/.exec(cleaned);
        if (!jsonMatch) return [];

        try {
            const parsed = JSON.parse(jsonMatch[0]);
            if (Array.isArray(parsed)) {
                return parsed
                    .filter(d => d?.name)
                    .map(d => ({
                        name: String(d.name || '').toLowerCase().replace(/\s+/g, '-'),
                        description: String(d.description || ''),
                        useWhen: String(d.useWhen || d.use_when || '')
                    }));
            }
        } catch {
            // Not valid JSON
        }

        return [];
    }

    /**
     * Format suggested disciplines as markdown table for taxonomy.md
     */
    formatAsMarkdownTable(disciplines: SuggestedDiscipline[]): string {
        const rows = disciplines.map(d =>
            `| ${d.name} | ${d.description} | ${d.useWhen} |`
        ).join('\n');

        return `| Name | Description | Use When |
|------|-------------|----------|
${rows}`;
    }

    // ==================== THEME SUGGESTION METHODS ====================

    /**
     * Use AI to suggest themes based on vault structure
     * @param userContext - Optional user-provided context about their focus areas
     */
    async suggestThemes(userContext?: string): Promise<SuggestedTheme[]> {
        const analysis = this.analyzeVaultStructure();

        if (analysis.subfolders.length === 0) {
            throw new Error('No meaningful folders found in vault to analyze');
        }

        const prompt = this.buildThemeSuggestionPrompt(analysis, userContext);

        console.debug('[AI Organiser] Suggesting themes with folders:', analysis.subfolders.slice(0, 20));

        const response = await this.llmService.generateTags(prompt);

        if (!response.success) {
            throw new Error(response.error || 'Failed to generate theme suggestions');
        }

        if (!response.rawResponse && (!response.tags || response.tags.length === 0)) {
            throw new Error('No content received from AI. Please check your LLM connection.');
        }

        const themes = this.parseAIResponse(response.tags || [], response.rawResponse);

        if (themes.length === 0) {
            const preview = response.rawResponse?.substring(0, 200) || 'No response';
            throw new Error(`AI did not return valid theme format. Response preview: ${preview}`);
        }

        // Themes use Title-Case, not kebab-case
        return themes.map(t => ({
            ...t,
            name: this.toTitleCase(t.name)
        }));
    }

    /**
     * Use AI to suggest ADDITIONAL themes to add to an existing list
     */
    async suggestAdditionalThemes(
        existingThemes: SuggestedTheme[],
        userContext: string
    ): Promise<SuggestedTheme[]> {
        const analysis = this.analyzeVaultStructure();
        const prompt = this.buildAddThemesPrompt(analysis, existingThemes, userContext);

        console.debug('[AI Organiser] Adding themes with context:', userContext.substring(0, 100));

        const response = await this.llmService.generateTags(prompt);

        if (!response.success) {
            throw new Error(response.error || 'Failed to generate additional theme suggestions');
        }

        if (!response.rawResponse && (!response.tags || response.tags.length === 0)) {
            throw new Error('No content received from AI. Please check your LLM connection.');
        }

        const newThemes = this.parseAIResponse(response.tags || [], response.rawResponse);

        return newThemes.map(t => ({
            ...t,
            name: this.toTitleCase(t.name)
        }));
    }

    /**
     * Build prompt for suggesting themes
     */
    private buildThemeSuggestionPrompt(analysis: FolderAnalysis, userContext?: string): string {
        const folderTree = analysis.folderTree.slice(0, 100).join('\n');
        const noteTitles = analysis.noteTitles.slice(0, 500).join(', ');

        let prompt = `<task>
Analyze this Obsidian vault's folder structure and suggest 8-12 meaningful "themes" (top-level categories) that would help organize notes in this vault.

Themes are BROAD categories that sit at the top of the tag hierarchy. Examples: Technology, Business, Personal-Development, Health, Creativity.
</task>

<vault_structure>
PARA Areas found: ${analysis.paraAreas.join(', ') || 'None identified'}

Folder hierarchy:
${folderTree}
</vault_structure>`;

        if (noteTitles) {
            prompt += `

<sample_note_titles>
${noteTitles}
</sample_note_titles>`;
        }

        if (userContext?.trim()) {
            prompt += `

<user_context>
${userContext.trim()}
</user_context>`;
        }

        prompt += `

<requirements>
1. Suggest broad themes that capture major areas of interest in this vault
2. Use Title-Case for names (e.g., "Personal-Development" not "personal-development")
3. Themes should be mutually exclusive - each note should fit primarily under one theme
4. Avoid overly specific themes (those are disciplines, not themes)
5. Provide clear "use when" guidance that helps the AI decide when to apply each theme
${userContext ? '6. Pay special attention to the user context' : ''}
</requirements>

<output_format>
Return a JSON array:
[
  {"name": "Theme-Name", "description": "What this theme covers", "useWhen": "When to apply this theme"}
]

Return ONLY the JSON array, no other text.
</output_format>`;

        return prompt;
    }

    /**
     * Build prompt for adding themes to existing list
     */
    private buildAddThemesPrompt(
        analysis: FolderAnalysis,
        existingThemes: SuggestedTheme[],
        userContext: string
    ): string {
        const folderTree = analysis.folderTree.slice(0, 100).join('\n');
        const existingList = existingThemes.map(t => `- ${t.name}: ${t.description}`).join('\n');

        return `<task>
The user has existing themes and wants to ADD more based on their feedback. Suggest ONLY NEW themes.
</task>

<existing_themes>
DO NOT duplicate these:
${existingList}
</existing_themes>

<user_request>
${userContext}
</user_request>

<vault_structure>
Folder hierarchy:
${folderTree}
</vault_structure>

<requirements>
1. Suggest ONLY NEW themes that complement the existing list
2. Use Title-Case for names
3. Focus on what the user requested
4. Suggest 1-4 new themes based on the request
</requirements>

<output_format>
Return a JSON array with ONLY the NEW themes:
[
  {"name": "Theme-Name", "description": "What this covers", "useWhen": "When to apply"}
]

Return ONLY the JSON array, no other text.
</output_format>`;
    }

    /**
     * Convert string to Title-Case
     */
    private toTitleCase(str: string): string {
        return str
            .replace(/[-_]/g, ' ')
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join('-');
    }

    // ==================== REVIEW & IMPROVE METHODS ====================

    /**
     * Review existing themes and suggest improvements (additions, modifications, removals)
     * Caps suggestions to incremental improvements rather than full rewrites
     * @param existingThemes - Current themes to review
     * @param userContext - Optional user-provided context
     */
    async reviewThemes(
        existingThemes: SuggestedTheme[],
        userContext?: string
    ): Promise<TaxonomyChange[]> {
        const analysis = this.analyzeVaultStructure();
        const prompt = this.buildThemeReviewPrompt(analysis, existingThemes, userContext);

        console.debug('[AI Organiser] Reviewing themes:', existingThemes.map(t => t.name));

        const response = await this.llmService.generateTags(prompt);

        if (!response.success) {
            throw new Error(response.error || 'Failed to review themes');
        }

        if (!response.rawResponse && (!response.tags || response.tags.length === 0)) {
            throw new Error('No content received from AI.');
        }

        const changes = this.parseReviewResponse(response.rawResponse);

        // Convert names to Title-Case for themes
        return changes.map(c => ({
            ...c,
            item: { ...c.item, name: this.toTitleCase(c.item.name) }
        }));
    }

    /**
     * Review existing disciplines and suggest improvements
     * @param existingDisciplines - Current disciplines to review
     * @param existingThemes - Current themes for alignment
     * @param userContext - Optional user-provided context
     */
    async reviewDisciplines(
        existingDisciplines: SuggestedDiscipline[],
        existingThemes?: SuggestedTheme[],
        userContext?: string
    ): Promise<TaxonomyChange[]> {
        const analysis = this.analyzeVaultStructure();
        const prompt = this.buildDisciplineReviewPrompt(analysis, existingDisciplines, existingThemes, userContext);

        console.debug('[AI Organiser] Reviewing disciplines:', existingDisciplines.map(d => d.name));

        const response = await this.llmService.generateTags(prompt);

        if (!response.success) {
            throw new Error(response.error || 'Failed to review disciplines');
        }

        if (!response.rawResponse && (!response.tags || response.tags.length === 0)) {
            throw new Error('No content received from AI.');
        }

        return this.parseReviewResponse(response.rawResponse);
    }

    /**
     * Build prompt for reviewing themes
     */
    private buildThemeReviewPrompt(
        analysis: FolderAnalysis,
        existingThemes: SuggestedTheme[],
        userContext?: string
    ): string {
        const folderTree = analysis.folderTree.slice(0, 80).join('\n');
        const noteTitles = analysis.noteTitles.slice(0, 300).join(', ');

        const existingList = existingThemes
            .map(t => `- ${t.name}: ${t.description} (Use when: ${t.useWhen})`)
            .join('\n');

        let prompt = `<task>
Review the user's existing THEMES and suggest INCREMENTAL improvements. This is NOT a rewrite - suggest only targeted changes.

Themes are broad, top-level categories. Suggest at most:
- 2-3 new themes to ADD (only if there's a clear gap)
- 1-2 themes to MODIFY (rename or improve description)
- 0-1 themes to REMOVE (only if clearly redundant or unused)
</task>

<existing_themes>
The user currently has these themes:
${existingList}
</existing_themes>

<vault_structure>
PARA Areas: ${analysis.paraAreas.join(', ') || 'None'}

Folder hierarchy:
${folderTree}
</vault_structure>`;

        if (noteTitles) {
            prompt += `

<sample_note_titles>
${noteTitles}
</sample_note_titles>`;
        }

        if (userContext?.trim()) {
            prompt += `

<user_context>
${userContext.trim()}
</user_context>`;
        }

        prompt += `

<requirements>
1. PRESERVE most existing themes - only suggest changes where clearly beneficial
2. Use Title-Case for theme names (e.g., "Personal-Development")
3. For MODIFY actions, include the original name so we know what to change
4. Only suggest REMOVE if a theme appears completely unused or redundant
5. Focus on gaps - what important areas are NOT covered by existing themes?
${userContext ? '6. Pay special attention to user context for targeted improvements' : ''}
</requirements>

<output_format>
Return a JSON array of changes:
[
  {"action": "add", "item": {"name": "Theme-Name", "description": "...", "useWhen": "..."}, "reason": "Why add this"},
  {"action": "modify", "originalName": "Old-Name", "item": {"name": "New-Name", "description": "...", "useWhen": "..."}, "reason": "Why change this"},
  {"action": "remove", "originalName": "Theme-To-Remove", "item": {"name": "Theme-To-Remove", "description": "", "useWhen": ""}, "reason": "Why remove this"}
]

If no changes needed, return an empty array: []
Return ONLY the JSON array, no other text.
</output_format>`;

        return prompt;
    }

    /**
     * Build prompt for reviewing disciplines
     */
    private buildDisciplineReviewPrompt(
        analysis: FolderAnalysis,
        existingDisciplines: SuggestedDiscipline[],
        existingThemes?: SuggestedTheme[],
        userContext?: string
    ): string {
        const folderTree = analysis.folderTree.slice(0, 80).join('\n');
        const noteTitles = analysis.noteTitles.slice(0, 300).join(', ');

        const existingList = existingDisciplines
            .map(d => `- ${d.name}: ${d.description} (Use when: ${d.useWhen})`)
            .join('\n');

        let prompt = `<task>
Review the user's existing DISCIPLINES and suggest INCREMENTAL improvements. This is NOT a rewrite - suggest only targeted changes.

Disciplines are specific fields/domains under themes. Suggest at most:
- 2-3 new disciplines to ADD (only if there's a clear gap)
- 1-2 disciplines to MODIFY (rename or improve description)
- 0-1 disciplines to REMOVE (only if clearly redundant or unused)
</task>

<existing_disciplines>
The user currently has these disciplines:
${existingList}
</existing_disciplines>`;

        if (existingThemes && existingThemes.length > 0) {
            const themesList = existingThemes.map(t => `- ${t.name}: ${t.description}`).join('\n');
            prompt += `

<themes_for_alignment>
Disciplines should align with these themes:
${themesList}
</themes_for_alignment>`;
        }

        prompt += `

<vault_structure>
PARA Areas: ${analysis.paraAreas.join(', ') || 'None'}

Folder hierarchy:
${folderTree}
</vault_structure>`;

        if (noteTitles) {
            prompt += `

<sample_note_titles>
${noteTitles}
</sample_note_titles>`;
        }

        if (userContext?.trim()) {
            prompt += `

<user_context>
${userContext.trim()}
</user_context>`;
        }

        prompt += `

<requirements>
1. PRESERVE most existing disciplines - only suggest changes where clearly beneficial
2. Use kebab-case for discipline names (e.g., "machine-learning")
3. For MODIFY actions, include the original name
4. Only suggest REMOVE if a discipline appears unused or is redundant with another
5. Focus on gaps - what specific fields are NOT covered?
${existingThemes ? '6. Ensure new disciplines align with existing themes' : ''}
${userContext ? `${existingThemes ? '7' : '6'}. Pay attention to user context for targeted improvements` : ''}
</requirements>

<output_format>
Return a JSON array of changes:
[
  {"action": "add", "item": {"name": "discipline-name", "description": "...", "useWhen": "..."}, "reason": "Why add"},
  {"action": "modify", "originalName": "old-name", "item": {"name": "new-name", "description": "...", "useWhen": "..."}, "reason": "Why change"},
  {"action": "remove", "originalName": "discipline-to-remove", "item": {"name": "discipline-to-remove", "description": "", "useWhen": ""}, "reason": "Why remove"}
]

If no changes needed, return an empty array: []
Return ONLY the JSON array, no other text.
</output_format>`;

        return prompt;
    }

    /**
     * Parse review response into TaxonomyChange array
     */
    private parseReviewResponse(rawResponse?: string): TaxonomyChange[] {
        if (!rawResponse) return [];

        // Remove markdown code blocks
        let cleaned = rawResponse.trim();
        cleaned = cleaned.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');

        // Find JSON array
        const jsonMatch = /\[[\s\S]*\]/.exec(cleaned);
        if (!jsonMatch) return [];

        try {
            const parsed = JSON.parse(jsonMatch[0]);
            if (!Array.isArray(parsed)) return [];

            return parsed
                .filter(c => c?.action && c?.item?.name)
                .map(c => ({
                    action: c.action as 'add' | 'modify' | 'remove',
                    item: {
                        name: String(c.item.name || ''),
                        description: String(c.item.description || ''),
                        useWhen: String(c.item.useWhen || c.item.use_when || '')
                    },
                    originalName: c.originalName ? String(c.originalName) : undefined,
                    reason: c.reason ? String(c.reason) : undefined
                }));
        } catch {
            logger.error('Tags', 'Failed to parse review response:', rawResponse.substring(0, 200));
            return [];
        }
    }
}
