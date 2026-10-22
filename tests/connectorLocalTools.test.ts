import { describe, it, expect } from 'vitest';
import { checkNodeInstalled, nodeMeetsMinimum, openTerminalInVault, type SpawnedChild, type Spawner } from '../src/services/agentConnectors/localTools';

interface Call { command: string; args: readonly string[]; options: Record<string, unknown> }

function fakeSpawner(behaviour: { stdout?: string; code?: number; error?: boolean; throws?: boolean; silent?: boolean }): { spawn: Spawner; calls: Call[]; unref: number } {
	const calls: Call[] = [];
	const state = { unref: 0 };
	const spawn: Spawner = (command, args, options) => {
		calls.push({ command, args, options: { ...options } });
		if (behaviour.throws) throw new Error('no such program');
		const handlers: Record<string, (...a: never[]) => void> = {};
		const child: SpawnedChild = {
			stdout: { on: (_e, cb) => { if (behaviour.stdout !== undefined) queueMicrotask(() => cb(behaviour.stdout!)); } },
			on: (event: string, cb: (...a: never[]) => void) => { handlers[event] = cb; },
			kill: () => undefined,
			unref: () => { state.unref++; },
		} as SpawnedChild;
		queueMicrotask(() => queueMicrotask(() => {
			if (behaviour.silent) return;
			if (behaviour.error) handlers.error?.(new Error('ENOENT') as never);
			else handlers.close?.((behaviour.code ?? 0) as never);
		}));
		return child;
	};
	return { spawn, calls, get unref() { return state.unref; } } as { spawn: Spawner; calls: Call[]; unref: number };
}

const timers = () => {
	const pending = new Map<number, () => void>();
	let next = 1;
	return {
		set: (fn: () => void) => { pending.set(next, fn); return next++; },
		clear: (id: number) => { pending.delete(id); },
		fire: () => { for (const fn of [...pending.values()]) fn(); },
	};
};

describe('checkNodeInstalled', () => {
	it('reads the version from a fixed argument list', async () => {
		const f = fakeSpawner({ stdout: 'v20.11.1\n' });
		const t = timers();
		expect(await checkNodeInstalled(f.spawn, t.set, t.clear)).toEqual({ ok: true, value: { version: 'v20.11.1' } });
		expect(f.calls).toEqual([{ command: 'node', args: ['--version'], options: { stdio: 'pipe', windowsHide: true } }]);
	});

	it('reports missing for an error, a non-zero exit, nonsense output, a throw and a silent program', async () => {
		const t = timers();
		expect(await checkNodeInstalled(fakeSpawner({ error: true }).spawn, t.set, t.clear)).toEqual({ ok: false, error: 'connector-node-missing' });
		expect(await checkNodeInstalled(fakeSpawner({ code: 1, stdout: 'v20.0.0' }).spawn, t.set, t.clear)).toEqual({ ok: false, error: 'connector-node-missing' });
		expect(await checkNodeInstalled(fakeSpawner({ stdout: 'hello' }).spawn, t.set, t.clear)).toEqual({ ok: false, error: 'connector-node-missing' });
		expect(await checkNodeInstalled(fakeSpawner({ throws: true }).spawn, t.set, t.clear)).toEqual({ ok: false, error: 'connector-node-missing' });
		const timer = timers();
		const pending = checkNodeInstalled(fakeSpawner({ silent: true }).spawn, timer.set, timer.clear);
		timer.fire();
		expect(await pending).toEqual({ ok: false, error: 'connector-node-missing' });
	});

	it('knows which versions are new enough', () => {
		expect(nodeMeetsMinimum('v18.0.0')).toBe(true);
		expect(nodeMeetsMinimum('v22.1.0')).toBe(true);
		expect(nodeMeetsMinimum('v16.20.2')).toBe(false);
		expect(nodeMeetsMinimum('garbage')).toBe(false);
	});
});

describe('openTerminalInVault', () => {
	it('opens a console on Windows with the vault as the working directory, never in a command string', async () => {
		const f = fakeSpawner({});
		const t = timers();
		const vault = 'C:\\Users\\Sam Smith\\My "Vault" & more';
		expect(await openTerminalInVault(f.spawn, 'win32', vault, { set: t.set, clear: t.clear })).toEqual({ ok: true, value: undefined });
		expect(f.calls).toEqual([{ command: 'cmd.exe', args: ['/c', 'start', 'cmd.exe', '/K'], options: { cwd: vault, detached: true, stdio: 'ignore', windowsHide: false } }]);
		expect(f.unref).toBe(1);
	});

	it('passes the vault as one argument on macOS', async () => {
		const f = fakeSpawner({});
		const t = timers();
		const vault = '/Users/sam/My Vault; rm -rf ~';
		expect((await openTerminalInVault(f.spawn, 'darwin', vault, { set: t.set, clear: t.clear })).ok).toBe(true);
		expect(f.calls[0]).toMatchObject({ command: 'open', args: ['-a', 'Terminal', vault] });
	});

	it('reports a launcher that fails, instead of claiming success', async () => {
		const t = timers();
		expect(await openTerminalInVault(fakeSpawner({ error: true }).spawn, 'darwin', '/v', { set: t.set, clear: t.clear })).toEqual({ ok: false, error: 'connector-needs-desktop' });
		expect(await openTerminalInVault(fakeSpawner({ code: 1 }).spawn, 'win32', 'C:\\v', { set: t.set, clear: t.clear })).toEqual({ ok: false, error: 'connector-needs-desktop' });
	});

	it('takes a launcher that stays silent as started once the short wait ends', async () => {
		const t = timers();
		const pending = openTerminalInVault(fakeSpawner({ silent: true }).spawn, 'darwin', '/v', { set: t.set, clear: t.clear });
		t.fire();
		expect(await pending).toEqual({ ok: true, value: undefined });
	});

	it('is not offered elsewhere, refuses unusable paths and never throws', async () => {
		const f = fakeSpawner({});
		const t = timers();
		const tm = { set: t.set, clear: t.clear };
		expect(await openTerminalInVault(f.spawn, 'linux', '/v', tm)).toEqual({ ok: false, error: 'connector-needs-desktop' });
		expect(await openTerminalInVault(f.spawn, 'win32', '', tm)).toEqual({ ok: false, error: 'connector-vault-path-unavailable' });
		expect(await openTerminalInVault(f.spawn, 'win32', 'relative/folder', tm)).toEqual({ ok: false, error: 'connector-vault-path-unavailable' });
		expect(f.calls).toHaveLength(0);
		expect(await openTerminalInVault(fakeSpawner({ throws: true }).spawn, 'darwin', '/v', tm)).toEqual({ ok: false, error: 'connector-needs-desktop' });
	});
});
