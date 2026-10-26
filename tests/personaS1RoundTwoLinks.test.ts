import { describe, it, expect } from 'vitest';
import { neutraliseByCache } from '../src/services/aiWorkspaces/linkNeutraliser';

const policy = { isShareable: () => true, resolve: () => null } as never;

describe('external image labels', () => {
    it.each([
        '![Diagram [draft]](https://example.org/d.png)',
        String.raw`![Diagram \] odd](https://example.org/d.png)`,
    ])('an empty cache does not block %s', (text) => {
        expect(neutraliseByCache(text + '\n', 'a.md', [], policy).ok).toBe(true);
    });
    it('still fails closed for a vault image with a nested label', () => {
        expect(neutraliseByCache('![A [b]](pic.png)\n', 'a.md', [], policy).ok).toBe(false);
    });
});
