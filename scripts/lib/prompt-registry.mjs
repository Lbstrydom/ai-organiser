/**
 * @fileoverview Immutable prompt revisions with content-hash identity.
 * `default` is an alias pointing to a revision. Promotion repoints the alias.
 * Historical outcomes always reference the exact revision used.
 * @module scripts/lib/prompt-registry
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from './file-io.mjs';
import { MutexFileStore } from './file-store.mjs';

const REVISIONS_DIR = path.resolve('.audit/prompt-revisions');

// ── Revision Identity ───────────────────────────────────────────────────────

/**
 * Compute revision ID from prompt content.
 * Immutable: the same text always produces the same ID.
 * @param {string} promptText
 * @returns {string} rev-<12 hex chars>
 */
export function revisionId(promptText) {
  const fullHash = crypto.createHash('sha256').update(promptText).digest('hex');
  return `rev-${fullHash.slice(0, 12)}`;
}

// ── Save / Load ─────────────────────────────────────────────────────────────

/**
 * Save a prompt revision. Idempotent: same content = same revision ID = no-op.
 * @param {string} passName
 * @param {string} revId
 * @param {string} promptText
 * @param {object} metadata
 */
export function saveRevision(passName, revId, promptText, metadata = {}) {
  const revDir = path.join(REVISIONS_DIR, passName);
  const revPath = path.join(revDir, `${revId}.json`);
  if (fs.existsSync(revPath)) return; // Content-addressed: same ID = same content
  fs.mkdirSync(revDir, { recursive: true });
  atomicWriteFileSync(revPath, JSON.stringify({
    revisionId: revId,
    promptText,
    checksum: crypto.createHash('sha256').update(promptText).digest('hex'),
    lifecycleState: 'draft',
    ...metadata
  }, null, 2));
}

/**
 * Load a revision by ID.
 * @param {string} passName
 * @param {string} revId
 * @returns {object|null}
 */
export function loadRevision(passName, revId) {
  const revPath = path.join(REVISIONS_DIR, passName, `${revId}.json`);
  try {
    if (fs.existsSync(revPath)) return JSON.parse(fs.readFileSync(revPath, 'utf-8'));
  } catch { /* corrupted */ }
  return null;
}

/**
 * Get all revision IDs for a pass.
 * @param {string} passName
 * @returns {string[]}
 */
export function listRevisions(passName) {
  const dir = path.join(REVISIONS_DIR, passName);
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.startsWith('rev-') && f.endsWith('.json'))
      .map(f => f.replace('.json', ''));
  } catch { return []; }
}

// ── Default Alias ───────────────────────────────────────────────────────────

/**
 * Get the active (default) revision ID for a pass.
 * @param {string} passName
 * @returns {string|null}
 */
export function getActiveRevisionId(passName) {
  const aliasPath = path.join(REVISIONS_DIR, passName, 'default.json');
  try {
    if (fs.existsSync(aliasPath)) {
      const alias = JSON.parse(fs.readFileSync(aliasPath, 'utf-8'));
      return alias.revisionId || null;
    }
  } catch { /* corrupted */ }
  return null;
}

/**
 * Get the active prompt text for a pass.
 * @param {string} passName
 * @returns {string|null}
 */
export function getActivePrompt(passName) {
  const revId = getActiveRevisionId(passName);
  if (!revId) return null;
  const rev = loadRevision(passName, revId);
  return rev?.promptText || null;
}

/**
 * Promote a revision to be the default for a pass.
 * Does NOT mutate the revision — just repoints the alias.
 * @param {string} passName
 * @param {string} newRevId
 */
export function promoteRevision(passName, newRevId) {
  // Verify revision exists before repointing alias
  const rev = loadRevision(passName, newRevId);
  if (!rev) {
    throw new Error(`Cannot promote ${newRevId} for ${passName}: revision file not found`);
  }

  const revDir = path.join(REVISIONS_DIR, passName);
  fs.mkdirSync(revDir, { recursive: true });
  const aliasPath = path.join(revDir, 'default.json');

  // Update lifecycle states
  const oldRevId = getActiveRevisionId(passName);
  if (oldRevId && oldRevId !== newRevId) {
    _transitionState(passName, oldRevId, 'retired');
  }
  _transitionState(passName, newRevId, 'promoted');

  atomicWriteFileSync(aliasPath, JSON.stringify({ revisionId: newRevId }, null, 2));
}

// ── Lifecycle Management ────────────────────────────────────────────────────

function _transitionState(passName, revId, newState) {
  const revPath = path.join(REVISIONS_DIR, passName, `${revId}.json`);
  try {
    if (!fs.existsSync(revPath)) return;
    const rev = JSON.parse(fs.readFileSync(revPath, 'utf-8'));
    rev.lifecycleState = newState;
    if (newState === 'promoted') rev.promotedAt = Date.now();
    if (newState === 'retired') rev.retiredAt = Date.now();
    if (newState === 'abandoned') rev.abandonedAt = Date.now();
    atomicWriteFileSync(revPath, JSON.stringify(rev, null, 2));
  } catch { /* best effort */ }
}

/**
 * Abandon a revision. NEVER physically deletes — transitions to 'abandoned' state.
 * Reference check: refuses to abandon if active bandit arms reference it.
 * @param {string} passName
 * @param {string} revId
 * @param {object} [bandit] - PromptBandit instance for reference check
 * @returns {{ ok: boolean, reason?: string, refs?: object[] }}
 */
export function abandonRevision(passName, revId, bandit = null) {
  const revPath = path.join(REVISIONS_DIR, passName, `${revId}.json`);
  if (!fs.existsSync(revPath)) return { ok: false, reason: 'not_found' };

  // Reference check — block if active arms point here
  if (bandit?.armsReferencingRevision) {
    const activeRefs = bandit.armsReferencingRevision(passName, revId);
    if (activeRefs.length > 0) {
      process.stderr.write(`  [prompt-registry] Cannot abandon ${revId}: ${activeRefs.length} active arm(s) reference it\n`);
      return { ok: false, reason: 'active_references', refs: activeRefs };
    }
  }

  _transitionState(passName, revId, 'abandoned');
  return { ok: true };
}

// ── Bootstrap ───────────────────────────────────────────────────────────────

/**
 * Bootstrap: register existing prompt constants as initial default revisions.
 * Idempotent — same content = same revision ID = no-op.
 * @param {Record<string, string>} passPrompts - { passName: promptText }
 */
export function bootstrapFromConstants(passPrompts) {
  for (const [passName, promptText] of Object.entries(passPrompts)) {
    const revId = revisionId(promptText);
    saveRevision(passName, revId, promptText, {
      source: 'bootstrap',
      createdAt: Date.now()
    });
    // Only set default if no default exists yet
    const current = getActiveRevisionId(passName);
    if (!current) {
      promoteRevision(passName, revId);
    }
  }
}
