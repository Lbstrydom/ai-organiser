/**
 * The sweep report: a living note that gets one dated, plugin-owned section per run. Pure.
 *
 *   <!-- aio:sweep run=<runId> -->
 *   ## Sweep <date>
 *   - [ ] <text> <context> ([[<source path>]]) <!-- aio:task id=aio-<uuid> -->
 *   <!-- /aio:sweep -->
 *
 * Task text and context are INLINE DATA ONLY. The serialiser collapses newlines and control
 * characters, neutralises comment delimiters (a payload can never synthesise a marker), escapes
 * wiki-link delimiters, truncates to a cap and restricts the context to the known `@` set. The
 * parser requires exactly one start and one end marker for the run, in order, not nested, with only
 * task lines between them, and returns the set of task ids actually present, which is what crash
 * recovery compares with the approval record.
 */
import { Result, ok, err } from '../../core/result';
import { assertWritable, normalisePath, type ProtectedSource } from '../../core/protectedPaths';
import { nonBodyLines } from '../../utils/markdownRegions';
import { VALID_GTD_CONTEXTS } from '../validators/constants';

export const RUN_ID_PATTERN = /^run-[0-9a-z]{6,24}$/;
export const TASK_ID_PATTERN = /^aio-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MAX_TASK_TEXT = 300;

export interface ReportTask {
    id: string;
    text: string;
    context: string;
    sourcePath: string;
}

export const startMarker = (runId: string): string => `<!-- aio:sweep run=${runId} -->`;
export const endMarker = '<!-- /aio:sweep -->';

/** Make arbitrary text safe to place on one report line. */
export function sanitizeInline(raw: string, max = MAX_TASK_TEXT): string {
    let s = [...raw].map((ch) => { const c = ch.charCodeAt(0); return c < 32 || c === 127 || c === 0x2028 || c === 0x2029 ? ' ' : ch; }).join('').replace(/\s+/g, ' ').trim();
    s = s.replace(/<!--/g, '< !--').replace(/-->/g, '-- >');
    s = s.replace(/\[\[/g, '\\[\\[').replace(/\]\]/g, '\\]\\]');
    // A leading checkbox pattern would read as a nested task.
    s = s.replace(/^\[[ xX]\]\s*/, '');
    if (s.length > max) s = `${s.slice(0, max - 1).trimEnd()}…`;
    return s;
}

export function safeContext(context: string): string {
    return (VALID_GTD_CONTEXTS as readonly string[]).includes(context) ? context : '';
}

