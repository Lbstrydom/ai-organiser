/**
 * @fileoverview Phase D.8 — git-history-based debt metric derivation.
 *
 * Fallback source for `distinctRunCount` + `firstDeferredCommit` when the
 * event log is not available (e.g., CI without local .audit/local/ events).
 *
 * Uses `git log -S<topicId>` to find commits that touched each entry's topicId
 * in the ledger. Each unique commit that touched the topicId represents a run
 * that persisted the entry (new or updated) — a lower bound on occurrences.
 *
 * This is LESS accurate than event-log-based derivation (events capture
 * surfaces/reopens/escalations which don't touch the ledger file). But it's
 * available everywhere git is available, making PR comments + CI useful
 * without requiring the local event log.
 *
 * @module scripts/lib/debt-git-history
 */

import { execFileSync } from 'node:child_process';

/**
 * Count distinct commits that changed the **net occurrence count** of a topicId
 * in the ledger file (via `git log -S<string>` pickaxe search).
 *
 * **IMPORTANT: this is a LOWER BOUND on real occurrences.** `git log -S` only
 * reports commits that added or removed the string — commits that merely
 * re-save the file with the string still present are NOT counted. So an entry
 * that was added once, then updated 5 times (keeping the topicId), returns 1.
 *
 * This is fine for our PR-comment use case: we're signalling "this topic has
 * a persisted history" not "exact run count". The event-log-derived
 * distinctRunCount (Phase D.1) is the accurate metric when available.
 *
 * Returns 0 if git unavailable, file not tracked, or topicId not found.
 *
 * @param {string} topicId
 * @param {object} [opts]
 * @param {string} [opts.ledgerPath='.audit/tech-debt.json']
 * @param {string} [opts.cwd=process.cwd()]
 * @returns {number}
 */
export function countCommitsTouchingTopic(topicId, {
  ledgerPath = '.audit/tech-debt.json',
  cwd = process.cwd(),
} = {}) {
  if (!topicId) return 0;
  try {
    // git log -S<string> --oneline -- <path>
    // outputs one commit per line; empty if no matches
    const out = execFileSync('git', [
      'log',
      `-S${topicId}`,
      '--oneline',
      '--',
      ledgerPath,
    ], { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (!out) return 0;
    return out.trim().split('\n').filter(Boolean).length;
  } catch {
    // git unavailable, not a repo, or file not tracked
    return 0;
  }
}

/**
 * Find the commit that first introduced a topicId to the ledger.
 * Returns `{sha, subject, url}` or null if not found.
 *
 * @param {string} topicId
 * @param {object} [opts]
 * @param {string} [opts.ledgerPath='.audit/tech-debt.json']
 * @param {string} [opts.remoteUrl] - if provided, constructs a commit URL
 * @param {string} [opts.cwd=process.cwd()]
 * @returns {{sha: string, subject: string, url?: string}|null}
 */
export function findFirstDeferCommit(topicId, {
  ledgerPath = '.audit/tech-debt.json',
  remoteUrl,
  cwd = process.cwd(),
} = {}) {
  if (!topicId) return null;
  try {
    // --diff-filter=A gets the commit that ADDED the string (first deferral);
    // --reverse walks forward so the first result is the earliest match
    // --format=%H%x09%s gives SHA and subject separated by tab
    const out = execFileSync('git', [
      'log',
      '--reverse',
      '--diff-filter=A',
      `-S${topicId}`,
      '--format=%H%x09%s',
      '--',
      ledgerPath,
    ], { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (!out) return null;
    const firstLine = out.trim().split('\n')[0];
    if (!firstLine) return null;
    const [sha, subject] = firstLine.split('\t');
    if (!sha) return null;
    const result = { sha: sha.trim(), subject: (subject || '').trim() };
    if (remoteUrl) {
      result.url = buildCommitUrl(remoteUrl, sha.trim());
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * Derive the GitHub repo URL from `git remote get-url origin` so we can
 * construct commit links without requiring the caller to pass it explicitly.
 * Returns null if origin not a recognized GitHub URL.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd=process.cwd()]
 * @returns {string|null} e.g. "https://github.com/owner/repo"
 */
export function detectGitHubRepoUrl({ cwd = process.cwd() } = {}) {
  try {
    const out = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    // Normalize: git@github.com:owner/repo.git → https://github.com/owner/repo
    //            https://github.com/owner/repo.git → https://github.com/owner/repo
    const sshMatch = out.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
    if (sshMatch) return `https://github.com/${sshMatch[1]}/${sshMatch[2]}`;
    const httpsMatch = out.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
    if (httpsMatch) return `https://github.com/${httpsMatch[1]}/${httpsMatch[2]}`;
    return null;
  } catch {
    return null;
  }
}

/**
 * Build a commit URL for a given repo + SHA.
 * @param {string} repoUrl e.g. "https://github.com/owner/repo"
 * @param {string} sha
 * @returns {string}
 */
export function buildCommitUrl(repoUrl, sha) {
  return `${repoUrl.replace(/\.git$/, '').replace(/\/$/, '')}/commit/${sha}`;
}

/**
 * Derive distinctRunCount (fallback) for a set of entries. Uses git-log
 * counting. Returns a Map<topicId, count>.
 *
 * @param {object[]} entries
 * @param {object} [opts]
 * @returns {Map<string, number>}
 */
export function deriveOccurrencesFromGit(entries, opts = {}) {
  const result = new Map();
  for (const e of entries || []) {
    if (!e.topicId) continue;
    result.set(e.topicId, countCommitsTouchingTopic(e.topicId, opts));
  }
  return result;
}
