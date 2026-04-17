/**
 * Presentation Quality Prompts
 *
 * Two-pass quality review prompts for HTML slide decks:
 * - Fast scan: cheap model, broad visual categories
 * - Deep scan: main model, spatial/contrast analysis
 */

const FAST_SCAN_CATEGORIES = ['colour', 'typography', 'overflow', 'density', 'gestalt', 'consistency'] as const;
const DEEP_SCAN_CATEGORIES = ['spacing', 'contrast', 'alignment', 'visual-balance'] as const;

const MAX_HTML_PROMPT_CHARS = 120_000;

/**
 * H2/R3-H2 fix: sanitize HTML before embedding in XML-tagged prompt context.
 * Uses a single case-insensitive regex to defang any closing tag that matches
 * the XML delimiter names used in these prompts, preventing prompt injection.
 * Truncates to prevent token budget overruns.
 */
const PROMPT_DELIMITER_RE = /<\/(html_deck|task|requirements|output_format|sampling_note)(\s*>)/gi;

function sanitizeHtmlForPrompt(html: string): string {
    const truncated = html.length > MAX_HTML_PROMPT_CHARS
        ? html.slice(0, MAX_HTML_PROMPT_CHARS) + '\n<!-- [truncated for prompt safety] -->'
        : html;
    // Insert a space before the slash to defang matching closing tags (case-insensitive)
    return truncated.replaceAll(PROMPT_DELIMITER_RE, '< /$1$2');
}

const OUTPUT_FORMAT = `{
  "findings": [
    {
      "slideIndex": 0,
      "category": "typography",
      "severity": "MEDIUM",
      "issue": "Font size too small for body text",
      "suggestion": "Increase body text to at least 24px"
    }
  ]
}`;

const SEVERITY_GUIDANCE = `Severity levels:
- HIGH: Blocks readability or looks broken (e.g., text overflow, invisible text)
- MEDIUM: Noticeable quality issue (e.g., inconsistent font sizes, poor spacing)
- LOW: Minor polish opportunity (e.g., slight alignment offset, suboptimal whitespace)`;

function buildSamplingNote(slideCount: number): string {
    if (slideCount <= 30) return '';
    return `\n<sampling_note>
This deck has ${slideCount} slides total. You are seeing a representative sample only.
Each sampled slide carries a data-sample-index attribute (0-based position within this sample).
IMPORTANT: Use the data-sample-index value as the slideIndex in all findings — do NOT use data-original-index or infer position from document order.
</sampling_note>`;
}

/** Build prompt for fast visual scan (cheap model). */
export function buildFastScanPrompt(html: string, slideCount: number): string {
    return `<task>
Perform a fast visual quality scan of this HTML slide deck (${slideCount} slides).
Check each slide for issues in these categories: ${FAST_SCAN_CATEGORIES.join(', ')}.
</task>

<requirements>
- Focus on clearly visible issues only — do not speculate
- Category definitions:
  - colour: Clashing colours, poor background/text pairing, inconsistent palette
  - typography: Font size too small (<18px body), too many font families, inconsistent sizing
  - overflow: Text overflowing containers, content cut off, horizontal scrolling
  - density: Too much text on one slide (>6 bullet points), walls of text
  - gestalt: Poor grouping, related items not visually grouped, misaligned elements
  - consistency: Style inconsistencies between slides (different heading sizes, spacing)
- ${SEVERITY_GUIDANCE}
- Return an empty findings array if no issues found
- slideIndex is 0-based
</requirements>${buildSamplingNote(slideCount)}

<output_format>
Return ONLY valid JSON matching this schema:
${OUTPUT_FORMAT}
</output_format>

<html_deck>
${sanitizeHtmlForPrompt(html)}
</html_deck>`;
}

/** Build prompt for deep spatial analysis (main model). */
export function buildDeepScanPrompt(html: string, slideCount: number): string {
    return `<task>
Perform a deep spatial and contrast analysis of this HTML slide deck (${slideCount} slides).
Focus on these categories: ${DEEP_SCAN_CATEGORIES.join(', ')}.
</task>

<requirements>
- Analyse the CSS and HTML structure for spatial relationships
- Category definitions:
  - spacing: Uneven margins/padding, cramped elements, excessive whitespace
  - contrast: WCAG AA failures, low contrast text/background combinations
  - alignment: Elements not aligned to grid, inconsistent left/right margins
  - visual-balance: Lopsided layouts, heavy top/bottom, unbalanced columns
- ${SEVERITY_GUIDANCE}
- Return an empty findings array if no issues found
- slideIndex is 0-based
</requirements>${buildSamplingNote(slideCount)}

<output_format>
Return ONLY valid JSON matching this schema:
${OUTPUT_FORMAT}
</output_format>

<html_deck>
${sanitizeHtmlForPrompt(html)}
</html_deck>`;
}
