/**
 * Presentation Source Service
 *
 * Resolves user-chosen `SelectedSource[]` into prompt-ready `PromptSource[]`.
 * Owns folder expansion, vault reads, web-search dispatch, dedup, error
 * capture. Pure resolver — does NOT decide whether to block generation.
 * The post-resolution generation gate lives on `CreationSourceController`
 * (audit Gemini-r3-G1).
 *
 * Plan: docs/completed/slide-authoring-followup-implementation.md (Items 1, 2,
 * audit H1/H5/H6/M7/M9/Gemini-r4-G3).
 */

import { App, TFile, TFolder } from 'obsidian';
import { logger } from '../../utils/logger';
import type {
    SelectedSource,
    PromptSource,
    SourceFailureCode,
    AudienceTier,
    ModelTier,
    CreationConfig,
} from './presentationTypes';
import type { Result } from '../../core/result';
import { ok, err } from '../../core/result';

// The resolver reads FULL source content; the single, model-aware truncation
// point is `allocateBudget` (presentationSourceBudget.ts) at submit time, so
// substantial sources aren't pre-chopped before the budget even sees them.
const DEFAULT_FOLDER_CAP = 50;

export interface SourceFailure {
    selected: SelectedSource;
    code: SourceFailureCode;
    /** Optional raw error string for debug logs — never rendered directly. */
    debugMessage?: string;
}

export interface ResolveResult {
    usable: PromptSource[];
    failures: SourceFailure[];
    /** mtime per resolved file path; controller caches this for invalidation. */
    mtimeByPath: Map<string, number>;
    /** Folder kind only: stable signature of enumerated path-set per folder ref. */
    folderPathsSignature?: Map<string, string>;
}

/** Optional research dispatcher contract. Loose to avoid coupling to the
 *  full ResearchSearchService import surface — accepts any object exposing
 *  a `search(query, opts)` returning a string. */
export interface WebSearchDispatcher {
    search(query: string, opts?: { signal?: AbortSignal }): Promise<string>;
}

/** Context handed to a query-grounding function: the deck's description/topic
 *  plus excerpts from already-resolved note/folder sources. */
export interface WebSearchGroundingContext {
    /** The user's deck prompt / description, if any. */
    description?: string;
    /** Leading excerpts of resolved note/folder content (capped). */
    noteExcerpts: string[];
}

/** Optional LLM-backed query grounder. Given the user's literal web-search
 *  query and the deck's note/description context, returns a focused query that
 *  anchors the search in that context. MUST NOT throw to the caller — the
 *  service falls back to the literal query on any failure or empty result. */
export type WebSearchGroundingFn = (
    literalQuery: string,
    context: WebSearchGroundingContext,
    signal?: AbortSignal,
) => Promise<string>;

/** Grounding context caps — keep the grounding prompt bounded regardless of
 *  how many/large the attached notes are (audit M2/M14: description was
 *  previously unbounded). */
const GROUNDING_MAX_NOTE_EXCERPTS = 6;
const GROUNDING_EXCERPT_CHARS = 1500;
const GROUNDING_DESCRIPTION_CHARS = 2000;
/** Service-side cap on the grounded query actually dispatched — defence in
 *  depth so a chatty grounder can't push an unbounded string to the search
 *  provider even if the caller forgets to clamp (audit M1/M14). */
const GROUNDED_QUERY_DISPATCH_CHARS = 256;

/** Extra options for {@link PresentationSourceService.resolve}. */
export interface ResolveOptions {
    folderCap?: number;
    signal?: AbortSignal;
    /** When present, web-search queries are LLM-grounded in the deck's notes +
     *  description before dispatch (Option A). Absent ⟹ literal-query search. */
    groundWebSearchQuery?: WebSearchGroundingFn;
    /** The deck prompt/description, fed to the grounding function as context. */
    deckDescription?: string;
}

export class PresentationSourceService {
    constructor(
        private readonly app: App,
        private readonly research: WebSearchDispatcher | null,
    ) {}

