/**
 * @fileoverview Wraps octokit Git Data API for atomic multi-file commits.
 * Uses trees/commits/refs for CAS-based writes to a branch.
 */
import { normalizeGitHubError } from './github-errors.mjs';

const MAX_RETRIES = 3;
const RETRY_DELAYS = [200, 800, 2000]; // ms

/**
 * Create the Git Data API helper.
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {string} branch - e.g. 'audit-events/main'
 * @returns {object}
 */
export function createGitDataApi(octokit, owner, repo, branch) {
  const ref = `heads/${branch}`;

  return {
    /**
     * Get the current branch HEAD SHA.
     * @returns {Promise<string>}
     */
    async getHeadSha() {
      const { data } = await octokit.git.getRef({ owner, repo, ref });
      return data.object.sha;
    },

    /**
     * Get the full recursive tree for a commit.
     * @param {string} commitSha
     * @returns {Promise<Array<{ path: string, sha: string, type: string }>>}
     */
    async getTree(commitSha) {
      const { data: commit } = await octokit.git.getCommit({ owner, repo, commit_sha: commitSha });
      const { data: tree } = await octokit.git.getTree({ owner, repo, tree_sha: commit.tree.sha, recursive: '1' });
      return tree.tree;
    },

    /**
     * Atomic multi-file commit with CAS retry.
     * @param {Array<{ path: string, content: string }>} files - Files to create/update
     * @param {Array<string>} [deletePaths] - Paths to delete
     * @param {string} message - Commit message
     * @returns {Promise<{ sha: string, success: boolean, error?: string }>}
     */
    async atomicCommit(files, deletePaths = [], message = '[audit-loop] update') {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          // 1. Get current HEAD
          const parentSha = await this.getHeadSha();
          const { data: parentCommit } = await octokit.git.getCommit({ owner, repo, commit_sha: parentSha });
          const baseTreeSha = parentCommit.tree.sha;

          // 2. Build tree entries
          const treeEntries = files.map(f => ({
            path: f.path,
            mode: '100644',
            type: 'blob',
            content: f.content,
          }));

          // Add deletions (null sha removes file)
          for (const p of deletePaths) {
            treeEntries.push({ path: p, mode: '100644', type: 'blob', sha: null });
          }

          // 3. Create tree
          const { data: newTree } = await octokit.git.createTree({
            owner, repo,
            base_tree: baseTreeSha,
            tree: treeEntries,
          });

          // 4. Create commit
          const { data: newCommit } = await octokit.git.createCommit({
            owner, repo,
            message,
            tree: newTree.sha,
            parents: [parentSha],
          });

          // 5. Update ref (CAS — force=false)
          await octokit.git.updateRef({
            owner, repo,
            ref,
            sha: newCommit.sha,
            force: false,
          });

          return { sha: newCommit.sha, success: true };

        } catch (err) {
          const normalized = normalizeGitHubError(err, 'atomic-commit');
          if (normalized.reason === 'transient' && attempt < MAX_RETRIES) {
            process.stderr.write(`  [github] conflict on attempt ${attempt + 1}, retrying in ${RETRY_DELAYS[attempt]}ms\n`);
            await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
            continue;
          }
          return { sha: null, success: false, error: normalized.operatorHint };
        }
      }
      return { sha: null, success: false, error: 'max retries exceeded' };
    },

    /**
     * Read a file from the branch.
     * @param {string} filePath
     * @returns {Promise<{ content: string, sha: string }|null>}
     */
    async readFile(filePath) {
      try {
        const { data } = await octokit.repos.getContent({
          owner, repo,
          path: filePath,
          ref: branch,
        });
        if (data.type !== 'file') return null;
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        return { content, sha: data.sha };
      } catch (err) {
        if (err.status === 404) return null;
        throw err;
      }
    },

    /**
     * Check if branch exists.
     * @returns {Promise<boolean>}
     */
    async branchExists() {
      try {
        await octokit.git.getRef({ owner, repo, ref });
        return true;
      } catch (err) {
        if (err.status === 404) return false;
        throw err;
      }
    },
  };
}
