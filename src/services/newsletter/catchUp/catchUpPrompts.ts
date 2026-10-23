/**
 * Catch-up prompts — one spoken briefing across several missed days.
 *
 * Sibling of `newsletterPrompts.ts`, never an edit of it: the legacy daily prompts stay
 * byte-identical. The inputs are the already-balanced written briefs (one block per pending day,
 * or itemised "late additions" for a day that moved on after an earlier episode), plus the
 * existing story-memory block so a story the listener already heard is not retold.
 *
 * XML-structured like the other prompts. There is no cached `stablePrefix`: a catch-up is ONE
 * call with unique content, so there is no reusable prefix to destabilise.
 */

import { insertBriefContent, type BriefSource } from '../../prompts/newsletterPrompts';
import type { RecallSelection, RecallStory } from '../newsletterMemoryTypes';
import { WORDS_PER_MINUTE } from './catchUpTypes';

export interface CatchUpPromptOptions {
    language?: string;
    from: string;
    to: string;
    dayCount: number;
    capMinutes: number;
    /** Story memory, with the pending days' own `unheard` entries already removed (they are the inputs). */
    recall?: RecallSelection;
    homeRegion?: string;
}

/** Tags that would let newsletter-derived text forge a prompt section. */
const FORGEABLE = /<\/?(?:task|requirements|output_format|newsletters|story_memory|home_region)>|--- (?:SOURCE:|END SOURCE ---|STORY ---)/gi;

function clean(text: string): string {
    let current = text;
    let previous: string;
    do {
        previous = current;
        current = current.replaceAll(FORGEABLE, '');
    } while (current !== previous);
    return current;
}

function renderList(label: string, stories: RecallStory[], withGist: boolean): string {
    if (stories.length === 0) return '';
    const lines = stories.map((s) => {
        const head = `[${s.bucketDate}] ${clean(s.title)}`;
        return withGist ? `--- STORY ---\n${head}: ${clean(s.gist)}` : head;
    });
    return `[${label}]\n${lines.join('\n')}`;
}

/**
 * The story-memory block. Labels match the daily brief's on purpose: they were renamed once to
 * stop the model reading them as newsletter names, and must not drift apart.
 */
export function renderCatchUpMemory(sel: RecallSelection | undefined): string {
    if (!sel || (sel.heard.length === 0 && sel.continuing.length === 0 && sel.unheard.length === 0)) return '';
    const earlier = sel.heard.filter((s) => s.isCurrentBucket);
    const previous = sel.heard.filter((s) => !s.isCurrentBucket);
    const sections = [
        renderList('ALREADY_TOLD_THEM_EARLIER_TODAY', earlier, false),
        renderList('ALREADY_TOLD_THEM_ON_A_PREVIOUS_DAY', previous, false),
        renderList('THEY_KNOW_THIS_STORY_BUT_NOT_THIS_UPDATE', sel.continuing, true),
        renderList('THEY_MISSED_THESE_ENTIRELY', sel.unheard, true),
    ].filter(Boolean);
    return `\n<story_memory>\n${sections.join('\n')}\n</story_memory>`;
}

/**
 * Remove the pending days' own `unheard` stories from the recall: they are already in the
 * inputs in full, and listing them twice only spends the budget. `heard` and `continuing` stay —
 * they are exactly what stops a story the listener already knows from being retold.
 */
export function recallForCatchUp(recall: RecallSelection | undefined, pendingDates: ReadonlySet<string>): RecallSelection | undefined {
    if (!recall) return undefined;
    return { ...recall, unheard: recall.unheard.filter((s) => !pendingDates.has(s.bucketDate)) };
}

