/**
 * Azure config export/import — lets a team share a working Azure setup
 * (endpoints, routing mode, deployment names, RPM overrides, default model,
 * Speech region/voice, …) as one pasted JSON blob instead of a field-by-field
 * walkthrough. NEVER includes secrets (`azureApiKey` or anything in
 * SecretStorage) — recipients still enter their own key.
 *
 * Defensive on import: pasted JSON is untrusted input. Each field is type-
 * checked before being applied; a malformed or missing field is skipped
 * rather than throwing or wiping the setting to an empty value.
 */

import type { AIOrganiserSettings } from '../../core/settings';

/** The exported shape. Keep in sync with the field list in both functions below. */
export interface AzureConfigExport {
    schemaVersion: 1;
    azureAIEndpoint?: string;
    azureOpenAIEndpoint?: string;
    azureRoutingMode?: 'model-based' | 'deployment-based';
    azureDeployments?: { chat?: string; embeddings?: string };
    azureGPTModel?: string;
    azureWhisperDeployment?: string;
    azureApiVersionOverride?: { whisper?: string; chat?: string; embeddings?: string };
    azureClaudeViaOpenAIGateway?: boolean;
    azureCapabilities?: unknown;
    azurePerDeploymentRpm?: Record<string, number>;
    azureMaxConcurrentRequests?: number;
    azureMaxRpm?: number;
    taskModels?: {
        tagging?: string;
        summarization?: string;
        chat?: string;
        mermaid?: string;
    };
    azureSpeechRegion?: string;
    azureSpeechEndpoint?: string;
    azureSpeechVoice?: string;
    azureSpeechMaxSpeakers?: number;
    azureSpeechRequired?: boolean;
}

/** Pure — builds the exportable, secret-free config snapshot. */
export function buildAzureConfigExport(settings: AIOrganiserSettings): AzureConfigExport {
    return {
        schemaVersion: 1,
        azureAIEndpoint: settings.azureAIEndpoint,
        azureOpenAIEndpoint: settings.azureOpenAIEndpoint,
        azureRoutingMode: settings.azureRoutingMode,
        azureDeployments: { ...settings.azureDeployments },
        azureGPTModel: settings.azureGPTModel,
        azureWhisperDeployment: settings.azureWhisperDeployment,
        azureApiVersionOverride: { ...settings.azureApiVersionOverride },
        azureClaudeViaOpenAIGateway: settings.azureClaudeViaOpenAIGateway,
        azureCapabilities: settings.azureCapabilities,
        azurePerDeploymentRpm: { ...settings.azurePerDeploymentRpm },
        azureMaxConcurrentRequests: settings.azureMaxConcurrentRequests,
        azureMaxRpm: settings.azureMaxRpm,
        taskModels: {
            tagging: settings.taskModels?.tagging,
            summarization: settings.taskModels?.summarization,
            chat: settings.taskModels?.chat,
            mermaid: settings.taskModels?.mermaid,
        },
        azureSpeechRegion: settings.azureSpeechRegion,
        azureSpeechEndpoint: settings.azureSpeechEndpoint,
        azureSpeechVoice: settings.azureSpeechVoice,
        azureSpeechMaxSpeakers: settings.azureSpeechMaxSpeakers,
        azureSpeechRequired: settings.azureSpeechRequired,
    };
}

