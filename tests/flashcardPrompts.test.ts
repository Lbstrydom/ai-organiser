/**
 * Flashcard Prompts — Unit Tests
 * Tests prompt invariants, CSV parsing, and source/format configurations.
 */
import {
    FLASHCARD_SOURCES,
    FLASHCARD_STYLES,
    FLASHCARD_FORMATS,
    UNICODE_MATH_TABLE,
    ANKI_FORMAT,
    BRAINSCAPE_FORMAT,
    buildFlashcardPrompt,
    buildScreenshotFlashcardPrompt,
    validateFlashcardCSV,
    cardsToCSV,
    getFlashcardFormat
} from '../src/services/prompts/flashcardPrompts';

// ─── Source / format / style constants ──────────────────────────────

describe('FLASHCARD_SOURCES', () => {
    it('should have 3 sources', () => {
        expect(FLASHCARD_SOURCES).toHaveLength(3);
    });

    it('should have current-note, multiple-notes, and screenshot', () => {
        const ids = FLASHCARD_SOURCES.map(s => s.id);
        expect(ids).toContain('current-note');
        expect(ids).toContain('multiple-notes');
        expect(ids).toContain('screenshot');
    });

    it('should mark screenshot as requiresVision', () => {
        const screenshot = FLASHCARD_SOURCES.find(s => s.id === 'screenshot');
        expect(screenshot?.requiresVision).toBe(true);
    });

    it('should NOT mark text sources as requiresVision', () => {
        const textSources = FLASHCARD_SOURCES.filter(s => s.id !== 'screenshot');
        for (const source of textSources) {
            expect(source.requiresVision).toBeFalsy();
        }
    });
});

describe('FLASHCARD_STYLES', () => {
    it('should have standard and multiple-choice', () => {
        const ids = FLASHCARD_STYLES.map(s => s.id);
        expect(ids).toContain('standard');
        expect(ids).toContain('multiple-choice');
    });
});

describe('FLASHCARD_FORMATS', () => {
    it('should have Anki and Brainscape', () => {
        const ids = FLASHCARD_FORMATS.map(f => f.id);
        expect(ids).toContain('anki');
        expect(ids).toContain('brainscape');
    });

    it('should use csv file extension for both', () => {
        for (const format of FLASHCARD_FORMATS) {
            expect(format.fileExtension).toBe('csv');
        }
    });

    it('getFlashcardFormat should return format by ID', () => {
        expect(getFlashcardFormat('anki')).toBe(ANKI_FORMAT);
        expect(getFlashcardFormat('brainscape')).toBe(BRAINSCAPE_FORMAT);
        expect(getFlashcardFormat('nonexistent')).toBeUndefined();
    });
});

// ─── Unicode math in Brainscape prompt ──────────────────────────────

describe('Brainscape Unicode math', () => {
    it('should contain Unicode superscripts', () => {
        expect(UNICODE_MATH_TABLE).toContain('²');
        expect(UNICODE_MATH_TABLE).toContain('³');
        expect(UNICODE_MATH_TABLE).toContain('ⁿ');
    });

    it('should contain Unicode operators', () => {
        expect(UNICODE_MATH_TABLE).toContain('≤');
        expect(UNICODE_MATH_TABLE).toContain('≥');
        expect(UNICODE_MATH_TABLE).toContain('≠');
        expect(UNICODE_MATH_TABLE).toContain('±');
        expect(UNICODE_MATH_TABLE).toContain('√');
        expect(UNICODE_MATH_TABLE).toContain('∞');
    });

    it('should contain Greek letters', () => {
        expect(UNICODE_MATH_TABLE).toContain('π');
        expect(UNICODE_MATH_TABLE).toContain('θ');
        expect(UNICODE_MATH_TABLE).toContain('σ');
        expect(UNICODE_MATH_TABLE).toContain('Σ');
    });

    it('should contain set symbols', () => {
        expect(UNICODE_MATH_TABLE).toContain('∈');
        expect(UNICODE_MATH_TABLE).toContain('∉');
        expect(UNICODE_MATH_TABLE).toContain('⊂');
        expect(UNICODE_MATH_TABLE).toContain('∅');
        expect(UNICODE_MATH_TABLE).toContain('∪');
        expect(UNICODE_MATH_TABLE).toContain('∩');
    });

    it('should contain arrows', () => {
        expect(UNICODE_MATH_TABLE).toContain('→');
        expect(UNICODE_MATH_TABLE).toContain('←');
        expect(UNICODE_MATH_TABLE).toContain('⇒');
        expect(UNICODE_MATH_TABLE).toContain('⇔');
    });

    it('BRAINSCAPE_FORMAT prompt should embed the Unicode table', () => {
        expect(BRAINSCAPE_FORMAT.prompt).toContain('²');
        expect(BRAINSCAPE_FORMAT.prompt).toContain('√');
        expect(BRAINSCAPE_FORMAT.prompt).toContain('Σ');
    });

    it('BRAINSCAPE_FORMAT should never mention LaTeX delimiters', () => {
        expect(BRAINSCAPE_FORMAT.prompt).not.toContain('\\(');
        expect(BRAINSCAPE_FORMAT.prompt).not.toContain('\\[');
        expect(BRAINSCAPE_FORMAT.prompt).toContain('NEVER use LaTeX');
    });
});

