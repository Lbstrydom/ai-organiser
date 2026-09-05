/**
 * Newsletter Prompts
 *
 * Prompts for daily brief synthesis and podcast script generation.
 */

import type { RecallSelection, RecallStory } from '../newsletter/newsletterMemoryTypes';

const STRUCTURAL_TAGS = [
    '</newsletters>', '<newsletters>',
    '</task>', '<task>',
    '</requirements>', '<requirements>',
    '</output_format>', '<output_format>',
    '--- SOURCE:', '--- END SOURCE ---',
    // Story-memory + region sections. Ledger titles and gists are LLM output
    // derived from untrusted email, so they inherit the taint and a crafted
    // newsletter must not be able to forge a section boundary.
    '</story_memory>', '<story_memory>',
    '</home_region>', '<home_region>',
    '--- STORY ---',
];

/** Strip structural XML/delimiter tags used by the prompt from source content to prevent injection.
 *  Iterates until the string stabilises to defeat nested-fragment evasion
 *  (e.g. `</news<newsletters>letters>` fuses into `</newsletters>` after the inner tag
 *  is removed; a second pass then removes the fused outer tag). */
function stripStructuralTags(text: string): string {
    const escaped = STRUCTURAL_TAGS.map(t =>
        t.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
    );
    const pattern = new RegExp(escaped.join('|'), 'gi');
    let current = text;
    let previous: string;
    do {
        previous = current;
        current = current.replaceAll(pattern, '');
    } while (current !== previous);
    return current;
}

// ── Daily Brief ──────────────────────────────────────────────────────────────

export interface BriefSource {
    sourceDisplayName: string;
    triageText: string;
    /** Populated by collectDayNewsletters; the explicit inputs isRegionRelevant reads. */
    senderName?: string;
    subject?: string;
    /** True when this source covers the reader's configured home region.
     *  Protects it from the budget trimmer's drop pass. */
    local?: boolean;
}

/**
 * Build the daily brief system+user prompt.
 * Language instruction is injected when a non-English language is configured.
 * Word budget scales with source count for heavier news days.
 */
export interface DailyBriefPromptOptions {
    language?: string;
    /** Cross-day story memory. Omitted or empty = today's behaviour, byte-identical. */
    recall?: RecallSelection;
    /** Home-region alias list. Empty = today's behaviour, byte-identical. */
    homeRegion?: string;
}

