/**
 * Settings stage chips (planStageFilter): a pressed stage keeps only that stage's sections and
 * sub-sections; umbrellas stay and open when a sub-section matches; stage-less sections leave.
 */
import { describe, it, expect } from 'vitest';
import { planStageFilter, type StagedSection } from '../src/ui/settings/settingsSearch';

const sections: StagedSection[] = [
    { id: 'features', stage: null, children: [] },
    { id: 'tagging', stage: 'refine', children: [] },
    { id: 'meeting-minutes', stage: 'create', children: [] },
    { id: 'ai-chat', stage: 'find', children: [{ id: 'sub-pres-models', stage: null }] },
    { id: 'integrations', stage: null, children: [
        { id: 'sub-inbox-sweep', stage: 'refine' },
        { id: 'sub-find-embeds', stage: 'maintain' },
        { id: 'sub-vault-upkeep', stage: 'maintain' },
    ] },
    { id: 'preferences', stage: null, children: [{ id: 'sub-interface', stage: null }] },
];

describe('settings stage chips', () => {
    it('keeps only the stage\'s sections and sub-sections, and opens the umbrella', () => {
        const plan = planStageFilter(sections, 'maintain');
        expect([...plan.visible].sort()).toEqual(['integrations', 'sub-find-embeds', 'sub-vault-upkeep']);
        expect([...plan.open]).toEqual(['integrations']);
    });

    it('a sub-section with no stage of its own follows its parent', () => {
        const plan = planStageFilter(sections, 'find');
        expect([...plan.visible].sort()).toEqual(['ai-chat', 'sub-pres-models']);
        expect(plan.open.size).toBe(0);
    });

    it('sections with no stage anywhere leave the list', () => {
        for (const stage of ['capture', 'create', 'refine', 'find', 'maintain'] as const) {
            const plan = planStageFilter(sections, stage);
            expect(plan.visible.has('features')).toBe(false);
            expect(plan.visible.has('preferences')).toBe(false);
        }
    });

    it('a stage with nothing in it shows nothing', () => {
        expect(planStageFilter(sections, 'capture').visible.size).toBe(0);
    });
});
