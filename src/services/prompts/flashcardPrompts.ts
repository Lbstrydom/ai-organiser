/**
 * Flashcard Generation Prompts
 *
 * Prompts for generating flashcards from note content.
 * Supports multiple output formats (Anki, Brainscape) with proper math notation handling.
 * Supports both standard Q&A and multiple choice card styles.
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
- Use standard CSV quoting: wrap fields containing commas, quotes, or newlines in double quotes
- Escape double quotes by doubling them: " becomes ""
- Each card on its own line
- NO header row - Anki imports raw Q,A pairs
- UTF-8 encoding
- Use <br> for line breaks within a field (Anki renders these as newlines)
</csv_format>

<math_notation>
CRITICAL: For any mathematical expressions, use MathJax notation that Anki supports:
- Inline math: \\( expression \\)
- Display/block math: \\[ expression \\]

Examples:
- Quadratic formula: \\( x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a} \\)
- Euler's identity: \\( e^{i\\pi} + 1 = 0 \\)
- Integral: \\[ \\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2} \\]

DO NOT use $ delimiters - Anki requires \\( \\) and \\[ \\] notation.
</math_notation>

<card_quality_rules>
1. ONE concept per card - atomic knowledge units
2. Questions should be specific and unambiguous
3. Answers should be concise but complete
4. Avoid yes/no questions - prefer "what", "how", "why", "when"
5. For definitions: Ask for the term given the definition, AND the definition given the term
6. For processes: Break into sequential steps, each step a separate card
7. For comparisons: Create cards for similarities AND differences
8. Include context clues if the term is ambiguous
9. Use cloze-style phrasing where appropriate: "The ___ is responsible for..."
</card_quality_rules>

<output_requirements>
- Generate 5-20 cards depending on content density
- Quality over quantity - skip trivial facts
- Ensure mathematical expressions are properly formatted with MathJax
- Test that CSV is valid (proper quoting, no unescaped special chars)
</output_requirements>

Output ONLY the CSV content, no explanations or markdown code blocks.`
};

/**
 * Brainscape format - plain text only, no LaTeX support
 */
export const BRAINSCAPE_FORMAT: FlashcardFormat = {
    id: 'brainscape',
    name: 'Brainscape',
    description: 'CSV format for Brainscape (plain text, no math symbols)',
    fileExtension: 'csv',
    mathSupport: 'plain',
    prompt: `You are an expert at creating high-quality flashcards for spaced repetition learning.

<task>
Generate flashcards from the provided content. Output a CSV file that can be imported into Brainscape.
</task>

<csv_format>
- Two columns: Question (front) and Answer (back)
- Use standard CSV quoting: wrap fields containing commas, quotes, or newlines in double quotes
- Escape double quotes by doubling them: " becomes ""
- Each card on its own line
- NO header row
- UTF-8 encoding
</csv_format>

<math_handling>
IMPORTANT: Brainscape does NOT support LaTeX or MathJax rendering.
For mathematical content, you MUST:
1. Write equations in plain text using words and basic symbols
2. Use ^ for exponents: x^2 means "x squared"
3. Use / for fractions: a/b means "a divided by b"
4. Spell out Greek letters: "pi", "theta", "sigma"
5. Use words for operations: "square root of", "integral of", "sum of"

Examples:
- Instead of: x = (-b ± √(b²-4ac)) / 2a
- Write: "x equals negative b plus or minus the square root of (b squared minus 4ac), all divided by 2a"

- Instead of: e^(iπ) + 1 = 0
- Write: "e to the power of (i times pi) plus 1 equals 0"

- Instead of: ∫₀^∞ e^(-x²) dx
- Write: "the integral from 0 to infinity of e to the negative x squared"
</math_handling>

<card_quality_rules>
1. ONE concept per card - atomic knowledge units
2. Questions should be specific and unambiguous
3. Answers should be concise but complete
4. Avoid yes/no questions - prefer "what", "how", "why", "when"
5. For definitions: Ask for the term given the definition, AND the definition given the term
6. For processes: Break into sequential steps, each step a separate card
7. For comparisons: Create cards for similarities AND differences
8. Include context clues if the term is ambiguous
</card_quality_rules>

<output_requirements>
- Generate 5-20 cards depending on content density
- Quality over quantity - skip trivial facts
- Ensure all math is written in plain readable text
- Test that CSV is valid (proper quoting, no unescaped special chars)
</output_requirements>

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
 * Style-specific instructions to append to the base prompt
 */
const STYLE_INSTRUCTIONS: Record<FlashcardStyle, string> = {
    'standard': `<card_style>
Generate STANDARD Q&A flashcards:
- Front: A clear, focused question
- Back: A concise, complete answer
- One concept per card
</card_style>`,

    'multiple-choice': `<card_style>
Generate MULTIPLE CHOICE flashcards for exam preparation:

FRONT CARD FORMAT (Question side):
- Start with the question text
- Then list exactly 4 options labeled A), B), C), D) - each on a new line
- Use <br> tags for line breaks in CSV
- Make distractors plausible but clearly wrong to someone who knows the material
- Only ONE option should be correct

BACK CARD FORMAT (Answer side):
- First line: The correct answer letter and text (e.g., "B) Mitochondria")
- Then a blank line
- Then "Explanation:" followed by:
  - Why the correct answer is right
  - Brief explanation of why each wrong option is incorrect

EXAMPLE CARD:
Front: "Which organelle is known as the powerhouse of the cell?<br>A) Nucleus<br>B) Mitochondria<br>C) Ribosome<br>D) Golgi apparatus"
Back: "B) Mitochondria<br><br>Explanation:<br>- B is correct: Mitochondria produce ATP through cellular respiration<br>- A is wrong: The nucleus contains genetic material but doesn't produce energy<br>- C is wrong: Ribosomes synthesize proteins<br>- D is wrong: Golgi apparatus packages and ships proteins"

IMPORTANT:
- Vary which letter (A, B, C, or D) is correct across cards
- Make all options similar in length and complexity
- Distractors should test common misconceptions
</card_style>`
};

/**
 * Build the complete prompt for flashcard generation
 */
export function buildFlashcardPrompt(
    content: string,
    format: FlashcardFormat,
    additionalContext?: string,
    language?: string,
    style: FlashcardStyle = 'standard'
): string {
    let prompt = format.prompt;

    // Add style-specific instructions
    prompt += `\n\n${STYLE_INSTRUCTIONS[style]}`;

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
