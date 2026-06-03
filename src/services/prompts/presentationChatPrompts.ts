/**
 * Presentation Chat Prompts
 *
 * Prompts for HTML slide generation, refinement, and brand audit.
 * The LLM generates self-contained HTML using a CSS template with brand variables.
 * LLM writes semantic CSS classes — never raw hex codes.
 */

import type { BrandRule } from '../chat/brandThemeService';
// M20 fix: import marker constants from SSOT (presentationConstants).
// R3-M3 fix: MAX_HTML_PROMPT_CHARS now centralised in the same module.
import { HTML_START_MARKER, HTML_END_MARKER, MAX_HTML_PROMPT_CHARS } from '../chat/presentationConstants';
import { escapeForPrompt } from '../../utils/promptSafe';

/**
 * Tag names that should be defanged in user/HTML inputs to prevent prompt
 * injection. Includes:
 *  - Section delimiters used by the prompt builders (`task`, `output_format`,
 *    `user_request`, `edit_request`, `conversation_history`, `note_content`,
 *    `current_html`, `html`, `brand_rules`, `scope`, `web_research`,
 *    `reference_notes`, `sources`, `audience_instructions`)
 *  - System-prompt section names produced by `buildPresentationSystemPrompt`
 *    (`requirements`, `design_principles`, `available_icons`, `css_template`)
 *    so user content can't inject a fake `<requirements>` block that the
 *    LLM might honour over the real one (R2-H3 fix, 2026-04-25).
 */
// IMPORTANT: do not include `html`, `title`, or any other standard HTML
// element name here — `currentHtml` ships full wrapped documents
// (`<html lang="en">`, `<title>…</title>`, etc.) and defanging those tags
// would corrupt the document the LLM round-trips. Defang ONLY the
// XML-section markers our prompt builders actually emit.
// (Gemini final-gate finding 2026-04-25.)
const DELIMITER_TAGS = [
    'current_html', 'task', 'output_format', 'note_content',
    'user_request', 'edit_request', 'conversation_history', 'brand_rules',
    'scope', 'scoped_fragment', 'web_research', 'reference_notes', 'sources',
    'audience_instructions', 'requirements', 'design_principles',
    'available_icons', 'css_template',
    'context', 'critical_instructions', 'content_to_translate',
].join('|');

/**
 * Sanitize prompt-XML delimiters in HTML content before embedding.
 * Matches BOTH opening (<tag>) and closing (</tag>) forms — escaping only
 * the closing tag leaves an attacker free to inject an opening tag that
 * swallows subsequent legitimate prompt sections (Gemini final-gate finding,
 * 2026-04-25). The capture preserves the slash so we re-emit `< tag>` or
 * `< /tag>` depending on the matched form.
 */
// Match `<tag>`, `</tag>`, `<tag attr="x">`, `<tag />`. Trailing capture
// covers any attributes/whitespace until the closing `>`. Closing tags
// reject inner attributes per HTML, so we accept only `\s*>` after `</tag`.
const HTML_PROMPT_DELIMITER_RE = new RegExp(
    String.raw`<(/)?(${DELIMITER_TAGS})(\s[^>]*)?\s*(/)?>`,
    'gi',
);

/** Replacer for the delimiter regex — defangs the matched tag by prefixing
 *  a literal space after `<` so the LLM no longer parses it as a section
 *  boundary. Preserves the slash + tag name + any attributes/self-close. */
function defangDelimiter(_match: string, slash: string | undefined, tag: string, attrs: string | undefined, selfClose: string | undefined): string {
    return `< ${slash ?? ''}${tag}${attrs ?? ''}${selfClose ?? ''}>`;
}

function sanitizeHtmlForPrompt(html: string): string {
    const truncated = html.length > MAX_HTML_PROMPT_CHARS
        ? html.slice(0, MAX_HTML_PROMPT_CHARS) + '\n<!-- [truncated for prompt safety] -->'
        : html;
    return truncated.replaceAll(HTML_PROMPT_DELIMITER_RE, defangDelimiter);
}

/**
 * Sanitize user-authored TEXT before embedding in a prompt section. Delegates
 * to the shared, TAG-AGNOSTIC `escapeForPrompt` (debt D5) — defangs ANY tag, not
 * just the fixed chat-delimiter list, so future tags are covered too. (HTML
 * content keeps the tag-preserving `sanitizeHtmlForPrompt` above.)
 */
function sanitizeTextForPrompt(text: string): string {
    return escapeForPrompt(text);
}

// ── Generation ──────────────────────────────────────────────────────────────

export function buildGenerationPrompt(options: {
    userQuery: string;
    noteContent?: string;
    conversationHistory?: string;
}): string {
    const { userQuery, noteContent, conversationHistory } = options;

    let prompt = '';

    if (conversationHistory) {
        prompt += `<conversation_history>\n${sanitizeTextForPrompt(conversationHistory)}\n</conversation_history>\n\n`;
    }

    if (noteContent) {
        prompt += `<note_content>\n${sanitizeTextForPrompt(noteContent)}\n</note_content>\n\n`;
    }

    prompt += `<user_request>\n${sanitizeTextForPrompt(userQuery)}\n</user_request>`;

    return prompt;
}

