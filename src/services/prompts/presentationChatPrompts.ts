/**
 * Presentation Chat Prompts
 *
 * Prompts for HTML slide generation, refinement, and brand audit.
 * The LLM generates self-contained HTML using a CSS template with brand variables.
 * LLM writes semantic CSS classes — never raw hex codes.
 */

import type { BrandRule } from '../chat/brandThemeService';
import { buildIconReference } from '../chat/brandThemeService';
// M20 fix: import marker constants from SSOT (presentationConstants).
// R3-M3 fix: MAX_HTML_PROMPT_CHARS now centralised in the same module.
import { HTML_START_MARKER, HTML_END_MARKER, MAX_HTML_PROMPT_CHARS } from '../chat/presentationConstants';

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
 * Sanitize prompt-XML delimiters in user-authored text before embedding.
 * Same logic as `sanitizeHtmlForPrompt` but no truncation — text inputs are
 * size-bounded by the caller. Matches both opening + closing tag forms.
 */
const TEXT_PROMPT_DELIMITER_RE = HTML_PROMPT_DELIMITER_RE;

function sanitizeTextForPrompt(text: string): string {
    return text.replaceAll(TEXT_PROMPT_DELIMITER_RE, defangDelimiter);
}

// ── Generation ──────────────────────────────────────────────────────────────

