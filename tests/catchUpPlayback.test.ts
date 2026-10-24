// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probeEpisodePlaying } from '../src/services/newsletter/catchUp/catchUpPlayback';

const NAME = 'catchup-20261022-081500-a1b2-c3d4e5f6.mp3';

function player(src: string, state: { paused: boolean; ended?: boolean }): HTMLAudioElement {
    const el = document.createElement('audio');
    Object.defineProperty(el, 'currentSrc', { value: src, configurable: true });
    Object.defineProperty(el, 'paused', { value: state.paused, configurable: true });
    Object.defineProperty(el, 'ended', { value: state.ended ?? false, configurable: true });
    document.body.appendChild(el);
    return el;
}

const app = (docs: Document[] = []) => ({
    workspace: { iterateAllLeaves: (cb: (leaf: { containerEl: { ownerDocument: Document } }) => void) => { for (const d of docs) cb({ containerEl: { ownerDocument: d } }); } },
}) as never;

beforeEach(() => { (globalThis as { activeDocument?: Document }).activeDocument = document; });
afterEach(() => { document.body.innerHTML = ''; delete (globalThis as { activeDocument?: Document }).activeDocument; });

describe('probeEpisodePlaying (the live "is it playing now" check)', () => {
    it('playing when a player is actively playing that episode, query strings and encoding ignored', () => {
        player(`app://obsidian/AI%20Organiser/Catch-up/${NAME}?1729000000`, { paused: false });
        expect(probeEpisodePlaying(app(), NAME)).toBe('playing');
    });

    it('idle when the matching player is paused or has ended', () => {
        player(`app://x/Catch-up/${NAME}`, { paused: true });
        expect(probeEpisodePlaying(app(), NAME)).toBe('idle');
        document.body.innerHTML = '';
        player(`app://x/Catch-up/${NAME}`, { paused: false, ended: true });
        expect(probeEpisodePlaying(app(), NAME)).toBe('idle');
    });

    it('a different recording playing does not count, even with a similar name', () => {
        player('app://x/Catch-up/catchup-20261022-081500-a1b2-ffffffff.mp3', { paused: false });
        player(`app://x/other/${NAME}.bak`, { paused: false });
        expect(probeEpisodePlaying(app(), NAME)).toBe('idle');
    });

    it('looks in popout windows too', () => {
        const other = document.implementation.createHTMLDocument('popout');
        const el = other.createElement('audio');
        Object.defineProperty(el, 'currentSrc', { value: `app://x/${NAME}`, configurable: true });
        Object.defineProperty(el, 'paused', { value: false, configurable: true });
        other.body.appendChild(el);
        expect(probeEpisodePlaying(app([other]), NAME)).toBe('playing');
    });

    it('a player that is playing something the probe cannot name might be this episode, so it blocks', () => {
        player('blob:app://obsidian/1234', { paused: false });
        expect(probeEpisodePlaying(app(), NAME)).toBe('unknown');
        document.body.innerHTML = '';
        player('', { paused: false });
        expect(probeEpisodePlaying(app(), NAME)).toBe('unknown');
    });

    it('a paused unnamed player does not block', () => {
        player('blob:app://obsidian/1234', { paused: true });
        expect(probeEpisodePlaying(app(), NAME)).toBe('idle');
    });

    it('unknown when it cannot look at all, and when looking throws', () => {
        delete (globalThis as { activeDocument?: Document }).activeDocument;
        expect(probeEpisodePlaying({} as never, NAME)).toBe('unknown');

        const hostile = { querySelectorAll: () => { throw new Error('detached'); } } as unknown as Document;
        expect(probeEpisodePlaying(app([hostile]), NAME)).toBe('unknown');
    });
});
