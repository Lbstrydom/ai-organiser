// Decides whether a build may auto-deploy to the local vault. Pure, so it is unit-tested.
// A linked git worktree must never deploy: its build is an experiment, and the vault holds
// the user's live plugin. Fail closed: if git cannot be read, do not deploy.
import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Pure decision. `gitDir` and `commonDir` are the outputs of
 * `git rev-parse --git-dir` / `--git-common-dir` as absolute paths
 * (or null when git could not be read).
 * @returns {{ deploy: boolean, reason: string }}
 */
export function decideDeploy(gitDir, commonDir, env = {}) {
	if (!gitDir || !commonDir) {
		return { deploy: false, reason: "git state could not be read (fail closed)" };
	}
	const norm = (p) => path.resolve(p.replace(/\\/g, "/")).replace(/[\\/]+$/, "").toLowerCase();
	if (norm(gitDir) === norm(commonDir)) return { deploy: true, reason: "main checkout" };
	if (env.AIORG_DEPLOY_FROM_WORKTREE === "1") {
		return { deploy: true, reason: "linked worktree, AIORG_DEPLOY_FROM_WORKTREE=1" };
	}
	return { deploy: false, reason: "linked git worktree (set AIORG_DEPLOY_FROM_WORKTREE=1 to deploy deliberately)" };
}

function git(cwd, args) {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
	} catch {
		return null;
	}
}

/** Reads git state for `cwd` and applies {@link decideDeploy}. */
export function shouldDeploy(cwd, env = process.env) {
	return decideDeploy(
		git(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]),
		git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
		env,
	);
}
