/**
 * Apps Script transport: the one place that talks to a user-owned Google Apps Script web app.
 *
 * Shared by the cloud inventory and the Google Tasks export, so the same rules apply to both:
 *
 *  - Endpoint policy: only `https://script.google.com/macros/s/<id>/exec` is accepted, checked on
 *    save and again before every send.
 *  - The secret travels only in the POST body. Obsidian's `requestUrl` follows Google's redirect to
 *    `script.googleusercontent.com`; a redirect after a POST becomes a GET without a body, so the
 *    secret is never replayed. It is also redacted from every message and log line.
 *  - Failures are classified into stable codes (each has user guidance): a Google sign-in page means
 *    the deployment's access is wrong; `auth` means the secret or script is out of date; and so on.
 *  - Retries (exponential backoff, at most 5 attempts) happen only for `drive-error`, `busy`, server
 *    errors and network errors, never for `auth` or `not-approved`.
 */
import { requestUrl } from 'obsidian';
import { Result, ok, err } from '../core/result';
import { logger } from '../utils/logger';

export const SCRIPT_URL_PATTERN = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;

/** Validate a pasted web app link. */
export function validateScriptUrl(url: string): Result<string> {
    const trimmed = url.trim();
    return SCRIPT_URL_PATTERN.test(trimmed) ? ok(trimmed) : err('script-invalid-endpoint');
}

export type ScriptErrorCode =
    | 'script-invalid-endpoint'
    | 'script-login-page'
    | 'script-auth'
    | 'script-not-approved'
    | 'script-bad-request'
    | 'script-drive-error'
    | 'script-network'
    | 'script-bad-response';

/** What one HTTP exchange returned. */
export interface ScriptHttpResponse {
    status: number;
    text: string;
}

export type ScriptTransport = (request: { url: string; body: string }) => Promise<ScriptHttpResponse>;

/** The real transport: Obsidian's `requestUrl` (works on mobile, unlike `fetch` to Google). */
export const defaultTransport: ScriptTransport = async ({ url, body }) => {
    const res = await requestUrl({ url, method: 'POST', contentType: 'application/json', body, throw: false });
    return { status: res.status, text: res.text };
};

export interface CallOptions {
    url: string;
    secret: string;
    body: Record<string, unknown>;
    transport?: ScriptTransport;
    /** Injectable for tests */
    sleep?: (ms: number) => Promise<void>;
    maxAttempts?: number;
    baseDelayMs?: number;
    signal?: AbortSignal;
}

/** Remove the secret from any text before it is shown or logged. */
export function redact(text: string, secret: string): string {
    return secret ? text.split(secret).join('[secret]') : text;
}

const REMOTE_CODES: Record<string, ScriptErrorCode> = {
    auth: 'script-auth',
    'not-approved': 'script-not-approved',
    'bad-request': 'script-bad-request',
    'drive-error': 'script-drive-error',
};

const RETRYABLE = new Set<ScriptErrorCode>(['script-drive-error', 'script-network']);

/** Interpret one response. Pure. */
export function parseScriptResponse<T>(response: ScriptHttpResponse): Result<T> {
    if (response.status >= 500) return err('script-drive-error');
    if (response.status === 401 || response.status === 403) return err('script-login-page');
    const text = response.text;
    // Google returns an HTML sign-in page (not JSON) when the deployment is not open to "Anyone".
    if (text.trimStart().startsWith('<')) return err('script-login-page');
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch {
        return err('script-bad-response');
    }
    if (!data || typeof data !== 'object') return err('script-bad-response');
    const body = data as { ok?: unknown; error?: { code?: unknown } };
    if (body.ok === true) return ok(data as T);
    const code = typeof body.error?.code === 'string' ? body.error.code : '';
    return err(REMOTE_CODES[code] ?? 'script-bad-response');
}

/** POST to the script with retry rules. Never throws. */
export async function callScript<T>(options: CallOptions): Promise<Result<T>> {
    const valid = validateScriptUrl(options.url);
    if (!valid.ok) return err(valid.error);
    const transport = options.transport ?? defaultTransport;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => window.setTimeout(r, ms)));
    const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
    const base = options.baseDelayMs ?? 500;
    const body = JSON.stringify({ secret: options.secret, ...options.body });

    let last: Result<T> = err('script-network');
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (options.signal?.aborted) return err('script-network');
        try {
            last = parseScriptResponse<T>(await transport({ url: valid.value, body }));
        } catch (e) {
            logger.warn('AppsScript', `Request failed: ${redact(e instanceof Error ? e.message : String(e), options.secret)}`);
            last = err('script-network');
        }
        if (last.ok || !RETRYABLE.has(last.error as ScriptErrorCode)) return last;
        if (attempt < maxAttempts - 1) await sleep(base * 2 ** attempt);
    }
    return last;
}
