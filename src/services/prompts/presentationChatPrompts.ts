/**
 * Presentation Chat Prompts
 *
 * Prompts for HTML slide generation, refinement, and brand audit.
 * The LLM generates self-contained HTML using a CSS template with brand variables.
 * LLM writes semantic CSS classes — never raw hex codes.
 */

import type { BrandRule } from '../chat/brandThemeService';
import { buildIconReference } from '../chat/brandThemeService';
// M20 fix: import marker constants from SSOT (presentationConstants)
import { HTML_START_MARKER, HTML_END_MARKER } from '../chat/presentationConstants';

const MAX_HTML_PROMPT_CHARS = 120_000;

/** H2 fix: escape prompt XML delimiter sequences in HTML content before embedding in prompts. */
// M5/R3-H2 fix: case-insensitive regex covers all delimiter tags used across prompt builders
const HTML_PROMPT_DELIMITER_RE = /<\/(current_html|html|task|output_format|note_content|user_request|edit_request|conversation_history|brand_rules)(\s*>)/gi;

function sanitizeHtmlForPrompt(html: string): string {
    const truncated = html.length > MAX_HTML_PROMPT_CHARS
        ? html.slice(0, MAX_HTML_PROMPT_CHARS) + '\n<!-- [truncated for prompt safety] -->'
        : html;
    return truncated.replaceAll(HTML_PROMPT_DELIMITER_RE, '< /$1$2');
}

/**
 * M4 fix: sanitize user-authored text before embedding in XML-tagged prompt context.
 * Defangs any closing tags that match the XML delimiter names used in these prompts.
 */
const TEXT_PROMPT_DELIMITER_RE = /<\/(note_content|user_request|edit_request|conversation_history|task|output_format)(\s*>)/gi;

function sanitizeTextForPrompt(text: string): string {
    return text.replaceAll(TEXT_PROMPT_DELIMITER_RE, '< /$1$2');
}

// ── Generation ──────────────────────────────────────────────────────────────

export function buildPresentationSystemPrompt(options: {
    cssTheme: string;
    outputLanguage?: string;
    brandRules?: string;
}): string {
    const { cssTheme, outputLanguage, brandRules } = options;
    const langLine = outputLanguage ? `\nGenerate all slide text in ${outputLanguage}.` : '';
    const brandSection = brandRules
        ? `\n<brand_rules>\n${brandRules}\n</brand_rules>\nFollow these composition rules strictly.`
        : '';

    const iconRef = buildIconReference();

    return `You are a professional presentation designer. You create visually rich HTML slide decks.${langLine}${brandSection}

<design_principles>
- ONE idea per slide — if a slide covers two points, split it into two slides
- Visual hierarchy: heading > subheading > body > caption — never skip levels
- White space: leave at least 30% of the slide area empty — resist filling all available space
- Consistency: use the same layout pattern for the same content type across the deck
- Contrast: white or light text on dark backgrounds; dark text on light backgrounds
- Alignment: all elements on a slide share a visual edge — left-align body text, center titles
- Bullet economy: max 6 bullets, max 10 words each — longer points become sub-slides
- Data over decoration: prefer a table, stat card, or chart reference over a paragraph of numbers
- Progressive disclosure: introduce a concept with a section slide before its detail slides
- Strong close: end with a takeaway, call-to-action, or key message — not just "Thank you"
</design_principles>

<requirements>
- Wrap your complete HTML output between ${HTML_START_MARKER} and ${HTML_END_MARKER} markers
- Return ONLY the HTML content of a presentation (no markdown, no explanation)
- Start with <div class="deck" data-title="Deck Title"> and end with </div>
- Each slide is a <section class="slide [type]"> where type is one of: slide-title, slide-content, slide-section, slide-closing
- Slides are 1920x1080px — the CSS handles this, just use the classes
- Use the provided CSS classes and variables — do NOT write raw hex color codes
- Use semantic HTML: h1/h2 for headings, ul/li for bullets, table for data, strong for emphasis
- Layouts: .col-container > .col for two-column, .stats-grid > .stat-card for KPI metrics
- Icons: use <span class="icon icon-{name}"></span> for visual accents — available icons listed below
- Size variants: .icon-lg (1.5em), .icon-xl (2em), .icon-2xl (3em); colour: .icon-accent, .icon-primary
- Include <aside class="speaker-notes">...</aside> inside each content slide for speaker notes
- Add <span class="slide-num">N</span> at the end of each slide
- Tables: use th for headers, support .badge .badge-green/.badge-yellow/.badge-red for status
- Aim for 4-6 bullet points per content slide, concise and scannable
- Include a title slide (first), logical section dividers, and a closing slide (last)
</requirements>

<available_icons>
${iconRef}
</available_icons>

<css_template>
${cssTheme}
</css_template>`;
}

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

// ── Refinement ──────────────────────────────────────────────────────────────

export function buildRefinementPrompt(options: {
    currentHtml: string;
    userRequest: string;
    conversationHistory?: string;
}): string {
    const { currentHtml, userRequest, conversationHistory } = options;

    let prompt = '<task>Modify the presentation HTML according to the user\'s request. Return the complete updated HTML.</task>\n\n';

    if (conversationHistory) {
        prompt += `<conversation_history>\n${sanitizeTextForPrompt(conversationHistory)}\n</conversation_history>\n\n`;
    }

    prompt += `<current_html>\n${sanitizeHtmlForPrompt(currentHtml)}\n</current_html>\n\n`;
    prompt += `<edit_request>\n${sanitizeTextForPrompt(userRequest)}\n</edit_request>`;

    return prompt;
}

// ── Brand Audit ─────────────────────────────────────────────────────────────

export function buildBrandAuditPrompt(html: string, rules: BrandRule[]): string {
    const rulesList = rules.map(r => `- [${r.id}] ${r.description}`).join('\n');

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
    if (attrMatch) return attrMatch[1];

    const h1Match = /<h1[^>]*>([^<]+)<\/h1>/i.exec(html);
    if (h1Match) return h1Match[1].trim();

    return 'Presentation';
}

/**
 * Count slides in HTML.
 */
export function countSlides(html: string): number {
    const matches = html.match(/class="slide[\s"]/g);
    return matches?.length ?? 0;
}
