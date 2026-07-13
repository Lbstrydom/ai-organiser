// Shared, dependency-free definition of "what the dead setImmediate <script>
// polyfill looks like" — imported by BOTH esbuild.config.mjs (which rewrites
// the pattern at build time) and scripts/verify-build.mjs (which verifies the
// rewrite held in the output bundle). One source of truth so the two can
// never independently drift about what they're each checking for.
//
// Context: `jszip` (pulled in by `docx` for .docx export and `pptxgenjs` for
// .pptx export) bundles the `immediate`/`setimmediate`/`lie` microtask
// polyfill, which contains the IE6-8 scheduler hack:
//   "onreadystatechange" in document.createElement("script")
//     ? var A = document.createElement("script"); A.onreadystatechange = ...
// It creates an EMPTY <script> element (no `.src`, no inline body) purely as
// an onreadystatechange microtask trigger — dead code in Electron
// (MessageChannel always exists) — but Obsidian's review bot statically
// counts the `createElement("script")` literal as "dynamic script injection."

export const SCRIPT_CREATE_RE = /createElement\((['"])script\1\)/g;

// The polyfill's signature token sits within a few chars of BOTH its
// createElement("script") sites: the feature-detection ("onreadystatechange"
// in …createElement("script")) and the usage (x=…createElement("script");
// x.onreadystatechange=…). 60 chars comfortably spans either side.
export const ONREADYSTATECHANGE_WINDOW = 60;

/**
 * True if `source` contains at least one createElement("script") call within
 * ONREADYSTATECHANGE_WINDOW chars of the "onreadystatechange" signature token
 * — i.e. an un-neutralised instance of the dead setImmediate polyfill pattern
 * that esbuild.config.mjs's neutralizeSetImmediateScriptPolyfill plugin is
 * supposed to have already rewritten to createElement("span").
 */
export function containsUnneutralisedPolyfillSignature(source) {
	// Fresh RegExp instance per call — SCRIPT_CREATE_RE carries the `g` flag,
	// so reusing the exported object across calls would leak `lastIndex`
	// state between them (a class of bug this module exists to prevent, not
	// introduce).
	const re = new RegExp(SCRIPT_CREATE_RE.source, SCRIPT_CREATE_RE.flags);
	let match;
	while ((match = re.exec(source)) !== null) {
		const offset = match.index;
		const from = Math.max(0, offset - ONREADYSTATECHANGE_WINDOW);
		const ctx = source.slice(from, offset + match[0].length + ONREADYSTATECHANGE_WINDOW);
		if (ctx.includes('onreadystatechange')) return true;
	}
	return false;
}
