import type { ContentPart, MultimodalCapability } from '../adapters/types';
import {
    ConnectionTestError,
    ConnectionTestResult,
    GenerateTagsResponse,
    LanguageCode,
    LLMResponse,
    MultimodalLLMService,
    SummarizeOptions,
} from '../types';
import { TaggingMode } from '../prompts/types';

/**
 * Fail-closed LLM service (D2).
 *
 * Installed by `initializeLLMService` when `mode === 'azure' && !valid` —
 * a misconfigured Azure setup. Every method returns the standard failed
 * `LLMCallResult` shape (`{ success:false, error }`) and makes **no network
 * call whatsoever**.
 *
 * It is a SEPARATE class (not a `disabled` flag on `CloudLLMService`) so there
 * is no two-mode service and no method can "forget" the guard — the negative
 * test ("no personal-Anthropic call fires in misconfigured Azure mode") holds
 * structurally: this class has no HTTP code path at all.
 */
export class NullLLMService implements MultimodalLLMService {
    private readonly error: string;

    constructor(error: string) {
        this.error = error;
    }

    private fail(): { success: false; error: string } {
        return { success: false, error: this.error };
    }

    // All methods are non-async (return resolved Promises) — there is no
    // network path and nothing to await, by design (the fail-closed guarantee).
    summarizeText(_prompt: string, _options?: SummarizeOptions): Promise<{ success: boolean; content?: string; error?: string }> {
        return Promise.resolve(this.fail());
    }

    summarizeTextStream(
        _prompt: string,
        _onChunk: (chunk: string) => void,
        _signal?: AbortSignal,
        _options?: SummarizeOptions,
    ): Promise<{ success: boolean; content?: string; error?: string }> {
        return Promise.resolve(this.fail());
    }

    sendMultimodal(
        _parts: ContentPart[],
        _options?: { maxTokens?: number },
    ): Promise<{ success: boolean; content?: string; error?: string }> {
        return Promise.resolve(this.fail());
    }

    getMultimodalCapability(): MultimodalCapability {
        return 'text-only';
    }

    analyzeTags(
        _content: string,
        _candidateTags: string[],
        _mode: TaggingMode,
        _maxTags: number,
        _language?: LanguageCode,
    ): Promise<LLMResponse> {
        return Promise.resolve({ success: false });
    }

    generateTags(_prompt: string): Promise<GenerateTagsResponse> {
        return Promise.resolve({ success: false, error: this.error });
    }

    testConnection(): Promise<{ result: ConnectionTestResult; error?: ConnectionTestError }> {
        return Promise.resolve({ result: ConnectionTestResult.Failed, error: { type: 'unknown', message: this.error } });
    }

    formatRequest(_prompt: string, _language?: string): Record<string, unknown> {
        return {};
    }

    dispose(): Promise<void> {
        // No resources to release.
        return Promise.resolve();
    }

    setDebugMode(_enabled: boolean): void {
        // No-op.
    }

    setSummarizeTimeout(_seconds: number): void {
        // No-op.
    }

    getModelName(): string {
        return '';
    }
}
