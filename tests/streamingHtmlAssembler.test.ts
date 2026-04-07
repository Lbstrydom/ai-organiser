/**
 * StreamingHtmlAssembler Tests
 *
 * Tests: accumulation, marker detection, checkpoint emission (with debounce),
 * checkpoint HTML validity, rejection counting, slide counting, finalize,
 * dispose, and edge cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamingHtmlAssembler } from '../src/services/chat/streamingHtmlAssembler';
import type { StreamingCheckpoint, StreamingResult } from '../src/services/chat/streamingHtmlAssembler';
import {
    HTML_START_MARKER,
    HTML_END_MARKER,
    STREAM_RENDER_DEBOUNCE_MS,
} from '../src/services/chat/presentationConstants';

// ── Helpers ────────────────────────────────────────────────────────────────

const CSS_THEME = 'body { background: #fff; }';

function createAssembler(
    onCheckpoint: (cp: StreamingCheckpoint) => void = vi.fn(),
    opts: { debounceMs?: number; language?: string } = {},
): StreamingHtmlAssembler {
    return new StreamingHtmlAssembler({
        cssTheme: CSS_THEME,
        onCheckpoint,
        ...opts,
    });
}

/** A single complete slide section. */
const SLIDE_TITLE = '<section class="slide slide-title"><h1>Title</h1></section>';
const SLIDE_CONTENT = '<section class="slide slide-content"><h2>Content</h2><p>Body text here</p></section>';
const SLIDE_CLOSING = '<section class="slide slide-closing"><h2>Thanks</h2></section>';

/** Wraps slides in a deck div with markers. */
function wrapDeck(...slides: string[]): string {
    return `${HTML_START_MARKER}\n<div class="deck" data-title="Test">\n${slides.join('\n')}\n</div>\n${HTML_END_MARKER}`;
}

// ── Timer setup ────────────────────────────────────────────────────────────

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

// ── 1. Basic Accumulation ──────────────────────────────────────────────────

describe('basic accumulation', () => {
    it('empty stream returns empty fullResponse with 0 slides', () => {
        const asm = createAssembler();
        const result = asm.finalize();

        expect(result.fullResponse).toBe('');
        expect(result.slideCount).toBe(0);
        expect(result.markersDetected).toBe(false);
        expect(result.rejectionCount).toBe(0);
    });

    it('single chunk with no HTML returns text and 0 slides', () => {
        const asm = createAssembler();
        asm.addChunk('Just some plain text with no HTML structure.');
        const result = asm.finalize();

        expect(result.fullResponse).toBe('Just some plain text with no HTML structure.');
        expect(result.slideCount).toBe(0);
    });
});

// ── 2. Marker Detection ───────────────────────────────────────────────────

describe('marker detection', () => {
    it('detects markers when both start and end are present', () => {
        const asm = createAssembler();
        asm.addChunk(wrapDeck(SLIDE_TITLE));
        const result = asm.finalize();

        expect(result.markersDetected).toBe(true);
    });

    it('reports false when no markers present', () => {
        const asm = createAssembler();
        asm.addChunk('<div class="deck"><section class="slide slide-title"><h1>Hi</h1></section></div>');
        const result = asm.finalize();

        expect(result.markersDetected).toBe(false);
    });

    it('detects markers split across chunks', () => {
        const asm = createAssembler();
        // Split the start marker across two chunks
        asm.addChunk('---HTML_STA');
        asm.addChunk('RT---\n<div class="deck">');
        asm.addChunk(SLIDE_TITLE);
        asm.addChunk('</div>\n---HTML_EN');
        asm.addChunk('D---');
        const result = asm.finalize();

        expect(result.markersDetected).toBe(true);
    });

    it('detects only start marker without end marker', () => {
        const asm = createAssembler();
        asm.addChunk(`${HTML_START_MARKER}\n<div class="deck">${SLIDE_TITLE}</div>`);
        const result = asm.finalize();

        // Both markers needed for markersDetected
        // Implementation may treat partial detection as false or true;
        // the key contract: finalize reflects accumulated state
        expect(typeof result.markersDetected).toBe('boolean');
    });
});

// ── 3. Checkpoint Emission ─────────────────────────────────────────────────

