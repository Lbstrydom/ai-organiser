import type { TFile } from 'obsidian';
import { computeMaxNotes, deterministicClustering, parseClusterResponse } from '../src/services/canvas/clusterBoard';

function createFile(path: string, folderName: string): TFile {
    return {
        path,
        basename: path.split('/').pop()?.replace('.md', '') || path,
        parent: { name: folderName }
    } as unknown as TFile;
}

describe('Cluster Board', () => {
    it('deterministicClustering should group by folder', () => {
        const files = [
            createFile('FolderA/Note1.md', 'FolderA'),
            createFile('FolderB/Note2.md', 'FolderB'),
            createFile('FolderA/Note3.md', 'FolderA')
        ];

        const clusters = deterministicClustering(files, 'topic');
        const labels = clusters.map(c => c.label);

        expect(labels).toContain('FolderA');
        expect(labels).toContain('FolderB');
    });

    it('deterministicClustering should group by subtag when in same folder', () => {
        const files = [
            createFile('FolderA/Note1.md', 'FolderA'),
            createFile('FolderA/Note2.md', 'FolderA'),
            createFile('FolderA/Note3.md', 'FolderA')
        ];

        const tagMap = new Map<string, string[]>([
            ['FolderA/Note1.md', ['topic/alpha']],
            ['FolderA/Note2.md', ['topic/beta']],
            ['FolderA/Note3.md', ['topic/alpha']]
        ]);

        const originalApp = (globalThis as any).app;
        (globalThis as any).app = {
            metadataCache: {
                getFileCache: (file: TFile) => ({ frontmatter: { tags: tagMap.get(file.path) || [] } })
            }
        };

        const clusters = deterministicClustering(files, 'topic');
        const labels = clusters.map(c => c.label);

        expect(labels).toContain('alpha');
        expect(labels).toContain('beta');

        (globalThis as any).app = originalApp;
    });

    it('computeMaxNotes should return a reasonable number', () => {
        const value = computeMaxNotes(500, 4000);
        expect(value).toBeGreaterThan(0);
        expect(value).toBeLessThan(50);
    });

    it('parseClusterResponse should parse valid JSON', () => {
        const response = '{"clusters":[{"label":"Group A","noteIndexes":[0,1]}]}';
        const clusters = parseClusterResponse(response, 2);
        expect(clusters).not.toBeNull();
        expect(clusters![0].label).toBe('Group A');
        expect(clusters![0].nodeIds).toEqual(['0', '1']);
    });

    it('parseClusterResponse should return null on malformed response', () => {
        const clusters = parseClusterResponse('invalid', 3);
        expect(clusters).toBeNull();
    });
});
