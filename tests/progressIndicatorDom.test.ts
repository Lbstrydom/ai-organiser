// @vitest-environment happy-dom
/**
 * Shared waiting indicator (waiting-state-ux) — DOM structure, a11y contract,
 * lifecycle (happy-dom).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildProgressIndicator } from '../src/services/progress/progressIndicatorDom';

let container: HTMLElement;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); });

describe('buildProgressIndicator', () => {
    it('appends exactly one root node', () => {
        buildProgressIndicator(container, { phaseText: 'Working' });
        expect(container.children.length).toBe(1);
        expect(container.querySelector('.ai-organiser-progress')).not.toBeNull();
    });

    it('a11y: status is a polite atomic live region; elapsed is aria-hidden + outside it', () => {
        buildProgressIndicator(container, { phaseText: 'Generating', elapsedText: '0:03' });
        const status = container.querySelector('.ai-organiser-progress-status')!;
        expect(status.getAttribute('role')).toBe('status');
        expect(status.getAttribute('aria-live')).toBe('polite');
        expect(status.getAttribute('aria-atomic')).toBe('true');
        const elapsed = container.querySelector('[data-testid="progress-elapsed"]')!;
        expect(elapsed.getAttribute('aria-hidden')).toBe('true');
        expect(status.contains(elapsed)).toBe(false);   // elapsed NOT inside the live region
    });

    it('setStatusFragment mutates only on change', () => {
        const h = buildProgressIndicator(container);
        const frag = container.querySelector('.ai-organiser-progress-fragment') as HTMLElement;
        h.setStatusFragment('a');
        expect(frag.textContent).toBe('a');
        // spy on the setter target — no write when unchanged
        const desc = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
        const spy = vi.fn();
        Object.defineProperty(frag, 'textContent', { configurable: true, get: () => 'a', set: spy });
        h.setStatusFragment('a');
        expect(spy).not.toHaveBeenCalled();
        Object.defineProperty(frag, 'textContent', desc!);
    });

    it('setElapsed updates the elapsed text', () => {
        const h = buildProgressIndicator(container);
        h.setElapsed('1:23');
        expect(container.querySelector('[data-testid="progress-elapsed"]')!.textContent).toBe('1:23');
    });

    it('mountCancel: native labelled button, idempotent (replaces handler, single button)', () => {
        const h = buildProgressIndicator(container, { cancelLabel: 'Cancel' });
        const a = vi.fn(); const b = vi.fn();
        h.mountCancel(a);
        h.mountCancel(b);   // idempotent — replaces handler, no second button
        const btns = container.querySelectorAll('button.ai-organiser-progress-cancel');
        expect(btns.length).toBe(1);
        const btn = btns[0] as HTMLButtonElement;
        expect(btn.getAttribute('type')).toBe('button');
        expect(btn.getAttribute('aria-label')).toBe('Cancel');
        btn.click();
        expect(a).not.toHaveBeenCalled();  // old handler removed
        expect(b).toHaveBeenCalledTimes(1);
    });

    it('idempotent mount: re-building on the same container destroys the prior root', () => {
        buildProgressIndicator(container, { phaseText: 'first' });
        buildProgressIndicator(container, { phaseText: 'second' });
        expect(container.querySelectorAll('.ai-organiser-progress').length).toBe(1);
        expect(container.querySelector('.ai-organiser-progress-phase')!.textContent).toBe('second');
    });

    it('destroy removes the node + setters become no-ops; never touches siblings', () => {
        const sibling = document.createElement('p');
        sibling.textContent = 'keep me';
        container.appendChild(sibling);
        const h = buildProgressIndicator(container);
        h.destroy();
        expect(container.querySelector('.ai-organiser-progress')).toBeNull();
        expect(container.contains(sibling)).toBe(true);   // sibling untouched (no innerHTML='')
        h.setPhase('x');  // no throw, no effect
        expect(container.querySelector('.ai-organiser-progress')).toBeNull();
    });
});
