import type { App, TFile } from 'obsidian';
import { computeMaxNotes, deterministicClustering, parseClusterResponse } from '../src/services/canvas/clusterBoard';

function createFile(path: string, folderName: string): TFile {
    return {
        path,
        basename: path.split('/').pop()?.replace('.md', '') || path,
        parent: { name: folderName }
    } as unknown as TFile;
}

function createMockApp(tagMap?: Map<string, string[]>): App {
    return {
        metadataCache: {
            getFileCache: (file: TFile) => {
                const tags = tagMap?.get(file.path) || [];
                return { frontmatter: { tags } };
            }
        }
    } as unknown as App;
}

describe('Cluster Board', () => {
    it('deterministicClustering should group by folder', () => {
        const app = createMockApp();
        const files = [
            createFile('FolderA/Note1.md', 'FolderA'),
            createFile('FolderB/Note2.md', 'FolderB'),
            createFile('FolderA/Note3.md', 'FolderA')
        ];

        const clusters = deterministicClustering(app, files, 'topic');
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

        const app = createMockApp(tagMap);
        const clusters = deterministicClustering(app, files, 'topic');
        const labels = clusters.map(c => c.label);

        expect(labels).toContain('alpha');
        expect(labels).toContain('beta');
    });

    it('deterministicClustering should chunk fallback when all same folder and no subtags', () => {
        const app = createMockApp();
        const files = Array.from({ length: 8 }, (_, i) =>
            createFile(`Folder/Note${i}.md`, 'Folder')
        );

        const clusters = deterministicClustering(app, files, 'topic');

        // Should fall back to chunk-based grouping (chunk size 6)
        expect(clusters.length).toBe(2);
        expect(clusters[0].label).toBe('Group 1');
        expect(clusters[0].nodeIds).toHaveLength(6);
        expect(clusters[1].label).toBe('Group 2');
        expect(clusters[1].nodeIds).toHaveLength(2);
    });

    it('computeMaxNotes should return exact value for known inputs', () => {
        // (500/4 + 50) = 175 tokens per note → 4000/175 = 22.857 → floor = 22
        expect(computeMaxNotes(500, 4000)).toBe(22);
    });

    it('computeMaxNotes should return minimum of 1', () => {
        expect(computeMaxNotes(99999, 100)).toBe(1);
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

    it('parseClusterResponse should return null for empty string', () => {
        expect(parseClusterResponse('', 3)).toBeNull();
    });

    it('parseClusterResponse should parse code fence JSON', () => {
        const response = '```json\n{"clusters":[{"label":"Tech","noteIndexes":[0]}]}\n```';
        const clusters = parseClusterResponse(response, 1);
        expect(clusters).not.toBeNull();
        expect(clusters![0].label).toBe('Tech');
    });

    it('parseClusterResponse should accept alternative keys (notes, indices)', () => {
        const response = '{"clusters":[{"label":"Alt","notes":[0,1]}]}';
        const clusters = parseClusterResponse(response, 2);
        expect(clusters).not.toBeNull();
        expect(clusters![0].nodeIds).toEqual(['0', '1']);
    });
});