// ── Web-search query grounding (Option A) ────────────────────────────────────

/** Hard cap on the grounded query the LLM may return — a web search query
 *  should be a short phrase, not an essay. Enforced by the caller. */
export const GROUNDED_QUERY_MAX_CHARS = 256;

/**
 * Build the prompt that asks the LLM to turn the user's literal web-search
 * query into ONE focused query grounded in the deck's topic + attached notes.
 * Output contract: a single plain-text search query line, no quotes, no
 * commentary — so the caller can pass it straight to the search provider.
 */
export function buildWebSearchGroundingPrompt(options: {
    literalQuery: string;
    description?: string;
    noteExcerpts: string[];
}): string {
    const { literalQuery, description, noteExcerpts } = options;

    let prompt = `<task>\nYou are refining a web search query for a slide deck. Rewrite the user's search request into ONE focused, high-signal web search query that is anchored in the deck's topic and the attached note context below. Add the specific entities, domain terms, timeframe, or qualifiers the context implies; drop nothing essential from the user's intent.\n</task>\n\n`;

    if (description) {
        prompt += `<deck_topic>\n${sanitizeTextForPrompt(description)}\n</deck_topic>\n\n`;
    }
    if (noteExcerpts.length > 0) {
        prompt += `<note_context>\n`;
        noteExcerpts.forEach((excerpt, i) => {
            prompt += `<note index="${i + 1}">\n${sanitizeTextForPrompt(excerpt)}\n</note>\n`;
        });
        prompt += `</note_context>\n\n`;
    }

    prompt += `<user_search_request>\n${sanitizeTextForPrompt(literalQuery)}\n</user_search_request>\n\n`;

    prompt += `<output_format>\nReturn ONLY the rewritten search query as a single line of plain text — no quotes, no markdown, no explanation, no leading label. Keep it concise (a search query, not a sentence). If the context adds nothing useful, return the user's request unchanged.\n</output_format>`;

    return prompt;
}

// ── Brand Audit ─────────────────────────────────────────────────────────────

export function buildBrandAuditPrompt(html: string, rules: BrandRule[]): string {
    // R2-H1 fix: sanitise rule id + description before interpolation. Brand
    // rules come from plugin config today, but defending against future
    // user-authored / imported brand kits costs us nothing.
    const rulesList = rules
        .map(r => `- [${sanitizeTextForPrompt(r.id)}] ${sanitizeTextForPrompt(r.description)}`)
        .join('\n');

    return `<task>Audit this HTML presentation against the brand rules. Return JSON with fixes for any violations.</task>

<brand_rules>
${rulesList}
</brand_rules>

<html>
${sanitizeHtmlForPrompt(html)}
</html>

<output_format>
Return ONLY valid JSON:
{
  "passed": ["rule-id", ...],
  "violations": [
    {
      "selector": "CSS selector targeting the violating element",
      "property": "CSS property to fix",
      "value": "corrected CSS value",
      "reason": "which rule was violated and why"
    }
  ]
}
If no violations found, return: { "passed": ["all"], "violations": [] }
</output_format>`;
}

// ── HTML Extraction ─────────────────────────────────────────────────────────

/**
 * Extract the HTML deck content from an LLM response.
 * Handles: raw HTML, HTML in code fences, HTML with surrounding text.
 */
export function extractHtmlFromResponse(response: string): string | null {
    if (!response?.trim()) return null;

    const trimmed = response.trim();

    // Try: content between HTML_START_MARKER and HTML_END_MARKER (M20 fix — use constants)
    const startIdx = trimmed.indexOf(HTML_START_MARKER);
    const endIdx = trimmed.indexOf(HTML_END_MARKER);
    if (startIdx >= 0 && endIdx > startIdx) {
        const inner = trimmed.slice(startIdx + HTML_START_MARKER.length, endIdx).trim();
        if (inner.includes('<div') || inner.includes('<section')) return inner;
    }

    // Try: content inside ```html fences
    const fenceMatch = /```(?:html)?\s*\n([\s\S]*?)\n```/i.exec(trimmed);
    if (fenceMatch) {
        const inner = fenceMatch[1].trim();
        if (inner.includes('<div') || inner.includes('<section')) return inner;
    }

    // Try: find <div class="deck"...>...</div> block
    const deckMatch = /<div\s+class="deck"[\s\S]*<\/div>\s*$/i.exec(trimmed);
    if (deckMatch) return deckMatch[0];

    // Try: starts with HTML tag (LLM returned raw HTML)
    if (trimmed.startsWith('<')) return trimmed;

    // Try: find first <section or <div tag and take everything from there
    const tagStart = trimmed.search(/<(?:section|div)\s/i);
    if (tagStart >= 0) return trimmed.slice(tagStart);

    return null;
}

