/**
 * The Apps Script a user pastes to let the plugin list their approved Drive folders.
 *
 * The plugin fills in a config block (secret, approved root folder IDs, version) so the user never
 * edits code or script properties. The script is the user's own: it reads file names and sizes in
 * the approved folders and nothing else, and only answers requests that carry the secret.
 *
 * Authorisation does not depend on anything the client sends: every folder request is checked to be
 * (or descend from) one of the approved roots. Authorised subfolder IDs are cached for 30 minutes so
 * a refresh costs about one Drive call per folder; uncached IDs fall back to a bounded parents walk.
 */
import { sha256Hex } from '../attachmentDuplicateService';

/** Bumped whenever the script's behaviour changes in a way the plugin must know about. */
export const INVENTORY_SCRIPT_VERSION = 1;
/** The oldest script version the plugin still works with. */
export const INVENTORY_SCRIPT_MIN_SUPPORTED = 1;

/** Hash of the approved roots, identical to the one the script computes in `ping`. */
export async function rootsHashOf(rootFolderIds: readonly string[]): Promise<string> {
    const joined = [...rootFolderIds].sort().join(',');
    return sha256Hex(new TextEncoder().encode(joined).buffer);
}

export interface InventoryScriptConfig {
    secret: string;
    rootFolderIds: readonly string[];
    version?: number;
}

/** The complete, ready-to-paste script. Pure. */
export function buildInventoryScript(config: InventoryScriptConfig): string {
    const cfg = JSON.stringify(
        { SECRET: config.secret, ROOT_FOLDER_IDS: [...config.rootFolderIds], SCRIPT_VERSION: config.version ?? INVENTORY_SCRIPT_VERSION },
        null,
        2,
    );
    return [
        '// AI Organiser: Drive folder inventory (read-only).',
        '// Needs the "Drive API" advanced service (Services > Add a service > Drive API, version v3).',
        '// Keep this script private: the secret below lets the plugin read the folders listed in ROOT_FOLDER_IDS.',
        `var CONFIG = ${cfg};`,
        '',
        'var FOLDER_MIME = "application/vnd.google-apps.folder";',
        'var CACHE_SECONDS = 1800;',
        'var MAX_WALK = 20;',
        '',
        'function out_(obj) {',
        '  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);',
        '}',
        '',
        'function fail_(code, message) {',
        '  return out_({ ok: false, error: { code: code, message: message } });',
        '}',
        '',
        'function rootsHash_() {',
        '  var joined = CONFIG.ROOT_FOLDER_IDS.slice().sort().join(",");',
        '  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, joined);',
        '  return bytes.map(function (b) { return ("0" + (b & 0xff).toString(16)).slice(-2); }).join("");',
        '}',
        '',
        '// Cached approvals are keyed by the approved roots, so replacing the script with a different',
        '// set of folders never honours an approval granted under the old set.',
        'var CACHE_KEY_PREFIX = null;',
        'function cacheKey_(id) {',
        '  if (CACHE_KEY_PREFIX === null) CACHE_KEY_PREFIX = "ok:" + rootsHash_().slice(0, 16) + ":";',
        '  return CACHE_KEY_PREFIX + id;',
        '}',
        '',
        'function isApproved_(folderId) {',
        '  if (CONFIG.ROOT_FOLDER_IDS.indexOf(folderId) !== -1) return true;',
        '  var cache = CacheService.getScriptCache();',
        '  if (cache.get(cacheKey_(folderId))) return true;',
        '  var current = folderId;',
        '  for (var i = 0; i < MAX_WALK; i++) {',
        '    var meta = Drive.Files.get(current, { fields: "parents", supportsAllDrives: true });',
        '    var parents = (meta && meta.parents) || [];',
        '    if (parents.length === 0) return false;',
        '    for (var p = 0; p < parents.length; p++) {',
        '      if (CONFIG.ROOT_FOLDER_IDS.indexOf(parents[p]) !== -1 || cache.get(cacheKey_(parents[p]))) {',
        '        cache.put(cacheKey_(folderId), "1", CACHE_SECONDS);',
        '        return true;',
        '      }',
        '    }',
        '    current = parents[0];',
        '  }',
        '  return false;',
        '}',
        '',
        'function list_(folderId, pageToken) {',
        '  var res = Drive.Files.list({',
        '    q: "\'" + folderId + "\' in parents and trashed = false",',
        '    fields: "nextPageToken, files(id,name,mimeType,size,modifiedTime,md5Checksum,sha256Checksum,parents)",',
        '    pageSize: 200,',
        '    pageToken: pageToken || null,',
        '    supportsAllDrives: true,',
        '    includeItemsFromAllDrives: true',
        '  });',
        '  var cache = CacheService.getScriptCache();',
        '  var files = [];',
        '  var folders = [];',
        '  (res.files || []).forEach(function (f) {',
        '    if (f.mimeType === FOLDER_MIME) {',
        '      folders.push({ id: f.id, name: f.name });',
        '      cache.put(cacheKey_(f.id), "1", CACHE_SECONDS);',
        '    } else {',
        '      files.push(f);',
        '    }',
        '  });',
        '  return { ok: true, files: files, folders: folders, nextPageToken: res.nextPageToken || null };',
        '}',
        '',
        'function doPost(e) {',
        '  try {',
        '    var req = JSON.parse((e && e.postData && e.postData.contents) || "{}");',
        '    if (!CONFIG.SECRET || !req || req.secret !== CONFIG.SECRET) return fail_("auth", "The secret does not match.");',
        '    if (req.op === "ping") {',
        '      var info = null;',
        '      if (req.folderId && isApproved_(req.folderId)) {',
        '        var f = Drive.Files.get(req.folderId, { fields: "id,name", supportsAllDrives: true });',
        '        info = { id: f.id, name: f.name };',
        '      }',
        '      return out_({ ok: true, scriptVersion: CONFIG.SCRIPT_VERSION, rootsHash: rootsHash_(), folder: info });',
        '    }',
        '    if (req.op === "list") {',
        '      if (!req.folderId || typeof req.folderId !== "string") return fail_("bad-request", "folderId is required.");',
        '      if (!isApproved_(req.folderId)) return fail_("not-approved", "That folder is not approved in this script.");',
        '      return out_(list_(req.folderId, req.pageToken));',
        '    }',
        '    return fail_("bad-request", "Unknown operation.");',
        '  } catch (err) {',
        '    return fail_("drive-error", String(err));',
        '  }',
        '}',
        '',
    ].join('\n');
}
