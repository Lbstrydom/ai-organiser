/**
 * The Azure "GPT model" setting and the model chat sends.
 *
 * With Azure OpenAI as the main provider, the chat service is built from
 * `cloudModel`, so a change to `azureGPTModel` has to carry over. These run only
 * on an explicit user action (picker, config import): stored values that already
 * differ are never rewritten on load.
 */
import type { AIOrganiserSettings } from '../../core/settings';
import { AZURE_DEFAULT_GPT_MODEL } from '../../core/azureDefaults';

/** A blank value (an imported empty setting) changes nothing. */
export function applyAzureGptModel(settings: AIOrganiserSettings, value: string): void {
    const model = value.trim();
    if (!model) return;
    settings.azureGPTModel = model;
    if (settings.cloudServiceType === 'azure-openai') settings.cloudModel = model;
}

/** The model a request to the Azure OpenAI chat surface actually carries. */
export function effectiveAzureGptModel(
    settings: { cloudServiceType?: string; cloudModel?: string; azureGPTModel?: string },
): string {
    const model = settings.cloudServiceType === 'azure-openai' ? settings.cloudModel : settings.azureGPTModel;
    return model || AZURE_DEFAULT_GPT_MODEL;
}
