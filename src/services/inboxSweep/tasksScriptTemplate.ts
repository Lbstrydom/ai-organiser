/**
 * The Apps Script a user pastes to let the plugin create tasks in ONE Google Tasks list.
 *
 * The same script text is deployed twice with a different config block:
 *  1. SETUP: `approvedListId` is null. The script answers `ping` and `lists` and refuses `upsert`
 *     (`not-approved`), so it cannot create anything. The user picks a list from `lists`.
 *  2. OPERATIONAL: `approvedListId` is set. `upsert` rejects any other list id before touching
 *     Google Tasks, so the restriction is enforced by the script and not only stated in the wizard.
 *
 * Atomic idempotency: `upsert` runs under the script lock. Per request it reads the property map
 * once, does at most ONE complete paginated scan of the approved list (including completed tasks)
 * to find reserved markers `[aio:<exportId>]` for ids missing from the map, and inserts each new
 * task with its marker already in its notes before writing the map entry. If the insert succeeded
 * but the map write failed, the next call finds the marker, so a retry never duplicates and two
 * devices cannot interleave. A request carries at most 25 items and stops starting new work after
 * four minutes, answering `retry` for the rest. A reused id with a different title is `conflict`.
 */
import { sha256Hex } from '../attachmentDuplicateService';

/** Bumped whenever the script's behaviour changes in a way the plugin must know about. */
export const TASKS_SCRIPT_VERSION = 1;
export const TASKS_SCRIPT_MIN_SUPPORTED = 1;
export const MAX_TASKS_PER_REQUEST = 25;

/** Hash of the approved list id, identical to the one the script computes in `ping`. */
export async function approvedListHashOf(listId: string | null): Promise<string> {
    return sha256Hex(new TextEncoder().encode(listId ?? '').buffer);
}

export interface TasksScriptConfig {
    secret: string;
    /** null = setup deployment (cannot create tasks) */
    approvedListId: string | null;
    version?: number;
}

