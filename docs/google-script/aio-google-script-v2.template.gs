// AI Organiser: your Google script (one deployment for several features).
// Modules in this script: Google Tasks, Drive folder inventory (read-only).
// Services to turn on in the script editor (Services > Add a service): Google Tasks API and Drive API (v3).
// Keep this script private: the secret below lets the plugin use the approved lists and folders, and nothing else.
var SECRET = "PASTE-THE-SECRET-FROM-THE-PLUGIN-HERE";
var TASKS_CONFIG = {
  "APPROVED_LIST_ID": "PASTE-MAIN-GOOGLE-LIST-ID",
  "APPROVED_LIST_IDS": [
    "PASTE-MAIN-GOOGLE-LIST-ID",
    "PASTE-ANOTHER-LIST-ID"
  ],
  "SCRIPT_VERSION": 2,
  "CAPABILITIES": [
    "upsert",
    "lists",
    "multi-list",
    "status"
  ]
};
var INV_CONFIG = {
  "ROOT_FOLDER_IDS": [
    "PASTE-DRIVE-ROOT-FOLDER-ID"
  ],
  "SCRIPT_VERSION": 1
};

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(code, message) {
  return out_({ ok: false, error: { code: code, message: message } });
}

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


var INV_FOLDER_MIME = "application/vnd.google-apps.folder";
var INV_CACHE_SECONDS = 1800;
var INV_MAX_WALK = 20;

function inv_rootsHash_() {
  var joined = INV_CONFIG.ROOT_FOLDER_IDS.slice().sort().join(",");
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, joined);
  return bytes.map(function (b) { return ("0" + (b & 0xff).toString(16)).slice(-2); }).join("");
}

// Cached approvals are keyed by the approved roots, so replacing the script with a different set of folders never honours an
// approval granted under the old set.
var INV_CACHE_KEY_PREFIX = null;
function inv_cacheKey_(id) {
  if (INV_CACHE_KEY_PREFIX === null) INV_CACHE_KEY_PREFIX = "inv:ok:" + inv_rootsHash_().slice(0, 16) + ":";
  return INV_CACHE_KEY_PREFIX + id;
}

function inv_isApproved_(folderId) {
  if (INV_CONFIG.ROOT_FOLDER_IDS.indexOf(folderId) !== -1) return true;
  var cache = CacheService.getScriptCache();
  if (cache.get(inv_cacheKey_(folderId))) return true;
  var current = folderId;
  for (var i = 0; i < INV_MAX_WALK; i++) {
    var meta = Drive.Files.get(current, { fields: "parents", supportsAllDrives: true });
    var parents = (meta && meta.parents) || [];
    if (parents.length === 0) return false;
    for (var p = 0; p < parents.length; p++) {
      if (INV_CONFIG.ROOT_FOLDER_IDS.indexOf(parents[p]) !== -1 || cache.get(inv_cacheKey_(parents[p]))) {
        cache.put(inv_cacheKey_(folderId), "1", INV_CACHE_SECONDS);
        return true;
      }
    }
    current = parents[0];
  }
  return false;
}

function inv_list_(folderId, pageToken) {
  var res = Drive.Files.list({
    q: "'" + folderId + "' in parents and trashed = false",
    fields: "nextPageToken, files(id,name,mimeType,size,modifiedTime,md5Checksum,sha256Checksum,parents)",
    pageSize: 200,
    pageToken: pageToken || null,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });
  var cache = CacheService.getScriptCache();
  var files = [];
  var folders = [];
  (res.files || []).forEach(function (f) {
    if (f.mimeType === INV_FOLDER_MIME) {
      folders.push({ id: f.id, name: f.name });
      cache.put(inv_cacheKey_(f.id), "1", INV_CACHE_SECONDS);
    } else {
      files.push(f);
    }
  });
  return { ok: true, files: files, folders: folders, nextPageToken: res.nextPageToken || null };
}

function inv_ping_(req) {
  var info = null;
  if (req.folderId && inv_isApproved_(req.folderId)) {
    var f = Drive.Files.get(req.folderId, { fields: "id,name", supportsAllDrives: true });
    info = { id: f.id, name: f.name };
  }
  return { scriptVersion: INV_CONFIG.SCRIPT_VERSION, rootsHash: inv_rootsHash_(), folder: info };
}

function inv_handle_(req) {
  if (req.op === "list") {
    if (!req.folderId || typeof req.folderId !== "string") return fail_("bad-request", "folderId is required.");
    if (!inv_isApproved_(req.folderId)) return fail_("not-approved", "That folder is not approved in this script.");
    return out_(inv_list_(req.folderId, req.pageToken));
  }
  return fail_("bad-request", "Unknown operation.");
}


function combinedPing_(req) {
  var answer = { ok: true, modules: { tasks: { version: 2, capabilities: ["upsert","lists","multi-list","status"] }, inventory: { version: 1, capabilities: ["list"] } } };
  var extra = null;
  if (req.module === "tasks") extra = tasks_ping_();
  if (req.module === "inventory") extra = inv_ping_(req);
  if (extra) { for (var k in extra) { if (k !== "ok" && k !== "modules") answer[k] = extra[k]; } }
  return answer;
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (err) {
    return fail_("bad-request", "The request was not valid JSON.");
  }
  if (!SECRET || !req || req.secret !== SECRET) return fail_("auth", "Wrong or missing secret.");
  var tasksOp = req.op === "lists" || req.op === "upsert" || req.op === "status";
  try {
    if (req.op === "ping") return out_(combinedPing_(req));
    if (tasksOp) return tasks_handle_(req);
    if (req.op === "list") return inv_handle_(req);
    return fail_("bad-request", "Unknown operation.");
  } catch (err) {
    return fail_(tasksOp ? "tasks-error" : "drive-error", tasksOp ? "Google Tasks could not complete the request." : String(err));
  }
}
