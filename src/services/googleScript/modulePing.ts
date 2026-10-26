/**
 * What a deployed Google script can do, learned from its `ping`. Pure normalisation plus one thin network call.
 *
 * Each module (`tasks`, `inventory`, later `structure`) reports `{ module, version, capabilities }`. A deployment made
 * before capabilities existed is a **legacy** answer: a validated v1 response is given exactly the capabilities v1 had, so
 * the newer plugin keeps working against an older script, and a feature that needs a capability the script lacks is turned
 * off on its own (with guidance) without touching a module that still works.
 *
 * The plugin never loads or runs remote code: this only reads a JSON answer.
 */
import { Result, ok, err } from '../../core/result';
import { callScript } from '../appsScriptClient';

export type ScriptModule = 'tasks' | 'inventory';

export interface ModuleInfo {
    module: ScriptModule;
    version: number;
    capabilities: string[];
    /** True when the capabilities were inferred from a v1 answer rather than reported by the script */
    legacy: boolean;
}

/** What v1 of each module could do (the legacy capability set). */
export const LEGACY_CAPABILITIES: Readonly<Record<ScriptModule, readonly string[]>> = Object.freeze({
    tasks: Object.freeze(['upsert', 'lists']),
    inventory: Object.freeze(['list']),
});

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? [...new Set(v)].slice(0, 32) : null);

/**
 * Normalise one module's ping. Returns null for a malformed answer: no capabilities, the setup state.
 * Accepts the combined-script form (`modules.<module> = { version, capabilities }`), the standalone v2 form
 * (`scriptVersion` plus a top-level `capabilities` array) and the legacy v1 form.
 */
export function normaliseModulePing(module: ScriptModule, response: unknown): ModuleInfo | null {
    if (!isRecord(response) || response.ok !== true) return null;
    const modules = response.modules;
    // A combined answer is authoritative: a module it does not carry, or carries malformed, has no capabilities (never the standalone fields).
    if (modules !== undefined) {
        if (!isRecord(modules) || !isRecord(modules[module])) return null;
        const m = modules[module];
        const caps = strings(m.capabilities);
        return typeof m.version === 'number' && Number.isFinite(m.version) && caps ? { module, version: m.version, capabilities: caps, legacy: false } : null;
    }
    const version = response.scriptVersion;
    if (typeof version !== 'number' || !Number.isFinite(version) || version < 1) return null;
    if (response.capabilities !== undefined) {
        const caps = strings(response.capabilities);
        return caps ? { module, version, capabilities: caps, legacy: false } : null;
    }
    // Legacy answers must carry the module's own v1 fields, or they are not a validated v1 ping.
    const v1Shape = module === 'tasks'
        ? Object.hasOwn(response, 'approvedListId') && typeof response.listHash === 'string'
        : typeof response.rootsHash === 'string';
    return v1Shape && version === 1 ? { module, version, capabilities: [...LEGACY_CAPABILITIES[module]], legacy: true } : null;
}

export interface ModuleEndpoint {
    url: string;
    secret: string;
}

/** Ask a deployed script what it can do. Never throws. */
export async function pingModule(module: ScriptModule, endpoint: ModuleEndpoint): Promise<Result<ModuleInfo>> {
    const res = await callScript<unknown>({ ...endpoint, body: { op: 'ping' }, maxAttempts: 2 });
    if (!res.ok) return err(res.error);
    const info = normaliseModulePing(module, res.value);
    return info ? ok(info) : err('script-bad-response');
}

export const hasCapability = (info: ModuleInfo | null, capability: string): boolean => !!info && info.capabilities.includes(capability);

/**
 * The guidance code for a feature that needs `capability` when the script lacks it, or null when it has it. A script that
 * could not be reached says nothing about a capability, so `info === null` gives null (the caller shows the reach error).
 */
export function capabilityGap(info: ModuleInfo | null, capability: string): 'script-capability-missing' | null {
    return info && !info.capabilities.includes(capability) ? 'script-capability-missing' : null;
}
