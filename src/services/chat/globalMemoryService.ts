import { App, TFile } from 'obsidian';
import type { AIOrganiserSettings } from '../../core/settings';
import { getChatRootFullPath } from '../../core/settings';
import { ensureFolderExists } from '../../utils/minutesUtils';

export const MAX_GLOBAL_MEMORY_ITEMS = 50;
const PLACEHOLDER_TEXT = '_No preferences saved yet._';

export class GlobalMemoryService {
    constructor(private readonly app: App, private readonly settings: AIOrganiserSettings) {}

    /** Load all memory items. Returns [] if file missing or empty. */
    async loadMemory(): Promise<string[]> {
        const path = this.getFilePath();
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return [];
        const content = await this.app.vault.read(file);
        return this.parseFile(content);
    }

    /** Add a fact. Returns false if duplicate (case-insensitive) or at capacity. */
    async addMemory(fact: string): Promise<boolean> {
        const items = await this.loadMemory();
        if (items.length >= MAX_GLOBAL_MEMORY_ITEMS) return false;
        if (items.some(i => i.toLowerCase() === fact.toLowerCase())) return false;
        items.push(fact);
        await this.saveAll(items);
        return true;
    }

    /** Remove a fact by exact text match. */
    async removeMemory(fact: string): Promise<void> {
        const items = await this.loadMemory();
        const filtered = items.filter(i => i !== fact);
        await this.saveAll(filtered);
    }

    /** Overwrite all items (used by edit modal Save). */
    async saveAll(items: string[]): Promise<void> {
        const path = this.getFilePath();
        const content = this.buildFileContent(items);
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
            await this.app.vault.modify(file, content);
        } else {
            await ensureFolderExists(this.app.vault, path.substring(0, path.lastIndexOf('/')));
            await this.app.vault.create(path, content);
        }
    }

    private getFilePath(): string {
        return `${getChatRootFullPath(this.settings)}/_global_memory.md`;
    }

    private parseFile(content: string): string[] {
        return content
            .split('\n')
            .filter(line => line.startsWith('- '))
            .map(line => line.slice(2).trim())
            .filter(line => line && line !== PLACEHOLDER_TEXT);
    }

    private buildFileContent(items: string[]): string {
        const body = items.length > 0
            ? items.map(i => `- ${i}`).join('\n')
            : PLACEHOLDER_TEXT;
        return `# Global Memory\n\n## Preferences\n${body}\n`;
    }
}
