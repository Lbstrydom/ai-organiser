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
