// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { enhanceAudioPlayersIn, LISTENED_RATIO } from '../src/ui/components/audioPlayerEnhancer';

/**
 * happy-dom does not implement `played` TimeRanges, so we install a controllable
 * fake. That is exactly why the plan also calls for a real-Chromium spec: this
 * suite pins the COVERAGE ARITHMETIC and the firing contract, not the browser's
 * TimeRanges semantics.
 */
function makeAudio(duration: number) {
    const el = document.createElement('audio');
    const ranges: [number, number][] = [];
    Object.defineProperty(el, 'duration', { value: duration, configurable: true });
    Object.defineProperty(el, 'played', {
        configurable: true,
        get: () => ({
            length: ranges.length,
            start: (i: number) => ranges[i][0],
            end: (i: number) => ranges[i][1],
        }),
    });
    Object.defineProperty(el, 'src', { value: 'brief-test.wav', configurable: true });
    return {
        el,
        /** Simulate genuine playback of [from, to]. */
        play(from: number, to: number) { ranges.push([from, to]); },
        /** Simulate a seek: moves the position, extends NO played range. */
        seek() { /* deliberately records nothing */ },
        fire(event: string) { el.dispatchEvent(new Event(event)); },
    };
}

function mount(audio: HTMLAudioElement) {
    const container = document.createElement('div');
    container.appendChild(audio);
    return container;
}

describe('enhanceAudioPlayersIn — listen detection', () => {
    it('fires once when played coverage clears the threshold', () => {
        const a = makeAudio(100);
        const onListened = vi.fn();
        enhanceAudioPlayersIn(mount(a.el), { onListened });

        a.play(0, 90);
        a.fire('timeupdate');
        expect(onListened).toHaveBeenCalledTimes(1);
        expect(onListened).toHaveBeenCalledWith('brief-test.wav');
    });

    it('does not fire twice', () => {
        const a = makeAudio(100);
        const onListened = vi.fn();
        enhanceAudioPlayersIn(mount(a.el), { onListened });

        a.play(0, 95);
        a.fire('timeupdate');
        a.fire('timeupdate');
        a.fire('ended');
        expect(onListened).toHaveBeenCalledTimes(1);
    });

    it('does NOT fire on a scrub-to-end', () => {
        // The regression a currentTime threshold would have: dragging the
        // scrubber to 95% and hitting the end never played anything.
        const a = makeAudio(100);
        const onListened = vi.fn();
        enhanceAudioPlayersIn(mount(a.el), { onListened });

        a.seek();
        a.fire('timeupdate');
        a.fire('ended');
        expect(onListened).not.toHaveBeenCalled();
    });

    it('does NOT fire for play-to-half then seek to the end', () => {
        const a = makeAudio(100);
        const onListened = vi.fn();
        enhanceAudioPlayersIn(mount(a.el), { onListened });

        a.play(0, 50);
        a.seek();
        a.fire('ended');
        expect(onListened).not.toHaveBeenCalled();
    });

    it('sums disjoint played ranges', () => {
        const a = makeAudio(100);
        const onListened = vi.fn();
        enhanceAudioPlayersIn(mount(a.el), { onListened });

        a.play(0, 50);
        a.fire('timeupdate');
        expect(onListened).not.toHaveBeenCalled();

        a.play(60, 100);
        a.fire('timeupdate');
        expect(onListened).toHaveBeenCalledTimes(1);
    });

    it('evaluates late-arriving metadata rather than bailing out at attach time', () => {
        // `duration` is NaN until metadata loads — the common case. Attaching
        // only when it is already finite would silently disable the feature.
        const el = document.createElement('audio');
        const ranges: [number, number][] = [];
        let duration = Number.NaN;
        Object.defineProperty(el, 'duration', { configurable: true, get: () => duration });
        Object.defineProperty(el, 'played', {
            configurable: true,
            get: () => ({ length: ranges.length, start: (i: number) => ranges[i][0], end: (i: number) => ranges[i][1] }),
        });
        const onListened = vi.fn();
        enhanceAudioPlayersIn(mount(el), { onListened });

        el.dispatchEvent(new Event('timeupdate'));
        expect(onListened).not.toHaveBeenCalled();

        duration = 100;
        ranges.push([0, 95]);
        el.dispatchEvent(new Event('loadedmetadata'));
        expect(onListened).toHaveBeenCalledTimes(1);
    });

    it('is inert for a zero or infinite duration', () => {
        for (const d of [0, Number.POSITIVE_INFINITY]) {
            const a = makeAudio(d);
            const onListened = vi.fn();
            enhanceAudioPlayersIn(mount(a.el), { onListened });
            a.play(0, 1000);
            a.fire('ended');
            expect(onListened).not.toHaveBeenCalled();
        }
    });

    it('is a no-op without a callback, and still adds the speed controls', () => {
        const a = makeAudio(100);
        const container = mount(a.el);
        expect(() => enhanceAudioPlayersIn(container)).not.toThrow();
        a.play(0, 100);
        a.fire('ended');
        expect(container.querySelector('.ai-organiser-audio-speed-controls')).not.toBeNull();
    });

    it('the returned disposer detaches the listeners', () => {
        const a = makeAudio(100);
        const onListened = vi.fn();
        const dispose = enhanceAudioPlayersIn(mount(a.el), { onListened });

        dispose();
        a.play(0, 100);
        a.fire('ended');
        expect(onListened).not.toHaveBeenCalled();
    });

    it('uses the documented threshold', () => {
        expect(LISTENED_RATIO).toBeGreaterThan(0.5);
        expect(LISTENED_RATIO).toBeLessThan(1);
    });
});

