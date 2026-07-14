/**
 * No `@vitest-environment` pragma needed — every test imports `DOMParser`/
 * `XMLSerializer` explicitly from the `@xmldom/xmldom` package rather than
 * relying on a global `window.DOMParser` (unlike `htmlToRichSlideParser.ts`,
 * which this test deliberately does NOT invoke — see the deviation note
 * below). A jsdom/happy-dom global `document` actually CONFUSES
 * `fonteditor-core`'s internal environment detection (verified live: the
 * `ttf2svg()` call below throws under `@vitest-environment jsdom` but
 * succeeds under the default Node environment) — this file runs under
 * plain Node on purpose.
 *
 * Verifies the `@xmldom/xmldom` override (npm-audit-remediation plan,
 * Cluster 3) — the version pinned via `package.json` `overrides` fixes a
 * serializer-safety class of CVEs (GHSA-wh4c-j3r5-mjhp CDATA injection,
 * GHSA-j759-j44w-7fr8 comment injection, GHSA-x6wf-f3px-wcqx processing-
 * instruction injection, GHSA-f6ww-3ggp-fr8h DocumentType injection,
 * GHSA-2v35-w6hq-6mfw uncontrolled recursion).
 *
 * Implementation note (deviation from the original plan): the plan's
 * original design was a full presentation-export byte/structural diff via
 * `dom-to-pptx` → `fonteditor-core`. That pipeline was found impractical to
 * test programmatically — `dom-to-pptx`'s public `exportToPptx()` API
 * triggers a browser download directly and does not return bytes for
 * inspection (see `src/types/dom-to-pptx.d.ts` — `Promise<void>`, not
 * `Promise<ArrayBuffer>`). Two layers instead: (1) `fonteditor-core.ttf2svg()`
 * — the actual xmldom-consuming call in the real
 * `dom-to-pptx → fonteditor-core → @xmldom/xmldom` chain — invoked directly
 * (bypassing only the browser-download wrapper, not the real consumer);
 * (2) `@xmldom/xmldom`'s `XMLSerializer` on the exact CDATA/comment/
 * processing-instruction content the CVEs cover, via round-trip fidelity —
 * if the serializer improperly escapes a dangerous delimiter sequence,
 * content would leak across node boundaries and a re-parse would NOT
 * reproduce the original content exactly.
 */
import { describe, it, expect } from 'vitest';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function xmldomVersion(): string {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- CJS package, no ESM export map for package.json
    return require('@xmldom/xmldom/package.json').version;
}

/** Full semver comparison — a major.minor-only check would let `0.9.0`
 *  through `0.9.9` (all still vulnerable, since the fix landed at exactly
 *  `0.9.10`) silently pass. */
function meetsMinimumVersion(version: string, minMajor: number, minMinor: number, minPatch: number): boolean {
    const [major, minor, patch] = version.split('.').map(Number);
    if (major !== minMajor) return major > minMajor;
    if (minor !== minMinor) return minor > minMinor;
    return patch >= minPatch;
}

describe('@xmldom/xmldom dependency pin', () => {
    it('resolves to the patched version range (>=0.9.10)', () => {
        expect(meetsMinimumVersion(xmldomVersion(), 0, 9, 10)).toBe(true);
    });

    it('rejects known-vulnerable pre-fix minor releases (regression guard for the version-check itself)', () => {
        expect(meetsMinimumVersion('0.9.9', 0, 9, 10)).toBe(false);
        expect(meetsMinimumVersion('0.9.0', 0, 9, 10)).toBe(false);
        expect(meetsMinimumVersion('0.8.11', 0, 9, 10)).toBe(false);
        expect(meetsMinimumVersion('0.9.10', 0, 9, 10)).toBe(true);
        expect(meetsMinimumVersion('0.9.11', 0, 9, 10)).toBe(true);
        expect(meetsMinimumVersion('1.0.0', 0, 9, 10)).toBe(true);
    });
});

