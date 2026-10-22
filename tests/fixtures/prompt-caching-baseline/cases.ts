/**
 * Input matrices for the prompt-caching byte-identity tests.
 *
 * `baseline.json` holds the prompts these inputs rendered to BEFORE the
 * prompt-caching rollout (captured at main 9bafff6, whose prompt builders are
 * byte-identical to 97c5e55). The tests compare the post-rollout builders —
 * both the legacy wrappers and `joinPromptParts(buildXParts(...))` — against
 * that file, so the oracle is independent of the code under test.
 */
import type { SummaryPromptOptions } from '../../../src/services/prompts/summaryPrompts';
import type { FolderContext } from '../../../src/utils/folderContextUtils';

const TAXONOMY_DEFAULT = `<available_themes>
Technology, Strategy, Business, Science, Personal-Development
</available_themes>

<available_disciplines>
Use your judgment to select an appropriate discipline based on the content.
Common disciplines include: computer-science, mathematics, marketing, economics, psychology, design, project-management, data-science
</available_disciplines>`;

const TAXONOMY_CUSTOM = `<available_themes>
Health, Finance, Travel
</available_themes>

<available_disciplines>
nutrition, investing, trip-planning
</available_disciplines>`;

const FOLDER_CONTEXT: FolderContext = {
    rootPath: 'Projects/Alpha',
    subfolders: ['Projects/Alpha/Notes', 'Projects/Alpha/Meetings'],
    existingTags: ['alpha', 'planning'],
    noteCount: 12,
};

export interface TagCase {
    content: string;
    taxonomyPrompt: string;
    maxTags: number;
    language?: 'en' | 'fr' | 'default';
    folderContext?: FolderContext;
}

export const TAG_CASES: Record<string, TagCase> = {
    'default-5': { content: 'Note about neural networks and backprop.', taxonomyPrompt: TAXONOMY_DEFAULT, maxTags: 5 },
    'default-3': { content: 'Short note.', taxonomyPrompt: TAXONOMY_DEFAULT, maxTags: 3 },
    'default-10-lang': { content: 'Une note sur la cuisine.', taxonomyPrompt: TAXONOMY_DEFAULT, maxTags: 10, language: 'fr' },
    'custom-5': { content: 'Budget and savings plan.', taxonomyPrompt: TAXONOMY_CUSTOM, maxTags: 5 },
    'folder-5': { content: 'Meeting notes for the alpha launch.', taxonomyPrompt: TAXONOMY_DEFAULT, maxTags: 5, folderContext: FOLDER_CONTEXT },
    'folder-lang-7': { content: 'Plan.', taxonomyPrompt: TAXONOMY_CUSTOM, maxTags: 7, language: 'fr', folderContext: FOLDER_CONTEXT },
};

/** Legacy `buildTagPrompt` (candidate-tag list) cases. */
export const TAG_LEGACY_CASES: Record<string, { content: string; candidateTags: string[]; maxTags: number; language?: 'en' | 'fr' | 'default' }> = {
    'candidates-5': { content: 'Quantum computing primer.', candidateTags: ['physics', 'computing', 'math'], maxTags: 5 },
    'no-candidates-3-lang': { content: 'Quantum computing primer.', candidateTags: [], maxTags: 3, language: 'fr' },
};

export interface SummaryCase {
    options: SummaryPromptOptions;
    content: string;
}

const PERSONA = '<persona>\nYou are a meticulous study assistant. Produce structured summaries with headings.\n</persona>';

export const SUMMARY_CASES: Record<string, SummaryCase> = {
    'persona-brief': { options: { length: 'brief', personaPrompt: PERSONA }, content: 'Chunk text alpha.' },
    'persona-detailed-lang-ctx': { options: { length: 'detailed', language: 'French', personaPrompt: PERSONA, userContext: 'Focus on risks' }, content: 'Chunk text beta.' },
    'persona-companion': { options: { length: 'standard', personaPrompt: PERSONA, includeCompanion: true }, content: 'Chunk text gamma.' },
    'persona-chunk-2-of-5': { options: { length: 'detailed', language: 'English', personaPrompt: PERSONA, userContext: 'Focus\n\nPrevious context: earlier part covered setup', chunkIndex: 2, chunkTotal: 5 }, content: 'Chunk text delta.' },
    'basic-standard': { options: { length: 'standard' }, content: 'Chunk text epsilon.' },
    'basic-lang-ctx-chunk': { options: { length: 'brief', language: 'German', userContext: 'Key numbers', chunkIndex: 1, chunkTotal: 3 }, content: 'Chunk text zeta.' },
};

export const IR_LANGUAGES: Array<string | undefined> = [undefined, 'French'];
export const IR_REFINE_REQUESTS = ['Make the title shorter', 'Add a closing slide with next steps'];
export const IR_SELECTIONS = [
    { slideIndex: 1, instruction: 'Tighten the wording' },
    { slideIndex: 2, instruction: '' },
];
