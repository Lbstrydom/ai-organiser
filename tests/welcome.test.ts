import { describe, it, expect } from 'vitest';
import { markWelcomeForExistingInstall } from '../src/core/welcome';

describe('who sees the welcome', () => {
    it('a new install (no saved data) sees it', () => {
        const m: Record<string, unknown> = {};
        markWelcomeForExistingInstall(null, m);
        expect(m.welcomeSeen).toBeUndefined();
    });
    it('an existing install, even legacy settings without features, does not', () => {
        const m: Record<string, unknown> = { serviceType: 'local' };
        markWelcomeForExistingInstall({ serviceType: 'local' }, m);
        expect(m.welcomeSeen).toBe(true);
    });
    it('keeps an existing value and is idempotent', () => {
        const m: Record<string, unknown> = { welcomeSeen: false };
        markWelcomeForExistingInstall({ welcomeSeen: false }, m);
        expect(m.welcomeSeen).toBe(false);
        const n: Record<string, unknown> = {};
        markWelcomeForExistingInstall({}, n);
        markWelcomeForExistingInstall({}, n);
        expect(n.welcomeSeen).toBe(true);
    });
});