// ─── MathJax in Anki prompt ─────────────────────────────────────────

describe('Anki MathJax notation', () => {
    it('should contain MathJax inline delimiters', () => {
        expect(ANKI_FORMAT.prompt).toContain('\\\\(');
        expect(ANKI_FORMAT.prompt).toContain('\\\\)');
    });

    it('should contain MathJax display delimiters', () => {
        expect(ANKI_FORMAT.prompt).toContain('\\\\[');
        expect(ANKI_FORMAT.prompt).toContain('\\\\]');
    });

    it('should NOT contain Unicode math table', () => {
        // Anki uses MathJax, not Unicode
        expect(ANKI_FORMAT.prompt).not.toContain(UNICODE_MATH_TABLE);
    });

    it('should use <br> for line breaks', () => {
        expect(ANKI_FORMAT.prompt).toContain('<br>');
    });
});

// ─── buildFlashcardPrompt ───────────────────────────────────────────

describe('buildFlashcardPrompt', () => {
    it('should include format prompt and content', () => {
        const prompt = buildFlashcardPrompt('Test content', ANKI_FORMAT);
        expect(prompt).toContain('<task>');
        expect(prompt).toContain('<content_to_process>');
        expect(prompt).toContain('Test content');
    });

    it('should include standard style instructions by default', () => {
        const prompt = buildFlashcardPrompt('Content', ANKI_FORMAT);
        expect(prompt).toContain('<card_style>');
        expect(prompt).toContain('STANDARD Q&A');
    });

    it('should include multiple-choice style when specified', () => {
        const prompt = buildFlashcardPrompt('Content', ANKI_FORMAT, undefined, undefined, 'multiple-choice');
        expect(prompt).toContain('MULTIPLE CHOICE');
        expect(prompt).toContain('**B)');
    });

    it('should include language instruction when specified', () => {
        const prompt = buildFlashcardPrompt('Content', BRAINSCAPE_FORMAT, undefined, 'Chinese');
        expect(prompt).toContain('<language>');
        expect(prompt).toContain('Chinese');
    });

    it('should NOT include language instruction for auto', () => {
        const prompt = buildFlashcardPrompt('Content', ANKI_FORMAT, undefined, 'auto');
        expect(prompt).not.toContain('<language>');
    });

    it('should NOT include language instruction for empty string', () => {
        const prompt = buildFlashcardPrompt('Content', ANKI_FORMAT, undefined, '');
        expect(prompt).not.toContain('<language>');
    });

    it('should include additional context when provided', () => {
        const prompt = buildFlashcardPrompt('Content', ANKI_FORMAT, 'Focus on key formulas');
        expect(prompt).toContain('<additional_context>');
        expect(prompt).toContain('Focus on key formulas');
    });

    it('should NOT include additional context when empty', () => {
        const prompt = buildFlashcardPrompt('Content', ANKI_FORMAT, '  ');
        expect(prompt).not.toContain('<additional_context>');
    });
});

// ─── buildScreenshotFlashcardPrompt ─────────────────────────────────

describe('buildScreenshotFlashcardPrompt', () => {
    it('should include transcription task', () => {
        const prompt = buildScreenshotFlashcardPrompt(ANKI_FORMAT);
        expect(prompt).toContain('Transcribe the question text EXACTLY');
        expect(prompt).toContain('<front_card_format>');
        expect(prompt).toContain('<back_card_format>');
    });

    it('should include answer instructions', () => {
        const prompt = buildScreenshotFlashcardPrompt(BRAINSCAPE_FORMAT);
        expect(prompt).toContain('Bold the correct answer');
        expect(prompt).toContain('Explanation:');
        expect(prompt).toContain('**Tip:**');
    });

    it('should use <br> for Anki format', () => {
        const prompt = buildScreenshotFlashcardPrompt(ANKI_FORMAT);
        expect(prompt).toContain('<br>');
        expect(prompt).toContain('Anki convention');
    });

    it('should use real line breaks for Brainscape format', () => {
        const prompt = buildScreenshotFlashcardPrompt(BRAINSCAPE_FORMAT);
        expect(prompt).toContain('REAL line breaks');
        expect(prompt).toContain('Brainscape convention');
    });

    it('should use MathJax for Anki', () => {
        const prompt = buildScreenshotFlashcardPrompt(ANKI_FORMAT);
        expect(prompt).toContain('MathJax notation');
        expect(prompt).toContain('\\\\(');
    });

    it('should use Unicode math for Brainscape', () => {
        const prompt = buildScreenshotFlashcardPrompt(BRAINSCAPE_FORMAT);
        expect(prompt).toContain('Unicode math symbols');
        expect(prompt).toContain('²');
        expect(prompt).toContain('√');
    });

    it('should include language instruction when specified', () => {
        const prompt = buildScreenshotFlashcardPrompt(ANKI_FORMAT, 'Spanish');
        expect(prompt).toContain('<language>');
        expect(prompt).toContain('Spanish');
    });

    it('should include additional context when provided', () => {
        const prompt = buildScreenshotFlashcardPrompt(ANKI_FORMAT, undefined, 'Biology exam');
        expect(prompt).toContain('<additional_context>');
        expect(prompt).toContain('Biology exam');
    });

    it('should NOT include context when empty', () => {
        const prompt = buildScreenshotFlashcardPrompt(ANKI_FORMAT, undefined, '   ');
        expect(prompt).not.toContain('<additional_context>');
    });
});

