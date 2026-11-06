/**
 * Tasks module v3: the same module as v2, except that the approved lists live in the script's own properties (`cfg:lists`) and the
 * plugin sets them with `setLists`. The script text then differs between users only in the secret, so setup takes one paste and a
 * list change takes no trip to Google. Pure; the plugin never loads or runs remote code.
 *
 * What this gives up, knowingly: in v1 and v2 the script text enforces the lock and a secret holder cannot widen it. Here the secret
 * alone can change the approved lists, so the lock stops plugin bugs and routing mistakes but not a thief. The other limits hold: at
 * most 8 lists, each a list that really exists, and no read, edit, complete, move or delete of anything the script did not create.
 *
 * v3 is v2 with edits, not a copy: `TASKS_CONFIG` is filled from the property at the start of each request, so every v2 rule reads
 * the same fields. v2 stays pinned by stored copies; an edit that no longer matches the v2 text throws here (and in the tests).
 * Pasting v2 back over v3 is a safe downgrade: v2 ignores `cfg:` and enforces its text again.
 *
 * Receipt store. Properties are limited to 500 KB per script and receipts were never removed, so exports would eventually stop.
 * v3 removes the oldest receipts once the store is near the limit and keeps their bindings, so a removed receipt does not risk a
 * duplicate: an id sent again finds its `[aio:<id>]` marker in its own list and is refused on any other. `status` then answers
 * `unknown-receipt` for that id. Bindings go only past their own cap, in no particular order, after about 2,000 ids: from then on an
 * old id could be created again if a device still held a different list for it, which needs a vault that missed that much sync.
 */
import { MAX_TASKS_LISTS } from '../inboxSweep/tasksRouting';
import { TASKS_V2_CAPABILITIES, tasksModuleFunctions } from './googleScriptBuilder';

export const TASKS_V3_VERSION = 3;
/** The capability that says the plugin may set the lists. A script without it keeps them in its text. */
export const LIST_CONFIG_CAPABILITY = 'list-config';
export const TASKS_V3_CAPABILITIES = [...TASKS_V2_CAPABILITIES, LIST_CONFIG_CAPABILITY] as const;
/** The store is pruned above this many bytes, towards the low mark (Google's limit is 500 KB per script). One request removes at most `RECEIPT_PRUNE_MAX` properties. */
export const RECEIPT_STORE_HIGH = 400_000;
export const RECEIPT_STORE_LOW = 300_000;
/** Most properties one request removes. The next request carries on. */
export const RECEIPT_PRUNE_MAX = 500;
/** Bindings outlive their receipts. Past this many bytes, those whose receipt has gone are removed (about 2,000 ids in). */
export const RECEIPT_BIND_MAX = 200_000;

/** The configuration block of a v3 script. It holds no list: those are in the script's properties. */
export function tasksModuleV3Config(): Record<string, unknown> {
    return { APPROVED_LIST_ID: '', APPROVED_LIST_IDS: [], SCRIPT_VERSION: TASKS_V3_VERSION, CAPABILITIES: [...TASKS_V3_CAPABILITIES] };
}

