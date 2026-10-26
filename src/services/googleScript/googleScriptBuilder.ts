/**
 * The Google script builder: composes the Apps Script a user pastes into their own Google account. Pure; the plugin never loads
 * or runs remote code.
 *
 * Modules. Each module (`tasks` today) contributes its configuration, its functions and the operations it answers. A standalone
 * script is one module behind the shared prelude. The standalone v1 Tasks script is NOT built here: `tasksScriptTemplate.ts` keeps
 * emitting its exact text (pinned byte for byte by a stored copy in the tests), so a user who needs nothing new sees no change.
 *
 * Tasks module v2 adds three things over v1: several approved lists (`APPROVED_LIST_IDS`, each request names one and the script
 * rejects any other before touching Google), an export binding (`bind:<exportId>` = list, recorded under the script lock, so two
 * devices that froze different lists before their vaults synced cannot both create the task), and one read-only operation,
 * `status`, that reads the completion of tasks the plugin itself exported (the task id comes from the script's own receipt;
 * a supplied id is ignored). `ping` keeps every v1 field and adds the list set, its hash and the capability list.
 */
import { sha256Hex } from '../attachmentDuplicateService';

/** Bumped when the v2 module's behaviour changes in a way the plugin must know about. */
export const TASKS_MODULE_VERSION = 2;
/** The capabilities a v2 Tasks module reports. A feature that needs one the script lacks is disabled alone. */
export const TASKS_V2_CAPABILITIES = ['upsert', 'lists', 'multi-list', 'status'] as const;
/** Most items one `status` request may carry. */
export const MAX_STATUS_ITEMS = 100;
/** The script stops starting new work after this long inside one status request. */
export const STATUS_BUDGET_MS = 60_000;

/** Hash of the approved list SET, identical to the one the v2 script computes in `ping`. */
export async function approvedListsHashOf(listIds: readonly string[]): Promise<string> {
    return sha256Hex(new TextEncoder().encode([...listIds].sort().join('\n')).buffer);
}

export interface TasksModuleConfig {
    secret: string;
    /** The main list; null = setup deployment (cannot create tasks) */
    approvedListId: string | null;
    /** Every approved list, the main one included; empty for the setup deployment */
    approvedListIds: readonly string[];
}

/** The configuration the tasks module is deployed with, as a plain object. */
export function tasksModuleConfig(config: TasksModuleConfig): Record<string, unknown> {
    // The set always holds the main list, so `APPROVED_LIST_ID` and `APPROVED_LIST_IDS` can never disagree.
    // A setup deployment (no main list) approves nothing, whatever set was passed: it can never create a task.
    const ids = config.approvedListId ? [...new Set([config.approvedListId, ...config.approvedListIds])] : [];
    return { SECRET: config.secret, APPROVED_LIST_ID: config.approvedListId ?? '', APPROVED_LIST_IDS: ids, SCRIPT_VERSION: TASKS_MODULE_VERSION, CAPABILITIES: [...TASKS_V2_CAPABILITIES] };
}

