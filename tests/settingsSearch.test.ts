import { describe, it, expect } from 'vitest';
import { matchesQuery, planSearch, type SearchableSection } from '../src/ui/settings/settingsSearch';

const sections: SearchableSection[] = [
    { id: 'ai-provider', texts: ['AI provider', 'API key'], children: [] },
    { id: 'integrations', texts: ['Integrations'], children: [
        { id: 'sub-ai-workspaces', texts: ['AI workspaces', 'Folders AI apps may see'] },
        { id: 'sub-google-tasks', texts: ['Google Tasks export', 'Your lists'] },
    ] },
];

describe('settings search', () => {
    it('matches every word, case-insensitively', () => {
        expect(matchesQuery(['AI workspaces'], 'workspaces ai')).toBe(true);
        expect(matchesQuery(['AI workspaces'], 'workspace kindle')).toBe(false);
        expect(matchesQuery(['x'], '   ')).toBe(true);
    });
    it('finds AI workspaces settings inside Integrations, opening only that sub-section', () => {
        const plan = planSearch(sections, 'workspaces');
        expect([...plan.visible]).toEqual(['integrations']);
        expect(plan.open.has('sub-ai-workspaces')).toBe(true);
        expect(plan.open.has('sub-google-tasks')).toBe(false);
    });
    it('no match: nothing visible (the tab then says so)', () => {
        expect(planSearch(sections, 'zzz').visible.size).toBe(0);
    });
});
