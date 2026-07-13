/**
 * Build-artifact verification gate tests.
 * Tests every exported check function in scripts/verify-build.mjs against
 * small in-memory fixtures — no real main.js needed.
 */

import { describe, it, expect } from 'vitest';
import {
	checkSetImmediatePolyfillNeutralised,
	checkNoManifestJsonLiteral,
	checkVersionSync,
	reportBundleSize,
	loadArtifacts,
	runAllChecks,
} from '../scripts/verify-build.mjs';
import { containsUnneutralisedPolyfillSignature } from '../scripts/setImmediatePolyfillSignature.mjs';

describe('containsUnneutralisedPolyfillSignature (shared signature module)', () => {
	it('detects an un-neutralised polyfill signature', () => {
		const src = '"onreadystatechange" in document.createElement("script")';
		expect(containsUnneutralisedPolyfillSignature(src)).toBe(true);
	});

	it('does not flag a neutralised (span) rewrite', () => {
		const src = '"onreadystatechange" in document.createElement("span")';
		expect(containsUnneutralisedPolyfillSignature(src)).toBe(false);
	});

	it('does not flag a genuine script-with-src loader far from onreadystatechange', () => {
		const src = 'var s = document.createElement("script"); s.src = "https://cdn.example.com/x.js"; document.head.appendChild(s);'
			+ ' '.repeat(200) + 'onreadystatechange somewhere far away';
		expect(containsUnneutralisedPolyfillSignature(src)).toBe(false);
	});

	it('is safe to call repeatedly without lastIndex leaking between calls', () => {
		const bad = '"onreadystatechange" in document.createElement("script")';
		const good = '"onreadystatechange" in document.createElement("span")';
		expect(containsUnneutralisedPolyfillSignature(bad)).toBe(true);
		expect(containsUnneutralisedPolyfillSignature(good)).toBe(false);
		expect(containsUnneutralisedPolyfillSignature(bad)).toBe(true);
	});
});

describe('checkSetImmediatePolyfillNeutralised', () => {
	it('passes on clean bundle source', () => {
		const r = checkSetImmediatePolyfillNeutralised('console.log("hello")');
		expect(r.status).toBe('pass');
	});

	it('fails when an un-neutralised signature is present', () => {
		const r = checkSetImmediatePolyfillNeutralised('"onreadystatechange" in document.createElement("script")');
		expect(r.status).toBe('fail');
		expect(r.message).toContain('setImmediate');
	});
});

describe('checkNoManifestJsonLiteral', () => {
	it('passes when no manifest.json literal exists', () => {
		const r = checkNoManifestJsonLiteral('const x = "index.json";');
		expect(r.status).toBe('pass');
	});

	it('fails and counts occurrences when manifest.json literal(s) exist', () => {
		const r = checkNoManifestJsonLiteral('const a = "manifest.json"; const b = "manifest.json";');
		expect(r.status).toBe('fail');
		expect(r.message).toContain('2');
	});

	it('catches single-quoted manifest.json (audit-caught: was double-quote-only)', () => {
		const r = checkNoManifestJsonLiteral("const a = 'manifest.json';");
		expect(r.status).toBe('fail');
	});

	it('catches template-literal manifest.json', () => {
		const r = checkNoManifestJsonLiteral('const a = `manifest.json`;');
		expect(r.status).toBe('fail');
	});
});

