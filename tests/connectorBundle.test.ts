import { describe, expect, it } from 'vitest';
import { buildZip, crc32, readZipComment } from '../src/utils/zipStore';
import {
	absoluteGeneratedPath, buildBundleManifest, buildCodexConfig, buildConnectorBundle, CONNECTOR_BUNDLE_COMMENT, isOwnBundle, isOwnServerFile, tomlBasicString,
} from '../src/services/agentConnectors/connectorBundle';
import { CONNECTOR_SERVER_MARKER, CONNECTOR_SERVER_SOURCE } from '../src/services/agentConnectors/connectorServerSource';

// A tiny independent ZIP reader (central directory), so the writer is not checked against itself.
function readZip(zip: Uint8Array): Array<{ name: string; data: Uint8Array; crcOk: boolean }> {
	const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	let end = -1;
	for (let i = zip.length - 22; i >= 0; i--) if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
	if (end < 0) throw new Error('no end record');
	const count = view.getUint16(end + 10, true);
	let at = view.getUint32(end + 16, true);
	const out: Array<{ name: string; data: Uint8Array; crcOk: boolean }> = [];
	for (let n = 0; n < count; n++) {
		if (view.getUint32(at, true) !== 0x02014b50) throw new Error('bad central header');
		const method = view.getUint16(at + 10, true);
		const crc = view.getUint32(at + 16, true);
		const size = view.getUint32(at + 24, true);
		const nameLen = view.getUint16(at + 28, true);
		const extraLen = view.getUint16(at + 30, true);
		const commentLen = view.getUint16(at + 32, true);
		const local = view.getUint32(at + 42, true);
		const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen));
		if (method !== 0) throw new Error('expected stored');
		if (view.getUint32(local, true) !== 0x04034b50) throw new Error('bad local header');
		const lname = view.getUint16(local + 26, true);
		const lextra = view.getUint16(local + 28, true);
		const data = zip.subarray(local + 30 + lname + lextra, local + 30 + lname + lextra + size);
		out.push({ name, data, crcOk: crc32(data) === crc });
		at += 46 + nameLen + extraLen + commentLen;
	}
	return out;
}

describe('zipStore', () => {
	it('computes the standard CRC-32', () => {
		expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
		expect(crc32(new Uint8Array())).toBe(0);
	});

	it('writes a readable archive: names, bytes, checksums and comment all come back', () => {
		const entries = [
			{ name: 'a.txt', data: new TextEncoder().encode('hello') },
			{ name: 'dir/Ünï.json', data: new TextEncoder().encode('{"x":1}') },
			{ name: 'empty', data: new Uint8Array() },
		];
		const zip = buildZip(entries, 'my comment');
		const back = readZip(zip);
		expect(back.map((e) => e.name)).toEqual(['a.txt', 'dir/Ünï.json', 'empty']);
		expect(back.every((e) => e.crcOk)).toBe(true);
		expect(new TextDecoder().decode(back[1].data)).toBe('{"x":1}');
		expect(readZipComment(zip)).toBe('my comment');
		expect(buildZip(entries, 'my comment')).toEqual(zip); // deterministic
	});

	it('refuses names that could escape or collide', () => {
		for (const name of ['', '/abs', '../x', 'a/../b', 'a//b', './a', 'a\\b', 'a\u0000b']) expect(() => buildZip([{ name, data: new Uint8Array() }]), JSON.stringify(name)).toThrow();
		expect(() => buildZip([{ name: 'a', data: new Uint8Array() }, { name: 'a', data: new Uint8Array() }])).toThrow();
	});

	it('is read by a real ZIP library when one is installed', async () => {
		interface JSZipLike { loadAsync(data: Uint8Array): Promise<{ files: Record<string, { async(type: 'string'): Promise<string> }> }> }
		const load = async (): Promise<JSZipLike | null> => {
			try { return ((await import('jszip')) as unknown as { default: JSZipLike }).default; } catch { return null; }
		};
		const JSZip = await load();
		if (!JSZip) return;
		const zip = await JSZip.loadAsync(buildConnectorBundle('9.9.9'));
		expect(Object.keys(zip.files).sort()).toEqual(['manifest.json', 'server/index.js', 'server/package.json']);
		expect(await zip.files['server/index.js'].async('string')).toBe(CONNECTOR_SERVER_SOURCE);
	});
});

