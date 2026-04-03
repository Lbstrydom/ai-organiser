/**
 * Flashcard Generation Prompts
 *
 * Prompts for generating flashcards from note content and screenshots.
 * Supports multiple output formats (Anki, Brainscape) with proper math notation handling.
 * Supports standard Q&A, multiple choice, and screenshot-based MC answering.
 * Supports three source types: current note, multiple notes, and screenshot.
 */

export interface FlashcardFormat {
    id: string;
    name: string;
    description: string;
    fileExtension: string;
    mathSupport: 'mathjax' | 'plain' | 'latex';
    prompt: string;
}

export type FlashcardStyle = 'standard' | 'multiple-choice';

export interface FlashcardStyleOption {
    id: FlashcardStyle;
    name: string;
    description: string;
}

export type FlashcardSource = 'current-note' | 'multiple-notes' | 'screenshot';

export interface FlashcardSourceOption {
    id: FlashcardSource;
    name: string;
    description: string;
    requiresVision?: boolean;
}

export const FLASHCARD_SOURCES: FlashcardSourceOption[] = [
    {
        id: 'current-note',
        name: 'Current Note',
        description: 'Generate flashcards from the currently open note'
    },
    {
        id: 'multiple-notes',
        name: 'Multiple Notes',
        description: 'Select multiple notes and extract core concepts across them'
    },
    {
        id: 'screenshot',
        name: 'Screenshot',
        description: 'Answer multiple choice questions from a screenshot image',
        requiresVision: true
    }
];

export const FLASHCARD_STYLES: FlashcardStyleOption[] = [
    {
        id: 'standard',
        name: 'Standard Q&A',
        description: 'Traditional question and answer format for learning concepts'
    },
    {
        id: 'multiple-choice',
        name: 'Multiple Choice',
        description: 'Exam-style questions with options A, B, C, D for test preparation'
    }
];

/**
 * Concise Unicode math reference for Brainscape (no LaTeX/MathJax support).
 * Contains all required symbols so tests can verify presence.
 * Used in both the Brainscape base prompt and the screenshot prompt for Brainscape format.
 */
export const UNICODE_MATH_TABLE = `Use Unicode math symbols directly — NEVER use LaTeX commands or $ delimiters.
Superscripts: ² ³ ⁿ (x², a³b², 2ⁿ)  Subscripts: ₀ ₁ ₂ (x₀, a₁ + a₂)
Operators: ≤ ≥ ≠ ± × ÷ √ ∞ (√2, n → ∞)
Greek: π θ σ μ λ Σ Δ Ω (2π, sin θ, σ², Σxᵢ)
Sets: ∈ ∉ ⊂ ⊃ ∅ ∪ ∩ (x ∈ S, A ∪ B)
Arrows: → ← ↔ ⇒ ⇔ (P ⇒ Q)
Examples: x = (-b ± √(b² - 4ac)) ÷ 2a  |  O(n log n)  |  lim(n→∞) 1/n = 0
For fractions: use "a/b" or "(numerator) over (denominator)".`;

/**
 * Anki format - uses MathJax notation
 * Inline math: \( ... \)
 * Display math: \[ ... \]
 */
export const ANKI_FORMAT: FlashcardFormat = {
    id: 'anki',
    name: 'Anki',
    description: 'CSV format for Anki with MathJax math notation',
    fileExtension: 'csv',
    mathSupport: 'mathjax',
    prompt: `You are an expert at creating high-quality flashcards for spaced repetition learning.

<task>
Generate flashcards from the provided content. Output a CSV file that can be imported directly into Anki.
</task>

<csv_format>
- Two columns: Question (front) and Answer (back)
- Wrap ALL fields in double quotes
- Escape internal quotes by doubling them: "He said ""hello"""
- NO header row — Anki imports raw Q,A pairs
- UTF-8 encoding
- Use <br> for line breaks within a field (Anki renders these as newlines)
- Avoid trailing spaces inside fields
</csv_format>

<math_notation>
CRITICAL: For any mathematical expressions, use MathJax notation that Anki supports:
- Inline math: \\\\( expression \\\\)
- Display/block math: \\\\[ expression \\\\]

Examples:
- Quadratic formula: \\\\( x = \\\\frac{-b \\\\pm \\\\sqrt{b^2-4ac}}{2a} \\\\)
- Euler's identity: \\\\( e^{i\\\\pi} + 1 = 0 \\\\)
- Integral: \\\\[ \\\\int_0^\\\\infty e^{-x^2} dx = \\\\frac{\\\\sqrt{\\\\pi}}{2} \\\\]

DO NOT use $ delimiters — Anki requires \\\\( \\\\) and \\\\[ \\\\] notation.
</math_notation>

<markdown_support>
Anki supports HTML rendering. You may use:
- <b>bold</b> or **bold** for emphasis and key terms
- <i>italic</i> for definitions and foreign terms
- <br> for line breaks
- Numbered and bulleted lists with HTML tags
</markdown_support>

<card_quality_rules>
1. ONE concept per card — atomic knowledge units
2. Questions should be specific and unambiguous
3. Answers should be concise but complete
4. Avoid yes/no questions — prefer "what", "how", "why", "when"
5. For definitions: Ask for the term given the definition, AND the definition given the term
6. For processes: Break into sequential steps, each step a separate card
7. For comparisons: Create cards for similarities AND differences
8. Include context clues if the term is ambiguous
</card_quality_rules>

<output_requirements>
- Generate 5-20 cards depending on content density
- Quality over quantity — skip trivial facts
- Ensure mathematical expressions are properly formatted with MathJax
- Wrap ALL fields in double quotes for reliable CSV import
</output_requirements>

<process>
1. Read ALL provided content carefully
2. Identify the key concepts, definitions, processes, and relationships
3. Create flashcard pairs following the card quality rules
4. Format as CSV following the rules above
5. Output the complete CSV file
</process>

Output ONLY the CSV content, no explanations or markdown code blocks.`
};

