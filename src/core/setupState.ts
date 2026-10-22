/**
 * Setup state: the one place that decides whether a feature shows "Not set up", "Ready"
 * or "Needs attention".
 *
 * Two kinds of fact, kept apart:
 *  - Persisted configuration facts live in settings, including `featureSetupCompletedAt`
 *    (set when a wizard finishes), which separates an untouched default from a choice the
 *    user made.
 *  - Derived health is computed here from settings plus explicit runtime observations
 *    (which folders exist, the last connection test). It is never stored, so it cannot drift.
 *
 * This module is the single canonical contract for setup and script compatibility. Other
 * files call `evaluateSetup` and `evaluateScriptCompat`; they never restate the rules.
 */

/** Features and sub-features that have a setup entry point. */
export type SetupId =
    | 'protected-folders'
    | 'agent-index'
    | 'cloud-inventory'
    | 'cloud-offload'
    | 'inbox-sweep'
    | 'google-tasks'
    | 'vault-upkeep';

export type SetupState = 'not-set-up' | 'ready' | 'needs-attention';

/** Why a feature is not `ready`. Maps to a sentence in `t.setup.reasons`. */
export type SetupReason =
    | 'no-config'
    | 'incomplete'
    | 'missing-folder'
    | 'connection-untested'
    | 'connection-failed'
    | 'connection-stale'
    | 'script-incompatible'
    | 'script-config-mismatch';

export const SETUP_REASONS: readonly SetupReason[] = [
    'no-config',
    'incomplete',
    'missing-folder',
    'connection-untested',
    'connection-failed',
    'connection-stale',
    'script-incompatible',
    'script-config-mismatch',
];

export interface SetupEvaluation {
    state: SetupState;
    reason?: SetupReason;
}

/** Result of the last "Test connection", tied to the configuration it tested. */
export interface ConnectionObservation {
    ok: boolean;
    configHash: string;
}

/** What a deployed script reported on its last `ping`. */
export interface ScriptReport {
    scriptVersion: number;
    configHash?: string;
}

/** What the plugin expects of the script. */
export interface ScriptExpectation {
    /** Oldest script version that still works. Below it the script is `incompatible`. */
    minSupported: number;
    /** Newest script version. Between min and current is only a hint. */
    current: number;
    /** Hash of the roots / approved list the plugin generated into the script. */
    configHash?: string;
}

export type ScriptCompat = 'ok' | 'hint' | 'incompatible' | 'config-mismatch';

/**
 * Compare a script's ping report with what the plugin expects.
 * Version compatibility is kept separate from configuration matching: a supported older
 * version with the right configuration is only a hint.
 */
export function evaluateScriptCompat(reported: ScriptReport | null | undefined, expected: ScriptExpectation): ScriptCompat {
    if (!reported || !Number.isFinite(reported.scriptVersion) || reported.scriptVersion < expected.minSupported) {
        return 'incompatible';
    }
    if (expected.configHash !== undefined && reported.configHash !== expected.configHash) {
        return 'config-mismatch';
    }
    return reported.scriptVersion < expected.current ? 'hint' : 'ok';
}

/** Runtime inputs the pure evaluator needs. Every field is optional: absent means "not observed". */
export interface SetupObservations {
    /** Normalised paths of vault folders that currently exist. When absent, folder checks are skipped. */
    existingFolders?: ReadonlySet<string>;
    /** Hash of the current configuration; a connection test for a different hash is stale. */
    configHash?: string;
    connection?: ConnectionObservation | null;
    script?: { report: ScriptReport | null; expected: ScriptExpectation } | null;
}

/** Declarative description of what "set up" means for one feature. */
export interface SetupSpec {
    /** Settings keys that must be non-empty (string or array) once set up. */
    required: readonly string[];
    /** Settings keys holding folder paths (string or string[]) that must exist. */
    folderKeys: readonly string[];
    /** True when setup is only complete after a wizard Finish (`featureSetupCompletedAt`). */
    needsCompletionMarker: boolean;
    /** True when a connection test result is part of health. */
    needsConnection: boolean;
}

/**
 * Specs by id. A feature's phase adds its entry here; an id with no spec evaluates as
 * `not-set-up`, so an unfinished feature can never read as ready.
 */
