/**
 * Recognises "that model or deployment does not exist" across providers, and adds the
 * next step to the error. Every other error is returned unchanged.
 *
 * Shapes: Azure `DeploymentNotFound`; OpenAI / Groq / LM Studio `model_not_found`;
 * Anthropic `not_found_error` with "model: <id>"; Gemini "models/<id> is not found";
 * OpenRouter "is not a valid model ID"; Mistral "Invalid model: <id>"; Bedrock
 * "model identifier is invalid"; Ollama "model '<id>' not found".
 */
import { getTranslations } from '../../i18n';
import { formatGuidance } from '../../core/friendlyErrors';

const NOT_FOUND_CODES = new Set(['deploymentnotfound', 'model_not_found', 'unknown_model']);

const NOT_FOUND_MESSAGES: readonly RegExp[] = [
    /\bdeployment\b.{0,80}\b(does not exist|not found)\b/i,
    /\bmodel\b.{0,120}\b(does not exist|not found)\b/i,
    /\bmodels\/\S+ is not found\b/i,
    /\bis not a valid model\b/i,
    /^invalid model:/i,
    /\bmodel identifier is invalid\b/i,
];

interface ErrorParts { codes: string[]; message: string }

const asRecord = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === 'object' ? v as Record<string, unknown> : {};

function readError(body: string): ErrorParts {
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return { codes: [], message: body.slice(0, 500) };
    }
    // Gemini's OpenAI-compatible surface wraps the object in an array.
    const root = asRecord(Array.isArray(parsed) ? parsed[0] : parsed);
    const error = asRecord(root.error);
    const message = [root.error, error.message, root.message].find((v): v is string => typeof v === 'string') ?? '';
    const codes = [error.code, error.type, root.code].filter((v): v is string => typeof v === 'string');
    return { codes: codes.map(c => c.toLowerCase()), message };
}

export function isModelNotFound(status: number, body: string): boolean {
    if (status !== 400 && status !== 404) return false;
    const { codes, message } = readError(body ?? '');
    if (codes.some(c => NOT_FOUND_CODES.has(c))) return true;
    if (codes.includes('not_found_error') && /^model\b/i.test(message)) return true;
    return NOT_FOUND_MESSAGES.some(pattern => pattern.test(message));
}

/** The name the request actually carried: the body, else the URL, else the configured model. */
export function requestedModelName(body: unknown, url: string, configured: string): string {
    const fromBody = asRecord(body).model;
    if (typeof fromBody === 'string' && fromBody) return fromBody;
    const fromUrl = /\/(?:deployments|models|model)\/([^/:?]+)/.exec(url)?.[1];
    return fromUrl ? decodeURIComponent(fromUrl) : configured;
}

/** `message` plus the next step when the provider says the model does not exist. */
export function withModelGuidance(message: string, status: number, body: string, model: string): string {
    if (!isModelNotFound(status, body)) return message;
    const t = getTranslations();
    const named = model ? ` ${t.modals.modelReplace.requestedName}: "${model}".` : '';
    return `${message} — ${formatGuidance(t.guidance['model-not-found'])}${named}`;
}
