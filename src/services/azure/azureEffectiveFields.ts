/**
 * Which stored value a deployment field on the settings screen edits, and which
 * Advanced settings differ from their defaults. The precedence mirrors
 * `endpointResolver` / `resolveAzureCapability`; a test holds them together.
 */
import { DEFAULT_SETTINGS, type AIOrganiserSettings } from '../../core/settings';
import { PROVIDER_ENDPOINT } from '../adapters/providerRegistry';
import { claudeSupportsAdaptiveThinking } from '../adapters/modelCapabilities';
import { defaultModeFor, getCapability } from './azureCapabilities';

/** Capabilities whose deployment name is edited inside its settings group. */
export type DeploymentFieldId = 'embeddings' | 'transcription' | 'tts' | 'websearch';

export interface DeploymentField {
    value: string;
    /** Where an edit is written: the per-feature override, or the shared setting. */
    source: 'capability' | 'legacy';
    /** A per-feature override is in effect in place of a shared setting. */
    isOverride: boolean;
}

function capabilityValue(s: AIOrganiserSettings, id: DeploymentFieldId): string {
    const raw = s.azureCapabilities?.[id]?.deployment;
    return typeof raw === 'string' ? raw.trim() : '';
}

export function resolveDeploymentField(s: AIOrganiserSettings, id: DeploymentFieldId): DeploymentField {
    const override = capabilityValue(s, id);
    if (id === 'tts' || id === 'websearch') return { value: override, source: 'capability', isOverride: false };
    if (override) return { value: override, source: 'capability', isOverride: true };
    const legacy = id === 'embeddings' ? s.azureDeployments?.embeddings : s.azureWhisperDeployment;
    return { value: legacy ?? '', source: 'legacy', isOverride: false };
}

/** Writes to the source the field was rendered from; the capability mode is kept. */
export function setDeploymentField(
    s: AIOrganiserSettings,
    id: DeploymentFieldId,
    source: DeploymentField['source'],
    value: string,
): void {
    if (source === 'capability') {
        if (!s.azureCapabilities) s.azureCapabilities = {};
        const prev = s.azureCapabilities[id];
        s.azureCapabilities[id] = { mode: prev?.mode ?? 'azure', deployment: value.trim() };
        return;
    }
    if (id === 'embeddings') {
        if (!s.azureDeployments) s.azureDeployments = {};
        s.azureDeployments.embeddings = value;
        return;
    }
    if (id === 'transcription') s.azureWhisperDeployment = value;
}

export interface AdvancedContext {
    /** A dedicated Azure Speech key is saved (SecretStorage lookups are async). */
    speechKeySet?: boolean;
}

export interface AdvancedSetting<Id extends string> {
    id: Id;
    isOverride(s: AIOrganiserSettings, ctx: AdvancedContext): boolean;
}

const rpmMapKey = (map: Record<string, number> | undefined): string =>
    JSON.stringify(Object.entries(map ?? {}).sort(([a], [b]) => a.localeCompare(b)));

export type AzureAdvancedId =
    | 'routing' | 'claude-gateway' | 'max-concurrent' | 'max-rpm' | 'deployment-rpm'
    | 'speech-key' | 'max-speakers' | 'in-region-only' | 'youtube' | 'debug';

/** The Azure layout's Advanced controls, in screen order. */
export const AZURE_ADVANCED: ReadonlyArray<AdvancedSetting<AzureAdvancedId>> = [
    { id: 'routing', isOverride: (s) => s.azureRoutingMode !== DEFAULT_SETTINGS.azureRoutingMode },
    { id: 'claude-gateway', isOverride: (s) => !!s.azureClaudeViaOpenAIGateway !== DEFAULT_SETTINGS.azureClaudeViaOpenAIGateway },
    { id: 'max-concurrent', isOverride: (s) => s.azureMaxConcurrentRequests !== DEFAULT_SETTINGS.azureMaxConcurrentRequests },
    { id: 'max-rpm', isOverride: (s) => s.azureMaxRpm !== DEFAULT_SETTINGS.azureMaxRpm },
    { id: 'deployment-rpm', isOverride: (s) => rpmMapKey(s.azurePerDeploymentRpm) !== rpmMapKey(DEFAULT_SETTINGS.azurePerDeploymentRpm) },
    { id: 'speech-key', isOverride: (s, ctx) => !!ctx.speechKeySet || !!s.azureSpeechApiKey },
    { id: 'max-speakers', isOverride: (s) => s.azureSpeechMaxSpeakers !== DEFAULT_SETTINGS.azureSpeechMaxSpeakers },
    { id: 'in-region-only', isOverride: (s) => !!s.azureSpeechRequired !== DEFAULT_SETTINGS.azureSpeechRequired },
    {
        id: 'youtube',
        isOverride: (s) => {
            const mode = s.azureCapabilities?.youtube?.mode;
            return !!mode && mode !== defaultModeFor(getCapability('youtube'));
        },
    },
    { id: 'debug', isOverride: (s) => !!s.debugMode },
];

export type StandardAdvancedId = 'endpoint' | 'thinking' | 'debug';

/** Built-in providers keep their endpoint under Advanced; others need it on screen. */
export function endpointIsAdvanced(provider: AIOrganiserSettings['cloudServiceType']): boolean {
    return provider !== 'openai-compatible' && !!PROVIDER_ENDPOINT[provider];
}

export function showsThinkingMode(s: AIOrganiserSettings): boolean {
    return s.serviceType === 'cloud' && s.cloudServiceType === 'claude' && claudeSupportsAdaptiveThinking(s.cloudModel);
}

/** Advanced controls shown for a non-Azure setup. */
export function standardAdvancedSettings(s: AIOrganiserSettings): Array<AdvancedSetting<StandardAdvancedId>> {
    const out: Array<AdvancedSetting<StandardAdvancedId>> = [];
    if (s.serviceType === 'cloud' && endpointIsAdvanced(s.cloudServiceType)) {
        out.push({
            id: 'endpoint',
            isOverride: (v) => !!v.cloudEndpoint && v.cloudEndpoint !== PROVIDER_ENDPOINT[v.cloudServiceType],
        });
    }
    if (showsThinkingMode(s)) {
        out.push({ id: 'thinking', isOverride: (v) => v.claudeThinkingMode !== DEFAULT_SETTINGS.claudeThinkingMode });
    }
    out.push({ id: 'debug', isOverride: (v) => !!v.debugMode });
    return out;
}

export function countAdvancedOverrides(
    s: AIOrganiserSettings,
    list: ReadonlyArray<AdvancedSetting<string>>,
    ctx: AdvancedContext = {},
): number {
    return list.filter((d) => d.isOverride(s, ctx)).length;
}
