/**
 * Attachment helper: "Remove the link and delete".
 *
 * A kept file is blocked because a note still links to it. This service plans the removal of those
 * links, and applies it ONLY as the exact plan the user approved in the preview:
 *
 *  - `planLinkRemoval` is pure. It finds the references to one file in one note with the same
 *    extractor the scan uses, resolves each from the note's own path (a same-named file elsewhere is
 *    untouched) and rewrites body lines only (frontmatter and code fences are never edited).
 *  - `removeLinks` writes one note at a time through `applyNoteEdit` (composite target, `review:false`
 *    because the caller's preview is the approval). The commit re-plans against the live text and
 *    refuses unless the re-plan equals what was approved, so a note that changed after the preview is
 *    never edited behind the user's back. It stops at the first note that is not written and never
 *    rolls back (a rollback could overwrite the user's own edits).
 *  - The write is a capability: `isLinkRemovalEnabled` (Find embeds on AND the setting on, default off)
 *    is checked again before any write.
 */
import type AIOrganiserPlugin from '../main';
import { Result, ok, err, type BatchResult } from '../core/result';
import { nonBodyLines } from '../utils/markdownRegions';
import { isFeatureEnabled } from './featureService';
import { applyNoteEdit, type CompositeTarget } from './noteEdit/applyNoteEdit';
import { extractReferenceSpansFromLine, isExternalUrl, normalizeEmbedPath } from './embedScanService';
import type { AIOrganiserSettings } from '../core/settings';

export type Resolve = (linktext: string, sourcePath: string) => string | null;

/** One changed line. `after: null` means the line is dropped. */
export interface LineChange {
    /** 1-based line number in the note as it was planned */
    line: number;
    before: string;
    after: string | null;
}

export interface NotePlan {
    notePath: string;
    /** The note text the plan was made from */
    baseline: string;
    changes: LineChange[];
    nextText: string;
}

export type PlanResult =
    | { status: 'ok'; plan: NotePlan }
    /** No reference to the file in this note any more */
    | { status: 'nothing' }
    /** References exist, but only where this action does not edit (frontmatter, code) */
    | { status: 'not-removable' };

export type UnlinkStatus = 'written' | 'stale' | 'refused-protected' | 'failed' | 'skipped';

export interface UnlinkOutcome {
    notePath: string;
    status: UnlinkStatus;
}

/** The two gates of the write capability, in one place. Fails closed. */
export function isLinkRemovalEnabled(settings: Pick<AIOrganiserSettings, 'attachmentAllowLinkRemoval' | 'featureFlags'>): boolean {
    return isFeatureEnabled(settings, 'embed-scan') && settings.attachmentAllowLinkRemoval === true;
}

const WIKI_FULL = /^\[\[([^\]|]+)(?:\|([^\]]*))?\]\]$/;
const MD_LINK_FULL = /^\[([^\]]+)\]\(([^)]+)\)$/;
const LIST_MARKER_ONLY = /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]*(?:\[[ xX]\][ \t]*)?)$/;

/** What replaces one reference: nothing for an embed, its visible text for a link. */
function replacementFor(originalText: string): string {
    if (originalText.startsWith('![')) return '';
    const wiki = originalText.match(WIKI_FULL);
    if (wiki) {
        if (wiki[2] !== undefined && wiki[2].trim() !== '') return wiki[2];
        const target = normalizeEmbedPath(wiki[1]);
        return target.split('/').pop() ?? target;
    }
    const md = originalText.match(MD_LINK_FULL);
    if (md) return md[1];
    return '';
}

/** The line without any leading blockquote markers, so a list inside a quote is measured like one outside it. */
function unquoted(line: string): string {
    return line.replace(/^(?:[ \t]*>[ ]?)+/, '');
}

function indentOf(line: string): number {
    const m = unquoted(line).match(/^[ \t]*/);
    return m ? m[0].replaceAll('\t', '    ').length : 0;
}

/**
 * Character ranges of inline code spans in a text. A run of backticks closes at the next run of the same
 * length, and a run with no matching later run is literal text (it does not swallow the rest). An OPENING run
 * preceded by an odd number of backslashes loses its first backtick to the escape.
 */
