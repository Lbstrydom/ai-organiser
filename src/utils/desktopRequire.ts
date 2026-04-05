/**
 * Access Electron/Node modules in desktop Obsidian. Returns undefined on mobile
 * or when the require function is unavailable.
 */
type WindowWithRequire = Window & { require?: (mod: string) => unknown };

export function desktopRequire<T = unknown>(mod: string): T | undefined {
    const win = window as WindowWithRequire;
    return win.require?.(mod) as T | undefined;
}

/** Type-only alias exported for files that need to cast `window` directly. */
export type { WindowWithRequire };
