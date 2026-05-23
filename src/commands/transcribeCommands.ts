/**
 * Commands for the F3 transcribe-audio surface.
 *
 *  - `ai-organiser:transcribe-audio` — opens the slim TranscribeOnlyModal.
 *    The top-level verb users actually type into the Command Picker (Pat
 *    persona-test P0). Picker leaf wired in CommandPickerModal.
 *
 * The follow-up `generate-minutes-from-transcript` command (plan §7) is
 * intentionally deferred to a separate commit — its hydration adapter
 * lands alongside it.
 */

import type AIOrganiserPlugin from '../main';
import { TranscribeOnlyModal } from '../ui/modals/TranscribeOnlyModal';

export function registerTranscribeCommands(plugin: AIOrganiserPlugin): void {
    plugin.addCommand({
        id: 'transcribe-audio',
        name: plugin.t.commands.transcribeAudio || 'Transcribe audio',
        icon: 'mic',
        callback: () => {
            new TranscribeOnlyModal(plugin.app, plugin).open();
        },
    });
}
