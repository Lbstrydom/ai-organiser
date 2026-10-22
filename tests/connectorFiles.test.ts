import { describe, expect, it } from 'vitest';
import { saveConnectorFiles } from '../src/services/agentConnectors/connectorFiles';
import { CONNECTOR_BUNDLE_FILE, CONNECTOR_SERVER_FILE, isOwnBundle } from '../src/services/agentConnectors/connectorBundle';
import { CONNECTOR_SERVER_SOURCE } from '../src/services/agentConnectors/connectorServerSource';
import { buildZip } from '../src/utils/zipStore';
import { DEFAULT_SETTINGS } from '../src/core/settings';

function makePlugin(over: Record<string, unknown> = {}, existing: Record<string, string | Uint8Array> = {}) {
	const files = new Map<string, string | Uint8Array>(Object.entries(existing));
	const folders = new Set<string>();
	const adapter = {
		exists: async (p: string) => files.has(p) || folders.has(p),
		read: async (p: string) => { const v = files.get(p); if (typeof v !== 'string') throw new Error('not text'); return v; },
		readBinary: async (p: string) => { const v = files.get(p); const bytes = typeof v === 'string' ? new TextEncoder().encode(v) : v!; return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
		write: async (p: string, d: string) => { files.set(p, d); },
		writeBinary: async (p: string, d: ArrayBuffer) => { files.set(p, new Uint8Array(d)); },
		rename: async (a: string, b: string) => { files.set(b, files.get(a)!); files.delete(a); },
		remove: async (p: string) => { files.delete(p); },
		mkdir: async (p: string) => { folders.add(p); },
	};
	const plugin = { settings: { ...structuredClone(DEFAULT_SETTINGS), agentConnectorFolder: 'AI connectors', ...over }, app: { vault: { adapter } }, manifest: { version: '1.2.3' } };
	return { plugin: plugin as never, files };
}

const BUNDLE = `AI connectors/${CONNECTOR_BUNDLE_FILE}`;
const SERVER = `AI connectors/${CONNECTOR_SERVER_FILE}`;

describe('saveConnectorFiles', () => {
	it('creates the bundle and the server in the chosen folder and leaves nothing temporary', async () => {
		const h = makePlugin();
		expect(await saveConnectorFiles(h.plugin, '1.2.3')).toEqual({ ok: true, value: { bundle: BUNDLE, server: SERVER } });
		expect(isOwnBundle(h.files.get(BUNDLE) as Uint8Array)).toBe(true);
		expect(h.files.get(SERVER)).toBe(CONNECTOR_SERVER_SOURCE);
		expect([...h.files.keys()].filter((k) => k.endsWith('.aio-tmp'))).toEqual([]);
	});

	it('refreshes its own earlier files', async () => {
		const h = makePlugin({}, { [SERVER]: '// ai-organiser/connector-server v1 protocol 2026-07-28,2025-11-25\nold', [BUNDLE]: buildZip([{ name: 'x', data: new Uint8Array() }], 'ai-organiser/connector-bundle v1') });
		expect((await saveConnectorFiles(h.plugin, '1.2.3')).ok).toBe(true);
		expect(h.files.get(SERVER)).toBe(CONNECTOR_SERVER_SOURCE);
	});

	it('leaves a file that is not its own untouched, and changes nothing else either', async () => {
		const foreignServer = makePlugin({}, { [SERVER]: 'console.log("mine")' });
		expect(await saveConnectorFiles(foreignServer.plugin, '1.2.3')).toEqual({ ok: false, error: 'connector-file-not-ours' });
		expect(foreignServer.files.get(SERVER)).toBe('console.log("mine")');
		const foreignBundle = makePlugin({}, { [BUNDLE]: new Uint8Array([1, 2, 3]) });
		expect(await saveConnectorFiles(foreignBundle.plugin, '1.2.3')).toEqual({ ok: false, error: 'connector-file-not-ours' });
		expect([...(foreignBundle.files.get(BUNDLE) as Uint8Array)]).toEqual([1, 2, 3]);
		expect(foreignBundle.files.has(SERVER)).toBe(false);
	});

	it('needs a chosen visible folder outside protected folders, and writes nothing otherwise', async () => {
		for (const [over, error] of [[{ agentConnectorFolder: '' }, 'connector-folder-missing'], [{ agentConnectorFolder: '.hidden' }, 'connector-folder-invalid'], [{ protectedFolders: ['AI connectors'] }, 'protected-path']] as const) {
			const h = makePlugin(over as never);
			expect(await saveConnectorFiles(h.plugin, '1.2.3')).toEqual({ ok: false, error });
			expect(h.files.size).toBe(0);
		}
	});

	it('serialises two saves at once', async () => {
		const h = makePlugin();
		const results = await Promise.all([saveConnectorFiles(h.plugin, '1.2.3'), saveConnectorFiles(h.plugin, '1.2.3')]);
		expect(results.every((r) => r.ok)).toBe(true);
		expect([...h.files.keys()].sort()).toEqual([BUNDLE, SERVER].sort());
	});
});
