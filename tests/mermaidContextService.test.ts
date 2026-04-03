/**
 * MermaidContextService Tests
 *
 * Tests for the context-gathering service used by Mermaid chat.
 * Covers:
 *  - Budget constants correctness
 *  - gatherSiblingDiagrams pure logic (no mocks needed)
 *  - gatherContext integration paths with mocked App / Plugin
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('obsidian', () => {
    class TFile {
        path: string;
        basename: string;
        constructor(path = 'note.md') {
            this.path = path;
            this.basename = path.replace(/\.md$/, '');
        }
    }
    return { TFile };
});

vi.mock('../src/services/tokenLimits', () => ({
    getMaxContentCharsForModel: vi.fn(() => 20_000),
}));

vi.mock('../src/services/ragService', () => ({
    RAGService: vi.fn().mockImplementation(() => ({
        retrieveContext: vi.fn().mockResolvedValue({ formattedContext: 'RAG chunk result', sources: [] }),
    })),
}));

import { TFile } from 'obsidian';
import {
    MermaidContextService,
    BUDGET_NOTE_PCT,
    BUDGET_SIBLING_PCT,
    BUDGET_BACKLINK_PCT,
    BUDGET_RAG_PCT,
    PROMPT_OVERHEAD_CHARS,
    GatheredContext,
} from '../src/services/mermaidContextService';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeFile(path = 'notes/test.md'): TFile {
    const f = new TFile();
    f.path = path;
    f.basename = path.replace(/^.*\//, '').replace(/\.md$/, '');
    return f;
}

/** Build a markdown string that contains one or more mermaid code fences. */
function mdWithMermaid(...blocks: string[]): string {
    return blocks.map(b => '```mermaid\n' + b + '\n```').join('\n\nSome text\n\n');
}

/** Minimal mock of AIOrganiserPlugin for gatherContext tests. */
function makeMockPlugin(overrides: Record<string, unknown> = {}): any {
    return {
        settings: {
            serviceType: 'cloud',
            cloudServiceType: 'openai',
            cloudModel: 'gpt-4o',
            localModel: '',
            mermaidChatIncludeNoteContext: false,
            mermaidChatIncludeBacklinks: false,
            mermaidChatIncludeRAG: false,
            mermaidChatRAGChunks: 3,
            ...overrides,
        },
        vectorStore: null,
        embeddingService: null,
    };
}

/** Minimal mock of Obsidian App. */
function makeMockApp(noteContent = '', resolvedLinks: Record<string, Record<string, number>> = {}): any {
    return {
        vault: {
            cachedRead: vi.fn().mockResolvedValue(noteContent),
            getAbstractFileByPath: vi.fn((p: string) => {
                const f = makeFile(p);
                // Make it pass `instanceof TFile`
                Object.setPrototypeOf(f, TFile.prototype);
                return f;
            }),
        },
        metadataCache: {
            resolvedLinks,
        },
    };
}

// ── Budget Constants ────────────────────────────────────────────────────────

describe('Budget constants', () => {
    it('BUDGET_NOTE_PCT is 0.40', () => {
        expect(BUDGET_NOTE_PCT).toBe(0.40);
    });

    it('BUDGET_SIBLING_PCT is 0.15', () => {
        expect(BUDGET_SIBLING_PCT).toBe(0.15);
    });

    it('BUDGET_BACKLINK_PCT is 0.25', () => {
        expect(BUDGET_BACKLINK_PCT).toBe(0.25);
    });

    it('BUDGET_RAG_PCT is 0.20', () => {
        expect(BUDGET_RAG_PCT).toBe(0.20);
    });

    it('PROMPT_OVERHEAD_CHARS is 2000', () => {
        expect(PROMPT_OVERHEAD_CHARS).toBe(2000);
    });

    it('budget percentages sum to 1.0', () => {
        const sum = BUDGET_NOTE_PCT + BUDGET_SIBLING_PCT + BUDGET_BACKLINK_PCT + BUDGET_RAG_PCT;
        expect(sum).toBeCloseTo(1.0, 10);
    });
});

// ── gatherSiblingDiagrams (pure logic, no mocks) ───────────────────────────

