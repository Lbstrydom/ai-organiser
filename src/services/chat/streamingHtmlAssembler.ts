/**
 * Streaming HTML Assembler for the presentation engine.
 *
 * Accumulates LLM response chunks during streaming generation and emits
 * debounced checkpoints when complete slides are detected. Tracks marker
 * presence and dangerous-pattern counts for reliability classification.
 */

import { logger } from '../../utils/logger';
import { wrapInDocument, extractHtmlFromResponse } from '../prompts/presentationChatPrompts';
import {
    HTML_START_MARKER,
    HTML_END_MARKER,
    STREAM_RENDER_DEBOUNCE_MS,
} from './presentationConstants';
// M5 fix: use shared dangerous-pattern list (DRY — was duplicated here and in sanitizer)
// Audit R1 H3: route streaming preview HTML through the same sanitize + CSP
// pipeline used by the final generation path, so preview and final render
// identical safety guarantees.
import {
    DANGEROUS_HTML_PATTERNS as DANGEROUS_PATTERNS,
    sanitizePresentation,
    injectCSP,
} from './presentationSanitizer';

/** Regex to count complete slides via closing section tags (mid-stream). */
const COMPLETE_SLIDE_RE = /<\/section>/gi;
/** Regex to count slide openings (for final count). */
const SLIDE_CLASS_RE = /class="slide[\s"]/g;

// ── Public types ───────────────────────────────────────────────────────────

/** Checkpoint emitted when a new complete slide is detected mid-stream. */
export interface StreamingCheckpoint {
    /** Partial HTML wrapped in a valid document for preview. */
    html: string;
    /** Number of complete slides detected so far. */
    slideCount: number;
    /** Whether HTML markers were detected in the stream. */
    markersDetected: boolean;
}

/** Final result returned when the stream ends. */
export interface StreamingResult {
    /** Full accumulated response text (unmodified). */
    fullResponse: string;
    /** Whether ---HTML_START--- / ---HTML_END--- markers were found. */
    markersDetected: boolean;
    /** Number of potentially dangerous patterns found in the response. */
    rejectionCount: number;
    /** Total slides in the final output. */
    slideCount: number;
}

/** Options for constructing a {@link StreamingHtmlAssembler}. */
export interface StreamingHtmlAssemblerOptions {
    /** CSS theme string to wrap checkpoint previews with. */
    cssTheme: string;
    /** Output language for the HTML lang attribute. */
    language?: string;
    /** Callback invoked when a new complete slide is detected. */
    onCheckpoint: (checkpoint: StreamingCheckpoint) => void;
    /** Fires the first time any chunk arrives. Lets the UI flip from
     *  "Starting generation…" to "Streaming response…" the moment the SSE
     *  stream begins delivering bytes — closes the silent-spinner gap when
     *  the LLM front-loads a long reasoning preamble before any slides
     *  close (`docs/completed/presentation-latency-feedback.md` fix #1). */
    onStreamStart?: () => void;
    /** Fires when a new opening `<section` tag is observed mid-stream,
     *  even before its closing tag. Argument is the 1-based count of
     *  opens-seen-so-far (i.e. "currently building slide N"). Lets the UI
     *  show "Building slide N…" while the slide is still streaming
     *  (`docs/completed/presentation-latency-feedback.md` fix #2). */
    onSlideStart?: (slideIndex: number) => void;
    /** Debounce interval in ms before emitting a checkpoint. Default 800. */
    debounceMs?: number;
}

// ── Implementation ─────────────────────────────────────────────────────────

/**
 * Accumulates LLM streaming chunks and emits checkpoints when new
 * complete slides are detected via `class="slide"` regex counting.
 *
 * Usage:
 * ```ts
 * const assembler = new StreamingHtmlAssembler({
 *     cssTheme: theme,
 *     onCheckpoint: (cp) => renderPreview(cp.html),
 * });
 * for await (const chunk of stream) assembler.addChunk(chunk);
 * const result = assembler.finalize();
 * ```
 */
export class StreamingHtmlAssembler {
    private readonly cssTheme: string;
    private readonly language: string | undefined;
    private readonly onCheckpoint: (checkpoint: StreamingCheckpoint) => void;
    private readonly onStreamStart: (() => void) | undefined;
    private readonly onSlideStart: ((slideIndex: number) => void) | undefined;
    private readonly debounceMs: number;
    private readonly startedAtMs: number;

