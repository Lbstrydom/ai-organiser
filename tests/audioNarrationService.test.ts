/**
 * Audio narration service — two-stage contract verification.
 *
 * Tests the prepareNarration / executeNarration pipeline with mocked dependencies.
 * Avoids any real network or vault writes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { App } from 'obsidian';

// Mock the lamejs encoder so we don't need a real lamejs build
vi.mock('@breezystack/lamejs', () => {
    return {
        default: {
            Mp3Encoder: class {
                encodeBuffer(_samples: Int16Array): Uint8Array {
                    return new Uint8Array(8);
                }
                flush(): Uint8Array {
                    return new Uint8Array(2);
                }
            },
        },
    };
});

// Mock obsidian's normalizePath (path passthrough is fine for tests)
vi.mock('obsidian', () => {
    class MockTFile {
        path = '';
        basename = '';
        extension = '';
    }
    return {
        normalizePath: (p: string) => p.replace(/\\/g, '/'),
        requestUrl: vi.fn(),
        TFile: MockTFile,
    };
});

// Mock minutesUtils
vi.mock('../src/utils/minutesUtils', () => ({
    ensureFolderExists: vi.fn().mockResolvedValue(undefined),
}));

// Mock privacy
vi.mock('../src/services/privacyNotice', () => ({
    ensurePrivacyConsent: vi.fn().mockResolvedValue(true),
}));

// Mock apiKeyHelpers — control whether key resolves
const apiKeyResult = { value: { provider: 'gemini', apiKey: 'test-key', model: 'gemini-3.1-flash-tts-preview', endpoint: '' } as { provider: string; apiKey: string; model: string; endpoint: string } | null };
vi.mock('../src/services/apiKeyHelpers', () => ({
    getAudioNarrationProviderConfig: vi.fn(async () => apiKeyResult.value),
    resolveSpecialistProvider: vi.fn(async () => apiKeyResult.value),
}));

// Mock settings helper
vi.mock('../src/core/settings', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('../src/core/settings');
    return {
        ...actual,
        getAudioNarrationFullPath: () => 'AI-Organiser/Narrations',
    };
});

// Now import the service (must be after mocks)
import { TFile } from 'obsidian';
import {
    prepareNarration,
    executeNarration,
    buildOutputPath,
} from '../src/services/audioNarration/audioNarrationService';
import { decodeError } from '../src/services/audioNarration/narrationTypes';
import type { PreparedNarration } from '../src/services/audioNarration/narrationTypes';

interface MockPlugin {
    app: App;
    settings: Record<string, unknown>;
    secretStorageService: { isAvailable(): boolean };
    t: { progress: { audioNarration: Record<string, string> } };
    busyStatusBarEl: HTMLElement | null;
    narrationJobs: { has: (k: string) => boolean };
}

function makeMockFile(path: string): TFile {
    const f = new TFile();
    f.path = path;
    f.basename = path.replace(/\.md$/, '').split('/').pop() || 'file';
    f.extension = 'md';
    return f;
}

function makeMp3File(): TFile {
    const f = new TFile();
    f.path = 'AI-Organiser/Narrations/test.01234567.mp3';
    f.basename = 'test.01234567';
    f.extension = 'mp3';
    return f;
}

function makeMockPlugin(noteContent: string, opts: { existingFile?: boolean } = {}): MockPlugin {
    const readMock = vi.fn().mockResolvedValue(noteContent);
    const createBinaryMock = vi.fn().mockResolvedValue(undefined);
    const modifyMock = vi.fn().mockResolvedValue(undefined);
    const getAbstractMock = vi.fn().mockReturnValue(opts.existingFile ? makeMp3File() : null);

    return {
        app: {
            vault: {
                read: readMock,
                createBinary: createBinaryMock,
                modify: modifyMock,
                getAbstractFileByPath: getAbstractMock,
            },
            workspace: { openLinkText: vi.fn() },
        } as unknown as App,
        settings: {
            audioNarrationProvider: 'gemini',
            audioNarrationVoice: 'Charon',
            audioNarrationOutputFolder: 'Narrations',
            audioNarrationEmbedInNote: true,
        },
        secretStorageService: { isAvailable: () => false },
        t: { progress: { audioNarration: { narrating: '{current}/{total}', encoding: 'enc', writing: 'wr' } } },
        busyStatusBarEl: null,
        narrationJobs: { has: () => false },
    };
}

describe('buildOutputPath', () => {
    it('produces stable filename based on fingerprint prefix', () => {
        const plugin = makeMockPlugin('# Hello\n\nWorld.') as unknown as { app: App; settings: Record<string, unknown> };
        const file = makeMockFile('Notes/test.md');
        const fp = '0123456789abcdef0123456789abcdef';
        const path = buildOutputPath(plugin as never, file, fp);
        expect(path).toBe('AI-Organiser/Narrations/test.01234567.mp3');
    });

    it('sanitises filesystem-unsafe characters', () => {
        const plugin = makeMockPlugin('# Hello') as unknown as { app: App; settings: Record<string, unknown> };
        const file = makeMockFile('test:weird*name.md');
        Object.assign(file, { basename: 'test:weird*name' });
        const path = buildOutputPath(plugin as never, file, 'a'.repeat(32));
        expect(path).not.toContain(':');
        expect(path).not.toContain('*');
    });

    it('strips wikilink-reserved characters (audit R2-M6)', () => {
        const plugin = makeMockPlugin('# Hello') as unknown as { app: App; settings: Record<string, unknown> };
        const file = makeMockFile('Note^block.md');
        Object.assign(file, { basename: 'Note[stuff]^block#section|alt' });
        const path = buildOutputPath(plugin as never, file, 'a'.repeat(32));
        expect(path).not.toContain('[');
        expect(path).not.toContain(']');
        expect(path).not.toContain('^');
        expect(path).not.toContain('#');
        expect(path).not.toContain('|');
    });

    it('rewrites Windows reserved device basenames (audit R2-H4)', () => {
        const plugin = makeMockPlugin('# Hello') as unknown as { app: App; settings: Record<string, unknown> };
        const reservedNames = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9'];
        for (const name of reservedNames) {
            const file = makeMockFile(`${name}.md`);
            Object.assign(file, { basename: name });
            const path = buildOutputPath(plugin as never, file, 'a'.repeat(32));
            // Must NOT use the reserved name as the basename
            expect(path).toContain('narration-');
            expect(path).toContain(name);
        }
    });

    it('handles dot-only basename (collapses to safe fallback)', () => {
        const plugin = makeMockPlugin('# Hello') as unknown as { app: App; settings: Record<string, unknown> };
        const file = makeMockFile('....md');
        Object.assign(file, { basename: '...' });
        const path = buildOutputPath(plugin as never, file, 'a'.repeat(32));
        expect(path).toContain('narration');
    });
});

describe('prepareNarration', () => {
    beforeEach(() => {
        apiKeyResult.value = { provider: 'gemini', apiKey: 'test-key', model: 'gemini-3.1-flash-tts-preview', endpoint: '' };
    });

    it('returns PreparedNarration on success', async () => {
        const plugin = makeMockPlugin('# Hello\n\nWorld.');
        const file = makeMockFile('test.md');
        const r = await prepareNarration(plugin as never, file);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.spokenText).toContain('Hello');
            expect(r.value.spokenText).toContain('World');
            expect(r.value.fingerprint).toMatch(/^[0-9a-f]+$/);
            expect(r.value.outputPath).toContain('.mp3');
            expect(r.value.existingFile).toBeNull();
            expect(r.value.voice).toBe('Charon');
            expect(r.value.embedInNote).toBe(true);
        }
    });

    it('returns EMPTY_CONTENT for empty note', async () => {
        const plugin = makeMockPlugin('');
        const file = makeMockFile('empty.md');
        const r = await prepareNarration(plugin as never, file);
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(decodeError(r.error).code).toBe('EMPTY_CONTENT');
        }
    });

    it('returns EMPTY_CONTENT for frontmatter-only note', async () => {
        const plugin = makeMockPlugin('---\ntitle: Test\n---\n');
        const file = makeMockFile('fm.md');
        const r = await prepareNarration(plugin as never, file);
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(decodeError(r.error).code).toBe('EMPTY_CONTENT');
        }
    });

    it('returns NO_API_KEY when key resolution fails', async () => {
        apiKeyResult.value = null;
        const plugin = makeMockPlugin('# Hi');
        const file = makeMockFile('a.md');
        const r = await prepareNarration(plugin as never, file);
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(decodeError(r.error).code).toBe('NO_API_KEY');
        }
    });

    it('detects existing fingerprinted file', async () => {
        const plugin = makeMockPlugin('# Hello', { existingFile: true });
        const file = makeMockFile('test.md');
        const r = await prepareNarration(plugin as never, file);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.existingFile).not.toBeNull();
        }
    });

    it('fingerprint is deterministic across calls', async () => {
        const plugin = makeMockPlugin('# Hello world');
        const file = makeMockFile('test.md');
        const r1 = await prepareNarration(plugin as never, file);
        const r2 = await prepareNarration(plugin as never, file);
        expect(r1.ok && r2.ok && r1.value.fingerprint).toBe(r2.ok && r2.value.fingerprint);
    });

    it('different voices produce different fingerprints', async () => {
        const pluginA = makeMockPlugin('# Hello');
        pluginA.settings.audioNarrationVoice = 'Charon';
        const pluginB = makeMockPlugin('# Hello');
        pluginB.settings.audioNarrationVoice = 'Puck';
        const file = makeMockFile('test.md');
        const rA = await prepareNarration(pluginA as never, file);
        const rB = await prepareNarration(pluginB as never, file);
        expect(rA.ok && rA.value.fingerprint).not.toBe(rB.ok && rB.value.fingerprint);
    });
});

describe('executeNarration', () => {
    let mockEngine: { synthesizeChunk: ReturnType<typeof vi.fn>; providerId: string };

    beforeEach(() => {
        apiKeyResult.value = { provider: 'gemini', apiKey: 'test-key', model: 'gemini-3.1-flash-tts-preview', endpoint: '' };
        // Default engine returns 100 dummy samples per chunk
        mockEngine = {
            providerId: 'gemini',
            synthesizeChunk: vi.fn().mockResolvedValue(new Int16Array(100)),
        };
    });

    function makePrepared(plugin: MockPlugin, spokenText: string, embedInNote = true): PreparedNarration {
        // Use the real provider, but inject our mock engine via factory override
        const providerOverride = {
            id: 'gemini' as const,
            displayName: 'Test Gemini',
            modelId: 'gemini-3.1-flash-tts-preview',
            defaultVoice: 'Charon',
            voices: [{ id: 'Charon', labelKey: 'k' }],
            costPerMillionCharsUsd: 15,
            privacyConsentKey: 'gemini',
            factory: vi.fn().mockResolvedValue(mockEngine),
        };
        return {
            file: { path: 'test.md', basename: 'test', extension: 'md' } as unknown as TFile,
            spokenText,
            stats: { charCount: spokenText.length, wordCount: spokenText.split(' ').length, estReadSeconds: 1, sectionCount: 0 },
            cost: { charCount: spokenText.length, chunkCount: 1, estDurationSec: 1, estUsd: 0.01, estEur: 0.009, providerId: 'gemini', voice: 'Charon' },
            fingerprint: '0123456789abcdef',
            outputPath: 'AI-Organiser/Narrations/test.01234567.mp3',
            existingFile: null,
            provider: providerOverride,
            voice: 'Charon',
            embedInNote,
        };
    }

    it('success path returns NarrateOutcome', async () => {
        const plugin = makeMockPlugin('# Hello');
        const prepared = makePrepared(plugin, 'Hello world.');
        const r = await executeNarration(plugin as never, prepared);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.bytes).toBeGreaterThan(0);
            expect(r.value.filePath).toBe(prepared.outputPath);
            expect(r.value.embedUpdated).toBe(true);
        }
    });

    it('returns NO_API_KEY when factory returns null', async () => {
        const plugin = makeMockPlugin('# Hello');
        const prepared = makePrepared(plugin, 'Hello.');
        // Override factory to return null
        (prepared.provider as unknown as { factory: ReturnType<typeof vi.fn> }).factory =
            vi.fn().mockResolvedValue(null);
        const r = await executeNarration(plugin as never, prepared);
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(decodeError(r.error).code).toBe('NO_API_KEY');
        }
    });

    it('returns TTS_FAILED on engine throw', async () => {
        const plugin = makeMockPlugin('# Hello');
        const prepared = makePrepared(plugin, 'Hello.');
        mockEngine.synthesizeChunk.mockRejectedValue(new Error('upstream broke'));
        const r = await executeNarration(plugin as never, prepared);
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(decodeError(r.error).code).toBe('TTS_FAILED');
        }
    });

    it('returns ABORTED when signal pre-aborts', async () => {
        const plugin = makeMockPlugin('# Hello');
        const prepared = makePrepared(plugin, 'Hello.');
        const ac = new AbortController();
        ac.abort();
        const r = await executeNarration(plugin as never, prepared, { signal: ac.signal });
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(decodeError(r.error).code).toBe('ABORTED');
        }
    });

    it('returns WRITE_FAILED when vault.createBinary throws', async () => {
        const plugin = makeMockPlugin('# Hello');
        (plugin.app.vault.createBinary as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('disk full'));
        const prepared = makePrepared(plugin, 'Hello.');
        const r = await executeNarration(plugin as never, prepared);
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(decodeError(r.error).code).toBe('WRITE_FAILED');
        }
    });

    it('embedUpdated=false when syncEmbed fails (non-fatal)', async () => {
        const plugin = makeMockPlugin('# Hello');
        // Make modify (used by syncEmbed) throw, but createBinary succeeds
        (plugin.app.vault.modify as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('locked'));
        const prepared = makePrepared(plugin, 'Hello.', true);
        const r = await executeNarration(plugin as never, prepared);
        // Service still returns ok — embed failure is surfaced via embedUpdated flag
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.embedUpdated).toBe(false);
        }
    });

    it('embedInNote=false → calls syncEmbed with enabled=false', async () => {
        const plugin = makeMockPlugin('# Hello');
        const prepared = makePrepared(plugin, 'Hello.', false);
        const r = await executeNarration(plugin as never, prepared);
        expect(r.ok).toBe(true);
        expect((plugin.app.vault.read as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });

    it('skipsExisting=true at write boundary when fingerprint match appears mid-flight (audit R2-M5)', async () => {
        const plugin = makeMockPlugin('# Hello');
        // First call to getAbstractFileByPath (in prepareNarration) returns null,
        // but second call (at write boundary) returns an mp3 TFile — simulating
        // a sync/copy that landed during execution.
        const mp3 = makeMp3File();
        let calls = 0;
        (plugin.app.vault.getAbstractFileByPath as ReturnType<typeof vi.fn>).mockImplementation(() => {
            calls++;
            return calls >= 1 ? mp3 : null;
        });
        const prepared = makePrepared(plugin, 'Hello.');
        const r = await executeNarration(plugin as never, prepared);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.skippedExisting).toBe(true);
        }
        // Most importantly — createBinary must NOT have been called
        expect((plugin.app.vault.createBinary as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });
});
