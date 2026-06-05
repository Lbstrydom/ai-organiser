import { describe, it, expect } from 'vitest';
import { encodeAnchor, findAndDecodeAnchor, SLIDE_ANCHOR, ANCHOR_VERSION } from '../src/services/presentationIr/dotDashAnchor';

describe('dot-dash anchor codec', () => {
    it('encodes to a versioned base64 comment and round-trips', () => {
        const state = { id: 's1', role: 'insight', visual_data: { type: 'bar', items: [{ label: 'EMEA', value: 60 }] } };
        const anchor = encodeAnchor(state);
        expect(anchor.startsWith(`<!-- ${SLIDE_ANCHOR}:${ANCHOR_VERSION} `)).toBe(true);
        const decoded = findAndDecodeAnchor(anchor);
        expect(decoded?.ok).toBe(true);
        if (decoded?.ok) {
            expect(decoded.version).toBe(ANCHOR_VERSION);
            expect(decoded.state).toEqual(state);
        }
    });

    it('survives a payload containing "-->" (audit H5/H9 — comment-fence break)', () => {
        const state = { id: 's1', visual_data: { type: 'bar', items: [{ label: 'a --> b', value: 1 }] }, note: 'close --> here' };
        const anchor = encodeAnchor(state);
        // The literal "-->" must NOT appear before the real fence (it's base64'd).
        const firstFence = anchor.indexOf('-->');
        expect(anchor.slice(0, firstFence)).not.toContain('a --> b');
        const decoded = findAndDecodeAnchor(anchor);
        expect(decoded?.ok).toBe(true);
        if (decoded?.ok) expect(decoded.state).toEqual(state);
    });

    it('survives unicode + markdown metacharacters', () => {
        const state = { id: 's1', title: '“E—MEA” 60% *bold* `code` <tag>', visual_data: { type: 'none' } };
        const decoded = findAndDecodeAnchor(encodeAnchor(state));
        expect(decoded?.ok).toBe(true);
        if (decoded?.ok) expect(decoded.state).toEqual(state);
    });

    it('returns null when no anchor is present (fresh slide)', () => {
        expect(findAndDecodeAnchor('## A title\n- a point')).toBeNull();
    });

    it('returns {ok:false} for a base64 payload that is not JSON (corrupt)', () => {
        const decoded = findAndDecodeAnchor(`<!-- ${SLIDE_ANCHOR}:1 Z2FyYmFnZQ== -->`); // "garbage"
        expect(decoded).toEqual({ ok: false });
    });
});
