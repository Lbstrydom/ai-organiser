/**
 * Presentation model resolver (plan Cluster B / Phase 4) — a THIN resolver built
 * ON the existing model infra (`specialistModelResolver`, `modelCapabilities`,
 * `providerProfile`, `providerRegistry`); it introduces NO new model catalog (plan
 * M1). It maps the pipeline's 5 logical roles to the 2 user-facing settings (M8),
 * resolves each to a concrete provider + `latest-*`-resolved model, and applies the
 * cross-family-independence + competence invariant for the critic.
 *
 * Phases 1-3 do NOT depend on this (they use the configured main model); it's
 * additive — the generator role can opt a role onto a different provider, and the
 * Cluster D critic resolves through `independent_critic` for a cross-family check.
 */
import type { Result } from '../../core/result';
import { ok } from '../../core/result';
import type { AdapterType } from '../adapters';
import type { ProviderProfile } from '../providerProfile';
import type { Fidelity } from '../types';
import { resolveForProvider } from '../specialistModelResolver';
import { PROVIDER_DEFAULT_MODEL, ALL_ADAPTERS } from '../adapters/providerRegistry';
import { parseClaudeModel, parseGeminiModel, parseOpenAIModel } from '../adapters/modelCapabilities';

export type PresentationRole =
    | 'storyboard_generator' | 'storyboard_disambiguator' | 'storyboard_repair'
    | 'structural_critic' | 'visual_critic';

/** The 2 user-facing settings the 5 roles collapse onto (plan M8). */
export type RoleSettingKey = 'storyboardGenerator' | 'independentCritic';

export type ProviderFamily = 'claude' | 'openai' | 'gemini' | 'other';

export interface PresentationModelRoles {
    /** A provider id (CloudServiceType/AdapterType) or null = "Main" (configured provider). */
    storyboardGenerator: string | null;
    independentCritic: string | null;
}

export interface RoleResolveContext {
    /** From `resolveProviderProfile(plugin)` — the configured main provider + model. */
    profile: ProviderProfile;
    roles: PresentationModelRoles;
    /** Key-presence probe (a chosen non-main provider needs a key, else we fall back to Main). */
    hasKey: (provider: AdapterType) => boolean;
}

export interface ResolvedRole {
    provider: AdapterType | 'local';
    /** Concrete model id, resolved from the provider's `latest-*` sentinel. */
    resolvedModel: string;
    /** For a SAME-provider role: the model override to pass through. '' = use the configured main model. */
    modelOverride: string;
    /** True when the role runs on a DIFFERENT provider than main — caller must build a specialist service (modelOverride alone can't switch adapters). */
    crossProvider: boolean;
    family: ProviderFamily;
    /** Non-fatal advisory (missing key → Main, shared family, weak tier). */
    warning?: string;
    /** True when the CHOSEN provider could not be used (unknown id, no key) and this is the main provider instead. */
    fellBackToMain?: boolean;
}

/** Map a logical role to its backing user setting (M8: generator-voice vs critic). */
export function settingForRole(role: PresentationRole): RoleSettingKey {
    return role === 'structural_critic' || role === 'visual_critic' ? 'independentCritic' : 'storyboardGenerator';
}

/** Coarse, SAFE family map — only the unambiguous single-family providers; everything else is 'other' (won't false-match the independence check). */
export function providerFamily(provider: AdapterType | 'local'): ProviderFamily {
    if (provider === 'claude' || provider === 'azure-claude') return 'claude';
    if (provider === 'openai' || provider === 'azure-openai') return 'openai';
    if (provider === 'gemini') return 'gemini';
    return 'other'; // local / bedrock / vertex / groq / … (multi-family or unknown)
}

/**
 * Family of a resolved role — refines an ambiguous multi-family gateway (OpenRouter,
 * Bedrock, Vertex, Groq, …) by parsing its concrete MODEL id (audit M10/M14), so a
 * gateway running Claude is recognised as the 'claude' family for the independence check.
 */
export function familyOf(provider: AdapterType | 'local', model: string): ProviderFamily {
    const byProvider = providerFamily(provider);
    if (byProvider !== 'other') return byProvider;
    if (parseClaudeModel(model)) return 'claude';
    if (parseGeminiModel(model)) return 'gemini';
    if (parseOpenAIModel(model)) return 'openai';
    return 'other';
}

export type Independence = 'same' | 'different' | 'unknown';

/**
 * A call's model identity when it is CONCRETE (llm-option-fidelity D1): a model id the
 * response reported, or one sent in this call's body (`per-call`). An alias, a
 * service-config name or a deployment name is routing evidence only and yields null.
 */