describe('@xmldom/xmldom via the actual production consumer (fonteditor-core)', () => {
    it('fonteditor-core.ttf2svg() — the real xmldom-consuming call this override protects — succeeds against the patched version', () => {
        // This is the ACTUAL integration path this cluster fixes:
        // dom-to-pptx -> fonteditor-core -> @xmldom/xmldom. dom-to-pptx's own
        // public API can't be driven headlessly (see file header), but
        // fonteditor-core's ttf2svg() is the specific operation that
        // constructs XML/SVG output via xmldom, and IS directly callable.
        // Font source: node_modules/pdfjs-dist's bundled Liberation Sans
        // (SIL Open Font License, already a real dependency of this repo —
        // no new fixture needed).
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- CJS package
        const { ttf2svg } = require('fonteditor-core');
        const fontPath = join(
            require.resolve('pdfjs-dist/package.json'),
            '..', 'standard_fonts', 'LiberationSans-Bold.ttf',
        );
        const buf = readFileSync(fontPath);
        // A fresh, explicitly-copied ArrayBuffer — NOT `buf.buffer.slice(...)`.
        // Verified live: fonteditor-core's internal TTF reader rejects a
        // sliced view of Node's pooled Buffer allocator under Vitest's
        // module-transform pipeline (an `instanceof ArrayBuffer` check
        // upstream in ttf2svg() itself passes fine either way, but a deeper
        // internal reader check fails specifically on the pooled-slice
        // shape) — a plain copy sidesteps it entirely.
        const arrayBuffer = new ArrayBuffer(buf.length);
        new Uint8Array(arrayBuffer).set(buf);

        const svg: string = ttf2svg(arrayBuffer);

        expect(svg.length).toBeGreaterThan(0);
        expect(svg).toContain('<?xml version="1.0"');
        expect(svg).toContain('<svg');
        expect(svg).toContain('</svg>');
        // Re-parse to confirm the xmldom-serialized output is well-formed
        // XML, not just non-empty — a corrupted serializer could still
        // produce SOME string without throwing.
        const reparsed = new DOMParser().parseFromString(svg, 'text/xml');
        expect(reparsed.getElementsByTagName('svg').length).toBe(1);
    });
});

describe('xmldom serializer — CDATA injection (GHSA-wh4c-j3r5-mjhp)', () => {
    it('rejects a CDATA terminator sequence at construction time (fail-closed, not a serialization-time escape)', () => {
        // The patched version validates at `createCDATASection()` itself —
        // stronger than a serialization-time escape: the dangerous node can
        // never exist in the DOM tree at all. (Verified live: the exact same
        // call on the pre-override 0.8.11 line does NOT throw and instead
        // lets the terminator through to the serializer unescaped — this
        // assertion is the regression guard for that hardening.)
        const doc = new DOMParser().parseFromString('<root><item/></root>', 'text/xml');
        expect(() => doc.createCDATASection('before ]]> after')).toThrow(/data contains "\]\]>"/);
    });

    it('round-trips a CDATA section containing safe content unchanged', () => {
        const doc = new DOMParser().parseFromString('<root><item/></root>', 'text/xml');
        const item = doc.getElementsByTagName('item')[0];
        const text = 'safe <not-a-real-tag> & special chars';
        item.appendChild(doc.createCDATASection(text));

        const serialized = new XMLSerializer().serializeToString(doc);
        const reparsed = new DOMParser().parseFromString(serialized, 'text/xml');
        expect(reparsed.getElementsByTagName('item')[0].textContent).toBe(text);
    });
});

describe('xmldom serializer — comment content (GHSA-j759-j44w-7fr8)', () => {
    it('round-trips a comment with safe content unchanged', () => {
        const doc = new DOMParser().parseFromString('<root/>', 'text/xml');
        const text = 'a safe comment with <angle brackets> and & ampersands';
        doc.documentElement!.appendChild(doc.createComment(text));

        const serialized = new XMLSerializer().serializeToString(doc);
        const reparsed = new DOMParser().parseFromString(serialized, 'text/xml');
        const reparsedComment = reparsed.documentElement!.childNodes[0];
        expect(reparsedComment.nodeType).toBe(8); // COMMENT_NODE
        expect(reparsedComment.nodeValue).toBe(text);
    });

    it('a comment containing "--" is not silently corrupted into valid-looking-but-wrong markup on re-parse', () => {
        // XML comments cannot legally contain "--" per the XML 1.0 grammar
        // itself (not an xmldom-specific rule). The pre-patch vulnerability
        // was serializing this anyway, producing WELL-FORMED-LOOKING but
        // structurally broken output that could smuggle markup into a
        // sibling position. The patched version's round-trip surfaces the
        // malformation loudly (a parse error) rather than silently — the
        // safe outcome is "detectably broken", not "silently accepted".
        const doc = new DOMParser().parseFromString('<root/>', 'text/xml');
        const dangerous = 'safe -- --> <injected>evil</injected>';
        doc.documentElement!.appendChild(doc.createComment(dangerous));
        const serialized = new XMLSerializer().serializeToString(doc);

        let injectionSucceeded = false;
        try {
            const reparsed = new DOMParser().parseFromString(serialized, 'text/xml');
            injectionSucceeded = reparsed.getElementsByTagName('injected').length > 0;
        } catch {
            // A parse error on re-parse is the SAFE outcome here — the
            // malformed content was surfaced, not silently smuggled through.
            injectionSucceeded = false;
        }
        expect(injectionSucceeded).toBe(false);
    });
});

