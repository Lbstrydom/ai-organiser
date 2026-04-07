/**
 * @fileoverview Canonical error normalization for GitHub REST API responses.
 */

/**
 * Normalize a GitHub API error into the canonical store error shape.
 * @param {Error} err - Error from octokit
 * @param {string} [context] - Operation context for hint
 * @returns {import('../sql/sql-errors.mjs').NormalizedStoreError}
 */
export function normalizeGitHubError(err, context) {
  const status = err.status || err.response?.status;
  const msg = err.message || '';

  // Auth errors
  if (status === 401) {
    return { reason: 'misconfiguration', retryable: false, bufferToOutbox: false,
      operatorHint: 'GitHub token invalid; check AUDIT_GITHUB_TOKEN', nativeCode: '401' };
  }

  // Permission / scope errors
  if (status === 403 && !msg.includes('rate limit')) {
    return { reason: 'misconfiguration', retryable: false, bufferToOutbox: false,
      operatorHint: 'Token lacks required scopes (contents:write, issues:write)', nativeCode: '403' };
  }

  // Rate limit
  if (status === 403 && msg.includes('rate limit')) {
    const retryAfter = err.response?.headers?.['retry-after'];
    return { reason: 'transient', retryable: true, bufferToOutbox: true,
      operatorHint: `GitHub rate limit hit; retry after ${retryAfter || '?'}s`, nativeCode: '403-ratelimit' };
  }
  if (status === 429) {
    const retryAfter = err.response?.headers?.['retry-after'];
    return { reason: 'transient', retryable: true, bufferToOutbox: true,
      operatorHint: `GitHub secondary rate limit; retry after ${retryAfter || '60'}s`, nativeCode: '429' };
  }

  // Branch/file not found
  if (status === 404) {
    if (context === 'branch-check') {
      return { reason: 'misconfiguration', retryable: false, bufferToOutbox: false,
        operatorHint: 'Branch not found. Run: node scripts/setup-github-store.mjs', nativeCode: '404' };
    }
    // File not found is not an error — it's empty data
    return { reason: 'not-found', retryable: false, bufferToOutbox: false,
      operatorHint: 'Resource not found', nativeCode: '404' };
  }

  // Stale ref (conflict during push)
  if (status === 409) {
    return { reason: 'transient', retryable: true, bufferToOutbox: true,
      operatorHint: 'Concurrent write conflict; retrying via merge', nativeCode: '409' };
  }

  // 422 can be stale-ref OR validation error
  if (status === 422) {
    if (msg.includes('not a fast forward') || msg.includes('Update is not a fast forward') || msg.includes('sha')) {
      return { reason: 'transient', retryable: true, bufferToOutbox: true,
        operatorHint: 'Stale ref; retrying', nativeCode: '422-stale' };
    }
    return { reason: 'validation', retryable: false, bufferToOutbox: false,
      operatorHint: `GitHub rejected payload: ${msg}`, nativeCode: '422-validation' };
  }

  // Server errors
  if (status >= 500) {
    return { reason: 'transient', retryable: true, bufferToOutbox: true,
      operatorHint: 'GitHub upstream error; retry', nativeCode: String(status) };
  }

  // Network errors
  if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('fetch failed')) {
    return { reason: 'transient', retryable: true, bufferToOutbox: true,
      operatorHint: 'Network error contacting GitHub; retry', nativeCode: 'NETWORK' };
  }

  return { reason: 'unknown', retryable: false, bufferToOutbox: false,
    operatorHint: `GitHub error: ${msg}`, nativeCode: String(status || 'UNKNOWN') };
}