/** A `latest-*` sentinel or a provider `*-latest` alias names whatever model is current, not a fixed one. */
function isAliasId(model: string): boolean {
    return /(^|[-_.:/])latest($|[-_.:/])/i.test(model);
}

function concreteIdentity(f: Fidelity | undefined): { provider: Fidelity['provider']; model: string } | null {
    if (!f) return null;
    if (f.reportedModel) {
        // A provider can echo back an alias; an alias is routing evidence, not an identity.
        return isAliasId(f.reportedModel) ? null : { provider: f.provider, model: f.reportedModel };
    }
    if (f.routing === 'per-call' && f.requestedModel && !isAliasId(f.requestedModel)) {
        return { provider: f.provider, model: f.requestedModel };
    }
    return null;
}

/**
 * Compare the generator's and the critic's ACTUAL model identity after the calls ran
 * (D1/D3). `same` and `different` need two concrete identities; everything else,
 * including a missing `fidelity`, is `unknown` — never independent. Equal routing
 * evidence never proves `same`, and unequal routing evidence never proves `different`.
 */
export function independenceFor(generator: Fidelity | undefined, critic: Fidelity | undefined): Independence {
    const g = concreteIdentity(generator);
    const c = concreteIdentity(critic);
    if (!g || !c) return 'unknown';
    if (g.provider === c.provider) return g.model === c.model ? 'same' : 'different';
    const gf = familyOf(g.provider, g.model);
    const cf = familyOf(c.provider, c.model);
    return gf !== 'other' && cf !== 'other' && gf !== cf ? 'different' : 'unknown';
}

/** Light competence heuristic — flag obviously weak tiers for a reasoning/critic role. */
function isWeakTier(provider: AdapterType | 'local', model: string): boolean {
    if (provider === 'claude' || provider === 'azure-claude') return parseClaudeModel(model)?.tier === 'haiku';
    if (provider === 'gemini') {
        const t = parseGeminiModel(model)?.tier;
        return t === 'flash' || t === 'nano';
    }
    return false;
}

function mainResolution(profile: ProviderProfile, warning?: string, fellBackToMain = false): ResolvedRole {
    return {
        provider: profile.provider,
        resolvedModel: profile.model,
        modelOverride: '',
        crossProvider: false,
        family: familyOf(profile.provider, profile.model),
        ...(warning ? { warning } : {}),
        ...(fellBackToMain ? { fellBackToMain: true } : {}),
    };
}

/**
 * Resolve the provider + model for a presentation role. Never throws. Falls back
 * to Main (with a warning) when the chosen provider has no key. For a critic that
 * ends up sharing the generator's family, returns a (non-fatal) independence warning.
 */
export function resolvePresentationRole(role: PresentationRole, ctx: RoleResolveContext): Result<ResolvedRole> {
    const key = settingForRole(role);
    const chosen = ctx.roles[key];

    if (!chosen) return ok(mainResolution(ctx.profile)); // "Main"

    // Validate the persisted provider string before casting (audit H4/M6) — an
    // unknown/corrupt value falls back to Main instead of resolving garbage.
    if (!(ALL_ADAPTERS as readonly string[]).includes(chosen)) {
        return ok(mainResolution(ctx.profile, `Unknown provider "${chosen}" for this role — using the main provider instead.`, true));
    }
    const provider = chosen as AdapterType;
    const isMain = provider === ctx.profile.provider;
    if (!isMain && !ctx.hasKey(provider)) {
        return ok(mainResolution(ctx.profile, `No API key for ${provider} — using the main provider instead.`, true));
    }

    const resolvedModel = resolveForProvider(provider, '') || PROVIDER_DEFAULT_MODEL[provider] || '';
    const result: ResolvedRole = {
        provider,
        resolvedModel,
        // Same-provider → switch the model via modelOverride; cross-provider → the
        // caller builds a specialist service for `provider` (adapters can't be
        // switched by modelOverride alone).
        modelOverride: isMain ? resolvedModel : '',
        crossProvider: !isMain,
        family: familyOf(provider, resolvedModel),
    };

    const warnings: string[] = [];
    if (key === 'independentCritic') {
        const gen = resolvePresentationRole('storyboard_generator', ctx);
        if (gen.ok && gen.value.family !== 'other' && gen.value.family === result.family) {
            warnings.push(`Critic shares the generator's ${result.family} model family — cross-family independence is reduced.`);
        }
    }
    if (isWeakTier(provider, resolvedModel)) {
        warnings.push('The chosen model is a low tier; a stronger model is recommended for this role.');
    }
    if (warnings.length) result.warning = warnings.join(' ');
    return ok(result);
}
