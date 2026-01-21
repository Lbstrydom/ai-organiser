/**
 * Mermaid Diagram Modal
 * Allows users to generate Mermaid diagrams from note content
 */

import { App, Modal, Setting } from 'obsidian';
import type { Translations } from '../../i18n/types';

export type DiagramType =
    | 'auto'
    | 'flowchart'
    | 'mindmap'
    | 'sequenceDiagram'
    | 'classDiagram'
    | 'stateDiagram'
    | 'erDiagram'
    | 'timeline'
    | 'gantt';

export interface MermaidDiagramResult {
    diagramType: DiagramType;
    instruction: string;
}

const DIAGRAM_TYPES: { value: DiagramType; label: string; description: string }[] = [
    { value: 'auto', label: 'Auto-detect', description: 'AI chooses the best diagram type' },
    { value: 'flowchart', label: 'Flowchart', description: 'Process flows, decision trees, workflows' },
    { value: 'mindmap', label: 'Mind Map', description: 'Hierarchical concept maps, brainstorming' },
    { value: 'sequenceDiagram', label: 'Sequence Diagram', description: 'Interactions between entities over time' },
    { value: 'classDiagram', label: 'Class Diagram', description: 'Object structures, relationships' },
    { value: 'stateDiagram', label: 'State Diagram', description: 'State machines, lifecycle stages' },
    { value: 'erDiagram', label: 'ER Diagram', description: 'Database entities and relationships' },
    { value: 'timeline', label: 'Timeline', description: 'Chronological events, history' },
    { value: 'gantt', label: 'Gantt Chart', description: 'Project schedules, task timelines' },
];

export class MermaidDiagramModal extends Modal {
    private t: Translations;
    private onSubmit: (result: MermaidDiagramResult) => void;
    private diagramType: DiagramType = 'auto';
    private instruction: string = '';

    constructor(
        app: App,
        t: Translations,
        onSubmit: (result: MermaidDiagramResult) => void
    ) {
        super(app);
        this.t = t;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        const t = this.t.modals.mermaidDiagram;

        contentEl.empty();
        contentEl.addClass('ai-organiser-modal');

        // Title
        contentEl.createEl('h2', { text: t?.title || 'Generate Mermaid Diagram' });

        // Description
        contentEl.createEl('p', {
            text: t?.description || 'Create a visual diagram from your note content. Obsidian will automatically render Mermaid diagrams.',
            cls: 'setting-item-description'
        });

        // Diagram type dropdown
        new Setting(contentEl)
            .setName(t?.typeLabel || 'Diagram Type')
            .setDesc(t?.typeDesc || 'Select the type of diagram to generate')
            .addDropdown(dropdown => {
                for (const type of DIAGRAM_TYPES) {
                    dropdown.addOption(type.value, `${type.label} - ${type.description}`);
                }
                dropdown.setValue(this.diagramType);
                dropdown.onChange(value => {
                    this.diagramType = value as DiagramType;
                });
            });

        // Instruction text area
        new Setting(contentEl)
            .setName(t?.instructionLabel || 'What to diagram')
            .setDesc(t?.instructionDesc || 'Describe what you want to visualize. Examples: "the entire note", "the process in section 2", "the relationship between concepts"')
            .addTextArea(text => {
                text.setPlaceholder(t?.instructionPlaceholder || 'e.g., "Diagram the workflow described in this note" or "Create a mind map of the key concepts"');
                text.setValue(this.instruction);
                text.onChange(value => {
                    this.instruction = value;
                });
                // Make text area larger
                text.inputEl.rows = 4;
                text.inputEl.style.width = '100%';
            });

        // Examples section
        const examplesEl = contentEl.createDiv({ cls: 'ai-organiser-examples' });
        examplesEl.createEl('h4', { text: t?.examplesTitle || 'Example instructions:' });
        const examplesList = examplesEl.createEl('ul');
        const examples = [
            t?.example1 || 'Diagram the entire note as a mind map',
            t?.example2 || 'Create a flowchart of the process described',
            t?.example3 || 'Show the timeline of events mentioned',
            t?.example4 || 'Visualize the relationships between the concepts',
        ];
        for (const example of examples) {
            const li = examplesList.createEl('li');
            li.createEl('span', { text: example, cls: 'clickable-example' });
            li.onclick = () => {
                this.instruction = example;
                const textArea = contentEl.querySelector('textarea');
                if (textArea) {
                    (textArea as HTMLTextAreaElement).value = example;
                }
            };
        }

        // Submit button
        new Setting(contentEl)
            .addButton(button => {
                button
                    .setButtonText(t?.generateButton || 'Generate Diagram')
                    .setCta()
                    .onClick(() => {
                        if (!this.instruction.trim()) {
                            this.instruction = 'Diagram the entire note';
                        }
                        this.onSubmit({
                            diagramType: this.diagramType,
                            instruction: this.instruction.trim()
                        });
                        this.close();
                    });
            });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
