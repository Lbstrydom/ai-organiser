/**
 * Embed manager — syncEmbed (single function: upsert when enabled, remove when disabled).
 * Verifies G2 (transformer) is paired with proper block lifecycle (H3, R2-H2).
 */

import { describe, it, expect, vi } from 'vitest';
import { syncEmbed, findEmbedBlock, EMBED_START, EMBED_END } from '../src/services/audioNarration/narrationEmbedManager';
import type { App, TFile } from 'obsidian';

interface MockFile {
    path: string;
}

function makeMockApp(initialContent: string): { app: App; getContent: () => string; readMock: ReturnType<typeof vi.fn>; modifyMock: ReturnType<typeof vi.fn> } {
    let content = initialContent;
    const readMock = vi.fn(async () => content);
    const modifyMock = vi.fn(async (_f: MockFile, newContent: string) => { content = newContent; });
    const app = {
        vault: {
            read: readMock,
            modify: modifyMock,
        },
    } as unknown as App;
    return { app, getContent: () => content, readMock, modifyMock };
}

const mockFile = { path: 'test.md' } as TFile;

describe('findEmbedBlock', () => {
    it('returns null when no block present', () => {
        expect(findEmbedBlock('# Hello\n\nNo block here.')).toBeNull();
    });

    it('finds block boundaries', () => {
        const content = `# Hi\n\n${EMBED_START}\n🎧 ![[a.mp3]]\n${EMBED_END}\n\nMore.`;
        const loc = findEmbedBlock(content);
        expect(loc).not.toBeNull();
        if (loc) {
            expect(content.slice(loc.start, loc.end)).toContain('a.mp3');
        }
    });

    it('matches greedy block content', () => {
        const content = `${EMBED_START}\nline1\nline2\nline3\n${EMBED_END}`;
        const loc = findEmbedBlock(content);
        expect(loc).not.toBeNull();
    });
});

describe('syncEmbed: enabled=true (upsert)', () => {
    it('inserts block at top when no frontmatter and no existing block', async () => {
        const { app, getContent } = makeMockApp('# Hello\n\nWorld.');
        const r = await syncEmbed(app, mockFile, 'AI-Organiser/Narrations/foo.mp3', true);
        expect(r.ok).toBe(true);
        const content = getContent();
        expect(content.startsWith(EMBED_START)).toBe(true);
        expect(content).toContain('![[AI-Organiser/Narrations/foo.mp3]]');
        expect(content).toContain('# Hello');
    });

    it('inserts after frontmatter', async () => {
        const initial = '---\ntitle: T\n---\n\n# Hello';
        const { app, getContent } = makeMockApp(initial);
        await syncEmbed(app, mockFile, 'foo.mp3', true);
        const content = getContent();
        expect(content.startsWith('---')).toBe(true);
        // Frontmatter ends with second `---`; block appears between frontmatter and body
        const fmEndIdx = content.indexOf('---', 3);  // second `---`
        const startIdx = content.indexOf(EMBED_START);
        const bodyIdx = content.indexOf('# Hello');
        expect(fmEndIdx).toBeGreaterThan(0);
        expect(startIdx).toBeGreaterThan(fmEndIdx);
        expect(bodyIdx).toBeGreaterThan(startIdx);
    });

    it('replaces existing block in place (preserves position)', async () => {
        const initial = `${EMBED_START}\n🎧 ![[old.mp3]]\n${EMBED_END}\n\n# Body`;
        const { app, getContent } = makeMockApp(initial);
        await syncEmbed(app, mockFile, 'new.mp3', true);
        const content = getContent();
        expect(content).toContain('new.mp3');
        expect(content).not.toContain('old.mp3');
        expect(content).toContain('# Body');
    });

    it('does not touch non-managed user 🎧 lines', async () => {
        const initial = `# Note\n\n🎧 my own audio note ![[my-recording.mp3]]\n\nbody.`;
        const { app, getContent } = makeMockApp(initial);
        await syncEmbed(app, mockFile, 'narration.mp3', true);
        const content = getContent();
        expect(content).toContain('my own audio note');
        expect(content).toContain('my-recording.mp3');
        expect(content).toContain('narration.mp3');  // newly added
    });

    it('idempotent: same input twice → same output', async () => {
        const { app, getContent } = makeMockApp('# Hello');
        await syncEmbed(app, mockFile, 'foo.mp3', true);
        const after1 = getContent();
        await syncEmbed(app, mockFile, 'foo.mp3', true);
        const after2 = getContent();
        expect(after1).toBe(after2);
    });

    it('re-reads vault content before write (TOCTOU safety)', async () => {
        const { app, readMock } = makeMockApp('# Hello');
        await syncEmbed(app, mockFile, 'foo.mp3', true);
        // First call should read the file fresh
        expect(readMock).toHaveBeenCalled();
    });
});

