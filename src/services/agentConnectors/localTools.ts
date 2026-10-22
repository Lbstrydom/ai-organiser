/**
 * The two small things the connector screens do on the user's own computer, both desktop only:
 * ask whether Node.js is installed, and open a terminal in the vault folder. Both go through an
 * injected spawner so they are tested without starting anything, both pass an argument array and
 * never a command string, and neither ever throws.
 */
import { Result, ok, err } from '../../core/result';
import { validateVaultPath, type ConnectorPlatform } from './connectorGuides';

export interface SpawnedChild {
    stdout?: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null;
    on(event: 'error', cb: (e: Error) => void): void;
    on(event: 'close', cb: (code: number | null) => void): void;
    kill?(): void;
    unref?(): void;
}

export interface SpawnOptions {
    cwd?: string;
    detached?: boolean;
    stdio?: 'ignore' | 'pipe';
    windowsHide?: boolean;
}

export type Spawner = (command: string, args: readonly string[], options: SpawnOptions) => SpawnedChild;

export interface NodeCheck {
    version: string;
}

const NODE_CHECK_TIMEOUT_MS = 3000;

/** Runs `node --version` (fixed arguments). `err('connector-node-missing')` when it cannot be found or does not answer. */
export function checkNodeInstalled(spawn: Spawner, setTimer: (fn: () => void, ms: number) => number, clearTimer: (id: number) => void): Promise<Result<NodeCheck>> {
    return new Promise((resolve) => {
        let settled = false;
        let out = '';
        let child: SpawnedChild | null = null;
        const finish = (result: Result<NodeCheck>): void => {
            if (settled) return;
            settled = true;
            clearTimer(timer);
            try { child?.kill?.(); } catch { /* already gone */ }
            resolve(result);
        };
        const timer = setTimer(() => finish(err('connector-node-missing')), NODE_CHECK_TIMEOUT_MS);
        try {
            child = spawn('node', ['--version'], { stdio: 'pipe', windowsHide: true });
            child.stdout?.on('data', (chunk) => { out += chunk.toString(); });
            child.on('error', () => finish(err('connector-node-missing')));
            child.on('close', (code) => {
                const version = out.trim();
                // "v20.11.1": a version that is not of that form is not an answer we trust.
                finish(code === 0 && /^v\d+\.\d+\.\d+/.test(version) ? ok({ version }) : err('connector-node-missing'));
            });
        } catch {
            finish(err('connector-node-missing'));
        }
    });
}

/** True when the version string names Node 18 or newer (what the generated server needs). */
export function nodeMeetsMinimum(version: string, minimumMajor = 18): boolean {
    const m = /^v(\d+)\./.exec(version);
    return m !== null && Number(m[1]) >= minimumMajor;
}

/**
 * Open a terminal in the vault folder: Windows and macOS only. The only value ever passed on is the
 * vault's own base path, as an argument or as the working directory, never inside a command string.
 */
export function openTerminalInVault(spawn: Spawner, platform: ConnectorPlatform, vaultPath: string): Result<void> {
    const valid = validateVaultPath(vaultPath);
    if (!valid.ok) return err(valid.error);
    try {
        if (platform === 'win32') {
            const child = spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/K'], { cwd: valid.value, detached: true, stdio: 'ignore', windowsHide: false });
            child.on('error', () => undefined);
            child.unref?.();
            return ok(undefined);
        }
        if (platform === 'darwin') {
            const child = spawn('open', ['-a', 'Terminal', valid.value], { detached: true, stdio: 'ignore' });
            child.on('error', () => undefined);
            child.unref?.();
            return ok(undefined);
        }
        return err('connector-needs-desktop');
    } catch {
        return err('connector-needs-desktop');
    }
}