describe('the extension bundle', () => {
	const bundle = buildConnectorBundle('1.2.3');
	const files = new Map(readZip(bundle).map((e) => [e.name, new TextDecoder().decode(e.data)]));

	it('holds the manifest, the server and a CommonJS pin, and marks itself as ours', () => {
		expect([...files.keys()]).toEqual(['manifest.json', 'server/package.json', 'server/index.js']);
		expect(files.get('server/index.js')).toBe(CONNECTOR_SERVER_SOURCE);
		expect(JSON.parse(files.get('server/package.json')!)).toEqual({ type: 'commonjs' });
		expect(readZipComment(bundle)).toBe(CONNECTOR_BUNDLE_COMMENT);
		expect(isOwnBundle(bundle)).toBe(true);
		expect(isOwnBundle(buildZip([{ name: 'x', data: new Uint8Array() }]))).toBe(false);
		expect(isOwnBundle(new Uint8Array([1, 2, 3]))).toBe(false);
	});

	it('has the manifest fields the specification requires, and a folder picker instead of a path', () => {
		const m = JSON.parse(files.get('manifest.json')!) as Record<string, any>;
		for (const field of ['manifest_version', 'name', 'version', 'description', 'author', 'server']) expect(m[field], field).toBeDefined();
		expect(m.manifest_version).toBe('0.3');
		expect(m.version).toBe('1.2.3');
		expect(m.author.name).toBeTruthy();
		expect(m.server).toEqual({
			type: 'node',
			entry_point: 'server/index.js',
			mcp_config: { command: 'node', args: ['${__dirname}/server/index.js', '${user_config.vault_folder}'] },
		});
		expect(m.user_config.vault_folder).toMatchObject({ type: 'directory', required: true });
		expect(m.tools.map((t: { name: string }) => t.name)).toEqual(['search_notes', 'read_note', 'list_folder', 'get_workspace_pack']);
		expect(m.compatibility.runtimes.node).toBe('>=18');
		expect(JSON.stringify(buildBundleManifest('1.2.3'))).toBe(JSON.stringify(m));
	});

	it('contains no vault path and nothing personal: the same bytes whoever builds it', () => {
		expect(buildConnectorBundle('1.2.3')).toEqual(bundle);
		const all = [...files.values()].join('\n');
		expect(all).not.toMatch(/[A-Za-z]:\\\\Users|\/Users\/|\/home\//);
	});

	it('recognises a server file by its first line only', () => {
		expect(isOwnServerFile(CONNECTOR_SERVER_SOURCE)).toBe(true);
		expect(isOwnServerFile(`${CONNECTOR_SERVER_MARKER}\nanything`)).toBe(true);
		expect(isOwnServerFile(`\n${CONNECTOR_SERVER_MARKER}\n`)).toBe(false);
		expect(isOwnServerFile('console.log("mine")')).toBe(false);
	});
});

// The inverse of tomlBasicString for the subset it emits, written independently of it.
function decodeTomlBasic(text: string): string {
	if (!text.startsWith('"') || !text.endsWith('"')) throw new Error('not a basic string');
	let out = '';
	for (let i = 1; i < text.length - 1; i++) {
		const ch = text[i];
		if (ch === '"') throw new Error('unescaped quote');
		if (ch.charCodeAt(0) < 0x20 && ch !== '\t') throw new Error('raw control character');
		if (ch !== '\\') { out += ch; continue; }
		const n = text[++i];
		const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
		if (n in simple) out += simple[n];
		else if (n === 'u') { out += String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16)); i += 4; }
		else throw new Error(`bad escape \\${n}`);
	}
	return out;
}

describe('the Codex config snippet', () => {
	it('round-trips any string through a TOML basic string', () => {
		const samples = ['plain', 'C:\\Users\\Sam Smith\\My "Vault"', "it's a vault", '/home/ann/Café/日本語', 'tab\there', 'back\\slash\\', 'quote"inside', 'ctl\u0001char\u007f', '\u00e9\u20ac\ud83d\ude00', ''];
		for (const s of samples) expect(decodeTomlBasic(tomlBasicString(s)), JSON.stringify(s)).toBe(s);
	});

	it('builds the table with the tools allow-listed and no shell command', () => {
		const res = buildCodexConfig('C:\\Vaults\\My Vault\\AI connectors\\ai-organiser-vault-server.cjs', 'C:\\Vaults\\My Vault');
		expect(res).toEqual({
			ok: true,
			value: [
				'[mcp_servers.ai-organiser-vault]',
				'command = "node"',
				'args = ["C:\\\\Vaults\\\\My Vault\\\\AI connectors\\\\ai-organiser-vault-server.cjs", "C:\\\\Vaults\\\\My Vault"]',
				'startup_timeout_sec = 10',
				'enabled_tools = ["search_notes", "read_note", "list_folder", "get_workspace_pack"]',
			].join('\n'),
		});
	});

	it('keeps a path with quotes and spaces intact and refuses unusable paths', () => {
		const vault = '/Users/ann/Ann\'s "big" vault';
		const res = buildCodexConfig('/x/server.cjs', vault);
		if (!res.ok) throw new Error(res.error);
		const argsLine = res.value.split('\n').find((l) => l.startsWith('args = '))!;
		const strings = [...argsLine.matchAll(/"(?:[^"\\]|\\.)*"/g)].map((m) => decodeTomlBasic(m[0]));
		expect(strings).toEqual(['/x/server.cjs', vault]);
		expect(buildCodexConfig('', vault).ok).toBe(false);
		expect(buildCodexConfig('/x/server.cjs', 'a\nb').ok).toBe(false);
	});

	it('spells generated paths for the platform they will be used on', () => {
		expect(absoluteGeneratedPath('C:\\Vaults\\Mine', 'AI connectors/Sub', 'f.cjs', '\\')).toBe('C:\\Vaults\\Mine\\AI connectors\\Sub\\f.cjs');
		expect(absoluteGeneratedPath('/Users/a/Vault/', 'AI connectors', 'f.cjs', '/')).toBe('/Users/a/Vault/AI connectors/f.cjs');
	});
});