export const SETUP_SPECS: Readonly<Partial<Record<SetupId, SetupSpec>>> = {
    'agent-index': {
        required: [],
        folderKeys: ['agentIndexIncludeFolders', 'agentIndexExcludeFolders'],
        needsCompletionMarker: true,
        needsConnection: false,
    },
    'cloud-inventory': {
        required: ['cloudInventoryScriptUrl', 'cloudInventoryPairs'],
        folderKeys: ['cloudInventoryPairs'],
        needsCompletionMarker: true,
        needsConnection: true,
    },
    'vault-upkeep': {
        required: [],
        folderKeys: ['upkeepReportFolder'],
        needsCompletionMarker: true,
        needsConnection: false,
    },
    'inbox-sweep': {
        required: ['sweepInboxFolders', 'sweepReportPath'],
        folderKeys: ['sweepInboxFolders', 'sweepExcludedFolders'],
        needsCompletionMarker: true,
        needsConnection: false,
    },
    'google-tasks': {
        required: ['tasksScriptUrl', 'tasksListId'],
        folderKeys: [],
        needsCompletionMarker: true,
        needsConnection: true,
    },
    'protected-folders': {
        required: ['protectedFolders'],
        folderKeys: ['protectedFolders'],
        needsCompletionMarker: false,
        needsConnection: false,
    },
};

import { normalisePath } from './protectedPaths';

type SettingsLike = Record<string, unknown>;

function isNonEmpty(value: unknown): boolean {
    if (typeof value === 'string') return value.trim() !== '';
    if (Array.isArray(value)) {
        // A folder entry that normalises to nothing (for example "/") is not an entry. A pair counts only
        // when it names a vault folder (the empty string is the vault root), the same test folderValues uses.
        return value.some((v) => {
            if (typeof v === 'string') return normalisePath(v).trim() !== '';
            if (v && typeof v === 'object') return typeof (v as { vaultFolder?: unknown }).vaultFolder === 'string';
            return false;
        });
    }
    // A switch that is off is not a value; any other present value (a number, an object) is.
    if (typeof value === 'boolean') return value;
    return value !== undefined && value !== null;
}

function folderValues(settings: SettingsLike, keys: readonly string[]): string[] {
    const out: string[] = [];
    for (const key of keys) {
        const value = settings[key];
        if (typeof value === 'string' && value.trim() !== '') out.push(value);
        else if (Array.isArray(value)) {
            for (const v of value) {
                // Folder lists hold strings; pair lists hold objects that name their vault folder.
                const folder = typeof v === 'string' ? v : (v && typeof v === 'object' ? (v as { vaultFolder?: unknown }).vaultFolder : undefined);
                if (typeof folder === 'string' && folder.trim() !== '') out.push(folder);
            }
        }
    }
    return out;
}

function normaliseFolder(path: string): string {
    // The same canonical form protection enforcement uses, so health and enforcement agree.
    return normalisePath(path).toLowerCase();
}

/**
 * Evaluate a feature's setup status. Pure: same settings and observations, same answer.
 *
 *  - no spec, nothing required filled in, or (when a wizard is needed) never finished: `not-set-up`;
 *  - a configured folder is missing, the last connection test failed, is stale for the current
 *    configuration hash, or never ran, or the script is incompatible / out of date: `needs-attention`;
 *  - otherwise `ready`.
 */
export function evaluateSetup(
    id: SetupId,
    settings: object,
    observations: SetupObservations = {},
): SetupEvaluation {
    const spec = SETUP_SPECS[id];
    if (!spec) return { state: 'not-set-up', reason: 'no-config' };
    const s = settings as SettingsLike;

    const completedAt = (s.featureSetupCompletedAt as Record<string, string> | undefined)?.[id];
    const filled = spec.required.every((key) => isNonEmpty(s[key]));

    if (spec.needsCompletionMarker && !completedAt) {
        return { state: 'not-set-up', reason: filled ? 'incomplete' : 'no-config' };
    }
    if (!filled) {
        return completedAt ? { state: 'needs-attention', reason: 'incomplete' } : { state: 'not-set-up', reason: 'no-config' };
    }

    if (observations.existingFolders) {
        const existing = observations.existingFolders;
        if (folderValues(s, spec.folderKeys).some((f) => !existing.has(normaliseFolder(f)))) {
            return { state: 'needs-attention', reason: 'missing-folder' };
        }
    }

    if (spec.needsConnection) {
        const c = observations.connection;
        if (!c) return { state: 'needs-attention', reason: 'connection-untested' };
        if (!c.ok) return { state: 'needs-attention', reason: 'connection-failed' };
        if (observations.configHash !== undefined && c.configHash !== observations.configHash) {
            return { state: 'needs-attention', reason: 'connection-stale' };
        }
        if (observations.script) {
            const compat = evaluateScriptCompat(observations.script.report, observations.script.expected);
            if (compat === 'incompatible') return { state: 'needs-attention', reason: 'script-incompatible' };
            if (compat === 'config-mismatch') return { state: 'needs-attention', reason: 'script-config-mismatch' };
        }
    }

    return { state: 'ready' };
}

/** Build the set of existing folder paths (normalised) for `SetupObservations.existingFolders`. */
export function toFolderSet(paths: Iterable<string>): Set<string> {
    const set = new Set<string>();
    for (const p of paths) set.add(normaliseFolder(p));
    return set;
}
