/**
 * The Azure model settings: what chat sends, and what describes it.
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

/**
 * The "Claude deployment" setting: one value for every task slot, and the chat
 * model when Azure Claude is the main provider. A blank value changes nothing.
 */
export function applyAzureClaudeDeployment(settings: AIOrganiserSettings, value: string): void {
    const deployment = value.trim();
    if (!deployment) return;
    const tasks = settings.taskModels;
    if (tasks) tasks.tagging = tasks.summarization = tasks.chat = tasks.mermaid = deployment;
    if (settings.cloudServiceType === 'azure-claude') settings.cloudModel = deployment;
}

type CapabilitySettings = Pick<AIOrganiserSettings, 'cloudServiceType' | 'cloudModel' | 'azureClaudeModel'>;

/**
 * The "Claude model" setting, when it describes this request: the main Azure
 * Claude deployment. Anything else (another provider or deployment) is undefined.
 */
export function azureCapabilityModel(settings: CapabilitySettings, provider: string, modelName: string): string | undefined {
    if (provider !== 'azure-claude' || settings.cloudServiceType !== 'azure-claude') return undefined;
    return modelName === settings.cloudModel ? settings.azureClaudeModel?.trim() || undefined : undefined;
}

/** What limits and capabilities of the main cloud model are read from. Never sent in a request. */
export function mainCapabilityModel(settings: CapabilitySettings): string {
    return azureCapabilityModel(settings, settings.cloudServiceType, settings.cloudModel) ?? settings.cloudModel;
}
