# Dependency Accepted Risks & Pinned Artifacts

Tracked, deliberate exceptions to a clean `npm audit` — either a vulnerability
whose risk is accepted (with a named trigger for revisiting), or a dependency
pinned to a specific non-registry artifact (with its provenance recorded so
future updates repeat the same verification, not a blind bump).

Plan: [docs/plans/npm-audit-remediation.md](plans/npm-audit-remediation.md).

---

## Accepted risks

### `@anthropic-ai/sdk` — GHSA-p7fg-763f-g4gf

- **Severity**: Moderate (CWE-732, insecure default file permissions in the
  local filesystem memory tool)
- **Affected range**: `>=0.79.0 <0.91.1` — installed `^0.90.0`
- **Status**: Accepted risk, dev-only, no code change
- **Owner**: Louis Strydom (solo maintainer)
- **Reachability evidence** (verified 2026-07-13, re-verified before this
  entry was committed):
  - `grep -rl "@anthropic-ai/sdk" src/ scripts/` → matches ONLY under
    `scripts/.claude-skills/lib/anthropic-client.mjs`,
    `scripts/.claude-skills/lib/llm-wrappers.mjs`, `scripts/evolve-prompts.mjs`,
    `scripts/refine-prompts.mjs`. **Zero matches under `src/`.**
  - `package.json` lists it under `"devDependencies"` (line 47), not
    `"dependencies"`.
  - `esbuild.config.mjs`'s single entry point is `src/main.ts`; esbuild only
    bundles what's statically reachable from that entry. No `src/` file
    imports `@anthropic-ai/sdk`, so esbuild cannot pull it into `main.js`.
  - **Build-artifact confirmation**: `grep -c "@anthropic-ai/sdk" main.js`
    after a production build → `0`.
  - The 4 matched scripts do not use the SDK's local-filesystem memory-tool
    feature (`grep -n "memory\|betaTool\|filesystem"` across those 4 files →
    no matches) — the vulnerable surface isn't invoked even within its own
    dev-only scope.
- **Trigger for revisiting**: migrate when next materially touching
  `scripts/.claude-skills/*` Claude SDK usage (a 21-minor-version pre-1.0
  gap makes a dedicated migration pass worthwhile once touching that code
  anyway — not worth a standalone migration for audit hygiene alone).

---

## Pinned non-registry artifacts

### `xlsx` — pinned to SheetJS's own CDN build

- **Reason**: `xlsx@0.18.5` (last npm-registry release) is vulnerable to
  prototype pollution (GHSA-4r6h-8v6p-xvw6) and ReDoS (GHSA-5pgg-2g8v-p4x9).
  SheetJS stopped publishing patched builds to the public npm registry;
  fixes since 0.18.5 ship only via `cdn.sheetjs.com`.
- **Pinned artifact**: `xlsx@0.20.3` —
  `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` (immutable versioned
  URL, not `-latest`)
- **SHA-512** (self-computed from the downloaded tarball, 2,409,319 bytes):
  `sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==`
- **Verified 2026-07-13**: extracted `package.json` from the tarball →
  `version: 0.20.3`, clears both cited advisories (`0.20.3 > 0.20.2` and
  `> 0.19.3`).
- **Trust model**: `package-lock.json` records npm's own independently
  computed integrity hash for this tarball on install — `npm ci` in the
  release workflow still verifies byte-for-byte reproducibility. This is a
  **different** trust root (SheetJS's CDN, not npm's registry signing), not
  an unpinned one.
- **Update procedure** (required before ever bumping this pin): download the
  new versioned tarball, extract `package.json`, confirm the version clears
  any newly-disclosed advisory, record the new SHA-512 here, update
  `package.json`. Never bump to `-latest` blind.

### `@xmldom/xmldom` — forced via `npm overrides`

- **Reason**: `dom-to-pptx@1.1.5 → fonteditor-core@2.6.3` hard-pins
  `@xmldom/xmldom@^0.8.3` (XML injection, GHSA-wh4c-j3r5-mjhp and related —
  fixed `>=0.9.10`). `fonteditor-core` (last published 2.6.3) has not been
  updated to allow a newer range.
