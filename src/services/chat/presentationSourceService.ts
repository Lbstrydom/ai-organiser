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
import { truncateAtBoundary } from '../tokenLimits';
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

const NOTE_HARD_CAP = 8_000;        // Mirrors presentationSourceBudget
const DEFAULT_FOLDER_CAP = 50;
const WEB_SEARCH_RESULT_CAP = 4_000;

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
        opts: { folderCap?: number; signal?: AbortSignal } = {},
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
                await this.resolveWebSearchInto(src, usable, failures, opts.signal);
            } else {
                failures.push({ selected: src, code: 'unsupported-kind' });
            }
        }
        return { usable, failures, mtimeByPath, folderPathsSignature };
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
            content: truncateAtBoundary(body, NOTE_HARD_CAP),
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
                    content: truncateAtBoundary(body, NOTE_HARD_CAP),
                    fromFolder: src.ref,
                });
                mtimeByPath.set(file.path, file.stat.mtime);
            } catch {
                // Per-file failures inside a folder are recorded silently —
                // we don't want one bad file to fail the whole folder.
            }
        }
    }

    private async resolveWebSearchInto(
        src: SelectedSource,
        usable: PromptSource[],
        failures: SourceFailure[],
        signal?: AbortSignal,
    ): Promise<void> {
        if (!this.research) {
            failures.push({ selected: src, code: 'web-search-failed', debugMessage: 'no research service' });
            return;
        }
        try {
            const results = await this.research.search(src.ref, { signal });
            if (!results.trim()) {
                failures.push({ selected: src, code: 'web-search-no-results' });
                return;
            }
            usable.push({
                kind: 'web-search',
                ref: src.ref,
                content: truncateAtBoundary(results, WEB_SEARCH_RESULT_CAP),
            });
        } catch (e) {
            failures.push({
                selected: src,
                code: 'web-search-failed',
                debugMessage: e instanceof Error ? e.message : String(e),
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

// Re-export shared constants so callers can compose the same defaults.
export { NOTE_HARD_CAP };
export const DEFAULT_CREATION_CONFIG: CreationConfig = {
    audience: 'general' as AudienceTier,
    length: 8,
    speedTier: 'fast' as ModelTier,
};
