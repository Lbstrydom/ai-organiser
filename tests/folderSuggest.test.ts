import { describe, it, expect } from 'vitest';
import { filterFolders } from '../src/ui/settings/components/FolderSuggest';
import { createTFolder } from './mocks/obsidian';

function folders(...paths: string[]) {
    return paths.map(p => createTFolder(p));
}

describe('filterFolders (FolderSuggest suggestion filtering)', () => {
    it('matches case-insensitively by substring', () => {
        const all = folders('AI-Organiser/Canvas', 'AI-Organiser/Exports', 'Daily Notes');
        const result = filterFolders(all, 'canvas').map(f => f.path);
        expect(result).toEqual(['AI-Organiser/Canvas']);
    });

    it('matches a substring anywhere in the path', () => {
        const all = folders('Projects/Brand', '999_Brand', 'Inbox');
        const result = filterFolders(all, 'brand').map(f => f.path);
        expect(result).toEqual(['999_Brand', 'Projects/Brand']);
    });

    it('returns all folders for an empty query, sorted by path', () => {
        const all = folders('Charlie', 'Alpha', 'Bravo');
        const result = filterFolders(all, '').map(f => f.path);
        expect(result).toEqual(['Alpha', 'Bravo', 'Charlie']);
    });

    it('returns an empty array when nothing matches', () => {
        const all = folders('A', 'B');
        expect(filterFolders(all, 'nomatch')).toEqual([]);
    });

    it('sorts matches by path', () => {
        const all = folders('z/one', 'a/two', 'm/three');
        const result = filterFolders(all, '/').map(f => f.path);
        expect(result).toEqual(['a/two', 'm/three', 'z/one']);
    });
});
