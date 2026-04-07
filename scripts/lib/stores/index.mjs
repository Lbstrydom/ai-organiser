/**
 * @fileoverview Adapter selection and loading.
 * pickAdapter() determines which adapter to use based on AUDIT_STORE env var.
 */

const VALID_ADAPTERS = ['noop', 'supabase', 'sqlite', 'postgres', 'github'];
const _loggedOnce = new Set();

function logOnce(key, msg) {
  if (_loggedOnce.has(key)) return;
  _loggedOnce.add(key);
  process.stderr.write(`  [learning] ${msg}\n`);
}

/**
 * Pick the adapter based on env vars.
 * 1. Explicit AUDIT_STORE wins
 * 2. Backward-compat auto-detect for existing Supabase users
 * 3. Default to noop
 *
 * @returns {string} Adapter name
 */
export function pickAdapter() {
  const explicit = process.env.AUDIT_STORE;
  if (explicit) {
    return validateExplicitAdapter(explicit);
  }

  // Backward-compat auto-detect
  if (process.env.SUPABASE_AUDIT_URL && process.env.SUPABASE_AUDIT_ANON_KEY) {
    logOnce('auto-detect',
      'Legacy Supabase env detected; using supabase adapter. Set AUDIT_STORE=supabase to silence this notice.');
    return 'supabase';
  }

  return 'noop';
}

/**
 * Validate an explicit AUDIT_STORE value. Fail-fast on bad config.
 * @param {string} name
 * @returns {string}
 */
function validateExplicitAdapter(name) {
  const normalized = name.toLowerCase().trim();

  if (!VALID_ADAPTERS.includes(normalized)) {
    throw new Error(`AUDIT_STORE="${name}" is not a valid adapter. Valid values: ${VALID_ADAPTERS.join(', ')}`);
  }

  // Validate required env vars per adapter
  if (normalized === 'supabase') {
    const missing = [];
    if (!process.env.SUPABASE_AUDIT_URL) missing.push('SUPABASE_AUDIT_URL');
    if (!process.env.SUPABASE_AUDIT_ANON_KEY) missing.push('SUPABASE_AUDIT_ANON_KEY');
    if (missing.length > 0) {
      throw new Error(`AUDIT_STORE=supabase requires: ${missing.join(', ')}. Set these env vars or use AUDIT_STORE=noop`);
    }
  }

  if (normalized === 'postgres') {
    if (!process.env.AUDIT_POSTGRES_URL) {
      throw new Error('AUDIT_STORE=postgres requires AUDIT_POSTGRES_URL. Set this env var or use AUDIT_STORE=noop');
    }
  }

  if (normalized === 'github') {
    const missing = [];
    if (!process.env.AUDIT_GITHUB_TOKEN) missing.push('AUDIT_GITHUB_TOKEN');
    if (!process.env.AUDIT_GITHUB_OWNER) missing.push('AUDIT_GITHUB_OWNER');
    if (!process.env.AUDIT_GITHUB_REPO) missing.push('AUDIT_GITHUB_REPO');
    if (missing.length > 0) {
      throw new Error(`AUDIT_STORE=github requires: ${missing.join(', ')}. Set these env vars or use AUDIT_STORE=noop`);
    }
  }

  // sqlite has no required env vars (defaults to ~/.audit-loop/shared.db)

  return normalized;
}

/**
 * Dynamically load an adapter module.
 * @param {string} name - Adapter name
 * @returns {Promise<import('./interfaces.mjs').StorageAdapter>}
 */
export async function loadAdapterModule(name) {
  switch (name) {
    case 'noop': {
      const mod = await import('./noop-store.mjs');
      return mod.adapter;
    }
    case 'supabase': {
      try {
        const mod = await import('./supabase-store.mjs');
        return mod.adapter;
      } catch (err) {
        if (err.code === 'ERR_MODULE_NOT_FOUND' || err.message?.includes('supabase')) {
          throw new Error(
            'AUDIT_STORE=supabase requires @supabase/supabase-js but it is not installed. ' +
            'Run: npm install @supabase/supabase-js (Or set AUDIT_STORE=noop)'
          );
        }
        throw err;
      }
    }
    case 'sqlite': {
      try {
        const mod = await import('./sqlite-store.mjs');
        return mod.adapter;
      } catch (err) {
        if (err.code === 'ERR_MODULE_NOT_FOUND' || err.message?.includes('better-sqlite3')) {
          throw new Error(
            'AUDIT_STORE=sqlite requires better-sqlite3. ' +
            'Run: npm install better-sqlite3 (Or set AUDIT_STORE=noop)'
          );
        }
        throw err;
      }
    }
    case 'postgres': {
      try {
        const mod = await import('./postgres-store.mjs');
        return mod.adapter;
      } catch (err) {
        if (err.code === 'ERR_MODULE_NOT_FOUND' || err.message?.includes('pg')) {
          throw new Error(
            'AUDIT_STORE=postgres requires pg. ' +
            'Run: npm install pg (Or set AUDIT_STORE=noop)'
          );
        }
        throw err;
      }
    }
    case 'github': {
      try {
        const mod = await import('./github-store.mjs');
        return mod.adapter;
      } catch (err) {
        if (err.code === 'ERR_MODULE_NOT_FOUND' || err.message?.includes('octokit')) {
          throw new Error(
            'AUDIT_STORE=github requires @octokit/rest. ' +
            'Run: npm install @octokit/rest @octokit/plugin-throttling @octokit/plugin-retry (Or set AUDIT_STORE=noop)'
          );
        }
        throw err;
      }
    }
    default:
      throw new Error(`Unknown adapter "${name}". Valid values: ${VALID_ADAPTERS.join(', ')}`);
  }
}

export { VALID_ADAPTERS };
