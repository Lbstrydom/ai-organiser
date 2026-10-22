/**
 * What the "Connect an AI app" screens show. Pure of Obsidian: every snippet is built here from plain
 * inputs so it can be tested against golden strings, and none of it is ever written to another
 * application's files (the screens only offer Copy buttons).
 *
 * Only facts read from the vendors' own documentation are pinned, each in one constant beside the
 * link a person can follow to check it; anything else is "see the documentation".
 */
import { Result, ok, err } from '../../core/result';

/** The vendors' documentation, linked rather than copied. */
export const CONNECTOR_DOCS = {
    claudeDesktopLocalServers: 'https://modelcontextprotocol.io/docs/develop/connect-local-servers',
    claudeDesktopExtensions: 'https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop',
    claudeCodeMemory: 'https://code.claude.com/docs/en/memory',
    codexMcp: 'https://developers.openai.com/codex/mcp',
    codexAgentsMd: 'https://developers.openai.com/codex/guides/agents-md',
    geminiContextFiles: 'https://geminicli.com/docs/cli/gemini-md',
    nodejs: 'https://nodejs.org/',
} as const;

/** The name the connector entry carries in the other application's configuration. */
export const CONNECTOR_ENTRY_NAME = 'ai-organiser-vault';

/** The official filesystem server package, the one vendor string the v1 route depends on. */
export const FILESYSTEM_SERVER_PACKAGE = '@modelcontextprotocol/server-filesystem';

/** Codex reads at most this much AGENTS.md text by default (`project_doc_max_bytes`). */
export const CODEX_INSTRUCTION_LIMIT_BYTES = 32 * 1024;
/** A warning is shown well before the limit, because other AGENTS.md files share the budget. */
export const CODEX_INSTRUCTION_WARN_BYTES = 24 * 1024;

export type ConnectorPlatform = 'darwin' | 'win32' | 'linux' | 'other';

export function platformOf(raw: string): ConnectorPlatform {
    return raw === 'darwin' || raw === 'win32' || raw === 'linux' ? raw : 'other';
}

/**
 * Where Claude Desktop keeps its configuration, from the official page. There is no Linux entry in
 * that page, so there is none here: the screen links the documentation instead of guessing a path.
 */
export function claudeDesktopConfigPath(platform: ConnectorPlatform): string | null {
    if (platform === 'darwin') return '~/Library/Application Support/Claude/claude_desktop_config.json';
    if (platform === 'win32') return '%APPDATA%\\Claude\\claude_desktop_config.json';
    return null;
}

/** Where Claude Desktop writes its MCP logs (official page), for the troubleshooting step. */
export function claudeDesktopLogPath(platform: ConnectorPlatform): string | null {
    if (platform === 'darwin') return '~/Library/Logs/Claude';
    if (platform === 'win32') return '%APPDATA%\\Claude\\logs';
    return null;
}

const MAX_PATH_CHARS = 1024;

/** A vault path is usable in a snippet when it is an absolute path without control characters. */
export function validateVaultPath(raw: string): Result<string> {
    if (typeof raw !== 'string' || raw.trim() === '' || raw.length > MAX_PATH_CHARS) return err('connector-vault-path-unavailable');
    // POSIX root, a drive letter, or a network share: anything else would be read relative to an unknown folder.
    if (!/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(raw)) return err('connector-vault-path-unavailable');
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
    if (/[\u0000-\u001f\u007f]/.test(raw)) return err('connector-vault-path-unavailable');
    return ok(raw);
}

/**
 * The entry to add to Claude Desktop's `claude_desktop_config.json` for the official filesystem server.
 * Built with `JSON.stringify`, so quotes, spaces, non-ASCII text and Windows backslashes are escaped
 * by construction. The user merges this under `mcpServers`; the screen says so.
 */
export function buildClaudeDesktopFilesystemConfig(vaultPath: string): Result<string> {
    const valid = validateVaultPath(vaultPath);
    if (!valid.ok) return err(valid.error);
    const config = { mcpServers: { [CONNECTOR_ENTRY_NAME]: { command: 'npx', args: ['-y', FILESYSTEM_SERVER_PACKAGE, valid.value] } } };
    return ok(JSON.stringify(config, null, 2));
}

/** The Gemini CLI `settings.json` snippet that makes it read `AGENTS.md` as well as `GEMINI.md`. */
export function buildGeminiSettingsSnippet(): string {
    return JSON.stringify({ context: { fileName: ['AGENTS.md', 'GEMINI.md'] } }, null, 2);
}

/** The line Claude Code users put in `CLAUDE.md` (the instructions text already says so too). */
export const CLAUDE_CODE_IMPORT_LINE = '@AGENTS.md';

export interface InstructionSizeCheck {
    bytes: number;
    level: 'ok' | 'warn' | 'over';
}

/** How the generated instructions compare with Codex's default `AGENTS.md` budget. */
export function checkInstructionSize(text: string): InstructionSizeCheck {
    const bytes = new TextEncoder().encode(text).length;
    return { bytes, level: bytes > CODEX_INSTRUCTION_LIMIT_BYTES ? 'over' : bytes > CODEX_INSTRUCTION_WARN_BYTES ? 'warn' : 'ok' };
}

// ─── The enforcement table ──────────────────────────────────────────────────

export type ConnectorRoute = 'claude-desktop-filesystem' | 'codex-agents-md' | 'read-only-connector' | 'command-line-agent' | 'chat-project';

/**
 * Which statements each route's screen makes. The wording lives in the translations; this table
 * fixes what is claimed, so a test can assert that no route claims enforcement it does not give and
 * that the read-only connector is the only route that claims any.
 */
export const ROUTE_CLAIMS: Record<ConnectorRoute, { enforcesScope: boolean; canChangeFiles: boolean; sendsNamesToProvider: boolean }> = {
    'claude-desktop-filesystem': { enforcesScope: false, canChangeFiles: true, sendsNamesToProvider: true },
    'codex-agents-md': { enforcesScope: false, canChangeFiles: true, sendsNamesToProvider: true },
    'read-only-connector': { enforcesScope: true, canChangeFiles: false, sendsNamesToProvider: true },
    'command-line-agent': { enforcesScope: false, canChangeFiles: true, sendsNamesToProvider: true },
    'chat-project': { enforcesScope: true, canChangeFiles: false, sendsNamesToProvider: true },
};
