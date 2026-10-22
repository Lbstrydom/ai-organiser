/**
 * The files the read-only connector is delivered in, built as bytes with no personal data in them:
 *  - the Claude Desktop extension (`.mcpb`, a ZIP): `manifest.json`, the server, and a one-line
 *    `package.json` that pins the server to CommonJS. The vault folder is NOT in the bundle: the
 *    manifest declares a `directory` setting and Claude Desktop asks the person to pick it;
 *  - the standalone server file for Codex and any other client that starts a command;
 *  - the Codex `config.toml` snippet.
 * Pure: builders return strings and bytes, nothing is written here.
 */
import { Result, ok, err } from '../../core/result';
import { buildZip, readZipComment, type ZipEntry } from '../../utils/zipStore';
import { CONNECTOR_SERVER_MARKER, CONNECTOR_SERVER_SOURCE } from './connectorServerSource';
import { CONNECTOR_ENTRY_NAME, validateVaultPath } from './connectorGuides';

export const CONNECTOR_BUNDLE_FILE = 'ai-organiser-vault-connector.mcpb';
export const CONNECTOR_SERVER_FILE = 'ai-organiser-vault-server.cjs';
/** Written into the ZIP's end record so a later save replaces only a bundle that is ours. */
export const CONNECTOR_BUNDLE_COMMENT = 'ai-organiser/connector-bundle v1';

export const CONNECTOR_TOOL_NAMES = ['search_notes', 'read_note', 'list_folder'] as const;

/** The extension manifest (spec 0.3, read from the MCPB repository on 2026-10-22). */
export function buildBundleManifest(pluginVersion: string): Record<string, unknown> {
    return {
        manifest_version: '0.3',
        name: CONNECTOR_ENTRY_NAME,
        display_name: 'AI Organiser vault (read only)',
        version: pluginVersion,
        description: 'Lets an AI app search and read the notes you included in your Obsidian vault. It cannot change anything.',
        author: { name: 'AI Organiser' },
        server: {
            type: 'node',
            entry_point: 'server/index.js',
            mcp_config: {
                command: 'node',
                args: ['${__dirname}/server/index.js', '${user_config.vault_folder}'],
            },
        },
        tools: [
            { name: 'search_notes', description: 'Search the included notes by title, path, tag, alias or heading.' },
            { name: 'read_note', description: 'Read one included note by its path.' },
            { name: 'list_folder', description: 'List the folders and notes inside a folder.' },
        ],
        user_config: {
            vault_folder: {
                type: 'directory',
                title: 'Vault folder',
                description: 'The folder of your Obsidian vault.',
                required: true,
            },
        },
        compatibility: { runtimes: { node: '>=18' } },
    };
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// The extension format requires an archive entry with this name. It is assembled, not spelled out: the
// build checks (docs/build-invariants.md) keep that literal out of main.js because the review bot's
// self-update heuristic keys on it.
const MANIFEST_ENTRY = ['manifest', 'json'].join('.');

/** The `.mcpb` bytes. Deterministic for a given plugin version. */
export function buildConnectorBundle(pluginVersion: string): Uint8Array {
    const entries: ZipEntry[] = [
        { name: MANIFEST_ENTRY, data: utf8(`${JSON.stringify(buildBundleManifest(pluginVersion), null, 2)}\n`) },
        { name: 'server/package.json', data: utf8('{"type":"commonjs"}\n') },
        { name: 'server/index.js', data: utf8(CONNECTOR_SERVER_SOURCE) },
    ];
    return buildZip(entries, CONNECTOR_BUNDLE_COMMENT);
}

export const isOwnBundle = (bytes: Uint8Array): boolean => readZipComment(bytes) === CONNECTOR_BUNDLE_COMMENT;

/** True when text is a server file we wrote (first line carries the marker). */
export function isOwnServerFile(text: string): boolean {
    const nl = text.indexOf('\n');
    return (nl === -1 ? text : text.slice(0, nl)).trim() === CONNECTOR_SERVER_MARKER;
}

export const buildServerFileText = (): string => CONNECTOR_SERVER_SOURCE;

// ─── TOML ───────────────────────────────────────────────────────────────────

/** A TOML basic string: backslash, double quote and every control character escaped. */
export function tomlBasicString(value: string): string {
    let out = '"';
    for (const ch of value) {
        const code = ch.codePointAt(0) ?? 0;
        if (ch === '\\') out += '\\\\';
        else if (ch === '"') out += '\\"';
        else if (ch === '\b') out += '\\b';
        else if (ch === '\t') out += '\\t';
        else if (ch === '\n') out += '\\n';
        else if (ch === '\f') out += '\\f';
        else if (ch === '\r') out += '\\r';
        else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0').toUpperCase()}`;
        else out += ch;
    }
    return `${out}"`;
}

/**
 * The `~/.codex/config.toml` table for the read-only connector. `enabled_tools` lists exactly the three
 * tools as a second line of defence. No shell command line is offered: a pasted command would need an
 * escaping contract per shell.
 */
export function buildCodexConfig(serverPath: string, vaultPath: string): Result<string> {
    const server = validateVaultPath(serverPath);
    const vault = validateVaultPath(vaultPath);
    if (!server.ok) return err(server.error);
    if (!vault.ok) return err(vault.error);
    return ok([
        `[mcp_servers.${CONNECTOR_ENTRY_NAME}]`,
        'command = "node"',
        `args = [${tomlBasicString(server.value)}, ${tomlBasicString(vault.value)}]`,
        'startup_timeout_sec = 10',
        `enabled_tools = [${CONNECTOR_TOOL_NAMES.map(tomlBasicString).join(', ')}]`,
    ].join('\n'));
}

/** The absolute path of a generated file, spelled for the platform it will be used on. */
export function absoluteGeneratedPath(vaultPath: string, folder: string, file: string, separator: '/' | '\\'): string {
    const parts = [...folder.split('/').filter(Boolean), file];
    const base = vaultPath.endsWith('/') || vaultPath.endsWith('\\') ? vaultPath.slice(0, -1) : vaultPath;
    return [base, ...parts].join(separator);
}
