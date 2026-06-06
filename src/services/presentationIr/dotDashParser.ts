/**
 * Dot-dash parser (plan §2b): the round-trip back from the user-edited storyline
 * `.md` to a `ConsultantStoryboard`. The `.md` is the editable source of truth for
 * the review step — prose edits (titles, supporting points) become the storyboard;
 * the hidden `<!-- aio-slide: {…} -->` anchor restores identity + the chart
 * visual_data + evidence bindings even after heavy editing.
 *
 * Tolerant + fail-typed: a malformed edit returns a specific `Result.err` (shown
 * in the note), never a crash. A slide whose anchor was lost is treated as NEW
 * (fresh id, no visual) — to be re-grounded from scratch downstream.
 */
import type { Result } from '../../core/result';
import { ok, err } from '../../core/result';
import type { ConsultantStoryboard } from './consultantStoryboard';
import { consultantStoryboardSchema, STORYBOARD_SCHEMA_VERSION } from './consultantStoryboard';
import { findAndDecodeAnchor, decodeMetaComment } from './dotDashAnchor';

export interface SlideComment { readonly slideId: string; readonly comment: string; }
export interface ParsedStoryline {
    readonly storyboard: ConsultantStoryboard;
    /** `<!-- comment: … -->` notes the user left, keyed to the slide they sit in. */
    readonly comments: readonly SlideComment[];
}

const THESIS_RE = /^>\s*\*\*Thesis:\*\*\s*(.+)$/m;
const COMMENT_RE = /<!--\s*comment:\s*([\s\S]*?)-->/gi;

/** Split markdown into `## `-delimited sections (the text BEFORE the first `## ` is the header). */
function splitSections(md: string): string[] {
    const parts = md.split(/^##\s+/m);
    return parts.slice(1); // drop the pre-header block
}

export function markdownToStoryboard(md: string): Result<ParsedStoryline> {
    if (typeof md !== 'string' || md.trim().length === 0) return err('storyline: empty document');
    const thesisM = md.match(THESIS_RE);
    const thesis = thesisM ? thesisM[1].trim() : '';
    if (!thesis) return err('storyline: missing "> **Thesis:** …" line');

    const sections = splitSections(md);
    if (sections.length === 0) return err('storyline: no "## <action title>" slides found');

    const comments: SlideComment[] = [];
    const slides: unknown[] = [];

    // for-loop (not forEach) so a corrupt-anchor `return err(...)` aborts the whole parse.
    for (let idx = 0; idx < sections.length; idx++) {
        const section = sections[idx];
        const firstNewline = section.indexOf('\n');
        const title = (firstNewline === -1 ? section : section.slice(0, firstNewline)).trim();
        const body = firstNewline === -1 ? '' : section.slice(firstNewline + 1);

        // Machine state from the hidden anchor (restores id/role/visual/evidence).
        // A fresh id uses the section number so reordered unanchored slides get
        // distinct ids; the schema superRefine still rejects any genuine collision.
        let id = `new-${idx + 1}`;
        let role = 'insight';
        let suggested_visual = 'none';
        let visual_data: unknown = { type: 'none' };
        let evidence_span_ids: string[] = [];
        const decoded = findAndDecodeAnchor(body);
        if (decoded && !decoded.ok) {
            return err(`storyline: slide "${title}" has a corrupt hidden anchor — fix or remove the <!-- aio-slide … --> line`);
        }
        if (decoded?.ok) {
            const state = decoded.state;
            id = typeof state.id === 'string' ? state.id : id;
            role = typeof state.role === 'string' ? state.role : role;
            suggested_visual = typeof state.suggested_visual === 'string' ? state.suggested_visual : suggested_visual;
            visual_data = state.visual_data ?? visual_data;
            evidence_span_ids = Array.isArray(state.evidence_span_ids) ? state.evidence_span_ids : [];
        }

        // Supporting prose = ALL `- ` dot-dash bullets INCLUDING their wrapped
        // continuation lines (renderer-gate MEDIUM — a multi-line bullet the user wrote
        // during review otherwise lost its continuation). A blank line, a `>` finding
        // line, or a comment ends the current bullet.
        const bullets: string[] = [];
        let current: string | null = null;
        for (const line of body.split('\n')) {
            if (/^\s*-\s+/.test(line)) {
                if (current !== null) bullets.push(current);
                current = line.replace(/^\s*-\s+/, '').trim();
            } else if (current !== null) {
                const t = line.trim();
                if (!t || t.startsWith('>') || t.startsWith('<!--')) { bullets.push(current); current = null; }
                else current += ' ' + t;
            }
        }
        if (current !== null) bullets.push(current);
        const core_message = bullets.length ? bullets.join(' ').trim() : title;

        // Lift comments in this section.
        for (const m of body.matchAll(COMMENT_RE)) {
            const c = m[1].trim();
            if (c) comments.push({ slideId: id, comment: c });
        }

        slides.push({ id, role, action_title: title, core_message, evidence_span_ids, suggested_visual, visual_data });
    }

    // Restore the LLM's section groupings (renderer-gate MEDIUM); omit when absent so
    // the schema's optional field stays undefined rather than an empty array.
    // Restore section groupings, but DROP references to slides the user deleted during
    // review (renderer-gate R2 HIGH — a dangling slide_id would fail the schema's
    // sections-reference superRefine and break the whole parse). Empty sections are dropped.
    const sectionMeta = decodeMetaComment('aio-sections', md);
    const slideIds = new Set(slides.map((s) => (s as { id?: string }).id));
    const candidate: Record<string, unknown> = { schemaVersion: STORYBOARD_SCHEMA_VERSION, thesis, slides };
    if (Array.isArray(sectionMeta)) {
        const cleaned = sectionMeta
            .filter((sec): sec is { label: unknown; slide_ids: unknown[] } => !!sec && typeof sec === 'object' && Array.isArray((sec as { slide_ids?: unknown }).slide_ids))
            .map((sec) => ({ ...sec, slide_ids: sec.slide_ids.filter((id) => typeof id === 'string' && slideIds.has(id)) }))
            .filter((sec) => sec.slide_ids.length > 0);
        if (cleaned.length) candidate.sections = cleaned;
    }
    const parsed = consultantStoryboardSchema.safeParse(candidate);
    if (!parsed.success) {
        const f = parsed.error.issues[0];
        return err(`storyline: edited content is invalid — ${f.path.join('.')}: ${f.message}`);
    }
    return ok({ storyboard: parsed.data, comments });
}
