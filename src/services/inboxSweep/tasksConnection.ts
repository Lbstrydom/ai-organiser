/**
 * Connecting another device to a Google script that is already deployed, and the one rule about making a new secret.
 *
 * The secret lives in SecretStorage, which is local to each device and vault, so a phone or second computer starts without it. A new
 * secret there would be a trap: pasted into Google it stops every other device. So a saved script link with no local secret never
 * creates one (`ensureTasksSecret`); the person connects with a code from a working device, or with the secret from the script editor.
 * A new secret for a deployed script comes only from `replaceTasksSecret`, behind a warning.
 *
 * A connection code is the link and the secret in one string, encoded only so that it survives a paste. It is NOT encrypted: it is
 * never logged, never put in a URL and never written to a note, and it is held only in the input until the test passes.
 * Everything here is plain web API (`atob`, `btoa`) and works on mobile.
 */
import type AIOrganiserPlugin from '../../main';
import { PLUGIN_SECRET_IDS } from '../../core/secretIds';
import { Result, ok, err } from '../../core/result';
import { validateScriptUrl, type ScriptTransport } from '../appsScriptClient';
import { LIST_CONFIG_CAPABILITY } from '../googleScript/tasksModuleV3';
import { normaliseTasksLists } from './tasksRouting';
import { tasksConfigKey } from './tasksScriptSelect';
import { pingTasksScript } from './tasksExportService';
import { logger } from '../../utils/logger';

