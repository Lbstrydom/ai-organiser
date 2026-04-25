/**
 * Slide Runtime
 *
 * JavaScript code injected into the slide preview iframe.
 * Handles keyboard navigation, speaker notes toggle, and
 * postMessage communication with the parent SlideIframePreview.
 *
 * Returns raw JS (no <script> tags) — the caller wraps it.
 */

import { DECK_CLASSES } from './presentationConstants';

/**
 * Build the slide runtime JS code to inject into the iframe.
 * The nonce ties parent ↔ iframe messages to a specific preview instance.
 */
export function buildSlideRuntimeCode(nonce: string): string {
    // Inline the class names so the runtime has no import dependencies
    const slideClass = DECK_CLASSES.slide;
    const notesClass = DECK_CLASSES.speakerNotes;

    return `(function() {
    'use strict';
    var NONCE = '${nonce}';
    var ORIGIN = (typeof location !== 'undefined' && location.origin) ? location.origin : '*';
    var currentIndex = 0;
    var notesVisible = false;

    function findSlides() {
        var byAttr = document.querySelectorAll('section[data-slide]');
        if (byAttr.length) return byAttr;
        var byClass = document.querySelectorAll('.${slideClass}');
        if (byClass.length) return byClass;
        // M10 fix: scoped fallback — only section children of .deck, not all sections
        var deck = document.querySelector('.deck');
        return deck ? deck.querySelectorAll('section') : document.querySelectorAll('section.${slideClass}');
    }

    function getSlides() {
        return findSlides();
    }

    function goToSlide(idx) {
        var slides = getSlides();
        if (!slides.length) return;
        if (idx < 0) idx = 0;
        if (idx >= slides.length) idx = slides.length - 1;
        currentIndex = idx;
        for (var i = 0; i < slides.length; i++) {
            if (i === currentIndex) {
                slides[i].classList.remove('pres-nav-hidden');
            } else {
                slides[i].classList.add('pres-nav-hidden');
            }
        }
        parent.postMessage({ nonce: NONCE, action: 'slideChanged', payload: { index: currentIndex, slideCount: slides.length } }, ORIGIN);
    }

    function toggleNotes() {
        notesVisible = !notesVisible;
        var notes = document.querySelectorAll('.${notesClass}');
        for (var i = 0; i < notes.length; i++) {
            notes[i].style.display = notesVisible ? '' : 'none';
        }
    }

    document.addEventListener('keydown', function(e) {
        switch (e.key) {
            case 'ArrowLeft':
                goToSlide(currentIndex - 1);
                e.preventDefault();
                break;
            case 'ArrowRight':
                goToSlide(currentIndex + 1);
                e.preventDefault();
                break;
            case 'Home':
                goToSlide(0);
                e.preventDefault();
                break;
            case 'End':
                goToSlide(getSlides().length - 1);
                e.preventDefault();
                break;
            case 'n':
            case 'N':
                toggleNotes();
                e.preventDefault();
                break;
        }
    });

    // ── Element selection (slide-authoring-editing plan) ────────────────────
    //
    // Delegated click + hover handlers walk up the DOM from the event target
    // looking for the nearest [data-element] ancestor. The decorator attaches
    // these attributes during projection (presentationDomDecorator.ts). Every
    // addressable subtree (slide, heading, list, list-item, image, table,
    // callout, etc.) gets one.
    //
    // Behaviour:
    //   - Click on an annotated subtree → postMessage 'elementSelected'
    //   - Click on empty space inside a slide → fall back to slide-level scope
    //   - Click outside any slide → no selection emitted
    //   - Hover → toggle 'pres-slide-element-hover' class on the candidate
    //     so the parent can render an overlay outline. CSS owns the visual.
    function findElementAncestor(node) {
        var n = node;
        while (n && n !== document.body) {
            if (n.nodeType === 1 && n.hasAttribute && n.hasAttribute('data-element')) {
                return n;
            }
            n = n.parentNode;
        }
        return null;
    }
    function findEnclosingSlideIndex(node) {
        // Walk up looking for a section.slide. Returns 0-based index or -1.
        var slides = getSlides();
        var n = node;
        while (n && n !== document.body) {
            if (n.nodeType === 1) {
                for (var i = 0; i < slides.length; i++) {
                    if (slides[i] === n) return i;
                }
            }
            n = n.parentNode;
        }
        return -1;
    }
    function inferElementKind(el) {
        // The data-element path encodes the kind as the segment before the
        // last index (e.g. 'slide-2.list-0.item-1' → 'list-item' for items,
        // 'list' for the list itself). We map a few common ones; unmatched
        // falls back to the tag name.
        var path = el.getAttribute('data-element') || '';
        // Build regex predicates via RegExp(string) instead of literals — the
        // outer template string would otherwise eat the regex backslashes,
        // and ESLint flags literal-form escapes inside strings as redundant.
        if (new RegExp('\\\\.item-\\\\d+$').test(path)) return 'list-item';
        if (new RegExp('\\\\.list-\\\\d+$').test(path)) return 'list';
        if (new RegExp('\\\\.heading$').test(path)) return 'heading';
        if (new RegExp('\\\\.subheading$').test(path)) return 'subheading';
        if (new RegExp('\\\\.image-\\\\d+$').test(path)) return 'image';
        if (new RegExp('\\\\.figure-\\\\d+$').test(path)) return 'figure';
        if (new RegExp('\\\\.table-\\\\d+$').test(path)) return 'table';
        if (new RegExp('\\\\.callout-\\\\d+$').test(path)) return 'callout';
        if (new RegExp('\\\\.quote-\\\\d+$').test(path)) return 'quote';
        if (new RegExp('\\\\.code-\\\\d+$').test(path)) return 'code';
        if (new RegExp('\\\\.col-\\\\d+$').test(path)) return 'col';
        if (new RegExp('\\\\.col-container-\\\\d+$').test(path)) return 'col-container';
        if (new RegExp('\\\\.stats-grid-\\\\d+$').test(path)) return 'stats-grid';
        if (new RegExp('\\\\.speaker-notes$').test(path)) return 'speaker-notes';
        if (new RegExp('^slide-\\\\d+$').test(path)) return 'slide';
        if (path === 'deck') return 'deck';
        return el.tagName.toLowerCase();
    }
    document.addEventListener('click', function(e) {
        var target = e.target;
        if (!target || target.nodeType !== 1) return;
        // Ignore clicks on speaker notes (they're toggled with N, not editable here)
        var notes = target.closest && target.closest('.${notesClass}');
        if (notes) return;
        var slideIndex = findEnclosingSlideIndex(target);
        if (slideIndex < 0) return; // outside any slide — ignore
        var elementEl = findElementAncestor(target);
        // If the element ancestor IS the slide itself, treat as slide-level scope.
        var isSlideLevel = !elementEl || new RegExp('^slide-\\\\d+$').test(elementEl.getAttribute('data-element') || '');
        if (isSlideLevel) {
            parent.postMessage({
                nonce: NONCE,
                action: 'elementSelected',
                payload: { kind: 'slide', slideIndex: slideIndex },
            }, ORIGIN);
            return;
        }
        var path = elementEl.getAttribute('data-element');
        var kind = inferElementKind(elementEl);
        parent.postMessage({
            nonce: NONCE,
            action: 'elementSelected',
            payload: {
                kind: 'element',
                slideIndex: slideIndex,
                elementPath: path,
                elementKind: kind,
            },
        }, ORIGIN);
    });

    var lastHoverEl = null;
    document.addEventListener('mouseover', function(e) {
        var target = e.target;
        if (!target || target.nodeType !== 1) return;
        var el = findElementAncestor(target);
        if (el === lastHoverEl) return;
        if (lastHoverEl) lastHoverEl.classList.remove('pres-slide-element-hover');
        lastHoverEl = el;
        if (el) el.classList.add('pres-slide-element-hover');
    });
    document.addEventListener('mouseleave', function() {
        if (lastHoverEl) {
            lastHoverEl.classList.remove('pres-slide-element-hover');
            lastHoverEl = null;
        }
    }, true);

    window.addEventListener('message', function(e) {
        var data = e.data;
        if (!data || data.nonce !== NONCE) return;
        if (data.action === 'goToSlide' && data.payload && typeof data.payload.index === 'number') {
            goToSlide(data.payload.index);
        }
        if (data.action === 'toggleNotes') {
            toggleNotes();
        }
    });

    // M9 fix: post ready after initial slide state is synced
    goToSlide(0);
    parent.postMessage({ nonce: NONCE, action: 'ready', payload: { slideCount: getSlides().length } }, ORIGIN);
})();`;
}
