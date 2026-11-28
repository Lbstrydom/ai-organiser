import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, type AIOrganiserSettings } from '../src/core/settings';
import {
    MODEL_NAME_GROUPS, MODEL_NAME_KEYS, cleanNewName, listModelNames, replaceModelName, replaceModelNameAndSave, touchesSearchModel,
} from '../src/services/modelNames/modelNameSettings';

const settings = (patch: Partial<AIOrganiserSettings>): AIOrganiserSettings =>
    ({ ...structuredClone(DEFAULT_SETTINGS), ...patch });

describe('replaceModelName', () => {
    const OLD = 'claude-old';
    const make = () => settings({
        cloudModel: OLD,
        pdfModel: OLD,
        providerSettings: { 'azure-claude': { model: OLD, apiKey: OLD }, openai: { model: 'gpt-x' } },
        azureCapabilities: { websearch: { mode: 'azure', deployment: OLD } } as AIOrganiserSettings['azureCapabilities'],
        taskModels: { ...DEFAULT_SETTINGS.taskModels, audit: OLD },
        presentationModelRoles: { storyboardGenerator: OLD, independentCritic: null },
        azurePerDeploymentRpm: { [OLD]: 42 },
        interfaceLanguage: OLD as AIOrganiserSettings['interfaceLanguage'],
    });

    it('changes every setting holding the name and nothing else', () => {
        const s = make();
        const changed = replaceModelName(s, OLD, 'claude-new');
        expect(changed.sort()).toEqual([
            'azureCapabilities.websearch.deployment', 'azurePerDeploymentRpm.claude-old', 'cloudModel', 'pdfModel',
            'presentationModelRoles.storyboardGenerator', 'providerSettings.azure-claude.model', 'taskModels.audit',
        ]);
        expect(s.cloudModel).toBe('claude-new');
        expect(s.providerSettings['azure-claude']).toEqual({ model: 'claude-new', apiKey: OLD });
        expect(s.providerSettings.openai?.model).toBe('gpt-x');
        expect(s.azurePerDeploymentRpm).toEqual({ 'claude-new': 42 });
        expect(s.interfaceLanguage).toBe(OLD); // not a model setting
        expect(listModelNames(s).map(n => n.name)).not.toContain(OLD);
    });

    it('keeps an existing request limit for the new name', () => {
        const s = settings({ azurePerDeploymentRpm: { a: 1, b: 2 } });
        replaceModelName(s, 'a', 'b');
        expect(s.azurePerDeploymentRpm).toEqual({ b: 2 });
    });

    it('works for local and direct cloud providers', () => {
        const s = settings({ localModel: 'llama3:8b', providerSettings: { openai: { model: 'llama3:8b' } } });
        expect(replaceModelName(s, 'llama3:8b', 'llama4:8b').sort()).toEqual(['localModel', 'providerSettings.openai.model']);
    });

    it('changes nothing for an unusable new name', () => {
        for (const bad of ['', '  ', 'claude-old', 'two words', '__proto__']) {
            const s = make();
            expect(replaceModelName(s, OLD, bad)).toEqual([]);
            expect(s.cloudModel).toBe(OLD);
        }
        expect(cleanNewName('a', '  b ')).toBe('b');
    });

    it('flags a search model change', () => {
        expect(touchesSearchModel(['cloudModel'])).toBe(false);
        expect(touchesSearchModel(['azureDeployments.embeddings'])).toBe(true);
    });
});

describe('replaceModelNameAndSave', () => {
    it('puts the old names back when saving fails, and a retry then succeeds', async () => {
        const s = settings({ cloudModel: 'a', providerSettings: { openai: { model: 'a' } }, azurePerDeploymentRpm: { 'a': 5 } });
        const failed = await replaceModelNameAndSave(s, 'a', 'b', () => Promise.reject(new Error('disk')));
        expect(failed).toEqual({ ok: false, error: 'model-replace-unsaved' });
        expect([s.cloudModel, s.providerSettings.openai?.model, s.azurePerDeploymentRpm]).toEqual(['a', 'a', { a: 5 }]);

        const retried = await replaceModelNameAndSave(s, 'a', 'b', () => Promise.resolve());
        expect(retried.ok && retried.value.length).toBe(3);
        expect(s.cloudModel).toBe('b');
    });

    it('keeps what was edited while the failed save was running', async () => {
        const s = settings({ cloudModel: 'a', pdfModel: 'a', providerSettings: { openai: { model: 'a' } }, azurePerDeploymentRpm: { a: 5, b: 9 } });
        await replaceModelNameAndSave(s, 'a', 'b', () => {
            s.pdfModel = 'chosen-meanwhile';
            s.providerSettings.openai!.apiKey = 'typed-meanwhile';
            s.azurePerDeploymentRpm.c = 1;
            return Promise.reject(new Error('disk'));
        });
        expect(s.cloudModel).toBe('a');
        expect(s.pdfModel).toBe('chosen-meanwhile');
        expect(s.providerSettings.openai).toEqual({ model: 'a', apiKey: 'typed-meanwhile' });
        expect(s.azurePerDeploymentRpm).toEqual({ a: 5, b: 9, c: 1 });
    });

    it('does not save when nothing changes', async () => {
        let saves = 0;
        await replaceModelNameAndSave(settings({}), 'absent', 'b', async () => { saves++; });
        expect(saves).toBe(0);
    });
});

describe('coverage of model settings', () => {
    /** Named like a model setting, but holds no name. */
    const NOT_A_NAME = ['azurePerDeploymentRpm'];

    it('every text or object setting named after a model or deployment is covered', () => {
        const covered = new Set<string>([...MODEL_NAME_KEYS, ...MODEL_NAME_GROUPS, ...NOT_A_NAME]);
        const candidates = Object.entries(DEFAULT_SETTINGS)
            .filter(([key, value]) => /model|deployment/i.test(key) && (typeof value === 'string' || (value !== null && typeof value === 'object')))
            .map(([key]) => key);
        expect(candidates.length).toBeGreaterThan(8); // positive control
        expect(candidates.filter(key => !covered.has(key))).toEqual([]);
    });
});