export function buildDailyBriefPrompt(options: DailyBriefPromptOptions = {}): string {
    const isNonEnglish = options.language && options.language.toLowerCase() !== 'english';
    const langInstruction = isNonEnglish
        ? `\n- Write the entire brief, including all headings, in ${options.language}`
        : '';

    const region = (options.homeRegion ?? '').trim();
    const hasRegion = region.length > 0;

    const themes = 'Geopolitics, Tech & AI, Business & Markets, Science & Health, Culture & Society';
    const localTheme = hasRegion ? ', Closer to home' : '';
    const headingNote = isNonEnglish
        ? `Choose 2-4 thematic headings appropriate for ${options.language} (e.g. equivalent of ${themes}${localTheme}) — only include headings that have content`
        : `Group under 2-4 thematic headings chosen from: ${themes}${localTheme} — only include headings that have content`;

    // Region rules exist because the default requirements actively suppress
    // local news: a local paper is single-source by definition, so the
    // "prioritise multi-source stories" rule down-ranks it every single day.
    const regionRules = hasRegion
        ? `
- The reader's home region is given in <home_region>. Stories about that region matter to them personally
- Put home-region stories under a "Closer to home" heading, and ONLY there. A home-region
  story must not also appear under a topical heading — one story, one place in the brief
- A home-region story reported by only ONE source is NOT less important — the multi-source
  priority rule below does NOT apply to it, because local papers are single-source by nature
- Never drop a home-region story to make room for international news`
        : '';

    const regionBlock = hasRegion
        ? `\n<home_region>\n${stripStructuralTags(region).slice(0, 400)}\n</home_region>`
        : '';

    const memoryRules = options.recall && !isSelectionEmpty(options.recall)
        ? `
- <story_memory> lists what this reader has and has not already been told, each entry dated. Obey it:
  · ALREADY_TOLD_THEM_*: omit entirely UNLESS today's sources carry a genuinely new development
  · THEY_KNOW_THIS_STORY_BUT_NOT_THIS_UPDATE: LEAD WITH WHAT IS NEW. They already know the
    background — do not restate it
  · THEY_MISSED_THESE_ENTIRELY: include with a brief catch-up. Do NOT suppress them
- RUNNING STORIES SHRINK. A big ongoing situation (a war, a court case, an election) reappears
  under a different headline every day. Judge it by the DATES in <story_memory>, not by whether
  the wording matches:
  · under 1 prior date  → normal length, lead with the new development
  · under 2-3 prior dates → ONE sentence, the newest development only
  · under 4+ prior dates → one short clause, and only if something actually changed. The reader
    has followed this for days; they need the update, not the situation
- Do NOT re-establish context the reader already has. Phrases like "amid ongoing tensions", "as
  the conflict continues" or "in the latest escalation" are words they have already read
- A long-running story must NEVER take space from a story the reader has not seen. When space is
  tight, cut the ongoing story further and keep the fresh one at full length
- Second-order stories belong to their parent situation. If the reader has followed a conflict for
  days, a story about that conflict's effect on shipping or food prices is a development in it,
  not a new story
- When continuing a story listed in <story_memory>, reuse that entry's title EXACTLY as written
- The (Sources: …) field names newsletters from <newsletters> ONLY. Never put a <story_memory>
  section name there — those labels describe what the reader has heard, they are not sources`
        : '';

    const memoryBlock = options.recall ? renderStoryMemory(options.recall) : '';

    return `<task>Synthesise these newsletter summaries into a comprehensive daily brief that covers all significant stories.</task>
<requirements>
- Cover every noteworthy story — the reader should not need to scroll past the brief
- Merge stories that appear in more than one source into a single entry with (Sources: A, B)
- Each distinct event or development appears once only
- ${headingNote}
- Use ### for theme headings
- Keep each bullet to one or two sentences — be concise but complete enough to understand the story
- Factual, neutral tone; no filler phrases
- Prioritise stories that appear in multiple sources — they are the day's signal
- Include every significant story — the brief should scale with the news volume
- Niche or soft stories (lifestyle, opinion pieces) can be omitted if space is needed for hard news${regionRules}${memoryRules}${langInstruction}
</requirements>
<output_format>
### [Theme heading]
- **[Story title]**: One-two sentence summary. (Sources: Newsletter A, Newsletter B)
</output_format>${regionBlock}${memoryBlock}
<newsletters>
{{CONTENT}}
</newsletters>`;
}

function isSelectionEmpty(sel: RecallSelection): boolean {
    return sel.heard.length === 0 && sel.continuing.length === 0 && sel.unheard.length === 0;
}

/**
 * Render the story-memory section.
 *
 * `heard` is split on `isCurrentBucket` so the model can say "since this
 * morning" rather than "yesterday" — the same story means something different
 * depending on when the reader heard it.
 *
 * Every title and gist goes through stripStructuralTags: these strings are LLM
 * output derived from untrusted email, so they inherit the taint.
 */
function renderStoryMemory(sel: RecallSelection): string {
    if (isSelectionEmpty(sel)) return '';

    const earlierToday = sel.heard.filter(s => s.isCurrentBucket);
    const previousDays = sel.heard.filter(s => !s.isCurrentBucket);

    const sections = [
        renderStoryList('ALREADY_TOLD_THEM_EARLIER_TODAY', earlierToday, false),
        renderStoryList('ALREADY_TOLD_THEM_ON_A_PREVIOUS_DAY', previousDays, false),
        renderStoryList('THEY_KNOW_THIS_STORY_BUT_NOT_THIS_UPDATE', sel.continuing, true),
        renderStoryList('THEY_MISSED_THESE_ENTIRELY', sel.unheard, true),
    ].filter(Boolean);

    return `\n<story_memory>\n${sections.join('\n')}\n</story_memory>`;
}

