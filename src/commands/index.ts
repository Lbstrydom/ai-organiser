import { registerGenerateCommands } from './generateCommands';
import { registerClearCommands } from './clearCommands';
import { registerUtilityCommands } from './utilityCommands';
import { registerSummarizeCommands } from './summarizeCommands';
import { registerMinutesCommands } from './minutesCommands';
import { registerTranscribeCommands } from './transcribeCommands';
import { registerTranslateCommands } from './translateCommands';
import { registerSmartNoteCommands, registerMermaidChatCommand } from './smartNoteCommands';
import { registerIntegrationCommands } from './integrationCommands';
import { registerHighlightCommands } from './highlightCommands';
import { registerSemanticSearchCommands } from './semanticSearchCommands';
import { registerChatCommands, registerPresentationCommands, registerInsertRelatedNotesCommand } from './chatCommands';
import { registerMigrationCommands } from './migrationCommands';
import { registerDashboardCommands } from './dashboardCommands';
import { registerNotebookLMCommands } from './notebookLMCommands';
import { registerExportCommands } from './exportCommands';
import { registerCanvasCommands } from './canvasCommands';
import { registerWebReaderCommands } from './webReaderCommands';
import { registerKindleCommands } from './kindleCommands';
import { registerDigitisationCommands } from './digitisationCommands';
import { registerSketchCommands } from './sketchCommands';
import { registerFlashcardCommands } from './flashcardCommands';
import { registerResearchCommands } from './researchCommands';
import { registerEmbedScanCommands } from './embedScanCommands';
import { registerQuickPeekCommands } from './quickPeekCommands';
import { registerNewsletterCommands } from './newsletterCommands';
import { registerAudioNarrationCommands } from './audioNarrationCommands';
import { registerOneDriveLinkCommands } from './oneDriveLinkCommands';
import { registerContextMenu } from '../ui/contextMenu';
import AIOrganiserPlugin from '../main';
import { isFeatureEnabled } from '../services/featureService';
import type { FeatureId } from '../core/features';

type RegisterFn = (plugin: AIOrganiserPlugin) => void;

/**
 * FeatureId → its command register-fn(s) (FT-4). Array-valued: a feature owns 1-to-many
 * register-fns (`tagging`→generate/clear/utility, `minutes`→minutes/transcribe,
 * `bases`→migration/dashboard, `smart-note`→smartNote/integration/highlight). Partial —
 * `provider` (core, no commands) is absent and gates via section ownership only.
 * `mermaid-chat`→`registerMermaidChatCommand`, `presentation`→`registerPresentationCommands`,
 * and `semantic-search`→`registerInsertRelatedNotesCommand` are FT-9b extractions: their
 * `addCommand`s rode inside a core/shared registrar and would leak into the native palette
 * when the feature is off. `registerContextMenu` is NOT here — it stays unconditionally
 * registered with per-item gating (Gemini-G2).
 */
export const REGISTER_BY_FEATURE: Partial<Record<FeatureId, RegisterFn[]>> = {
    tagging: [registerGenerateCommands, registerClearCommands, registerUtilityCommands],
    summarize: [registerSummarizeCommands],
    minutes: [registerMinutesCommands, registerTranscribeCommands],
    translate: [registerTranslateCommands],
    'smart-note': [registerSmartNoteCommands, registerIntegrationCommands, registerHighlightCommands],
    'semantic-search': [registerSemanticSearchCommands, registerInsertRelatedNotesCommand],
    chat: [registerChatCommands],
    presentation: [registerPresentationCommands],
    bases: [registerMigrationCommands, registerDashboardCommands],
    notebooklm: [registerNotebookLMCommands],
    export: [registerExportCommands],
    canvas: [registerCanvasCommands],
    'web-reader': [registerWebReaderCommands],
    kindle: [registerKindleCommands],
    digitisation: [registerDigitisationCommands],
    sketch: [registerSketchCommands],
    flashcards: [registerFlashcardCommands],
    research: [registerResearchCommands],
    'embed-scan': [registerEmbedScanCommands],
    'quick-peek': [registerQuickPeekCommands],
    newsletter: [registerNewsletterCommands],
    'audio-narration': [registerAudioNarrationCommands],
    'mermaid-chat': [registerMermaidChatCommand],
    'onedrive-link': [registerOneDriveLinkCommands],
};

/**
 * Register commands for ENABLED features only (FT-5: load-time snapshot — Obsidian can't
 * cleanly runtime-unregister, so disabled features simply never register; toggling needs
 * a reload). The context-menu listener is registered unconditionally (cross-cutting; its
 * per-item contributions gate inline — Gemini-G2).
 */
export function registerCommands(plugin: AIOrganiserPlugin) {
    for (const [id, fns] of Object.entries(REGISTER_BY_FEATURE) as [FeatureId, RegisterFn[]][]) {
        if (!isFeatureEnabled(plugin.settings, id)) continue;
        for (const fn of fns) fn(plugin);
    }
    registerContextMenu(plugin);
}
