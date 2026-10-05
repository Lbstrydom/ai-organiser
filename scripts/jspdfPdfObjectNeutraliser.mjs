// jsPDF >= 4.2.1 ships an `output('pdfobjectnewwindow')` mode that opens a
// window and injects a <script> pointing at a CDN copy of pdfobject:
//   var pdfObjectUrl = "https://cdnjs.cloudflare.com/ajax/libs/pdfobject/...";
//   ... initializedPdfObjectWindow.document.createElement("script") ...
// The plugin only ever calls `doc.output('arraybuffer')`, so that branch is
// dead code — but Obsidian's review bot statically counts the
// `createElement("script")` literal as "dynamic script injection" (a blocking
// error that failed release 1.0.28). jsPDF 4.2.0 did not have the branch.
//
// Imported by BOTH esbuild.config.mjs (rewrites the one site at build time) and
// tests; scripts/verify-build.mjs separately asserts no script element creation
// survives anywhere in the bundle, so a future jsPDF restructure that defeats
// this guard fails the build instead of the store review.

export const JSPDF_FILES = /[\\/]node_modules[\\/]jspdf[\\/]dist[\\/].*\.(?:c|m)?js$/;

const SCRIPT_CREATE_RE = /createElement\((['"])script\1\)/g;
const PDFOBJECT_CDN_MARKER = 'ajax/libs/pdfobject/';
// The CDN url literal precedes the createElement call by ~500 chars in the
// readable build and by less in the minified one.
const PDFOBJECT_WINDOW = 1500;

/**
 * Rewrite createElement("script") -> createElement("span") ONLY where the
 * pdfobject CDN url literal appears within PDFOBJECT_WINDOW chars before it.
 * Any other script loader is left intact (and caught by verify-build).
 * @returns {{ source: string, swaps: number }}
 */
export function neutraliseJspdfPdfObjectLoader(source) {
	if (!source.includes(PDFOBJECT_CDN_MARKER)) return { source, swaps: 0 };
	let swaps = 0;
	const out = source.replace(SCRIPT_CREATE_RE, (match, q, offset, str) => {
		const before = str.slice(Math.max(0, offset - PDFOBJECT_WINDOW), offset);
		if (!before.includes(PDFOBJECT_CDN_MARKER)) return match;
		swaps++;
		return `createElement(${q}span${q})`;
	});
	return { source: out, swaps };
}