/**
 * Brainscape format - uses Unicode math, supports basic markdown
 */
export const BRAINSCAPE_FORMAT: FlashcardFormat = {
    id: 'brainscape',
    name: 'Brainscape',
    description: 'CSV format for Brainscape with Unicode math notation',
    fileExtension: 'csv',
    mathSupport: 'plain',
    prompt: `You are an expert at creating high-quality Brainscape-compatible flashcards.

<task>
Generate flashcards from the provided content. Output a 2-column CSV file (no headers) for Brainscape import.
</task>

<csv_format>
- Two columns: Question (front) and Answer (back)
- Wrap ALL fields in double quotes
- Escape internal quotes by doubling them: "He said ""hello"""
- Preserve REAL line breaks within quoted fields (not <br> tags)
- NO header row
- UTF-8 encoding
- Avoid trailing spaces inside fields
</csv_format>

<math_handling>
CRITICAL: Brainscape does NOT support LaTeX or MathJax rendering.
${UNICODE_MATH_TABLE}
</math_handling>

<markdown_support>
Brainscape supports basic markdown:
- **bold** for emphasis and key terms
- *italic* for definitions and foreign terms
- Bullet lists with - (with line breaks)
- Numbered lists with 1. 2. 3.

DO NOT use:
- Code fences (\`\`\`) — not rendered in card view
- Tables — describe data in prose or lists instead
- Headers (# ##) — not rendered in card view
- HTML tags (<br>, <b>) — use real line breaks and **bold** instead
</markdown_support>

<card_quality_rules>
1. ONE concept per card — atomic knowledge units
2. Questions should be specific and unambiguous
3. Answers should be concise but complete
4. Avoid yes/no questions — prefer "what", "how", "why", "when"
5. For definitions: Ask for the term given the definition, AND the definition given the term
6. For processes: Break into sequential steps, each step a separate card
7. For comparisons: Create cards for similarities AND differences
8. Include context clues if the term is ambiguous
</card_quality_rules>

<output_requirements>
- Generate 5-20 cards depending on content density
- Quality over quantity — skip trivial facts
- Use Unicode math symbols (²³√π∞Σ) — NEVER LaTeX
- Wrap ALL fields in double quotes for reliable CSV import
</output_requirements>

<process>
1. Read ALL provided content carefully
2. Identify the key concepts, definitions, processes, and relationships
3. Create flashcard pairs following the card quality rules
4. Format as CSV following the rules above
5. Output the complete CSV file
</process>

Output ONLY the CSV content, no explanations or markdown code blocks.`
};

/**
 * All available flashcard formats
 */
export const FLASHCARD_FORMATS: FlashcardFormat[] = [
    ANKI_FORMAT,
    BRAINSCAPE_FORMAT
];

/**
 * Get a flashcard format by ID
 */
export function getFlashcardFormat(formatId: string): FlashcardFormat | undefined {
    return FLASHCARD_FORMATS.find(f => f.id === formatId);
}

/**
 * Get format-specific style instructions, including only the relevant example.
 */
