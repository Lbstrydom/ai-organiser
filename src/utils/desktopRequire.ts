/**
 * Access Electron/Node modules in desktop Obsidian. Returns undefined on mobile
 * or when the require function is unavailable.
 */
type WindowWithRequire = { require?: (mod: string) => unknown };

export function desktopRequire<T = unknown>(mod: string): T | undefined {
    const g = globalThis as WindowWithRequire;
    return g.require?.(mod) as T | undefined;
}

/** Type-only alias exported for files that need to cast `window` directly. */
export type { WindowWithRequire };

// Convenience accessors for commonly-used Electron/Node modules. Each returns
// undefined on mobile or when `window.require` is unavailable, so callers must
// guard the result before use.

export function getFs(): typeof import('fs') | undefined {
    return desktopRequire<typeof import('fs')>('fs');
}

export function getPath(): typeof import('path') | undefined {
    return desktopRequire<typeof import('path')>('path');
}

export function getOs(): typeof import('os') | undefined {
    return desktopRequire<typeof import('os')>('os');
}

type ElectronModule = {
    remote?: { dialog?: unknown; BrowserWindow?: unknown };
    dialog?: unknown;
    BrowserWindow?: unknown;
    shell?: { openPath?: (p: string) => Promise<string> };
};

export function getElectron(): ElectronModule | undefined {
    return desktopRequire<ElectronModule>('electron');
}
