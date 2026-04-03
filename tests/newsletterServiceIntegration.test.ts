/**
 * Newsletter Service Integration Tests
 *
 * Covers: digest merge, deterministic filenames, mark-seen safety,
 * two-phase Gmail confirmation, auto-tag wiring, Bases metadata,
 * idempotent retries, and fetchAndProcess end-to-end.
 */

vi.mock('obsidian', () => ({
    normalizePath: (p: string) => p.replace(/\\/g, '/'),
    requestUrl: vi.fn(),
    TFile: class TFile { path = ''; },
}));

vi.mock('../src/utils/htmlToMarkdown', () => ({
    htmlToMarkdown: (html: string) => html.replace(/<[^>]+>/g, ''),
    cleanMarkdown: (md: string) => md.trim(),
    extractLinks: () => [],
}));

vi.mock('../src/services/tokenLimits', () => ({
    truncateAtBoundary: (text: string, max: number) => text.slice(0, max),
}));

vi.mock('../src/services/prompts/triagePrompts', () => ({
    buildTriagePrompt: () => 'prompt CONTENT_PLACEHOLDER',
    insertContentIntoTriagePrompt: (_p: string, content: string) => `triage: ${content}`,
}));

vi.mock('../src/services/llmFacade', () => ({
    summarizeText: vi.fn().mockResolvedValue({ success: true, content: 'AI triage summary' }),
    pluginContext: (p: any) => p,
}));

