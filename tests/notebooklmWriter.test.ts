import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WriterService } from '../src/services/notebooklm/writer';
import { TFile, TFolder, createTFile, createTFolder } from './mocks/obsidian';
import type { PackManifest, Changelog } from '../src/services/notebooklm/types';

// Minimal App mock — only vault operations used by WriterService.
// Values in the map must be TFile or TFolder instances (or null) so that
// instanceof checks in writeFile / ensureFolder work correctly.
function makeApp() {
    const files = new Map<string, TFile | TFolder>();

    return {
        vault: {
            getAbstractFileByPath: (path: string) => files.get(path) ?? null,
            modify: vi.fn(async (file: TFile, _content: string) => {
                files.set(file.path, file);
            }),
            create: vi.fn(async (path: string, _content: string) => {
                files.set(path, createTFile(path));
            }),
            createFolder: vi.fn(async (path: string) => {
                files.set(path, createTFolder(path));
            }),
            _files: files,
        },
    } as unknown as import('obsidian').App;
}

function makeManifest(overrides: Partial<PackManifest> = {}): PackManifest {
    return {
        packId: 'test-pack-id',
        revision: 1,
        generatedAt: '2026-01-01T00:00:00.000Z',
        stats: { noteCount: 2, totalBytes: 2048 },
        config: {
            selectionTag: 'notebooklm',
            exportFolder: 'NotebookLM',
            postExportTagAction: 'keep',
            exportFormat: 'text',
            pdf: {
                pageSize: 'A4',
                fontName: 'helvetica',
                fontSize: 11,
                includeFrontmatter: false,
                includeTitle: true,
                marginX: 20,
                marginY: 20,
                lineHeight: 1.5,
            },
        },
        entries: [
            {
                type: 'note-text',
                filePath: 'Notes/Note A.md',
                outputName: 'Note_A.txt',
                title: 'Note A',
                mtime: '2026-01-01T00:00:00.000Z',
                tags: ['notebooklm'],
                sizeBytes: 1024,
                sha256: 'abc123',
            },
            {
                type: 'note-text',
                filePath: 'Notes/Note B.md',
                outputName: 'Note_B.txt',
                title: 'Note B',
                mtime: '2026-01-01T00:00:00.000Z',
                tags: ['notebooklm'],
                sizeBytes: 1024,
                sha256: 'def456',
            },
        ],
        ...overrides,
    };
}

describe('WriterService.generateReadmeContent (via writeReadme)', () => {
    let app: ReturnType<typeof makeApp>;
    let service: WriterService;

    beforeEach(() => {
        app = makeApp();
        service = new WriterService(app);
    });

    it('writes README.md to the correct path', async () => {
        const manifest = makeManifest();
        await service.writeReadme('packs/my-pack', manifest);
        expect(app.vault.create).toHaveBeenCalledWith(
            'packs/my-pack/README.md',
            expect.stringContaining('NotebookLM source pack'),
        );
    });

    it('includes note count and total size', async () => {
        const manifest = makeManifest();
        await service.writeReadme('packs/my-pack', manifest);
        const content = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
        expect(content).toContain('**Notes:** 2');
        expect(content).toContain('2.0 KB');
    });

    it('generates a checklist for note entries', async () => {
        const manifest = makeManifest();
        await service.writeReadme('packs/my-pack', manifest);
        const content = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
        expect(content).toContain('- [ ] Note_A.txt — Note A');
        expect(content).toContain('- [ ] Note_B.txt — Note B');
    });

    it('omits sidecar section when no attachment entries', async () => {
        const manifest = makeManifest();
        await service.writeReadme('packs/my-pack', manifest);
        const content = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
        expect(content).not.toContain('Attached documents');
    });

    it('includes sidecar section when attachment entries exist', async () => {
        const manifest = makeManifest({
            entries: [
                {
                    type: 'note-text',
                    filePath: 'Notes/Note A.md',
                    outputName: 'Note_A.txt',
                    title: 'Note A',
                    mtime: '2026-01-01T00:00:00.000Z',
                    tags: [],
                    sizeBytes: 1024,
                    sha256: 'abc',
                },
                {
                    type: 'attachment',
                    filePath: 'Attachments/chart.pdf',
                    outputName: 'chart.pdf',
                    title: 'chart.pdf',
                    mtime: '2026-01-01T00:00:00.000Z',
                    tags: [],
                    sizeBytes: 512000,
                    sha256: 'xyz',
                },
            ],
        });
        await service.writeReadme('packs/my-pack', manifest);
        const content = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
        expect(content).toContain('Attached documents');
        expect(content).toContain('- [ ] chart.pdf ← contains charts/graphs');
    });

    it('includes upload instructions and NotebookLM link', async () => {
        await service.writeReadme('packs/my-pack', makeManifest());
        const content = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
        expect(content).toContain('notebooklm.google.com');
        expect(content).toContain('Upload instructions');
    });

    it('uses vault.modify when file already exists', async () => {
        (app.vault as unknown as { _files: Map<string, TFile | TFolder> })._files.set('packs/my-pack/README.md', createTFile('packs/my-pack/README.md'));
        await service.writeReadme('packs/my-pack', makeManifest());
        expect(app.vault.modify).toHaveBeenCalled();
        expect(app.vault.create).not.toHaveBeenCalled();
    });
});