- **Fix**: `package.json` `"overrides": { "@xmldom/xmldom": "^0.9.10" }` —
  installed and confirmed via `package-lock.json` at `0.9.10`.
- **Verification (implementation deviation from the original plan,
  disclosed)**: the original design was a full presentation-export OOXML
  manifest diff via `dom-to-pptx → fonteditor-core`. That pipeline turned
  out to be impractical to test programmatically — `dom-to-pptx`'s public
  `exportToPptx()` API triggers a browser download directly and does not
  return bytes for inspection. `tests/verifyPptxXmldomCompat.test.ts`
  instead exercises the actual vulnerable surface directly —
  `@xmldom/xmldom`'s `DOMParser`/`XMLSerializer` on the exact CDATA/
  comment/processing-instruction content the CVEs cover — via round-trip
  fidelity assertions. This is a more direct proof of the security property
  than a pipeline-level diff would have been.
- **Known residual gap, found during verification (not hidden)**: unlike
  `createCDATASection()` (which now validates at construction time and
  throws on a `]]>` terminator sequence), `@xmldom/xmldom@0.9.10`'s
  `createProcessingInstruction()` does NOT validate that `data` excludes the
  `?>` terminator — a PI built from attacker-controlled data containing
  `?>` still leaks a real sibling element on serialize+re-parse (verified
  live, asserted explicitly in the test file rather than silently passed).
  **Not reachable through this codebase's actual xmldom usage**:
  `fonteditor-core`'s xmldom calls manipulate font-metadata XML, which does
  not construct `ProcessingInstruction` nodes from attacker-controlled
  (e.g. user-authored slide) text. Tracked here so it isn't lost; revisit
  if `fonteditor-core`'s usage ever changes to construct PIs from
  user-influenced content.
- **If this override ever needs to be dropped** (verification fails and
  `patch-package` proves unclean): this becomes an **accepted risk** entry
  in this same document — named owner (Louis Strydom), advisory IDs,
  affected/patched range, and a review trigger of "re-verify whenever
  `fonteditor-core` publishes a release, or every 6 months, whichever is
  sooner." `patch-package` is a temporary bridge, never a standalone
  terminal remediation.

### Local ONNX embedding model — pinned to a commit SHA

- **Reason**: `LocalOnnxEmbeddingService` downloads
  `Xenova/all-MiniLM-L6-v2` from Hugging Face Hub. The default `main` branch
  is a mutable ref — a compromise of the `Xenova` HF account could push
  different model bytes to every opted-in user, and the `@xenova/transformers
  → onnxruntime-web → onnx-proto → protobufjs` chain has a known
  critical-severity (RCE-class) vulnerability with no available fix, so the
  bytes being decoded matter.
- **Pinned commit**: `751bff37182d3f1213fa05d7196b954e230abad9`
- **Verified 2026-07-13**: `https://huggingface.co/api/models/Xenova/all-MiniLM-L6-v2`
  → `sha: 751bff37182d3f1213fa05d7196b954e230abad9`, `lastModified:
  2025-07-22T16:42:24.000Z`.
- **Underlying dependency risk NOT eliminated**: this narrows exploitability
  (immutable content vs. a mutable branch pointer) — it does not fix the
  `protobufjs` chain itself. The real fix is a future migration to
  `@huggingface/transformers`, tracked separately (out of scope for the
  plan that produced this pin).
- **Update procedure**: any intentional model update requires resolving and
  recording a new commit SHA here, the same way the xlsx pin is updated —
  never a silent `main`-branch drift.

### Related but deferred

- `semanticSearchCommands.ts`'s generic `t.messages.vectorStoreFailed`
  Notice doesn't distinguish *why* the vector store is empty (missing
  cloud credentials vs. other causes) from the new
  `'local-onnx-not-consented'` reason introduced alongside these pins. This
  plan's design doesn't depend on fixing it — the settings-page banner
  (see the ONNX opt-in gate cluster) already covers the specific new gap.
  Worth a follow-up pass if user reports surface confusion here.
