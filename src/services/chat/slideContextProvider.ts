/**
 * Slide Context Provider
 *
 * Bridges the presentation service to the existing vault + research APIs
 * for the targeted slide editing feature. The service consumes the
 * `SlideContextProvider` interface — never `App` or `ResearchSearchService`
 * directly — so backend code stays testable in isolation (DIP).
 *
 * Plan: docs/completed/slide-authoring-editing-backend.md §"Source resolution"
 */

import type { App, TFile } from 'obsidian';
import { TFile as TFileClass, TFolder as TFolderClass, normalizePath } from 'obsidian';
import type { ResearchSearchService } from '../research/researchSearchService';
import {
    FOLDER_MAX_FILES,
    FOLDER_TOTAL_BUDGET_CHARS,
    FOLDER_PER_FILE_MIN_CHARS,
    REFERENCES_BUDGET_CHARS,
    REFERENCES_PER_NOTE_MIN_CHARS,
    WEB_RESEARCH_RESULT_COUNT,
} from './presentationConstants';
import { logger } from '../../utils/logger';

/** Abstraction over the gather-context surface that scoped edits need.
 *  Service depends on this; constructor-inject the concrete implementation.
 *
 *  **Empty-string semantics** (H7 design choice, 2026-04-25): all three
 *  methods return empty string for "no context to add" regardless of cause —
 *  consent denied, network failure, missing files, abort signal, empty result.
 *  This is intentional and matches the existing research/audio specialist
 *  pattern: the user's edit proceeds without that context, and reasons for
 *  the empty are surfaced via `logger.warn` on the failure path. The
 *  alternative (typed `Result<T>` per call) would force the orchestrator
 *  to map every failure into a partial-context decision the user has
 *  already implicitly made by enabling/disabling the corresponding flag.
 *
 *  Failures that should hard-stop the operation throw exceptions; the
 *  orchestrator catches and converts to `Result<T>.err` at the service
 *  boundary. Empty string is "soft" failure — user gets less context, edit
 *  still applies. */
export interface SlideContextProvider {
    /** Fetch web research snippets for a query. Returns a pre-rendered text
     *  block ready to slot into the prompt's `<web_research>` section, or
     *  empty string when web search is not used / fails / consent denied. */
    fetchWebResearch(query: string, signal?: AbortSignal): Promise<string>;

    /** Read named reference notes, truncate per-note within total budget,
     *  return a pre-rendered `<reference_note>` block, or empty string. */
    readReferences(notePaths: string[], signal?: AbortSignal): Promise<string>;

    /** Enumerate a folder, rank by recency, truncate within budget, return
     *  a pre-rendered block of `<reference_note path="…">…</reference_note>`,
     *  or empty string when folder doesn't exist / is empty / abort fired. */
    readFolder(folderPath: string, signal?: AbortSignal): Promise<string>;
}

// ── Default implementation ──────────────────────────────────────────────────

export interface DefaultSlideContextProviderDeps {
    app: App;
    researchService: ResearchSearchService;
    /** Async gate — typically wraps `ensurePrivacyConsent(plugin, serviceType)`.
     *  Called once per fetchWebResearch invocation; returns true to proceed. */
    privacyConsent: () => Promise<boolean>;
}

/**
 * Concrete provider that bridges presentation service to vault + research.
 * Constructor-injected so unit tests can swap in fakes; production code
 * builds it inside PresentationModeHandler.runScopedEdit.
 */
export class DefaultSlideContextProvider implements SlideContextProvider {
    constructor(private deps: DefaultSlideContextProviderDeps) {}

    async fetchWebResearch(query: string, signal?: AbortSignal): Promise<string> {
        if (signal?.aborted) return '';
        const consent = await this.deps.privacyConsent();
        if (!consent) return '';  // soft-skip: user explicitly declined
        if (signal?.aborted) return '';

        // Network/provider errors PROPAGATE per the failure-mode policy in
        // the backend plan — user can retry, possibly without web search.
        // Soft-fail is reserved for consent denial, which is an explicit
        // user choice (Gemini final-gate finding 2026-04-25).
        const results = await this.deps.researchService.search([query], {
            maxResults: WEB_RESEARCH_RESULT_COUNT,
            dateRange: 'recent',
        });
        if (signal?.aborted) return '';

        return results
            .slice(0, WEB_RESEARCH_RESULT_COUNT)
            .map((r, i) => `[${i + 1}] ${r.title} — ${r.url}\n  ${r.snippet}`)
            .join('\n\n');
    }

