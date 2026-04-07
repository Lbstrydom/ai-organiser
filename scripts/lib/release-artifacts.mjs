/**
 * @fileoverview Single source of truth for the set of files in every release.
 * Used by: release workflow, installer, bootstrap, update checker.
 */

export const RELEASE_ARTIFACTS = Object.freeze({
  // Skill files — bundled in tarball AND individually SHA-hashed
  skills: Object.freeze([
    'skills/audit-loop/SKILL.md',
    'skills/plan-backend/SKILL.md',
    'skills/plan-frontend/SKILL.md',
    'skills/ship/SKILL.md',
    'skills/audit/SKILL.md',
  ]),

  // Installer tooling — fetched per install
  scripts: Object.freeze([
    'scripts/install-skills.mjs',
    'scripts/check-skill-updates.mjs',
    'scripts/build-manifest.mjs',
    'scripts/lib/bootstrap-template.mjs',
  ]),

  // Metadata files
  metadata: Object.freeze([
    'skills.manifest.json',
    'bundle-history.json',
  ]),

  // Release-only assets (not installed, just distributed)
  releaseOnly: Object.freeze([
    'checksums.json',
    'checksums.json.sig',
    'checksums.json.pem',
    'skills-bundle.tar.gz',
  ]),
});

/**
 * Get all artifact paths that should be checksum-verified on install.
 * @returns {string[]}
 */
export function getVerifiableArtifacts() {
  return [...RELEASE_ARTIFACTS.skills, ...RELEASE_ARTIFACTS.scripts, ...RELEASE_ARTIFACTS.metadata];
}
