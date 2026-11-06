/**
 * Connecting another device, run against the generated script on fake Google services. Nothing here touches a real Apps Script
 * deployment or a real device. Any refusal must leave the stored secret and the settings exactly as they were.
 */
import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { GUIDANCE_CODES, describeError } from '../src/core/friendlyErrors';
import { en } from '../src/i18n/en';
import { PLUGIN_SECRET_IDS } from '../src/core/secretIds';
import { buildCombinedScript } from '../src/services/googleScript/combinedScript';
import { buildTasksScript } from '../src/services/inboxSweep/tasksScriptTemplate';
import { connectDevice, createConnectionCode, encodeConnectionCode, ensureTasksSecret, parseConnectionInput, replaceTasksSecret } from '../src/services/inboxSweep/tasksConnection';
import type { ScriptTransport } from '../src/services/appsScriptClient';
import { logger } from '../src/utils/logger';
import { newWorld, run, type World } from './helpers/fakeGoogleScript';

vi.stubGlobal('window', globalThis);

const URL_OK = 'https://script.google.com/macros/s/AKfycbxTEST/exec';
const SECRET = 'a1'.repeat(24);
const OLD = 'c3'.repeat(24);
const v3 = buildCombinedScript({ secret: SECRET, tasks: { automatic: true } });

function device(over: Record<string, unknown> = {}, secret: string | null = null) {
  const settings = { ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), ...over };
  const store = { value: secret };
  const saveSettings = vi.fn(async () => undefined);
  const setSecret = vi.fn(async (id: string, value: string) => { expect(id).toBe(PLUGIN_SECRET_IDS.GOOGLE_TASKS); store.value = value; });
  const plugin = { settings, saveSettings, secretStorageService: { getSecret: async () => store.value, setSecret, removeSecret: async () => { store.value = null; } } };
  return { plugin: plugin as never, settings, store, saveSettings, setSecret };
}
const approvedWorld = (): World => {
  const world = newWorld();
  run(v3, world, JSON.stringify({ secret: SECRET, op: 'setLists', main: 'LA', ids: ['LA', 'LB'], expectedRevision: 0 }));
  return world;
};
const transportFor = (world: World, script = v3): ScriptTransport => async ({ body }) => ({ status: 200, text: run(script, world, body) });

describe('the connection code', () => {
  it('round trips, and survives the line breaks and spaces a phone paste can add', () => {
    const code = encodeConnectionCode(URL_OK, SECRET);
    expect(parseConnectionInput(code, '')).toEqual({ ok: true, value: { url: URL_OK, secret: SECRET } });
    expect(parseConnectionInput(`  ${code.slice(0, 20)}\n${code.slice(20)}\n`, '')).toEqual({ ok: true, value: { url: URL_OK, secret: SECRET } });
  });

  it('refuses anything malformed', () => {
    const good = encodeConnectionCode(URL_OK, SECRET);
    for (const raw of ['', 'hello', URL_OK, good.slice(0, 30), 'aio-connect-1.!!!', `aio-connect-1.${btoa('null')}`, `aio-connect-1.${btoa(JSON.stringify({ u: URL_OK }))}`, encodeConnectionCode('https://evil.example/exec', SECRET), encodeConnectionCode(URL_OK, 'short')]) {
      expect(parseConnectionInput(raw, URL_OK), raw).toEqual({ ok: false, error: 'tasks-connect-bad-code' });
    }
  });

  it('takes the bare secret or the whole script line, with the link from the field', () => {
    for (const raw of [SECRET, `"${SECRET}"`, `var SECRET = "${SECRET}";`, `  "SECRET": "${SECRET}",`]) {
      expect(parseConnectionInput(raw, URL_OK), raw).toEqual({ ok: true, value: { url: URL_OK, secret: SECRET } });
    }
    expect(parseConnectionInput(SECRET, '')).toEqual({ ok: false, error: 'tasks-connect-needs-link' });
    expect(parseConnectionInput(SECRET, 'https://evil.example/exec').ok).toBe(false);
  });

  it('is made only from what this device holds', async () => {
    const { plugin } = device({ tasksScriptUrl: URL_OK }, SECRET);
    expect(await createConnectionCode(plugin)).toEqual({ ok: true, value: encodeConnectionCode(URL_OK, SECRET) });
    expect(await createConnectionCode(device({ tasksScriptUrl: URL_OK }).plugin)).toEqual({ ok: false, error: 'tasks-no-secret' });
    expect((await createConnectionCode(device({}, SECRET).plugin)).ok).toBe(false);
  });
});

