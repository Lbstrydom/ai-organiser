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
 */
export function buildDailyBriefPrompt(options: { language?: string } = {}): string {
    const isNonEnglish = options.language && options.language.toLowerCase() !== 'english';
    const langInstruction = isNonEnglish
        ? `\n- Write the entire brief, including all headings, in ${options.language}`
        : '';
    const headingNote = isNonEnglish
        ? `Choose 2-4 thematic headings appropriate for ${options.language} (e.g. equivalent of Geopolitics, Tech & AI, Business & Markets, Science & Health, Culture & Society) — only include headings that have content`
        : 'Group under 2-4 thematic headings chosen from: Geopolitics, Tech & AI, Business & Markets, Science & Health, Culture & Society — only include headings that have content';

    return `<task>Synthesise these newsletter summaries into a concise daily brief.</task>
<requirements>
- Identify stories that appear in more than one newsletter and merge them into one entry
- Each distinct event or development appears once only
- Attribute merged stories with (Sources: Name A, Name B) at the end of the bullet
- ${headingNote}
- Use ### for theme headings
- 150-300 words total
- Factual, neutral tone; no filler phrases${langInstruction}
</requirements>
<output_format>
### [Theme heading]
- **[Story title]**: One sentence summary. (Sources: Newsletter A, Newsletter B)
</output_format>
<newsletters>
{{CONTENT}}
</newsletters>`;
}

/**
 * Inject source blocks into the brief prompt.
 * Uses non-XML --- SOURCE --- delimiters to avoid entity escaping issues.
 * Structural XML tags are stripped from all source content.
 * Each source is capped at 500 chars (sentence boundary).
 * Total content is capped at 5000 chars — least-recently-added sources trimmed first.
 */
export function insertBriefContent(
    prompt: string,
    sources: BriefSource[]
): { filled: string; truncatedCount: number } {
    const PER_SOURCE_CAP = 500;
    const TOTAL_CAP = 5000;

    const blocks: string[] = [];
    let totalChars = 0;
    let truncatedCount = 0;

    for (const src of sources) {
        const name = stripStructuralTags(src.sourceDisplayName);
        const triage = stripStructuralTags(src.triageText);
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

/**
 * Build the podcast script rewrite prompt.
 * Converts markdown brief to spoken conversational prose.
 */
export function buildPodcastScriptPrompt(options: { language?: string } = {}): string {
    const isNonEnglish = options.language && options.language.toLowerCase() !== 'english';
    const langInstruction = isNonEnglish
        ? `\n- Speak entirely in ${options.language}, including opening, closing, and all transitions`
        : '';
    const transitionNote = isNonEnglish
        ? `Convert theme headings to natural spoken transitions appropriate in ${options.language}`
        : 'Convert theme headings to spoken transitions: "In geopolitics today...", "In tech and AI...", "On the business and markets front..."';

    return `<task>Rewrite this daily news brief as a short spoken podcast script.</task>
<requirements>
- Remove all markdown formatting (no **, ##, ###, -, bullets)
- ${transitionNote}
- Remove source attribution parentheses like (Sources: X, Y)
- Add a one-sentence opening that introduces today's main topics
- Add a one-sentence closing to end the briefing
- Keep it natural and conversational — write as it will be spoken aloud
- 100-250 words total${langInstruction}
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
