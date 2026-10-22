import { afterAll, describe, expect, it } from 'vitest';
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runConnectorSelfTest } from '../src/services/agentConnectors/connectorSelfTest';
import type { Spawner } from '../src/services/agentConnectors/localTools';
import { makeVault } from './helpers/connectorServerHarness';

// The real program starter, with "node" meaning the node that is running these tests.
const realSpawn: Spawner = (command, args, options) => nodeSpawn(command === 'node' ? process.execPath : command, [...args], { stdio: ['pipe', 'pipe', 'pipe'], cwd: options.cwd, windowsHide: true }) as never;

const realTimers = { set: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number, clear: (id: number) => clearTimeout(id as never) };

const vault = makeVault();
afterAll(() => vault.cleanup());

describe('runConnectorSelfTest', () => {
	it('starts the real server and passes both protocol flows', async () => {
		vault.write('Notes/A.md', 'a');
		vault.write('Private/B.md', 'b');
		vault.writeScope({ exclude: ['Private'] });
		const res = await runConnectorSelfTest(realSpawn, vault.serverFile, vault.root, realTimers);
		expect(res).toEqual({ ok: true, value: { topLevelItems: 1 } }); // only Notes/ is visible
	});

	it('fails, with one clear code, when the server cannot start or the vault is wrong', async () => {
		expect(await runConnectorSelfTest(realSpawn, vault.serverFile, path.join(vault.root, 'nope'), realTimers)).toEqual({ ok: false, error: 'connector-test-failed' });
		expect(await runConnectorSelfTest(realSpawn, path.join(vault.root, 'missing.cjs'), vault.root, realTimers)).toEqual({ ok: false, error: 'connector-test-failed' });
		const failing: Spawner = () => { throw new Error('no node'); };
		expect(await runConnectorSelfTest(failing, vault.serverFile, vault.root, realTimers)).toEqual({ ok: false, error: 'connector-test-failed' });
	});

	it('fails when the program answers wrongly, and when it never answers', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-selftest-'));
		try {
			const liar = path.join(dir, 'liar.cjs');
			fs.writeFileSync(liar, "process.stdin.on('data', (d) => { for (const l of String(d).split('\\n').filter(Boolean)) { const m = JSON.parse(l); if (m.id) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 'x', tools: [] } }) + '\\n'); } });");
			expect(await runConnectorSelfTest(realSpawn, liar, vault.root, realTimers)).toEqual({ ok: false, error: 'connector-test-failed' });

			const mute = path.join(dir, 'mute.cjs');
			fs.writeFileSync(mute, 'setTimeout(() => {}, 60000); process.stdin.resume();');
			const hold: { fire: (() => void) | null } = { fire: null };
			const timers = { set: (fn: () => void) => { hold.fire = fn; return 1; }, clear: () => undefined };
			const pending = runConnectorSelfTest(realSpawn, mute, vault.root, timers);
			await new Promise((r) => setTimeout(r, 300));
			hold.fire?.();
			expect(await pending).toEqual({ ok: false, error: 'connector-test-failed' });
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
