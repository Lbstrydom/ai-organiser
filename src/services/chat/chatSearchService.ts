import { App, TFile } from 'obsidian';
import type { Result } from '../../core/result';
import { ok, err } from '../../core/result';
import type { AIOrganiserSettings } from '../../core/settings';
import { getChatRootFullPath } from '../../core/settings';
import { logger } from '../../utils/logger';
import type { ChatMode } from '../../ui/chat/ChatModeHandler';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SearchFilters {
    mode?: ChatMode;
    projectId?: string;
    dateRange?: 'week' | 'month' | 'quarter' | 'year' | 'all';
}

export interface ExcerptSegment {
    text: string;
    highlight: boolean;
}

export interface SearchResult {
    filePath: string;
    title: string;
    mode: ChatMode;
    projectId?: string;
    projectName?: string;
    messageCount: number;
    updatedAt: string;
    excerptSegments: ExcerptSegment[];
}

// ─── Date range helpers ──────────────────────────────────────────────────────

const DATE_RANGE_DAYS: Record<string, number> = {
    week: 7,
    month: 30,
    quarter: 90,
    year: 365,
};

function isWithinDateRange(created: string, range: string): boolean {
    if (range === 'all') return true;
    const days = DATE_RANGE_DAYS[range];
    if (days === undefined) return true;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const parsed = new Date(created).getTime();
    return !isNaN(parsed) && parsed >= cutoff;
}

// ─── Frontmatter helpers ─────────────────────────────────────────────────────

const CHAT_MODE_RE = /^chat_mode:\s*(\S+)/m;
const PROJECT_ID_RE = /^project_id:\s*"([^"]+)"/m;
const CREATED_RE = /^created:\s*(.+)/m;
const TAGS_RE = /^tags:\s*\n((?:\s+-\s+.+\n?)*)/m;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

interface FrontmatterData {
    chatMode?: ChatMode;
    projectId?: string;
    created?: string;
    hasAiChatTag: boolean;
}

function parseFrontmatter(raw: string): FrontmatterData {
    const fmMatch = FRONTMATTER_RE.exec(raw);
    if (!fmMatch) return { hasAiChatTag: false };

    const fm = fmMatch[1];
    const modeMatch = CHAT_MODE_RE.exec(fm);
    const projMatch = PROJECT_ID_RE.exec(fm);
    const createdMatch = CREATED_RE.exec(fm);
    const tagsMatch = TAGS_RE.exec(fm);

    const hasAiChatTag = tagsMatch
        ? /- ai-chat\b/.test(tagsMatch[0])
        : false;

    return {
        chatMode: modeMatch ? modeMatch[1] as ChatMode : undefined,
        projectId: projMatch ? projMatch[1] : undefined,
        created: createdMatch ? createdMatch[1].trim() : undefined,
        hasAiChatTag,
    };
}

// ─── Message counting ────────────────────────────────────────────────────────

const MESSAGE_HEADER_RE = /^\*\*(You|Assistant)\*\*/gm;

function countMessages(searchableContent: string): number {
    const matches = searchableContent.match(MESSAGE_HEADER_RE);
    return matches ? matches.length : 0;
}

// ─── Title extraction ────────────────────────────────────────────────────────

function extractTitle(searchableContent: string, filePath: string): string {
    // First heading in the content
    const headingMatch = /^#\s+(.+)/m.exec(searchableContent);
    if (headingMatch) return headingMatch[1].trim();

    // Fall back to filename without extension
    const parts = filePath.split('/');
    const fileName = parts[parts.length - 1] ?? '';
    return fileName.replace(/\.md$/, '');
}

// ─── Service ─────────────────────────────────────────────────────────────────

const STATE_BLOB_RE = /<!--\s*chat-state-b64:[\s\S]*?-->/g;

export class ChatSearchService {
    private cache: Map<string, string> = new Map();

    constructor(
        private app: App,
        private settings: AIOrganiserSettings,
    ) {}

