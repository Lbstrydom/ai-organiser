/**
 * MermaidTemplateService — Phase 4
 * Manages user-defined and built-in Mermaid diagram templates stored in
 * AI-Organiser/Config/mermaid-templates.md.
 */

import { App, TFile, normalizePath } from 'obsidian';
import type AIOrganiserPlugin from '../main';

export interface MermaidTemplate {
    name: string;
    description: string;
    type: string;   // e.g. 'flowchart', 'sequenceDiagram', 'mindmap', ...
    code: string;
}

/** Built-in fallback templates shown when the config file is missing or empty. */
export const FALLBACK_TEMPLATES: MermaidTemplate[] = [
    {
        name: 'Simple Flowchart',
        description: 'A basic top-down flowchart with start and end nodes.',
        type: 'flowchart',
        code: 'flowchart TD\n    A([Start]) --> B[Step 1]\n    B --> C[Step 2]\n    C --> D([End])',
    },
    {
        name: 'Sequence Diagram',
        description: 'Shows interactions between two parties over time.',
        type: 'sequenceDiagram',
        code: 'sequenceDiagram\n    participant A as Actor A\n    participant B as Actor B\n    A->>B: Request\n    B-->>A: Response',
    },
    {
        name: 'Mind Map',
        description: 'Radial mind map around a central topic.',
        type: 'mindmap',
        code: 'mindmap\n  root((Topic))\n    Branch A\n      Subtopic 1\n      Subtopic 2\n    Branch B\n      Subtopic 3',
    },
    {
        name: 'Gantt Chart',
        description: 'Simple project timeline with sections and tasks.',
        type: 'gantt',
        code: 'gantt\n    title Project Timeline\n    dateFormat YYYY-MM-DD\n    section Phase 1\n    Task A           :a1, 2025-01-01, 7d\n    Task B           :a2, after a1, 5d\n    section Phase 2\n    Task C           :b1, after a2, 10d',
    },
];

export class MermaidTemplateService {
    private readonly app: App;
    private readonly plugin: AIOrganiserPlugin;

    constructor(app: App, plugin: AIOrganiserPlugin) {
        this.app = app;
        this.plugin = plugin;
    }

    /** Load templates from the config file, falling back to built-ins if unavailable. */
    async loadTemplates(): Promise<MermaidTemplate[]> {
        try {
            const path = this.getTemplatePath();
            const file = this.app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) return FALLBACK_TEMPLATES;
            const content = await this.app.vault.cachedRead(file);
            const parsed = this.parseTemplateFile(content);
            return parsed.length > 0 ? parsed : FALLBACK_TEMPLATES;
        } catch {
            return FALLBACK_TEMPLATES;
        }
    }

    /**
     * Append a new template section to the config file.
     * Creates the file from the configurationService default content if it doesn't exist.
     */
    async saveAsTemplate(template: MermaidTemplate): Promise<void> {
        const path = this.getTemplatePath();
        let file = this.app.vault.getAbstractFileByPath(path);

        const section = this.formatTemplateSection(template);

        if (file instanceof TFile) {
            const existing = await this.app.vault.read(file);
            await this.app.vault.modify(file, existing + '\n\n---\n\n' + section);
        } else {
            // Ensure folder exists
            const folder = normalizePath(path.substring(0, path.lastIndexOf('/')));
            try { await this.app.vault.createFolder(folder); } catch { /* already exists */ }
            await this.app.vault.create(path, '# Mermaid Diagram Templates\n\n---\n\n' + section);
        }
    }

    /** Parse the template markdown file into an array of MermaidTemplate objects. */
    parseTemplateFile(content: string): MermaidTemplate[] {
        const templates: MermaidTemplate[] = [];
        // Split on hr markers (---) to separate each template block
        const sections = content.split(/\n---\n/);
        for (const section of sections) {
            const template = this.parseTemplateSection(section);
            if (template) templates.push(template);
        }
        return templates;
    }

    // ─── private helpers ──────────────────────────────────────────────────────

    private getTemplatePath(): string {
        const configService = this.plugin.configService;
        if (configService) {
            const paths = configService.getConfigPaths();
            return paths.mermaidTemplates;
        }
        // Fallback
        const pluginFolder = this.plugin.settings.pluginFolder ?? 'AI-Organiser';
        const configFolder = this.plugin.settings.configFolderPath ?? 'Config';
        return normalizePath(`${pluginFolder}/${configFolder}/mermaid-templates.md`);
    }

    /** Parse a single ### section into a MermaidTemplate. Returns null if invalid. */
    private parseTemplateSection(section: string): MermaidTemplate | null {
        const lines = section.trim().split('\n');
        if (lines.length < 3) return null;

        // First non-empty line starting with ### is the name
        let name = '';
        let type = '';
        let descriptionLines: string[] = [];
        let codeLines: string[] = [];
        let inCode = false;

        for (const line of lines) {
            const stripped = line.trim();
            if (!name && stripped.startsWith('### ')) {
                // Name line: "### My Template [type: flowchart]"
                const typeMatch = stripped.match(/\[type:\s*([^\]]+)\]/);
                type = typeMatch ? typeMatch[1].trim() : '';
                name = stripped
                    .replace(/^###\s+/, '')
                    .replace(/\[type:[^\]]*\]/g, '')
                    .trim();
                continue;
            }
            if (!name) continue; // skip content before the ### header

            if (stripped.startsWith('```mermaid')) {
                inCode = true;
                continue;
            }
            if (stripped.startsWith('```') && inCode) {
                inCode = false;
                continue;
            }
            if (inCode) {
                codeLines.push(line);
                continue;
            }
            // Description lines start with >
            if (stripped.startsWith('> ')) {
                descriptionLines.push(stripped.slice(2).trim());
            }
        }

        if (!name || codeLines.length === 0) return null;

        // Infer type from first code line if not specified
        if (!type && codeLines.length > 0) {
            type = codeLines[0].trim().split(/\s+/)[0] ?? '';
        }

        return {
            name,
            description: descriptionLines.join(' ').trim(),
            type,
            code: codeLines.join('\n').trim(),
        };
    }

    private formatTemplateSection(template: MermaidTemplate): string {
        const typeTag = template.type ? ` [type: ${template.type}]` : '';
        const descLine = template.description ? `> ${template.description}\n\n` : '';
        return `### ${template.name}${typeTag}\n${descLine}\`\`\`mermaid\n${template.code}\n\`\`\``;
    }
}