describe('connecting', () => {
  it('a device with nothing is ready afterwards, and nothing was approved or changed on the script', async () => {
    const world = approvedWorld();
    const before = JSON.stringify(world.props);
    const { plugin, settings, store, saveSettings } = device();
    const res = await connectDevice(plugin, encodeConnectionCode(URL_OK, SECRET), '', transportFor(world));
    expect(res).toEqual({ ok: true, value: { url: URL_OK, automatic: true, combined: true } });
    expect(store.value).toBe(SECRET);
    expect(settings).toMatchObject({ tasksScriptUrl: URL_OK, tasksAutoLists: true, tasksListsRevision: 1, tasksListId: 'LA', tasksListName: 'Title LA' });
    expect(settings.tasksLists.map((l: { id: string; title: string }) => [l.id, l.title])).toEqual([['LA', 'Title LA'], ['LB', 'Title LB']]);
    expect(settings.tasksLastTest.ok).toBe(true);
    expect(settings.featureSetupCompletedAt['google-tasks']).toBeTruthy();
    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(world.props)).toBe(before);
  });

  it('settings that synced keep their lists, and the revision this device held still shows another device\'s change', async () => {
    const world = approvedWorld();
    const lists = [{ id: 'LA', title: 'Mine', needsDate: true }];
    const { plugin, settings } = device({ tasksScriptUrl: URL_OK, tasksListId: 'LA', tasksListName: 'Mine', tasksLists: lists, tasksAutoLists: true, tasksListsRevision: 0 });
    expect((await connectDevice(plugin, SECRET, URL_OK, transportFor(world))).ok).toBe(true);
    expect(settings.tasksLists).toEqual(lists);
    expect(settings.tasksListName).toBe('Mine');
    expect(settings.tasksListsRevision).toBe(0);
  });

  it('a locked script is recorded as locked, whatever synced', async () => {
    const locked = buildTasksScript({ secret: SECRET, approvedListId: 'LA' });
    const { plugin, settings } = device({ tasksAutoLists: true, tasksListsRevision: 3 });
    const res = await connectDevice(plugin, encodeConnectionCode(URL_OK, SECRET), '', transportFor(newWorld(), locked));
    expect(res).toEqual({ ok: true, value: { url: URL_OK, automatic: false, combined: false } });
    expect(settings).toMatchObject({ tasksAutoLists: false, tasksListsRevision: null, tasksListId: 'LA' });
  });

  describe('refusals save nothing', () => {
    const cases: Array<[string, string, string, ScriptTransport]> = [
      ['a malformed code', 'not a code', 'tasks-connect-bad-code', transportFor(newWorld())],
      ['a secret with no link', SECRET, 'tasks-connect-needs-link', transportFor(newWorld())],
      ['the wrong secret', encodeConnectionCode(URL_OK, 'b2'.repeat(24)), 'tasks-connect-wrong-secret', transportFor(newWorld())],
      ['a script that cannot be reached', encodeConnectionCode(URL_OK, SECRET), 'script-network', async () => { throw new Error('offline'); }],
      ['a page that is not a script', encodeConnectionCode(URL_OK, SECRET), 'script-login-page', async () => ({ status: 200, text: '<html>Sign in</html>' })],
    ];
    for (const [name, raw, code, transport] of cases) {
      it(name, async () => {
        for (const secret of [null, OLD]) {
          const { plugin, settings, store, saveSettings, setSecret } = device({}, secret);
          const before = JSON.stringify(settings);
          expect(await connectDevice(plugin, raw, '', transport)).toEqual({ ok: false, error: code });
          expect(store.value).toBe(secret);
          expect(setSecret).not.toHaveBeenCalled();
          expect(saveSettings).not.toHaveBeenCalled();
          expect(JSON.stringify(settings)).toBe(before);
        }
      });
    }
  });

  it('if the settings cannot be saved, the earlier secret and settings come back', async () => {
    const world = approvedWorld();
    for (const secret of [OLD, null]) {
      const { plugin, settings, store, saveSettings } = device({ tasksScriptUrl: 'https://script.google.com/macros/s/OLD/exec' }, secret);
      const before = JSON.stringify(settings);
      saveSettings.mockRejectedValueOnce(new Error(`disk full ${SECRET}`));
      const warn = vi.spyOn(logger, 'warn');
      expect(await connectDevice(plugin, encodeConnectionCode(URL_OK, SECRET), '', transportFor(world))).toEqual({ ok: false, error: 'tasks-connect-save-failed' });
      expect(store.value).toBe(secret);
      expect(JSON.stringify(settings)).toBe(before);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
      warn.mockRestore();
    }
  });

  it('a secret the store did not keep is a failure, and the settings are not touched', async () => {
    const world = approvedWorld();
    const { plugin, settings, saveSettings, setSecret } = device();
    const before = JSON.stringify(settings);
    setSecret.mockImplementation(async () => undefined);
    expect(await connectDevice(plugin, encodeConnectionCode(URL_OK, SECRET), '', transportFor(world))).toEqual({ ok: false, error: 'tasks-connect-save-failed' });
    expect(saveSettings).not.toHaveBeenCalled();
    expect(JSON.stringify(settings)).toBe(before);
    setSecret.mockRejectedValue(new Error('no store'));
    expect(await connectDevice(plugin, encodeConnectionCode(URL_OK, SECRET), '', transportFor(world))).toEqual({ ok: false, error: 'tasks-connect-save-failed' });
  });

  it('the secret travels only in the request body, and the code is never logged', async () => {
    const world = approvedWorld();
    const urls: string[] = [];
    const inner = transportFor(world);
    const spies = (['debug', 'warn', 'error'] as const).map((m) => vi.spyOn(logger, m));
    const { plugin } = device();
    const code = encodeConnectionCode(URL_OK, SECRET);
    await connectDevice(plugin, code, '', (req) => { urls.push(req.url); return inner(req); });
    await connectDevice(device().plugin, code, '', async () => { throw new Error('offline'); });
    expect(urls.every((u) => u === URL_OK)).toBe(true);
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
      expect(JSON.stringify(spy.mock.calls)).not.toContain(code);
      spy.mockRestore();
    }
  });
});