const CODE_PREFIX = 'aio-connect-1.';
const BARE_SECRET = /^[A-Za-z0-9_-]{16,256}$/;
/** The secret line of a script, copied whole: `var SECRET = "..."` or `"SECRET": "..."`. */
const SECRET_LINE = /SECRET"?\s*[:=]\s*["']([^"']+)["']/;

function newSecret(): string {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

let secretInFlight: Promise<Result<{ secret: string; created: boolean }>> | null = null;

/** The stored secret, creating one only when no script link is saved: with a link, a script already exists and has its own secret. */
export function ensureTasksSecret(plugin: AIOrganiserPlugin): Promise<Result<{ secret: string; created: boolean }>> {
    if (secretInFlight) return secretInFlight;
    secretInFlight = (async (): Promise<Result<{ secret: string; created: boolean }>> => {
        const existing = await plugin.secretStorageService.getSecret(PLUGIN_SECRET_IDS.GOOGLE_TASKS);
        if (existing) return ok({ secret: existing, created: false });
        if (plugin.settings.tasksScriptUrl.trim() !== '') return err('tasks-no-secret');
        const secret = newSecret();
        await plugin.secretStorageService.setSecret(PLUGIN_SECRET_IDS.GOOGLE_TASKS, secret);
        return ok({ secret, created: true });
    })().finally(() => { secretInFlight = null; });
    return secretInFlight;
}

/** Replace the secret, whatever is stored. Only from the person's confirmed choice: every other device stops until it is connected again. */
export async function replaceTasksSecret(plugin: AIOrganiserPlugin): Promise<void> {
    await plugin.secretStorageService.setSecret(PLUGIN_SECRET_IDS.GOOGLE_TASKS, newSecret());
}

export function encodeConnectionCode(url: string, secret: string): string {
    const packed = btoa(JSON.stringify({ u: url, s: secret })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${CODE_PREFIX}${packed}`;
}

/** What was pasted: a connection code, or the secret on its own with `linkField` giving the link. Pure. */
export function parseConnectionInput(raw: string, linkField: string): Result<{ url: string; secret: string }> {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (text.startsWith(CODE_PREFIX)) {
        let decoded: { u?: unknown; s?: unknown } | null;
        try {
            decoded = JSON.parse(atob(text.slice(CODE_PREFIX.length).replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/'))) as { u?: unknown; s?: unknown } | null;
        } catch {
            return err('tasks-connect-bad-code');
        }
        if (typeof decoded?.u !== 'string' || typeof decoded.s !== 'string' || !BARE_SECRET.test(decoded.s)) return err('tasks-connect-bad-code');
        const url = validateScriptUrl(decoded.u);
        return url.ok ? ok({ url: url.value, secret: decoded.s }) : err('tasks-connect-bad-code');
    }
    const secret = SECRET_LINE.exec(text)?.[1] ?? text.replace(/^["']|["']$/g, '');
    if (!BARE_SECRET.test(secret)) return err('tasks-connect-bad-code');
    if (linkField.trim() === '') return err('tasks-connect-needs-link');
    const url = validateScriptUrl(linkField);
    return url.ok ? ok({ url: url.value, secret }) : err(url.error);
}

/** The code a working device shows. Reads what is saved; sends nothing. */
export async function createConnectionCode(plugin: AIOrganiserPlugin): Promise<Result<string>> {
    const url = validateScriptUrl(plugin.settings.tasksScriptUrl);
    if (!url.ok) return err(url.error);
    const secret = await plugin.secretStorageService.getSecret(PLUGIN_SECRET_IDS.GOOGLE_TASKS);
    return secret ? ok(encodeConnectionCode(url.value, secret)) : err('tasks-no-secret');
}

export interface ConnectOutcome {
    url: string;
    automatic: boolean;
    combined: boolean;
}

/**
 * Test the pasted secret against the script and save only if the script accepts it. Any refusal leaves the stored secret and the
 * settings as they were. Lists the script approves fill an empty list setup, so a device whose settings did not sync is ready too.
 * Never approves or changes a list. Never throws.
 */
export async function connectDevice(plugin: AIOrganiserPlugin, raw: string, linkField: string, transport?: ScriptTransport): Promise<Result<ConnectOutcome>> {
    const parsed = parseConnectionInput(raw, linkField);
    if (!parsed.ok) return err(parsed.error);
    const { url, secret } = parsed.value;
    const ping = await pingTasksScript({ url, secret, transport });
    if (!ping.ok) return err(ping.error === 'script-auth' ? 'tasks-connect-wrong-secret' : ping.error);

    const s = plugin.settings;
    const secrets = plugin.secretStorageService;
    const info = ping.value;
    const automatic = info.capabilities?.includes(LIST_CONFIG_CAPABILITY) === true;
    const before = { url: s.tasksScriptUrl, auto: s.tasksAutoLists, revision: s.tasksListsRevision, listId: s.tasksListId, listName: s.tasksListName, lists: s.tasksLists, lastTest: s.tasksLastTest, done: s.featureSetupCompletedAt['google-tasks'] };
    let previous: string | null;
    try {
        previous = await secrets.getSecret(PLUGIN_SECRET_IDS.GOOGLE_TASKS);
        await secrets.setSecret(PLUGIN_SECRET_IDS.GOOGLE_TASKS, secret);
        if ((await secrets.getSecret(PLUGIN_SECRET_IDS.GOOGLE_TASKS)) !== secret) return err('tasks-connect-save-failed');
    } catch {
        return err('tasks-connect-save-failed');
    }
    s.tasksScriptUrl = url;
    // A revision this device already holds stays: it is what tells it another device has changed the lists since.
    s.tasksListsRevision = automatic ? (before.auto && before.revision !== null ? before.revision : info.listsRevision ?? 0) : null;
    s.tasksAutoLists = automatic;
    if (s.tasksListId === '' && info.approvedListId !== null) {
        const titles = info.approvedListTitles ?? {};
        s.tasksListId = info.approvedListId;
        s.tasksListName = titles[info.approvedListId] ?? '';
        s.tasksLists = normaliseTasksLists((info.approvedListIds ?? [info.approvedListId]).map((id) => ({ id, title: titles[id] ?? '', needsDate: false })));
    }
    if (s.tasksListId !== '') {
        const at = new Date().toISOString();
        s.tasksLastTest = { ok: true, configHash: tasksConfigKey(url, s.tasksListId), at };
        s.featureSetupCompletedAt['google-tasks'] = at;
    }
    try {
        await plugin.saveSettings();
    } catch (e) {
        logger.warn('Sweep', 'Could not save the device connection', e instanceof Error ? e.message.split(secret).join('[secret]') : 'unknown');
        s.tasksScriptUrl = before.url;
        s.tasksAutoLists = before.auto;
        s.tasksListsRevision = before.revision;
        s.tasksListId = before.listId;
        s.tasksListName = before.listName;
        s.tasksLists = before.lists;
        s.tasksLastTest = before.lastTest;
        if (before.done === undefined) delete s.featureSetupCompletedAt['google-tasks']; else s.featureSetupCompletedAt['google-tasks'] = before.done;
        try {
            if (previous) await secrets.setSecret(PLUGIN_SECRET_IDS.GOOGLE_TASKS, previous); else await secrets.removeSecret(PLUGIN_SECRET_IDS.GOOGLE_TASKS);
        } catch {
            logger.warn('Sweep', 'Could not restore the earlier secret');
        }
        return err('tasks-connect-save-failed');
    }
    return ok({ url, automatic, combined: info.combined === true });
}