export function buildPresentationSystemPrompt(options: {
    cssTheme: string;
    outputLanguage?: string;
    brandRules?: string;
}): string {
    const { cssTheme, outputLanguage, brandRules } = options;
    const langLine = outputLanguage ? `\nGenerate all slide text in ${outputLanguage}.` : '';
    // R2-H1 fix: sanitise brandRules even though they come from the plugin's
    // own brand config — defense in depth against future config sources.
    const brandSection = brandRules
        ? `\n<brand_rules>\n${sanitizeTextForPrompt(brandRules)}\n</brand_rules>\nFollow these composition rules strictly.`
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

// ── Targeted Slide Editing — scoped prompts (slide-authoring-editing plan) ──

import type { SelectionScope, AudienceTier, SourceDescriptor } from '../chat/presentationTypes';

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

/** Format a SelectionScope as a human-readable scope description for the prompt. */
function describeScope(scope: SelectionScope): string {
    if (scope.kind === 'range') {
        const end = scope.slideEndIndex ?? scope.slideIndex;
        return `Slides ${scope.slideIndex + 1} through ${end + 1} (1-based) — labels match slide order in the input.`;
    }
    if (scope.kind === 'slide') {
        return `Slide ${scope.slideIndex + 1} (1-based).`;
    }
    const path = scope.elementPath ?? '(unspecified)';
    const kind = scope.elementKind ?? 'element';
    return `Element on slide ${scope.slideIndex + 1}: kind="${kind}", path="${path}".`;
}

/**
 * Build a scoped CONTENT-mode edit prompt. Tells the LLM to modify ONLY
 * the indicated region's text/data, preserving everything else byte-for-byte.
 *
 * Sender pre-renders `references` and `webResearch` blocks (via
 * SlideContextProvider) so this builder is a pure string-mash with no I/O.
 */
export function buildScopedContentEditPrompt(options: {
    /** FULL canonical deck HTML — the LLM needs to see all slides to
     *  preserve out-of-scope content byte-for-byte. */
    currentHtml: string;
    /** The scoped subtree, called out separately so the LLM knows what
     *  to actually modify. */
    scopedFragment: string;
    scope: SelectionScope;
    userRequest: string;
    references?: string;
    webResearch?: string;
    conversationHistory?: string;
}): string {
    const {
        currentHtml, scopedFragment, scope, userRequest,
        references, webResearch, conversationHistory,
    } = options;

    let prompt = '<task>\n';
    prompt += 'Make a CONTENT edit to the indicated slide region. Rewrite only the text or data inside the scope. ';
    prompt += 'Preserve every slide OUTSIDE the scope byte-for-byte (you can see them in <current_html>). ';
    prompt += 'Return the COMPLETE updated deck HTML, starting with `<div class="deck">` and ending with `</div>`.\n';
    prompt += '</task>\n\n';

    prompt += `<scope>\n${describeScope(scope)}\n</scope>\n\n`;
    prompt += `<current_html>\n${sanitizeHtmlForPrompt(currentHtml)}\n</current_html>\n\n`;
    prompt += `<scoped_fragment>\n${sanitizeHtmlForPrompt(scopedFragment)}\n</scoped_fragment>\n\n`;

    if (references?.trim()) {
        prompt += `<reference_notes>\n${sanitizeTextForPrompt(references)}\n</reference_notes>\n\n`;
    }
    if (webResearch?.trim()) {
        prompt += `<web_research>\n${sanitizeTextForPrompt(webResearch)}\n</web_research>\n\n`;
    }
    if (conversationHistory) {
        prompt += `<conversation_history>\n${sanitizeTextForPrompt(conversationHistory)}\n</conversation_history>\n\n`;
    }

    prompt += `<edit_request>\n${sanitizeTextForPrompt(userRequest)}\n</edit_request>\n\n`;
    prompt += '<output_format>\n'
        + `Wrap the COMPLETE updated deck HTML between ${HTML_START_MARKER} and ${HTML_END_MARKER}. `
        + 'Start with `<div class="deck">`, include EVERY original slide (only the scoped region modified, '
        + 'all others unchanged byte-for-byte), and close with `</div>`. '
        + 'Use the existing CSS classes — do NOT introduce new ones.\n'
        + '</output_format>';

    return prompt;
}

/**
 * Build a scoped DESIGN-mode edit prompt. Layout, hierarchy, visual emphasis,
 * structure changes — but text content stays.
 *
 * For decks under the design-mode fallback threshold, `deckContextSummary`
 * is the full deck design summary; for larger decks it's a compact token sheet.
 * The caller picks which to pass based on deck size.
 */
export function buildScopedDesignEditPrompt(options: {
    /** FULL canonical deck HTML — needed to preserve unscoped slides
     *  byte-for-byte and to match deck design language. */
    currentHtml: string;
    /** The scoped subtree, called out separately so the LLM knows what to restyle. */
    scopedFragment: string;
    scope: SelectionScope;
    userRequest: string;
    conversationHistory?: string;
}): string {
    const { currentHtml, scopedFragment, scope, userRequest, conversationHistory } = options;

    let prompt = '<task>\n';
    prompt += 'Make a DESIGN edit to the indicated slide region. Change layout, hierarchy, structure, ';
    prompt += 'visual emphasis, or component choice — but DO NOT change underlying text content or data values.\n';
    prompt += 'Preserve every slide OUTSIDE the scope byte-for-byte (you can see them in <current_html>). ';
    prompt += 'Return the COMPLETE updated deck HTML, starting with `<div class="deck">` and ending with `</div>`.\n';
    prompt += '</task>\n\n';

    prompt += `<scope>\n${describeScope(scope)}\n</scope>\n\n`;
    prompt += `<current_html>\n${sanitizeHtmlForPrompt(currentHtml)}\n</current_html>\n\n`;
    prompt += `<scoped_fragment>\n${sanitizeHtmlForPrompt(scopedFragment)}\n</scoped_fragment>\n\n`;

    if (conversationHistory) {
        prompt += `<conversation_history>\n${sanitizeTextForPrompt(conversationHistory)}\n</conversation_history>\n\n`;
    }

    prompt += `<edit_request>\n${sanitizeTextForPrompt(userRequest)}\n</edit_request>\n\n`;
    prompt += '<output_format>\n'
        + `Wrap the COMPLETE updated deck HTML between ${HTML_START_MARKER} and ${HTML_END_MARKER}. `
        + 'Start with `<div class="deck">`, include EVERY original slide (only the scoped region restyled, '
        + 'all others unchanged byte-for-byte), and close with `</div>`. '
        + 'Use the existing CSS classes — do NOT introduce new ones. '
        + 'Match the deck\'s visual rhythm and design language.\n'
        + '</output_format>';

    return prompt;
}

/**
 * Build a creation prompt augmented with audience tier, target length, and
 * structured source descriptors. Extends `buildGenerationPrompt` rather than
 * replacing it — whole-deck refinement / Polish stays with the existing
 * `buildRefinementPrompt`.
 */
export function buildCreationPromptWithStyle(options: {
    userQuery: string;
    sources: SourceDescriptor[];
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
            const refLabel = src.kind === 'web' ? 'url' : 'path';
            prompt += `<source kind="${src.kind}" ${refLabel}="${escapeAttrValue(src.ref)}">\n`;
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
