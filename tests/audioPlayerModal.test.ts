// @vitest-environment happy-dom
/**
 * AudioPlayerModal — focused player with speed pills + skip buttons.
 * Verifies the persona-driven Pat fix (community plugin no longer required
 * for basic speed/skip controls).
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('obsidian', () => {
    class MockTFile {
        path = '';
        basename = '';
        extension = '';
    }
    class Modal {
        contentEl: HTMLElement;
        constructor(public app: unknown) {
            this.contentEl = document.createElement('div');
            const polyfill = (el: HTMLElement): void => {
                (el as unknown as Record<string, unknown>).empty = () => { while (el.firstChild) el.removeChild(el.firstChild); };
                (el as unknown as Record<string, unknown>).addClass = (c: string) => { el.classList.add(c); };
                (el as unknown as Record<string, unknown>).removeClass = (c: string) => { el.classList.remove(c); };
                (el as unknown as Record<string, unknown>).createEl = (tag: string, opts?: { cls?: string; text?: string }) => {
                    const child = document.createElement(tag);
                    if (opts?.cls) child.className = opts.cls;
                    if (opts?.text) child.textContent = opts.text;
                    el.appendChild(child);
                    polyfill(child);
                    return child;
                };
                (el as unknown as Record<string, unknown>).createDiv = (opts?: { cls?: string; text?: string }) => {
                    const d = document.createElement('div');
                    if (opts?.cls) d.className = opts.cls;
                    if (opts?.text) d.textContent = opts.text;
                    el.appendChild(d);
                    polyfill(d);
                    return d;
                };
                (el as unknown as Record<string, unknown>).createSpan = (opts?: { cls?: string; text?: string }) => {
                    const s = document.createElement('span');
                    if (opts?.cls) s.className = opts.cls;
                    if (opts?.text) s.textContent = opts.text;
                    el.appendChild(s);
                    polyfill(s);
                    return s;
                };
            };
            polyfill(this.contentEl);
        }
        onOpen(): void { /* override */ }
        onClose(): void { /* override */ }
        open(): void { this.onOpen(); }
        close(): void { this.onClose(); }
    }
    return { TFile: MockTFile, Modal };
});

import { TFile } from 'obsidian';
import { AudioPlayerModal } from '../src/ui/modals/AudioPlayerModal';

interface MockApp {
    vault: { getResourcePath: (f: unknown) => string };
    workspace: { openLinkText: ReturnType<typeof vi.fn> };
}
const mockApp: MockApp = {
    vault: {
        getResourcePath: (_f: unknown) => 'app://local/path/to/foo.mp3',
    },
    workspace: { openLinkText: vi.fn() },
};

const mockPlugin = {
    t: {
        modals: {
            audioPlayer: {
                title: 'Play narration',
                speedLabel: 'Speed:',
                skipBack: '← {sec}s',
                skipForward: '{sec}s →',
                openExternal: 'Open in default player',
            },
        },
    },
} as never;

function makeFile(): TFile {
    const f = new TFile();
    f.path = 'AI-Organiser/Narrations/foo.abc12345.mp3';
    f.basename = 'foo.abc12345';
    f.extension = 'mp3';
    return f;
}

describe('AudioPlayerModal', () => {
    it('renders 5 speed pills (0.75x to 2x)', () => {
        const m = new AudioPlayerModal(mockApp as never, mockPlugin, makeFile());
        m.open();
        const rates = m.contentEl.querySelectorAll('.ai-organiser-audio-player-rate');
        expect(rates.length).toBe(5);
        const labels = Array.from(rates).map(r => r.textContent);
        expect(labels).toEqual(['0.75×', '1×', '1.25×', '1.5×', '2×']);
    });

    it('marks 1x as the default active pill', () => {
        const m = new AudioPlayerModal(mockApp as never, mockPlugin, makeFile());
        m.open();
        const active = m.contentEl.querySelectorAll('.ai-organiser-audio-player-rate.is-active');
        expect(active.length).toBe(1);
        expect(active[0].textContent).toBe('1×');
    });

    it('renders skip-back-15s and skip-forward-30s buttons', () => {
        const m = new AudioPlayerModal(mockApp as never, mockPlugin, makeFile());
        m.open();
        const skipBtns = m.contentEl.querySelectorAll('.ai-organiser-audio-player-skip');
        expect(skipBtns.length).toBe(2);
        expect(skipBtns[0].textContent).toBe('← 15s');
        expect(skipBtns[1].textContent).toBe('30s →');
    });

    it('renders an <audio> element with controls + the file resource path', () => {
        const m = new AudioPlayerModal(mockApp as never, mockPlugin, makeFile());
        m.open();
        const audio = m.contentEl.querySelector('audio') as HTMLAudioElement | null;
        expect(audio).not.toBeNull();
        expect(audio?.controls).toBe(true);
        expect(audio?.src).toContain('foo.mp3');
    });

    it('clicking a speed pill changes the audio playbackRate and active state', () => {
        const m = new AudioPlayerModal(mockApp as never, mockPlugin, makeFile());
        m.open();
        const audio = m.contentEl.querySelector('audio') as HTMLAudioElement;
        const rates = m.contentEl.querySelectorAll('.ai-organiser-audio-player-rate');
        const fastBtn = Array.from(rates).find(r => r.textContent === '1.5×') as HTMLButtonElement;
        fastBtn.click();
        expect(audio.playbackRate).toBe(1.5);
        expect(fastBtn.classList.contains('is-active')).toBe(true);
        const oneXBtn = Array.from(rates).find(r => r.textContent === '1×') as HTMLButtonElement;
        expect(oneXBtn.classList.contains('is-active')).toBe(false);
    });

    it('clicking skip-back rewinds 15 seconds (clamped at 0)', () => {
        const m = new AudioPlayerModal(mockApp as never, mockPlugin, makeFile());
        m.open();
        const audio = m.contentEl.querySelector('audio') as HTMLAudioElement;
        audio.currentTime = 30;
        const back = m.contentEl.querySelector('.ai-organiser-audio-player-skip') as HTMLButtonElement;
        back.click();
        expect(audio.currentTime).toBe(15);
        // Clamp at 0
        audio.currentTime = 5;
        back.click();
        expect(audio.currentTime).toBe(0);
    });

    it('clicking skip-forward advances 30 seconds', () => {
        const m = new AudioPlayerModal(mockApp as never, mockPlugin, makeFile());
        m.open();
        const audio = m.contentEl.querySelector('audio') as HTMLAudioElement;
        audio.currentTime = 10;
        const skips = m.contentEl.querySelectorAll('.ai-organiser-audio-player-skip');
        const forward = skips[1] as HTMLButtonElement;
        forward.click();
        expect(audio.currentTime).toBe(40);
    });

    it('clicking "Open in default player" pauses + closes + opens via workspace', () => {
        const m = new AudioPlayerModal(mockApp as never, mockPlugin, makeFile());
        m.open();
        const audio = m.contentEl.querySelector('audio') as HTMLAudioElement;
        const pauseSpy = vi.spyOn(audio, 'pause');
        const external = m.contentEl.querySelector('.ai-organiser-audio-player-external') as HTMLButtonElement;
        external.click();
        expect(pauseSpy).toHaveBeenCalled();
        expect(mockApp.workspace.openLinkText).toHaveBeenCalled();
    });
});