    /** Pure detection — returns SelectedSource for active md file, or null. */
    detectActiveNote(): SelectedSource | null {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return null;
        return { kind: 'note', ref: file.path, autoDetected: true };
    }

    /**
     * Resolve user-chosen sources into prompt-ready content. Errors are
     * captured per-source as `SourceFailure` entries — never thrown.
     * Dedup: by (kind, ref); standalone-note wins over folder-derived dup.
     */
    async resolve(
        selected: ReadonlyArray<SelectedSource>,
        opts: ResolveOptions = {},
    ): Promise<ResolveResult> {
        const folderCap = opts.folderCap ?? DEFAULT_FOLDER_CAP;
        const usable: PromptSource[] = [];
        const failures: SourceFailure[] = [];
        const mtimeByPath = new Map<string, number>();
        const folderPathsSignature = new Map<string, string>();
        const standaloneNotePaths = new Set<string>();

        // First pass: collect standalone note refs so folder dedup can drop them.
        for (const src of selected) {
            if (src.kind === 'note') standaloneNotePaths.add(src.ref);
        }

        // Two-phase: resolve notes/folders BEFORE web-search so the web-search
        // grounder can anchor its query in the already-resolved note content
        // (Option A). Web-search sources are processed last, in selection order.
        const webSearchSources: SelectedSource[] = [];
        for (const src of selected) {
            if (opts.signal?.aborted) break;
            if (src.kind === 'note') {
                await this.resolveNoteInto(src, usable, failures, mtimeByPath);
            } else if (src.kind === 'folder') {
                await this.resolveFolderInto(
                    src, usable, failures, mtimeByPath, folderPathsSignature,
                    folderCap, standaloneNotePaths,
                );
            } else if (src.kind === 'web-search') {
                webSearchSources.push(src);
            } else {
                failures.push({ selected: src, code: 'unsupported-kind' });
            }
        }

        if (webSearchSources.length > 0) {
            // Build grounding context once from the resolved note/folder content.
            const groundingContext = this.buildGroundingContext(usable, opts.deckDescription);
            for (const src of webSearchSources) {
                if (opts.signal?.aborted) break;
                await this.resolveWebSearchInto(
                    src, usable, failures, opts.signal,
                    opts.groundWebSearchQuery, groundingContext,
                );
            }
        }

        return { usable, failures, mtimeByPath, folderPathsSignature };
    }

    /** Assemble bounded grounding context from resolved note/folder sources.
     *  Standalone notes (explicitly chosen by the user) are prioritised over
     *  folder-derived ones, so a large attached folder can't crowd the few
     *  hand-picked notes out of the excerpt budget (Gemini-G1). */
    private buildGroundingContext(
        usable: ReadonlyArray<PromptSource>,
        description?: string,
    ): WebSearchGroundingContext {
        const notes = usable.filter(s => s.kind === 'note');
        // Stable partition: standalone (no `fromFolder`) first, folder-derived next.
        const ordered = [
            ...notes.filter(s => !s.fromFolder),
            ...notes.filter(s => s.fromFolder),
        ];
        const noteExcerpts: string[] = [];
        for (const s of ordered) {
            if (noteExcerpts.length >= GROUNDING_MAX_NOTE_EXCERPTS) break;
            const trimmed = s.content.trim();
            if (!trimmed) continue;
            noteExcerpts.push(trimmed.slice(0, GROUNDING_EXCERPT_CHARS));
        }
        const desc = description?.trim().slice(0, GROUNDING_DESCRIPTION_CHARS);
        return { description: desc ? desc : undefined, noteExcerpts };
    }

    private async resolveNoteInto(
        src: SelectedSource,
        usable: PromptSource[],
        failures: SourceFailure[],
        mtimeByPath: Map<string, number>,
    ): Promise<void> {
        const abs = this.app.vault.getAbstractFileByPath(src.ref);
        if (!(abs instanceof TFile)) {
            failures.push({ selected: src, code: 'note-not-found' });
            return;
        }
        let body: string;
        try {
            body = await this.app.vault.read(abs);
        } catch (e) {
            failures.push({
                selected: src,
                code: 'note-read-failed',
                debugMessage: e instanceof Error ? e.message : String(e),
            });
            return;
        }
        if (!body.trim()) {
            failures.push({ selected: src, code: 'note-empty' });
            return;
        }
        usable.push({
            kind: 'note',
            ref: src.ref,
            content: body,
        });
        mtimeByPath.set(src.ref, abs.stat.mtime);
    }

