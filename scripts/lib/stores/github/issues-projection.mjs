/**
 * @fileoverview Best-effort GitHub Issues projection for operator UX.
 * Issues are NOT the source of truth — branch files are.
 * Failures are logged but never block the caller.
 */

/**
 * Create the issues projection helper.
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @returns {object}
 */
export function createIssuesProjection(octokit, owner, repo) {
  let _budgetUsed = 0;
  let _budgetPaused = false;
  const BUDGET_CAP = 50; // max issue API calls per run

  return {
    /**
     * Project an event as a closed GitHub issue.
     * @param {object} event
     * @param {string} event.runId
     * @param {string} event.scopeId
     * @param {string} event.kind - 'adjudication' | 'suppression' | 'event'
     * @param {string} event.topicId
     * @param {object} event.payload
     * @returns {Promise<{ projected: boolean, issueNumber?: number }>}
     */
    async projectEvent(event) {
      if (_budgetPaused) return { projected: false };
      if (_budgetUsed >= BUDGET_CAP) {
        _budgetPaused = true;
        process.stderr.write(`  [github] issue projection paused — rate-limit budget low; events are on branch\n`);
        return { projected: false };
      }

      try {
        const title = `[audit-loop] run=${event.runId?.slice(0, 8)} scope=${event.scopeId?.slice(0, 8)} topic=${event.topicId?.slice(0, 8)} kind=${event.kind}`;
        const body = formatIssueBody(event);
        const labels = [`audit-loop:${event.kind}`];

        // Create issue
        const { data: issue } = await octokit.issues.create({
          owner, repo,
          title,
          body,
          labels,
        });
        _budgetUsed += 1;

        // Close immediately (archival)
        await octokit.issues.update({
          owner, repo,
          issue_number: issue.number,
          state: 'closed',
        });
        _budgetUsed += 1;

        return { projected: true, issueNumber: issue.number };
      } catch (err) {
        process.stderr.write(`  [github] issue projection failed: ${err.message}\n`);
        return { projected: false };
      }
    },

    /** Get current budget usage. */
    get budgetUsed() { return _budgetUsed; },
    get budgetPaused() { return _budgetPaused; },
  };
}

function formatIssueBody(event) {
  const json = JSON.stringify(event.payload || event, null, 2);
  const summary = event.payload?.ruling
    ? `**Ruling**: ${event.payload.ruling}`
    : `**Kind**: ${event.kind}`;

  return `<!-- AL_EVENT v=1 -->\n${json}\n<!-- /AL_EVENT -->\n\n${summary}\n**Run**: ${event.runId || 'N/A'}\n**Scope**: ${event.scopeId || 'N/A'}`;
}
