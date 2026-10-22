export declare const HOOK_MARKER: string;
export declare function buildHookScript(guardScriptPath: string): string;
export declare function planInstall(existing: string | null): { action: 'create' | 'update' | 'refuse'; reason?: string };
export declare function resolveHooksDir(cwd: string): string;
export declare function installHook(options?: { cwd?: string; guardScriptPath?: string }): { ok: boolean; message: string };
