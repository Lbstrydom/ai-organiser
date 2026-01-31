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
        ]);

        expect(prompt).toContain('<task>');
        expect(prompt).toContain('<pairs>');
        expect(prompt).toContain('<output_format>');
        expect(prompt).toContain('Note A');
        expect(prompt).toContain('Note B');
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
});
