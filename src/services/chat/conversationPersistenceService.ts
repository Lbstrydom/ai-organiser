import { App, TFile } from 'obsidian';
import type { AIOrganiserSettings } from '../../core/settings';
import { getChatRootFullPath } from '../../core/settings';
import { ensureFolderExists, getAvailableFilePath } from '../../utils/minutesUtils';
import type { ConversationState, ConversationSummary } from '../../utils/chatExportUtils';
import { serializeConversationNote, extractConversationState } from '../../utils/chatExportUtils';

/** Alias for ConversationSummary — used by resume picker and list views. */
export type RecentConversation = ConversationSummary;

export class ConversationPersistenceService {
    private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private currentFiles = new Map<string, TFile | null>();

    constructor(private app: App, private settings: AIOrganiserSettings) {}

    /** Fire-and-forget debounced save (1-second debounce per mode) */
    scheduleSave(state: ConversationState): void {
        const mode = state.mode;
        const existing = this.saveTimers.get(mode);
        if (existing) clearTimeout(existing);
        this.saveTimers.set(mode, setTimeout(() => {
            this.saveTimers.delete(mode);
            void this.doSave(state);
        }, 1000));
    }

    /** Awaitable immediate save */
    async saveNow(state: ConversationState): Promise<string> {
        this.cancelPending(state.mode);
        return this.doSave(state);
    }