/** The tasks module's functions. ES5 on purpose; names are prefixed `tasks_` so modules cannot collide. */
const TASKS_MODULE_FUNCTIONS = String.raw`
var TASKS_MAX_ITEMS = 25;
var TASKS_BUDGET_MS = 240000;
var TASKS_STATUS_MAX_ITEMS = 100;
var TASKS_STATUS_BUDGET_MS = 60000;
var TASKS_ID_PATTERN = /^aio-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
var TASKS_MARKER = /(?:^|\n)\[aio:(aio-[0-9a-f-]{36})\]\s*$/;

function tasks_hex_(bytes) {
  return bytes.map(function (b) { return ("0" + (b & 0xff).toString(16)).slice(-2); }).join("");
}

function tasks_listHash_() {
  return tasks_hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, TASKS_CONFIG.APPROVED_LIST_ID || ""));
}

function tasks_listsHash_() {
  return tasks_hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, TASKS_CONFIG.APPROVED_LIST_IDS.slice().sort().join("\n")));
}

function tasks_approved_(listId) {
  return typeof listId === "string" && listId !== "" && TASKS_CONFIG.APPROVED_LIST_IDS.indexOf(listId) !== -1;
}

function tasks_on_() {
  return typeof Tasks !== "undefined" && Tasks && Tasks.Tasklists;
}

function tasks_lists_() {
  var lists = [];
  var token = null;
  do {
    var res = Tasks.Tasklists.list({ maxResults: 100, pageToken: token || undefined });
    (res.items || []).forEach(function (l) { lists.push({ id: l.id, title: l.title }); });
    token = res.nextPageToken || null;
  } while (token);
  return lists;
}

// Returns null when the budget ran out before the list was fully read.
function tasks_scanMarkers_(listId, started) {
  var found = {};
  var token = null;
  do {
    if (Date.now() - started > TASKS_BUDGET_MS) return null;
    var res = Tasks.Tasks.list(listId, { maxResults: 100, showCompleted: true, showHidden: true, showDeleted: false, pageToken: token || undefined });
    (res.items || []).forEach(function (t) {
      var m = TASKS_MARKER.exec(t.notes || "");
      if (m) found[m[1]] = { taskId: t.id, title: t.title || "" };
    });
    token = res.nextPageToken || null;
  } while (token);
  return found;
}

// The list an export id is bound to: the explicit binding, else the list of ANY receipt for it, even one for a list that is not
// approved today (a v1 receipt counts, and removing a list from the approved set never frees its ids).
function tasks_boundList_(map, exportId) {
  var bound = map["bind:" + exportId];
  if (bound) return bound;
  var tail = ":" + exportId;
  for (var k in map) {
    if (k.indexOf("x:") === 0 && k.length > tail.length + 2 && k.slice(-tail.length) === tail) return k.slice(2, k.length - tail.length);
  }
  return null;
}

function tasks_upsert_(req) {
  if (TASKS_CONFIG.APPROVED_LIST_IDS.length === 0) return fail_("not-approved", "This script is in setup mode and cannot create tasks.");
  if (!tasks_approved_(req.listId)) return fail_("not-approved", "That list is not approved in this script.");
  var tasks = req.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > TASKS_MAX_ITEMS) return fail_("bad-request", "Send between 1 and " + TASKS_MAX_ITEMS + " tasks.");
  var seen = {};
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    if (!t || typeof t.exportId !== "string" || !TASKS_ID_PATTERN.test(t.exportId) || typeof t.title !== "string" || t.title === "") return fail_("bad-request", "A task is missing its id or title.");
    if (seen[t.exportId]) return fail_("bad-request", "A task id appears twice in one request.");
    seen[t.exportId] = true;
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return fail_("busy", "Another request is running. Try again.");
  try {
    var started = Date.now();
    var props = PropertiesService.getScriptProperties();
    var map = props.getProperties();
    var key = function (id) { return "x:" + req.listId + ":" + id; };
    var missing = tasks.some(function (t) { var b = tasks_boundList_(map, t.exportId); return !map[key(t.exportId)] && (b === null || b === req.listId); });
    var lookup = missing ? tasks_scanMarkers_(req.listId, started) : {};
    var results = [];
    tasks.forEach(function (t) {
      if (Date.now() - started > TASKS_BUDGET_MS) { results.push({ exportId: t.exportId, status: "retry" }); return; }
      // An id already bound to another list is never created here: the original receipt is returned.
      var bound = tasks_boundList_(map, t.exportId);
      if (bound !== null && bound !== req.listId) {
        var original = map["x:" + bound + ":" + t.exportId];
        results.push({ exportId: t.exportId, status: "target-conflict", taskId: original ? JSON.parse(original).taskId : undefined });
        return;
      }
      var known = map[key(t.exportId)];
      if (known) {
        var rec = JSON.parse(known);
        results.push({ exportId: t.exportId, status: rec.title === t.title ? "exists" : "conflict", taskId: rec.taskId });
        return;
      }
      // The scan did not finish in time: say so rather than risk creating a duplicate.
      if (lookup === null) { results.push({ exportId: t.exportId, status: "retry" }); return; }
      var hit = lookup[t.exportId];
      if (hit) {
        props.setProperty(key(t.exportId), JSON.stringify({ taskId: hit.taskId, title: hit.title }));
        props.setProperty("bind:" + t.exportId, req.listId);
        map[key(t.exportId)] = JSON.stringify({ taskId: hit.taskId, title: hit.title });
        map["bind:" + t.exportId] = req.listId;
        results.push({ exportId: t.exportId, status: hit.title === t.title ? "exists" : "conflict", taskId: hit.taskId });
        return;
      }
      var notes = (typeof t.notes === "string" && t.notes ? t.notes + "\n" : "") + "[aio:" + t.exportId + "]";
      var body = { title: t.title, notes: notes };
      if (typeof t.due === "string" && /^\d{4}-\d{2}-\d{2}/.test(t.due)) body.due = t.due.slice(0, 10) + "T00:00:00.000Z";
      // The binding is written first: if the insert then fails, a retry to the same list still works, and no other list can claim the id.
      props.setProperty("bind:" + t.exportId, req.listId);
      map["bind:" + t.exportId] = req.listId;
      var created = Tasks.Tasks.insert(body, req.listId);
      props.setProperty(key(t.exportId), JSON.stringify({ taskId: created.id, title: t.title }));
      map[key(t.exportId)] = JSON.stringify({ taskId: created.id, title: t.title });
      results.push({ exportId: t.exportId, status: "created", taskId: created.id });
    });
    return out_({ ok: true, results: results });
  } finally {
    lock.releaseLock();
  }
}

// Read-only: the completion of tasks THIS script created. The task id comes from the script's own receipt; a supplied id is ignored.
function tasks_status_(req) {
  if (!tasks_approved_(req.listId)) return fail_("not-approved", "That list is not approved in this script.");
  var items = req.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > TASKS_STATUS_MAX_ITEMS) return fail_("bad-request", "Send between 1 and " + TASKS_STATUS_MAX_ITEMS + " items.");
  var started = Date.now();
  var map = PropertiesService.getScriptProperties().getProperties();
  var results = items.map(function (item) {
    var id = item && item.exportId;
    if (typeof id !== "string" || !TASKS_ID_PATTERN.test(id)) return { exportId: String(id), outcome: "unknown-receipt" };
    if (Date.now() - started > TASKS_STATUS_BUDGET_MS) return { exportId: id, outcome: "retry" };
    var bound = tasks_boundList_(map, id);
    var receipt = bound === req.listId ? map["x:" + req.listId + ":" + id] : null;
    if (!receipt) return { exportId: id, outcome: "unknown-receipt" };
    var taskId = JSON.parse(receipt).taskId;
    try {
      var task = Tasks.Tasks.get(req.listId, taskId);
      if (!task || task.deleted) return { exportId: id, outcome: "not-found" };
      return { exportId: id, outcome: "ok", status: task.status === "completed" ? "completed" : "needsAction", completed: task.completed || undefined };
    } catch (err) {
      return { exportId: id, outcome: /404|not found/i.test(String(err && err.message)) ? "not-found" : "error" };
    }
  });
  return out_({ ok: true, results: results });
}

function tasks_ping_() {
  return { ok: true, scriptVersion: TASKS_CONFIG.SCRIPT_VERSION, approvedListId: TASKS_CONFIG.APPROVED_LIST_ID || null, listHash: tasks_listHash_(), approvedListIds: TASKS_CONFIG.APPROVED_LIST_IDS, listsHash: tasks_listsHash_(), capabilities: TASKS_CONFIG.CAPABILITIES };
}

function tasks_handle_(req) {
  if (!tasks_on_()) return fail_("tasks-service-off", "Turn on the Google Tasks API service in the script editor.");
  if (req.op === "ping") return out_(tasks_ping_());
  if (req.op === "lists") return out_({ ok: true, lists: tasks_lists_() });
  if (req.op === "upsert") return tasks_upsert_(req);
  if (req.op === "status") return tasks_status_(req);
  return fail_("bad-request", "Unknown operation.");
}
`;

