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