    private buffer = '';
    private lastCheckpointSlideCount = 0;
    private lastSlideStartCount = 0;
    private streamStartFired = false;
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private disposed = false;

    constructor(options: StreamingHtmlAssemblerOptions) {
        this.cssTheme = options.cssTheme;
        this.language = options.language;
        this.onCheckpoint = options.onCheckpoint;
        this.onStreamStart = options.onStreamStart;
        this.onSlideStart = options.onSlideStart;
        this.debounceMs = options.debounceMs ?? STREAM_RENDER_DEBOUNCE_MS;
        this.startedAtMs = Date.now();
    }

    /**
     * Feed a chunk from the LLM stream.
     *
     * Three progress signals are fired off this hot path so the UI can
     * advance status without waiting for `</section>`:
     *  1. `onStreamStart` — once on the first non-empty chunk
     *  2. `onSlideStart`  — when a new opening `<section` is observed
     *  3. `onCheckpoint`  — when a slide closes (existing contract)
     *
     * The first two are status-only signals (no HTML payload); they exist
     * to close the silent-spinner gap reported in
     * `docs/completed/presentation-latency-feedback.md` (Pat persona, FIX-01
     * re-test 2026-04-25).
     */
    addChunk(chunk: string): void {
        if (this.disposed) return;
        if (!chunk) return;

        // First-byte signal — fire BEFORE accumulating into the buffer so
        // the UI flip happens at the earliest possible moment.
        if (!this.streamStartFired) {
            this.streamStartFired = true;
            try {
                this.onStreamStart?.();
            } catch (e) {
                logger.warn('StreamingHtml', 'onStreamStart callback threw (non-fatal)', e);
            }
        }

        this.buffer += chunk;

        // Slide-start signal — counts opening `<section` occurrences in the
        // accumulated buffer. The handler maps this to "Building slide N…".
        const slideStarts = this.countSlides(this.buffer);
        if (slideStarts > this.lastSlideStartCount) {
            this.lastSlideStartCount = slideStarts;
            try {
                this.onSlideStart?.(slideStarts);
            } catch (e) {
                logger.warn('StreamingHtml', 'onSlideStart callback threw (non-fatal)', e);
            }
        }

        const completedSlides = this.countCompletedSlides(this.buffer);
        if (completedSlides > this.lastCheckpointSlideCount) {
            this.scheduleCheckpoint(completedSlides);
        }
    }

    /**
     * Signal that the stream has ended.
     * Clears any pending debounce timer and returns the final result.
     */
    finalize(): StreamingResult {
        this.clearDebounce();

        const markersDetected = this.hasMarkers();
        const slideCount = this.countSlides(this.buffer);
        const rejectionCount = this.countDangerousPatterns(this.buffer);
        const elapsedMs = Date.now() - this.startedAtMs;
        const byteCount = this.buffer.length;

        // Extended log payload — duration + byte count make latency
        // regressions diagnosable from logs alone, without needing a
        // persona-test re-run. (`docs/completed/presentation-latency-feedback.md`
        // fix #3.)
        logger.debug('StreamingHtml',
            `Finalized: ${slideCount} slides, ${rejectionCount} rejections, `
            + `markers=${String(markersDetected)}, ${byteCount} bytes, ${elapsedMs}ms`);

        return {
            fullResponse: this.buffer,
            markersDetected,
            rejectionCount,
            slideCount,
        };
    }

    /** Cancel streaming and clean up timers. */
    dispose(): void {
        this.disposed = true;
        this.clearDebounce();
    }

    // ── Private helpers ────────────────────────────────────────────────────

    /**
     * Count completed slides by matching closing `</section>` tags.
     * Only closed sections represent fully streamed slides (M3 remediation).
     */
    private countCompletedSlides(text: string): number {
        const matches = text.match(COMPLETE_SLIDE_RE);
        return matches ? matches.length : 0;
    }

    /**
     * Count slide openings by matching `class="slide"` occurrences.
     * Used for final result (all slides including any unclosed trailing one).
     */
    private countSlides(text: string): number {
        const matches = text.match(SLIDE_CLASS_RE);
        return matches ? matches.length : 0;
    }