export function buildTasksScript(config: TasksScriptConfig): string {
    const cfg = JSON.stringify(
        { SECRET: config.secret, APPROVED_LIST_ID: config.approvedListId ?? '', SCRIPT_VERSION: config.version ?? TASKS_SCRIPT_VERSION },
        null,
        2,
    );
    return [
        '// AI Organiser: send approved tasks to ONE Google Tasks list.',
        '// Needs the "Tasks API" advanced service (Services > Add a service > Google Tasks API).',
        '// Keep this script private: the secret below lets the plugin create tasks in the approved list.',
        `var CONFIG = ${cfg};`,
        '',
        'var MAX_ITEMS = 25;',
        'var BUDGET_MS = 240000;',
        'var ID_PATTERN = /^aio-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;',
        '',
        'function out_(obj) {',
        '  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);',
        '}',
        '',
        'function fail_(code, message) {',
        '  return out_({ ok: false, error: { code: code, message: message } });',
        '}',
        '',
        'function listHash_() {',
        '  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, CONFIG.APPROVED_LIST_ID || "");',
        '  return bytes.map(function (b) { return ("0" + (b & 0xff).toString(16)).slice(-2); }).join("");',
        '}',
        '',
        'function tasksOn_() {',
        '  return typeof Tasks !== "undefined" && Tasks && Tasks.Tasklists;',
        '}',
        '',
        'function lists_() {',
        '  var lists = [];',
        '  var token = null;',
        '  do {',
        '    var res = Tasks.Tasklists.list({ maxResults: 100, pageToken: token || undefined });',
        '    (res.items || []).forEach(function (l) { lists.push({ id: l.id, title: l.title }); });',
        '    token = res.nextPageToken || null;',
        '  } while (token);',
        '  return lists;',
        '}',
        '',
        'function scanMarkers_(listId) {',
        '  var found = {};',
        '  var token = null;',
        '  do {',
        '    var res = Tasks.Tasks.list(listId, { maxResults: 100, showCompleted: true, showHidden: true, showDeleted: false, pageToken: token || undefined });',
        '    (res.items || []).forEach(function (t) {',
        '      var m = /\\[aio:(aio-[0-9a-f-]{36})\\]/.exec(t.notes || "");',
        '      if (m) found[m[1]] = { taskId: t.id, title: t.title || "" };',
        '    });',
        '    token = res.nextPageToken || null;',
        '  } while (token);',
        '  return found;',
        '}',
        '',
        'function upsert_(req) {',
        '  if (!CONFIG.APPROVED_LIST_ID) return fail_("not-approved", "This script is in setup mode and cannot create tasks.");',
        '  if (req.listId !== CONFIG.APPROVED_LIST_ID) return fail_("not-approved", "That list is not approved in this script.");',
        '  var tasks = req.tasks;',
        '  if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > MAX_ITEMS) return fail_("bad-request", "Send between 1 and " + MAX_ITEMS + " tasks.");',
        '  for (var i = 0; i < tasks.length; i++) {',
        '    var t = tasks[i];',
        '    if (!t || typeof t.exportId !== "string" || !ID_PATTERN.test(t.exportId) || typeof t.title !== "string" || t.title === "") return fail_("bad-request", "A task is missing its id or title.");',
        '  }',
        '  var lock = LockService.getScriptLock();',
        '  if (!lock.tryLock(20000)) return fail_("busy", "Another request is running. Try again.");',
        '  try {',
        '    var started = Date.now();',
        '    var props = PropertiesService.getScriptProperties();',
        '    var map = props.getProperties();',
        '    var missing = tasks.some(function (t) { return !map["x:" + t.exportId]; });',
        '    var lookup = missing ? scanMarkers_(CONFIG.APPROVED_LIST_ID) : {};',
        '    var results = [];',
        '    tasks.forEach(function (t) {',
        '      if (Date.now() - started > BUDGET_MS) { results.push({ exportId: t.exportId, status: "retry" }); return; }',
        '      var known = map["x:" + t.exportId];',
        '      if (known) {',
        '        var rec = JSON.parse(known);',
        '        results.push({ exportId: t.exportId, status: rec.title === t.title ? "exists" : "conflict", taskId: rec.taskId });',
        '        return;',
        '      }',
        '      var hit = lookup[t.exportId];',
        '      if (hit) {',
        '        props.setProperty("x:" + t.exportId, JSON.stringify({ taskId: hit.taskId, title: hit.title }));',
        '        results.push({ exportId: t.exportId, status: hit.title === t.title ? "exists" : "conflict", taskId: hit.taskId });',
        '        return;',
        '      }',
        '      var notes = (typeof t.notes === "string" && t.notes ? t.notes + "\\n" : "") + "[aio:" + t.exportId + "]";',
        '      var body = { title: t.title, notes: notes };',
        '      if (typeof t.due === "string" && /^\\d{4}-\\d{2}-\\d{2}/.test(t.due)) body.due = t.due.slice(0, 10) + "T00:00:00.000Z";',
        '      var created = Tasks.Tasks.insert(body, CONFIG.APPROVED_LIST_ID);',
        '      props.setProperty("x:" + t.exportId, JSON.stringify({ taskId: created.id, title: t.title }));',
        '      results.push({ exportId: t.exportId, status: "created", taskId: created.id });',
        '    });',
        '    return out_({ ok: true, results: results });',
        '  } finally {',
        '    lock.releaseLock();',
        '  }',
        '}',
        '',
        'function doPost(e) {',
        '  var req;',
        '  try {',
        '    req = JSON.parse((e && e.postData && e.postData.contents) || "{}");',
        '  } catch (err) {',
        '    return fail_("bad-request", "The request was not valid JSON.");',
        '  }',
        '  if (!req || req.secret !== CONFIG.SECRET) return fail_("auth", "Wrong or missing secret.");',
        '  if (!tasksOn_()) return fail_("tasks-service-off", "Turn on the Google Tasks API service in the script editor.");',
        '  try {',
        '    if (req.op === "ping") return out_({ ok: true, scriptVersion: CONFIG.SCRIPT_VERSION, approvedListId: CONFIG.APPROVED_LIST_ID || null, listHash: listHash_() });',
        '    if (req.op === "lists") return out_({ ok: true, lists: lists_() });',
        '    if (req.op === "upsert") return upsert_(req);',
        '    return fail_("bad-request", "Unknown operation.");',
        '  } catch (err) {',
        '    return fail_("tasks-error", "Google Tasks could not complete the request.");',
        '  }',
        '}',
        '',
    ].join('\n');
}
