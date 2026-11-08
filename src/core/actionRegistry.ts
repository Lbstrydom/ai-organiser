/**
 * The action registry: one entry per public command (docs/plans/navigation-discoverability.md,
 * decision 1). Every surface that names or lists a command reads it from here: the command
 * palette (`actionName`), the picker (`buildCommandCategories`) and, later, the menus.
 *
 * Pure data. It imports types only and nothing from `src/commands/`, so a command module can
 * read its own name from here without a cycle. Every registered command id is either an action
 * here or listed in `HIDDEN_COMMANDS`; `tests/actionRegistry.test.ts` fails on any other.
 *
 * Generated once from the Phase 1 picker tree; edit it by hand from now on. The picker groups
 * those leaves into sections by `kind` and orders All actions by `stage`.
 */
import type { Translations } from '../i18n/types';
import type { FeatureId } from './features';
import type { WorkflowStage } from './workflowStages';
import type { ActionTargetKind } from './actionTarget';
import type { ContextRole } from './contextResolver';

/** Render-time precondition for an action — drives the picker's requirement chip. */
export type RequirementKind =
    | 'none'             // always available
    | 'active-note'      // requires an open .md file
    | 'selection'        // requires a non-empty editor selection
    | 'vault'            // requires ≥1 .md file in the vault
    | 'semantic-search'  // requires enableSemanticSearch + vectorStore
    | 'mp3-file';        // requires an active .mp3 (Play narration's own checkCallback)

type Commands = Translations['commands'];
/** Keys of `t.commands` whose value is a string: the only valid action labels. */
export type CommandLabelKey = { [K in keyof Commands]-?: Commands[K] extends string ? K : never }[keyof Commands];
export type ActionDescKey = keyof Translations['modals']['commandPicker']['descriptions'];

/** daily = ordinary work; setup = a "Set up …" flow; tool = plumbing and index tooling. */
export type ActionKind = 'daily' | 'setup' | 'tool';

export interface ActionDef {
    /** The command id without the `ai-organiser:` prefix. */
    readonly id: string;
    /** Owning feature: the action exists only while it is on (see anyOfFeatures / alsoRequiresFeatures). */
    readonly feature: FeatureId;
    readonly stage: WorkflowStage;
    readonly kind: ActionKind;
    /** The one label, on every surface. */
    readonly labelKey: CommandLabelKey;
    readonly descKey: ActionDescKey;
    readonly descFallback: string;
    readonly icon: string;
    readonly requires: RequirementKind;
    readonly synonyms?: readonly string[];
    /** Other `t.commands` labels that should also find this action. */
    readonly synonymKeys?: readonly CommandLabelKey[];
    /** Old taxonomy homes, kept searchable (see `legacyHomeAliases`). */
    readonly legacyHomes?: readonly string[];
    /** 'desktop' when the command exists or works only in the desktop app. */
    readonly platform?: 'desktop';
    /** Shown when ANY of these is on; `feature` stays the canonical owner. */
    readonly anyOfFeatures?: readonly FeatureId[];
    /** Features that must ALSO be on, beyond `feature`. */
    readonly alsoRequiresFeatures?: readonly FeatureId[];
    /** Roles this action suits (src/core/contextResolver.ts), for "For this context" and the
     *  right-click section. Absent = never suggested for a context. */
    readonly contexts?: readonly ContextRole[];
    /** Target kinds the action accepts. Absent = only the active context (palette behaviour). */
    readonly targets?: readonly ActionTargetKind[];
    /** Search-dedup chip for a default Pinned cross-listing. */
    readonly canonicalCategoryId?: 'pinned';
}

/** The default Pinned leaves when the user has chosen none. */
export const DEFAULT_PINNED: readonly string[] = Object.freeze(['chat-with-ai', 'semantic-search', 'quick-peek']);

