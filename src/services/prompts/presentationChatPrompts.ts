/**
 * Presentation Chat Prompts
 *
 * Prompts for HTML slide generation, refinement, and brand audit.
 * The LLM generates self-contained HTML using a CSS template with brand variables.
 * LLM writes semantic CSS classes — never raw hex codes.
 */

import type { BrandTheme, BrandRule } from '../chat/brandThemeService';
import { buildIconReference } from '../chat/brandThemeService';

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
        prompt += `<conversation_history>\n${conversationHistory}\n</conversation_history>\n\n`;
    }

    if (noteContent) {
        prompt += `<note_content>\n${noteContent}\n</note_content>\n\n`;
    }

    prompt += `<user_request>\n${userQuery}\n</user_request>`;

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
        prompt += `<conversation_history>\n${conversationHistory}\n</conversation_history>\n\n`;
    }

    prompt += `<current_html>\n${currentHtml}\n</current_html>\n\n`;
    prompt += `<edit_request>\n${userRequest}\n</edit_request>`;

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
${html}
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
 * Validate and sanitize extracted HTML (H4 fix + R2 H1 fix).
 * Checks .deck root, .slide children, and strips unsafe content.
 */
export function validateDeckHtml(html: string): { ok: true; sanitized: string } | { ok: false; error: string } {
    if (!html.includes('class="deck') && !html.includes("class='deck")) {
        return { ok: false, error: 'Missing .deck root element' };
    }
    if (!html.includes('class="slide') && !html.includes("class='slide")) {
        return { ok: false, error: 'No .slide elements found' };
    }

    // Strip unsafe elements and attributes from LLM output
    let sanitized = html;
    sanitized = sanitized.replace(/<script[\s\S]*?<\/script>/gi, '');
    sanitized = sanitized.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
    sanitized = sanitized.replace(/<link[^>]*>/gi, '');
    sanitized = sanitized.replace(/<object[\s\S]*?<\/object>/gi, '');
    sanitized = sanitized.replace(/<embed[^>]*>/gi, '');
    sanitized = sanitized.replace(/\s+on\w+\s*=\s*"[^"]*"/gi, '');
    sanitized = sanitized.replace(/\s+on\w+\s*=\s*'[^']*'/gi, '');

    return { ok: true, sanitized };
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
