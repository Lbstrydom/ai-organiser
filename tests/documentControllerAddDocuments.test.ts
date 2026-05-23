/**
 * Unit tests for DocumentHandlingController.addDocuments (plan F4 batch add).
 *
 * Coverage:
 *   - Adds previously-unseen items
 *   - Deduplicates against the controller's existing list (by id)
 *   - Preserves ordering — returns one AddResult per input item
 *   - Returns empty array when called with []
 */

vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return mod;
});

import { App } from 'obsidian';
import { DocumentHandlingController, type DocumentItem } from '../src/ui/controllers/DocumentHandlingController';

function makeApp(): App {
    return {
        vault: {},
        workspace: {
            getActiveFile: () => null,
        },
        metadataCache: {},
    } as unknown as App;
}

function makeItem(id: string, name: string): DocumentItem {
    return {
        id,
        name,
        path: id,
        isExternal: false,
        truncationChoice: 'truncate',
        charCount: 0,
        isProcessing: false,
    };
}

function makeController(): DocumentHandlingController {
    const plugin = { settings: {}, t: { minutes: {} } } as never;
    const docService = { extractText: vi.fn() } as never;
    return new DocumentHandlingController(makeApp(), plugin, docService);
}

describe('DocumentHandlingController.addDocuments', () => {
    it('adds previously-unseen items and reports added=true for each', () => {
        const c = makeController();
        const results = c.addDocuments([makeItem('a', 'Alpha'), makeItem('b', 'Beta')]);
        expect(results.map((r) => r.added)).toEqual([true, true]);
        expect(c.getDocuments().map((d) => d.id)).toEqual(['a', 'b']);
    });

    it('deduplicates against the existing list by id', () => {
        const c = makeController();
        c.addDocuments([makeItem('a', 'Alpha')]);
        const results = c.addDocuments([makeItem('a', 'Alpha'), makeItem('b', 'Beta')]);
        expect(results[0]).toEqual({ added: false, duplicate: true, error: 'Document already added' });
        expect(results[1].added).toBe(true);
        expect(c.getDocuments().map((d) => d.id)).toEqual(['a', 'b']);
    });

    it('handles empty input gracefully', () => {
        const c = makeController();
        const results = c.addDocuments([]);
        expect(results).toEqual([]);
        expect(c.getDocuments()).toEqual([]);
    });

    it('preserves input order in results', () => {
        const c = makeController();
        c.addDocuments([makeItem('a', 'Alpha')]);
        const results = c.addDocuments([
            makeItem('b', 'Beta'),
            makeItem('a', 'Alpha'),  // duplicate at index 1
            makeItem('c', 'Charlie'),
        ]);
        expect(results.map((r) => r.added)).toEqual([true, false, true]);
        expect(results[1].duplicate).toBe(true);
    });
});