const V3_ADDITIONS = String.raw`
var TASKS_CFG_KEY = "cfg:lists";
var TASKS_MAX_LISTS = __MAX_LISTS__;
var TASKS_STORE_HIGH = __STORE_HIGH__;
var TASKS_STORE_LOW = __STORE_LOW__;
var TASKS_PRUNE_MAX = __PRUNE_MAX__;
var TASKS_BIND_MAX = __BIND_MAX__;
var TASKS_CFG = { main: "", ids: [], titles: {}, revision: 0, changedAt: null };

// Fill the fields every rule reads from the property. Anything unreadable approves nothing: no task can be created.
function tasks_loadLists_() {
  var cfg = null;
  try { cfg = JSON.parse(PropertiesService.getScriptProperties().getProperty(TASKS_CFG_KEY) || "null"); } catch (err) { cfg = null; }
  var revision = cfg && typeof cfg.revision === "number" ? cfg.revision : 0;
  var valid = cfg && typeof cfg.main === "string" && Array.isArray(cfg.ids) && cfg.ids.indexOf(cfg.main) !== -1;
  TASKS_CFG = valid ? { main: cfg.main, ids: cfg.ids, titles: cfg.titles || {}, revision: revision, changedAt: cfg.changedAt || null } : { main: "", ids: [], titles: {}, revision: revision, changedAt: null };
  TASKS_CONFIG.APPROVED_LIST_ID = TASKS_CFG.main;
  TASKS_CONFIG.APPROVED_LIST_IDS = TASKS_CFG.ids;
}

// Only ever sent because a person acted in the plugin. Every id must be a list that really exists, and a stale revision is refused
// so two devices cannot silently overwrite each other.
function tasks_setLists_(req) {
  var ids = req.ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > TASKS_MAX_LISTS) return fail_("bad-request", "Send between 1 and " + TASKS_MAX_LISTS + " lists.");
  var seen = {};
  for (var i = 0; i < ids.length; i++) {
    if (typeof ids[i] !== "string" || ids[i] === "" || seen[ids[i]]) return fail_("bad-request", "A list id is missing or appears twice.");
    seen[ids[i]] = true;
  }
  if (typeof req.main !== "string" || !seen[req.main]) return fail_("bad-request", "The main list must be one of the lists.");
  if (typeof req.expectedRevision !== "number") return fail_("bad-request", "The expected revision is missing.");
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return fail_("busy", "Another request is running. Try again.");
  try {
    tasks_loadLists_();
    if (req.expectedRevision !== TASKS_CFG.revision) return fail_("stale-revision", "The lists were changed elsewhere.");
    var titles = {};
    tasks_lists_().forEach(function (l) { if (seen[l.id]) titles[l.id] = String(l.title || "").slice(0, 120); });
    for (var j = 0; j < ids.length; j++) {
      if (!Object.prototype.hasOwnProperty.call(titles, ids[j])) return fail_("unknown-list", "That list does not exist in Google Tasks.");
    }
    var next = { main: req.main, ids: ids, titles: titles, revision: TASKS_CFG.revision + 1, changedAt: new Date().toISOString() };
    PropertiesService.getScriptProperties().setProperty(TASKS_CFG_KEY, JSON.stringify(next));
    return out_({ ok: true, revision: next.revision });
  } finally {
    lock.releaseLock();
  }
}

// Non-ASCII is counted at 3 bytes: an overestimate is safe here, the limit is not.
function tasks_bytes_(s) {
  return String(s).replace(/[^\x00-\x7f]/g, "xxx").length;
}

// Called under the script lock. A removed receipt keeps its binding: the marker scan only reads the target list, so the binding is what
// stops an old id being created on a different list. Bindings are small, and only those whose receipt has gone are removed, past a cap.
// A receipt from before v3 has no date and goes first; one from before v2 has no binding, so it gets one now.
function tasks_prune_(props, map) {
  var total = 0;
  var bindBytes = 0;
  var receipts = [];
  var bindings = [];
  var hasReceipt = {};
  for (var k in map) {
    var size = tasks_bytes_(k) + tasks_bytes_(map[k]);
    total += size;
    if (k.indexOf("x:") === 0) {
      var id = k.slice(k.lastIndexOf(":") + 1);
      var at = 0;
      try { at = Number(JSON.parse(map[k]).at) || 0; } catch (err) { at = 0; }
      receipts.push({ key: k, id: id, list: k.slice(2, k.length - id.length - 1), at: at, size: size });
      hasReceipt[id] = true;
    } else if (k.indexOf("bind:") === 0) {
      bindBytes += size;
      bindings.push({ key: k, id: k.slice(5), size: size });
    }
  }
  if (total <= TASKS_STORE_HIGH) return;
  var removed = 0;
  for (var b = 0; b < bindings.length && bindBytes > TASKS_BIND_MAX && removed < TASKS_PRUNE_MAX; b++) {
    if (hasReceipt[bindings[b].id]) continue;
    props.deleteProperty(bindings[b].key);
    delete map[bindings[b].key];
    bindBytes -= bindings[b].size;
    total -= bindings[b].size;
    removed++;
  }
  receipts.sort(function (x, y) { return x.at - y.at; });
  for (var i = 0; i < receipts.length && total > TASKS_STORE_LOW && removed < TASKS_PRUNE_MAX; i++) {
    var r = receipts[i];
    var bindKey = "bind:" + r.id;
    if (!map[bindKey]) {
      props.setProperty(bindKey, r.list);
      map[bindKey] = r.list;
      total += tasks_bytes_(bindKey) + tasks_bytes_(r.list);
      removed++;
    }
    props.deleteProperty(r.key);
    delete map[r.key];
    total -= r.size;
    removed++;
  }
}

function tasks_ping_() {
  tasks_loadLists_();
  return { ok: true, scriptVersion: TASKS_CONFIG.SCRIPT_VERSION, approvedListId: TASKS_CFG.main || null, listHash: tasks_listHash_(), approvedListIds: TASKS_CFG.ids, listsHash: tasks_listsHash_(), capabilities: TASKS_CONFIG.CAPABILITIES, listsRevision: TASKS_CFG.revision, approvedListTitles: TASKS_CFG.titles, listsChangedAt: TASKS_CFG.changedAt };
}
`;

