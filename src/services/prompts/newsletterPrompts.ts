/**
 * Newsletter Prompts
 *
 * Prompts for daily brief synthesis and podcast script generation.
 */

const STRUCTURAL_TAGS = [
    '</newsletters>', '<newsletters>',
    '</task>', '<task>',
    '</requirements>', '<requirements>',
    '</output_format>', '<output_format>',
    '--- SOURCE:', '--- END SOURCE ---',
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
}

/**
 * Build the daily brief system+user prompt.
 * Language instruction is injected when a non-English language is configured.
 * Word budget scales with source count for heavier news days.
 */
export function buildDailyBriefPrompt(options: { language?: string } = {}): string {
    const isNonEnglish = options.language && options.language.toLowerCase() !== 'english';
    const langInstruction = isNonEnglish
        ? `\n- Write the entire brief, including all headings, in ${options.language}`
        : '';
    const headingNote = isNonEnglish
        ? `Choose 2-4 thematic headings appropriate for ${options.language} (e.g. equivalent of Geopolitics, Tech & AI, Business & Markets, Science & Health, Culture & Society) — only include headings that have content`
        : 'Group under 2-4 thematic headings chosen from: Geopolitics, Tech & AI, Business & Markets, Science & Health, Culture & Society — only include headings that have content';

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
- Include 10-20 stories depending on how much happened; do not artificially limit to a handful
- Niche or soft stories (lifestyle, opinion pieces) can be omitted if space is needed for hard news${langInstruction}
</requirements>
<output_format>
### [Theme heading]
- **[Story title]**: One-two sentence summary. (Sources: Newsletter A, Newsletter B)
</output_format>
<newsletters>
{{CONTENT}}
</newsletters>`;
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

/**
 * Inject source blocks into the brief prompt.
 * Uses non-XML --- SOURCE --- delimiters to avoid entity escaping issues.
 * Structural XML tags are stripped from all source content.
 * Garbage sources (raw HTML, tracking pixels) are filtered out.
 * Each source is capped at 1500 chars (sentence boundary) to preserve full story lists.
 * Total content is capped at 16000 chars to accommodate heavy news days.
 */
export function insertBriefContent(
    prompt: string,
    sources: BriefSource[]
): { filled: string; truncatedCount: number } {
    const PER_SOURCE_CAP = 1500;
    const TOTAL_CAP = 16_000;

    const blocks: string[] = [];
    let totalChars = 0;
    let truncatedCount = 0;

    for (const src of sources) {
        const name = stripStructuralTags(src.sourceDisplayName);
        const triage = stripStructuralTags(src.triageText);

        if (isGarbageSource(triage)) continue; // skip garbage extraction

        const capped = capAtSentenceBoundary(triage, PER_SOURCE_CAP);
        const block = `--- SOURCE: ${name} ---\n${capped}\n--- END SOURCE ---`;

        if (totalChars + block.length > TOTAL_CAP) {
            truncatedCount++;
            continue;
        }
        blocks.push(block);
        totalChars += block.length;
    }

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
export function buildPodcastScriptPrompt(options: { language?: string; maxMins?: number } = {}): string {
    const isNonEnglish = options.language && options.language.toLowerCase() !== 'english';
    const langInstruction = isNonEnglish
        ? `\n- Speak entirely in ${options.language}, including opening, closing, and all transitions`
        : '';
    const transitionNote = isNonEnglish
        ? `Convert theme headings to natural spoken transitions appropriate in ${options.language}`
        : 'Convert theme headings to spoken transitions: "In geopolitics today...", "In tech and AI...", "On the business and markets front..."';
    const maxWords = Math.round((options.maxMins ?? 5) * WORDS_PER_MINUTE);

    return `<task>Rewrite this daily news brief as a spoken podcast script for a solo news briefing.</task>
<requirements>
- Remove all markdown formatting (no **, ##, ###, -, bullets)
- ${transitionNote}
- Remove source attribution parentheses like (Sources: X, Y)
- Open with one sentence previewing the 2-3 biggest stories of the day
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

/** Truncate text at a sentence boundary at or before maxChars. */
function capAtSentenceBoundary(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    const slice = text.slice(0, maxChars);
    const lastPeriod = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('.\n'));
    return lastPeriod > maxChars * 0.5
        ? slice.slice(0, lastPeriod + 1)
        : slice;
}