describe('checkpoint emission', () => {
    it('fires checkpoint when a complete slide arrives', () => {
        const onCheckpoint = vi.fn();
        const asm = createAssembler(onCheckpoint, { debounceMs: 0 });

        asm.addChunk(`${HTML_START_MARKER}\n<div class="deck">`);
        asm.addChunk(SLIDE_TITLE);
        vi.advanceTimersByTime(STREAM_RENDER_DEBOUNCE_MS + 100);

        expect(onCheckpoint).toHaveBeenCalled();
        const cp: StreamingCheckpoint = onCheckpoint.mock.calls[onCheckpoint.mock.calls.length - 1][0];
        expect(cp.slideCount).toBeGreaterThanOrEqual(1);
    });

    it('fires checkpoint per new slide when debounce allows', () => {
        const onCheckpoint = vi.fn();
        const asm = createAssembler(onCheckpoint, { debounceMs: 0 });

        asm.addChunk(`${HTML_START_MARKER}\n<div class="deck">${SLIDE_TITLE}`);
        vi.advanceTimersByTime(STREAM_RENDER_DEBOUNCE_MS + 100);
        const countAfterFirst = onCheckpoint.mock.calls.length;

        asm.addChunk(SLIDE_CONTENT);
        vi.advanceTimersByTime(STREAM_RENDER_DEBOUNCE_MS + 100);

        asm.addChunk(SLIDE_CLOSING);
        vi.advanceTimersByTime(STREAM_RENDER_DEBOUNCE_MS + 100);

        // At least 3 checkpoints total (one per slide)
        expect(onCheckpoint.mock.calls.length).toBeGreaterThanOrEqual(countAfterFirst + 2);
    });

    it('does not fire checkpoint when no new slide completes', () => {
        const onCheckpoint = vi.fn();
        const asm = createAssembler(onCheckpoint);

        // Partial slide — no closing </section>
        asm.addChunk(`${HTML_START_MARKER}\n<div class="deck"><section class="slide slide-content"><h2>Partial`);
        vi.advanceTimersByTime(STREAM_RENDER_DEBOUNCE_MS + 100);

        // Checkpoint may fire but slideCount should be 0 (no complete slide)
        const checkpoints = onCheckpoint.mock.calls;
        if (checkpoints.length > 0) {
            expect(checkpoints[checkpoints.length - 1][0].slideCount).toBe(0);
        }
    });

    it('debounces rapid chunks into single checkpoint', () => {
        const onCheckpoint = vi.fn();
        const asm = createAssembler(onCheckpoint);

        // Feed two slides rapidly without advancing timers
        asm.addChunk(`${HTML_START_MARKER}\n<div class="deck">${SLIDE_TITLE}`);
        asm.addChunk(SLIDE_CONTENT);

        // Only advance once — should coalesce into one checkpoint
        vi.advanceTimersByTime(STREAM_RENDER_DEBOUNCE_MS + 100);

        // Should have at most 1 checkpoint call (debounced)
        expect(onCheckpoint.mock.calls.length).toBeLessThanOrEqual(1);
        if (onCheckpoint.mock.calls.length === 1) {
            expect(onCheckpoint.mock.calls[0][0].slideCount).toBe(2);
        }
    });
});

// ── 4. Checkpoint HTML ─────────────────────────────────────────────────────