describe('gatherSiblingDiagrams', () => {
    let service: MermaidContextService;

    beforeEach(() => {
        service = new MermaidContextService(makeMockApp(), makeMockPlugin());
    });

    it('returns labels from sibling blocks, excluding the current block', () => {
        const current = 'flowchart TD\n  A[Start] --> B[End]';
        const sibling = 'flowchart LR\n  X[Alpha] --> Y[Beta]';
        const content = mdWithMermaid(current, sibling);

        const labels = service.gatherSiblingDiagrams(content, current);

        expect(labels).toContain('Alpha');
        expect(labels).toContain('Beta');
        // Should NOT include labels from the current block
        expect(labels).not.toContain('Start');
        expect(labels).not.toContain('End');
    });

    it('returns empty when the only block is the current one', () => {
        const current = 'flowchart TD\n  A[Only] --> B[Block]';
        const content = mdWithMermaid(current);

        const labels = service.gatherSiblingDiagrams(content, current);

        expect(labels).toHaveLength(0);
    });

    it('returns empty when there are no mermaid blocks', () => {
        const content = '# Just a heading\n\nSome paragraph text.';

        const labels = service.gatherSiblingDiagrams(content, 'flowchart TD\n  A --> B');

        expect(labels).toHaveLength(0);
    });

    it('deduplicates labels across multiple siblings', () => {
        const current = 'flowchart TD\n  Z[Current]';
        const siblingA = 'flowchart TD\n  A[Shared] --> B[UniqueA]';
        const siblingB = 'flowchart LR\n  C[Shared] --> D[UniqueB]';
        const content = mdWithMermaid(current, siblingA, siblingB);

        const labels = service.gatherSiblingDiagrams(content, current);

        const sharedCount = labels.filter(l => l === 'Shared').length;
        expect(sharedCount).toBe(1);
        expect(labels).toContain('UniqueA');
        expect(labels).toContain('UniqueB');
    });
});

// ── gatherContext (mock-based integration) ──────────────────────────────────

describe('gatherContext', () => {
    it('returns empty strings when all context sources are disabled', async () => {
        const app = makeMockApp('# Heading\n\nSome text');
        const plugin = makeMockPlugin({
            mermaidChatIncludeNoteContext: false,
            mermaidChatIncludeBacklinks: false,
            mermaidChatIncludeRAG: false,
        });
        const service = new MermaidContextService(app, plugin);
        const file = makeFile();
        Object.setPrototypeOf(file, TFile.prototype);

        const ctx = await service.gatherContext(file, 'flowchart TD\n  A --> B');

        expect(ctx.noteContext).toBe('');
        expect(ctx.siblingDiagrams).toEqual([]);
        expect(ctx.backlinkContext).toBe('');
        expect(ctx.ragContext).toBe('');
    });

    it('includes backlink titles when backlinks are enabled', async () => {
        const file = makeFile('notes/target.md');
        Object.setPrototypeOf(file, TFile.prototype);

        const resolvedLinks: Record<string, Record<string, number>> = {
            'notes/linker-a.md': { 'notes/target.md': 1 },
            'notes/linker-b.md': { 'notes/target.md': 2 },
            'notes/unrelated.md': { 'notes/other.md': 1 },
        };

        const app = makeMockApp('Some content', resolvedLinks);
        const plugin = makeMockPlugin({ mermaidChatIncludeBacklinks: true });
        const service = new MermaidContextService(app, plugin);

        const ctx = await service.gatherContext(file, 'flowchart TD\n  A --> B');

        expect(ctx.backlinkContext).toContain('linker-a');
        expect(ctx.backlinkContext).toContain('linker-b');
        expect(ctx.backlinkContext).not.toContain('unrelated');
    });

    it('includes sibling labels when note context is enabled and siblings exist', async () => {
        const current = 'flowchart TD\n  A[Start] --> B[End]';
        const sibling = 'flowchart LR\n  X[Foo] --> Y[Bar]';
        const content = mdWithMermaid(current, sibling);

        const app = makeMockApp(content);
        const plugin = makeMockPlugin({ mermaidChatIncludeNoteContext: true });
        const service = new MermaidContextService(app, plugin);
        const file = makeFile();
        Object.setPrototypeOf(file, TFile.prototype);

        const ctx = await service.gatherContext(file, current);

        expect(ctx.siblingDiagrams).toContain('Foo');
        expect(ctx.siblingDiagrams).toContain('Bar');
    });

    it('returns empty RAG context when vectorStore is null', async () => {
        const app = makeMockApp('Some content');
        const plugin = makeMockPlugin({
            mermaidChatIncludeRAG: true,
            // vectorStore and embeddingService remain null
        });
        const service = new MermaidContextService(app, plugin);
        const file = makeFile();
        Object.setPrototypeOf(file, TFile.prototype);

        const ctx = await service.gatherContext(file, 'flowchart TD\n  A --> B');

        expect(ctx.ragContext).toBe('');
    });

    it('handles vault read errors gracefully', async () => {
        const app = makeMockApp('');
        app.vault.cachedRead = vi.fn().mockRejectedValue(new Error('File not found'));
        const plugin = makeMockPlugin({ mermaidChatIncludeNoteContext: true });
        const service = new MermaidContextService(app, plugin);
        const file = makeFile();
        Object.setPrototypeOf(file, TFile.prototype);

        // gatherContext propagates the error from cachedRead (it does not catch it)
        await expect(service.gatherContext(file, 'flowchart TD\n  A --> B'))
            .rejects.toThrow('File not found');
    });
});
