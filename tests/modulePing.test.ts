import { describe, it, expect, vi } from 'vitest';

const callScript = vi.fn();
vi.mock('../src/services/appsScriptClient', () => ({ callScript: (...args: unknown[]) => callScript(...args) }));

import { pingModule } from '../src/services/googleScript/modulePing';

describe('pingModule', () => {
  const endpoint = { url: 'https://script.google.com/macros/s/AKfycbxTEST/exec', secret: 'S' };

  it('asks for a ping with the secret in the body channel and normalises the answer', async () => {
    callScript.mockResolvedValueOnce({ ok: true, value: { ok: true, scriptVersion: 1, approvedListId: 'L', listHash: 'h' } });
    expect(await pingModule('tasks', endpoint)).toEqual({ ok: true, value: { module: 'tasks', version: 1, capabilities: ['upsert', 'lists'], legacy: true } });
    expect(callScript).toHaveBeenLastCalledWith(expect.objectContaining({ ...endpoint, body: { op: 'ping' } }));
  });

  it('a transport failure keeps its stable code; an unreadable answer is a bad response', async () => {
    callScript.mockResolvedValueOnce({ ok: false, error: 'script-login-page' });
    expect(await pingModule('tasks', endpoint)).toEqual({ ok: false, error: 'script-login-page' });
    callScript.mockResolvedValueOnce({ ok: true, value: { ok: true, scriptVersion: 'x' } });
    expect(await pingModule('inventory', endpoint)).toEqual({ ok: false, error: 'script-bad-response' });
  });
});