/** A vault path can become a `[[link]]` only when it contains none of the characters links cannot hold. */
export function isLinkSafePath(path: string): boolean {
    return path !== '' && !/[[\]#^|\n\r]/.test(path) && !path.includes('<!--') && !path.includes('-->');
}

function sourceRef(path: string): string {
    return isLinkSafePath(path) ? `[[${path}]]` : `source: ${sanitizeInline(path, 200).replace(/[()[\]#^|]/g, ' ').replace(/\s+/g, ' ').trim()}`;
}

export function renderTaskLine(task: ReportTask): Result<string> {
    if (!TASK_ID_PATTERN.test(task.id)) return err('invalid-task-id');
    const text = sanitizeInline(task.text);
    if (text === '') return err('empty-task');
    const context = safeContext(task.context);
    return ok(`- [ ] ${text}${context ? ` ${context}` : ''} (${sourceRef(task.sourcePath)}) <!-- aio:task id=${task.id} -->`);
}

/** One section for a run. `err` when the run id or any task is invalid, so nothing malformed is ever written. */
export function renderSection(runId: string, dateIso: string, tasks: readonly ReportTask[]): Result<string> {
    if (!RUN_ID_PATTERN.test(runId)) return err('invalid-run-id');
    const day = /^\d{4}-\d{2}-\d{2}/.exec(dateIso)?.[0];
    if (!day) return err('invalid-date');
    const lines: string[] = [];
    for (const task of tasks) {
        const line = renderTaskLine(task);
        if (!line.ok) return err(line.error);
        lines.push(line.value);
    }
    return ok([startMarker(runId), `## Sweep ${day}`, ...lines, endMarker].join('\n'));
}

export type SectionState =
    | { state: 'absent' }
    | { state: 'ok'; ids: string[]; start: number; end: number }
    | { state: 'conflict' };

const TASK_LINE = /^- \[[ xX]\] .* <!-- aio:task id=(aio-[0-9a-f-]{36}) -->$/;

/** Find this run's section in the report note and read the task ids it holds. */
export function findSection(text: string, runId: string): SectionState {
    const start = startMarker(runId);
    const lines = text.split('\n');
    const hidden = nonBodyLines(lines);
    const visible = lines.map((l, i) => (hidden[i] ? l.replace(/[^\r]/g, ' ') : l)).join('\n');
    const lineAt = (marker: string): number[] => {
        const at: number[] = [];
        for (let i = visible.indexOf(marker); i !== -1; i = visible.indexOf(marker, i + marker.length)) {
            const before = i === 0 ? '\n' : visible[i - 1];
            const after = visible[i + marker.length] ?? '\n';
            if (before === '\n' && (after === '\n' || after === '\r')) at.push(i);
        }
        return at;
    };
    const starts = lineAt(start);
    // The end marker is shared by every run, so only the one after our start counts.
    const ends = lineAt(endMarker);
    if (starts.length === 0) return { state: 'absent' };
    if (starts.length !== 1) return { state: 'conflict' };
    const end = ends.find((e) => e > starts[0]);
    if (end === undefined) return { state: 'conflict' };
    const inner = visible.slice(starts[0] + start.length, end);
    if (inner.includes('<!-- aio:sweep ')) return { state: 'conflict' }; // nested
    const ids: string[] = [];
    let sawHeading = false;
    for (const raw of inner.split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (line.trim() === '') continue;
        if (!sawHeading && /^## Sweep \d{4}-\d{2}-\d{2}/.test(line)) { sawHeading = true; continue; }
        const m = TASK_LINE.exec(line);
        if (!m) return { state: 'conflict' };
        if (!TASK_ID_PATTERN.test(m[1])) return { state: 'conflict' };
        ids.push(m[1]);
    }
    if (new Set(ids).size !== ids.length) return { state: 'conflict' };
    return { state: 'ok', ids, start: starts[0], end: end + endMarker.length };
}

/** Append a section to the report text, or leave it unchanged when this run's section is already there. */
export function appendSection(text: string, runId: string, section: string): Result<string> {
    const found = findSection(text, runId);
    if (found.state === 'conflict') return err('marker-conflict');
    if (found.state === 'ok') return ok(text);
    const body = text.replace(/\s+$/, '');
    return ok(`${body === '' ? '' : body + '\n\n'}${section}\n`);
}

/** Recovery decision for the report step: compare the ids in the note with the approval record's. */
export function reconcileReport(text: string, runId: string, expectedIds: readonly string[]): 'done' | 'redo' | 'conflict' {
    const found = findSection(text, runId);
    if (found.state === 'absent') return 'redo';
    if (found.state === 'conflict') return 'conflict';
    const have = new Set(found.ids);
    return have.size === expectedIds.length && expectedIds.every((id) => have.has(id)) ? 'done' : 'conflict';
}

/**
 * The report note path: vault-relative, a Markdown file, not hidden, not inside a protected folder.
 * Returns the normalised path.
 */
export function validateReportPath(raw: string, protectedFolders: ProtectedSource): Result<string> {
    const trimmed = raw.trim();
    if (trimmed === '' || /^([a-zA-Z]:|[\\/])/.test(trimmed) || trimmed.split(/[\\/]/).includes('..')) return err('sweep-report-invalid');
    const path = normalisePath(trimmed);
    if (path === '' || path.startsWith('.') || path.includes('/.') || !path.toLowerCase().endsWith('.md')) return err('sweep-report-invalid');
    if (!assertWritable(protectedFolders, 'create', path).ok) return err('protected-path');
    return ok(path);
}