/**
 * Wrap extracted HTML content in a full HTML document with the CSS theme.
 * L3 fix: uses output language for lang attribute.
 */
export function wrapInDocument(deckHtml: string, cssTheme: string, language?: string): string {
    const lang = mapLanguageToHtmlLang(language);
    return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<style>
${cssTheme}
</style>
</head>
<body>
${deckHtml}
</body>
</html>`;
}

function mapLanguageToHtmlLang(language?: string): string {
    if (!language) return 'en';
    const lower = language.toLowerCase();
    const map: Record<string, string> = {
        english: 'en', german: 'de', french: 'fr', spanish: 'es',
        italian: 'it', portuguese: 'pt', dutch: 'nl', chinese: 'zh',
        japanese: 'ja', korean: 'ko', russian: 'ru', arabic: 'ar',
        finnish: 'fi', swedish: 'sv', norwegian: 'no', danish: 'da',
    };
    return map[lower] || lower.slice(0, 2) || 'en';
}

/**
 * Extract the deck title from HTML (data-title attribute or first h1).
 */
export function extractDeckTitle(html: string): string {
    const attrMatch = /data-title="([^"]+)"/i.exec(html);
    if (attrMatch) return decodeHtmlEntities(attrMatch[1]);

    const h1Match = /<h1[^>]*>([^<]+)<\/h1>/i.exec(html);
    if (h1Match) return decodeHtmlEntities(h1Match[1].trim());

    return 'Presentation';
}

/** Decode the handful of HTML entities the renderers emit so the title (used
 *  for the export filename + the PPTX title slide) reads as plain text. */
function decodeHtmlEntities(s: string): string {
    return s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

/**
 * Count slides in HTML.
 */
export function countSlides(html: string): number {
    const matches = html.match(/class="slide[\s"]/g);
    return matches?.length ?? 0;
}

// ── Audience-styled Creation ────────────────────────────────────────────────

import type { AudienceTier, PromptSource } from '../chat/presentationTypes';

/**
 * Audience design-language slot. Inserted into `<audience_instructions>`
 * within the system prompt so per-audience defaults shape the deck. Pure
 * data — adding a new tier is one entry, no logic change.
 */
export const AUDIENCE_DESIGN_LANGUAGE: Record<AudienceTier, string> = {
    analyst: [
        'Audience: technical analysts. Prioritise data density, citations, and precise terminology.',
        'Use 5–6 bullets per content slide; include charts, tables, or stat-cards where data supports it.',
        'Cite sources inline as [1], [2], etc., and include a closing slide with the reference list.',
        'Avoid metaphors; prefer concrete numbers, ratios, percentages, and named entities.',
    ].join('\n'),
    executive: [
        'Audience: executives. Prioritise narrative clarity, takeaways, and brevity.',
        'Use ≤ 4 bullets per content slide; ≤ 8 words each. Lead with the conclusion.',
        'Use stat-cards or large-typography callouts for key numbers — never a table when a single figure will do.',
        'Use section dividers between major themes; close with explicit next-steps and decisions.',
    ].join('\n'),
    general: [
        'Audience: general professional. Balance density and clarity.',
        'Use 4–6 bullets per content slide, concise but explanatory.',
        'Mix charts, bullets, and stat-cards — pick the form that best fits each slide\'s content.',
        'Close with a clear takeaway and next steps.',
    ].join('\n'),
};

/**
 * Build a creation prompt augmented with audience tier, target length, and
 * structured source descriptors. Extends `buildGenerationPrompt` rather than
 * replacing it — whole-deck refinement / Polish stays with the existing
 * `buildRefinementPrompt`.
 */
export function buildCreationPromptWithStyle(options: {
    userQuery: string;
    sources: PromptSource[];
    audience: AudienceTier;
    length: number;
    conversationHistory?: string;
}): string {
    const { userQuery, sources, audience, length, conversationHistory } = options;

    let prompt = '';

    if (conversationHistory) {
        prompt += `<conversation_history>\n${sanitizeTextForPrompt(conversationHistory)}\n</conversation_history>\n\n`;
    }

    if (sources.length > 0) {
        prompt += '<sources>\n';
        for (const src of sources) {
            const refLabel = src.kind === 'web-search' ? 'query' : 'path';
            const fromAttr = src.fromFolder ? ` from="${escapeAttrValue(src.fromFolder)}"` : '';
            prompt += `<source kind="${src.kind}" ${refLabel}="${escapeAttrValue(src.ref)}"${fromAttr}>\n`;
            prompt += sanitizeTextForPrompt(src.content);
            prompt += '\n</source>\n\n';
        }
        prompt += '</sources>\n\n';
    }

    prompt += `<audience_instructions>\n${AUDIENCE_DESIGN_LANGUAGE[audience]}\nTarget slide count: ${length}.\n</audience_instructions>\n\n`;
    prompt += `<user_request>\n${sanitizeTextForPrompt(userQuery)}\n</user_request>`;

    return prompt;
}

function escapeAttrValue(value: string): string {
    return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
