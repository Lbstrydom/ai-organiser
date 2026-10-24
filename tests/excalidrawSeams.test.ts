// @vitest-environment happy-dom
/**
 * Excalidraw drawings at the model-input seams: chat attachments (pick + re-extract), project
 * pinned notes and multi-source summarise. A drawing contributes its words only; one with no
 * words makes no provider call; a normal note passes through untouched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('obsidian', async () => await import('./mocks/obsidian'));

const picker = vi.hoisted(() => ({ onChoose: null as null | ((f: unknown) => void) }));
vi.mock('../src/ui/utils/filePickers', () => ({
    tryNativeFilePicker: vi.fn(async () => null),
    openVaultFilePicker: vi.fn((_app: unknown, opts: { onChoose: (f: unknown) => void }) => { picker.onChoose = opts.onChoose; }),
}));
vi.mock('../src/services/documentExtractionService', () => ({ DocumentExtractionService: class { constructor() {} } }));
vi.mock('../src/services/llmFacade', () => ({ summarizeText: vi.fn(), pluginContext: vi.fn() }));
vi.mock('../src/services/webContentService', () => ({ fetchArticle: vi.fn() }));
vi.mock('../src/utils/busyIndicator', () => ({ withBusyIndicator: (_p: unknown, fn: () => unknown) => fn() }));

import { App, createTFile } from './mocks/obsidian';
import { FreeChatModeHandler } from '../src/ui/chat/FreeChatModeHandler';
import { ProjectService } from '../src/services/chat/projectService';
import { MultiSourceOrchestrator } from '../src/services/multiSource/multiSourceOrchestrator';
import { drawingNote as drawing } from './helpers/excalidrawFixture';
import type { MultiSourceDeps, MultiSourceRunOptions } from '../src/services/multiSource/multiSourceTypes';


// ── Chat attachments ──────────────────────────────────────────────────────────

function chatCtx(): any {
    return {
        plugin: {
            settings: { serviceType: 'cloud', cloudServiceType: 'claude', interfaceLanguage: 'en' },
            t: { modals: { unifiedChat: { freeAttachExtractFailed: 'Could not read {name}' } } },
        },
        app: {}, fullPlugin: {}, options: {},
    };
}

function chatHarness(files: Record<string, string>) {
    const app = new App();
    app.vault.read = vi.fn(async (f: { path: string }) => files[f.path] ?? '');
    app.vault.getAbstractFileByPath = ((p: string) => (p in files ? createTFile(p) : null)) as never;
    const handler = new FreeChatModeHandler(app as never);
    const notify = vi.fn();
    return { notify, h: handler as any };
}

describe('chat attachments: vault note picker', () => {
    beforeEach(() => { picker.onChoose = null; });

    it('attaches a drawing as its words only', async () => {
        const { h, notify } = chatHarness({ 'Map.excalidraw.md': drawing() });
        h.openVaultFilePicker(chatCtx(), { notify });
        picker.onChoose!(createTFile('Map.excalidraw.md'));
        await vi.waitFor(() => expect(h.attachments).toHaveLength(1));
        expect(h.attachments[0].extractedText).toBe('Intake\nDecision');
        expect(h.attachments[0].extractedText).not.toContain('N4KAkARALgngDgUw');
    });

    it('refuses a drawing with no words through the existing empty-text notice', async () => {
        const { h, notify } = chatHarness({ 'Blank.excalidraw.md': drawing({ elements: [] }) });
        h.openVaultFilePicker(chatCtx(), { notify });
        picker.onChoose!(createTFile('Blank.excalidraw.md'));
        await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('Could not read Blank.excalidraw.md'));
        expect(h.attachments).toHaveLength(0);
    });

    it('attaches a normal note byte-for-byte', async () => {
        const body = '# Plan\n\nWe sketched it in Excalidraw.\n';
        const { h, notify } = chatHarness({ 'Plan.md': body });
        h.openVaultFilePicker(chatCtx(), { notify });
        picker.onChoose!(createTFile('Plan.md'));
        await vi.waitFor(() => expect(h.attachments).toHaveLength(1));
        expect(h.attachments[0].extractedText).toBe(body);
    });
});

describe('chat attachments: re-extract on resume', () => {
    it('re-reads a drawing as its words only', async () => {
        const { h } = chatHarness({ 'Map.excalidraw.md': drawing() });
        const att = { path: 'Map.excalidraw.md', name: 'Map.excalidraw.md', extractedText: '', included: true, charCount: 0, truncated: false, mtime: 0 };
        await h.tryReextractAttachment(att);
        expect(att.extractedText).toBe('Intake\nDecision');
        expect(att.charCount).toBe('Intake\nDecision'.length);
    });
});

// ── Project pinned notes ──────────────────────────────────────────────────────

describe('project pinned notes', () => {
    function pinned(files: Record<string, string>) {
        const app = new App();
        app.vault.read = vi.fn(async (f: { path: string }) => files[f.path] ?? '');
        app.metadataCache.getFirstLinkpathDest = (link: string) => (link in files ? createTFile(link) : null);
        return new ProjectService(app as never, {} as never);
    }
    const config = (pinnedFiles: string[]) => ({ pinnedFiles } as never);

    it('includes a drawing as its words and skips a drawing with none', async () => {
        const svc = pinned({ 'Map.excalidraw.md': drawing(), 'Blank.excalidraw.md': drawing({ elements: [] }), 'Plain.md': 'plain body' });
        const out = await svc.readPinnedFiles(config(['Map.excalidraw.md', 'Blank.excalidraw.md', 'Plain.md']), 10_000);
        expect(out).toBe('--- Map.excalidraw.md ---\nIntake\nDecision\n\n--- Plain.md ---\nplain body');
    });

    it('keeps an ordinary empty note exactly as before', async () => {
        const svc = pinned({ 'Empty.md': '' });
        expect(await svc.readPinnedFiles(config(['Empty.md']), 10_000)).toBe('--- Empty.md ---\n');
    });
});

// ── Multi-source summarise ────────────────────────────────────────────────────

describe('multi-source: current note', () => {
    const baseOpts: MultiSourceRunOptions = { personaPrompt: 'p', focusContext: undefined, currentFilePath: 'n.md', today: '2026-01-01' };

    function run(content: string) {
        const app = new App();
        app.vault.read = vi.fn(async () => content);
        const summarizeContent = vi.fn(async (c: string) => `S:${c}`);
        const deps = {
            app, plugin: { app, t: { messages: { summarizingNoteContent: 's' } }, settings: {} },
            summarizeContent, summarizePdf: vi.fn(), extractDocument: vi.fn(), notify: vi.fn(), onAudioCleanup: vi.fn(),
        } as unknown as MultiSourceDeps;
        const p = new MultiSourceOrchestrator(deps).run([{ kind: 'note', file: createTFile('n.md') }], baseOpts);
        return { p, summarizeContent };
    }

    it('summarises the words of a drawing, not the blob', async () => {
        const { p, summarizeContent } = run(drawing());
        await p;
        expect(summarizeContent.mock.calls[0][0]).toBe('Intake\nDecision');
    });

    it('makes no provider call for a drawing with no words', async () => {
        const { p, summarizeContent } = run(drawing({ elements: [] }));
        const r = await p;
        expect(summarizeContent).not.toHaveBeenCalled();
        expect(r.ok && r.value.items[0].processed.success).toBe(false);
    });

    it('summarises a normal note unchanged', async () => {
        const { p, summarizeContent } = run('plain body');
        await p;
        expect(summarizeContent.mock.calls[0][0]).toBe('plain body');
    });
});
