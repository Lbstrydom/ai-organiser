import { describe, it, expect } from 'vitest';
import {
	buildClaudeDesktopFilesystemConfig, buildGeminiSettingsSnippet, checkInstructionSize, claudeDesktopConfigPath, claudeDesktopLogPath,
	CODEX_INSTRUCTION_LIMIT_BYTES, CONNECTOR_ENTRY_NAME, FILESYSTEM_SERVER_PACKAGE, platformOf, ROUTE_CLAIMS, validateVaultPath,
} from '../src/services/agentConnectors/connectorGuides';

describe('config locations (from the vendor documentation)', () => {
	it('gives the two documented Claude Desktop paths and none for other systems', () => {
		expect(claudeDesktopConfigPath('darwin')).toBe('~/Library/Application Support/Claude/claude_desktop_config.json');
		expect(claudeDesktopConfigPath('win32')).toBe('%APPDATA%\\Claude\\claude_desktop_config.json');
		expect(claudeDesktopConfigPath('linux')).toBeNull();
		expect(claudeDesktopLogPath('linux')).toBeNull();
		expect(platformOf('freebsd')).toBe('other');
		expect(claudeDesktopConfigPath(platformOf('freebsd'))).toBeNull();
	});
});

describe('Claude Desktop filesystem snippet', () => {
	const parse = (vault: string) => {
		const res = buildClaudeDesktopFilesystemConfig(vault);
		if (!res.ok) throw new Error(res.error);
		return JSON.parse(res.value) as { mcpServers: Record<string, { command: string; args: string[] }> };
	};

	it('is valid JSON that carries the vault path exactly, whatever it contains', () => {
		const paths = [
			'/Users/sam/Vault',
			'C:\\Users\\Sam Smith\\Documents\\My Vault',
			'/home/ann/Café "notes" \'v2\'',
			'D:\\Données\\日本語\\vault',
			'\\\\server\\share\\vault',
		];
		for (const p of paths) {
			const entry = parse(p).mcpServers[CONNECTOR_ENTRY_NAME];
			expect(entry.command).toBe('npx');
			expect(entry.args).toEqual(['-y', FILESYSTEM_SERVER_PACKAGE, p]);
		}
	});

	it('matches the documented shape byte for byte', () => {
		expect(buildClaudeDesktopFilesystemConfig('/v')).toEqual({
			ok: true,
			value: ['{', '  "mcpServers": {', '    "ai-organiser-vault": {', '      "command": "npx",', '      "args": [', '        "-y",', '        "@modelcontextprotocol/server-filesystem",', '        "/v"', '      ]', '    }', '  }', '}'].join('\n'),
		});
	});

	it('refuses a path it cannot put in a snippet', () => {
		for (const bad of ['', '   ', 'a\nb', 'a\u0000b', 'x'.repeat(2000)]) {
			expect(validateVaultPath(bad)).toEqual({ ok: false, error: 'connector-vault-path-unavailable' });
			expect(buildClaudeDesktopFilesystemConfig(bad).ok).toBe(false);
		}
	});
});

describe('other snippets and checks', () => {
	it('makes Gemini CLI read AGENTS.md as well as GEMINI.md', () => {
		expect(JSON.parse(buildGeminiSettingsSnippet())).toEqual({ context: { fileName: ['AGENTS.md', 'GEMINI.md'] } });
	});

	it('compares the instructions with the Codex budget in bytes, not characters', () => {
		expect(checkInstructionSize('short').level).toBe('ok');
		expect(checkInstructionSize('x'.repeat(25 * 1024)).level).toBe('warn');
		expect(checkInstructionSize('x'.repeat(CODEX_INSTRUCTION_LIMIT_BYTES + 1)).level).toBe('over');
		// 11 000 three-byte characters are 33 000 bytes although only 11 000 characters.
		expect(checkInstructionSize('€'.repeat(11_000)).level).toBe('over');
	});
});

describe('what each route claims', () => {
	it('only the read-only connector and the export claim that the scope is enforced; the open routes say files can change', () => {
		expect(ROUTE_CLAIMS['claude-desktop-filesystem']).toMatchObject({ enforcesScope: false, canChangeFiles: true });
		expect(ROUTE_CLAIMS['command-line-agent']).toMatchObject({ enforcesScope: false, canChangeFiles: true });
		expect(ROUTE_CLAIMS['codex-agents-md']).toMatchObject({ enforcesScope: false, canChangeFiles: true });
		expect(ROUTE_CLAIMS['read-only-connector']).toMatchObject({ enforcesScope: true, canChangeFiles: false });
		expect(ROUTE_CLAIMS['chat-project']).toMatchObject({ enforcesScope: true, canChangeFiles: false });
		// Every route that gives an AI app note information sends it to the provider.
		expect(Object.values(ROUTE_CLAIMS).every((c) => c.sendsNamesToProvider)).toBe(true);
	});
});