describe('making a secret', () => {
  it('with a saved link and no secret, none is made', async () => {
    const { plugin, setSecret } = device({ tasksScriptUrl: URL_OK });
    expect(await ensureTasksSecret(plugin)).toEqual({ ok: false, error: 'tasks-no-secret' });
    expect(setSecret).not.toHaveBeenCalled();
  });

  it('with no link one is made once, and a stored one is returned as it is', async () => {
    const first = device();
    const [a, b] = await Promise.all([ensureTasksSecret(first.plugin), ensureTasksSecret(first.plugin)]);
    expect(a).toEqual(b);
    expect(first.setSecret).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ ok: true, value: { secret: first.store.value, created: true } });
    expect(await ensureTasksSecret(device({ tasksScriptUrl: URL_OK }, OLD).plugin)).toEqual({ ok: true, value: { secret: OLD, created: false } });
  });

  it('replace always writes a new one', async () => {
    const { plugin, store } = device({ tasksScriptUrl: URL_OK }, OLD);
    await replaceTasksSecret(plugin);
    expect(store.value).toMatch(/^[0-9a-f]{48}$/);
    expect(store.value).not.toBe(OLD);
  });
});

describe('guidance', () => {
  it('every new code says what to do next, and the code the Drive inventory uses is unchanged', () => {
    for (const code of ['tasks-no-secret', 'tasks-connect-bad-code', 'tasks-connect-needs-link', 'tasks-connect-wrong-secret', 'tasks-connect-save-failed']) {
      expect(GUIDANCE_CODES).toContain(code);
      expect(describeError(en, code).nextStep).toBeTruthy();
    }
    expect(describeError(en, 'no-secret').nextStep).toBe('Open the setup window and copy the script to create one.');
    expect(describeError(en, 'tasks-no-secret').nextStep).toMatch(/Do not copy a new script/);
  });
});
