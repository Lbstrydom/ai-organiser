/**
 * Task types — the canonical set of LLM-driven task categories used by the
 * model catalog and Azure settings validation. Kept neutral (no Obsidian /
 * service imports) so it can be consumed from anywhere.
 */

export type TaskType =
    | 'tagging'
    | 'summarization'
    | 'audit'
    | 'research'
    | 'chat'
    | 'mermaid'
    | 'embeddings'
    | 'transcription';

export const ALL_TASK_TYPES: TaskType[] = [
    'tagging',
    'summarization',
    'audit',
    'research',
    'chat',
    'mermaid',
    'embeddings',
    'transcription',
];