function renderStoryList(label: string, stories: RecallStory[], withGist: boolean): string {
    if (stories.length === 0) return '';
    // The DATE is load-bearing, not decoration. Headline similarity cannot thread
    // a running situation whose framing changes daily — "US sanctions on Egyptian
    // bank" and "Iran attacks U.S. bases in Jordan" are the same conflict and
    // share almost no words — but a model reading dated entries groups them
    // easily. The dates are what make the proportionality rule work at all.
    //
    // `withGist` is false for already-heard stories: the model only has to
    // RECOGNISE them, and the gist costs four times the characters for no gain.
    // Charging every list for gists is what truncated a week of memory down to
    // twelve entries, which in turn made a week-long story look brand new.
    const lines = stories.map(s => {
        const head = `[${s.bucketDate}] ${stripStructuralTags(s.title)}`;
        return withGist ? `--- STORY ---\n${head}: ${stripStructuralTags(s.gist)}` : head;
    });
    return `[${label}]\n${lines.join('\n')}`;
}

/** Minimum meaningful chars for a source to be worth including. */
const MIN_USEFUL_CHARS = 50;
/** HTML entity density threshold — sources dominated by entities are garbage extraction. */
const HTML_ENTITY_RE = /&#\d+;/g;

/** Returns true if the triage text is garbage (raw HTML remnants, tracking pixels, etc.). */
function isGarbageSource(text: string): boolean {
    if (text.length < MIN_USEFUL_CHARS) return true;
    const entityMatches = text.match(HTML_ENTITY_RE);
    if (entityMatches && entityMatches.length > text.length / 20) return true;
    // Mostly whitespace/image markup
    if (text.replaceAll(/\s+/g, '').length < MIN_USEFUL_CHARS) return true;
    return false;
}

/** Default content budget when provider limit is unknown. Conservative fallback. */
const DEFAULT_CONTENT_BUDGET = 20_000;

/** Fraction of the provider's content budget allocated to newsletter source blocks. */
const CONTENT_BUDGET_FRACTION = 7 / 10;

/**
 * Inject source blocks into the brief prompt.
 * Uses non-XML --- SOURCE --- delimiters to avoid entity escaping issues.
 * Structural XML tags are stripped from all source content.
 * Garbage sources (raw HTML, tracking pixels) are filtered out.
 *
 * No artificial per-source or total cap — the budget is derived from the
 * provider's context window (70% of maxContentChars). More newsletters =
 * bigger brief; fewer = smaller. The user controls scope by managing their
 * subscriptions.
 *
 * @param maxContentChars  Provider budget from getMaxContentChars(). Pass 0
 *   or omit to use a conservative default (useful in tests).
 */
export function insertBriefContent(
    prompt: string,
    sources: BriefSource[],
    maxContentChars = 0
): { filled: string; truncatedCount: number } {
    const totalBudget = Math.floor(
        (maxContentChars > 0 ? maxContentChars : DEFAULT_CONTENT_BUDGET) * CONTENT_BUDGET_FRACTION
    );

    // Build all blocks first, then trim if over budget
    const cleaned: { name: string; text: string; local: boolean }[] = [];
    for (const src of sources) {
        const name = stripStructuralTags(src.sourceDisplayName);
        const triage = stripStructuralTags(src.triageText);
        if (isGarbageSource(triage)) continue;
        cleaned.push({ name, text: triage, local: src.local === true });
    }

    // Assemble blocks — no per-source cap. Every story the user subscribed to gets included.
    const entries = cleaned.map((c, i) => ({
        block: `--- SOURCE: ${c.name} ---\n${c.text}\n--- END SOURCE ---`,
        idx: i, text: c.text, name: c.name, local: c.local,
    }));

    const { blocks, truncatedCount } = fitToTokenBudget(entries, totalBudget);
    const content = blocks.join('\n\n');
    return {
        // Use split/join instead of replace() to avoid JS $-pattern evaluation
        // ($&, $', etc.) from untrusted newsletter content injecting into the prompt.
        filled: prompt.split('{{CONTENT}}').join(content),
        truncatedCount,
    };
}

