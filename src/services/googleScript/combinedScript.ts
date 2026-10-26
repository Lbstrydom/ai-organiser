/**
 * The combined Google script: one deployment, one URL, one secret, with the Tasks module v2 and (optionally) the Drive inventory
 * module behind one `doPost`. Pure; the plugin never loads or runs remote code.
 *
 * Built only when the user chooses to combine. The standalone scripts (`tasksScriptTemplate.ts`, `scriptTemplate.ts` and the
 * standalone v2 builder) are untouched and keep emitting exactly the text they always did.
 *
 * Protocol. Operations keep their names (`upsert`, `lists`, `status` belong to Tasks; `list` to the inventory), so a request is
 * routed by its operation. `ping` is the one shared operation:
 *  - with no `module` it answers `{ ok, modules: { tasks?: { version, capabilities }, inventory?: { version, capabilities } } }`;
 *  - with `module: 'tasks'` or `'inventory'` it also carries that module's standalone ping fields at the top level, so a client
 *    written for the standalone script reads the combined one unchanged.
 * A module the script does not carry answers `module-missing` for its operations, and a module reported absent from `modules`
 * has no capabilities (see `normaliseModulePing`).
 *
 * Secrets and access: one secret for both modules. The Tasks module acts only on the approved lists; the inventory module only
 * on the approved Drive roots and their descendants (the script enforces this, Google does not).
 */
import { TASKS_V2_CAPABILITIES, TASKS_MODULE_VERSION, tasksModuleConfig, tasksModuleFunctions, type TasksModuleConfig } from './googleScriptBuilder';
import { INVENTORY_SCRIPT_VERSION } from '../cloudInventory/scriptTemplate';

export const INVENTORY_MODULE_CAPABILITIES = ['list'] as const;

export interface CombinedScriptConfig {
    secret: string;
    /** Absent: the script carries no Tasks module */
    tasks?: Omit<TasksModuleConfig, 'secret'>;
    /** Absent: the script carries no inventory module */
    inventory?: { rootFolderIds: readonly string[] };
}

/** The inventory module's functions. ES5 on purpose; names are prefixed `inv_` so modules cannot collide. */
const INVENTORY_MODULE_FUNCTIONS = String.raw`
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
`;

/** Build the combined script. At least one module is required. */
export function buildCombinedScript(config: CombinedScriptConfig): string {
    if (config.secret.trim() === '') throw new Error('The Google script needs a secret.');
    if (!config.tasks && !config.inventory) throw new Error('The combined script needs at least one module.');
    const parts: string[] = [
        '// AI Organiser: your Google script (one deployment for several features).',
        `// Modules in this script: ${[config.tasks ? 'Google Tasks' : '', config.inventory ? 'Drive folder inventory (read-only)' : ''].filter(Boolean).join(', ')}.`,
        `// Services to turn on in the script editor (Services > Add a service): ${[config.tasks ? 'Google Tasks API' : '', config.inventory ? 'Drive API (v3)' : ''].filter(Boolean).join(' and ')}.`,
        '// Keep this script private: the secret below lets the plugin use the approved lists and folders, and nothing else.',
        `var SECRET = ${JSON.stringify(config.secret)};`,
    ];
    if (config.tasks) {
        // The one secret lives in SECRET; the module's own copy is left out so it is written once.
        const tasksCfg: Record<string, unknown> = tasksModuleConfig({ secret: config.secret, ...config.tasks });
        delete tasksCfg.SECRET;
        parts.push(`var TASKS_CONFIG = ${JSON.stringify(tasksCfg, null, 2)};`);
    }
    if (config.inventory) {
        const cfg = { ROOT_FOLDER_IDS: [...new Set(config.inventory.rootFolderIds)], SCRIPT_VERSION: INVENTORY_SCRIPT_VERSION };
        parts.push(`var INV_CONFIG = ${JSON.stringify(cfg, null, 2)};`);
    }
    parts.push(
        '',
        'function out_(obj) {',
        '  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);',
        '}',
        '',
        'function fail_(code, message) {',
        '  return out_({ ok: false, error: { code: code, message: message } });',
        '}',
    );
    if (config.tasks) parts.push(tasksModuleFunctions());
    if (config.inventory) parts.push(INVENTORY_MODULE_FUNCTIONS);

    const modulesLine = [
        config.tasks ? `tasks: { version: ${TASKS_MODULE_VERSION}, capabilities: ${JSON.stringify([...TASKS_V2_CAPABILITIES])} }` : '',
        config.inventory ? `inventory: { version: ${INVENTORY_SCRIPT_VERSION}, capabilities: ${JSON.stringify([...INVENTORY_MODULE_CAPABILITIES])} }` : '',
    ].filter(Boolean).join(', ');
    const hasTasks = config.tasks !== undefined;
    const hasInv = config.inventory !== undefined;
    parts.push(
        '',
        'function combinedPing_(req) {',
        `  var answer = { ok: true, modules: { ${modulesLine} } };`,
        '  var extra = null;',
        ...(hasTasks ? ['  if (req.module === "tasks") extra = tasks_ping_();'] : []),
        ...(hasInv ? ['  if (req.module === "inventory") extra = inv_ping_(req);'] : []),
        '  if (extra) { for (var k in extra) { if (k !== "ok" && k !== "modules") answer[k] = extra[k]; } }',
        '  return answer;',
        '}',
        '',
        'function doPost(e) {',
        '  var req;',
        '  try {',
        '    req = JSON.parse((e && e.postData && e.postData.contents) || "{}");',
        '  } catch (err) {',
        '    return fail_("bad-request", "The request was not valid JSON.");',
        '  }',
        '  if (!SECRET || !req || req.secret !== SECRET) return fail_("auth", "Wrong or missing secret.");',
        '  var tasksOp = req.op === "lists" || req.op === "upsert" || req.op === "status";',
        '  try {',
        '    if (req.op === "ping") return out_(combinedPing_(req));',
        hasTasks ? '    if (tasksOp) return tasks_handle_(req);' : '    if (tasksOp) return fail_("module-missing", "This script does not include the Google Tasks module.");',
        hasInv ? '    if (req.op === "list") return inv_handle_(req);' : '    if (req.op === "list") return fail_("module-missing", "This script does not include the Drive inventory module.");',
        '    return fail_("bad-request", "Unknown operation.");',
        '  } catch (err) {',
        '    return fail_(tasksOp ? "tasks-error" : "drive-error", tasksOp ? "Google Tasks could not complete the request." : String(err));',
        '  }',
        '}',
        '',
    );
    return parts.join('\n');
}