/** Result of an import attempt — which top-level fields were actually applied. */
export interface AzureConfigImportResult {
    ok: boolean;
    appliedFields: string[];
    error?: string;
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Mutates `settings` in place with any well-typed fields found in `raw`
 * (parsed JSON, untrusted). Never throws. Returns which fields were applied,
 * so the caller can show the user exactly what changed.
 */
export function applyAzureConfigImport(settings: AIOrganiserSettings, raw: unknown): AzureConfigImportResult {
    if (!isPlainObject(raw)) return { ok: false, appliedFields: [], error: 'Not a valid config object' };
    const applied: string[] = [];

    if (isString(raw.azureAIEndpoint)) { settings.azureAIEndpoint = raw.azureAIEndpoint; applied.push('azureAIEndpoint'); }
    if (isString(raw.azureOpenAIEndpoint)) { settings.azureOpenAIEndpoint = raw.azureOpenAIEndpoint; applied.push('azureOpenAIEndpoint'); }
    if (raw.azureRoutingMode === 'model-based' || raw.azureRoutingMode === 'deployment-based') {
        settings.azureRoutingMode = raw.azureRoutingMode;
        applied.push('azureRoutingMode');
    }
    if (isPlainObject(raw.azureDeployments)) {
        const chat = isString(raw.azureDeployments.chat) ? raw.azureDeployments.chat : settings.azureDeployments?.chat;
        const embeddings = isString(raw.azureDeployments.embeddings) ? raw.azureDeployments.embeddings : settings.azureDeployments?.embeddings;
        settings.azureDeployments = { chat, embeddings };
        applied.push('azureDeployments');
    }
    if (isString(raw.azureGPTModel)) { settings.azureGPTModel = raw.azureGPTModel; applied.push('azureGPTModel'); }
    if (isString(raw.azureWhisperDeployment)) { settings.azureWhisperDeployment = raw.azureWhisperDeployment; applied.push('azureWhisperDeployment'); }
    if (isPlainObject(raw.azureApiVersionOverride)) {
        const o = raw.azureApiVersionOverride;
        settings.azureApiVersionOverride = {
            whisper: isString(o.whisper) ? o.whisper : settings.azureApiVersionOverride?.whisper,
            chat: isString(o.chat) ? o.chat : settings.azureApiVersionOverride?.chat,
            embeddings: isString(o.embeddings) ? o.embeddings : settings.azureApiVersionOverride?.embeddings,
        };
        applied.push('azureApiVersionOverride');
    }
    if (isBoolean(raw.azureClaudeViaOpenAIGateway)) { settings.azureClaudeViaOpenAIGateway = raw.azureClaudeViaOpenAIGateway; applied.push('azureClaudeViaOpenAIGateway'); }
    if (isPlainObject(raw.azureCapabilities)) {
        settings.azureCapabilities = raw.azureCapabilities as typeof settings.azureCapabilities;
        applied.push('azureCapabilities');
    }
    if (isPlainObject(raw.azurePerDeploymentRpm)) {
        const clean: Record<string, number> = {};
        for (const [k, v] of Object.entries(raw.azurePerDeploymentRpm)) {
            if (isNumber(v)) clean[k] = v;
        }
        if (Object.keys(clean).length > 0) {
            settings.azurePerDeploymentRpm = { ...settings.azurePerDeploymentRpm, ...clean };
            applied.push('azurePerDeploymentRpm');
        }
    }
    if (isNumber(raw.azureMaxConcurrentRequests)) { settings.azureMaxConcurrentRequests = raw.azureMaxConcurrentRequests; applied.push('azureMaxConcurrentRequests'); }
    if (isNumber(raw.azureMaxRpm)) { settings.azureMaxRpm = raw.azureMaxRpm; applied.push('azureMaxRpm'); }
    if (isPlainObject(raw.taskModels)) {
        const tm = raw.taskModels;
        const value = isString(tm.chat) ? tm.chat : (isString(tm.tagging) ? tm.tagging : undefined);
        if (value && settings.taskModels) {
            settings.taskModels.tagging = value;
            settings.taskModels.summarization = value;
            settings.taskModels.chat = value;
            settings.taskModels.mermaid = value;
            applied.push('taskModels');
        }
    }
    if (isString(raw.azureSpeechRegion)) { settings.azureSpeechRegion = raw.azureSpeechRegion; applied.push('azureSpeechRegion'); }
    if (isString(raw.azureSpeechEndpoint)) { settings.azureSpeechEndpoint = raw.azureSpeechEndpoint; applied.push('azureSpeechEndpoint'); }
    if (isString(raw.azureSpeechVoice)) { settings.azureSpeechVoice = raw.azureSpeechVoice; applied.push('azureSpeechVoice'); }
    if (isNumber(raw.azureSpeechMaxSpeakers)) { settings.azureSpeechMaxSpeakers = raw.azureSpeechMaxSpeakers; applied.push('azureSpeechMaxSpeakers'); }
    if (isBoolean(raw.azureSpeechRequired)) { settings.azureSpeechRequired = raw.azureSpeechRequired; applied.push('azureSpeechRequired'); }

    return { ok: applied.length > 0, appliedFields: applied, error: applied.length === 0 ? 'No recognized fields found' : undefined };
}
