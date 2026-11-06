/**
 * Mermaid syntax check using the parser Obsidian renders with.
 *
 * `loadMermaid()` hands back whatever engine this Obsidian version draws diagrams with
 * (its own Pele renderer behind a Mermaid-shaped wrapper in 1.15), so a verdict here
 * matches what the note will show. Runs locally. Results are ADVISORY ONLY: never block rendering.
 *
 * A parser that cannot be loaded or used falls back to `validateMermaidSyntax`, so a
 * failed load never reads as a valid diagram.
 */
import { loadMermaid } from 'obsidian';
import { logger } from './logger';
import { validateMermaidSyntax } from './mermaidUtils';

export type MermaidCheck =
    | { source: 'parser'; valid: true }
    | { source: 'parser'; valid: false; line?: number }
    | { source: 'heuristic'; valid: boolean; warnings: string[] };

export interface MermaidCheckStrings {
    syntaxErrors: string;
    parseFailedTitle: string;
    parseFailed: string;
    parseFailedAtLine: string;
}

const PARSER_LOAD_TIMEOUT_MS = 3000;

function heuristicCheck(code: string): MermaidCheck {
    return { source: 'heuristic', ...validateMermaidSyntax(code) };
}

async function loadParser(load: () => Promise<unknown>): Promise<unknown> {
    let timer: number | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error('Mermaid parser load timed out')), PARSER_LOAD_TIMEOUT_MS);
    });
    try {
        return await Promise.race([load(), timeout]);
    } finally {
        window.clearTimeout(timer);
    }
}

/** Pele errors carry a 1-based `line` (0 when there is none); anything else reports no position. */
function lineOf(error: unknown): number | undefined {
    const line = (error as { line?: unknown } | null | undefined)?.line;
    return typeof line === 'number' && line > 0 ? line : undefined;
}

export async function checkMermaidSyntax(
    code: string,
    load: () => Promise<unknown> = loadMermaid,
): Promise<MermaidCheck> {
    if (!code?.trim()) return heuristicCheck(code);

    let parser: { parse?: unknown } | null | undefined;
    try {
        parser = await loadParser(load) as { parse?: unknown } | null | undefined;
    } catch (error) {
        logger.debug('MermaidCheck', `Parser unavailable: ${String(error)}`);
        return heuristicCheck(code);
    }
    if (typeof parser?.parse !== 'function') return heuristicCheck(code);

    try {
        const parsed: unknown = await (parser.parse as (text: string) => unknown).call(parser, code);
        return parsed === false ? { source: 'parser', valid: false } : { source: 'parser', valid: true };
    } catch (error) {
        // A broken parser is not a verdict on the diagram.
        if (error instanceof TypeError || error instanceof ReferenceError) {
            logger.debug('MermaidCheck', `Parser failed: ${String(error)}`);
            return heuristicCheck(code);
        }
        return { source: 'parser', valid: false, line: lineOf(error) };
    }
}

/** The advisory block to show for a check, or null when there is nothing to say. */
export function describeMermaidCheck(
    check: MermaidCheck,
    t: MermaidCheckStrings,
): { title: string; items: string[] } | null {
    if (check.valid) return null;
    if (check.source === 'heuristic') {
        return check.warnings.length > 0 ? { title: t.syntaxErrors, items: check.warnings } : null;
    }
    const item = check.line === undefined
        ? t.parseFailed
        : t.parseFailedAtLine.replace('{line}', String(check.line));
    return { title: t.parseFailedTitle, items: [item] };
}
