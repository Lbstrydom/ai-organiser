/**
 * Every setting that holds a model or deployment name, and the one operation over them:
 * replace a name everywhere. Names are matched exactly and nothing else is touched.
 *
 * A new `*Model` / `*Deployment` setting must be added here;
 * `tests/modelNameSettings.test.ts` fails until it is.
 */
import type { AIOrganiserSettings } from '../../core/settings';
import { err, ok, type Result } from '../../core/result';
import { logger } from '../../utils/logger';

/** Top-level settings whose value is a name. */
export const MODEL_NAME_KEYS = [
    'cloudModel', 'localModel', 'mobileFallbackModel', 'embeddingModel', 'azureGPTModel',
    'azureWhisperDeployment', 'flashcardModel', 'auditModel', 'quickPeekModel', 'pdfModel',
    'youtubeGeminiModel',
] as const;

/** Top-level settings that are objects whose string values are names. */
export const MODEL_NAME_GROUPS = ['azureDeployments', 'azureFastModel', 'taskModels', 'presentationModelRoles'] as const;

/** Per-deployment pacing, keyed by name. */
const RPM_KEY = 'azurePerDeploymentRpm';

interface Slot { path: string; name: string; set(next: string): void }

type Bag = Record<string, unknown>;

const isBag = (v: unknown): v is Bag => v !== null && typeof v === 'object' && !Array.isArray(v);

function slot(owner: Bag, key: string, path: string): Slot[] {
    const name = owner[key];
    return typeof name === 'string' && name ? [{ path, name, set: next => { owner[key] = next; } }] : [];
}

/** `settings[group].<entry>.<field>`, for maps of small objects. */
function nestedSlots(settings: Bag, group: string, field: string): Slot[] {
    const map = settings[group];
    if (!isBag(map)) return [];
    return Object.entries(map).flatMap(([id, entry]) => isBag(entry) ? slot(entry, field, `${group}.${id}.${field}`) : []);
}

function rpmSlots(settings: Bag): Slot[] {
    const map = settings[RPM_KEY];
    if (!isBag(map)) return [];
    return Object.keys(map).map(name => ({
        path: `${RPM_KEY}.${name}`,
        name,
        // An existing row for the new name is the user's current quota: keep it.
        set: next => {
            if (!Object.prototype.hasOwnProperty.call(map, next)) map[next] = map[name];
            delete map[name];
        },
    }));
}

function allSlots(settings: AIOrganiserSettings): Slot[] {
    const s = settings as unknown as Bag;
    return [
        ...MODEL_NAME_KEYS.flatMap(key => slot(s, key, key)),
        ...MODEL_NAME_GROUPS.flatMap(group => {
            const bag = s[group];
            return isBag(bag) ? Object.keys(bag).flatMap(key => slot(bag, key, `${group}.${key}`)) : [];
        }),
        ...nestedSlots(s, 'providerSettings', 'model'),
        ...nestedSlots(s, 'azureCapabilities', 'deployment'),
        ...rpmSlots(s),
    ];
}

/** Every name in use, with the settings that hold it, sorted by name. */
export function listModelNames(settings: AIOrganiserSettings): Array<{ name: string; paths: string[] }> {
    const byName = new Map<string, string[]>();
    for (const s of allSlots(settings)) byName.set(s.name, [...(byName.get(s.name) ?? []), s.path]);
    return [...byName.entries()]
        .map(([name, paths]) => ({ name, paths }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/** True when the change touches the search model, whose stored index may no longer match. */
export function touchesSearchModel(paths: readonly string[]): boolean {
    return paths.some(p => p === 'embeddingModel' || p === 'azureDeployments.embeddings' || p === 'taskModels.embeddings');
}

/** A usable replacement name, or null. */
export function cleanNewName(from: string, to: string): string | null {
    const next = to.trim();
    return next && next !== from && !/\s/.test(next) && next !== '__proto__' ? next : null;
}

/** Replace `from` with `to` in `settings` (mutates it). Returns the paths that changed. */
export function replaceModelName(settings: AIOrganiserSettings, from: string, to: string): string[] {
    const next = cleanNewName(from, to);
    if (!next) return [];
    const matches = allSlots(settings).filter(s => s.name === from);
    for (const match of matches) match.set(next);
    return matches.map(m => m.path);
}

/**
 * Replace and persist. If saving fails, the settings that changed are put back, so the old name is
 * still listed and the user can try again.
 */
export async function replaceModelNameAndSave(
    settings: AIOrganiserSettings, from: string, to: string, save: () => Promise<void>,
): Promise<Result<string[]>> {
    const before = structuredClone(settings) as unknown as Bag;
    const changed = replaceModelName(settings, from, to);
    if (changed.length === 0) return ok(changed);
    try {
        await save();
        return ok(changed);
    } catch (error) {
        logger.error('ModelNames', 'Saving the replaced names failed', error);
        const live = settings as unknown as Bag;
        for (const key of new Set(changed.map(path => path.split('.')[0]))) live[key] = before[key];
        return err('model-replace-unsaved');
    }
}
