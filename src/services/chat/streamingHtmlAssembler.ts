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

// ── Dangerous pattern regexes (compiled once) ──────────────────────────────

const DANGEROUS_PATTERNS: ReadonlyArray<RegExp> = [
    /<script/gi,
    /<iframe/gi,
    /on\w+=/gi,
    /javascript:/gi,
];

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
    private readonly debounceMs: number;

    private buffer = '';
    private lastCheckpointSlideCount = 0;
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private disposed = false;

    constructor(options: StreamingHtmlAssemblerOptions) {
        this.cssTheme = options.cssTheme;
        this.language = options.language;
        this.onCheckpoint = options.onCheckpoint;
        this.debounceMs = options.debounceMs ?? STREAM_RENDER_DEBOUNCE_MS;
    }

    /**
     * Feed a chunk from the LLM stream.
     * After appending, checks whether the completed slide count has increased
     * and schedules a debounced checkpoint if so.
     */
    addChunk(chunk: string): void {
        if (this.disposed) return;

        this.buffer += chunk;

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

        logger.debug('StreamingHtml', `Finalized: ${slideCount} slides, ${rejectionCount} rejections, markers=${String(markersDetected)}`);

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
            // Reset lastIndex since these are global regexes
            pattern.lastIndex = 0;
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

        const wrapped = wrapInDocument(partialHtml, this.cssTheme, this.language);

        this.onCheckpoint({
            html: wrapped,
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
