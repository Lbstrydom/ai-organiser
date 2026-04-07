/**
 * Mermaid Block Picker Modal
 * FuzzySuggestModal for selecting a specific mermaid block to edit when
 * a note contains multiple diagrams and the cursor is not inside any of them.
 */

import { App, FuzzySuggestModal } from 'obsidian';
import type { MermaidBlock } from '../../utils/mermaidUtils';

export class MermaidBlockPickerModal extends FuzzySuggestModal<MermaidBlock> {
    constructor(
        app: App,
        private readonly blocks: MermaidBlock[],
        private readonly onSelect: (block: MermaidBlock) => void,
        placeholder?: string,
    ) {
        super(app);
        this.setPlaceholder(placeholder ?? 'Select a diagram to edit...');
    }

    getItems(): MermaidBlock[] {
        return this.blocks;
    }

    getItemText(block: MermaidBlock): string {
        const firstLine = block.code.split('\n')[0]?.trim() ?? '';
        const diagramType = firstLine.split(/\s+/)[0] ?? 'diagram';
        const preview = block.code
            .split('\n')
            .slice(1, 3)
            .map(l => l.trim())
            .filter(Boolean)
            .join(' ')
            .slice(0, 60);
        const lineRange = `Lines ${block.startLine + 1}–${block.endLine + 1}`;
        return preview
            ? `${diagramType} (${lineRange}) — ${preview}`
            : `${diagramType} (${lineRange})`;
    }

    onChooseItem(block: MermaidBlock): void {
        this.onSelect(block);
    }
}
