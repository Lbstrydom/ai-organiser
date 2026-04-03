/**
 * MermaidTemplatePickerModal
 * Fuzzy-suggest modal for selecting a saved/default Mermaid diagram template.
 *
 * Usage:
 *   new MermaidTemplatePickerModal(app, plugin, templates, onChoose).open();
 */

import { App, FuzzySuggestModal, FuzzyMatch, setIcon } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { MermaidTemplate } from '../../services/mermaidTemplateService';

export class MermaidTemplatePickerModal extends FuzzySuggestModal<MermaidTemplate> {
    constructor(
        app: App,
        private readonly plugin: AIOrganiserPlugin,
        private readonly templates: MermaidTemplate[],
        private readonly onChoose: (template: MermaidTemplate) => void,
    ) {
        super(app);
        const t = plugin.t.modals.mermaidChat;
        this.setPlaceholder(t.templateSelectTitle);
        this.emptyStateText = t.templateNoTemplates;
    }

    getItems(): MermaidTemplate[] {
        return this.templates;
    }

    getItemText(item: MermaidTemplate): string {
        return item.name;
    }

    renderSuggestion(value: FuzzyMatch<MermaidTemplate>, el: HTMLElement): void {
        const item = value.item;
        el.addClass('ai-organiser-template-suggestion');

        const iconEl = el.createEl('span', { cls: 'ai-organiser-template-icon' });
        // Use a diagram-type icon; map common types
        setIcon(iconEl, this.iconForType(item.type));

        const textEl = el.createEl('div', { cls: 'ai-organiser-template-text' });
        textEl.createEl('strong', { cls: 'ai-organiser-template-name', text: item.name });

        if (item.type) {
            textEl.createEl('span', {
                cls: 'ai-organiser-template-type',
                text: ` · ${item.type}`,
            });
        }

        if (item.description) {
            textEl.createEl('div', {
                cls: 'ai-organiser-template-desc',
                text: item.description,
            });
        }
    }

    onChooseItem(item: MermaidTemplate): void {
        this.onChoose(item);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private iconForType(type: string | undefined): string {
        switch (type) {
            case 'flowchart': return 'git-branch';
            case 'sequence': return 'arrow-right-left';
            case 'mindmap': return 'brain';
            case 'gantt': return 'calendar-range';
            case 'class': return 'box';
            case 'state': return 'shuffle';
            case 'er': return 'database';
            case 'pie': return 'pie-chart';
            default: return 'share-2';
        }
    }
}