function inlineCodeRanges(text: string): Array<[number, number]> {
    const runs = [...text.matchAll(/`+/g)].map((m) => ({ start: m.index ?? 0, len: m[0].length }));
    const ranges: Array<[number, number]> = [];
    for (let i = 0; i < runs.length; i++) {
        let slashes = 0;
        for (let k = runs[i].start - 1; k >= 0 && text[k] === '\\'; k--) slashes++;
        const escaped = slashes % 2 === 1;
        const len = runs[i].len - (escaped ? 1 : 0);
        if (len <= 0) continue;
        const close = runs.findIndex((r, j) => j > i && r.len === len);
        if (close < 0) continue;
        ranges.push([escaped ? runs[i].start + 1 : runs[i].start, runs[close].start + runs[close].len]);
        i = close;
    }
    return ranges;
}

/**
 * Is the span [start, end) of line `i` inside an inline code span? A code span may cross line breaks within a
 * paragraph, so the paragraph (the run of non-blank lines around the line) is scanned as one text.
 */
function inInlineCode(lines: readonly string[], mask: readonly boolean[], i: number, start: number, end: number): boolean {
    // The paragraph stops at a blank line and at frontmatter or fenced code, whose backticks are not inline code.
    const edge = (k: number): boolean => lines[k].trim() === '' || mask[k];
    let from = i;
    while (from > 0 && !edge(from - 1)) from--;
    let to = i;
    while (to < lines.length - 1 && !edge(to + 1)) to++;
    const clean = (l: string): string => l.replace(/\r$/, '');
    let offset = 0;
    for (let k = from; k < i; k++) offset += clean(lines[k]).length + 1;
    const paragraph = lines.slice(from, to + 1).map(clean).join('\n');
    return inlineCodeRanges(paragraph).some(([a, b]) => offset + start >= a && offset + end <= b);
}

/** Plan the removal of every reference to `filePath` in one note. Pure. */
export function planLinkRemoval(text: string, filePath: string, notePath: string, resolve: Resolve): PlanResult {
    const lines = text.split('\n');
    const mask = nonBodyLines(lines);
    const next: Array<string | null> = lines.map((l) => l);
    const changes: LineChange[] = [];
    let inBody = false;
    let outsideBody = false;

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const cr = raw.endsWith('\r') ? '\r' : '';
        const line = cr ? raw.slice(0, -1) : raw;
        const hits = extractReferenceSpansFromLine(line, i + 1).filter((ref) => {
            if (isExternalUrl(ref.path)) return false;
            const linktext = normalizeEmbedPath(ref.path);
            return linktext !== '' && resolve(linktext, notePath) === filePath;
        });
        if (hits.length === 0) continue;
        if (mask[i]) { outsideBody = true; continue; }
        // A reference written inside inline code is literal text, not a link: leave it alone.
        const live = hits.filter((h) => !inInlineCode(lines, mask, i, h.start, h.end));
        if (live.length === 0) { outsideBody = true; continue; }
        inBody = true;
        // Rewrite by position (last first), so identical text elsewhere on the line is never touched.
        let edited = line;
        for (const hit of [...live].sort((a, b) => b.start - a.start)) {
            edited = edited.slice(0, hit.start) + replacementFor(hit.originalText) + edited.slice(hit.end);
        }
        // A line the removal emptied (or left as a bare list marker) goes, unless that would orphan the
        // list item's own continuation or children.
        let after: string | null = edited;
        if (edited.trim() === '') {
            after = null;
        } else if (LIST_MARKER_ONLY.test(edited)) {
            const follower = lines.slice(i + 1).find((l) => unquoted(l).trim() !== '');
            const hasChildren = follower !== undefined && indentOf(follower) > indentOf(edited);
            after = hasChildren ? edited : null;
        }
        changes.push({ line: i + 1, before: line, after: after === null ? null : after });
        next[i] = after === null ? null : after + cr;
    }

    if (changes.length === 0) return { status: outsideBody && !inBody ? 'not-removable' : 'nothing' };

    // Dropping a line must not leave two blank lines in a row. The extra blank line that goes with it is a
    // change like any other: it is listed, so the preview shows it and the approved plan covers it.
    const out: string[] = [];
    for (let i = 0; i < next.length; i++) {
        const cur = next[i];
        if (cur === null) {
            const prevBlank = out.length > 0 && out[out.length - 1].trim() === '';
            const following = next[i + 1];
            if (prevBlank && typeof following === 'string' && following.trim() === '') {
                changes.push({ line: i + 2, before: lines[i + 1].replace(/\r$/, ''), after: null });
                i++;
            }
            continue;
        }
        out.push(cur);
    }
    changes.sort((x, y) => x.line - y.line);
    const nextText = out.join('\n');
    return { status: 'ok', plan: { notePath, baseline: text, changes, nextText } };
}

function sameChanges(a: readonly LineChange[], b: readonly LineChange[]): boolean {
    return a.length === b.length && a.every((c, i) => c.line === b[i].line && c.before === b[i].before && c.after === b[i].after);
}

export interface RemoveLinksOptions {
    /** Polled between notes; false stops before the next note (a note write itself is never interrupted). */
    shouldContinue?: () => boolean;
}

/**
 * Apply the approved plans, one note at a time. Never throws. `err('link-removal-off')` when the
 * capability is off (nothing is written). Otherwise a `BatchResult`: `items` are the notes written,
 * `errors` the others (`source` = note path, `error` = the `UnlinkStatus`), `isPartial` when some were
 * written and some not. Stops at the first note that was not written.
 */
export async function removeLinks(
    plugin: AIOrganiserPlugin,
    filePath: string,
    plans: readonly NotePlan[],
    opts: RemoveLinksOptions = {},
): Promise<Result<BatchResult<UnlinkOutcome>>> {
    if (!isLinkRemovalEnabled(plugin.settings)) return err('link-removal-off');
    const resolveFrom = (linktext: string, sourcePath: string): string | null =>
        plugin.app.metadataCache.getFirstLinkpathDest(linktext, sourcePath)?.path ?? null;
    const outcomes: UnlinkOutcome[] = [];
    let stopped = false;
    // A callback that throws is treated as "stop": the contract is that this function never throws.
    const mayContinue = (): boolean => {
        try { return opts.shouldContinue?.() !== false; } catch { return false; }
    };
    for (const plan of plans) {
        // The capability is checked before EVERY write: switching it off mid-job stops the next note.
        if (stopped || !mayContinue() || !isLinkRemovalEnabled(plugin.settings)) {
            stopped = true;
            outcomes.push({ notePath: plan.notePath, status: 'skipped' });
            continue;
        }
        const target: CompositeTarget = {
            kind: 'composite',
            filePath: plan.notePath,
            baseline: plan.baseline,
            recompute: (current) => {
                const replan = planLinkRemoval(current, filePath, plan.notePath, resolveFrom);
                if (replan.status !== 'ok') return err('link-changed');
                // The approved plan, and nothing else, is what may be written.
                if (!sameChanges(replan.plan.changes, plan.changes)) return err('link-changed');
                return ok({ content: replan.plan.nextText });
            },
        };
        let status: UnlinkStatus;
        try {
            const res = await applyNoteEdit(plugin, target, { review: false });
            if (res.ok) status = 'written';
            else if (res.error === 'link-changed' || res.error === 'baseline-changed') status = 'stale';
            else if (res.error === 'protected-path') status = 'refused-protected';
            else status = 'failed';
        } catch {
            status = 'failed';
        }
        outcomes.push({ notePath: plan.notePath, status });
        if (status !== 'written') stopped = true;
    }
    const items = outcomes.filter((o) => o.status === 'written');
    const errors = outcomes.filter((o) => o.status !== 'written').map((o) => ({ source: o.notePath, error: o.status }));
    return ok({ items, errors, warnings: [], isPartial: items.length > 0 && errors.length > 0 });
}
