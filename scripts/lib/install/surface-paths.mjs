/**
 * @fileoverview Repo-root discovery and scope target path resolution.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Discover the repo root by walking up from cwd.
 * Looks for .git (directory or file, for worktrees).
 * @param {string} [startDir=process.cwd()]
 * @returns {string} Absolute path to repo root
 */
export function findRepoRoot(startDir = process.cwd()) {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;
  let outermost = null;

  while (current !== root) {
    const gitPath = path.join(current, '.git');
    if (fs.existsSync(gitPath)) {
      outermost = current; // keep walking up for outermost
    }
    current = path.dirname(current);
  }

  if (outermost) return outermost;

  // Fallback: look for package.json
  current = path.resolve(startDir);
  while (current !== root) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    current = path.dirname(current);
  }

  return startDir;
}

/**
 * Resolve target paths for a skill based on surface selection.
 * @param {string} skillName
 * @param {string} surface - 'claude' | 'copilot' | 'agents' | 'both'
 * @param {string} repoRoot
 * @returns {Array<{ surface: string, dir: string, filePath: string }>}
 */
export function resolveSkillTargets(skillName, surface, repoRoot) {
  const targets = [];
  const home = os.homedir();

  if (surface === 'claude' || surface === 'both') {
    const dir = path.join(home, '.claude', 'skills', skillName);
    targets.push({ surface: 'claude', dir, filePath: path.join(dir, 'SKILL.md') });
  }

  if (surface === 'copilot' || surface === 'both') {
    const dir = path.join(repoRoot, '.github', 'skills', skillName);
    targets.push({ surface: 'copilot', dir, filePath: path.join(dir, 'SKILL.md') });
  }

  if (surface === 'agents' || surface === 'both') {
    const dir = path.join(repoRoot, '.agents', 'skills', skillName);
    targets.push({ surface: 'agents', dir, filePath: path.join(dir, 'SKILL.md') });
  }

  return targets;
}

/**
 * Get the receipt file path for a given scope.
 * @param {'repo'|'global'} scope
 * @param {string} repoRoot
 * @returns {string}
 */
export function receiptPath(scope, repoRoot) {
  if (scope === 'global') {
    return path.join(os.homedir(), '.audit-loop-install-receipt.json');
  }
  return path.join(repoRoot, '.audit-loop-install-receipt.json');
}
