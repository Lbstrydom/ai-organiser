/**
 * Azure specialist-capability registry — the single source of truth (SSOT) for
 * what each Azure Foundry surface CAN serve and the explicit bring-your-own
 * (BYO) alternatives. Drives BOTH the Azure settings UI and the resolution
 * helper, so adding/changing a capability is one edit here (Open/Closed).
 *
 * Neutral module: NO Obsidian / DOM imports → fully unit-testable.
 *
 * Plan: docs/plans/azure-capability-flexibility.md
 */

import type { FeatureId } from '../../core/features';

/** Capabilities that, in Azure mode, need explicit per-capability routing.
 *  (PDF + vision ride the MAIN provider; diarization is standalone Deepgram —
 *  neither is in this matrix.) */
export type AzureCapabilityId =
    | 'transcription'
    | 'embeddings'
    | 'visual-embeddings'
    | 'tts'
    | 'websearch'
    | 'youtube';

export const AZURE_CAPABILITY_IDS: readonly AzureCapabilityId[] = Object.freeze([
    'transcription', 'embeddings', 'visual-embeddings', 'tts', 'websearch', 'youtube',
]);

/**
 * `full`    → Azure can do it (configure a deployment) — default mode `azure`.
 * `partial` → Azure can, but with a caveat (web search needs the azure-claude
 *             surface + a Claude deployment when main = azure-openai).
 * `none`    → Azure has no path (YouTube) → must BYO or the feature is off.
 */
export type AzureSupport = 'full' | 'partial' | 'none';

/** Which existing specialist-config subsystem owns the BYO provider/key/model
 *  for a capability (D2 — the Azure map NEVER stores provider/key/model). */
/** `visual-embedding` is DEDICATED (Gemini-R3 G2) — it must NEVER alias `embedding`,
 *  whose check reads TEXT-lane config (EMBEDDING secret / embeddingProvider / local-onnx
 *  bypass) and would silently authorize visual page-image traffic on text settings,
 *  breaking the C5/C22 consent isolation. */
export type ByoConfigKind = 'embedding' | 'visual-embedding' | 'transcription' | 'tts' | 'research' | 'youtube';

export type AzureSurface = 'azure-openai' | 'azure-claude';

export interface AzureCapabilityDef {
    id: AzureCapabilityId;
    support: AzureSupport;
    /** Foundry surface that serves this capability when mode==='azure' (null when support==='none'). */
    surface: AzureSurface | null;
    /** Whether mode==='azure' needs a deployment name field. */
    needsDeployment: boolean;
    /** Existing specialist subsystem the BYO path delegates to (null when support==='none' has no BYO either — n/a here). */
    byoConfigKind: ByoConfigKind;
    /** Dependent features (OR semantics): the settings row renders if ANY is enabled. */
    featureFlags: readonly FeatureId[];
    /** i18n key suffixes under t.settings.azureCapabilities.<id>.* */
    labelKey: string;
    descKey: string;
}

/**
 * The registry. `tts.support === 'full'` because the Azure Speech engine ships
 * in the same release (plan D3). `websearch` is `partial` — it runs on the
 * azure-claude surface even when main = azure-openai (needs a Claude deployment).
 */
export const AZURE_CAPABILITIES: Readonly<Record<AzureCapabilityId, AzureCapabilityDef>> = Object.freeze({
    transcription: {
        id: 'transcription',
        support: 'full',
        surface: 'azure-openai',
        needsDeployment: true,
        byoConfigKind: 'transcription',
        featureFlags: ['minutes', 'summarize'],
        labelKey: 'transcription', descKey: 'transcriptionDesc',
    },
    embeddings: {
        id: 'embeddings',
        support: 'full',
        surface: 'azure-openai',
        needsDeployment: true,
        byoConfigKind: 'embedding',
        featureFlags: ['semantic-search'],
        labelKey: 'embeddings', descKey: 'embeddingsDesc',
    },
    'visual-embeddings': {
        id: 'visual-embeddings',
        // Azure CAN serve Cohere embed-v-4-0 (Foundry `/models` routes), but whether the
        // tenant's deployment accepts IMAGE input is probe-gated (DP-2/C3) — the resolver
        // only says where to route; the probe decides azure-vs-byo at the lane level.
        // Surface is azure-claude because the Foundry `/models` routes live on the SAME
        // resource + key as the Claude surface (`azureAIEndpoint`, services.ai.azure.com).
        support: 'partial',
        surface: 'azure-claude',
        needsDeployment: true,
        byoConfigKind: 'visual-embedding',
        featureFlags: ['visual-search'],
        labelKey: 'visualEmbeddings', descKey: 'visualEmbeddingsDesc',
    },
    websearch: {
        id: 'websearch',
        support: 'partial',
        surface: 'azure-claude',
        needsDeployment: true,
        byoConfigKind: 'research',
        featureFlags: ['research', 'presentation'],
        labelKey: 'websearch', descKey: 'websearchDesc',
    },
    tts: {
        id: 'tts',
        support: 'full',
        surface: 'azure-openai',
        needsDeployment: true,
        byoConfigKind: 'tts',
        featureFlags: ['audio-narration', 'newsletter'],
        labelKey: 'tts', descKey: 'ttsDesc',
    },
    youtube: {
        id: 'youtube',
        support: 'none',
        surface: null,
        needsDeployment: false,
        byoConfigKind: 'youtube',
        featureFlags: ['summarize'],
        labelKey: 'youtube', descKey: 'youtubeDesc',
    },
});

export function getCapability(id: AzureCapabilityId): AzureCapabilityDef {
    return AZURE_CAPABILITIES[id];
}

export function listCapabilities(): readonly AzureCapabilityDef[] {
    return AZURE_CAPABILITY_IDS.map((id) => AZURE_CAPABILITIES[id]);
}

/** Per-capability stored choice. Provider/key/model for BYO live in the
 *  EXISTING specialist settings + SecretStorage (D2) — never here. */
export interface AzureCapabilityChoice {
    mode: 'azure' | 'byo' | 'off';
    /** Only when mode==='azure' && def.needsDeployment. The per-capability deployment SSOT (H1). */
    deployment?: string;
}

/**
 * The default mode when no explicit choice exists (used by BOTH migration's
 * last-resort fallback and a missing runtime entry, so the two never diverge —
 * H5). `none`-support → `byo`; otherwise → `azure`. An `azure` default with a
 * blank deployment then resolves `unavailable('no-deployment')` (never silently
 * "working").
 */
export function defaultModeFor(def: AzureCapabilityDef): AzureCapabilityChoice['mode'] {
    return def.support === 'none' ? 'byo' : 'azure';
}

/** UI situation badge derived from support (✓ full / ⚠ partial / ✗ none). */
export function azureSituation(def: AzureCapabilityDef): 'has' | 'partial' | 'none' {
    if (def.support === 'full') return 'has';
    if (def.support === 'partial') return 'partial';
    return 'none';
}
