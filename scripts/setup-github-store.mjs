#!/usr/bin/env node
/**
 * @fileoverview Setup CLI for GitHub storage adapter.
 * Creates an orphan branch with initial schema_version.json.
 *
 * Usage:
 *   node scripts/setup-github-store.mjs --owner <o> --repo <r>
 *   AUDIT_GITHUB_TOKEN=<token> node scripts/setup-github-store.mjs
 */

const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m';

function parseArgs(argv) {
  const args = { owner: null, repo: null, branch: 'audit-events/main', token: null };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--owner': args.owner = argv[++i]; break;
      case '--repo': args.repo = argv[++i]; break;
      case '--branch': args.branch = argv[++i]; break;
      case '--token': args.token = argv[++i]; break;
    }
  }
  return args;
}

async function main() {
  let Octokit;
  try {
    const mod = await import('@octokit/rest');
    Octokit = mod.Octokit;
  } catch {
    console.error(`${R}Error${X}: @octokit/rest not installed. Run: npm install @octokit/rest`);
    process.exit(1);
  }

  const args = parseArgs(process.argv);
  const token = args.token || process.env.AUDIT_GITHUB_TOKEN;
  const owner = args.owner || process.env.AUDIT_GITHUB_OWNER;
  const repo = args.repo || process.env.AUDIT_GITHUB_REPO;
  const branch = args.branch;

  if (!token || !owner || !repo) {
    console.error(`${R}Error${X}: --owner, --repo, and AUDIT_GITHUB_TOKEN are required`);
    process.exit(1);
  }

  console.log(`GitHub Store Setup`);
  console.log(`  Repo: ${owner}/${repo}`);
  console.log(`  Branch: ${branch}`);

  const baseUrl = process.env.AUDIT_GITHUB_API_URL || 'https://api.github.com';
  const octokit = new Octokit({ auth: token, baseUrl });

  try {
    // Check if branch already exists
    try {
      await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
      console.log(`  ${G}Branch already exists${X} — nothing to do.`);
      return;
    } catch (err) {
      if (err.status !== 404) throw err;
    }

    // Create orphan branch
    console.log(`  Creating orphan branch...`);

    // 1. Create blob for schema_version.json
    const { data: blob } = await octokit.git.createBlob({
      owner, repo,
      content: JSON.stringify({ v: 1 }, null, 2),
      encoding: 'utf-8',
    });

    // 2. Create tree with single file
    const { data: tree } = await octokit.git.createTree({
      owner, repo,
      tree: [{ path: 'schema_version.json', mode: '100644', type: 'blob', sha: blob.sha }],
    });

    // 3. Create commit with no parent (orphan)
    const { data: commit } = await octokit.git.createCommit({
      owner, repo,
      message: '[audit-loop] initialize storage branch',
      tree: tree.sha,
      parents: [],
    });

    // 4. Create branch ref
    await octokit.git.createRef({
      owner, repo,
      ref: `refs/heads/${branch}`,
      sha: commit.sha,
    });

    console.log(`  ${G}Created${X}: orphan branch '${branch}' with schema_version.json (v=1)`);
    console.log(`  Commit: ${commit.sha.slice(0, 8)}`);
  } catch (err) {
    console.error(`${R}Setup failed${X}: ${err.message}`);
    process.exit(1);
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
