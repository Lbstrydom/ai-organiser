import { registerGenerateCommands } from './generateCommands';
import { registerClearCommands } from './clearCommands';
import { registerUtilityCommands } from './utilityCommands';
import { registerSummarizeCommands } from './summarizeCommands';
import { registerTranslateCommands } from './translateCommands';
import { registerSmartNoteCommands } from './smartNoteCommands';
import { registerIntegrationCommands } from './integrationCommands';
import { registerHighlightCommands } from './highlightCommands';
import { registerSemanticSearchCommands } from './semanticSearchCommands';
import { registerChatCommands } from './chatCommands';
import { registerMigrationCommands } from './migrationCommands';
import { registerDashboardCommands } from './dashboardCommands';
import AIOrganiserPlugin from '../main';

export function registerCommands(plugin: AIOrganiserPlugin) {
    registerGenerateCommands(plugin);
    registerClearCommands(plugin);
    registerUtilityCommands(plugin);
    registerSummarizeCommands(plugin);
    registerTranslateCommands(plugin);
    registerSmartNoteCommands(plugin);
    registerIntegrationCommands(plugin);
    registerHighlightCommands(plugin);
    registerSemanticSearchCommands(plugin);
    registerChatCommands(plugin);
    registerMigrationCommands(plugin);
    registerDashboardCommands(plugin);
}
