/**
 * "Test the connector": start the saved server file exactly as an AI app would, and check it twice in
 * two fresh processes: once the way older clients talk (initialize, initialized, tools/list, a tool
 * call) and once the way current clients talk (server/discover, tools/list and a tool call, each with
 * its own protocol metadata and no handshake). It reports only what it saw: that the server started and
 * answered correctly. It cannot know whether an AI app is connected.
 *
 * Pure of Obsidian: the program starter and the timer are injected, so it is tested against the real
 * server file without a desktop.
 */
import { Result, ok, err } from '../../core/result';
import type { SpawnedChild, Spawner } from './localTools';

export const SELF_TEST_LIMIT_MS = 8000;
const MODERN = '2026-07-28';
const TOOLS = 'search_notes,read_note,list_folder';
/** The pack tool is listed only while the published scope serves packs; the test accepts the list with or without it, nothing else. */
const TOOLS_WITH_PACK = `${TOOLS},get_workspace_pack`;
const toolsOk = (listed: string): boolean => listed === TOOLS || listed === TOOLS_WITH_PACK;

export interface SelfTestResult {
    /** Entries the connector shows at the top level of the vault */
    topLevelItems: number;
}

interface Reply { id?: unknown; result?: Record<string, unknown>; error?: { code?: number } }

interface Timers { set(fn: () => void, ms: number): number; clear(id: number): void }

/** What a flow can do on one running server. */
interface Conversation {
    ask(method: string, params?: unknown): Promise<Reply>;
    notify(method: string): void;
}

const FAILED = 'connector-test-failed';

/** Start the server once, run `flow` against it within the time limit, and always stop it. */
function converse<T>(spawn: Spawner, serverPath: string, vaultPath: string, timers: Timers, flow: (c: Conversation) => Promise<Result<T>>): Promise<Result<T>> {
    return new Promise((resolve) => {
        let child: SpawnedChild | null = null;
        let settled = false;
        let buffer = '';
        let nextId = 1;
        const waiting = new Map<number, (reply: Reply) => void>();
        const finish = (result: Result<T>): void => {
            if (settled) return;
            settled = true;
            timers.clear(timer);
            try { child?.stdin?.end(); } catch { /* already closed */ }
            try { child?.kill?.(); } catch { /* already gone */ }
            resolve(result);
        };
        const timer = timers.set(() => finish(err(FAILED)), SELF_TEST_LIMIT_MS);
        const conversation: Conversation = {
            ask: (method, params) => new Promise((done) => {
                const id = nextId++;
                waiting.set(id, done);
                child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
            }),
            notify: (method) => { child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`); },
        };
        try {
            child = spawn('node', [serverPath, vaultPath], { stdio: 'pipe', windowsHide: true });
            child.stdout?.on('data', (chunk) => {
                buffer += chunk.toString();
                let nl = buffer.indexOf('\n');
                while (nl !== -1) {
                    const line = buffer.slice(0, nl);
                    buffer = buffer.slice(nl + 1);
                    try {
                        const reply = JSON.parse(line) as Reply;
                        if (typeof reply.id === 'number') { const w = waiting.get(reply.id); waiting.delete(reply.id); w?.(reply); }
                    } catch { /* not ours to interpret */ }
                    nl = buffer.indexOf('\n');
                }
            });
            child.stdin?.on?.('error', () => undefined);
            child.on('error', () => finish(err(FAILED)));
            child.on('close', () => finish(err(FAILED)));
            void flow(conversation).then(finish, () => finish(err(FAILED)));
        } catch {
            finish(err(FAILED));
        }
    });
}

const toolNames = (r: Reply): string => (Array.isArray(r.result?.tools) ? (r.result.tools as Array<{ name?: unknown }>).map((t) => String(t.name)).join() : '');

/** Items in a `list_folder` answer, or null when the answer is not a successful one. */
function itemsOf(reply: Reply): number | null {
    const content = reply.result?.content;
    if (reply.error || !Array.isArray(content) || reply.result?.isError === true) return null;
    const first = (content[0] as { text?: unknown } | undefined)?.text;
    if (typeof first !== 'string') return null;
    return first === 'Nothing here.' ? 0 : first.split('\n').filter((l) => l !== '' && !l.startsWith('...')).length;
}

export async function runConnectorSelfTest(spawn: Spawner, serverPath: string, vaultPath: string, timers: Timers): Promise<Result<SelfTestResult>> {
    const meta = { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } };

    const legacy = await converse<number>(spawn, serverPath, vaultPath, timers, async (c) => {
        const init = await c.ask('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'ai-organiser-test', version: '1' } });
        if (typeof init.result?.protocolVersion !== 'string') return err(FAILED);
        c.notify('notifications/initialized');
        if (!toolsOk(toolNames(await c.ask('tools/list')))) return err(FAILED);
        const items = itemsOf(await c.ask('tools/call', { name: 'list_folder', arguments: {} }));
        return items === null ? err(FAILED) : ok(items);
    });
    if (!legacy.ok) return err(legacy.error);

    // A second, fresh process: no handshake of any kind has happened on it.
    const modern = await converse<number>(spawn, serverPath, vaultPath, timers, async (c) => {
        const discover = await c.ask('server/discover', meta);
        const versions = discover.result?.supportedVersions;
        if (!Array.isArray(versions) || !versions.includes(MODERN)) return err(FAILED);
        const tools = await c.ask('tools/list', meta);
        if (!toolsOk(toolNames(tools)) || tools.result?.resultType !== 'complete') return err(FAILED);
        const call = await c.ask('tools/call', { ...meta, name: 'list_folder', arguments: {} });
        const items = itemsOf(call);
        return items === null || call.result?.resultType !== 'complete' ? err(FAILED) : ok(items);
    });
    if (!modern.ok) return err(modern.error);
    // Both flows read the same vault through the same scope.
    return legacy.value === modern.value ? ok({ topLevelItems: modern.value }) : err(FAILED);
}