// ── Podcast Script ───────────────────────────────────────────────────────────

const WORDS_PER_MINUTE = 130;

/**
 * Build the podcast script rewrite prompt.
 * Converts markdown brief to spoken conversational prose.
 * maxMins is a ceiling — if the news is light, produce a shorter script rather than padding.
 */
export interface PodcastScriptPromptOptions {
    language?: string;
    maxMins?: number;
    /** Cross-day memory, so the script opens with what is NEW. */
    recall?: RecallSelection;
    /** Home-region aliases, so a local segment is reserved. */
    homeRegion?: string;
}

export function buildPodcastScriptPrompt(options: PodcastScriptPromptOptions = {}): string {
    const isNonEnglish = options.language && options.language.toLowerCase() !== 'english';
    const langInstruction = isNonEnglish
        ? `\n- Speak entirely in ${options.language}, including opening, closing, and all transitions`
        : '';
    const transitionNote = isNonEnglish
        ? `Convert theme headings to natural spoken transitions appropriate in ${options.language}`
        : 'Convert theme headings to spoken transitions: "In geopolitics today...", "In tech and AI...", "On the business and markets front..."';
    const maxWords = Math.round((options.maxMins ?? 5) * WORDS_PER_MINUTE);

    const region = (options.homeRegion ?? '').trim();
    const hasRegion = region.length > 0;
    // Without a reserved segment the local story loses every time: the opener
    // asks for the biggest stories and the word cap squeezes from the bottom.
    const regionRule = hasRegion
        ? `\n- Reserve a short segment for stories close to home (${stripStructuralTags(region).slice(0, 200)}). Do not cut it to fit the word budget — cut international coverage instead`
        : '';

    const hasMemory = options.recall
        && (options.recall.continuing.length > 0 || options.recall.heard.length > 0);
    const memoryRule = hasMemory
        ? `
- The listener has heard earlier briefings. Open with what is NEW since they last listened
- For a story that continues from a previous briefing, give the new development only — do NOT
  re-explain the background they already have
- For anything they missed, one sentence of catch-up is enough`
        : '';

    const openerRule = hasMemory
        ? '- Open with one sentence on what has changed since the last briefing'
        : '- Open with one sentence previewing the 2-3 biggest stories of the day';

    return `<task>Rewrite this daily news brief as a spoken podcast script for a solo news briefing.</task>
<requirements>
- Remove all markdown formatting (no **, ##, ###, -, bullets)
- ${transitionNote}
- Remove source attribution parentheses like (Sources: X, Y)
${openerRule}${regionRule}${memoryRule}
- Close with a single sentence wrap-up — vary the phrasing, do NOT use generic "thanks for tuning in"
- Write for the ear, not the eye: use contractions, short sentences, and natural rhythm
- Connect related stories where possible ("And that ties into...", "Meanwhile on the same front...")
- Do NOT just expand each bullet into a longer paragraph — restructure, combine, and add context
- Aim for a conversational tone as if explaining to a colleague over coffee
- Maximum ${maxWords} words — if the news is light, write less rather than padding${langInstruction}
</requirements>
<brief>
{{CONTENT}}
</brief>`;
}

/**
 * Inject brief text into the podcast script prompt.
 * Strips structural tags from the brief text.
 */