const V2_PING = `function tasks_ping_() {
  return { ok: true, scriptVersion: TASKS_CONFIG.SCRIPT_VERSION, approvedListId: TASKS_CONFIG.APPROVED_LIST_ID || null, listHash: tasks_listHash_(), approvedListIds: TASKS_CONFIG.APPROVED_LIST_IDS, listsHash: tasks_listsHash_(), capabilities: TASKS_CONFIG.CAPABILITIES };
}
`;

/** Replace every occurrence, and refuse to build if the v2 text no longer has it: a silent miss would drop a rule. */
function edit(text: string, from: string, to: string): string {
    if (!text.includes(from)) throw new Error(`The v3 Tasks module no longer matches the v2 text: ${from.slice(0, 60)}`);
    return text.split(from).join(to);
}

/** The v3 module's functions: v2's, with the lists read from the property, `setLists` added and the receipt store kept in bounds. */
export function tasksModuleV3Functions(): string {
    const additions = V3_ADDITIONS
        .replace('__MAX_LISTS__', String(MAX_TASKS_LISTS))
        .replace('__STORE_HIGH__', String(RECEIPT_STORE_HIGH))
        .replace('__STORE_LOW__', String(RECEIPT_STORE_LOW))
        .replace('__PRUNE_MAX__', String(RECEIPT_PRUNE_MAX))
        .replace('__BIND_MAX__', String(RECEIPT_BIND_MAX));
    let text = tasksModuleFunctions();
    text = edit(text, V2_PING, additions.trimStart());
    text = edit(text, `function tasks_handle_(req) {
  if (!tasks_on_()) return fail_("tasks-service-off", "Turn on the Google Tasks API service in the script editor.");
`, `function tasks_handle_(req) {
  if (!tasks_on_()) return fail_("tasks-service-off", "Turn on the Google Tasks API service in the script editor.");
  tasks_loadLists_();
  if (req.op === "setLists") return tasks_setLists_(req);
`);
    text = edit(text, `    var map = props.getProperties();
`, `    var map = props.getProperties();
    tasks_prune_(props, map);
`);
    // Receipts carry their date, so the oldest can be found.
    text = edit(text, 'JSON.stringify({ taskId: hit.taskId, title: hit.title })', 'JSON.stringify({ taskId: hit.taskId, title: hit.title, at: Date.now() })');
    text = edit(text, 'JSON.stringify({ taskId: created.id, title: t.title })', 'JSON.stringify({ taskId: created.id, title: t.title, at: Date.now() })');
    return text;
}