    /** Check whether the buffer contains start/end HTML markers. */
    private hasMarkers(): boolean {
        return this.buffer.includes(HTML_START_MARKER) || this.buffer.includes(HTML_END_MARKER);
    }

    /**
     * Count occurrences of potentially dangerous patterns in a string.
     * Used for reliability classification in Phase 3.
     */
    private countDangerousPatterns(text: string): number {
        let count = 0;
        for (const pattern of DANGEROUS_PATTERNS) {
            // `String#match` with a /g regex scans the whole string and
            // ignores `lastIndex` entirely (only `RegExp#exec` advances it).
            // So no manual reset needed. (Gemini-gate G2 2026-04-20.)
            const matches = text.match(pattern);
            if (matches) count += matches.length;
        }
        return count;
    }

    /**
     * Schedule a debounced checkpoint emission. If a timer is already
     * pending it is cleared and rescheduled with the latest slide count.
     */
    private scheduleCheckpoint(slideCount: number): void {
        this.clearDebounce();

        this.debounceTimer = setTimeout(() => {
            if (this.disposed) return;
            this.emitCheckpoint(slideCount);
        }, this.debounceMs);
    }

    /** Build and emit a checkpoint to the callback. */
    private emitCheckpoint(slideCount: number): void {
        this.lastCheckpointSlideCount = slideCount;

        const markersDetected = this.hasMarkers();
        const partialHtml = this.extractPartialHtml();

        if (!partialHtml) {
            logger.debug('StreamingHtml', 'Checkpoint skipped: no extractable HTML');
            return;
        }

        // Audit R1 H3: sanitize and CSP-wrap the partial HTML so streaming
        // checkpoints receive the same safety guarantees as final output.
        // sanitizePresentation is idempotent on already-safe content and
        // only strips dangerous tags/attributes — safe on mid-stream HTML.
        const sanitized = sanitizePresentation(partialHtml);
        const wrapped = wrapInDocument(sanitized.html, this.cssTheme, this.language);
        const secured = injectCSP(wrapped);

        this.onCheckpoint({
            html: secured,
            slideCount,
            markersDetected,
        });
    }

    /**
     * Extract HTML suitable for preview from the current buffer.
     *
     * If markers are present, extracts content between them.
     * Otherwise falls back to {@link extractHtmlFromResponse}.
     * Closes any unclosed `</section>` and `</div>` tags to produce
     * valid-enough HTML for iframe preview.
     */
    private extractPartialHtml(): string | null {
        let html: string | null = null;

        if (this.hasMarkers()) {
            html = this.extractBetweenMarkers();
        }

        if (!html) {
            html = extractHtmlFromResponse(this.buffer);
        }

        if (!html) return null;

        // Close any unclosed section/div tags for valid preview rendering
        return this.closeOpenTags(html);
    }

    /**
     * Extract content between HTML_START_MARKER and HTML_END_MARKER.
     * If end marker is missing (stream still in progress), takes
     * everything after the start marker.
     */
    private extractBetweenMarkers(): string | null {
        const startIdx = this.buffer.indexOf(HTML_START_MARKER);
        if (startIdx < 0) return null;

        const contentStart = startIdx + HTML_START_MARKER.length;
        const endIdx = this.buffer.indexOf(HTML_END_MARKER, contentStart);

        if (endIdx >= 0) {
            return this.buffer.slice(contentStart, endIdx).trim();
        }

        // End marker not yet received — take everything after start marker
        return this.buffer.slice(contentStart).trim();
    }

    /**
     * Close unclosed `<section>` and `<div>` tags so the partial HTML
     * renders correctly in an iframe preview.
     */
    private closeOpenTags(html: string): string {
        const openSections = (html.match(/<section[\s>]/gi) ?? []).length;
        const closeSections = (html.match(/<\/section>/gi) ?? []).length;
        const openDivs = (html.match(/<div[\s>]/gi) ?? []).length;
        const closeDivs = (html.match(/<\/div>/gi) ?? []).length;

        let patched = html;
        const missingSections = openSections - closeSections;
        for (let i = 0; i < missingSections; i++) {
            patched += '</section>';
        }
        const missingDivs = openDivs - closeDivs;
        for (let i = 0; i < missingDivs; i++) {
            patched += '</div>';
        }

        return patched;
    }

    private clearDebounce(): void {
        if (this.debounceTimer !== null) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
    }
}