export function insertPodcastContent(prompt: string, brief: string): string {
    // Use split/join to avoid JS $-pattern evaluation from untrusted content.
    return prompt.split('{{CONTENT}}').join(stripStructuralTags(brief));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

interface BlockEntry {
    block: string;
    idx: number;
    text: string;
    name: string;
    /** Home-region source: protected from the drop pass. */
    local: boolean;
}

/** Trim floor for an ordinary source. */
const MIN_SOURCE_CHARS = 200;
/**
 * Trim floor for a home-region source.
 *
 * Higher than the ordinary floor so a trimmed local paper keeps enough text to
 * be summarisable rather than being reduced to a headline. Local papers are
 * short to begin with, so the old flat 200-char floor gutted them.
 */
const MIN_LOCAL_SOURCE_CHARS = 600;

/** Trim source blocks to fit within a character budget. Preserves source count where possible. */
function fitToTokenBudget(
    entries: BlockEntry[],
    budget: number
): { blocks: string[]; truncatedCount: number } {
    let total = entries.reduce((sum, e) => sum + e.block.length, 0);
    let truncatedCount = 0;

    if (total <= budget) {
        return { blocks: entries.map(e => e.block), truncatedCount: 0 };
    }

    // ── Step 1: trim iteratively, largest first ─────────────────────────────
    // Reduce only as much as the overage requires. The floors are floors the
    // trimmer may not cross, NOT targets to trim down to — bulk-truncating
    // every source to its floor the moment the budget is exceeded would throw
    // away most of an available budget to recover a small overage.
    entries.sort((a, b) => b.block.length - a.block.length);
    for (const entry of entries) {
        if (total <= budget) break;
        const floor = entry.local ? MIN_LOCAL_SOURCE_CHARS : MIN_SOURCE_CHARS;
        const maxChars = Math.max(floor, Math.floor(entry.text.length * (budget / total)));
        const capped = capAtSentenceBoundary(entry.text, maxChars);
        if (capped.length < entry.text.length) {
            const oldLen = entry.block.length;
            entry.block = `--- SOURCE: ${entry.name} ---\n${capped}\n--- END SOURCE ---`;
            entry.text = capped;
            total -= (oldLen - entry.block.length);
            truncatedCount++;
        }
    }

    // ── Step 2: drop, non-local first ───────────────────────────────────────
    // The comparator is (local ASC, length ASC): EVERY non-local source is
    // exhausted before the first local one is dropped, regardless of length.
    // Length-only ordering dropped the shortest first, which is exactly the
    // shape of a local paper — that is how local news was being silently
    // squeezed out of the brief on heavy news days.
    entries.sort((a, b) => {
        if (a.local !== b.local) return a.local ? 1 : -1;
        return a.block.length - b.block.length;
    });
    while (total > budget && entries.length > 1) {
        const dropped = entries.shift();
        if (dropped) total -= dropped.block.length;
        truncatedCount++;
    }

    // ── Step 3: one source left and still over budget ───────────────────────
    // Protection changes the ORDER of sacrifice, never the ceiling. The floors
    // are floors on trimming, not guarantees against a budget smaller than the
    // floor, so the last survivor is hard-truncated to fit.
    if (total > budget && entries.length === 1) {
        const only = entries[0];
        const overhead = only.block.length - only.text.length;
        const room = Math.max(0, budget - overhead);
        if (only.text.length > room) {
            const capped = only.text.slice(0, room);
            only.block = `--- SOURCE: ${only.name} ---\n${capped}\n--- END SOURCE ---`;
            truncatedCount++;
        }
    }

    // Restore original order
    entries.sort((a, b) => a.idx - b.idx);
    return { blocks: entries.map(e => e.block), truncatedCount };
}

/** Truncate text at a sentence boundary at or before maxChars. */
function capAtSentenceBoundary(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    const slice = text.slice(0, maxChars);
    const lastPeriod = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('.\n'));
    return lastPeriod > maxChars * 0.5
        ? slice.slice(0, lastPeriod + 1)
        : slice;
}
