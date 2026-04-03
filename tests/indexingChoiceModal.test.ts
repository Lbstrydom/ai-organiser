/**
 * Tests for IndexingChoiceModal
 */
import { describe, it, expect } from 'vitest';
import { IndexingChoiceModal } from '../src/ui/modals/IndexingChoiceModal';
import { App } from './mocks/obsidian';
import type { Translations } from '../src/i18n/types';

function makeT(): Translations['modals']['unifiedChat'] {
    return {
        indexingTitle: '{name} is too large',
        indexingStats: '{charCount} chars — budget is {budget}',
        indexingDescription: 'Smart indexing description',
        indexingCreateProject: 'Create project',
        indexingIntoProject: 'Index into project',
        indexingTemporary: 'Temporary',
        indexingTruncate: 'Truncate',
        indexingNoEmbeddings: 'No embeddings available',
        indexingOpenSettings: 'Open Settings',
        indexingPillProgress: 'indexing... {percent}%',
        indexingPillIndexed: 'indexed, {count} chunks',
        indexingPillPartial: 'indexed, {actual}/{total} chunks',
        indexingPillFailed: 'index failed',
        indexingPillMobileCapped: 'Document capped at {max} chunks on mobile',
    } as unknown as Translations['modals']['unifiedChat'];
}

function makeModal(opts: {
    embeddingsAvailable?: boolean;
    isProjectActive?: boolean;
    charCount?: number;
    budget?: number;
} = {}): IndexingChoiceModal {
    return new IndexingChoiceModal(
        new App() as any,
        'large-doc.pdf',
        opts.charCount ?? 100_000,
        opts.budget ?? 20_000,
        opts.embeddingsAvailable ?? true,
        opts.isProjectActive ?? false,
        makeT(),
    );
}

/** Collect all text from a MockHTMLElement's subtree */
function collectText(el: any): string[] {
    const texts: string[] = [];
    if (el.textContent) texts.push(el.textContent);
    for (const child of el.children ?? []) {
        texts.push(...collectText(child));
    }
    return texts;
}

describe('IndexingChoiceModal', () => {
    describe('waitForChoice / default resolution', () => {
        it('resolves to truncate when closed without button click', async () => {
            const modal = makeModal();
            const promise = modal.waitForChoice();
            modal.onClose();
            expect(await promise).toBe('truncate');
        });

        it('single-flight: second onClose does not throw or deadlock', async () => {
            const modal = makeModal();
            const promise = modal.waitForChoice();
            modal.onClose();
            modal.onClose(); // idempotent
            expect(await promise).toBe('truncate');
        });

        it('resolved state prevents re-resolution on repeated closes', async () => {
            const modal = makeModal();
            const promise = modal.waitForChoice();
            modal.onClose();
            modal.onClose();
            modal.onClose();
            const choice = await promise;
            expect(['truncate', 'project', 'temporary', 'settings']).toContain(choice);
        });
    });

    describe('onOpen — DOM structure with embeddings available', () => {
        it('renders without throwing', () => {
            const modal = makeModal({ embeddingsAvailable: true });
            expect(() => modal.onOpen()).not.toThrow();
            modal.onClose();
        });

        it('includes stats text with char counts', () => {
            const modal = makeModal({ embeddingsAvailable: true, charCount: 50_000, budget: 10_000 });
            modal.onOpen();
            const texts = collectText(modal.contentEl);
            const statsText = texts.join(' ');
            expect(statsText).toContain('50,000');
            expect(statsText).toContain('10,000');
            modal.onClose();
        });

        it('shows Create project label when no active project', () => {
            const modal = makeModal({ embeddingsAvailable: true, isProjectActive: false });
            modal.onOpen();
            const texts = collectText(modal.contentEl);
            expect(texts.some(t => t.includes('Create project'))).toBe(true);
            modal.onClose();
        });

        it('shows Index into project label when project is active', () => {
            const modal = makeModal({ embeddingsAvailable: true, isProjectActive: true });
            modal.onOpen();
            const texts = collectText(modal.contentEl);
            expect(texts.some(t => t.includes('Index into project'))).toBe(true);
            modal.onClose();
        });

        it('includes Temporary option', () => {
            const modal = makeModal({ embeddingsAvailable: true });
            modal.onOpen();
            const texts = collectText(modal.contentEl);
            expect(texts.some(t => t.includes('Temporary'))).toBe(true);
            modal.onClose();
        });

        it('always includes Truncate option', () => {
            const modal = makeModal({ embeddingsAvailable: true });
            modal.onOpen();
            const texts = collectText(modal.contentEl);
            expect(texts.some(t => t.includes('Truncate'))).toBe(true);
            modal.onClose();
        });
    });

    describe('onOpen — DOM structure without embeddings', () => {
        it('renders without throwing', () => {
            const modal = makeModal({ embeddingsAvailable: false });
            expect(() => modal.onOpen()).not.toThrow();
            modal.onClose();
        });

        it('shows Open Settings option instead of project/temp buttons', () => {
            const modal = makeModal({ embeddingsAvailable: false });
            modal.onOpen();
            const texts = collectText(modal.contentEl);
            expect(texts.some(t => t.includes('Open Settings'))).toBe(true);
            expect(texts.some(t => t.includes('Create project') || t.includes('Temporary'))).toBe(false);
            modal.onClose();
        });

        it('still shows Truncate option', () => {
            const modal = makeModal({ embeddingsAvailable: false });
            modal.onOpen();
            const texts = collectText(modal.contentEl);
            expect(texts.some(t => t.includes('Truncate'))).toBe(true);
            modal.onClose();
        });
    });

    describe('onClose cleanup', () => {
        it('empties contentEl on close', () => {
            const modal = makeModal();
            modal.onOpen();
            expect(modal.contentEl.children.length).toBeGreaterThan(0);
            modal.onClose();
            expect(modal.contentEl.children.length).toBe(0);
        });
    });
});
