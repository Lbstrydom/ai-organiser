/**
 * The importer's gate and the checks the settings and the service share. Pure: no Obsidian runtime, no Node.
 */
import { Result, ok, err } from '../../core/result';
import { normalisePath } from '../../core/protectedPaths';
import type { AIOrganiserSettings } from '../../core/settings';
import { isFeatureEnabled } from '../featureService';
import { driveDisplayPath } from './importPolicy';

/** The feature is on and has a source folder. Synced settings only, so every device gives the same answer. */
export function claudeImportActive(settings: Pick<AIOrganiserSettings, 'featureFlags' | 'claudeImportSourceFolder'>): boolean {
    return isFeatureEnabled(settings, 'claude-import') && settings.claudeImportSourceFolder.trim() !== '';
}

/** The Drive folder named in the AI workspace instructions, or undefined (then the instructions are exactly what they were). */
export function importFolderForInstructions(settings: Pick<AIOrganiserSettings, 'featureFlags' | 'claudeImportSourceFolder'>): string | undefined {
    if (!claudeImportActive(settings)) return undefined;
    const shown = driveDisplayPath(settings.claudeImportSourceFolder);
    return shown === '' ? undefined : shown;
}

/** The vault folder for copies: a plain relative folder, not the config folder, not protected. Returns it normalised. */
export function checkDestination(raw: string, isProtected: (path: string) => boolean, configDir = '.obsidian'): Result<string> {
    const typed = raw.trim().replace(/\\/g, '/');
    // A climb is refused as typed (normalising would quietly resolve it to some other folder).
    if (typed.split('/').some((s) => s === '..')) return err('claude-import-destination-invalid');
    const folder = normalisePath(typed);
    const top = folder.split('/')[0].toLowerCase();
    if (folder === '' || top.startsWith('.') || top === normalisePath(configDir).split('/')[0].toLowerCase()) return err('claude-import-destination-invalid');
    if (isProtected(folder)) return err('claude-import-destination-protected');
    return ok(folder);
}