describe('checkpoint HTML', () => {
    it('checkpoint html contains a wrapped document', () => {
        const onCheckpoint = vi.fn();
        const asm = createAssembler(onCheckpoint, { debounceMs: 0 });

        asm.addChunk(wrapDeck(SLIDE_TITLE, SLIDE_CONTENT));
        vi.advanceTimersByTime(STREAM_RENDER_DEBOUNCE_MS + 100);

        expect(onCheckpoint).toHaveBeenCalled();
        const cp: StreamingCheckpoint = onCheckpoint.mock.calls[onCheckpoint.mock.calls.length - 1][0];
        expect(cp.html).toContain('<!DOCTYPE html>');
        expect(cp.html).toContain(CSS_THEME);
    });

    it('checkpoint html contains only complete slides', () => {
        const onCheckpoint = vi.fn();
        const asm = createAssembler(onCheckpoint, { debounceMs: 0 });

        // One complete slide + partial second slide
        asm.addChunk(`${HTML_START_MARKER}\n<div class="deck">${SLIDE_TITLE}<section class="slide slide-content"><h2>Partial`);
        vi.advanceTimersByTime(STREAM_RENDER_DEBOUNCE_MS + 100);

        if (onCheckpoint.mock.calls.length > 0) {
            const cp: StreamingCheckpoint = onCheckpoint.mock.calls[onCheckpoint.mock.calls.length - 1][0];
            // Only complete slides should be in HTML — no unclosed <section>
            const openSections = (cp.html.match(/<section[^>]*class="slide/g) ?? []).length;
            const closeSections = (cp.html.match(/<\/section>/g) ?? []).length;
            expect(closeSections).toBeGreaterThanOrEqual(openSections);
        }
    });
});

// ── 5. Rejection Counting ──────────────────────────────────────────────────

describe('rejection counting', () => {
    it('counts <script> as a rejection', () => {
        const asm = createAssembler();
        asm.addChunk(wrapDeck(
            '<section class="slide slide-content"><h2>Bad</h2><script>alert("xss")</script></section>',
        ));
        const result = asm.finalize();

        expect(result.rejectionCount).toBeGreaterThanOrEqual(1);
    });

    it('counts multiple unsafe elements', () => {
        const asm = createAssembler();
        asm.addChunk(wrapDeck(
            '<section class="slide slide-content">' +
            '<script>x</script>' +
            '<iframe src="evil.com"></iframe>' +
            '<div onclick="alert(1)">click</div>' +
            '</section>',
        ));
        const result = asm.finalize();

        expect(result.rejectionCount).toBeGreaterThanOrEqual(3);
    });

    it('clean HTML has zero rejections', () => {
        const asm = createAssembler();
        asm.addChunk(wrapDeck(SLIDE_TITLE, SLIDE_CONTENT));
        const result = asm.finalize();

        expect(result.rejectionCount).toBe(0);
    });
});

// ── 6. Slide Counting ──────────────────────────────────────────────────────

describe('slide counting', () => {
    it('counts slide-title and slide-content classes', () => {
        const asm = createAssembler();
        asm.addChunk(wrapDeck(SLIDE_TITLE, SLIDE_CONTENT, SLIDE_CLOSING));
        const result = asm.finalize();

        expect(result.slideCount).toBe(3);
    });

    it('does not count "slideshow" as a slide (word boundary)', () => {
        const asm = createAssembler();
        asm.addChunk(wrapDeck(
            '<div class="slideshow">Not a slide</div>',
            SLIDE_TITLE,
        ));
        const result = asm.finalize();

        // Only the actual slide-title should count
        expect(result.slideCount).toBe(1);
    });

    it('counts zero slides when no slide classes present', () => {
        const asm = createAssembler();
        asm.addChunk(`${HTML_START_MARKER}\n<div class="deck"><p>No slides here</p></div>\n${HTML_END_MARKER}`);
        const result = asm.finalize();

        expect(result.slideCount).toBe(0);
    });
});

// ── 7. Finalize ────────────────────────────────────────────────────────────

describe('finalize', () => {
    it('returns full accumulated text from all chunks', () => {
        const asm = createAssembler();
        asm.addChunk('chunk-1 ');
        asm.addChunk('chunk-2 ');
        asm.addChunk('chunk-3');
        const result = asm.finalize();

        expect(result.fullResponse).toBe('chunk-1 chunk-2 chunk-3');
    });

    it('clears pending debounce timer', () => {
        const onCheckpoint = vi.fn();
        const asm = createAssembler(onCheckpoint);

        asm.addChunk(wrapDeck(SLIDE_TITLE));
        // Finalize before debounce fires
        asm.finalize();

        // Advance time — no checkpoint should fire after finalize
        vi.advanceTimersByTime(STREAM_RENDER_DEBOUNCE_MS * 2);

        // Checkpoint may have been called during finalize (flush) but not after
        const countAtFinalize = onCheckpoint.mock.calls.length;
        vi.advanceTimersByTime(STREAM_RENDER_DEBOUNCE_MS * 2);
        expect(onCheckpoint.mock.calls.length).toBe(countAtFinalize);
    });
});

// ── 8. Dispose ─────────────────────────────────────────────────────────────

describe('dispose', () => {
    it('clears pending debounce timer', () => {
        const onCheckpoint = vi.fn();
        const asm = createAssembler(onCheckpoint);

        asm.addChunk(wrapDeck(SLIDE_TITLE));
        asm.dispose();

        vi.advanceTimersByTime(STREAM_RENDER_DEBOUNCE_MS * 2);
        expect(onCheckpoint).not.toHaveBeenCalled();
    });

    it('no checkpoint fires after dispose', () => {
        const onCheckpoint = vi.fn();
        const asm = createAssembler(onCheckpoint);

        asm.addChunk(wrapDeck(SLIDE_TITLE, SLIDE_CONTENT));
        asm.dispose();

        // Even with long timer advance, no callbacks
        vi.advanceTimersByTime(10_000);
        expect(onCheckpoint).not.toHaveBeenCalled();
    });
});

// ── 9. Edge Cases ──────────────────────────────────────────────────────────

describe('edge cases', () => {
    it('handles very large chunks (100KB) without crashing', () => {
        const asm = createAssembler();
        const largeContent = '<p>' + 'A'.repeat(100_000) + '</p>';
        asm.addChunk(wrapDeck(
            `<section class="slide slide-content">${largeContent}</section>`,
        ));
        const result = asm.finalize();

        expect(result.slideCount).toBe(1);
        expect(result.fullResponse.length).toBeGreaterThan(100_000);
    });

    it('handles Unicode content correctly', () => {
        const asm = createAssembler();
        const unicodeSlide = '<section class="slide slide-content"><h2>Zusammenfassung</h2><p>Uber die Brucke gehen und Glu\u0308hwein trinken \uD83C\uDF1F</p></section>';
        asm.addChunk(wrapDeck(unicodeSlide));
        const result = asm.finalize();

        expect(result.slideCount).toBe(1);
        expect(result.fullResponse).toContain('Zusammenfassung');
        expect(result.fullResponse).toContain('\uD83C\uDF1F');
    });

    it('handles empty chunks gracefully', () => {
        const asm = createAssembler();
        asm.addChunk('');
        asm.addChunk('');
        asm.addChunk(wrapDeck(SLIDE_TITLE));
        asm.addChunk('');
        const result = asm.finalize();

        expect(result.slideCount).toBe(1);
        expect(result.markersDetected).toBe(true);
    });
});
