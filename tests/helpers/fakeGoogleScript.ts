/** Runs a generated Google script against fake Google services. Nothing here touches a real Apps Script deployment. */
import crypto from 'node:crypto';

export type FakeTask = { id: string; title: string; notes?: string; status?: string };
export interface World { lists: Record<string, FakeTask[]>; props: Record<string, string>; seq: number; deletes: number; taskCalls: number }
export const newWorld = (): World => ({ lists: { LA: [], LB: [], LC: [] }, props: {}, seq: 0, deletes: 0, taskCalls: 0 });

export function run(script: string, world: World, body: string): string {
  const sandbox = {
    ContentService: { createTextOutput: (s: string) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
    Utilities: { computeDigest: (_a: unknown, input: string) => [...crypto.createHash('sha256').update(input).digest()].map((b) => (b > 127 ? b - 256 : b)), DigestAlgorithm: { SHA_256: 'x' } },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() { /* test lock */ } }) },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperties: () => ({ ...world.props }),
        getProperty: (k: string) => world.props[k] ?? null,
        setProperty: (k: string, v: string) => { world.props[k] = v; },
        deleteProperty: (k: string) => { world.deletes++; delete world.props[k]; },
      }),
    },
    Tasks: {
      Tasklists: { list: () => { world.taskCalls++; return { items: Object.keys(world.lists).map((k) => ({ id: k, title: `Title ${k}` })) }; } },
      Tasks: {
        list: (listId: string) => ({ items: world.lists[listId] ?? [] }),
        insert: (b: { title: string; notes: string }, listId: string) => { const t: FakeTask = { id: `t${++world.seq}`, title: b.title, notes: b.notes, status: 'needsAction' }; (world.lists[listId] ??= []).push(t); return t; },
        get: (listId: string, taskId: string) => { const f = (world.lists[listId] ?? []).find((t) => t.id === taskId); if (!f) throw new Error('Not Found 404'); return f; },
      },
    },
  };
  const fn = new Function('sandbox', `with (sandbox) { ${script}; return doPost; }`);
  return (fn(sandbox) as (e: unknown) => { s: string })({ postData: { contents: body } }).s;
}