describe('xmldom serializer — processing-instruction data (GHSA-x6wf-f3px-wcqx)', () => {
    it('round-trips a processing instruction with safe content unchanged', () => {
        const doc = new DOMParser().parseFromString('<root/>', 'text/xml');
        const data = 'key="value" other="safe"';
        doc.documentElement!.appendChild(doc.createProcessingInstruction('target', data));

        const serialized = new XMLSerializer().serializeToString(doc);
        const reparsed = new DOMParser().parseFromString(serialized, 'text/xml');
        const reparsedPi = reparsed.documentElement!.childNodes[0];
        expect(reparsedPi.nodeType).toBe(7); // PROCESSING_INSTRUCTION_NODE
        expect(reparsedPi.nodeValue).toBe(data);
    });

    // KNOWN RESIDUAL GAP (found during implementation, disclosed honestly
    // rather than papered over): unlike createCDATASection(), xmldom 0.9.10's
    // createProcessingInstruction() does NOT validate that `data` excludes
    // the "?>" terminator sequence. A PI constructed with attacker-controlled
    // data containing "?>" DOES leak a real sibling element on re-parse —
    // verified live below. This is a genuine inconsistency in the patched
    // library (CDATA is now fail-closed at construction; PI is not), not a
    // test-writing error. PRACTICAL exploitability in this codebase is low:
    // fonteditor-core's actual xmldom usage manipulates font-metadata XML,
    // which does not construct ProcessingInstruction nodes from
    // attacker-controlled (e.g. user-authored slide) text — so this gap is
    // not reachable through the PPTX export path this cluster is fixing.
    // Recorded here (not silently passed) so it doesn't get lost, and noted
    // in docs/dependency-accepted-risks.md.
    it('DOCUMENTS (does not silently hide) that PI data containing "?>" still leaks — matches known upstream behavior, not reachable via this codebase\'s xmldom usage', () => {
        const doc = new DOMParser().parseFromString('<root/>', 'text/xml');
        const dangerousData = 'safe ?> <injected>evil</injected>';
        doc.documentElement!.appendChild(doc.createProcessingInstruction('target', dangerousData));
        const serialized = new XMLSerializer().serializeToString(doc);
        const reparsed = new DOMParser().parseFromString(serialized, 'text/xml');
        // This assertion is INTENTIONALLY the opposite of "safe" — it
        // documents the known gap so a future xmldom upgrade that fixes it
        // is caught (this test would then need updating, which is the
        // point: a silent behavior change here should be visible).
        expect(reparsed.getElementsByTagName('injected').length).toBe(1);
    });
});

describe('xmldom serializer — recursion safety (GHSA-2v35-w6hq-6mfw)', () => {
    it('serializes a deeply nested (but bounded) document without stack overflow', () => {
        const doc = new DOMParser().parseFromString('<root/>', 'text/xml');
        let current = doc.documentElement!;
        const depth = 500;
        for (let i = 0; i < depth; i++) {
            const child = doc.createElement('n');
            current.appendChild(child);
            current = child;
        }
        expect(() => new XMLSerializer().serializeToString(doc)).not.toThrow();
        const serialized = new XMLSerializer().serializeToString(doc);
        // The innermost (leaf) node has no children and serializes
        // self-closing (`<n/>`), the other 499 as `<n>`.
        const openTags = (serialized.match(/<n>/g) ?? []).length;
        const selfClosedTags = (serialized.match(/<n\/>/g) ?? []).length;
        expect(openTags + selfClosedTags).toBe(depth);
    });
});