/** The standalone tasks v2 script: the module behind the shared prelude. */
export function buildTasksScriptV2(config: TasksModuleConfig): string {
    // A script with no secret would accept any caller. This is a programming error, not user input.
    if (config.secret.trim() === '') throw new Error('The Google Tasks script needs a secret.');
    const cfg = JSON.stringify(tasksModuleConfig(config), null, 2);
    return [
        '// AI Organiser: send approved tasks to your Google Tasks lists.',
        '// Needs the "Tasks API" advanced service (Services > Add a service > Google Tasks API).',
        '// Keep this script private: the secret below lets the plugin create tasks in the approved lists.',
        `var TASKS_CONFIG = ${cfg};`,
        '',
        'function out_(obj) {',
        '  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);',
        '}',
        '',
        'function fail_(code, message) {',
        '  return out_({ ok: false, error: { code: code, message: message } });',
        '}',
        TASKS_MODULE_FUNCTIONS,
        'function doPost(e) {',
        '  var req;',
        '  try {',
        '    req = JSON.parse((e && e.postData && e.postData.contents) || "{}");',
        '  } catch (err) {',
        '    return fail_("bad-request", "The request was not valid JSON.");',
        '  }',
        '  if (!TASKS_CONFIG.SECRET || !req || req.secret !== TASKS_CONFIG.SECRET) return fail_("auth", "Wrong or missing secret.");',
        '  try {',
        '    return tasks_handle_(req);',
        '  } catch (err) {',
        '    return fail_("tasks-error", "Google Tasks could not complete the request.");',
        '  }',
        '}',
        '',
    ].join('\n');
}

/** What the plugin settings decide about the script: whether v2 is needed, and which lists it approves. */
export interface TasksScriptChoice {
    /** More than one list is configured, or completion read-back is on */
    needsV2: boolean;
    approvedListIds: string[];
}

export function tasksScriptChoice(input: { mainListId: string; otherListIds: readonly string[]; readBack: boolean }): TasksScriptChoice {
    const ids = [...new Set([...(input.mainListId ? [input.mainListId] : []), ...input.otherListIds])];
    return { needsV2: input.otherListIds.length > 0 || input.readBack, approvedListIds: ids };
}
