/**
 * Deterministic clean-up of a synthesised brief.
 *
 * Both defects here were observed in real generated output and BOTH survived
 * being forbidden in the prompt. Instructions about global properties of a long
 * document — "never repeat a story", "never write X in this field" — are weakly
 * followed, so they are enforced in code instead.
 *
 *   1. Memory-section labels leaking into the source attribution:
 *        "(Sources: THEY_MISSED_THESE_ENTIRELY)"
 *      A catch-up story comes from the story ledger, not from today's
 *      newsletters, so it genuinely has no source to cite and the model filled
 *      the slot with the nearest label it could see.
 *
 *   2. The same story listed twice under different headings. A home-region
 *      story is legitimately both "Geopolitics" and "Closer to home", and the
 *      model wrote it in both.
 */

import { storyKey } from './newsletterStoryLedger';
import { keyTokens, findSimilarKey } from './newsletterStoryIdentity';

/** The memory section names, which must never appear as a source. */
const MEMORY_LABELS = [
    'ALREADY_TOLD_THEM_EARLIER_TODAY',
    'ALREADY_TOLD_THEM_ON_A_PREVIOUS_DAY',
    'THEY_KNOW_THIS_STORY_BUT_NOT_THIS_UPDATE',
    'THEY_MISSED_THESE_ENTIRELY',
    'already_heard',
    'continuing',
    'not yet heard',
    'not_yet_heard',
];

const BULLET_RE = /^\s*[-*]\s+\*\*(.+?)\*\*/;
const HEADING_RE = /^#{2,4}\s+(.+?)\s*$/;

/**
 * Replace a fabricated source attribution with an honest one.
 *
 * The story was carried over from the reader's history rather than reported in
 * today's newsletters, so "previously reported" is the truthful label — dropping
 * the parenthetical entirely would imply it came from today's sources.
 */
export function stripMemoryLabelSources(md: string): string {
    let out = md;
    for (const label of MEMORY_LABELS) {
        const escaped = label.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
        // Only when the label is the WHOLE attribution — a real source list that
        // happens to contain the word is left alone.
        out = out.replaceAll(
            new RegExp(String.raw`\(Sources?:\s*${escaped}\s*\)`, 'gi'),
            '(Previously reported)',
        );
    }
    return out;
}

/**
 * Remove a story that appears under more than one heading.
 *
 * When a duplicate is found, the copy under `preferHeading` wins. That matters:
 * "Closer to home" is rendered last, so a naive keep-the-first rule would always
 * discard the local placement and undo the point of having the section.
 */
export function dedupeBriefStories(md: string, preferHeading = 'Closer to home'): string {
    const lines = md.split('\n');

    // Pass 1: find every bullet, its key, and the heading it sits under.
    interface Entry { line: number; key: string; heading: string }
    const entries: Entry[] = [];
    const tokens = new Map<string, Set<string>>();
    let heading = '';

    for (const [i, raw] of lines.entries()) {
        const h = HEADING_RE.exec(raw);
        if (h) { heading = h[1]; continue; }
        const b = BULLET_RE.exec(raw);
        if (!b) continue;
        const rawKey = storyKey(b[1].trim());
        if (!rawKey) continue;
        // Fold near-identical titles onto one key, the same way memory does.
        const tok = keyTokens(rawKey);
        const key = tokens.has(rawKey) ? rawKey : (findSimilarKey(tok, tokens) ?? rawKey);
        if (!tokens.has(key)) tokens.set(key, tok);
        entries.push({ line: i, key, heading });
    }

    // Pass 2: for each key kept more than once, choose the survivor.
    const byKey = new Map<string, Entry[]>();
    for (const e of entries) {
        const list = byKey.get(e.key);
        if (list) list.push(e); else byKey.set(e.key, [e]);
    }

    const drop = new Set<number>();
    for (const group of byKey.values()) {
        if (group.length < 2) continue;
        const preferred = group.find(e => e.heading.toLowerCase() === preferHeading.toLowerCase());
        const keep = preferred ?? group[0];
        for (const e of group) if (e !== keep) drop.add(e.line);
    }
    if (drop.size === 0) return md;

    // A bullet can wrap onto following lines; drop those with it.
    const removed = new Set<number>(drop);
    for (const start of drop) {
        for (let i = start + 1; i < lines.length; i++) {
            const l = lines[i];
            if (l.trim() === '' || HEADING_RE.test(l) || BULLET_RE.test(l)) break;
            removed.add(i);
        }
    }

    const kept = lines.filter((_, i) => !removed.has(i));
    return dropEmptyHeadings(kept).join('\n').replaceAll(/\n{3,}/g, '\n\n').trim();
}

/** Remove a heading left with no bullets after de-duplication. */
function dropEmptyHeadings(lines: string[]): string[] {
    const out: string[] = [];
    for (const [i, line] of lines.entries()) {
        if (!HEADING_RE.test(line)) { out.push(line); continue; }
        let hasContent = false;
        for (let j = i + 1; j < lines.length; j++) {
            if (HEADING_RE.test(lines[j])) break;
            if (BULLET_RE.test(lines[j])) { hasContent = true; break; }
        }
        if (hasContent) out.push(line);
    }
    return out;
}

/** Both guards, in the order the brief pipeline applies them. */
export function postProcessBrief(md: string, preferHeading?: string): string {
    return dedupeBriefStories(stripMemoryLabelSources(md), preferHeading);
}
