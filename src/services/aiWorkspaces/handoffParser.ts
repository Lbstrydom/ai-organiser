/**
 * Reads the `## Handoff` section an AI ends a session with. Deterministic, no provider call. Pure.
 *
 * Grammar v1 (shared with `renderHandoffContract`): the first heading `Handoff` at level 1-3 outside code, its header lines
 * (`Project ID:`, `Chat project: name (app)`), and the subsections Decisions / Next actions / Deliverables / Questions.
 * An item is a list line; lines indented by two spaces continue it. Nothing is silently truncated: a long item is flagged and
 * a section beyond the item cap says how many more there are.
 *
 * A hand-back that cannot be read this way is `malformed` with the reasons; nothing is guessed.
 */
import { nonBodyLines } from '../../utils/markdownRegions';
import { isAioId } from '../projects/projectIndex';
import { isValidDue } from '../inboxSweep/tasksRouting';
import { HANDOFF_HEADING, HANDOFF_SECTIONS } from './handoffGrammar';

export const MAX_ITEMS_PER_SECTION = 50;
export const LONG_ITEM_CHARS = 500;

export type HandoffSection = 'decisions' | 'actions' | 'deliverables' | 'questions';

const SECTION_OF: Record<string, HandoffSection> = {
    [HANDOFF_SECTIONS[0].toLowerCase()]: 'decisions',
    [HANDOFF_SECTIONS[1].toLowerCase()]: 'actions',
    [HANDOFF_SECTIONS[2].toLowerCase()]: 'deliverables',
    [HANDOFF_SECTIONS[3].toLowerCase()]: 'questions',
};

export type HandoffWarningCode = 'unknown-key' | 'bad-date' | 'conflicting-project' | 'extra-block' | 'capped' | 'missing-claim' | 'long-item';
export interface HandoffWarning { code: HandoffWarningCode; detail: string }

export interface HandoffItem {
    section: HandoffSection;
    /** 0-based position within its section, after concatenating repeated subsections */
    ordinal: number;
    text: string;
    longItem: boolean;
}
export interface DecisionItem extends HandoffItem { section: 'decisions'; claim: 'suggested' | 'decided' }
export interface ActionItem extends HandoffItem { section: 'actions'; contexts: string[]; waiting?: string; due?: string }
export interface DeliverableItem extends HandoffItem { section: 'deliverables'; fileName: string; status: 'draft' | 'released' }

export type MalformedReason = 'no-section' | 'no-header' | 'conflicting-project' | 'project-id-invalid';

export interface HandoffParse {
    status: 'ok' | 'malformed';
    reasons: MalformedReason[];
    projectId?: string;
    chat?: { name: string; app?: 'claude' | 'chatgpt' };
    decisions: DecisionItem[];
    actions: ActionItem[];
    deliverables: DeliverableItem[];
    questions: HandoffItem[];
    /** Items beyond the cap, per section (the review says "N more: open the file") */
    more: Partial<Record<HandoffSection, number>>;
    warnings: HandoffWarning[];
}