    /** Load conversation state from a vault note */
    async load(filePath: string): Promise<ConversationState | null> {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) return null;
        const content = await this.app.vault.cachedRead(file);
        return extractConversationState(content);
    }

    /** List recent conversations sorted by updatedAt descending */
    async listRecent(limit = 20, projectId?: string): Promise<ConversationSummary[]> {
        const rootPath = getChatRootFullPath(this.settings);
        const results: ConversationSummary[] = [];

        const allFiles = this.app.vault.getMarkdownFiles();
        for (const file of allFiles) {
            if (!file.path.startsWith(rootPath + '/')) continue;

            const content = await this.app.vault.cachedRead(file);
            const state = extractConversationState(content);
            if (!state) continue;
            if (projectId !== undefined && state.projectId !== projectId) continue;

            const nonSystemMsgs = state.messages.filter(m => m.role !== 'system');
            const userMsgs = nonSystemMsgs.filter(m => m.role === 'user');
            const firstUser = userMsgs[0];
            const derivedTitle = firstUser
                ? firstUser.content.slice(0, 80).replace(/\n/g, ' ')
                : file.basename;
            const title = state.customTitle ?? derivedTitle;

            const ts = state.updatedAt ?? state.lastActiveAt ?? new Date().toISOString();
            results.push({
                filePath: file.path,
                title,
                mode: state.mode,
                messageCount: userMsgs.length,
                projectId: state.projectId,
                createdAt: state.createdAt,
                updatedAt: ts,
                lastActiveAt: ts,
                slideCount: extractSlideCount(state),
            });
        }

        results.sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
        return results.slice(0, limit);
    }

    /**
     * Rename a conversation by setting its customTitle.
     * Reads the file, patches the state, and re-serialises in place.
     * Returns false if the file could not be found or parsed.
     */
    async renameConversation(filePath: string, newTitle: string): Promise<boolean> {
        // getAbstractFileByPath (not getFileByPath — which doesn't exist on
        // Vault) matches the pattern used in load/delete above. Calling the
        // non-existent method would throw TypeError at runtime. Gemini gate
        // G1 (2026-04-21).
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) return false;
        const content = await this.app.vault.read(file);
        const state = extractConversationState(content);
        if (!state) return false;
        state.customTitle = newTitle.trim() || undefined;
        state.updatedAt = new Date().toISOString();
        await this.app.vault.modify(file, serializeConversationNote(state));
        return true;
    }

    /** Start a new conversation for a mode (clears all project and bare entries for that mode) */
    startNew(mode: string): void {
        this.cancelPending(mode);
        // Clear bare mode entry and all project entries for this mode
        for (const key of Array.from(this.currentFiles.keys())) {
            if (key === mode || key.startsWith(`${mode}::`)) {
                this.currentFiles.delete(key);
            }
        }
    }

    /** Set the current file for a mode (used when resuming) */
    setCurrentFile(mode: string, file: TFile | null): void {
        this.currentFiles.set(mode, file);
    }

    /** Return the vault path of the current conversation file for a mode, or null if unsaved. */
    getCurrentFilePath(mode: string): string | null {
        return this.currentFiles.get(mode)?.path ?? null;
    }

    /** Cancel pending save for a mode */
    cancelPending(mode: string): void {
        const timer = this.saveTimers.get(mode);
        if (timer) { clearTimeout(timer); this.saveTimers.delete(mode); }
    }

    /** Cancel all pending saves */
    cancelAllPending(): void {
        for (const timer of this.saveTimers.values()) clearTimeout(timer);
        this.saveTimers.clear();
    }

    /** Clear all cached TFiles so next save creates new files for all modes */
    clearCache(): void {
        this.currentFiles.clear();
    }

    /** Move a conversation file to a target folder */
    async moveConversation(filePath: string, targetFolder: string): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) throw new Error('File not found: ' + filePath);
        const newPath = `${targetFolder}/${file.name}`;
        await this.app.fileManager.renameFile(file, newPath);
    }

    /** Delete a conversation by path (moves to trash) */
    async delete(filePath: string): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) return;
        await this.app.fileManager.trashFile(file);
    }

    /** Prune old conversations from inbox subfolders (not Projects/) */
    async pruneOldConversations(retentionDays: number): Promise<number> {
        if (retentionDays === 0) return 0;
        const rootPath = getChatRootFullPath(this.settings);
        const inboxPrefix = `${rootPath}/Conversations/`;
        const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

        const allFiles = this.app.vault.getMarkdownFiles();
        let deleted = 0;
        for (const file of allFiles) {
            if (!file.path.startsWith(inboxPrefix)) continue;
            const content = await this.app.vault.cachedRead(file);
            const state = extractConversationState(content);
            const ts = state?.updatedAt ?? state?.lastActiveAt ?? '';
            if (ts && ts < cutoff) {
                await this.app.fileManager.trashFile(file);
                deleted++;
            }
        }
        return deleted;
    }

    private cacheKey(state: ConversationState): string {
        return state.projectId ? `${state.mode}::${state.projectId}` : state.mode;
    }

    private async doSave(state: ConversationState): Promise<string> {
        const key = this.cacheKey(state);
        const targetFile = this.currentFiles.get(key) ?? null;
        const now = new Date().toISOString();
        const ts = state.updatedAt ?? now;
        const stateWithTime: ConversationState = { ...state, lastActiveAt: ts, updatedAt: ts };
        const content = serializeConversationNote(stateWithTime);

        if (targetFile) {
            try {
                await this.app.vault.modify(targetFile, content);
                return targetFile.path;
            } catch {
                // File may have been deleted — fall through to create a new one
                this.currentFiles.delete(key);
            }
        }
        const path = await this.buildFilePath(state);
        await ensureFolderExists(this.app.vault, path.substring(0, path.lastIndexOf('/')));
        const newFile = await this.app.vault.create(path, content);
        this.currentFiles.set(key, newFile);
        return newFile.path;
    }

    private async buildFilePath(state: ConversationState): Promise<string> {
        const rootPath = getChatRootFullPath(this.settings);
        let folderPath: string;

        if (state.projectFolderPath) {
            // Use direct project folder path when provided
            folderPath = state.projectFolderPath;
        } else {
            // Route to mode subfolder (fallback for projectId-only or inbox chats)
            folderPath = `${rootPath}/Conversations/${state.mode}`;
        }

        const dateStr = new Date().toISOString().slice(0, 10);
        const nonSystem = state.messages.filter(m => m.role !== 'system');
        const firstUser = nonSystem.find(m => m.role === 'user');
        const slug = firstUser
            ? firstUser.content.slice(0, 60).replace(/[/\\:*?"<>|#^[\]]/g, '-').replace(/\s{2,}/g, ' ').trim()
            : `Chat-${dateStr}`;
        const fileName = `${slug || 'Chat'}.md`;

        return await getAvailableFilePath(this.app.vault, folderPath, fileName);
    }
}

/** Extract slide count from a presentation snapshot without importing DOM utilities. */
function extractSlideCount(state: import('../../utils/chatExportUtils').ConversationState): number | undefined {
    if (state.mode !== 'presentation' || !state.presentationSnapshot) return undefined;
    const html = (state.presentationSnapshot as { html?: string }).html;
    if (!html) return undefined;
    const count = (html.match(/class="slide["\s]/g) ?? []).length;
    return count > 0 ? count : undefined;
}