    private async resolveFolderInto(
        src: SelectedSource,
        usable: PromptSource[],
        failures: SourceFailure[],
        mtimeByPath: Map<string, number>,
        folderPathsSignature: Map<string, string>,
        folderCap: number,
        standaloneNotePaths: Set<string>,
    ): Promise<void> {
        const abs = this.app.vault.getAbstractFileByPath(src.ref);
        if (!(abs instanceof TFolder)) {
            failures.push({ selected: src, code: 'folder-not-found' });
            return;
        }
        const mdFiles: TFile[] = [];
        const collect = (folder: TFolder): void => {
            for (const child of folder.children) {
                if (child instanceof TFile && child.extension === 'md') mdFiles.push(child);
                else if (child instanceof TFolder) collect(child);
            }
        };
        collect(abs);
        if (mdFiles.length === 0) {
            failures.push({ selected: src, code: 'folder-empty' });
            return;
        }
        // Sort + cap.
        mdFiles.sort((a, b) => a.path.localeCompare(b.path));
        const capped = mdFiles.slice(0, folderCap);
        // Signature for cache validation (audit Gemini-r5-G2).
        folderPathsSignature.set(src.ref, capped.map(f => f.path).join('\x00'));
        // Per-file content; standalone-note dedup.
        for (const file of capped) {
            if (standaloneNotePaths.has(file.path)) continue;
            try {
                const body = await this.app.vault.read(file);
                if (!body.trim()) continue;
                usable.push({
                    kind: 'note',
                    ref: file.path,
                    content: body,
                    fromFolder: src.ref,
                });
                mtimeByPath.set(file.path, file.stat.mtime);
            } catch {
                // Per-file failures inside a folder are recorded silently —
                // we don't want one bad file to fail the whole folder.
            }
        }
    }

    /**
     * Resolve the effective web-search query. Returns the LLM-grounded query
     * when a grounder is supplied AND there's context to anchor on; otherwise
     * (no grounder, no context, empty result, or any error) returns the literal
     * query. Graceful by contract — grounding must never break search.
     */
    private async groundQuery(
        literalQuery: string,
        signal?: AbortSignal,
        ground?: WebSearchGroundingFn,
        ctx?: WebSearchGroundingContext,
    ): Promise<string> {
        if (!ground || !ctx) return literalQuery;
        // Nothing to anchor on → don't spend an LLM call; literal is correct.
        if (!ctx.description && ctx.noteExcerpts.length === 0) return literalQuery;
        try {
            const grounded = (await ground(literalQuery, ctx, signal))?.trim();
            // Defence in depth — clamp regardless of caller-side clamping so an
            // unbounded grounder result can't reach the search provider (M1/M14).
            return grounded ? grounded.slice(0, GROUNDED_QUERY_DISPATCH_CHARS) : literalQuery;
        } catch (e) {
            logger.warn(
                'PresentationSourceService',
                `web-search grounding failed for "${literalQuery}" — using literal query: ${e instanceof Error ? e.message : String(e)}`,
            );
            return literalQuery;
        }
    }