/** Every public command. All actions lists them by stage (WORKFLOW_STAGES order), then in this order. */
export const ACTIONS: readonly ActionDef[] = Object.freeze([
    { id: 'research-web', feature: 'research', stage: 'capture', kind: 'daily', labelKey: 'researchWeb', descKey: 'researchWeb', descFallback: 'Web research with citations', icon: 'globe', requires: 'none', synonyms: ['research', 'web', 'citations'], legacyHomes: ['capture'] },
    { id: 'refresh-cloud-inventories', feature: 'cloud-inventory', stage: 'capture', kind: 'daily', labelKey: 'refreshCloudInventories', descKey: 'refreshCloudInventories', descFallback: 'Update the Drive file lists in your hub notes', icon: 'refresh-cw', requires: 'vault', synonyms: ['drive', 'google', 'inventory', 'refresh'] },
    { id: 'check-cloud-inventories', feature: 'cloud-inventory', stage: 'capture', kind: 'daily', labelKey: 'checkCloudInventories', descKey: 'checkCloudInventories', descFallback: 'See which Drive folders changed without writing anything', icon: 'list-checks', requires: 'vault', synonyms: ['drive', 'google', 'inventory', 'check'] },
    { id: 'setup-cloud-inventory', feature: 'cloud-inventory', stage: 'capture', kind: 'setup', labelKey: 'setupCloudInventory', descKey: 'setupCloudInventory', descFallback: 'Pair a Drive folder with a vault folder step by step', icon: 'cloud', requires: 'vault', synonyms: ['drive', 'google', 'inventory', 'setup', 'pair'] },
    { id: 'web-reader', feature: 'web-reader', stage: 'capture', kind: 'daily', labelKey: 'webReader', descKey: 'webReader', descFallback: 'Triage web URLs in the active note', icon: 'newspaper', requires: 'active-note', synonyms: ['web', 'reader', 'triage', 'article'], legacyHomes: ['capture'] },
    { id: 'kindle-sync', feature: 'kindle', stage: 'capture', kind: 'daily', labelKey: 'kindleSync', descKey: 'kindleSync', descFallback: 'Sync Kindle highlights into the vault', icon: 'book-open', requires: 'none', synonyms: ['kindle', 'sync', 'highlights'], legacyHomes: ['capture'] },
    { id: 'newsletter-fetch', feature: 'newsletter', stage: 'capture', kind: 'daily', labelKey: 'newsletterFetch', descKey: 'newsletter', descFallback: 'Fetch newsletters from Gmail and triage them', icon: 'mail', requires: 'none', synonyms: ['newsletter', 'digest', 'fetch', 'recurring'], legacyHomes: ['capture'] },
    { id: 'newsletter-audio', feature: 'newsletter', stage: 'capture', kind: 'daily', labelKey: 'newsletterAudio', descKey: 'newsletterAudio', descFallback: 'Make one audio that catches you up on the days you missed', icon: 'headphones', requires: 'none', synonyms: ['newsletter', 'audio', 'podcast', 'catch up', 'catch-up', 'listen', 'missed'] },
    { id: 'newsletter-mark-caught-up', feature: 'newsletter', stage: 'capture', kind: 'daily', labelKey: 'newsletterMarkCaughtUp', descKey: 'newsletterMarkCaughtUp', descFallback: 'Tell the daily brief you are up to date on earlier stories', icon: 'check-check', requires: 'none', synonyms: ['newsletter', 'caught up', 'listened', 'read', 'catch up'], legacyHomes: ['capture'] },
    { id: 'newsletter-mark-brief-read', feature: 'newsletter', stage: 'capture', kind: 'daily', labelKey: 'newsletterMarkBriefRead', descKey: 'newsletterMarkBriefRead', descFallback: 'Tell the daily brief you read this day\'s brief', icon: 'book-open-check', requires: 'active-note', synonyms: ['newsletter', 'read', 'brief', 'seen', 'digest'] },
    { id: 'newsletter-mark-catchup-listened', feature: 'newsletter', stage: 'capture', kind: 'daily', labelKey: 'newsletterMarkCatchUpListened', descKey: 'newsletterMarkCatchUpListened', descFallback: 'Mark the catch-up episode in this note as listened', icon: 'check-circle-2', requires: 'active-note', synonyms: ['newsletter', 'listened', 'episode', 'heard'] },
    { id: 'newsletter-regenerate-audio', feature: 'newsletter', stage: 'capture', kind: 'daily', labelKey: 'newsletterRegenerateAudio', descKey: 'newsletterRegenerateAudio', descFallback: 'Re-run text-to-speech on today\'s existing daily brief', icon: 'refresh-cw', requires: 'none', synonyms: ['newsletter', 'audio', 'regenerate', 'podcast'] },
    { id: 'record-audio', feature: 'summarize', stage: 'capture', kind: 'daily', labelKey: 'recordAudio', descKey: 'recordAudio', descFallback: 'Record audio directly in Obsidian', icon: 'mic', requires: 'none', synonyms: ['record', 'voice', 'dictate', 'audio', 'microphone'], legacyHomes: ['capture'] },
    { id: 'insert-onedrive-link', feature: 'onedrive-link', stage: 'capture', kind: 'daily', labelKey: 'insertOneDriveLink', descKey: 'insertOneDriveLink', descFallback: 'Insert a link to a file in your local OneDrive folder', icon: 'link', requires: 'active-note', synonyms: ['onedrive', 'link', 'file'], platform: 'desktop' },
    { id: 'smart-summarize', feature: 'summarize', stage: 'create', kind: 'daily', labelKey: 'summarize', descKey: 'smartSummarize', descFallback: 'Summarize content from URL, PDF, YouTube, or audio', icon: 'file-text', requires: 'none', synonyms: ['youtube', 'pdf', 'url', 'audio', 'video', 'web', 'create', 'summary'], synonymKeys: ['summarizeSmart', 'summarizeFromUrl', 'summarizeFromPdf', 'summarizeFromYouTube', 'summarizeFromAudio'], legacyHomes: ['capture'], contexts: ['pdf', 'markdown'] },
    { id: 'create-meeting-minutes', feature: 'minutes', stage: 'create', kind: 'daily', labelKey: 'createMeetingMinutes', descKey: 'createMeetingMinutes', descFallback: 'Generate structured minutes from a transcript', icon: 'clipboard-list', requires: 'none', synonyms: ['minutes', 'meeting', 'transcript', 'transcribe', 'audio', 'speech-to-text'], legacyHomes: ['capture'], contexts: ['audio'] },
    { id: 'transcribe-audio', feature: 'minutes', stage: 'create', kind: 'daily', labelKey: 'transcribeAudio', descKey: 'transcribeAudio', descFallback: 'Transcribe an audio file to a speaker-labelled note', icon: 'mic', requires: 'none', synonyms: ['transcribe', 'audio', 'speech-to-text', 'whisper', 'minutes'], legacyHomes: ['capture'], contexts: ['audio'] },
    { id: 'smart-translate', feature: 'translate', stage: 'create', kind: 'daily', labelKey: 'translate', descKey: 'smartTranslate', descFallback: 'Translate the active note into another language', icon: 'languages', requires: 'active-note', synonyms: ['translate', 'language', 'locale'], synonymKeys: ['translateNote', 'translateSelection'], legacyHomes: ['active-note-refine'], contexts: ['selection', 'markdown'] },
    { id: 'export-note', feature: 'export', stage: 'create', kind: 'daily', labelKey: 'exportNote', descKey: 'exportNote', descFallback: 'Export as PDF, Word, or PowerPoint document', icon: 'file-output', requires: 'active-note', synonyms: ['pdf', 'docx', 'pptx', 'word', 'powerpoint'], legacyHomes: ['active-note-export'], contexts: ['markdown'] },
    { id: 'export-minutes-docx', feature: 'minutes', stage: 'create', kind: 'daily', labelKey: 'exportMinutesDocx', descKey: 'exportMinutesDocx', descFallback: 'Export meeting minutes as Word document', icon: 'file-text', requires: 'active-note', synonyms: ['minutes', 'meeting', 'word', 'docx'], legacyHomes: ['active-note-export'], contexts: ['minutes'] },
    { id: 'presentation-chat', feature: 'presentation', stage: 'create', kind: 'daily', labelKey: 'presentationChat', descKey: 'presentationChat', descFallback: 'Generate a structured slide deck from this note', icon: 'presentation', requires: 'active-note', synonyms: ['slides', 'presentation', 'deck', 'pitch'], legacyHomes: ['active-note-refine'] },
    { id: 'build-presentation-from-storyline', feature: 'presentation', stage: 'create', kind: 'daily', labelKey: 'buildFromStoryline', descKey: 'buildFromStoryline', descFallback: 'Rebuild a deck from a saved consultant storyline note', icon: 'wand-2', requires: 'active-note', synonyms: ['storyline', 'rebuild', 'slides', 'deck'], legacyHomes: ['active-note-refine'] },
    { id: 'edit-mermaid-diagram', feature: 'mermaid-chat', stage: 'create', kind: 'daily', labelKey: 'editMermaidDiagram', descKey: 'editMermaidDiagram', descFallback: 'Conversational Mermaid diagram editing', icon: 'workflow', requires: 'active-note', synonyms: ['mermaid', 'diagram', 'flowchart'], legacyHomes: ['active-note-refine'] },
    { id: 'new-sketch', feature: 'sketch', stage: 'create', kind: 'daily', labelKey: 'newSketch', descKey: 'newSketch', descFallback: 'Open the sketch pad to draw a quick sketch', icon: 'pencil', requires: 'none', synonyms: ['sketch', 'draw', 'whiteboard'], legacyHomes: ['capture'] },
    { id: 'build-investigation-canvas', feature: 'canvas', stage: 'create', kind: 'daily', labelKey: 'buildInvestigationCanvas', descKey: 'buildInvestigationCanvas', descFallback: 'Build an investigation canvas from related notes', icon: 'compass', requires: 'active-note', synonyms: ['canvas', 'investigate', 'board'], legacyHomes: ['active-note-maps'], platform: 'desktop' },
    { id: 'build-context-canvas', feature: 'canvas', stage: 'create', kind: 'daily', labelKey: 'buildContextCanvas', descKey: 'buildContextCanvas', descFallback: 'Build a context canvas from embedded sources', icon: 'layout-grid', requires: 'active-note', synonyms: ['canvas', 'context', 'board'], legacyHomes: ['active-note-maps'], platform: 'desktop' },
    { id: 'build-cluster-canvas', feature: 'canvas', stage: 'create', kind: 'daily', labelKey: 'buildClusterCanvas', descKey: 'buildClusterCanvas', descFallback: 'Build a cluster canvas grouping vault notes by tag', icon: 'network', requires: 'vault', synonyms: ['canvas', 'cluster', 'board'], legacyHomes: ['vault-visualize'], platform: 'desktop' },
    { id: 'edit-ai-workspace', feature: 'ai-workspaces', stage: 'create', kind: 'daily', labelKey: 'editAiWorkspace', descKey: 'editAiWorkspace', descFallback: 'Choose what a project shares with an AI app', icon: 'messages-square', requires: 'none', synonyms: ['ai', 'workspace', 'share', 'project', 'claude', 'chatgpt'], contexts: ['project'] },
    { id: 'open-ai-workspaces-settings', feature: 'ai-workspaces', stage: 'create', kind: 'setup', labelKey: 'openAiWorkspacesSettings', descKey: 'openAiWorkspacesSettings', descFallback: 'Choose which folders AI apps may see, and set up workspaces', icon: 'settings', requires: 'none', synonyms: ['ai', 'workspace', 'settings', 'share', 'folders'] },
    { id: 'open-welcome', feature: 'provider', stage: 'find', kind: 'tool', labelKey: 'openWelcome', descKey: 'openWelcome', descFallback: 'Jobs, AI setup and all actions, in one window', icon: 'door-open', requires: 'none', synonyms: ['welcome', 'start', 'help', 'getting started', 'jobs'] },
    { id: 'copy-ai-instructions', feature: 'ai-workspaces', stage: 'create', kind: 'daily', labelKey: 'copyAiInstructions', descKey: 'copyAiInstructions', descFallback: 'Copy the instructions for a project to paste into an AI app', icon: 'clipboard-copy', requires: 'none', synonyms: ['ai', 'workspace', 'instructions', 'project', 'copy'], contexts: ['project'] },
    { id: 'create-ai-context-pack', feature: 'ai-workspaces', stage: 'create', kind: 'daily', labelKey: 'createContextPack', descKey: 'createContextPack', descFallback: 'Write a dated context pack for a project', icon: 'package', requires: 'none', synonyms: ['ai', 'workspace', 'context', 'pack', 'project'], contexts: ['project'] },
    { id: 'refresh-ai-live-pack', feature: 'ai-workspaces', stage: 'create', kind: 'daily', labelKey: 'refreshLivePack', descKey: 'refreshLivePack', descFallback: "Rewrite a project's live pack in Google Drive now", icon: 'refresh-cw', requires: 'none', synonyms: ['ai', 'workspace', 'live', 'pack', 'drive', 'refresh'], contexts: ['project'], platform: 'desktop' },
    { id: 'review-ai-handback', feature: 'ai-workspaces', stage: 'create', kind: 'daily', labelKey: 'reviewAiHandback', descKey: 'reviewAiHandback', descFallback: 'Review what an AI app handed back in this note', icon: 'inbox', requires: 'active-note', synonyms: ['ai', 'workspace', 'handback', 'hand-back', 'review'], alsoRequiresFeatures: ['capture-inbox'], contexts: ['inbox'] },
    { id: 'narrate-note', feature: 'audio-narration', stage: 'create', kind: 'daily', labelKey: 'narrateNote', descKey: 'narrateNote', descFallback: 'Convert this note to a spoken-audio MP3', icon: 'audio-lines', requires: 'active-note', synonyms: ['narrate', 'audio', 'tts', 'listen', 'voice', 'speak', 'podcast', 'mp3'], legacyHomes: ['active-note-export'], contexts: ['markdown'] },
    { id: 'play-narration', feature: 'audio-narration', stage: 'create', kind: 'daily', labelKey: 'playNarration', descKey: 'playNarration', descFallback: 'Open mp3 in a player with speed and skip controls', icon: 'play-circle', requires: 'mp3-file', synonyms: ['play', 'audio', 'speed', 'skip', 'mp3'], legacyHomes: ['active-note-export'], contexts: ['audio'] },
    { id: 'export-flashcards', feature: 'flashcards', stage: 'create', kind: 'daily', labelKey: 'exportFlashcards', descKey: 'exportFlashcards', descFallback: 'Generate Anki or Brainscape flashcards from note', icon: 'layers', requires: 'active-note', synonyms: ['flashcards', 'anki', 'brainscape', 'cards', 'study', 'quiz'], legacyHomes: ['active-note-export'] },
    { id: 'smart-tag', feature: 'tagging', stage: 'create', kind: 'daily', labelKey: 'tag', descKey: 'smartTag', descFallback: 'Generate tags for the active note', icon: 'tag', requires: 'active-note', synonyms: ['tag', 'tagging', 'categorise'], synonymKeys: ['generateTagsForCurrentNote'], legacyHomes: ['active-note-refine'], contexts: ['multi', 'markdown'] },
    { id: 'open-process', feature: 'capture-inbox', stage: 'refine', kind: 'tool', labelKey: 'openProcess', descKey: 'openProcess', descFallback: 'See what waits for you: captures, AI hand-backs and held tasks', icon: 'list-todo', requires: 'none', synonyms: ['process', 'queue', 'waiting', 'review', 'handback', 'captures'], anyOfFeatures: ['capture-inbox', 'inbox-sweep', 'ai-workspaces'] },
    { id: 'sweep-inbox', feature: 'inbox-sweep', stage: 'refine', kind: 'daily', labelKey: 'sweepInbox', descKey: 'sweepInbox', descFallback: 'Read your inbox notes and propose actions for you to review', icon: 'inbox', requires: 'none', synonyms: ['inbox', 'sweep', 'tasks', 'actions', 'gtd'], contexts: ['inbox'] },
    { id: 'setup-inbox-sweep', feature: 'inbox-sweep', stage: 'refine', kind: 'setup', labelKey: 'setupInboxSweep', descKey: 'setupInboxSweep', descFallback: 'Choose inbox folders and what to keep out, step by step', icon: 'sparkles', requires: 'none', synonyms: ['inbox', 'sweep', 'setup', 'keep out'] },
    { id: 'process-capture-inbox', feature: 'capture-inbox', stage: 'refine', kind: 'daily', labelKey: 'processCaptureInbox', descKey: 'processCaptureInbox', descFallback: 'Turn voice memos, photos and quick notes in your inbox into readable text with a proposed title, tags and folder', icon: 'inbox', requires: 'none', synonyms: ['capture', 'inbox', 'voice', 'memo', 'photo', 'transcribe', 'clarify', 'gtd'], contexts: ['inbox'] },
    { id: 'review-captures', feature: 'capture-inbox', stage: 'refine', kind: 'daily', labelKey: 'reviewCaptures', descKey: 'reviewCaptures', descFallback: 'See the captures that are waiting for your review', icon: 'list-checks', requires: 'none', synonyms: ['capture', 'review', 'queue', 'inbox'] },
    { id: 'setup-capture-inbox', feature: 'capture-inbox', stage: 'refine', kind: 'setup', labelKey: 'setupCaptureInbox', descKey: 'setupCaptureInbox', descFallback: 'Choose the inbox, what to keep out and where organised notes may go, step by step', icon: 'sparkles', requires: 'none', synonyms: ['capture', 'inbox', 'setup', 'keep out'] },
    { id: 'send-tasks-to-google', feature: 'google-tasks-export', stage: 'refine', kind: 'daily', labelKey: 'sendTasksToGoogle', descKey: 'sendTasksToGoogle', descFallback: 'Send the tasks you approved to your Google Tasks list', icon: 'send', requires: 'none', synonyms: ['google', 'tasks', 'send', 'export'], contexts: ['sweep-report'] },
    { id: 'make-google-task', feature: 'google-tasks-export', stage: 'refine', kind: 'daily', labelKey: 'makeGoogleTask', descKey: 'makeGoogleTask', descFallback: 'Turn this note, or the selected text, into one Google task without AI', icon: 'list-plus', requires: 'active-note', synonyms: ['google', 'tasks', 'task', 'todo', 'right click', 'quick'], contexts: ['project', 'minutes', 'markdown'] },
    { id: 'setup-google-tasks', feature: 'google-tasks-export', stage: 'refine', kind: 'setup', labelKey: 'setupGoogleTasks', descKey: 'setupGoogleTasks', descFallback: 'Connect your own Google Tasks list step by step', icon: 'list-checks', requires: 'none', synonyms: ['google', 'tasks', 'setup'] },
    { id: 'refresh-task-status', feature: 'google-tasks-export', stage: 'refine', kind: 'daily', labelKey: 'refreshTaskStatus', descKey: 'refreshTaskStatus', descFallback: 'Tick off sweep report lines for tasks done in Google Tasks', icon: 'refresh-cw', requires: 'none', synonyms: ['google', 'tasks', 'status', 'done', 'refresh'], contexts: ['sweep-report'] },
    { id: 'copy-combined-google-script', feature: 'google-tasks-export', stage: 'refine', kind: 'tool', labelKey: 'copyCombinedGoogleScript', descKey: 'copyCombinedGoogleScript', descFallback: 'Copy one Google script for Tasks and Drive folders', icon: 'clipboard-copy', requires: 'none', synonyms: ['google', 'script', 'apps script', 'combined', 'copy'] },
    { id: 'adopt-project', feature: 'google-tasks-export', stage: 'refine', kind: 'daily', labelKey: 'adoptProject', descKey: 'adoptProject', descFallback: 'Mark the active note as a project with one small reviewed edit; nothing is moved', icon: 'folder-kanban', requires: 'active-note', synonyms: ['project', 'adopt', 'para', 'gtd'], contexts: ['inbox', 'markdown'] },
    { id: 'enhance-note', feature: 'smart-note', stage: 'refine', kind: 'daily', labelKey: 'improveNote', descKey: 'enhanceNote', descFallback: 'Improve the active note with AI suggestions', icon: 'sparkles', requires: 'active-note', synonyms: ['improve', 'polish', 'enhance', 'rewrite'], synonymKeys: ['enhance'], legacyHomes: ['active-note-refine'], contexts: ['markdown'] },
    { id: 'integrate-pending-content', feature: 'smart-note', stage: 'refine', kind: 'daily', labelKey: 'integratePendingContent', descKey: 'integratePending', descFallback: 'Integrate pending content into the active note', icon: 'merge', requires: 'active-note', synonyms: ['integrate', 'merge'], legacyHomes: ['active-note-pending'] },
    { id: 'add-to-pending-integration', feature: 'smart-note', stage: 'refine', kind: 'daily', labelKey: 'addToPendingIntegration', descKey: 'addToPending', descFallback: 'Add the active note to the pending-integration queue', icon: 'plus-square', requires: 'active-note', synonyms: ['add'], legacyHomes: ['active-note-pending'] },
    { id: 'resolve-pending-embeds', feature: 'smart-note', stage: 'refine', kind: 'daily', labelKey: 'resolvePendingEmbeds', descKey: 'resolveEmbeds', descFallback: 'Resolve embedded content references in the active note', icon: 'link', requires: 'active-note', synonyms: ['embeds', 'resolve', 'expand'], legacyHomes: ['active-note-pending'] },
    { id: 'ensure-note-structure', feature: 'smart-note', stage: 'refine', kind: 'daily', labelKey: 'ensureNoteStructure', descKey: 'ensureNoteStructure', descFallback: 'Add references and pending integration sections to this note', icon: 'list-plus', requires: 'active-note', synonyms: ['references', 'pending', 'sections', 'structure'] },
    { id: 'quick-add-text-pending', feature: 'smart-note', stage: 'refine', kind: 'daily', labelKey: 'quickAddTextPending', descKey: 'quickAddTextPending', descFallback: 'Type text to add to this note\'s pending integration', icon: 'text-cursor-input', requires: 'active-note', synonyms: ['pending', 'quick', 'add', 'text'] },
    { id: 'quick-add-url-pending', feature: 'smart-note', stage: 'refine', kind: 'daily', labelKey: 'quickAddUrlPending', descKey: 'quickAddUrlPending', descFallback: 'Add a link to this note\'s pending integration', icon: 'link', requires: 'active-note', synonyms: ['pending', 'quick', 'add', 'url', 'link'] },
    { id: 'drop-selection-pending', feature: 'smart-note', stage: 'refine', kind: 'daily', labelKey: 'dropSelectionPending', descKey: 'dropSelectionPending', descFallback: 'Move the selected text into pending integration', icon: 'arrow-down-to-line', requires: 'selection', synonyms: ['pending', 'selection', 'drop', 'move'], contexts: ['selection'] },
    { id: 'digitise-image', feature: 'digitisation', stage: 'refine', kind: 'daily', labelKey: 'digitiseImage', descKey: 'digitiseImage', descFallback: 'Digitise a handwritten or whiteboard image', icon: 'scan', requires: 'active-note', synonyms: ['digitise', 'digitize', 'ocr', 'image', 'scan'], legacyHomes: ['active-note-refine'], contexts: ['image'] },
    { id: 'clear-tags', feature: 'tagging', stage: 'refine', kind: 'daily', labelKey: 'clearTags', descKey: 'clearTags', descFallback: 'Clear tags from the active note', icon: 'eraser', requires: 'active-note', synonyms: ['clear', 'tags', 'reset'], legacyHomes: ['active-note-refine'] },
    { id: 'refresh-onedrive-embed', feature: 'onedrive-link', stage: 'refine', kind: 'daily', labelKey: 'refreshOneDriveEmbed', descKey: 'refreshOneDriveEmbed', descFallback: 'Re-sync any OneDrive embeds in this note with their source files', icon: 'refresh-cw', requires: 'active-note', synonyms: ['onedrive', 'refresh', 'sync', 'update'], platform: 'desktop' },
    { id: 'chat-with-ai', feature: 'chat', stage: 'find', kind: 'daily', labelKey: 'chatWithAI', descKey: 'chatWithAI', descFallback: 'Free-form AI chat with file attachments and projects', icon: 'message-circle', requires: 'none', synonyms: ['ask', 'question', 'chat', 'rag', 'passages'], canonicalCategoryId: 'pinned', contexts: ['selection', 'pdf'] },
    { id: 'semantic-search', feature: 'semantic-search', stage: 'find', kind: 'daily', labelKey: 'searchSemanticVault', descKey: 'semanticSearch', descFallback: 'Find notes by meaning, not just keywords', icon: 'search', requires: 'semantic-search', synonyms: ['semantic', 'search', 'find', 'query', 'lookup'], canonicalCategoryId: 'pinned' },
    { id: 'find-related', feature: 'semantic-search', stage: 'find', kind: 'daily', labelKey: 'showRelatedNotes', descKey: 'findRelated', descFallback: 'Find related resources for the active note', icon: 'compass', requires: 'active-note', synonyms: ['related', 'similar', 'connections', 'linked', 'find', 'resources'], synonymKeys: ['findResources'], legacyHomes: ['active-note-maps'], contexts: ['markdown'] },
    { id: 'insert-related-notes', feature: 'semantic-search', stage: 'find', kind: 'daily', labelKey: 'insertRelatedNotes', descKey: 'insertRelatedNotes', descFallback: 'Insert related notes into the active note', icon: 'list-tree', requires: 'active-note', synonyms: ['related', 'similar', 'connections', 'linked', 'insert'], legacyHomes: ['active-note-maps'] },
    { id: 'quick-peek', feature: 'quick-peek', stage: 'find', kind: 'daily', labelKey: 'quickPeek', descKey: 'quickPeek', descFallback: 'Fast 1-paragraph triage of embedded sources', icon: 'zap', requires: 'active-note', synonyms: ['peek', 'quick', 'triage', 'skim', 'preview', 'sources'], canonicalCategoryId: 'pinned', contexts: ['markdown'] },
    { id: 'open-project', feature: 'google-tasks-export', stage: 'find', kind: 'daily', labelKey: 'openProject', descKey: 'openProject', descFallback: 'Find one of your adopted projects and open its note', icon: 'folder-open', requires: 'none', synonyms: ['project', 'open', 'para', 'gtd'], contexts: ['project'] },
    { id: 'copy-claude-permissions', feature: 'agent-index', stage: 'find', kind: 'tool', labelKey: 'copyClaudePermissions', descKey: 'copyClaudePermissions', descFallback: 'Copy the Claude Code permission rules for your excluded and protected folders', icon: 'shield', requires: 'none', synonyms: ['claude', 'permissions', 'deny', 'agent'] },
    { id: 'write-agent-instructions', feature: 'agent-index', stage: 'find', kind: 'tool', labelKey: 'writeAgentInstructions', descKey: 'writeAgentInstructions', descFallback: 'Preview and write the instructions block into your AGENTS.md', icon: 'file-pen-line', requires: 'none', synonyms: ['agents', 'instructions', 'block', 'write'] },
    { id: 'build-agent-index', feature: 'agent-index', stage: 'find', kind: 'tool', labelKey: 'buildAgentIndex', descKey: 'buildAgentIndex', descFallback: 'Write the note index that AI coding tools can read', icon: 'list-tree', requires: 'vault', synonyms: ['agent', 'index', 'claude', 'cursor', 'map'] },
    { id: 'check-agent-index', feature: 'agent-index', stage: 'find', kind: 'tool', labelKey: 'checkAgentIndex', descKey: 'checkAgentIndex', descFallback: 'See whether the agent index still matches your notes', icon: 'list-checks', requires: 'vault', synonyms: ['agent', 'index', 'check', 'stale'] },
    { id: 'copy-agent-instructions', feature: 'agent-index', stage: 'find', kind: 'tool', labelKey: 'copyAgentInstructions', descKey: 'copyAgentInstructions', descFallback: 'Copy the routing text and permission rules for your AI coding tool', icon: 'clipboard-copy', requires: 'vault', synonyms: ['agent', 'instructions', 'claude', 'permissions', 'deny'] },
    { id: 'open-agent-connectors', feature: 'agent-connectors', stage: 'find', kind: 'tool', labelKey: 'openAgentConnectors', descKey: 'openAgentConnectors', descFallback: 'Step-by-step help to connect Claude Desktop, Codex or a command-line agent', icon: 'plug-zap', requires: 'none', synonyms: ['connect', 'claude', 'codex', 'agent', 'mcp'] },
    { id: 'export-vault-map', feature: 'agent-connectors', stage: 'find', kind: 'tool', labelKey: 'exportVaultMap', descKey: 'exportVaultMap', descFallback: 'Make one file of note paths, tags and links to upload to a chat project', icon: 'file-up', requires: 'none', synonyms: ['export', 'chat', 'project', 'upload', 'map'] },
    { id: 'manage-index', feature: 'semantic-search', stage: 'find', kind: 'tool', labelKey: 'manageIndex', descKey: 'manageIndex', descFallback: 'Build, rebuild or clear the semantic search index', icon: 'database', requires: 'none', synonyms: ['index', 'semantic', 'rebuild', 'embeddings'] },
    { id: 'setup-agent-index', feature: 'agent-index', stage: 'find', kind: 'setup', labelKey: 'setupAgentIndex', descKey: 'setupAgentIndex', descFallback: 'Choose what the agent index covers, with a preview', icon: 'sparkles', requires: 'vault', synonyms: ['agent', 'index', 'setup'] },
    { id: 'show-tag-network', feature: 'tagging', stage: 'maintain', kind: 'daily', labelKey: 'showTagNetwork', descKey: 'showTagNetwork', descFallback: 'Visualise the tag network for the vault', icon: 'network', requires: 'vault', synonyms: ['tags', 'network', 'graph'], legacyHomes: ['vault-visualize'] },
    { id: 'collect-all-tags', feature: 'tagging', stage: 'maintain', kind: 'daily', labelKey: 'collectAllTags', descKey: 'collectAllTags', descFallback: 'Collect every tag in the vault into a list', icon: 'tags', requires: 'vault', synonyms: ['tags', 'collect', 'list'], legacyHomes: ['vault-visualize'] },
    { id: 'resume-offload', feature: 'cloud-offload', stage: 'maintain', kind: 'daily', labelKey: 'resumeOffload', descKey: 'resumeOffload', descFallback: 'Continue an unfinished move of a large file to Google Drive', icon: 'cloud-upload', requires: 'none', synonyms: ['drive', 'google', 'offload', 'resume', 'large'], platform: 'desktop' },
    { id: 'run-vault-upkeep', feature: 'vault-upkeep', stage: 'maintain', kind: 'daily', labelKey: 'runVaultUpkeep', descKey: 'runVaultUpkeep', descFallback: 'Check your vault now and list what needs attention', icon: 'broom', requires: 'none', synonyms: ['upkeep', 'sweep', 'check', 'maintenance'] },
    { id: 'open-upkeep-review', feature: 'vault-upkeep', stage: 'maintain', kind: 'daily', labelKey: 'openUpkeepReview', descKey: 'openUpkeepReview', descFallback: 'See the result of the last vault upkeep run', icon: 'clipboard-list', requires: 'none', synonyms: ['upkeep', 'review', 'report'] },
    { id: 'setup-vault-upkeep', feature: 'vault-upkeep', stage: 'maintain', kind: 'setup', labelKey: 'setupVaultUpkeep', descKey: 'setupVaultUpkeep', descFallback: 'Choose how often to check and what to check, step by step', icon: 'sparkles', requires: 'none', synonyms: ['upkeep', 'setup', 'schedule'] },
    { id: 'find-embeds', feature: 'embed-scan', stage: 'maintain', kind: 'daily', labelKey: 'findEmbeds', descKey: 'findEmbeds', descFallback: 'Find every embedded asset in the vault', icon: 'puzzle', requires: 'vault', synonyms: ['embeds', 'find', 'hygiene'], legacyHomes: ['vault'] },
    { id: 'upgrade-metadata', feature: 'bases', stage: 'maintain', kind: 'daily', labelKey: 'upgradeToBases', descKey: 'upgradeMetadata', descFallback: 'Upgrade vault notes to Bases metadata format', icon: 'database', requires: 'vault', synonyms: ['migrate', 'upgrade', 'bases', 'metadata'] },
    { id: 'upgrade-folder-metadata', feature: 'bases', stage: 'maintain', kind: 'daily', labelKey: 'upgradeFolderToBases', descKey: 'upgradeFolderMetadata', descFallback: 'Upgrade current folder notes to Bases metadata', icon: 'folder-sync', requires: 'active-note', synonyms: ['migrate', 'folder', 'upgrade', 'bases'] },
    { id: 'create-bases-dashboard', feature: 'bases', stage: 'maintain', kind: 'daily', labelKey: 'createBasesDashboard', descKey: 'createDashboard', descFallback: 'Create a Bases dashboard for the vault', icon: 'gauge', requires: 'vault', synonyms: ['dashboard', 'bases', 'create'], legacyHomes: ['vault-visualize'] },
    { id: 'notebooklm-export', feature: 'notebooklm', stage: 'maintain', kind: 'daily', labelKey: 'notebookLMExport', descKey: 'notebookLMExport', descFallback: 'Export selected notes as NotebookLM source pack', icon: 'book-open', requires: 'vault', synonyms: ['notebooklm', 'export', 'pdf', 'pack'], legacyHomes: ['tools'] },
    { id: 'notebooklm-toggle-selection', feature: 'notebooklm', stage: 'maintain', kind: 'daily', labelKey: 'notebookLMToggle', descKey: 'notebookLMToggle', descFallback: 'Toggle current note in NotebookLM selection', icon: 'check-square', requires: 'active-note', synonyms: ['notebooklm', 'select', 'toggle'] },
    { id: 'notebooklm-clear-selection', feature: 'notebooklm', stage: 'maintain', kind: 'daily', labelKey: 'notebookLMClear', descKey: 'notebookLMClear', descFallback: 'Clear all NotebookLM selections', icon: 'x-square', requires: 'none', synonyms: ['notebooklm', 'clear', 'selection'] },
    { id: 'notebooklm-open-export-folder', feature: 'notebooklm', stage: 'maintain', kind: 'daily', labelKey: 'notebookLMOpenFolder', descKey: 'notebookLMOpenFolder', descFallback: 'Open the NotebookLM export folder', icon: 'folder-open', requires: 'none', synonyms: ['notebooklm', 'folder', 'export', 'open'] },
] satisfies ActionDef[]);

/**
 * Registered commands that are deliberately not actions: cursor-bound variants and the picker
 * itself. Never used to keep a public action out of the picker.
 */
export const HIDDEN_COMMANDS: Readonly<Record<string, string>> = Object.freeze({
    'open-picker': 'opens the picker itself',
    'select-presentation-slide': 'internal to the presentation chat view',
    'highlight-selection': 'editor formatting, reached from the right-click menu',
    'remove-highlight': 'editor formatting, reached from the right-click menu',
    'highlight-yellow': 'editor formatting colour variant',
    'highlight-green': 'editor formatting colour variant',
    'highlight-blue': 'editor formatting colour variant',
    'highlight-pink': 'editor formatting colour variant',
    'highlight-orange': 'editor formatting colour variant',
    'highlight-purple': 'editor formatting colour variant',
});

export const ACTION_BY_ID: ReadonlyMap<string, ActionDef> = new Map(ACTIONS.map((a) => [a.id, a]));

/** The label of an action, the same string on every surface. Throws on an unknown id (a bug). */
export function actionName(t: Translations, id: string): string {
    const def = ACTION_BY_ID.get(id);
    if (!def) throw new Error(`Unknown action id: ${id}`);
    return t.commands[def.labelKey];
}
