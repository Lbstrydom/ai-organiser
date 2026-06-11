/**
 * Azure AI Speech voice picker (azure-audio follow-up, 2026-06-11).
 *
 * The regional catalog carries ~700 voices — a dropdown is unusable, so this
 * is a FuzzySuggestModal over the loaded catalog: search by display name
 * ("Ava"), locale ("en-US", "fi-FI"), gender, or API short name. Selection
 * hands back the entry; the settings section writes `azureSpeechVoice`.
 */

import { FuzzySuggestModal, type App } from 'obsidian';
import type { SpeechVoiceEntry } from '../../services/tts/voiceCatalogService';

export class SpeechVoicePickerModal extends FuzzySuggestModal<SpeechVoiceEntry> {
    constructor(
        app: App,
        private readonly voices: SpeechVoiceEntry[],
        placeholder: string,
        private readonly onPick: (voice: SpeechVoiceEntry) => void,
    ) {
        super(app);
        this.setPlaceholder(placeholder);
    }

    getItems(): SpeechVoiceEntry[] {
        // Locale-then-name order so same-language voices cluster together
        // when the query is broad (e.g. "en-US").
        return [...this.voices].sort((a, b) =>
            a.locale.localeCompare(b.locale) || a.displayName.localeCompare(b.displayName));
    }

    getItemText(v: SpeechVoiceEntry): string {
        const gender = v.gender ? ` — ${v.gender}` : '';
        return `${v.displayName} — ${v.locale}${gender} — ${v.shortName}`;
    }

    onChooseItem(v: SpeechVoiceEntry): void {
        this.onPick(v);
    }
}
