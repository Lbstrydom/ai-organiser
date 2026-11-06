/**
 * Tests for mermaidParseCheck.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkMermaidSyntax, describeMermaidCheck } from '../src/utils/mermaidParseCheck';

const CODE = 'flowchart TD\n  A --> B';
// Passes every heuristic, so a heuristic result here proves the parser was not consulted.
const HEURISTIC_CLEAN = { source: 'heuristic', valid: true, warnings: [] };

const strings = {
    syntaxErrors: 'warnings',
    parseFailedTitle: 'problem',
    parseFailed: 'unreadable',
    parseFailedAtLine: 'line {line} unreadable',
};

/** The rejection Obsidian's wrapper gives: a PeleError with a 1-based line. */
function peleError(line: number): Error {
    return Object.assign(new Error(`Parse error on line ${line}:`), { name: 'PeleError', code: 'syntax', line, column: 3 });
}

describe('checkMermaidSyntax', () => {
    // The suite runs in node; the check uses window timers.
    beforeEach(() => { vi.stubGlobal('window', globalThis); });
    afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

    it('reports valid when the parser accepts the diagram', async () => {
        const parse = vi.fn().mockResolvedValue({ diagramType: 'flowchart' });
        await expect(checkMermaidSyntax(CODE, async () => ({ parse }))).resolves.toEqual({ source: 'parser', valid: true });
        expect(parse).toHaveBeenCalledWith(CODE);
    });

    it('calls parse on the loaded object, so a method using this still works', async () => {
        const parser = { ok: true, parse(this: { ok: boolean }) { return Promise.resolve(this.ok); } };
        await expect(checkMermaidSyntax(CODE, async () => parser)).resolves.toEqual({ source: 'parser', valid: true });
    });

    it('reports the line when the parser rejects the diagram', async () => {
        const parse = vi.fn().mockRejectedValue(peleError(2));
        await expect(checkMermaidSyntax(CODE, async () => ({ parse }))).resolves.toEqual({ source: 'parser', valid: false, line: 2 });
    });

    it('omits the line when the error has no usable position', async () => {
        for (const rejection of [Object.assign(new Error('No diagram type'), { line: 0 }), new Error('other'), 'text']) {
            const parse = vi.fn().mockRejectedValue(rejection);
            await expect(checkMermaidSyntax(CODE, async () => ({ parse }))).resolves.toEqual({ source: 'parser', valid: false, line: undefined });
        }
    });

    it('reads a false result as invalid', async () => {
        const parse = vi.fn().mockResolvedValue(false);
        await expect(checkMermaidSyntax(CODE, async () => ({ parse }))).resolves.toEqual({ source: 'parser', valid: false });
    });

    it('falls back to the heuristics when loading fails', async () => {
        await expect(checkMermaidSyntax(CODE, () => Promise.reject(new Error('no parser')))).resolves.toEqual(HEURISTIC_CLEAN);
    });

    it('a failed load still reports what the heuristics find', async () => {
        const result = await checkMermaidSyntax('flowchart TD\n  A[open --> B', () => Promise.reject(new Error('no parser')));
        expect(result.source).toBe('heuristic');
        expect(result.valid).toBe(false);
    });

    it('falls back when the loaded object has no parse function', async () => {
        for (const loaded of [{}, null, undefined, { parse: 'nope' }]) {
            await expect(checkMermaidSyntax(CODE, async () => loaded)).resolves.toEqual(HEURISTIC_CLEAN);
        }
    });

    it('falls back when the parser itself is broken, rather than blaming the diagram', async () => {
        const parse = vi.fn().mockRejectedValue(new TypeError('x is not a function'));
        await expect(checkMermaidSyntax(CODE, async () => ({ parse }))).resolves.toEqual(HEURISTIC_CLEAN);
    });

    it('falls back when loading never finishes', async () => {
        vi.useFakeTimers();
        const pending = checkMermaidSyntax(CODE, () => new Promise(() => { /* never */ }));
        await vi.advanceTimersByTimeAsync(3000);
        await expect(pending).resolves.toEqual(HEURISTIC_CLEAN);
    });

    it('does not load the parser for an empty diagram', async () => {
        const load = vi.fn();
        const result = await checkMermaidSyntax('   ', load);
        expect(load).not.toHaveBeenCalled();
        expect(result).toMatchObject({ source: 'heuristic', valid: false });
    });
});

describe('describeMermaidCheck', () => {
    it('says nothing for a valid diagram', () => {
        expect(describeMermaidCheck({ source: 'parser', valid: true }, strings)).toBeNull();
        expect(describeMermaidCheck({ source: 'heuristic', valid: true, warnings: [] }, strings)).toBeNull();
    });

    it('names the line when the parser gave one', () => {
        expect(describeMermaidCheck({ source: 'parser', valid: false, line: 4 }, strings))
            .toEqual({ title: 'problem', items: ['line 4 unreadable'] });
    });

    it('uses the general message when the parser gave no line', () => {
        expect(describeMermaidCheck({ source: 'parser', valid: false }, strings))
            .toEqual({ title: 'problem', items: ['unreadable'] });
    });

    it('lists heuristic warnings under the softer heading', () => {
        expect(describeMermaidCheck({ source: 'heuristic', valid: false, warnings: ['a', 'b'] }, strings))
            .toEqual({ title: 'warnings', items: ['a', 'b'] });
    });
});