vi.mock('../src/utils/minutesUtils', () => ({
    sanitizeFileName: (name: string) => name.replace(/[\\/:*?"<>|]/g, '-'),
    ensureFolderExists: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/core/settings', () => ({
    getNewsletterOutputFullPath: () => 'AI-Organiser/Newsletter Inbox',
}));

vi.mock('../src/utils/frontmatterUtils', () => ({
    updateAIOMetadata: vi.fn().mockResolvedValue(true),
    createSummaryHook: (text: string) => text.slice(0, 280),
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requestUrl } from 'obsidian';
import { NewsletterService } from '../src/services/newsletter/newsletterService';
import type { RawNewsletter } from '../src/services/newsletter/newsletterTypes';
import { updateAIOMetadata } from '../src/utils/frontmatterUtils';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeRaw(overrides: Partial<RawNewsletter> = {}): RawNewsletter {
    return {
        id: 'msg-1',
        from: 'Morning Brew <morning@brew.com>',
        subject: 'Daily Update',
        date: '2026-03-17T10:00:00Z',
        body: '<h1>Hello</h1><p>Content</p>',
        plain: 'Hello\nContent',
        ...overrides,
    };
}

/** In-memory vault mock with file storage */
function createMockVault() {
    const files = new Map<string, { path: string; content: string }>();
    return {
        files,
        getAbstractFileByPath: (path: string) => files.get(path) ?? null,
        create: vi.fn(async (path: string, content: string) => {
            files.set(path, { path, content });
        }),
        modify: vi.fn(async (file: { path: string }, content: string) => {
            files.set(file.path, { path: file.path, content });
        }),
        cachedRead: vi.fn(async (file: { path: string }) => {
            return files.get(file.path)?.content ?? '';
        }),
        read: vi.fn(async (file: { path: string }) => {
            return files.get(file.path)?.content ?? '';
        }),
    };
}

function createMockPlugin(vault: ReturnType<typeof createMockVault>) {
    return {
        app: {
            vault,
            workspace: {},
            fileManager: { processFrontMatter: vi.fn() },
            metadataCache: { getFileCache: vi.fn().mockReturnValue(null) },
        },
        settings: {
            newsletterEnabled: true,
            newsletterScriptUrl: 'https://script.google.com/test',
            newsletterOutputFolder: 'Newsletter Inbox',
            newsletterAutoTag: false,
            enableStructuredMetadata: false,
            pluginFolder: 'AI-Organiser',
            debugMode: false,
            newsletterGmailLabel: 'Newsletters',
            newsletterFetchLimit: 20,
        },
        newsletterSeenIds: [] as string[],
        loadData: vi.fn().mockResolvedValue({}),
        saveData: vi.fn().mockResolvedValue(undefined),
        analyzeAndTagNote: vi.fn().mockResolvedValue({ success: true }),
    } as any;
}

/** Mock requestUrl: routes GET (returns emails) and POST (returns ok). */
function mockFetchResponse(emails: RawNewsletter[]) {
    (requestUrl as any).mockImplementation(async (opts: any) => {
        if (opts.method === 'POST') {
            return { status: 200, text: JSON.stringify({ ok: true }), json: { ok: true } };
        }
        const body = JSON.stringify(emails);
        return { status: 200, text: body, json: emails };
    });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('NewsletterService integration', () => {
    let vault: ReturnType<typeof createMockVault>;
    let plugin: ReturnType<typeof createMockPlugin>;
    let service: NewsletterService;

    beforeEach(() => {
        vi.clearAllMocks();
        vault = createMockVault();
        plugin = createMockPlugin(vault);
        service = new NewsletterService(plugin);
    });

    // ── Digest merge ─────────────────────────────────────────────────

    describe('digest merge (no duplicate frontmatter)', () => {
        it('creates a fresh digest on first fetch', async () => {
            mockFetchResponse([makeRaw()]);
            const result = await service.fetchAndProcess();

            expect(result.totalNew).toBe(1);
            const digestEntry = [...vault.files.entries()].find(([k]) => k.includes('Digest'));
            expect(digestEntry).toBeDefined();
            const digestContent = digestEntry![1].content;

            expect(digestContent.startsWith('---\n')).toBe(true);
            const fmEnd = digestContent.indexOf('\n---\n', 4);
            expect(fmEnd).toBeGreaterThan(0);
            expect(digestContent.indexOf('\n---\ntags:', fmEnd + 4)).toBe(-1);
            expect(digestContent).toContain('newsletter_count: 1');
        });

        it('merges into existing digest without duplicate frontmatter', async () => {
            mockFetchResponse([makeRaw({ id: 'msg-1', subject: 'First' })]);
            await service.fetchAndProcess();
            plugin.newsletterSeenIds = [];

            mockFetchResponse([makeRaw({ id: 'msg-2', from: 'The Hustle <hustle@co.com>', subject: 'Second' })]);
            const result = await service.fetchAndProcess();

            expect(result.totalNew).toBe(1);
            const digestEntry = [...vault.files.entries()].find(([k]) => k.includes('Digest'));
            const digestContent = digestEntry![1].content;

            const fmEnd = digestContent.indexOf('\n---\n', 4);
            expect(digestContent.indexOf('\n---\ntags:', fmEnd + 4)).toBe(-1);
            expect(digestContent).toContain('newsletter_count: 2');
            expect(digestContent).toContain('Morning Brew');
            expect(digestContent).toContain('The Hustle');
        });

        it('preserves existing entries when merging', async () => {
            mockFetchResponse([makeRaw({ id: 'msg-1' })]);
            await service.fetchAndProcess();
            plugin.newsletterSeenIds = [];

            mockFetchResponse([makeRaw({ id: 'msg-2', from: 'Other <other@co.com>', subject: 'Other' })]);
            await service.fetchAndProcess();

            const digestEntry = [...vault.files.entries()].find(([k]) => k.includes('Digest'));
            const digestContent = digestEntry![1].content;
            expect(digestContent).toContain('Morning Brew');
            expect(digestContent).toContain('Read full');
        });
    });

    // ── Deterministic filenames ──────────────────────────────────────

    describe('deterministic filenames (per-message hash)', () => {
        it('same-sender different-message gets unique deterministic paths', async () => {
            mockFetchResponse([
                makeRaw({ id: 'msg-1', subject: 'Issue #1' }),
                makeRaw({ id: 'msg-2', subject: 'Issue #2' }),
            ]);
            const result = await service.fetchAndProcess();
            expect(result.totalNew).toBe(2);

            const paths = [...vault.files.keys()].filter(k =>
                k.includes('Morning Brew') && !k.includes('Digest'));
            expect(paths.length).toBe(2);
            // Both contain a hash suffix, not -2
            expect(paths.every(p => /Morning Brew-[a-z0-9]+\.md$/.test(p))).toBe(true);
            expect(new Set(paths).size).toBe(2); // distinct
        });

        it('digest links match deterministic filenames', async () => {
            mockFetchResponse([
                makeRaw({ id: 'msg-1', subject: 'Issue #1' }),
                makeRaw({ id: 'msg-2', subject: 'Issue #2' }),
            ]);
            await service.fetchAndProcess();

            const digestEntry = [...vault.files.entries()].find(([k]) => k.includes('Digest'));
            const digestContent = digestEntry![1].content;
            const readFullLinks = digestContent.match(/\[\[.*?\|Read full\]\]/g) || [];
            expect(readFullLinks.length).toBe(2);
            expect(new Set(readFullLinks).size).toBe(2);
        });

        it('retry of same message targets the same file (idempotent)', async () => {
            mockFetchResponse([makeRaw({ id: 'msg-1' })]);
            await service.fetchAndProcess();

            const notesBefore = [...vault.files.keys()].filter(k =>
                k.includes('Morning Brew') && !k.includes('Digest'));
            expect(notesBefore.length).toBe(1);

            // Simulate retry: reset seen IDs so same message comes through again
            plugin.newsletterSeenIds = [];
            mockFetchResponse([makeRaw({ id: 'msg-1' })]);
            await service.fetchAndProcess();

            // Should NOT create a -2 duplicate — same deterministic path, skipped
            const notesAfter = [...vault.files.keys()].filter(k =>
                k.includes('Morning Brew') && !k.includes('Digest'));
            expect(notesAfter.length).toBe(1);
            expect(notesAfter[0]).toBe(notesBefore[0]);
        });

        it('mid-batch failure does not create duplicates on retry', async () => {
            // First run: two messages, second note write fails
            const createCalls = { count: 0 };
            vault.create.mockImplementation(async (path: string, content: string) => {
                createCalls.count++;
                if (createCalls.count === 2) throw new Error('Disk full');
                vault.files.set(path, { path, content });
            });

            mockFetchResponse([
                makeRaw({ id: 'msg-1', subject: 'First' }),
                makeRaw({ id: 'msg-2', from: 'Other <o@co.com>', subject: 'Second' }),
            ]);

            await expect(service.fetchAndProcess()).rejects.toThrow('Disk full');
            // Only first note created
            expect(vault.files.size).toBe(1);
            // Not marked seen
            expect(plugin.newsletterSeenIds).toEqual([]);

            // Retry — restore normal create
            vault.create.mockImplementation(async (path: string, content: string) => {
                vault.files.set(path, { path, content });
            });
            mockFetchResponse([
                makeRaw({ id: 'msg-1', subject: 'First' }),
                makeRaw({ id: 'msg-2', from: 'Other <o@co.com>', subject: 'Second' }),
            ]);
            await service.fetchAndProcess();

            // msg-1 note should exist exactly once (deterministic path, skipped on create)
            const msg1Notes = [...vault.files.keys()].filter(k =>
                k.includes('Morning Brew') && !k.includes('Digest'));
            expect(msg1Notes.length).toBe(1);
        });
    });

    // ── Mark-seen safety + Gmail confirmation ────────────────────────

    describe('mark-seen safety and Gmail confirmation', () => {
        it('does not mark seen before vault writes', async () => {
            vault.create.mockRejectedValueOnce(new Error('Vault write failed'));
            mockFetchResponse([makeRaw()]);

            await expect(service.fetchAndProcess()).rejects.toThrow('Vault write failed');
            expect(plugin.newsletterSeenIds).toEqual([]);
        });

        it('marks seen after successful vault writes', async () => {
            mockFetchResponse([makeRaw()]);
            await service.fetchAndProcess();
            expect(plugin.newsletterSeenIds.length).toBe(1);
        });

        it('calls POST to confirm read on Gmail after vault writes', async () => {
            mockFetchResponse([makeRaw({ id: 'msg-42' })]);
            await service.fetchAndProcess();

            // requestUrl called twice: GET (fetch) + POST (confirm)
            expect(requestUrl).toHaveBeenCalledTimes(2);
            const postCall = (requestUrl as any).mock.calls[1][0];
            expect(postCall.method).toBe('POST');
            expect(JSON.parse(postCall.body)).toEqual(['msg-42']);
        });

        it('does not POST confirm when vault writes fail', async () => {
            vault.create.mockRejectedValueOnce(new Error('Write failed'));
            mockFetchResponse([makeRaw()]);

            await expect(service.fetchAndProcess()).rejects.toThrow('Write failed');
            // Only the GET call, no POST
            const postCalls = (requestUrl as any).mock.calls.filter(
                (c: any[]) => c[0]?.method === 'POST');
            expect(postCalls.length).toBe(0);
        });

        it('survives POST confirm failure (best-effort)', async () => {
            (requestUrl as any).mockImplementation(async (opts: any) => {
                if (opts.method === 'POST') throw new Error('POST failed');
                const body = JSON.stringify([makeRaw()]);
                return { status: 200, text: body, json: [makeRaw()] };
            });

            const result = await service.fetchAndProcess();
            expect(result.totalNew).toBe(1); // Still succeeds
            expect(plugin.newsletterSeenIds.length).toBe(1); // Still marked seen locally
        });

        it('returns false and warns on old-script 405 response', async () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const confirmed = await service.confirmReadOnGmail(['msg-1']);
            // Default mock returns {status: 200} — override for this test
            (requestUrl as any).mockImplementation(async (opts: any) => {
                if (opts.method === 'POST') return { status: 405, text: '', json: null };
                return { status: 200, text: '[]', json: [] };
            });
            const result = await service.confirmReadOnGmail(['msg-1']);
            expect(result).toBe(false);
            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining('does not support two-phase')
            );
            warnSpy.mockRestore();
        });

        it('returns false and warns on old-script 500 response', async () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            (requestUrl as any).mockImplementation(async (opts: any) => {
                if (opts.method === 'POST') return { status: 500, text: '', json: null };
                return { status: 200, text: '[]', json: [] };
            });
            // Reset warning flag by creating fresh service
            const freshService = new NewsletterService(plugin);
            const result = await freshService.confirmReadOnGmail(['msg-1']);
            expect(result).toBe(false);
            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining('Re-deploy')
            );
            warnSpy.mockRestore();
        });

        it('returns true on successful POST confirm', async () => {
            mockFetchResponse([]);
            const result = await service.confirmReadOnGmail(['msg-1']);
            expect(result).toBe(true);
        });

        it('skips already-seen emails', async () => {
            mockFetchResponse([makeRaw()]);
            await service.fetchAndProcess();

            mockFetchResponse([makeRaw()]);
            const result = await service.fetchAndProcess();
            expect(result.totalSkipped).toBe(1);
            expect(result.totalNew).toBe(0);
        });
    });

    // ── Auto-tag + Bases metadata ────────────────────────────────────

    describe('auto-tag and Bases metadata wiring', () => {
        it('does not call analyzeAndTagNote when newsletterAutoTag is false', async () => {
            plugin.settings.newsletterAutoTag = false;
            mockFetchResponse([makeRaw()]);
            await service.fetchAndProcess();
            expect(plugin.analyzeAndTagNote).not.toHaveBeenCalled();
        });

        it('calls analyzeAndTagNote for created notes when enabled', async () => {
            plugin.settings.newsletterAutoTag = true;
            // Return TFile-like objects from getAbstractFileByPath
            vault.create.mockImplementation(async (path: string, content: string) => {
                const { TFile: MockTFile } = await import('obsidian');
                const file = new MockTFile();
                (file as any).path = path;
                vault.files.set(path, { path, content });
                const origGet = vault.getAbstractFileByPath.bind(vault);
                vault.getAbstractFileByPath = (p: string) =>
                    vault.files.has(p) ? (file as any) : origGet(p);
            });

            mockFetchResponse([makeRaw()]);
            await service.fetchAndProcess();
            expect(plugin.analyzeAndTagNote).toHaveBeenCalled();
        });

        it('calls updateAIOMetadata when enableStructuredMetadata is true', async () => {
            plugin.settings.enableStructuredMetadata = true;
            plugin.settings.newsletterAutoTag = false; // metadata should fire even without auto-tag

            vault.create.mockImplementation(async (path: string, content: string) => {
                const { TFile: MockTFile } = await import('obsidian');
                const file = new MockTFile();
                (file as any).path = path;
                vault.files.set(path, { path, content });
                const origGet = vault.getAbstractFileByPath.bind(vault);
                vault.getAbstractFileByPath = (p: string) =>
                    vault.files.has(p) ? (file as any) : origGet(p);
            });

            mockFetchResponse([makeRaw()]);
            await service.fetchAndProcess();

            expect(updateAIOMetadata).toHaveBeenCalled();
            const call = (updateAIOMetadata as any).mock.calls[0];
            expect(call[2]).toMatchObject({ source: 'email' });
            expect(call[2].summary).toBeDefined();
        });

        it('does not call updateAIOMetadata when enableStructuredMetadata is false', async () => {
            plugin.settings.enableStructuredMetadata = false;
            plugin.settings.newsletterAutoTag = true;
            mockFetchResponse([makeRaw()]);
            await service.fetchAndProcess();
            expect(updateAIOMetadata).not.toHaveBeenCalled();
        });

        it('does not block result when auto-tag fails', async () => {
            plugin.settings.newsletterAutoTag = true;
            plugin.analyzeAndTagNote.mockRejectedValue(new Error('Tag failed'));
            mockFetchResponse([makeRaw()]);
            const result = await service.fetchAndProcess();
            expect(result.totalNew).toBe(1);
            expect(result.errors).toEqual([]);
        });
    });

    // ── fetchAndProcess end-to-end ───────────────────────────────────

    describe('fetchAndProcess end-to-end', () => {
        it('returns error when no script URL configured', async () => {
            plugin.settings.newsletterScriptUrl = '';
            const result = await service.fetchAndProcess();
            expect(result.errors).toContain('No Apps Script URL configured');
        });

        it('returns error on HTTP failure', async () => {
            (requestUrl as any).mockImplementation(async () => {
                throw new Error('Network error');
            });
            const result = await service.fetchAndProcess();
            expect(result.errors[0]).toContain('Fetch failed');
        });

        it('returns empty result for no emails', async () => {
            mockFetchResponse([]);
            const result = await service.fetchAndProcess();
            expect(result.totalFetched).toBe(0);
            expect(result.totalNew).toBe(0);
        });

        it('creates individual note without hand-written summary in frontmatter', async () => {
            mockFetchResponse([makeRaw()]);
            await service.fetchAndProcess();

            const noteEntry = [...vault.files.entries()].find(([k]) =>
                k.includes('Morning Brew') && !k.includes('Digest'));
            expect(noteEntry).toBeDefined();
            const content = noteEntry![1].content;

            expect(content).toContain('tags:');
            expect(content).toContain('  - newsletter');
            // summary is NOT in raw frontmatter — written by updateAIOMetadata instead
            expect(content).not.toContain('summary:');
            expect(content).toContain('# Daily Update');
            expect(content).toContain('*From: Morning Brew <morning@brew.com>*');
        });

        it('calls progress callback', async () => {
            mockFetchResponse([makeRaw()]);
            const onProgress = vi.fn();
            await service.fetchAndProcess(onProgress);
            expect(onProgress).toHaveBeenCalledWith(1, 1);
        });
    });
});

// ── Command registration ────────────────────────────────────────────────────

describe('newsletter-open-digest command registration', () => {
    it('open-digest command is exported from newsletterCommands', async () => {
        const mod = await import('../src/commands/newsletterCommands');
        expect(typeof mod.registerNewsletterCommands).toBe('function');
    });
});