describe('syncEmbed: enabled=false (remove)', () => {
    it('removes existing managed block', async () => {
        const initial = `${EMBED_START}\n🎧 ![[a.mp3]]\n${EMBED_END}\n\n# Body`;
        const { app, getContent } = makeMockApp(initial);
        await syncEmbed(app, mockFile, '', false);
        const content = getContent();
        expect(content).not.toContain(EMBED_START);
        expect(content).not.toContain('a.mp3');
        expect(content).toContain('# Body');
    });

    it('no-op when no block exists', async () => {
        const initial = '# Hello\n\nNo block.';
        const { app, getContent, modifyMock } = makeMockApp(initial);
        const r = await syncEmbed(app, mockFile, '', false);
        expect(r.ok).toBe(true);
        expect(getContent()).toBe(initial);
        // Should not call modify when there's nothing to remove
        expect(modifyMock).not.toHaveBeenCalled();
    });

    it('preserves non-managed 🎧 lines outside markers', async () => {
        const initial = `${EMBED_START}\n🎧 ![[old.mp3]]\n${EMBED_END}\n\n🎧 my custom audio`;
        const { app, getContent } = makeMockApp(initial);
        await syncEmbed(app, mockFile, '', false);
        const content = getContent();
        expect(content).not.toContain('old.mp3');
        expect(content).toContain('my custom audio');
    });
});

describe('syncEmbed: round-trip (R2-H2 toggle drift verification)', () => {
    it('on → off → on produces same result as single on', async () => {
        const initial = '# Hello';
        const { app, getContent } = makeMockApp(initial);
        await syncEmbed(app, mockFile, 'foo.mp3', true);
        const expected = getContent();

        const second = makeMockApp(initial);
        await syncEmbed(second.app, mockFile, 'foo.mp3', true);
        await syncEmbed(second.app, mockFile, 'foo.mp3', false);
        await syncEmbed(second.app, mockFile, 'foo.mp3', true);
        const actual = second.getContent();

        expect(actual).toBe(expected);
    });

    it('idempotent-hit branch with embedInNote=false removes prior block', async () => {
        // Simulates the R2-H2 fix: existing-file branch must remove embed if user toggled off
        const initial = `${EMBED_START}\n🎧 ![[old.mp3]]\n${EMBED_END}\n\n# Body`;
        const { app, getContent } = makeMockApp(initial);
        await syncEmbed(app, mockFile, 'old.mp3', false);
        expect(getContent()).not.toContain(EMBED_START);
    });
});

describe('syncEmbed: mtime conflict guard (audit H10)', () => {
    it('refuses to write when file was edited during compute window', async () => {
        let mtime = 1000;
        let content = '# Hello';
        const file = { path: 'a.md', stat: { mtime } } as unknown as TFile;
        const readMock = vi.fn(async () => {
            // Simulate user edit happening between read and write — bump mtime
            mtime = 2000;
            (file as unknown as { stat: { mtime: number } }).stat.mtime = mtime;
            return content;
        });
        const modifyMock = vi.fn(async (_f: MockFile, c: string) => { content = c; });
        const app = { vault: { read: readMock, modify: modifyMock } } as unknown as App;

        const r = await syncEmbed(app, file, 'foo.mp3', true);
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error).toContain('EMBED_FAILED');
        }
        expect(modifyMock).not.toHaveBeenCalled();
    });

    it('proceeds normally when mtime is stable across the window', async () => {
        const file = { path: 'a.md', stat: { mtime: 1000 } } as unknown as TFile;
        const { app, getContent } = makeMockApp('# Hello');
        // Make read use the test-file (with stat) instead of the mock's default
        (app.vault.read as ReturnType<typeof vi.fn>).mockImplementation(async () => '# Hello');
        const r = await syncEmbed(app, file, 'foo.mp3', true);
        expect(r.ok).toBe(true);
        expect(getContent()).toContain('foo.mp3');
    });
});

describe('syncEmbed: error handling', () => {
    it('returns EMBED_FAILED when read throws', async () => {
        const app = {
            vault: {
                read: vi.fn().mockRejectedValue(new Error('read failed')),
                modify: vi.fn(),
            },
        } as unknown as App;
        const r = await syncEmbed(app, mockFile, 'x.mp3', true);
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error).toContain('EMBED_FAILED');
        }
    });

    it('returns EMBED_FAILED when modify throws', async () => {
        const app = {
            vault: {
                read: vi.fn().mockResolvedValue('# Hello'),
                modify: vi.fn().mockRejectedValue(new Error('write failed')),
            },
        } as unknown as App;
        const r = await syncEmbed(app, mockFile, 'x.mp3', true);
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error).toContain('EMBED_FAILED');
        }
    });
});
