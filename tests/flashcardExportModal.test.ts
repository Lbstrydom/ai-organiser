/**
 * Flashcard Export Modal — Validation Tests
 * Tests the pure validation function extracted from FlashcardExportModal.
 */
import { createTFile } from './mocks/obsidian';
import { validateFlashcardExportForm } from '../src/ui/modals/FlashcardExportModal';

describe('validateFlashcardExportForm', () => {
    // ─── current-note ───────────────────────────────────────────────

    describe('current-note source', () => {
        it('should be valid when active file exists', () => {
            const result = validateFlashcardExportForm({
                source: 'current-note',
                selectedNotes: [],
                imageFile: null,
                hasActiveFile: true,
                visionSupported: false
            });
            expect(result.valid).toBe(true);
            expect(result.errorCode).toBeUndefined();
        });

        it('should return noActiveFile when no active file', () => {
            const result = validateFlashcardExportForm({
                source: 'current-note',
                selectedNotes: [],
                imageFile: null,
                hasActiveFile: false,
                visionSupported: false
            });
            expect(result.valid).toBe(false);
            expect(result.errorCode).toBe('noActiveFile');
        });
    });

    // ─── multiple-notes ─────────────────────────────────────────────

    describe('multiple-notes source', () => {
        it('should be valid when at least one note selected', () => {
            const result = validateFlashcardExportForm({
                source: 'multiple-notes',
                selectedNotes: [createTFile('notes/test.md')],
                imageFile: null,
                hasActiveFile: false,
                visionSupported: false
            });
            expect(result.valid).toBe(true);
        });

        it('should be valid with multiple notes selected', () => {
            const result = validateFlashcardExportForm({
                source: 'multiple-notes',
                selectedNotes: [
                    createTFile('notes/a.md'),
                    createTFile('notes/b.md'),
                    createTFile('notes/c.md')
                ],
                imageFile: null,
                hasActiveFile: false,
                visionSupported: false
            });
            expect(result.valid).toBe(true);
        });

        it('should return noNotesSelected when no notes selected', () => {
            const result = validateFlashcardExportForm({
                source: 'multiple-notes',
                selectedNotes: [],
                imageFile: null,
                hasActiveFile: false,
                visionSupported: false
            });
            expect(result.valid).toBe(false);
            expect(result.errorCode).toBe('noNotesSelected');
        });
    });

    // ─── screenshot ─────────────────────────────────────────────────

    describe('screenshot source', () => {
        it('should be valid when image file set and vision supported', () => {
            const result = validateFlashcardExportForm({
                source: 'screenshot',
                selectedNotes: [],
                imageFile: createTFile('images/exam.png'),
                hasActiveFile: false,
                visionSupported: true
            });
            expect(result.valid).toBe(true);
        });

        it('should return noImageSelected when no image file', () => {
            const result = validateFlashcardExportForm({
                source: 'screenshot',
                selectedNotes: [],
                imageFile: null,
                hasActiveFile: false,
                visionSupported: true
            });
            expect(result.valid).toBe(false);
            expect(result.errorCode).toBe('noImageSelected');
        });

        it('should return visionUnsupported when vision not supported', () => {
            const result = validateFlashcardExportForm({
                source: 'screenshot',
                selectedNotes: [],
                imageFile: createTFile('images/exam.png'),
                hasActiveFile: false,
                visionSupported: false
            });
            expect(result.valid).toBe(false);
            expect(result.errorCode).toBe('visionUnsupported');
        });

        it('should check image before vision support', () => {
            // When both image and vision are missing, image check comes first
            const result = validateFlashcardExportForm({
                source: 'screenshot',
                selectedNotes: [],
                imageFile: null,
                hasActiveFile: false,
                visionSupported: false
            });
            expect(result.valid).toBe(false);
            expect(result.errorCode).toBe('noImageSelected');
        });
    });

    // ─── Cross-source independence ──────────────────────────────────

    describe('source independence', () => {
        it('current-note does not require selectedNotes or imageFile', () => {
            const result = validateFlashcardExportForm({
                source: 'current-note',
                selectedNotes: [],
                imageFile: null,
                hasActiveFile: true,
                visionSupported: false
            });
            expect(result.valid).toBe(true);
        });

        it('multiple-notes does not require active file or vision', () => {
            const result = validateFlashcardExportForm({
                source: 'multiple-notes',
                selectedNotes: [createTFile('notes/test.md')],
                imageFile: null,
                hasActiveFile: false,
                visionSupported: false
            });
            expect(result.valid).toBe(true);
        });

        it('screenshot does not require active file or selected notes', () => {
            const result = validateFlashcardExportForm({
                source: 'screenshot',
                selectedNotes: [],
                imageFile: createTFile('images/exam.png'),
                hasActiveFile: false,
                visionSupported: true
            });
            expect(result.valid).toBe(true);
        });
    });
});