// ─── CSV validation ─────────────────────────────────────────────────

describe('validateFlashcardCSV', () => {
    it('should validate simple 2-column CSV', () => {
        const csv = 'What is 1+1?,2\nWhat is 2+2?,4';
        const result = validateFlashcardCSV(csv);
        expect(result.valid).toBe(true);
        expect(result.cardCount).toBe(2);
        expect(result.errors).toHaveLength(0);
    });

    it('should handle quoted fields with commas', () => {
        const csv = '"What is A, B, or C?","It is A, definitely"';
        const result = validateFlashcardCSV(csv);
        expect(result.valid).toBe(true);
        expect(result.cardCount).toBe(1);
        expect(result.cards[0].question).toBe('What is A, B, or C?');
    });

    it('should handle quoted fields with real newlines', () => {
        const csv = '"Question with\nnewline","Answer with\nmultiple\nlines"';
        const result = validateFlashcardCSV(csv);
        expect(result.valid).toBe(true);
        expect(result.cardCount).toBe(1);
        expect(result.cards[0].answer).toContain('\n');
    });

    it('should handle escaped double quotes', () => {
        const csv = '"He said ""hello""","She said ""goodbye"""';
        const result = validateFlashcardCSV(csv);
        expect(result.valid).toBe(true);
        expect(result.cards[0].question).toBe('He said "hello"');
    });

    it('should reject empty CSV', () => {
        const result = validateFlashcardCSV('');
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('Empty CSV output');
    });

    it('should reject lines with fewer than 2 columns', () => {
        const csv = 'only one column\nQuestion,Answer';
        const result = validateFlashcardCSV(csv);
        expect(result.errors.some(e => e.includes('Expected 2 columns'))).toBe(true);
        // Still parses the valid card
        expect(result.cardCount).toBe(1);
    });

    it('should reject empty question', () => {
        const csv = ',Some answer';
        const result = validateFlashcardCSV(csv);
        expect(result.errors.some(e => e.includes('Empty question'))).toBe(true);
    });

    it('should reject empty answer', () => {
        const csv = 'Some question,';
        const result = validateFlashcardCSV(csv);
        expect(result.errors.some(e => e.includes('Empty answer'))).toBe(true);
    });
});

// ─── cardsToCSV round-trip ──────────────────────────────────────────

describe('cardsToCSV', () => {
    it('should serialize simple cards', () => {
        const cards = [
            { question: 'Q1', answer: 'A1' },
            { question: 'Q2', answer: 'A2' }
        ];
        const csv = cardsToCSV(cards);
        expect(csv).toBe('Q1,A1\nQ2,A2');
    });

    it('should escape fields with commas', () => {
        const cards = [{ question: 'A, B, C?', answer: 'A' }];
        const csv = cardsToCSV(cards);
        expect(csv).toBe('"A, B, C?",A');
    });

    it('should escape fields with double quotes', () => {
        const cards = [{ question: 'He said "hi"', answer: 'Yes' }];
        const csv = cardsToCSV(cards);
        expect(csv).toContain('""hi""');
    });

    it('should handle round-trip with newlines', () => {
        const original = [
            { question: 'Q with\nnewline', answer: 'A with\nmulti\nlines' }
        ];
        const csv = cardsToCSV(original);
        const parsed = validateFlashcardCSV(csv);
        expect(parsed.valid).toBe(true);
        expect(parsed.cardCount).toBe(1);
        expect(parsed.cards[0].question).toBe('Q with\nnewline');
        expect(parsed.cards[0].answer).toBe('A with\nmulti\nlines');
    });

    it('should handle round-trip with commas and quotes', () => {
        const original = [
            { question: 'What is "A, B"?', answer: '"A" and "B"' }
        ];
        const csv = cardsToCSV(original);
        const parsed = validateFlashcardCSV(csv);
        expect(parsed.valid).toBe(true);
        expect(parsed.cards[0].question).toBe('What is "A, B"?');
        expect(parsed.cards[0].answer).toBe('"A" and "B"');
    });
});
