/**
 * Slide Picker Modal — keyboard-reachable slide-level scope selection.
 *
 * Audit Gemini-r7-G2 fix: keyboard-only users couldn't reach slide-level
 * scope (the "Promote to slide" button only appeared after element-click,
 * which they can't do in the iframe). This modal opens via a global
 * command (`Mod+Shift+S` by default) and lists every slide as
 * `Slide N — <first heading>`. Selecting an entry sets the scope to
 * `{ kind: 'slide', slideIndex: i }`.
 */

import { App, FuzzySuggestModal } from 'obsidian';
import type AIOrganiserPlugin from '../../main';

export interface SlideEntry {
    slideIndex: number;
    headingText: string;
}

/**
 * Parse the deck HTML into one entry per slide. The first heading's
 * textContent (or a placeholder) is the user-readable label.
 */
export function parseSlideEntries(html: string): SlideEntry[] {
    if (!html) return [];
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const slides = Array.from(doc.querySelectorAll('section.slide'));
    return slides.map((slide, i) => {
        const heading = slide.querySelector('h1, h2, h3, h4, h5, h6');
        const headingText = (heading?.textContent ?? '').trim() || `(no heading)`;
        return { slideIndex: i, headingText };
    });
}

export class SlidePickerModal extends FuzzySuggestModal<SlideEntry> {
    constructor(
        app: App,
        private readonly plugin: AIOrganiserPlugin,
        private readonly entries: SlideEntry[],
        private readonly onPick: (entry: SlideEntry) => void,
    ) {
        super(app);
        const t = this.plugin.t.modals.unifiedChat;
        this.setPlaceholder(t.slideSelectorPlaceholder);
    }

    getItems(): SlideEntry[] {
        return this.entries;
    }

    getItemText(item: SlideEntry): string {
        const t = this.plugin.t.modals.unifiedChat;
        return t.slideSelectorEntry
            .replace('{n}', String(item.slideIndex + 1))
            .replace('{heading}', item.headingText);
    }

    onChooseItem(item: SlideEntry): void {
        this.onPick(item);
    }
}