    async readReferences(notePaths: string[], signal?: AbortSignal): Promise<string> {
        if (signal?.aborted) return '';
        if (notePaths.length === 0) return '';

        const allocation = Math.floor(REFERENCES_BUDGET_CHARS / notePaths.length);
        if (allocation < REFERENCES_PER_NOTE_MIN_CHARS) {
            // Too many references; cap how many we read.
            const maxKept = Math.floor(REFERENCES_BUDGET_CHARS / REFERENCES_PER_NOTE_MIN_CHARS);
            notePaths = notePaths.slice(0, maxKept);
        }

        const perNote = Math.floor(REFERENCES_BUDGET_CHARS / notePaths.length);
        const blocks: string[] = [];

        // Explicit user-named references: errors PROPAGATE so the orchestrator
        // can surface "could not read reference: <path>" via err(). The user
        // chose these notes specifically — silently skipping a missing one
        // would land an edit grounded in fewer references than they expected.
        for (const path of notePaths) {
            if (signal?.aborted) return blocks.join('\n\n');
            const content = await this.readNoteOrThrow(path, perNote);
            if (content) blocks.push(`<reference_note path="${escapeAttr(path)}">\n${content}\n</reference_note>`);
        }

        return blocks.join('\n\n');
    }

    async readFolder(folderPath: string, signal?: AbortSignal): Promise<string> {
        if (signal?.aborted) return '';

        const normalised = normalizePath(folderPath);
        const folder = this.deps.app.vault.getAbstractFileByPath(normalised);
        if (!folder || !(folder instanceof TFolderClass)) {
            logger.warn('SlideContext', `Folder not found: ${normalised}`);
            return '';
        }

        const files = collectMarkdownFiles(folder)
            .sort((a, b) => b.stat.mtime - a.stat.mtime);

        const cappedFiles = files.slice(0, FOLDER_MAX_FILES);
        if (cappedFiles.length === 0) return '';

        const allocation = Math.floor(FOLDER_TOTAL_BUDGET_CHARS / cappedFiles.length);
        if (allocation < FOLDER_PER_FILE_MIN_CHARS) {
            // Allocation too small — drop tail files until each survivor gets ≥ min.
            const maxKept = Math.floor(FOLDER_TOTAL_BUDGET_CHARS / FOLDER_PER_FILE_MIN_CHARS);
            cappedFiles.length = Math.min(cappedFiles.length, maxKept);
        }

        const perFile = Math.floor(FOLDER_TOTAL_BUDGET_CHARS / cappedFiles.length);
        const blocks: string[] = [];

        for (const file of cappedFiles) {
            if (signal?.aborted) return blocks.join('\n\n');
            const content = await this.readNoteSafe(file.path, perFile);
            if (content) blocks.push(`<reference_note path="${escapeAttr(file.path)}">\n${content}\n</reference_note>`);
        }

        if (files.length > FOLDER_MAX_FILES) {
            blocks.push(`<reference_note note="folder cap reached">\nFolder contained ${files.length} files; included the ${cappedFiles.length} most recently edited.\n</reference_note>`);
        }

        return blocks.join('\n\n');
    }

    /** Read + truncate a single note. Returns '' on missing file or read
     *  failure. Used by `readFolder` where individual file failures
     *  should NOT abort the whole folder enumeration. */
    private async readNoteSafe(path: string, budgetChars: number): Promise<string> {
        const file = this.deps.app.vault.getAbstractFileByPath(path);
        if (!file || !(file instanceof TFileClass)) return '';
        try {
            const raw = await this.deps.app.vault.cachedRead(file);
            return truncateAtSentence(raw, budgetChars);
        } catch (e) {
            logger.warn('SlideContext', `Could not read ${path}: ${e instanceof Error ? e.message : String(e)}`);
            return '';
        }
    }

    /** Read + truncate a single note. THROWS on missing file or read
     *  failure. Used by `readReferences` where the user explicitly named
     *  the note and a silent skip would mislead them. */
    private async readNoteOrThrow(path: string, budgetChars: number): Promise<string> {
        const file = this.deps.app.vault.getAbstractFileByPath(path);
        if (!file || !(file instanceof TFileClass)) {
            throw new Error(`reference note not found: ${path}`);
        }
        const raw = await this.deps.app.vault.cachedRead(file);
        return truncateAtSentence(raw, budgetChars);
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function collectMarkdownFiles(folder: TFolder): TFile[] {
    const out: TFile[] = [];
    for (const child of folder.children) {
        if (child instanceof TFileClass && child.extension === 'md') {
            out.push(child);
        } else if (child instanceof TFolderClass) {
            out.push(...collectMarkdownFiles(child));
        }
    }
    return out;
}

/** Truncate text at a sentence boundary near the budget, with ellipsis marker. */
function truncateAtSentence(text: string, budgetChars: number): string {
    if (text.length <= budgetChars) return text;
    const slice = text.slice(0, budgetChars);
    // Find last sentence-ending punctuation in the slice.
    const lastPeriod = Math.max(
        slice.lastIndexOf('. '),
        slice.lastIndexOf('! '),
        slice.lastIndexOf('? '),
        slice.lastIndexOf('.\n'),
    );
    const cut = lastPeriod > budgetChars * 0.7 ? lastPeriod + 1 : budgetChars;
    return slice.slice(0, cut).trimEnd() + '\n\n[…truncated for prompt budget]';
}

function escapeAttr(value: string): string {
    return value.replaceAll('"', '&quot;');
}

// Type re-export so tests don't need to import from obsidian directly.
type TFolder = InstanceType<typeof TFolderClass>;
