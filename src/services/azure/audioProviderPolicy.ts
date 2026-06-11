/**
 * AudioProviderPolicy — the SINGLE call-time compliance/availability guard for
 * every audio entry point (plan D5/D8). Evaluates CURRENT settings on every
 * call, so a stale persisted provider (e.g. `openai-gpt-audio` left behind from
 * a non-Azure session) fails CLOSED instead of leaking egress (R1-M7).
 *
 * Consulted by `prepareNarration`, TTS engine selection, the transcription
 * service, and Minutes/coordinator diarization selection — compliance is
 * code-enforced at every entry, not just the UI.
 *
 * The matrix (plan D3/D5):
 *  - NON-AZURE mode: Azure surfaces (`azure-speech`, `azure-openai`) refused —
 *    everything else (gemini / deepgram / openai / groq / openai-gpt-audio) allowed.
 *  - AZURE mode + `azureSpeechRequired` STRICT: ONLY `azure-speech` allowed.
 *    Whisper / `/audio/speech` (Global-Standard) AND all BYO providers
 *    (gemini, deepgram, gpt-audio) are refused — never a silent fallback.
 *  - AZURE mode, strict OFF (default, backward-compat): legacy `azure-openai`
 *    + `azure-speech` + BYO allowed; `openai-gpt-audio` is the ONE exception —
 *    it is OpenAI-direct Global-Standard and selectable only when NOT in Azure
 *    mode (D5), so it is refused in Azure mode regardless of strict.
 *
 * Decision is on the RESOLVED surface + op + strict flag, not providerId alone
 * (R2-M1). Pure-ish: reads settings only; availability (keys/config) is the
 * capability resolver's job, allowed/denied is this module's. Never throws.
 */

import { type Result, ok, err } from '../../core/result';
import { isAzureMode } from './endpointResolver';

export type AudioOp = 'tts' | 'stt' | 'diarization';

/** Provider/surface ids that can appear at audio entry points. */
export type AudioProviderId =
    | 'azure-speech'      // Azure AI Speech (in-region) — TTS + STT + diarization
    | 'azure-openai'      // Azure OpenAI Whisper / /audio/speech (Global-Standard legacy)
    | 'gemini'            // BYO Gemini TTS
    | 'deepgram'          // BYO Deepgram diarization
    | 'openai'            // BYO OpenAI Whisper
    | 'groq'              // BYO Groq Whisper
    | 'openai-gpt-audio'; // gpt-audio-1.5 (OpenAI-direct, Global-Standard — private/BYO ONLY)

export interface AudioPolicyQuery {
    op: AudioOp;
    /** Typically an {@link AudioProviderId}; kept open (string) because the guard
     *  must fail CLOSED on unknown/stale persisted ids, not reject them at compile time. */
    providerId: string;
    /** The capability-resolved surface when the caller has one (R2-M1) —
     *  decides for resolver-routed calls where providerId may be generic. */
    resolvedSurface?: string;
}

export type AudioPolicyDenialReason =
    | 'not-azure-mode'            // azure surface invoked while main provider is not Azure
    | 'strict-speech-required'    // strict mode: only azure-speech is permitted
    | 'gpt-audio-requires-non-azure' // D5: gpt-audio is private/BYO only
    | 'unknown-provider'          // id not in the known audio-provider set — fail closed (D8)
    | 'op-mismatch';              // provider cannot serve this operation (e.g. deepgram TTS)

/** Operations each provider can serve — denies nonsensical combinations
 *  (e.g. `deepgram` for TTS, `gemini` for diarization) at the policy layer. */
const PROVIDER_OPS: Record<AudioProviderId, readonly AudioOp[]> = {
    'azure-speech': ['tts', 'stt', 'diarization'],
    'azure-openai': ['tts', 'stt'],
    gemini: ['tts'],
    deepgram: ['diarization'],
    openai: ['stt'],
    groq: ['stt'],
    'openai-gpt-audio': ['tts', 'stt'],
};

function isKnownProvider(id: string): id is AudioProviderId {
    return Object.prototype.hasOwnProperty.call(PROVIDER_OPS, id);
}

/** Typed denial prefix — callers can parse `policy-denied:<reason>`. */
export function policyDenied(reason: AudioPolicyDenialReason): Result<void> {
    return err(`policy-denied:${reason}`);
}

interface PolicySettings {
    cloudServiceType?: string;
    azureSpeechRequired?: boolean;
}

/** Minimal plugin shape — settings only (testable without a full plugin). */
export interface AudioPolicyHost {
    settings: PolicySettings;
}

export function assertAllowed(plugin: AudioPolicyHost, q: AudioPolicyQuery): Result<void> {
    const settings = plugin.settings ?? {};
    const azure = isAzureMode(settings);
    // The effective surface under judgement: an explicit resolution wins (R2-M1).
    const surface = q.resolvedSurface || q.providerId;

    // Fail CLOSED on ids outside the known provider set (D8: a stale/garbage
    // persisted provider must never slip past the guard), and deny provider/op
    // combinations the provider cannot serve.
    if (!isKnownProvider(surface)) return policyDenied('unknown-provider');
    if (!PROVIDER_OPS[surface].includes(q.op)) return policyDenied('op-mismatch');

    if (!azure) {
        // Azure surfaces need Azure mode (creds/endpoints live there) — refuse.
        if (surface === 'azure-speech' || surface === 'azure-openai') {
            return policyDenied('not-azure-mode');
        }
        return ok(undefined);
    }

    if (settings.azureSpeechRequired === true) {
        // Strict (Wärtsilä): azure-speech ONLY. Whisper, /audio/speech, gpt-audio,
        // gemini, deepgram — all refused fail-closed (plan D3, keystone H2).
        return surface === 'azure-speech' ? ok(undefined) : policyDenied('strict-speech-required');
    }

    // Azure mode, strict OFF: legacy + BYO stay reachable (backward-compat #18),
    // EXCEPT gpt-audio — OpenAI-direct egress is never offered in Azure mode (D5).
    if (surface === 'openai-gpt-audio') {
        return policyDenied('gpt-audio-requires-non-azure');
    }
    return ok(undefined);
}