    private async resolveWebSearchInto(
        src: SelectedSource,
        usable: PromptSource[],
        failures: SourceFailure[],
        signal?: AbortSignal,
        ground?: WebSearchGroundingFn,
        groundingContext?: WebSearchGroundingContext,
    ): Promise<void> {
        if (!this.research) {
            failures.push({ selected: src, code: 'web-search-not-configured', debugMessage: 'no research service' });
            return;
        }
        // Option A: ground the literal query in the deck's notes/description.
        // Only when a grounder is supplied AND there's actual context to anchor
        // on. Grounding NEVER throws to here — fall back to the literal query.
        const effectiveQuery = await this.groundQuery(src.ref, signal, ground, groundingContext);
        // Grounding can be a slow LLM call — re-check abort before spending a
        // search request on a cancelled run (audit H2/H4).
        if (signal?.aborted) return;
        try {
            const results = await this.research.search(effectiveQuery, { signal });
            if (!results.trim()) {
                logger.warn('PresentationSourceService', `web-search returned no results for "${effectiveQuery}"`);
                failures.push({ selected: src, code: 'web-search-no-results' });
                return;
            }
            usable.push({
                kind: 'web-search',
                // ref stays the user's literal query — it is the source's stable
                // identity for caching/dedup. The grounded query only steers the
                // dispatch; when it differs we note it in the content header.
                ref: src.ref,
                content: effectiveQuery !== src.ref
                    ? `<!-- grounded search: ${effectiveQuery} -->\n${results}`
                    : results,
            });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // Two distinct "not actionable as a retry" patterns get the
            // dedicated config code — both point the user at Settings:
            //  - ResearchSearchService: "No search provider configured" (no
            //    active provider AND no fallback was found by auto-detect)
            //  - ClaudeWebSearchAdapter: "Claude API key not configured for
            //    web search" (active provider is claude-web-search, but key
            //    resolution returned null — typically because cloudServiceType
            //    isn't 'claude' so the main-key fallback didn't fire)
            const isUnconfigured = /no search provider configured|api key not configured/i.test(msg);
            // Rate-limit / overload exhaustion (the adapter retried + gave up).
            // Tagged by the adapter with `rate-limited`; also match the raw
            // provider phrasing so a 429 bubbling from any layer is caught. This
            // is transient — the user should just try again shortly, NOT a
            // configuration error pointing them at Settings.
            const isRateLimited = !isUnconfigured
                && /rate[- ]?limit|rate_limit_error|429|too many requests|overloaded/i.test(msg);
            const code: SourceFailureCode = isUnconfigured
                ? 'web-search-not-configured'
                : isRateLimited
                    ? 'web-search-rate-limited'
                    : 'web-search-failed';
            // Logger surfaces the real failure to the console — silently
            // swallowing into the UI made this class of bug invisible. Uses
            // `error` so it logs regardless of debugMode (warn is gated). The
            // UI state still drives the user-facing tooltip + block message
            // via the failureCode.
            logger.error(
                'PresentationSourceService',
                `web-search failed for "${src.ref}" → code=${code}: ${msg}`,
            );
            failures.push({
                selected: src,
                code,
                debugMessage: msg,
            });
        }
    }
}

// ── Validation invariant (audit H2 + Gemini-r4-G4) ──────────────────────────

export type CreationConfigError =
    | 'zero-sources'
    | 'zero-length'
    | 'length-out-of-range';

const MAX_LENGTH = 50;

/** Validation result for the create-flow Send gate (audit Gemini-r4-G4 —
 *  sources are passed as a separate parameter since they live on the
 *  controller, not on CreationConfig). The error union is encoded as the
 *  string field of the project's `Result<T>` type — callers narrow via
 *  the constants exported below. */
export type ValidatedCreation = { config: CreationConfig; sources: ReadonlyArray<SelectedSource> };

export function validateCreationConfig(
    config: CreationConfig,
    sources: ReadonlyArray<SelectedSource>,
): Result<ValidatedCreation> {
    if (sources.length === 0) return err<ValidatedCreation>('zero-sources');
    if (!Number.isFinite(config.length) || config.length <= 0) return err<ValidatedCreation>('zero-length');
    if (config.length > MAX_LENGTH) return err<ValidatedCreation>('length-out-of-range');
    return ok({ config, sources });
}

export const DEFAULT_CREATION_CONFIG: CreationConfig = {
    audience: 'general' as AudienceTier,
    length: 8,
    speedTier: 'fast' as ModelTier,
    planMode: 'direct',  // seeded from settings.presentationConsultantMode per creation cycle
};