export function buildCatchUpScriptPrompt(options: CatchUpPromptOptions): string {
    const isNonEnglish = !!options.language && options.language.toLowerCase() !== 'english';
    const langInstruction = isNonEnglish
        ? `\n- Speak entirely in ${clean(options.language ?? '')}, including the opening, the closing and every transition`
        : '';
    const maxWords = options.capMinutes * WORDS_PER_MINUTE;

    const region = clean((options.homeRegion ?? '').trim()).slice(0, 200);
    const regionRule = region
        ? `\n- Reserve a short segment for stories close to home (${region}). Do not cut it to fit the word budget — cut international coverage instead`
        : '';

    const memoryBlock = renderCatchUpMemory(options.recall);
    const memoryRule = memoryBlock
        ? `
- <story_memory> lists what the listener has already heard. Do not retell ALREADY_TOLD stories unless something new happened.
  For THEY_KNOW_THIS_STORY_BUT_NOT_THIS_UPDATE give only the update. Tell THEY_MISSED_THESE_ENTIRELY properly, in one or two sentences each`
        : '';

    const span = options.from === options.to ? options.from : `${options.from} to ${options.to}`;

    return `<task>Write ONE spoken news briefing for a listener who has been away. It covers ${span} (${options.dayCount} ${options.dayCount === 1 ? 'day' : 'days'} of newsletters) and replaces listening to each day separately.</task>
<requirements>
- Synthesise across the days. This is one briefing, not a day-by-day recap: order stories by importance and storyline, never by date
- For a story that ran over several days, say where it started and where it stands now, and skip the steps in between
- Mention a day only when the date matters to the story ("by Thursday...")
- Scale by selection, not length: the more days there are, the more minor single-day stories you drop. Never add airtime for extra days
- A block marked "Update to" holds new developments on a day the listener may already have heard: give them as developments and do not re-explain the background${regionRule}${memoryRule}
- Remove all markdown formatting and source attributions; write for the ear, with contractions, short sentences and natural rhythm
- Open with one sentence saying what period this covers and what the biggest development was; close with a single sentence, varied, not a generic thank-you
- Maximum ${maxWords} words (about ${options.capMinutes} minutes) — write less rather than padding${langInstruction}
</requirements>
<output_format>
Plain spoken prose in paragraphs. No headings, no bullets, no stage directions.
</output_format>${memoryBlock}
<newsletters>
{{CONTENT}}
</newsletters>`;
}

export interface CatchUpContentEntry {
    date: string;
    kind: 'full' | 'delta';
    text: string;
}

/**
 * Fill the prompt with the pending days. Each day becomes one source block named by its date;
 * a delta is labelled as an update so the model treats it as a development, not a fresh day.
 * Budgeting and tag-stripping reuse the daily brief's `insertBriefContent`.
 */
export function insertCatchUpContent(
    prompt: string,
    entries: readonly CatchUpContentEntry[],
    maxContentChars = 0,
): { filled: string; truncatedCount: number } {
    const sources: BriefSource[] = entries.map((e) => ({
        sourceDisplayName: e.kind === 'delta' ? `Update to ${e.date}` : `Day ${e.date}`,
        // The header also lifts a short itemised delta over the "garbage source" length floor.
        triageText: e.kind === 'delta'
            ? `New since the listener last heard ${e.date}:\n${e.text}`
            : `Briefing for ${e.date}:\n${e.text}`,
    }));
    return insertBriefContent(prompt, sources, maxContentChars);
}

/** Ask for a shorter version of a script that came out over its limit. */
export function buildShortenPrompt(script: string, wordBudget: number, language?: string): string {
    const isNonEnglish = !!language && language.toLowerCase() !== 'english';
    const lang = isNonEnglish ? ` Keep the script in ${clean(language ?? '')}.` : '';
    return `<task>Shorten this spoken news script to at most ${wordBudget} words.</task>
<requirements>
- Keep the opening sentence and the closing sentence
- Drop the least important stories first, then trim detail from the rest; never cut a sentence in half
- Keep it plain spoken prose with no markdown${lang}
</requirements>
<script>
${clean(script)}
</script>`;
}
