import { describe, it, expect } from 'vitest';
import { consultantStoryboardSchema } from '../src/services/presentationIr/consultantStoryboard';
import type { ConsultantStoryboard } from '../src/services/presentationIr/consultantStoryboard';
import { storyboardToMarkdown, SLIDE_ANCHOR } from '../src/services/presentationIr/dotDashSerializer';
import type { StructuralFinding } from '../src/services/chat/consultantAuditService';

function sb(obj: unknown): ConsultantStoryboard {
    const r = consultantStoryboardSchema.safeParse(obj);
    if (!r.success) throw new Error('fixture invalid: ' + JSON.stringify(r.error.issues));
    return r.data as ConsultantStoryboard;
}

const storyboard = sb({
    schemaVersion: 1,
    thesis: 'Growth was regionally concentrated',
    slides: [{
        id: 's1', role: 'insight', action_title: 'EMEA drove 60% of Q3 growth',
        core_message: 'EMEA led every region', evidence_span_ids: ['e1'],
        suggested_visual: 'bar',
        visual_data: { type: 'bar', unit: '%', items: [{ label: 'EMEA', value: 60, evidence_span_id: 'e1' }] },
    }],
});

describe('storyboardToMarkdown', () => {
    it('renders the deck name, thesis, and a hidden review guide', () => {
        const md = storyboardToMarkdown(storyboard, { deckName: 'Q3 Review' });
        expect(md).toContain('# Q3 Review');
        expect(md).toContain('> **Thesis:** Growth was regionally concentrated');
        expect(md).toContain('Build slides from this storyline');
    });

    it('renders each slide as a ## action title with the hidden machine anchor + dot-dash', () => {
        const md = storyboardToMarkdown(storyboard);
        expect(md).toContain('## EMEA drove 60% of Q3 growth');
        expect(md).toContain(`<!-- ${SLIDE_ANCHOR}`);
        expect(md).toContain('- EMEA led every region');
        expect(md).toContain('> visual: bar');
    });

    it('the anchor carries the full visual_data + evidence ids (round-trippable)', () => {
        const md = storyboardToMarkdown(storyboard);
        const anchorLine = md.split('\n').find((l) => l.includes(SLIDE_ANCHOR));
        expect(anchorLine).toBeTruthy();
        expect(anchorLine).toContain('"visual_data"');
        expect(anchorLine).toContain('"evidence_span_ids":["e1"]');
    });

    it('shows ✓ no issues when a slide is clean', () => {
        const md = storyboardToMarkdown(storyboard);
        expect(md).toContain('⚠ Storyline check: ✓ no issues');
    });

    it('renders audit findings inline under the slide they belong to', () => {
        const bySlide = new Map<string, StructuralFinding[]>([
            ['s1', [{ slideId: 's1', dimension: 'action-title', severity: 'minor', message: 'Title may be a label.' }]],
        ]);
        const md = storyboardToMarkdown(storyboard, { bySlide });
        expect(md).toContain('[minor/action-title] Title may be a label.');
    });

    it('renders deck-level findings (empty-key) above the slides', () => {
        const bySlide = new Map<string, StructuralFinding[]>([
            ['', [{ dimension: 'mece', severity: 'major', message: 'Slides 2 and 3 overlap.' }]],
        ]);
        const md = storyboardToMarkdown(storyboard, { bySlide });
        const deckIdx = md.indexOf('Slides 2 and 3 overlap.');
        const firstSlideIdx = md.indexOf('## EMEA drove 60%');
        expect(deckIdx).toBeGreaterThan(-1);
        expect(deckIdx).toBeLessThan(firstSlideIdx); // deck-level findings precede the slides
    });
});
