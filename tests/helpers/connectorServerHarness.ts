/**
 * Test harness: a synthetic vault on disk, and the real connector server running as a child process
 * that speaks line-delimited JSON-RPC. Nothing here comes from a real vault.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONNECTOR_SCOPE_PATH, CONNECTOR_SERVER_SOURCE } from '../../src/services/agentConnectors/connectorServerSource';

export interface ScopeShape {
	include?: string[];
	exclude?: string[];
	protectedFolders?: string[];
	indexPath?: string;
	disabled?: boolean;
}

export interface TestVault {
	root: string;
	serverFile: string;
	write(rel: string, text: string): void;
	writeScope(scope?: ScopeShape): void;
	writeIndex(notes: Array<{ path: string; tags?: string[]; aliases?: string[]; headings?: string[] }>, indexPath?: string): void;
	cleanup(): void;
}

export function makeVault(): TestVault {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-connector-'));
	const root = path.join(base, 'Vault');
	fs.mkdirSync(root);
	const serverFile = path.join(base, 'server.cjs');
	fs.writeFileSync(serverFile, CONNECTOR_SERVER_SOURCE);
	const write = (rel: string, text: string): void => {
		const abs = path.join(root, ...rel.split('/'));
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, text);
	};
	return {
		root,
		serverFile,
		write,
		writeScope(scope: ScopeShape = {}) {
			write(CONNECTOR_SCOPE_PATH, JSON.stringify({
				generator: 'ai-organiser/connector-scope', version: 1, revision: 'r', generatedAt: 'now',
				disabled: scope.disabled ?? false,
				includeFolders: scope.include ?? [], excludeFolders: scope.exclude ?? [], protectedFolders: scope.protectedFolders ?? [],
				indexPath: scope.indexPath ?? '.ai-organiser/agent-index.jsonl',
			}));
		},
		writeIndex(notes, indexPath = '.ai-organiser/agent-index.jsonl') {
			const header = { type: 'header', schemaVersion: 1, generator: 'ai-organiser/agent-index', outputPath: indexPath, buildId: 'b', generatedAt: 'now', scopeHash: 'h', stale: false, files: [] };
			const lines = [header, ...notes.map((n) => ({ type: 'note', path: n.path, basename: n.path.slice(n.path.lastIndexOf('/') + 1).replace(/\.md$/, ''), folder: '', tags: n.tags ?? [], mtime: 1, size: 1, sha256: 'x', links: [], aliases: n.aliases ?? [], headings: n.headings ?? [] }))];
			write(indexPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
		},
		cleanup() { fs.rmSync(base, { recursive: true, force: true }); },
	};
}

export interface Rpc {
	jsonrpc?: string;
	id?: unknown;
	method?: string;
	params?: unknown;
	[k: string]: unknown;
}

export class ServerClient {
	private readonly child: ChildProcessWithoutNullStreams;
	private buffer = '';
	private readonly lines: string[] = [];
	private waiter: (() => void) | null = null;
	stderr = '';
	exitCode: number | null | undefined;
	private readonly exited: Promise<number | null>;
	private nextId = 1;

	constructor(serverFile: string, vaultArg: string | null) {
		this.child = spawn(process.execPath, vaultArg === null ? [serverFile] : [serverFile, vaultArg], { stdio: ['pipe', 'pipe', 'pipe'] });
		this.child.stdout.setEncoding('utf8');
		this.child.stdout.on('data', (chunk: string) => {
			this.buffer += chunk;
			let nl = this.buffer.indexOf('\n');
			while (nl !== -1) {
				this.lines.push(this.buffer.slice(0, nl));
				this.buffer = this.buffer.slice(nl + 1);
				nl = this.buffer.indexOf('\n');
			}
			this.waiter?.();
		});
		this.child.stderr.setEncoding('utf8');
		this.child.stderr.on('data', (c: string) => { this.stderr += c; });
		this.exited = new Promise((resolve) => this.child.on('close', (code) => { this.exitCode = code; this.waiter?.(); resolve(code); }));
		this.child.stdin.on('error', () => undefined);
	}

	/** Send one raw line (no validation), exactly as given. */
	sendRaw(line: string): void { this.child.stdin.write(`${line}\n`); }
	send(msg: unknown): void { this.sendRaw(JSON.stringify(msg)); }

	/** The next line the server printed, parsed. Rejects if nothing arrives in time. */
	async next(timeoutMs = 4000): Promise<Rpc> {
		const deadline = Date.now() + timeoutMs;
		while (this.lines.length === 0) {
			if (this.exitCode !== undefined) throw new Error(`server exited (${this.exitCode}) before answering; stderr: ${this.stderr}`);
			const left = deadline - Date.now();
			if (left <= 0) throw new Error('no answer from the server');
			await new Promise<void>((resolve) => { const t = setTimeout(resolve, left); this.waiter = () => { clearTimeout(t); resolve(); }; });
		}
		return JSON.parse(this.lines.shift()!) as Rpc;
	}

	/** True when the server printed nothing more within a short wait. */
	async quiet(ms = 250): Promise<boolean> {
		await new Promise((r) => setTimeout(r, ms));
		return this.lines.length === 0;
	}

	async request(method: string, params?: unknown): Promise<Rpc> {
		const id = this.nextId++;
		this.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
		const reply = await this.next();
		if (reply.id !== id) throw new Error(`answer for another request: ${JSON.stringify(reply)}`);
		return reply;
	}

	/** Legacy handshake. */
	async initialize(version = '2025-11-25'): Promise<Rpc> {
		const reply = await this.request('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test', version: '0' } });
		this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
		return reply;
	}

	async call(name: string, args: Record<string, unknown> = {}, modern = false): Promise<{ text: string[]; isError: boolean; raw: Rpc }> {
		const params: Record<string, unknown> = { name, arguments: args };
		if (modern) params._meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' };
		const raw = await this.request('tools/call', params);
		const result = raw.result as { content?: Array<{ text: string }>; isError?: boolean } | undefined;
		return { text: (result?.content ?? []).map((c) => c.text), isError: result?.isError ?? false, raw };
	}

	closeInput(): void { this.child.stdin.end(); }
	async waitExit(): Promise<number | null> { return this.exited; }
	kill(): void { this.child.kill(); }
}