describe('WriterService.writeManifest', () => {
    let app: ReturnType<typeof makeApp>;
    let service: WriterService;

    beforeEach(() => {
        app = makeApp();
        service = new WriterService(app);
    });

    it('writes valid JSON to manifest.json', async () => {
        const manifest = makeManifest();
        await service.writeManifest('packs/my-pack', manifest);
        const call = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(call[0]).toBe('packs/my-pack/manifest.json');
        const parsed = JSON.parse(call[1] as string);
        expect(parsed.packId).toBe('test-pack-id');
        expect(parsed.entries).toHaveLength(2);
    });
});

describe('WriterService.writeChangelog', () => {
    let app: ReturnType<typeof makeApp>;
    let service: WriterService;

    beforeEach(() => {
        app = makeApp();
        service = new WriterService(app);
    });

    it('writes changelog.md with summary counts', async () => {
        const changelog: Changelog = {
            fromRevision: 1,
            toRevision: 2,
            generatedAt: '2026-01-02T00:00:00.000Z',
            summary: { added: 1, removed: 0, changed: 2 },
            entries: [
                { type: 'added', filePath: 'Notes/New Note.md', title: 'New Note' },
                { type: 'changed', filePath: 'Notes/Existing.md', title: 'Existing' },
            ],
        };
        await service.writeChangelog('packs/my-pack', changelog);
        const content = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
        expect(content).toContain('**From revision:** 1');
        expect(content).toContain('**To revision:** 2');
        expect(content).toContain('Added: 1');
        expect(content).toContain('Changed: 2');
        expect(content).toContain('ADDED');
        expect(content).toContain('New Note');
    });

    it('writes changelog with no entries when summary is all zeros', async () => {
        const changelog: Changelog = {
            fromRevision: 1,
            toRevision: 1,
            generatedAt: '2026-01-02T00:00:00.000Z',
            summary: { added: 0, removed: 0, changed: 0 },
            entries: [],
        };
        await service.writeChangelog('packs/my-pack', changelog);
        const content = (app.vault.create as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
        expect(content).toContain('Changelog');
        expect(content).not.toContain('## Changes');
    });
});

describe('WriterService.ensureFolder', () => {
    it('creates folder when it does not exist', async () => {
        const app = makeApp();
        const service = new WriterService(app);
        await service.ensureFolder('packs/new-folder');
        expect(app.vault.createFolder).toHaveBeenCalledWith('packs/new-folder');
    });

    it('does not create folder when it already exists', async () => {
        const app = makeApp();
        (app.vault as unknown as { _files: Map<string, TFile | TFolder> })._files.set('packs/existing', createTFolder('packs/existing'));
        const service = new WriterService(app);
        await service.ensureFolder('packs/existing');
        // createFolder should NOT be called if folder exists
        // (getAbstractFileByPath returns truthy for 'packs/existing')
        expect(app.vault.createFolder).not.toHaveBeenCalled();
    });
});