describe('enhanceAudioPlayersIn — default playback speed', () => {
    it('applies the configured default speed to a freshly-enhanced element', () => {
        const a = makeAudio(100);
        enhanceAudioPlayersIn(mount(a.el), { defaultSpeed: 2 });
        expect(a.el.playbackRate).toBe(2);
    });

    it('defaults to 1× when no speed is configured — unchanged behavior', () => {
        const a = makeAudio(100);
        enhanceAudioPlayersIn(mount(a.el));
        expect(a.el.playbackRate).toBe(1);
    });

    it('highlights the matching speed button as active, not always 1×', () => {
        const a = makeAudio(100);
        const container = mount(a.el);
        enhanceAudioPlayersIn(container, { defaultSpeed: 1.5 });
        const active = container.querySelector('.ai-organiser-audio-speed-btn.is-active');
        expect(active?.getAttribute('data-speed')).toBe('1.5');
    });

    it('degrades to 1× for an out-of-list value rather than applying garbage', () => {
        const a = makeAudio(100);
        enhanceAudioPlayersIn(mount(a.el), { defaultSpeed: 3.7 as never });
        expect(a.el.playbackRate).toBe(1);
    });
});

describe('enhanceAudioPlayersIn: playback reporting', () => {
    function setup() {
        const a = makeAudio(100);
        const onPlayback = vi.fn();
        const container = mount(a.el);
        const dispose = enhanceAudioPlayersIn(container, { onPlayback });
        return { a, onPlayback, container, dispose };
    }

    it('reports play, pause and end with the player source', () => {
        const { a, onPlayback } = setup();
        Object.defineProperty(a.el, 'paused', { value: false, configurable: true });
        a.fire('play');
        a.fire('playing');
        a.fire('timeupdate');
        Object.defineProperty(a.el, 'paused', { value: true, configurable: true });
        a.fire('pause');
        a.fire('ended');
        expect(onPlayback.mock.calls.map((c) => c[1])).toEqual(['playing', 'playing', 'playing', 'paused', 'ended']);
        expect(onPlayback.mock.calls[0][0]).toBe('brief-test.wav');
    });

    it('a time update on a paused or ended player is not a heartbeat', () => {
        const { a, onPlayback } = setup();
        Object.defineProperty(a.el, 'paused', { value: true, configurable: true });
        a.fire('timeupdate');
        expect(onPlayback).not.toHaveBeenCalled();
    });

    it('re-rendering the same player reports once, not twice', () => {
        const { a, onPlayback, container } = setup();
        enhanceAudioPlayersIn(container, { onPlayback });
        a.fire('play');
        expect(onPlayback).toHaveBeenCalledTimes(1);
    });

    it('stops reporting after dispose', () => {
        const { a, onPlayback, dispose } = setup();
        dispose();
        a.fire('play');
        expect(onPlayback).not.toHaveBeenCalled();
    });

    it('without the hook nothing is attached (existing behaviour)', () => {
        const a = makeAudio(100);
        const container = mount(a.el);
        const spy = vi.spyOn(a.el, 'addEventListener');
        enhanceAudioPlayersIn(container, {});
        expect(spy.mock.calls.map((c) => c[0])).not.toContain('play');
    });
});

describe('enhanceAudioPlayersIn: disposing frees the element for a new render', () => {
    it('listen detection works again on the same element after a dispose', () => {
        const a = makeAudio(100);
        const container = mount(a.el);
        const first = vi.fn();
        const dispose = enhanceAudioPlayersIn(container, { onListened: first });
        dispose();
        const second = vi.fn();
        enhanceAudioPlayersIn(container, { onListened: second });
        a.play(0, 90);
        a.fire('timeupdate');
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
    });

    it('playback reporting works again on the same element after a dispose', () => {
        const a = makeAudio(100);
        const container = mount(a.el);
        const first = vi.fn();
        enhanceAudioPlayersIn(container, { onPlayback: first })();
        const second = vi.fn();
        enhanceAudioPlayersIn(container, { onPlayback: second });
        a.fire('play');
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
    });
});
