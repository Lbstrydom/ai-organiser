/**
 * "Test the connector": start the saved server file exactly as an AI app would, and talk to it twice,
 * once the way older clients do (initialize, initialized, tools/list, a call) and once the way current
 * clients do (server/discover, tools/list with per-request metadata). Reports only what it saw: that
 * the server started and answered correctly. It cannot know whether an AI app is connected.
 *
 * Pure of Obsidian: the program starter and the timer are injected, so it is tested against the real
 * server file without a desktop.
 */
import { Result, ok, err } from '../../core/result';
import type { SpawnedChild, Spawner } from './localTools';

export const SELF_TEST_LIMIT_MS = 8000;
const MODERN = '2026-07-28';

export interface SelfTestResult {
    /** Entries the connector shows at the top level of the vault */
    topLevelItems: number;
}

interface Reply { id?: unknown; result?: Record<string, unknown>; error?: { code?: number } }

export function runConnectorSelfTest(
    spawn: Spawner,
    serverPath: string,
    vaultPath: string,
    timers: { set(fn: () => void, ms: number): number; clear(id: number): void },
): Promise<Result<SelfTestResult>> {
    return new Promise((resolve) => {
        let child: SpawnedChild | null = null;
        let settled = false;
        let buffer = '';
        const waiting = new Map<number, (reply: Reply) => void>();
        const finish = (result: Result<SelfTestResult>): void => {
            if (settled) return;
            settled = true;
            timers.clear(timer);
            try { child?.stdin?.end(); } catch { /* already closed */ }
            try { child?.kill?.(); } catch { /* already gone */ }
            resolve(result);
        };
        const timer = timers.set(() => finish(err('connector-test-failed')), SELF_TEST_LIMIT_MS);

        const ask = (id: number, method: string, params?: unknown): Promise<Reply> => new Promise((done) => {
            waiting.set(id, done);
            child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
        });
        const meta = { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } };
        const toolNames = (r: Reply): string[] => (Array.isArray(r.result?.tools) ? (r.result.tools as Array<{ name?: unknown }>).map((t) => String(t.name)) : []);

        const run = async (): Promise<void> => {
            const init = await ask(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'ai-organiser-test', version: '1' } });
            if (typeof init.result?.protocolVersion !== 'string') return finish(err('connector-test-failed'));
            child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
            const legacyTools = await ask(2, 'tools/list');
            if (toolNames(legacyTools).join() !== 'search_notes,read_note,list_folder') return finish(err('connector-test-failed'));

            const discover = await ask(3, 'server/discover', meta);
            const versions = discover.result?.supportedVersions;
            if (!Array.isArray(versions) || !versions.includes(MODERN)) return finish(err('connector-test-failed'));
            const modernTools = await ask(4, 'tools/list', meta);
            if (toolNames(modernTools).join() !== 'search_notes,read_note,list_folder' || modernTools.result?.resultType !== 'complete') return finish(err('connector-test-failed'));

            const list = await ask(5, 'tools/call', { ...meta, name: 'list_folder', arguments: {} });
            const content = list.result?.content;
            if (list.error || !Array.isArray(content) || list.result?.isError === true) return finish(err('connector-test-failed'));
            const first = (content[0] as { text?: unknown } | undefined)?.text;
            const text = typeof first === 'string' ? first : '';
            finish(ok({ topLevelItems: text === 'Nothing here.' ? 0 : text.split('\n').filter((l) => l !== '' && !l.startsWith('...')).length }));
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
            child.on('error', () => finish(err('connector-test-failed')));
            child.on('close', () => finish(err('connector-test-failed')));
            void run().catch(() => finish(err('connector-test-failed')));
        } catch {
            finish(err('connector-test-failed'));
        }
    });
}