function getStyleInstructions(style: FlashcardStyle, formatId: string): string {
    const isAnki = formatId === 'anki';
    const lineBreakNote = isAnki
        ? 'Use <br> tags for line breaks within CSV fields.'
        : 'Use REAL line breaks within quoted CSV fields.';

    if (style === 'standard') {
        const example = isAnki
            ? `"What is Newton's second law of motion?","**F = ma**<br><br>Force equals mass times acceleration.<br><br>**Tip:** Heavier cart needs more force for same acceleration."`
            : `"What is Newton's second law of motion?","**F = ma**\n\nForce equals mass times acceleration.\n\n**Tip:** Heavier cart needs more force for same acceleration."`;

        return `<card_style>
Generate STANDARD Q&A flashcards. ${lineBreakNote}

- ONE concept per card, specific questions (what/how/why — no yes/no)
- Answer: key answer in **bold**, 1-2 sentence explanation, optional **Tip:**

EXAMPLE:
${example}
</card_style>`;
    }

    // multiple-choice
    const example = isAnki
        ? `"Which organelle is the powerhouse of the cell?<br><br>A) Nucleus<br>B) Mitochondria<br>C) Ribosome<br>D) Golgi apparatus","**B) Mitochondria** — produces ATP via cellular respiration.<br><br>- A: Nucleus stores genetic material<br>- C: Ribosomes synthesize proteins<br>- D: Golgi packages proteins"`
        : `"Which organelle is the powerhouse of the cell?\n\nA) Nucleus\nB) Mitochondria\nC) Ribosome\nD) Golgi apparatus","**B) Mitochondria** — produces ATP via cellular respiration.\n\n- A: Nucleus stores genetic material\n- C: Ribosomes synthesize proteins\n- D: Golgi packages proteins"`;

    return `<card_style>
Generate MULTIPLE CHOICE flashcards. ${lineBreakNote}

- Question text, blank line, then 4 options A) B) C) D)
- Plausible distractors, ONE correct answer
- Answer: bold correct option, brief explanation, optional **Tip:**
- Vary which letter is correct across cards

EXAMPLE:
${example}
</card_style>`;
}

/**
 * Build the complete prompt for flashcard generation (text-based workflows)
 */
export function buildFlashcardPrompt(
    content: string,
    format: FlashcardFormat,
    additionalContext?: string,
    language?: string,
    style: FlashcardStyle = 'standard'
): string {
    let prompt = format.prompt;

    // Add style-specific instructions (format-aware: only shows relevant example)
    prompt += `\n\n${getStyleInstructions(style, format.id)}`;

    // Add language instruction if specified
    if (language && language !== 'auto' && language !== '') {
        prompt += `\n\n<language>
Generate all flashcard content in ${language}. Both questions and answers must be in this language.
</language>`;
    }

    // Add additional context if provided
    if (additionalContext && additionalContext.trim()) {
        prompt += `\n\n<additional_context>
${additionalContext.trim()}
</additional_context>`;
    }

    // Add the content to process
    prompt += `\n\n<content_to_process>
${content}
</content_to_process>`;

    return prompt;
}

/**
 * Build the vision prompt for screenshot-based MC answering (Workflow A).
 * This is a multimodal prompt — the image is sent separately as a ContentPart.
 */
export function buildScreenshotFlashcardPrompt(
    format: FlashcardFormat,
    language?: string,
    additionalContext?: string
): string {
    const isAnki = format.id === 'anki';
    const lineBreakInstr = isAnki
        ? 'Use <br> tags for line breaks within CSV fields (Anki convention).'
        : 'Use REAL line breaks inside quoted CSV fields (Brainscape convention).';

    const mathInstr = isAnki
        ? `Use MathJax notation for math: \\\\( inline \\\\) and \\\\[ display \\\\].
DO NOT use $ delimiters.`
        : `Use Unicode math symbols directly (², √, π, Σ, ≤, ≥, →, etc.) — NEVER LaTeX.

${UNICODE_MATH_TABLE}`;

    let prompt = `You are an expert at transcribing and answering multiple choice exam questions.

<task>
Look at the image carefully. It contains one or more multiple choice questions.
For EACH question in the image:
1. Transcribe the question text EXACTLY as written (preserve original wording)
2. Transcribe ALL answer options (A, B, C, D) in full
3. Determine the correct answer
4. Provide a clear explanation and study tip

Output a CSV file with one row per question.
</task>

<csv_format>
- Two columns: Question (front) and Answer (back)
- Use standard CSV quoting: wrap fields containing commas, quotes, or newlines in double quotes
- Escape double quotes by doubling them: " becomes ""
- NO header row
- UTF-8 encoding
- ${lineBreakInstr}
</csv_format>

<front_card_format>
Transcribe the question followed by all options on separate lines:
- Preserve the EXACT question text from the image
- List all options as A), B), C), D) on new lines
- Do NOT paraphrase or reword — copy precisely
- If text is partially illegible, transcribe what you can and mark unclear parts with [?]
</front_card_format>

<back_card_format>
- First line: Bold the correct answer — e.g., **B) The correct answer text**
- Blank line
- "Explanation:" section:
  - Why the correct answer is right (brief, clear)
  - Why each wrong option is incorrect (one line each)
- Optional: **Tip:** a memory aid, mnemonic, or exam strategy
</back_card_format>

<math_handling>
${mathInstr}
</math_handling>`;

    // Add language instruction
    if (language && language !== 'auto' && language !== '') {
        prompt += `\n\n<language>
Generate all answer explanations and tips in ${language}. Transcribe the original questions as-is from the image.
</language>`;
    }

    // Add additional context
    if (additionalContext?.trim()) {
        prompt += `\n\n<additional_context>
${additionalContext.trim()}
</additional_context>`;
    }

    prompt += `\n\nOutput ONLY the CSV content, no explanations or markdown code blocks.`;

    return prompt;
}