/** Office-style text: non-breaking spaces and paragraph breaks become plain ones. */
export function normaliseHandoffText(text: string): string {
    return text.replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n').replace(/[\u2028\u2029]/g, '\n');
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_ITEM = /^[-*]\s+(?:\[[ xX]\]\s+)?(.*)$/;

/** Is this line a template placeholder the AI echoed (`<text>`, `<file name>: <one line>`)? */
/** The contract's own placeholders, and only those: any other angle-bracket text (an autolink, a tag) is the AI's own. */
const TEMPLATE_TOKEN = /<(text|file name|one line|person|name)>/i;
const isPlaceholder = (text: string): boolean => {
    if (!TEMPLATE_TOKEN.test(text)) return false;
    // Only the contract's own template stubs may remain once the placeholders are taken out; any word the AI wrote keeps the item.
    const rest = text
        .replace(/^\s*(suggested|decided)\s*:/i, '')
        .replace(new RegExp(TEMPLATE_TOKEN.source, 'gi'), '')
        .replace(/@context\b/gi, '')
        .replace(/\((waiting:\s*|due:\s*YYYY-MM-DD|draft\|released|claude\|chatgpt)\s*\)/gi, '')
        .replace(/[\s:,()-]+/g, '');
    return rest === '';
};

function parseAttributes(raw: string, contexts: ReadonlySet<string>, warnings: HandoffWarning[]): { text: string; contexts: string[]; waiting?: string; due?: string } {
    let text = raw.trim();
    const found: string[] = [];
    let waiting: string | undefined;
    let due: string | undefined;
    // Trailing attributes, in any order; an escaped `\(` or `\@` is literal text.
    for (let guard = 0; guard < 12; guard++) {
        const paren = /\s*\((waiting|due):\s*([^()]*)\)\s*$/i.exec(text);
        if (paren && !text.slice(0, paren.index + (paren[0].length - paren[0].trimStart().length)).endsWith('\\')) {
            const value = paren[2].trim();
            if (paren[1].toLowerCase() === 'waiting') waiting = waiting ?? (value || undefined);
            else if (isValidDue(value)) due = due ?? value;
            else warnings.push({ code: 'bad-date', detail: value });
            text = text.slice(0, paren.index).trimEnd();
            continue;
        }
        const ctx = /(?:^|\s)(@[a-z0-9][a-z0-9_-]{0,23})\s*$/.exec(text);
        if (ctx && contexts.has(ctx[1]) && !text.slice(0, ctx.index + ctx[0].indexOf('@')).endsWith('\\')) {
            found.push(ctx[1]);
            text = text.slice(0, ctx.index).trimEnd();
            continue;
        }
        break;
    }
    return { text: text.replace(/\\([(@])/g, '$1'), contexts: found.reverse(), waiting, due };
}

export function parseHandoff(raw: string, contexts: readonly string[]): HandoffParse {
    const out: HandoffParse = { status: 'ok', reasons: [], decisions: [], actions: [], deliverables: [], questions: [], more: {}, warnings: [] };
    const lines = normaliseHandoffText(raw).split('\n');
    const hidden = nonBodyLines(lines);
    const known = new Set(contexts);

    // The first `Handoff` heading outside code and frontmatter; any further one is warned about.
    const starts: number[] = [];
    lines.forEach((line, i) => {
        if (hidden[i]) return;
        const m = HEADING.exec(line);
        if (m && m[1].length <= 3 && m[2].trim().toLowerCase() === HANDOFF_HEADING.toLowerCase()) starts.push(i);
    });
    if (starts.length === 0) { out.status = 'malformed'; out.reasons.push('no-section'); return out; }
    for (let i = 1; i < starts.length; i++) out.warnings.push({ code: 'extra-block', detail: String(starts[i] + 1) });
    const level = HEADING.exec(lines[starts[0]])?.[1].length ?? 2;

    // Section body: to the next heading of the same or a higher level.
    let end = lines.length;
    for (let i = starts[0] + 1; i < lines.length; i++) {
        if (hidden[i]) continue;
        const m = HEADING.exec(lines[i]);
        if (m && m[1].length <= level) { end = i; break; }
    }

    const projectIds: string[] = [];
    let current: HandoffSection | null = null;
    let sawSubsection = false;
    const counts: Record<HandoffSection, number> = { decisions: 0, actions: 0, deliverables: 0, questions: 0 };
    let open: { section: HandoffSection; text: string } | null = null;

    const flush = (): void => {
        if (!open) return;
        const { section } = open;
        const text = open.text.trim();
        open = null;
        if (text === '' || isPlaceholder(text)) return;
        if (counts[section] >= MAX_ITEMS_PER_SECTION) {
            out.more[section] = (out.more[section] ?? 0) + 1;
            return;
        }
        const ordinal = counts[section]++;
        const longItem = text.length > LONG_ITEM_CHARS;
        if (longItem) out.warnings.push({ code: 'long-item', detail: `${section}:${ordinal}` });
        const base = { ordinal, longItem };
        if (section === 'decisions') {
            const claim = /^(suggested|decided)\s*:\s*(.*)$/is.exec(text);
            if (!claim) out.warnings.push({ code: 'missing-claim', detail: `decisions:${ordinal}` });
            out.decisions.push({ ...base, section, claim: claim ? (claim[1].toLowerCase() as 'suggested' | 'decided') : 'suggested', text: (claim ? claim[2] : text).trim() });
        } else if (section === 'actions') {
            const a = parseAttributes(text, known, out.warnings);
            out.actions.push({ ...base, section, text: a.text, contexts: a.contexts, waiting: a.waiting, due: a.due });
        } else if (section === 'deliverables') {
            const m = /^(.*?)\s*\((draft|released)\)\s*$/i.exec(text);
            const body = (m ? m[1] : text).trim();
            const colon = body.indexOf(':');
            out.deliverables.push({ ...base, section, text: body, fileName: (colon === -1 ? body : body.slice(0, colon)).trim(), status: m && m[2].toLowerCase() === 'released' ? 'released' : 'draft' });
        } else {
            out.questions.push({ ...base, section, text });
        }
    };

    for (let i = starts[0] + 1; i < end; i++) {
        const line = lines[i];
        if (hidden[i]) { if (open) open.text += `\n${line}`; continue; }
        const h = HEADING.exec(line);
        if (h && h[1].length > level) {
            flush();
            const name = h[2].trim().toLowerCase();
            current = SECTION_OF[name] ?? null;
            sawSubsection = true;
            if (!current) out.warnings.push({ code: 'unknown-key', detail: h[2].trim() });
            continue;
        }
        if (!sawSubsection) {
            const id = /^project id\s*:\s*(.*)$/i.exec(line.trim());
            if (id) { projectIds.push(id[1].trim()); continue; }
            const chat = /^chat project\s*:\s*(.*)$/i.exec(line.trim());
            if (chat) {
                const m = /^(.*?)\s*\((claude|chatgpt)\)\s*$/i.exec(chat[1].trim());
                const name = (m ? m[1] : chat[1]).trim();
                if (name !== '' && !isPlaceholder(name)) out.chat = { name, ...(m ? { app: m[2].toLowerCase() as 'claude' | 'chatgpt' } : {}) };
            }
            continue;
        }
        if (!current) continue;
        const item = LIST_ITEM.exec(line);
        if (item) { flush(); open = { section: current, text: item[1] }; continue; }
        // A continuation: indented by two spaces (or more) under an open item.
        if (open && /^ {2,}\S/.test(line)) { open.text += `\n${line.trim()}`; continue; }
        if (line.trim() === '') { flush(); continue; }
        flush();
    }
    flush();

    const ids = [...new Set(projectIds.filter((id) => id !== '' && !isPlaceholder(id)))];
    if (ids.length > 1) { out.status = 'malformed'; out.reasons.push('conflicting-project'); out.warnings.push({ code: 'conflicting-project', detail: ids.join(', ') }); }
    else if (ids.length === 1) {
        if (isAioId(ids[0])) out.projectId = ids[0].toLowerCase();
        else { out.status = 'malformed'; out.reasons.push('project-id-invalid'); }
    }
    if (out.projectId === undefined && out.chat === undefined && !out.reasons.includes('conflicting-project') && !out.reasons.includes('project-id-invalid')) {
        out.status = 'malformed';
        out.reasons.push('no-header');
    }
    return out;
}

/**
 * Is this note an AI hand-back, or a note the hand-back review has already written into? Such notes are reviewed with Review AI
 * hand-back; the sweep leaves them alone so their lines do not come back as tasks. A "## Handoff" heading outside code (level 1-3),
 * an aio:handoff marker, or the frontmatter flag aio-handback: true.
 */
export function looksLikeHandback(text: string): boolean {
    if (text.includes('<!-- aio:handoff id=')) return true;
    const normalised = normaliseHandoffText(text);
    if (/^---\n[\s\S]{0,2000}?\baio-handback:\s*true\b[\s\S]*?\n---/.test(normalised)) return true;
    const lines = normalised.split('\n');
    const hidden = nonBodyLines(lines);
    return lines.some((line, i) => {
        if (hidden[i]) return false;
        const m = HEADING.exec(line);
        return m !== null && m[1].length <= 3 && m[2].trim().toLowerCase() === HANDOFF_HEADING.toLowerCase();
    });
}

// ─── Item identity ──────────────────────────────────────────────────────────

const enc = new TextEncoder();
const norm = (s: string): string => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

async function sha256(text: string): Promise<string> {
    const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
    return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** `sha256(handbackId + section + normalised text + ordinal)`: the AI never produces ids; the plugin computes them. */
export function itemId(handbackId: string, item: Pick<HandoffItem, 'section' | 'text' | 'ordinal'>): Promise<string> {
    return sha256(`${handbackId}\n${item.section}\n${norm(item.text)}\n${item.ordinal}`).then((h) => h.slice(0, 16));
}

/** The identity of a hand-back: the note's path-independent content hash. A changed file is a new hand-back. */
export function handbackIdOf(noteText: string): Promise<string> {
    return sha256(normaliseHandoffText(noteText)).then((h) => h.slice(0, 24));
}
