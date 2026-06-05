import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProviderProfile } from '../src/services/providerProfile';
import type { AdapterType } from '../src/services/adapters';

// Deterministic model resolution per provider.
vi.mock('../src/services/specialistModelResolver', () => ({ resolveForProvider: vi.fn() }));
import { resolveForProvider } from '../src/services/specialistModelResolver';
import {
    resolvePresentationRole, settingForRole, providerFamily, familyOf,
    type RoleResolveContext, type PresentationModelRoles,
} from '../src/services/presentationIr/presentationModelResolver';

const MODELS: Record<string, string> = {
    claude: 'claude-opus-4-6', 'azure-claude': 'claude-sonnet-4-6',
    openai: 'gpt-5.3', 'azure-openai': 'gpt-5.3', gemini: 'gemini-2.5-pro',
};

function profile(provider: AdapterType | 'local', model = 'main-model'): ProviderProfile {
    return { provider, model, valid: true, mode: 'personal', providerLabel: String(provider), endpointHost: '', keySource: 'x' } as unknown as ProviderProfile;
}
function ctx(mainProvider: AdapterType, roles: PresentationModelRoles, keys: AdapterType[] = []): RoleResolveContext {
    return { profile: profile(mainProvider), roles, hasKey: (p) => keys.includes(p) };
}

beforeEach(() => vi.mocked(resolveForProvider).mockImplementation((p) => MODELS[p] ?? 'resolved-model'));

describe('settingForRole + providerFamily', () => {
    it('maps the 5 roles to 2 settings (M8)', () => {
        expect(settingForRole('storyboard_generator')).toBe('storyboardGenerator');
        expect(settingForRole('storyboard_disambiguator')).toBe('storyboardGenerator');
        expect(settingForRole('storyboard_repair')).toBe('storyboardGenerator');
        expect(settingForRole('structural_critic')).toBe('independentCritic');
        expect(settingForRole('visual_critic')).toBe('independentCritic');
    });
    it('maps providers to a safe coarse family', () => {
        expect(providerFamily('claude')).toBe('claude');
        expect(providerFamily('azure-claude')).toBe('claude');
        expect(providerFamily('openai')).toBe('openai');
        expect(providerFamily('azure-openai')).toBe('openai');
        expect(providerFamily('gemini')).toBe('gemini');
        expect(providerFamily('groq')).toBe('other');
        expect(providerFamily('local')).toBe('other');
    });
});

describe('resolvePresentationRole', () => {
    it('null → Main (no override, not cross-provider)', () => {
        const r = resolvePresentationRole('storyboard_generator', ctx('claude', { storyboardGenerator: null, independentCritic: null }));
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toMatchObject({ provider: 'claude', modelOverride: '', crossProvider: false, family: 'claude' });
    });

    it('same provider as main → modelOverride switches the model (not cross-provider)', () => {
        const r = resolvePresentationRole('storyboard_generator', ctx('claude', { storyboardGenerator: 'claude', independentCritic: null }), );
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toMatchObject({ provider: 'claude', modelOverride: 'claude-opus-4-6', crossProvider: false });
    });

    it('a different provider WITH a key → cross-provider (specialist service), no modelOverride', () => {
        const r = resolvePresentationRole('structural_critic', ctx('claude', { storyboardGenerator: null, independentCritic: 'openai' }, ['openai']));
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toMatchObject({ provider: 'openai', modelOverride: '', crossProvider: true, family: 'openai' });
        if (r.ok) expect(r.value.warning).toBeUndefined(); // different family from the claude generator → good
    });

    it('a different provider WITHOUT a key → falls back to Main with a warning', () => {
        const r = resolvePresentationRole('structural_critic', ctx('claude', { storyboardGenerator: null, independentCritic: 'openai' }, []));
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.provider).toBe('claude');
            expect(r.value.crossProvider).toBe(false);
            expect(r.value.warning).toMatch(/No API key for openai/);
        }
    });

    it('a critic sharing the generator family is flagged (independence reduced)', () => {
        // main=claude generator (Main → claude); critic=azure-claude → same 'claude' family.
        const r = resolvePresentationRole('structural_critic', ctx('claude', { storyboardGenerator: null, independentCritic: 'azure-claude' }, ['azure-claude']));
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.warning).toMatch(/shares the generator's claude/);
    });

    it('flags an obviously weak tier (haiku critic)', () => {
        vi.mocked(resolveForProvider).mockReturnValue('claude-haiku-4-6');
        const r = resolvePresentationRole('structural_critic', ctx('openai', { storyboardGenerator: null, independentCritic: 'claude' }, ['claude']));
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.warning).toMatch(/low tier/);
    });

    it('an unknown/corrupt provider string falls back to Main (audit H4/M6)', () => {
        const r = resolvePresentationRole('storyboard_generator', ctx('claude', { storyboardGenerator: 'totally-bogus', independentCritic: null }));
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.provider).toBe('claude');
            expect(r.value.crossProvider).toBe(false);
            expect(r.value.warning).toMatch(/Unknown provider/);
        }
    });

    it('a multi-family gateway is classed by its resolved MODEL, not just the provider (audit M10/M14)', () => {
        // openrouter is an ambiguous gateway → provider-only would be 'other'; the
        // model id reveals the real family for the independence check.
        vi.mocked(resolveForProvider).mockReturnValue('claude-opus-4-6');
        const r = resolvePresentationRole('structural_critic', ctx('claude', { storyboardGenerator: null, independentCritic: 'openrouter' }, ['openrouter']));
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.family).toBe('claude');                 // refined from the model
            expect(r.value.warning).toMatch(/shares the generator's claude/); // now correctly flagged
        }
    });
});

describe('familyOf', () => {
    it('refines an ambiguous gateway by its model, keeps unambiguous providers', () => {
        expect(familyOf('groq', 'llama-3.3-70b')).toBe('other');
        expect(familyOf('openrouter', 'claude-opus-4-6')).toBe('claude');
        expect(familyOf('bedrock', 'gpt-5.3')).toBe('openai');
        expect(familyOf('vertex', 'gemini-2.5-pro')).toBe('gemini');
        expect(familyOf('claude', 'anything')).toBe('claude'); // provider wins for unambiguous
    });
});
