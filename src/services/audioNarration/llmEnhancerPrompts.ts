/**
 * LLM Enhancer prompt — single source of truth.
 *
 * XML-structured per project convention (mirrors src/services/prompts/*).
 * Bump LLM_ENHANCEMENT_PROMPT_VERSION whenever the prompt's behaviour
 * changes — it salts the on-mode fingerprint so users get fresh enhancement
 * runs after a prompt update (but only on the on-mode path; off-mode
 * literal-mode caches are unaffected).
 */

/** Bump on any structural prompt change. Salts the on-mode fingerprint. */
export const LLM_ENHANCEMENT_PROMPT_VERSION = 1;

export interface EnhancementContext {
    /** Note H1 — gives the LLM document-level context */
    noteTitle: string;
    /** 1-based; lets LLM avoid "as I said earlier" preambles on chunk 1 */
    chunkIndex: number;
    /** Total chunks so LLM can write a closer on the last chunk */
    chunkTotal: number;
    /** H2 of the previous chunk (for accurate bridges) */
    prevSectionTitle: string;
    /** H2 of the next chunk (for accurate bridges) */
    nextSectionTitle: string;
    /** Per-chunk timeout (ms). Default 90_000. */
    timeoutMs?: number;
}

/** Strip < > & so they don't break the XML structure when note titles contain them. */
function escapeXml(s: string): string {
    return s.replace(/[<>&]/g, '');
}

/**
 * Audit-code M8 — neutralise any `</note_section>` (or look-alike opening
 * tags resembling our prompt envelope) inside untrusted note content.
 * Without this, a note containing `</note_section>` could close our envelope
 * early and inject fresh instructions that compete with the prompt.
 *
 * We zero-width-space-separate the closing-tag pattern so the LLM still
 * reads the literal text but the parser regex never matches our envelope
 * boundaries. The user-visible character difference is invisible in TTS.
 */
function neutraliseEnvelopeMarkers(content: string): string {
    const ZWSP = '​';
    return content
        .replace(/<\s*\/\s*note_section\s*>/gi, `<${ZWSP}/note_section>`)
        .replace(/<\s*note_section[^>]*>/gi, (m) => m.replace(/^</, `<${ZWSP}`))
        .replace(/<\s*\/?\s*(task|context|requirements|output_format)\s*>/gi,
            (m) => m.replace(/^</, `<${ZWSP}`));
}

export function buildEnhancerPrompt(noteContent: string, ctx: EnhancementContext): string {
    return `<task>
Convert one section of an Obsidian markdown note into speech-ready
markdown for text-to-speech narration. The user will LISTEN to the
output, not read it.
</task>

<context>
Note title: ${escapeXml(ctx.noteTitle)}
Section ${ctx.chunkIndex} of ${ctx.chunkTotal}
Previous section: "${escapeXml(ctx.prevSectionTitle) || '(none — first section)'}"
Next section: "${escapeXml(ctx.nextSectionTitle) || '(none — last section)'}"
</context>

<requirements>
SKIP entirely (return nothing for):
  - YAML frontmatter (already stripped, but be safe)
  - HTML comments + tags
  - Wikilink targets that are file paths (e.g. ![[brief.mp3]])
  - Image embeds (replace with "Image: <alt>" if alt is meaningful, else skip)

SUMMARISE (do NOT read verbatim):
  - \`\`\`mermaid\`\`\` blocks: describe the diagram type and walk through the
    main flow / branches in 1-3 sentences. NEVER output mermaid syntax.
  - \`\`\`code\`\`\` blocks: say "There's a <language> snippet that <purpose>.
    <N> lines."
  - Tables >3 rows: "A table compares [X] across [Y categories]. Key
    points: [2-3 highlights]."
  - Tables <=3 rows: narrate row-by-row naturally.

RENDER verbatim with light cleanup:
  - Body paragraphs, lists, headings, callouts, blockquotes
  - Drop bold/italic markers (TTS doesn't carry weight)
  - Callout \`> [!important]\` -> "Important note: ..."

NORMALISE for TTS:
  - Currency: "EUR 600,000" not "EUR-symbol 600,000"
  - Percentages: "37 percent" not "37%"
  - Dates: "May 22nd, 2026" not "2026-05-22"
  - Acronyms on first use: spelled letter-by-letter ("O O D") with
    parenthetical expansion when the term is non-obvious.

PACE for listening:
  - Insert paragraph breaks between sub-sections so TTS can pause.
  - First section: start cleanly, no preamble.
  - Last section: end with a closer ("That concludes the note.").
  - Middle sections: end with a bridge ("That covers X. Next, Y.").

HALLUCINATION CONSTRAINTS:
  - NEVER add facts not present in the source markdown.
  - NEVER invent numbers, dates, names, or quotes.
  - When summarising tables, preserve key numbers verbatim — round only
    when the source already rounded.
  - When unsure how to summarise, prefer reading verbatim over guessing.

LANGUAGE: Match the source markdown's language. Preserve quoted text in
its original language; translate ONLY transitional phrases.
</requirements>

<output_format>
STRICT JSON only (no markdown fence, no preamble) with exactly two keys:
{
  "enhancedMarkdown": "<the rewritten markdown for THIS section>",
  "decisions": [
    {
      "blockType": "mermaid" | "table" | "code" | "acronym" | "callout" | "other",
      "action": "summarise" | "transform" | "skip" | "verbatim",
      "reason": "<one-line explanation>"
    }
  ]
}

Limit decisions to at most 15 entries per section — pick the most
interesting transforms (skipped routine body paragraphs are not worth
logging).
</output_format>

<note_section>
${neutraliseEnvelopeMarkers(noteContent)}
</note_section>`;
}