/**
 * Validate CSV output from LLM
 * Returns { valid: boolean, errors: string[], cardCount: number }
 */
export function validateFlashcardCSV(csv: string): {
    valid: boolean;
    errors: string[];
    cardCount: number;
    cards: Array<{ question: string; answer: string }>;
} {
    const errors: string[] = [];
    const cards: Array<{ question: string; answer: string }> = [];

    if (!csv || !csv.trim()) {
        return { valid: false, errors: ['Empty CSV output'], cardCount: 0, cards: [] };
    }

    // Parse CSV - handle quoted fields properly
    const lines = parseCSVLines(csv.trim());

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (!line.trim()) continue; // Skip empty lines

        const fields = parseCSVLine(line);

        if (fields.length < 2) {
            errors.push(`Line ${i + 1}: Expected 2 columns, got ${fields.length}`);
            continue;
        }

        const question = fields[0].trim();
        const answer = fields[1].trim();

        if (!question) {
            errors.push(`Line ${i + 1}: Empty question`);
            continue;
        }

        if (!answer) {
            errors.push(`Line ${i + 1}: Empty answer`);
            continue;
        }

        cards.push({ question, answer });
    }

    if (cards.length === 0) {
        errors.push('No valid flashcards found in output');
    }

    return {
        valid: errors.length === 0,
        errors,
        cardCount: cards.length,
        cards
    };
}

/**
 * Parse CSV into lines, handling multi-line quoted fields
 */
function parseCSVLines(csv: string): string[] {
    const lines: string[] = [];
    let currentLine = '';
    let inQuotes = false;

    for (let i = 0; i < csv.length; i++) {
        const char = csv[i];

        if (char === '"') {
            // Check for escaped quote
            if (csv[i + 1] === '"') {
                currentLine += '""';
                i++; // Skip next quote
            } else {
                inQuotes = !inQuotes;
                currentLine += char;
            }
        } else if (char === '\n' && !inQuotes) {
            if (currentLine.trim()) {
                lines.push(currentLine);
            }
            currentLine = '';
        } else if (char === '\r') {
            // Skip carriage returns
        } else {
            currentLine += char;
        }
    }

    // Don't forget the last line
    if (currentLine.trim()) {
        lines.push(currentLine);
    }

    return lines;
}

/**
 * Parse a single CSV line into fields
 */
function parseCSVLine(line: string): string[] {
    const fields: string[] = [];
    let currentField = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (char === '"') {
            if (inQuotes && line[i + 1] === '"') {
                // Escaped quote
                currentField += '"';
                i++; // Skip next quote
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            fields.push(currentField);
            currentField = '';
        } else {
            currentField += char;
        }
    }

    // Add the last field
    fields.push(currentField);

    return fields;
}

/**
 * Convert cards array back to CSV string
 */
export function cardsToCSV(cards: Array<{ question: string; answer: string }>): string {
    return cards.map(card => {
        const q = escapeCSVField(card.question);
        const a = escapeCSVField(card.answer);
        return `${q},${a}`;
    }).join('\n');
}

/**
 * Escape a field for CSV output
 */
function escapeCSVField(field: string): string {
    // If field contains comma, quote, or newline, wrap in quotes
    if (field.includes(',') || field.includes('"') || field.includes('\n')) {
        // Escape internal quotes by doubling them
        const escaped = field.replace(/"/g, '""');
        return `"${escaped}"`;
    }
    return field;
}
