import { buildClusterPrompt, buildEdgeLabelPrompt } from '../src/services/prompts/canvasPrompts';

describe('Canvas Prompts', () => {
    it('buildEdgeLabelPrompt should include XML tags and pairs', () => {
        const prompt = buildEdgeLabelPrompt([
            {
                fromTitle: 'Note A',
                fromSnippet: 'Alpha',
                toTitle: 'Note B',
                toSnippet: 'Beta',
                pairIndex: 0
            }
        ], 'English');

        expect(prompt).toContain('<task>');
        expect(prompt).toContain('<pairs>');
        expect(prompt).toContain('<output_format>');
        expect(prompt).toContain('Note A');
        expect(prompt).toContain('Note B');
    });

    it('buildEdgeLabelPrompt should include language in requirements', () => {
        const prompt = buildEdgeLabelPrompt([
            { fromTitle: 'A', fromSnippet: 'a', toTitle: 'B', toSnippet: 'b', pairIndex: 0 }
        ], 'French');

        expect(prompt).toContain('<requirements>');
        expect(prompt).toContain('French');
    });

    it('buildEdgeLabelPrompt should render pair indexes correctly', () => {
        const prompt = buildEdgeLabelPrompt([
            { fromTitle: 'A', fromSnippet: 'a', toTitle: 'B', toSnippet: 'b', pairIndex: 0 },
            { fromTitle: 'C', fromSnippet: 'c', toTitle: 'D', toSnippet: 'd', pairIndex: 1 }
        ], 'English');

        expect(prompt).toContain('[Pair 0]');
        expect(prompt).toContain('[Pair 1]');
    });

    it('buildEdgeLabelPrompt with empty pairs should still have structure', () => {
        const prompt = buildEdgeLabelPrompt([], 'English');

        expect(prompt).toContain('<task>');
        expect(prompt).toContain('<pairs>');
        expect(prompt).toContain('<output_format>');
    });

    it('buildClusterPrompt should include tag and note titles', () => {
        const prompt = buildClusterPrompt(
            'research',
            [
                { title: 'Note One', snippet: 'Snippet one' },
                { title: 'Note Two', snippet: 'Snippet two' }
            ],
            'English'
        );

        expect(prompt).toContain('research');
        expect(prompt).toContain('Note One');
        expect(prompt).toContain('Note Two');
        expect(prompt).toContain('<notes>');
        expect(prompt).toContain('<output_format>');
    });

    it('buildClusterPrompt should include language in requirements', () => {
        const prompt = buildClusterPrompt('topic', [{ title: 'T', snippet: 'S' }], 'German');

        expect(prompt).toContain('<requirements>');
        expect(prompt).toContain('German');
    });

    it('buildClusterPrompt should include snippets', () => {
        const prompt = buildClusterPrompt('topic', [
            { title: 'Note', snippet: 'This is a snippet of text' }
        ], 'English');

        expect(prompt).toContain('This is a snippet of text');
    });

    it('buildClusterPrompt with empty notes should still have structure', () => {
        const prompt = buildClusterPrompt('tag', [], 'English');

        expect(prompt).toContain('<task>');
        expect(prompt).toContain('<notes>');
        expect(prompt).toContain('<output_format>');
    });
});
