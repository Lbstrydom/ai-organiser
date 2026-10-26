/**
 * The connector server's source, checked as text (what it may and may not contain) and for parity
 * with the plugin's own scope rule over thousands of generated paths.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CONNECTOR_SCOPE_GENERATOR, CONNECTOR_SCOPE_PATH, CONNECTOR_SERVER_MARKER, CONNECTOR_SERVER_SOURCE } from '../src/services/agentConnectors/connectorServerSource';
import { CONNECTOR_SCOPE_PATH as PUBLISHER_SCOPE_PATH, CONNECTOR_SCOPE_GENERATOR as PUBLISHER_GENERATOR } from '../src/services/agentConnectors/connectorScope';
import { isInIndexScope, type IndexScopeConfig } from '../src/services/agentIndex/agentIndexService';

describe('what the server source contains', () => {
	const source = CONNECTOR_SERVER_SOURCE;

	it('starts with its marker and fits inside a raw template literal', () => {
		expect(source.split('\n')[0]).toBe(CONNECTOR_SERVER_MARKER);
		expect(source).not.toContain('`');
		expect(source).not.toContain('${');
	});

	it('requires only fs, path, os and crypto (a hash)', () => {
		const required = [...source.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).sort();
		expect(required).toEqual(['node:crypto', 'node:fs', 'node:os', 'node:path']);
		expect(source).not.toMatch(/\bimport\s+[\w{*]/);
	});

	it('has no way to write, change, run a program or reach the network', () => {
		const forbidden = [
			'writeFile', 'appendFile', 'createWriteStream', 'unlink', 'rmdir', 'rmSync', 'fsp.rm(', 'fs.rm(', 'rename', 'mkdir', 'copyFile', 'truncate', 'chmod', 'chown', 'utimes', 'symlink', 'link(',
			'child_process', 'worker_threads', 'node:net', 'node:http', 'node:https', 'node:dgram', 'node:dns', 'node:tls', 'node:vm',
			'fetch(', 'XMLHttpRequest', 'WebSocket', 'eval(', 'new Function', 'process.binding', 'process.dlopen', 'process.kill', 'spawn', 'exec(', 'setTimeout', 'setInterval',
		];
		for (const token of forbidden) expect(source.includes(token), token).toBe(false);
		// The only mode a file is opened with is read.
		const opens = [...source.matchAll(/fsp\.open\(([^)]*)\)/g)].map((m) => m[1]);
		expect(opens.length).toBeGreaterThan(0);
		for (const args of opens) expect(args.endsWith("'r'")).toBe(true);
	});

	it('agrees with the plugin on where the scope lives and what makes it ours', () => {
		expect(CONNECTOR_SCOPE_PATH).toBe(PUBLISHER_SCOPE_PATH);
		expect(CONNECTOR_SCOPE_GENERATOR).toBe(PUBLISHER_GENERATOR);
		expect(source).toContain(`const SCOPE_PATH = '${CONNECTOR_SCOPE_PATH}';`);
		expect(source).toContain(`const SCOPE_GENERATOR = '${CONNECTOR_SCOPE_GENERATOR}';`);
		// No other vault location is hard-coded: the only dot-folder path in the source is the scope file.
		const hardCoded = [...source.matchAll(/'(\.ai-organiser[^']*)'/g)].map((m) => m[1]);
		expect(new Set(hardCoded)).toEqual(new Set([CONNECTOR_SCOPE_PATH]));
	});
});

describe('scope parity with the plugin', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-parity-'));
	const file = path.join(dir, 'server.cjs');
	fs.writeFileSync(file, CONNECTOR_SERVER_SOURCE);
	const server = createRequire(path.join(process.cwd(), 'package.json'))(file) as {
		scopeAllows(p: string, scope: { includeFolders: string[]; excludeFolders: string[]; protectedFolders: string[] }): boolean;
		folderVisible(p: string, scope: { includeFolders: string[]; excludeFolders: string[]; protectedFolders: string[] }): boolean;
	};
	afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

	// A small seeded generator: the same table on every run.
	function rng(seed: number): () => number {
		let a = seed;
		return () => {
			a |= 0; a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}
	const rand = rng(20261022);
	const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];

	const names = ['Notes', 'notes', 'NOTES', 'Note', 'Notes2', 'Private', 'private', 'Priv', 'A', 'a', 'B-b', 'my notes', 'Café', 'Ünï', '日本', '.hidden', '..x', 'x.', '1', 'Course', 'Archive'];
	const separators = ['/', '/', '/', '//', '\\', '/./', '/../'];
	function randomPath(): string {
		const depth = 1 + Math.floor(rand() * 4);
		let p = rand() < 0.1 ? '/' : rand() < 0.05 ? './' : '';
		for (let i = 0; i < depth; i++) p += pick(names) + (i < depth - 1 ? pick(separators) : '');
		if (rand() < 0.6) p += '.md';
		if (rand() < 0.1) p += '/';
		return p;
	}
	const randomFolders = (max: number): string[] => Array.from({ length: Math.floor(rand() * (max + 1)) }, () => (rand() < 0.1 ? '' : rand() < 0.15 ? `${pick(names)}/${pick(names)}` : pick(names)) + (rand() < 0.1 ? '/' : ''));

	it('gives the same answer as isInIndexScope for 6 000 generated paths across 40 scopes', () => {
		let disagreements = 0;
		let included = 0;
		for (let s = 0; s < 40; s++) {
			const include = randomFolders(2);
			const exclude = randomFolders(2);
			const prot = randomFolders(2);
			const config: IndexScopeConfig = { includeFolders: include, excludeFolders: [...exclude, ...prot], includeAliases: false, includeHeadings: false, frontmatterKeys: [], exportUnresolvedLinks: false };
			for (let i = 0; i < 150; i++) {
				const p = randomPath();
				const a = isInIndexScope(p, config);
				const b = server.scopeAllows(p, { includeFolders: include, excludeFolders: exclude, protectedFolders: prot });
				if (a !== b) disagreements++;
				if (a) included++;
			}
		}
		expect(disagreements).toBe(0);
		expect(included).toBeGreaterThan(200); // the table exercises both answers
	});

	it('agrees on a fixed table of tricky spellings', () => {
		const scopes = [
			{ include: [], exclude: ['Private'], prot: ['Course'] },
			{ include: ['Notes'], exclude: ['Notes/Private'], prot: [] },
			{ include: ['Notes', 'Archive'], exclude: [], prot: ['notes/locked'] },
			{ include: [], exclude: ['A/B'], prot: [] },
		];
		const paths = ['Private', 'Private/x.md', 'private/x.md', 'PRIVATE/X.md', 'Privateer/x.md', 'Notes', 'Notes/Private/x.md', 'Notes/private/x.md', 'Notes/locked/x.md', 'notes/LOCKED/x.md', 'Notes2/x.md',
			'A/B/c.md', 'A/Bc/c.md', 'A/b/c.md', '.hidden/x.md', 'Notes/.hidden/x.md', '', '/', 'Course/x.md', 'x/../Private/y.md', 'Notes/../Private/y.md', 'Notes//Private//y.md', 'Notes\\Private\\y.md'];
		for (const sc of scopes) {
			for (const p of paths) {
				const expected = isInIndexScope(p, { includeFolders: sc.include, excludeFolders: [...sc.exclude, ...sc.prot], includeAliases: false, includeHeadings: false, frontmatterKeys: [], exportUnresolvedLinks: false });
				expect(server.scopeAllows(p, { includeFolders: sc.include, excludeFolders: sc.exclude, protectedFolders: sc.prot }), `${JSON.stringify(sc)} ${JSON.stringify(p)}`).toBe(expected);
			}
		}
	});

	it('shows a folder whenever a note inside it could be allowed, and never an excluded one', () => {
		for (let s = 0; s < 40; s++) {
			const scope = { includeFolders: randomFolders(2), excludeFolders: randomFolders(2), protectedFolders: randomFolders(2) };
			for (let i = 0; i < 100; i++) {
				const folder = randomPath().replace(/\.md\/?$/, '').replace(/\/$/, '');
				if (server.scopeAllows(`${folder}/note.md`, scope)) expect(server.folderVisible(folder, scope), `${JSON.stringify(scope)} ${folder}`).toBe(true);
				const norm = folder.split('\\').join('/').split('/').filter((x) => x !== '' && x !== '.').join('/');
				const excluded = [...scope.excludeFolders, ...scope.protectedFolders].some((f) => {
					const nf = f.split('\\').join('/').split('/').filter((x) => x !== '' && x !== '.').join('/').toLowerCase();
					return nf !== '' && (norm.toLowerCase() === nf || norm.toLowerCase().startsWith(`${nf}/`)) && !norm.includes('..');
				});
				if (excluded) expect(server.folderVisible(folder, scope), `${JSON.stringify(scope)} ${folder}`).toBe(false);
			}
		}
	});
});
