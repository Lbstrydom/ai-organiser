/**
 * @fileoverview GitHub adapter for the audit-loop learning system.
 * Uses a dedicated orphan branch as authoritative store + Issues as projection.
 *
 * Config:
 *   AUDIT_STORE=github
 *   AUDIT_GITHUB_TOKEN=<token> (required)
 *   AUDIT_GITHUB_OWNER=<owner> (required)
 *   AUDIT_GITHUB_REPO=<repo> (required)
 *   AUDIT_GITHUB_BRANCH=audit-events/main (default)
 *   AUDIT_GITHUB_API_URL=https://api.github.com (override for GHE)
 */
import crypto from 'node:crypto';
import { GLOBAL_REPO_ID } from './interfaces.mjs';
import { normalizeGitHubError } from './github/github-errors.mjs';
import { createGitDataApi } from './github/git-data-api.mjs';
import { createIssuesProjection } from './github/issues-projection.mjs';

/**
 * Create and initialize the GitHub adapter.
 * @param {object} [config]
 * @returns {Promise<object>} Adapter conforming to StorageAdapter
 */
export async function createGitHubAdapter(config = {}) {
  // Dynamic import — @octokit/rest is optional
  let Octokit;
  try {
    const mod = await import('@octokit/rest');
    Octokit = mod.Octokit;
  } catch {
    throw new Error(
      'AUDIT_STORE=github requires @octokit/rest. ' +
      'Run: npm install @octokit/rest @octokit/plugin-throttling @octokit/plugin-retry'
    );
  }

  const token = config.token || process.env.AUDIT_GITHUB_TOKEN;
  const owner = config.owner || process.env.AUDIT_GITHUB_OWNER;
  const repo = config.repo || process.env.AUDIT_GITHUB_REPO;
  const branch = config.branch || process.env.AUDIT_GITHUB_BRANCH || 'audit-events/main';
  const baseUrl = config.apiUrl || process.env.AUDIT_GITHUB_API_URL || 'https://api.github.com';

  if (!token) throw new Error('AUDIT_GITHUB_TOKEN is required');
  if (!owner) throw new Error('AUDIT_GITHUB_OWNER is required');
  if (!repo) throw new Error('AUDIT_GITHUB_REPO is required');

  const octokit = new Octokit({ auth: token, baseUrl });
  const gitApi = createGitDataApi(octokit, owner, repo, branch);
  const issues = createIssuesProjection(octokit, owner, repo);

  // Path helpers
  const debtPath = (scopeId) => `debt/${scopeId}/entries.json`;
  const eventPath = (scopeId, key) => `events/${scopeId}/${key}.json`;
  const banditPath = (scopeId) => `learning/${scopeId}/bandit-state.json`;
  const fpPath = (scopeId) => `learning/${scopeId}/fp-state.json`;
  const runPath = (scopeId, runId) => `runs/${scopeId}/${runId}.json`;
  const findingsPath = (scopeId, runId, pass) => `findings/${scopeId}/${runId}/${pass}.json`;
  const promptPath = () => `global/prompt-variants.json`;
  const now = () => new Date().toISOString();

  async function readJson(path) {
    const file = await gitApi.readFile(path);
    if (!file) return null;
    try { return JSON.parse(file.content); } catch (err) {
      process.stderr.write(`  [github] JSON parse error for ${path}: ${err.message}\n`);
      return null;
    }
  }

  async function writeJson(path, data, message) {
    return gitApi.atomicCommit(
      [{ path, content: JSON.stringify(data, null, 2) }],
      [],
      message || `[audit-loop] update ${path}`
    );
  }

  return {
    name: 'github',
    capabilities: {
      debt: true, run: true, learningState: true, globalState: true, repo: true,
      scopeIsolation: true,
    },

    async init() {
      try {
        // Verify repo access
        await octokit.repos.get({ owner, repo });
        // Verify branch exists
        const exists = await gitApi.branchExists();
        if (!exists) {
          process.stderr.write(`  [github] ERROR: branch '${branch}' not found. Run: node scripts/setup-github-store.mjs\n`);
          return false;
        }
        // Verify schema version
        const REQUIRED_SCHEMA_VERSION = 1;
        const sv = await readJson('schema_version.json');
        if (!sv || sv.v < REQUIRED_SCHEMA_VERSION) {
          process.stderr.write(`  [github] ERROR: invalid schema version. Run: node scripts/setup-github-store.mjs\n`);
          return false;
        }
        return true;
      } catch (err) {
        const normalized = normalizeGitHubError(err, 'init');
        process.stderr.write(`  [github] init failed: ${normalized.operatorHint}\n`);
        return false;
      }
    },

    debt: {
      async upsertDebtEntries(repoId, entries) {
        const existing = await readJson(debtPath(repoId)) || {};
        for (const e of entries) {
          const key = e.topicId || e.topic_id;
          existing[key] = { ...existing[key], ...e, updatedAt: now() };
        }
        const result = await writeJson(debtPath(repoId), existing, `[audit-loop] upsert ${entries.length} debt entries`);
        return { ok: result.success, inserted: entries.length, updated: 0 };
      },

      async readDebtEntries(repoId) {
        const data = await readJson(debtPath(repoId));
        return data ? Object.values(data) : [];
      },

      async removeDebtEntry(repoId, topicId) {
        const data = await readJson(debtPath(repoId));
        if (!data || !data[topicId]) return { ok: true, removed: false };
        delete data[topicId];
        await writeJson(debtPath(repoId), data, `[audit-loop] remove debt entry ${topicId.slice(0, 8)}`);
        return { ok: true, removed: true };
      },

      async appendDebtEvents(repoId, events) {
        const files = [];
        for (const e of events) {
          const key = e.idempotencyKey || e.idempotency_key;
          if (!key) {
            process.stderr.write(`  [github] WARN: skipped event without idempotencyKey\n`);
            continue;
          }
          files.push({
            path: eventPath(repoId, key),
            content: JSON.stringify({ ...e, createdAt: e.ts || now() }, null, 2),
          });
        }
        if (files.length === 0) return { inserted: 0 };
        const result = await gitApi.atomicCommit(files, [], `[audit-loop] append ${files.length} debt events`);
        // Project to issues (best-effort)
        for (const e of events) {
          await issues.projectEvent({ runId: e.runId, scopeId: repoId, kind: 'event', topicId: e.topicId || e.topic_id, payload: e });
        }
        return { inserted: result.success ? files.length : 0 };
      },

      async readDebtEvents(repoId, sinceTs) {
        try {
          const headSha = await gitApi.getHeadSha();
          const tree = await gitApi.getTree(headSha);
          const prefix = `events/${repoId}/`;
          const eventFiles = tree.filter(t => t.path.startsWith(prefix) && t.path.endsWith('.json'));
          const events = [];
          for (const ef of eventFiles) {
            const data = await readJson(ef.path);
            if (!data) continue;
            if (sinceTs && (data.createdAt || data.ts) < sinceTs) continue;
            events.push(data);
          }
          events.sort((a, b) => (a.createdAt || a.ts || '').localeCompare(b.createdAt || b.ts || ''));
          return events;
        } catch { return []; }
      },
    },

    run: {
      async recordRunStart(repoId, planFile, mode, runId) {
        if (!runId) runId = crypto.randomUUID();
        const data = { runId, repoId, planFile, mode, startedAt: now() };
        await writeJson(runPath(repoId, runId), data, `[audit-loop] run ${runId.slice(0, 8)} start`);
        return runId;
      },

      async recordRunComplete(runId, stats) {
        // Read existing run file and update — but we need repoId for path
        // Convention: stats should include repoId
        const repoId = stats?.repoId || 'unknown';
        const existing = await readJson(runPath(repoId, runId)) || {};
        existing.completedAt = now();
        existing.stats = stats;
        await writeJson(runPath(repoId, runId), existing, `[audit-loop] run ${runId.slice(0, 8)} complete`);
      },

      async recordFindings(runId, findings, passName, round) {
        const repoId = findings[0]?._repoId || 'unknown';
        const data = { runId, passName, round, findings: findings.map(f => ({
          id: f.id, severity: f.severity, category: f.category, detail: f.detail?.slice(0, 500),
          _hash: f._hash,
        })), createdAt: now() };
        await writeJson(findingsPath(repoId, runId, passName), data,
          `[audit-loop] ${findings.length} findings for ${passName} R${round}`);
      },

      async recordPassStats(runId, passName, stats) {
        // Included in run summary via recordRunComplete
      },

      async recordAdjudicationEvent(runId, fingerprint, event) {
        const key = crypto.createHash('sha256').update(`adj:${runId}:${fingerprint}`).digest('hex').slice(0, 16);
        const scopeId = event?.repoId || 'unknown';
        const files = [{ path: eventPath(scopeId, key), content: JSON.stringify({ ...event, runId, fingerprint, kind: 'adjudication', createdAt: now() }, null, 2) }];
        await gitApi.atomicCommit(files, [], `[audit-loop] adjudication ${fingerprint.slice(0, 8)}`);
        await issues.projectEvent({ runId, scopeId, kind: 'adjudication', topicId: fingerprint, payload: event });
      },

      async recordSuppressionEvents(runId, result) {
        const key = crypto.createHash('sha256').update(`sup:${runId}:${now()}`).digest('hex').slice(0, 16);
        const scopeId = result?.repoId || 'unknown';
        const files = [{ path: eventPath(scopeId, key), content: JSON.stringify({ ...result, runId, kind: 'suppression', createdAt: now() }, null, 2) }];
        await gitApi.atomicCommit(files, [], `[audit-loop] suppression events`);
      },
    },

    learningState: {
      async syncBanditArms(repoId, arms) {
        await writeJson(banditPath(repoId), arms, `[audit-loop] sync bandit arms`);
      },

      async loadBanditArms(repoId) {
        return readJson(banditPath(repoId));
      },

      async syncFalsePositivePatterns(repoId, patterns) {
        await writeJson(fpPath(repoId), patterns, `[audit-loop] sync FP patterns`);
      },

      async loadFalsePositivePatterns(repoId) {
        const repoPatterns = await readJson(fpPath(repoId)) || {};
        const globalPatterns = await readJson(fpPath(GLOBAL_REPO_ID)) || {};
        return { repoPatterns, globalPatterns };
      },
    },

    globalState: {
      async syncPromptRevision(passName, revisionId, text) {
        if (!passName || !revisionId) return;
        const existing = await readJson(promptPath()) || {};
        const key = `${passName}:${revisionId}`;
        existing[key] = { passName, revisionId, text, updatedAt: now() };
        await writeJson(promptPath(), existing, `[audit-loop] sync prompt ${passName}/${revisionId}`);
      },

      async listGlobalPromptVariants() {
        const data = await readJson(promptPath());
        return data ? Object.values(data) : [];
      },
    },

    repo: {
      async upsertRepo(profile, repoName) {
        return profile?.repoFingerprint || null;
      },

      async getRepoByFingerprint(fingerprint) {
        return fingerprint ? { id: fingerprint, fingerprint } : null;
      },
    },
  };
}

export const adapter = {
  name: 'github',
  capabilities: { debt: true, run: true, learningState: true, globalState: true, repo: true, scopeIsolation: true },
  _factory: createGitHubAdapter,
};
