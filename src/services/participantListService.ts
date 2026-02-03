/**
 * Participant List Service
 * Manages persistent participant lists for meeting minutes.
 * Stored as markdown files in AI-Organiser/Meetings/participants/
 */

import { App, TFile, TFolder, normalizePath } from 'obsidian';

export interface ParticipantList {
    id: string;
    name: string;
    entries: string[];  // Raw lines: "Name | Title | Company"
    createdAt: string;
    updatedAt: string;
}

const PARTICIPANTS_FOLDER = 'participants';

export class ParticipantListService {
    private app: App;
    private configFolder: string;

    constructor(app: App, configFolder: string) {
        this.app = app;
        this.configFolder = configFolder;
    }

    getParticipantsFolder(): string {
        return normalizePath(`${this.configFolder}/${PARTICIPANTS_FOLDER}`);
    }

    private async ensureFolder(): Promise<void> {
        const folderPath = this.getParticipantsFolder();
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!folder) {
            try {
                await this.app.vault.createFolder(folderPath);
            } catch {
                // Folder may already exist
            }
        }
    }

    async listParticipantLists(): Promise<ParticipantList[]> {
        await this.ensureFolder();
        const folderPath = this.getParticipantsFolder();
        const folder = this.app.vault.getAbstractFileByPath(folderPath);

        if (!folder || !(folder instanceof TFolder)) {
            return [];
        }

        const lists: ParticipantList[] = [];
        for (const child of folder.children) {
            if (child instanceof TFile && child.extension === 'md') {
                try {
                    const list = await this.loadFromFile(child);
                    if (list) lists.push(list);
                } catch {
                    console.warn(`[AI Organiser] Failed to load participant list: ${child.path}`);
                }
            }
        }

        return lists.sort((a, b) => a.name.localeCompare(b.name));
    }

    async getById(id: string): Promise<ParticipantList | null> {
        const path = normalizePath(`${this.getParticipantsFolder()}/${id}.md`);
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!file || !(file instanceof TFile)) return null;
        return this.loadFromFile(file);
    }

    async createParticipantList(name: string, entries: string[]): Promise<ParticipantList> {
        let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        // Fallback for non-Latin names that produce empty slug
        if (!id) {
            id = `list-${Date.now()}`;
        }
        // Prevent silent overwrites — append counter if id already exists
        const baseId = id;
        let counter = 1;
        while (await this.getById(id)) {
            id = `${baseId}-${counter}`;
            counter++;
        }
        const now = new Date().toISOString();
        const list: ParticipantList = { id, name, entries, createdAt: now, updatedAt: now };
        await this.save(list);
        return list;
    }

    async save(list: ParticipantList): Promise<string> {
        await this.ensureFolder();
        list.updatedAt = new Date().toISOString();

        const path = normalizePath(`${this.getParticipantsFolder()}/${list.id}.md`);
        const content = this.serialize(list);

        const existing = this.app.vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) {
            await this.app.vault.modify(existing, content);
        } else {
            await this.app.vault.create(path, content);
        }
        return path;
    }

    private async loadFromFile(file: TFile): Promise<ParticipantList | null> {
        const content = await this.app.vault.read(file);
        return this.parse(content, file.basename);
    }

    private parse(content: string, fallbackId: string): ParticipantList | null {
        let name = fallbackId;
        let createdAt = '';
        let updatedAt = '';
        let body = content;

        // Parse YAML frontmatter
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
        if (fmMatch) {
            const yaml = fmMatch[1];
            body = fmMatch[2];

            const nameMatch = yaml.match(/^name:\s*(.+)$/m);
            if (nameMatch) name = nameMatch[1].trim();

            const createdMatch = yaml.match(/^created:\s*(.+)$/m);
            if (createdMatch) createdAt = createdMatch[1].trim();

            const updatedMatch = yaml.match(/^updated:\s*(.+)$/m);
            if (updatedMatch) updatedAt = updatedMatch[1].trim();
        }

        const entries = body
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0 && !line.startsWith('#'));

        return { id: fallbackId, name, entries, createdAt, updatedAt };
    }

    private serialize(list: ParticipantList): string {
        const lines = [
            '---',
            `name: ${list.name}`,
            `created: ${list.createdAt}`,
            `updated: ${list.updatedAt}`,
            '---',
            '',
            ...list.entries,
            '',
        ];
        return lines.join('\n');
    }
}
