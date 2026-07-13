import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';

// Pure transformation: bump manifest.json's version and upsert the matching
// versions.json entry (never overwrite prior entries — versions.json is a
// history of every shipped release's minAppVersion requirement).
export function computeVersionBump(currentManifest, currentVersions, newVersion) {
	const manifest = { ...currentManifest, version: newVersion };
	const versions = { ...currentVersions, [newVersion]: currentManifest.minAppVersion };
	return { manifest, versions };
}

// TODO(follow-up): add tests/versionBump.test.ts if this script grows past a
// single transformation (see docs/plans/adapter-conformance-and-build-gate.md
// Open Question 3 — deferred in favour of a manual `npm version patch` scratch
// check for this pass).
function main() {
	const newVersion = process.env.npm_package_version;
	if (!newVersion || typeof newVersion !== 'string' || newVersion.trim() === '') {
		console.error('version-bump.mjs: npm_package_version is missing or empty. Run via `npm version <bump>`, not `node version-bump.mjs` directly.');
		process.exit(1);
	}

	const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
	const versions = JSON.parse(readFileSync('versions.json', 'utf8'));

	const { manifest: updatedManifest, versions: updatedVersions } = computeVersionBump(manifest, versions, newVersion);

	writeFileSync('manifest.json', JSON.stringify(updatedManifest, null, '\t'));
	writeFileSync('versions.json', JSON.stringify(updatedVersions, null, '\t'));
}

// Only run the CLI side effect when executed directly (`node version-bump.mjs`
// via the npm `version` lifecycle hook) — never on import, so the pure
// `computeVersionBump` export stays safely importable (e.g. for a future
// tests/versionBump.test.ts) without triggering a file write.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main();
}
