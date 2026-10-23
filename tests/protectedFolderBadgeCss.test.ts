/**
 * Protected-folder shield — CSS and source contracts that happy-dom cannot render.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PROTECTED_FOLDER_CLASS, PROTECTED_SHIELD_CLASS } from '../src/core/protectedFolderBadge';

const root = join(__dirname, '..');
const css = readFileSync(join(root, 'styles.css'), 'utf8');

/** The rule body for the first selector list containing `selector` (outside @media). */
function ruleBody(selector: string): string {
    const start = css.indexOf(selector);
    expect(start, `${selector} present in styles.css`).toBeGreaterThan(-1);
    const open = css.indexOf('{', start);
    return css.slice(open + 1, css.indexOf('}', open));
}

describe('protected-folder shield styles', () => {
    it('styles both classes the controller uses', () => {
        expect(css).toContain(`.${PROTECTED_FOLDER_CLASS}`);
        expect(css).toContain(`.${PROTECTED_SHIELD_CLASS}`);
    });

    it('keeps the name as the only shrinking element and the shield fixed-size', () => {
        const name = ruleBody(`.${PROTECTED_FOLDER_CLASS} > .nav-folder-title-content`);
        expect(name).toContain('min-width: 0');
        expect(name).toContain('text-overflow: ellipsis');
        const shield = ruleBody(`.${PROTECTED_SHIELD_CLASS} {`);
        expect(shield).toContain('flex: 0 0 auto');
    });

    it('draws the shield from a local data URI at full opacity with a theme token', () => {
        const shield = ruleBody(`.${PROTECTED_SHIELD_CLASS} {`);
        expect(shield).toContain('mask: url("data:image/svg+xml');
        expect(shield).toContain('var(--text-muted)');
        expect(shield).not.toMatch(/opacity/);
        expect(shield).not.toMatch(/url\(["']?https?:/);
    });

    it('has a larger mobile size', () => {
        expect(ruleBody(`.is-mobile .${PROTECTED_SHIELD_CLASS}`)).toMatch(/width: 16px/);
    });

    it('survives forced colors', () => {
        const idx = css.indexOf('@media (forced-colors: active)');
        expect(idx).toBeGreaterThan(-1);
        const block = css.slice(idx, css.indexOf('\n}\n', idx));
        expect(block).toContain(`.${PROTECTED_SHIELD_CLASS}`);
        expect(block).toContain('forced-color-adjust: none');
        expect(block).toContain('CanvasText');
    });
});

describe('explorer controller source', () => {
    const dir = join(root, 'src', 'ui', 'explorer');
    const sources = readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => readFileSync(join(dir, f), 'utf8'));

    it('never assigns element.style, logs to the console or injects scripts', () => {
        for (const src of sources) {
            expect(src).not.toMatch(/\.style\./);
            expect(src).not.toMatch(/console\./);
            expect(src).not.toMatch(/createElement\(['"]script['"]\)/);
        }
    });
});