    /**
     * Search all conversations matching query and filters.
     * Returns Result<SearchResult[]>.
     */
    async search(query: string, filters: SearchFilters): Promise<Result<SearchResult[]>> {
        try {
            const rootPath = getChatRootFullPath(this.settings);
            const allFiles = this.app.vault.getMarkdownFiles();
            const chatFiles = allFiles.filter(f => f.path.startsWith(rootPath));

            const results: SearchResult[] = [];
            const lowerQuery = query.toLowerCase();

            for (const file of chatFiles) {
                const raw = await this.readCached(file);
                const fm = parseFrontmatter(raw);

                // Must be an ai-chat conversation file
                if (!fm.hasAiChatTag) continue;

                // Apply mode filter
                if (filters.mode && fm.chatMode !== filters.mode) continue;

                // Apply project filter
                if (filters.projectId && fm.projectId !== filters.projectId) continue;

                // Apply date range filter
                if (filters.dateRange && fm.created && !isWithinDateRange(fm.created, filters.dateRange)) continue;

                const searchable = this.extractSearchableContent(raw);

                // Match query (case-insensitive substring)
                if (lowerQuery && !searchable.toLowerCase().includes(lowerQuery)) continue;

                const excerptSegments = this.buildExcerpt(searchable, query);
                const title = extractTitle(searchable, file.path);
                const mode = fm.chatMode ?? 'free';

                results.push({
                    filePath: file.path,
                    title,
                    mode,
                    projectId: fm.projectId,
                    messageCount: countMessages(searchable),
                    updatedAt: fm.created ?? new Date(file.stat.mtime).toISOString(),
                    excerptSegments,
                });
            }

            // Sort by updatedAt descending
            results.sort((a, b) => {
                const ta = new Date(a.updatedAt).getTime() || 0;
                const tb = new Date(b.updatedAt).getTime() || 0;
                return tb - ta;
            });

            return ok(results);
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            logger.error('ChatSearch', `Search failed: ${message}`);
            return err(`Search failed: ${message}`);
        }
    }

    /**
     * Extract searchable text from conversation file.
     * Strips YAML frontmatter and base64 state blob.
     */
    extractSearchableContent(rawContent: string): string {
        // Strip frontmatter
        let content = rawContent.replace(FRONTMATTER_RE, '');

        // Strip base64 state blobs
        content = content.replace(STATE_BLOB_RE, '');

        return content.trim();
    }

    /**
     * Build excerpt segments with highlighted matches.
     * Safe rendering — no innerHTML needed (M10).
     */
    buildExcerpt(content: string, query: string, contextChars = 100): ExcerptSegment[] {
        if (!query) {
            return [{ text: content.slice(0, 200), highlight: false }];
        }

        const lowerContent = content.toLowerCase();
        const lowerQuery = query.toLowerCase();
        const idx = lowerContent.indexOf(lowerQuery);

        if (idx === -1) {
            return [{ text: content.slice(0, 200), highlight: false }];
        }

        const start = Math.max(0, idx - contextChars);
        const matchEnd = idx + query.length;
        const end = Math.min(content.length, matchEnd + contextChars);

        const segments: ExcerptSegment[] = [];

        const before = content.slice(start, idx);
        if (before) {
            segments.push({ text: (start > 0 ? '...' : '') + before, highlight: false });
        }

        segments.push({ text: content.slice(idx, matchEnd), highlight: true });

        const after = content.slice(matchEnd, end);
        if (after) {
            segments.push({ text: after + (end < content.length ? '...' : ''), highlight: false });
        }

        return segments;
    }

    /** Clear cached file contents. Call on modal close. */
    clearCache(): void {
        this.cache.clear();
    }

    // ─── Private ─────────────────────────────────────────────────────────────

    private async readCached(file: TFile): Promise<string> {
        const cached = this.cache.get(file.path);
        if (cached !== undefined) return cached;

        const content = await this.app.vault.cachedRead(file);
        this.cache.set(file.path, content);
        return content;
    }
}
