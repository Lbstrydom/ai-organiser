// Release-blocking build-artifact verification. Runs after every
// `build`/`build:quick` (chained via package.json), never on `dev`. See
// docs/build-invariants.md for what each check verifies and why.
//
// Structure: pure, exported check functions operating on plain data (no file
// I/O inside them) + a thin CLI wrapper (main()) that does file I/O,
// printing, and exit-code semantics. This keeps every check unit-testable
// via small in-memory fixtures — see tests/verifyBuild.test.ts.

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { containsUnneutralisedPolyfillSignature } from './setImmediatePolyfillSignature.mjs';

/** @typedef {{name: string, status: 'pass'|'fail'|'info', message: string}} CheckResult */

/** @returns {CheckResult} */
export function checkSetImmediatePolyfillNeutralised(bundleSource) {
	const name = 'setImmediate-polyfill-neutralised';
	if (containsUnneutralisedPolyfillSignature(bundleSource)) {
		return {
			name,
			status: 'fail',
			message: 'main.js contains an un-neutralised setImmediate <script> polyfill signature — see docs/build-invariants.md#the-invariants',
		};
	}
	return { name, status: 'pass', message: 'no un-neutralised setImmediate <script> polyfill signature found' };
}

/** @returns {CheckResult} */
export function checkNoManifestJsonLiteral(bundleSource) {
	const name = 'no-manifest-json-literal';
	// Matches "manifest.json", 'manifest.json', and `manifest.json` — the
	// review bot's self-update heuristic fires on the literal appearing
	// anywhere in the bundle regardless of which quote style produced it
	// (audit-caught: an earlier draft only matched double quotes).
	const count = (bundleSource.match(/["'`]manifest\.json["'`]/g) || []).length;
	if (count > 0) {
		return {
			name,
			status: 'fail',
			message: `main.js contains ${count} "manifest.json" string literal(s) — triggers the Obsidian review bot's self-update false positive; see docs/build-invariants.md#the-invariants`,
		};
	}
	return { name, status: 'pass', message: 'zero "manifest.json" string literals in main.js' };
}

const NON_EMPTY_STRING = (v) => typeof v === 'string' && v.trim().length > 0;
const isNonNullObject = (v) => typeof v === 'object' && v !== null;

/** @returns {CheckResult} */
export function checkVersionSync(pkgJson, manifestJson, versionsJson) {
	const name = 'version-sync';
	// Presence/type validation FIRST — without this, missing/empty fields on
	// both sides compare `undefined === undefined` and silently pass (a real
	// bug caught during audit: an empty {} package.json + manifest.json would
	// otherwise sail through as "in sync"). Object-shape checks come before
	// any property access — a `null` pkgJson/manifestJson (valid JSON) must
	// produce a structured fail result, not a thrown TypeError (also
	// audit-caught).
	if (!isNonNullObject(pkgJson)) {
		return { name, status: 'fail', message: `package.json did not parse to an object (got ${JSON.stringify(pkgJson)})` };
	}
	if (!isNonNullObject(manifestJson)) {
		return { name, status: 'fail', message: `manifest.json did not parse to an object (got ${JSON.stringify(manifestJson)})` };
	}
	if (!isNonNullObject(versionsJson)) {
		return { name, status: 'fail', message: `versions.json did not parse to an object (got ${JSON.stringify(versionsJson)})` };
	}
	if (!NON_EMPTY_STRING(pkgJson.version)) {
		return { name, status: 'fail', message: `package.json.version is missing or not a non-empty string (got ${JSON.stringify(pkgJson.version)})` };
	}
	if (!NON_EMPTY_STRING(manifestJson.version)) {
		return { name, status: 'fail', message: `manifest.json.version is missing or not a non-empty string (got ${JSON.stringify(manifestJson.version)})` };
	}
	if (!NON_EMPTY_STRING(manifestJson.minAppVersion)) {
		return { name, status: 'fail', message: `manifest.json.minAppVersion is missing or not a non-empty string (got ${JSON.stringify(manifestJson.minAppVersion)})` };
	}
	if (pkgJson.version !== manifestJson.version) {
		return {
			name,
			status: 'fail',
			message: `package.json version (${pkgJson.version}) !== manifest.json version (${manifestJson.version}) — see docs/build-invariants.md#the-invariants`,
		};
	}
	const entry = versionsJson[manifestJson.version];
	if (entry !== manifestJson.minAppVersion) {
		return {
			name,
			status: 'fail',
			message: `versions.json["${manifestJson.version}"] is ${JSON.stringify(entry)}, expected "${manifestJson.minAppVersion}" (manifest.json's minAppVersion) — see docs/build-invariants.md#the-invariants`,
		};
	}
	return { name, status: 'pass', message: `package.json/manifest.json/versions.json agree on version ${manifestJson.version}` };
}

/** @returns {CheckResult} */
export function reportBundleSize(bundleSource) {
	const bytes = Buffer.byteLength(bundleSource, 'utf8');
	const mb = (bytes / (1024 * 1024)).toFixed(2);
	// Info only — never fails. The current bundle is already ~7MB (disclosed,
	// accepted trade-off); a hard threshold here would break every release.
	return { name: 'bundle-size', status: 'info', message: `main.js is ${mb} MB` };
}

/**
 * Reads main.js/package.json/manifest.json/versions.json and returns either
 * `{ ok: true, bundleSource, pkgJson, manifestJson, versionsJson }` or
 * `{ ok: false, result: CheckResult }` — file-not-found, unreadable, and
 * malformed-JSON all collapse into the SAME named `fail` result shape the
 * substantive checks use, so main() never has to catch a raw exception.
 */
export function loadArtifacts(readFileFn = readFileSync, existsFn = existsSync) {
	if (!existsFn('main.js')) {
		return {
			ok: false,
			result: {
				name: 'artifacts-present',
				status: 'fail',
				message: 'main.js not found — run `npm run build` (or `build:quick`) first, then re-run verify:build.',
			},
		};
	}
	try {
		const bundleSource = readFileFn('main.js', 'utf8');
		const pkgJson = JSON.parse(readFileFn('package.json', 'utf8'));
		const manifestJson = JSON.parse(readFileFn('manifest.json', 'utf8'));
		const versionsJson = JSON.parse(readFileFn('versions.json', 'utf8'));
		return { ok: true, bundleSource, pkgJson, manifestJson, versionsJson };
	} catch (err) {
		return {
			ok: false,
			result: {
				name: 'artifacts-present',
				status: 'fail',
				message: `Failed to read/parse build artifacts: ${err instanceof Error ? err.message : String(err)}`,
			},
		};
	}
}

/** @returns {CheckResult[]} */
export function runAllChecks(artifacts) {
	return [
		checkSetImmediatePolyfillNeutralised(artifacts.bundleSource),
		checkNoManifestJsonLiteral(artifacts.bundleSource),
		checkVersionSync(artifacts.pkgJson, artifacts.manifestJson, artifacts.versionsJson),
		reportBundleSize(artifacts.bundleSource),
	];
}

function main() {
	const loaded = loadArtifacts();
	if (!loaded.ok) {
		console.log(`[FAIL] ${loaded.result.name}: ${loaded.result.message}`);
		process.exit(1);
	}

	const results = runAllChecks(loaded);
	for (const r of results) {
		console.log(`[${r.status.toUpperCase()}] ${r.name}: ${r.message}`);
	}

	const failed = results.some(r => r.status === 'fail');
	if (failed) {
		console.log('\nverify:build FAILED — see docs/build-invariants.md for what each check verifies and why.');
		process.exit(1);
	}
	console.log('\nverify:build passed.');
}

// Only run the CLI wrapper when executed directly — never on import, so
// tests/verifyBuild.test.ts can import the check functions without
// triggering file I/O or process.exit().
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main();
}
