/**
 * Multi-source orchestration types (Cluster C / Phase 4).
 *
 * Shared contracts for the decomposed multi-source summarize path. The
 * `MultiSourceOrchestrator` turns an editor-free list of `ResolvedSource`s into an
 * ordered `BatchResult<SourceOutcome>`; `SummaryInsertion` + `SourceMetadataWriter`
 * turn that outcome list into note content + a `NoteMutation`. The command adapter
 * owns the editor/snapshot/write seam — none of these types touch the editor.
 */

import type { TFile, App } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import type { BatchError } from '../../core/result';
import type { PdfSummarizationOptions, PdfSummarizationResult } from '../../commands/summarizeTypes';
import type { TranscriptionResult } from '../audioTranscriptionService';

/** The transcription fields the post-transcription cleanup needs (compression savings). */
export type AudioCleanupPayload = Pick<TranscriptionResult, 'compressedData' | 'originalSizeBytes'>;

/** Item-level failure shape for a single source (alias of the generic boundary error). */
export type SourceError = BatchError;

/** The source kinds a multi-source run can process (drives the checklist + references). */
export type MultiSourceType = 'web' | 'youtube' | 'note' | 'pdf' | 'document' | 'audio' | 'image';

/**
 * A processed source record — exactly the legacy `ProcessedSource` shape. Drives the
 * "Sources Processed" checklist and the References section. `success`/`error` capture
 * the per-source outcome; `date` is the run's stamp (injected for determinism).
 */
export interface ProcessedSource {
    type: MultiSourceType;
    url?: string;
    title: string;
    date: string;
    success: boolean;
    error?: string;
}

/**
 * One source's full outcome: the `processed` record (always present) plus the
 * `summary`/`label` (present iff the source succeeded). The orchestrator returns
 * these in processing order so `SummaryInsertion` can rebuild `summaries`,
 * `sourceLabels`, and `allSources` byte-identically to the legacy path.
 */
export interface SourceOutcome {
    processed: ProcessedSource;
    /** Generated summary text — present iff `processed.success`. */
    summary?: string;
    /** Source label (e.g. `URL: <title>`) — present iff `processed.success`. */
    label?: string;
}

/**
 * Editor-free description of a source to process. The adapter flattens the modal's
 * grouped `SelectedSources` into this ordered list (note → urls → youtube → pdfs →
 * documents → audio → images) so the orchestrator never reads the editor/view.
 */
export type ResolvedSource =
    | { kind: 'note'; file: TFile }
    | { kind: 'url'; url: string }
    | { kind: 'youtube'; url: string }
    | { kind: 'pdf'; path: string; isVaultFile: boolean }
    | { kind: 'document'; path: string; isVaultFile: boolean }
    | { kind: 'audio'; path: string; isVaultFile: boolean }
    | { kind: 'image'; path: string };

/** Transient progress message sink (the adapter wires this to `new Notice`). */
export type NotifyFn = (message: string, timeoutMs?: number) => void;

/**
 * Constructor dependencies (DI, mirrors the minutes `*Controller` pattern). The three
 * function seams (`summarizeContent`/`summarizePdf`/`extractDocument`) wrap helpers
 * that live in `summarizeCommands.ts`; injecting them as functions avoids a circular
 * import AND avoids relocating their large dependency tails (documented deviation from
 * the plan's "inject pdfService/documentService" — narrower DIP, same effect).
 */
export interface MultiSourceDeps {
    app: App;
    plugin: AIOrganiserPlugin;
    /**
     * Per-source summarize seam (wraps `callSummarizeService`, egress already gated).
     * `signal` threads into the underlying `summarizeText` so an in-flight call can be
     * aborted mid-flight (Gemini-gate G1) — the orchestrator passes `opts.signal`.
     */
    summarizeContent: (
        content: string,
        personaPrompt: string,
        focusContext?: string,
        isRawPrompt?: boolean,
        signal?: AbortSignal,
    ) => Promise<string | null>;
    /** PDF summarize seam (wraps `summarizePdfWithFullWorkflow`). */
    summarizePdf: (
        pdfPath: string,
        isVaultFile: boolean,
        options: PdfSummarizationOptions,
    ) => Promise<PdfSummarizationResult>;
    /** Document-extraction seam (wraps `extractDocumentTextForMultiSource`). */
    extractDocument: (
        document: { path: string; isVaultFile: boolean },
        currentFilePath?: string,
    ) => Promise<{ success: boolean; text?: string; error?: string }>;
    /** Transient progress notices. */
    notify: NotifyFn;
    /** Post-transcription cleanup modal seam (wraps `offerPostTranscriptionCleanup`). */
    onAudioCleanup?: (file: TFile, transcriptionResult: AudioCleanupPayload) => Promise<void>;
}

/** Per-run options (extends the plan's `{ signal, onProgress }` with run context). */
export interface MultiSourceRunOptions {
    personaPrompt: string;
    focusContext?: string;
    /** The captured note path, for vault-link resolution of sources. */
    currentFilePath?: string;
    /** The run's date stamp (injected so References dates are deterministic in tests). */
    today: string;
    /** Cooperative cancellation — checked between sources (no-op when absent). */
    signal?: AbortSignal;
    /** Fired before each source is processed: `(processedSoFar, total)`. */
    onProgress?: (done: number, total: number) => void;
}