describe('checkVersionSync', () => {
	it('passes when package.json/manifest.json/versions.json all agree', () => {
		const r = checkVersionSync(
			{ version: '1.0.21' },
			{ version: '1.0.21', minAppVersion: '1.11.4' },
			{ '1.0.20': '1.11.4', '1.0.21': '1.11.4' },
		);
		expect(r.status).toBe('pass');
	});

	it('fails when package.json and manifest.json versions differ', () => {
		const r = checkVersionSync(
			{ version: '1.0.22' },
			{ version: '1.0.21', minAppVersion: '1.11.4' },
			{ '1.0.21': '1.11.4' },
		);
		expect(r.status).toBe('fail');
		expect(r.message).toContain('!==');
	});

	it('fails when versions.json is missing the current version key', () => {
		const r = checkVersionSync(
			{ version: '1.0.21' },
			{ version: '1.0.21', minAppVersion: '1.11.4' },
			{ '1.0.20': '1.11.4' },
		);
		expect(r.status).toBe('fail');
	});

	it('fails when versions.json maps the current version to the wrong minAppVersion', () => {
		const r = checkVersionSync(
			{ version: '1.0.21' },
			{ version: '1.0.21', minAppVersion: '1.11.4' },
			{ '1.0.21': '1.9.0' },
		);
		expect(r.status).toBe('fail');
	});

	it('fails on empty/malformed objects rather than passing via undefined === undefined (audit-caught regression guard)', () => {
		const r = checkVersionSync({}, {}, {});
		expect(r.status).toBe('fail');
	});

	it('fails with a structured result (not a thrown TypeError) when pkgJson is null', () => {
		expect(() => checkVersionSync(null, { version: '1.0.21', minAppVersion: '1.11.4' }, {})).not.toThrow();
		const r = checkVersionSync(null, { version: '1.0.21', minAppVersion: '1.11.4' }, {});
		expect(r.status).toBe('fail');
	});

	it('fails with a structured result when manifestJson is null', () => {
		expect(() => checkVersionSync({ version: '1.0.21' }, null, {})).not.toThrow();
		const r = checkVersionSync({ version: '1.0.21' }, null, {});
		expect(r.status).toBe('fail');
	});

	it('fails when package.json.version is missing', () => {
		const r = checkVersionSync(
			{},
			{ version: '1.0.21', minAppVersion: '1.11.4' },
			{ '1.0.21': '1.11.4' },
		);
		expect(r.status).toBe('fail');
		expect(r.message).toContain('package.json.version');
	});

	it('fails when manifest.json.minAppVersion is missing', () => {
		const r = checkVersionSync(
			{ version: '1.0.21' },
			{ version: '1.0.21' },
			{ '1.0.21': '1.11.4' },
		);
		expect(r.status).toBe('fail');
		expect(r.message).toContain('minAppVersion');
	});

	it('does not require historical entries to be equal — only the current version key', () => {
		const r = checkVersionSync(
			{ version: '1.0.21' },
			{ version: '1.0.21', minAppVersion: '1.11.4' },
			{ '1.0.18': '1.10.0', '1.0.19': '1.10.0', '1.0.20': '1.11.4', '1.0.21': '1.11.4' },
		);
		expect(r.status).toBe('pass');
	});
});

describe('reportBundleSize', () => {
	it('is always info, never fail, regardless of size', () => {
		const huge = 'x'.repeat(10 * 1024 * 1024); // 10MB, well over any accepted threshold
		const r = reportBundleSize(huge);
		expect(r.status).toBe('info');
		expect(r.message).toMatch(/MB/);
	});
});

describe('loadArtifacts', () => {
	it('returns a fail result when main.js does not exist', () => {
		const result = loadArtifacts(
			() => { throw new Error('should not be called'); },
			() => false,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.result.status).toBe('fail');
			expect(result.result.message).toContain('npm run build');
		}
	});

	it('returns a fail result on malformed JSON rather than throwing', () => {
		const files: Record<string, string> = {
			'main.js': 'console.log(1)',
			'package.json': '{ not valid json',
			'manifest.json': '{}',
			'versions.json': '{}',
		};
		const result = loadArtifacts(
			(path: string) => files[path],
			() => true,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.result.status).toBe('fail');
		}
	});

	it('returns ok:true with parsed artifacts on success', () => {
		const files: Record<string, string> = {
			'main.js': 'console.log(1)',
			'package.json': JSON.stringify({ version: '1.0.21' }),
			'manifest.json': JSON.stringify({ version: '1.0.21', minAppVersion: '1.11.4' }),
			'versions.json': JSON.stringify({ '1.0.21': '1.11.4' }),
		};
		const result = loadArtifacts(
			(path: string) => files[path],
			() => true,
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.pkgJson.version).toBe('1.0.21');
		}
	});
});

describe('runAllChecks', () => {
	it('runs all four checks and returns four results', () => {
		const results = runAllChecks({
			bundleSource: 'console.log(1)',
			pkgJson: { version: '1.0.21' },
			manifestJson: { version: '1.0.21', minAppVersion: '1.11.4' },
			versionsJson: { '1.0.21': '1.11.4' },
		});
		expect(results).toHaveLength(4);
		expect(results.every(r => ['pass', 'fail', 'info'].includes(r.status))).toBe(true);
	});
});
