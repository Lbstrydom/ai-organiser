type Log = (message: string) => void;
export const BACKUP_ROOT: string;
export const BACKUP_FILES: string[];
export function resolveTargets(opts?: { repoRoot?: string; env?: Record<string, string | undefined> }): string[];
export function stamp(now?: Date): string;
export function backupTargets(
	targets: string[],
	opts?: { backupRoot?: string; now?: Date; log?: Log },
): string | null;
export function compareBackupNames(a: string, b: string): number;
export function latestBackup(backupRoot?: string): string | null;
export function restoreBackup(backupDir: string, opts?: { log?: Log }): string[];
export function ensureVaultBackup(opts?: { backupRoot?: string; now?: Date; log?: Log }): string | null;
