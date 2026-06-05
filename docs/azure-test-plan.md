# Azure-Mode Test Plan (functional + persona-fit layout)

- **Status**: Living document — extend in place
- **Owner**: Louis + team
- **Scope**: Every Azure-routed feature, verified in the **real Obsidian Electron app** (Playwright/CDP) against the live `azure-claude` deployment, plus persona-driven layout evaluation of every generated artifact.
- **Out of scope**: Gemini-only paths (YouTube transcription, audio-narration TTS, the LLM-enhancement pre-stage) and non-Azure search providers (Tavily / Bright Data SERP). The `claude-web-search` research provider **is** Azure-routed and IS in scope.

> **Why this exists.** "It failed on Azure" needs to become a precise, repeatable signal that separates three very different things: (1) a **code bug**, (2) a **TPM-quota limit** (the deployment caps at ~10k tokens/min — an IT item), and (3) a **layout/UX flaw**. Every result below is labelled with which of the three it is.

---

## 0. Preconditions & environment

| Item | Value |
|---|---|
| Vault | `C:\obsidian\Second Brain` (last-opened) |
| Obsidian | `C:\Program Files\Obsidian\Obsidian.exe` — **must be closed** before a run (single-instance + CDP port) |
| Provider | `cloudServiceType: azure-claude`, `azureFirstMode: true`, endpoint set, `researchProvider: claude-web-search` |
| Pacing | `azureMaxRpm: 10`, `azureMaxConcurrentRequests: 2` (defaults) |
| Test materials | `AI-Organiser/Z test/` (notes, minutes, multi-source) + `99 File Storage/*.pdf,*.png` + `AI-Organiser/Recordings/*.m4a,*.mp3` |
| Harness | `scripts/persona-harness/` — `driver.mjs` (launch/attach), `azure-feature-sweep.mjs` (service-layer sweep) |

**The three-way result label** every test must produce:
- **PASS** — feature completed correctly, routed to Azure (`*.services.ai.azure.com`).
- **QUOTA** — failed *only* because the 10k-TPM window was exhausted (back-to-back/large input); the pacing retried; raising the quota or spacing the call fixes it. **Not a code defect.**
- **BUG** — failed for any other reason (wrong routing, broken parse, hard-fail where a retry should have happened, malformed output). **Actionable.**
- **LAYOUT** — completed but the rendered artifact has a substantive layout flaw.

---

## 1. Track 1 — Functional matrix (does each Azure feature work?)

Each row exercises a real **paced egress path** and asserts completion + Azure routing + graceful throttling. Egress legend: **T** = `summarizeText`→`postWithRetry`, **G** = `analyzeTags`→`makeRequestWithRetry`, **M** = `sendMultimodal` (multimodal), **W** = Whisper (`pacedWhisperRequest`), **S** = `summarizeTextStream` (SSE), **WS** = `claudeWebSearchAdapter`, **E** = embeddings (`embeddingQueue`, separate cap-1 mechanism).

### 1a. Capture / ingest
| # | Feature | Command | Egress | Material | Expected | Pass criteria |
|---|---|---|---|---|---|---|
| 1 | Summarize note | `smart-summarize` | T | `Test Note Raw text.md` | structured summary inserted | non-empty summary, sources cleaned |
| 2 | Summarize URL | `smart-summarize` | T (+web fetch) | `Test URL.md` | article summary | summary reflects the article |
| 3 | Summarize PDF | `smart-summarize` / multi-source | **M** | `Test PDF.md` → `Design Thinking…pdf` | PDF summary | accurate, multimodal routed |
| 4 | Multi-source | multi-source modal | T+M+W | `Test Multi-source 1.md` (wav+URLs) | merged summary | all sub-sources resolved or per-source error isolated |
| 5 | Transcribe audio | `transcribe-audio` | **W** | `recording-2026-02-01T13-30-04.mp3` (14K) | labelled transcript note | transcript text + speaker review, Whisper routed |
| 6 | Quick peek | `quick-peek` | T | note with embeds | per-source triage cards | one card per source, no hard-fail |
| 7 | Web reader | `web-reader` | T | note with web links | triage summaries | per-URL brief + note creation |

### 1b. Create
| # | Feature | Command | Egress | Material | Expected | Pass criteria |
|---|---|---|---|---|---|---|
| 8 | Meeting minutes | `create-meeting-minutes` | T (+**W** if audio) | `Test Minutes Hamina 1.md` / `hamina…mp3` | structured minutes JSON→md | agenda/actions/decisions sections present |
| 9 | Presentation (slides) | `presentation-chat` | T/**S** | prompt + note/web-search source | IR deck, ≥5 slides | renders + exports PPTX (see §2 layout) |
| 10 | Mermaid diagram | `edit-mermaid-diagram` / mermaid chat | T/**S** | a note | valid mermaid block | ` ```mermaid ` + renders |
| 11 | Canvas (investigation) | `build-investigation-canvas` | T (+**E**) | a note (semantic search on) | `.canvas` with related notes | nodes + edges created |
| 12 | Canvas (cluster) | `build-cluster-canvas` | T | a tag | clustered `.canvas` | clusters labelled |
| 13 | Flashcards | flashcard export | T/**M** | a note / image | Anki/Brainscape deck | cards generated |
| 14 | Translate | `smart-translate` | T | `Test Translate.md` / note | translated note | target-language output |

### 1c. Refine
| # | Feature | Command | Egress | Material | Expected | Pass criteria |
|---|---|---|---|---|---|---|
| 15 | Improve note | `improve` | T | a note | improved draft (diff review) | Reviewed-Edits modal + sensible diff |
| 16 | Integrate pending | resolve-pending | T+M | note with embeds | embeds resolved inline | content replaces embed syntax |
| 17 | Digitise image | `digitise-image` | **M** | `Vison test.md` → png (**resized**) | extracted text + mermaid | accurate; **note: real path resizes via ImageProcessorService** |
| 18 | Per-slide polish | presentation polish | T | an existing deck | refined slides | content preserved (no deletion — #2) |

### 1d. Find
| # | Feature | Command | Egress | Material | Expected | Pass criteria |
|---|---|---|---|---|---|---|
| 19 | Web research | `research-web` | **WS** (+T/S) | a question | synthesised answer + citations | shared azure-claude bucket; recovers from 429 |
| 20 | Semantic search | semantic search | **E** | a query | ranked results | results returned (embeddings via queue) |
| 21 | Find related | related-notes / insert-related | **E** | a note | related list | populated sidebar/insert |
| 22 | Tags | `smart-tag` | **G** | `Test Note Raw text.md` | frontmatter tags | ≥1 tag, kebab-case |

### 1e. Throttling resilience (cross-cutting — the trust-critical row)
| # | Scenario | Method | Expected (post-fix) |
|---|---|---|---|
| 23 | Small request under exhausted TPM | fire a tiny `summarizeText` right after a heavy call | **retries** + succeeds (NOT a ">TPM 64k" hard-fail) |
| 24 | Genuinely-too-big input | a >50k-char single prompt | input-only fail-fast → actionable `AzureRateLimitError` |
| 25 | Multimodal under exhausted TPM | PDF/image right after a heavy call | retries; exhausted → actionable error (never pre-empts) |
| 26 | Web-search + text share the bucket | run research then summarize | one shared RPM budget; no double-spend 429-storm |
| 27 | Chunked audio (many Whisper calls) | transcribe a >20-min file | per-chunk paced, no RPM storm |

---

## 2. Track 2 — Persona-fit layout evaluation (all artifacts)

For each persona, drive their **realistic** end-to-end flows, **capture the rendered layout** of every artifact, and score it against the persona's stated needs. A flaw is "substantive" if it would make the persona distrust the output (broken chart, dropped content, overflow, illegible hierarchy, off-brand, export ≠ preview).

### Personas (from `personas.json`)
| Persona | Role | Primary flows | Layout sensitivities |
|---|---|---|---|
| **Pat** | Director, briefing prep, 48 | **presentation deck** from a board note + web research; **meeting minutes** from `hamina…mp3`; DOCX/PPTX export | exec-ready slides, complete minutes, on-brand, export fidelity |
| **Dr. Chen** | Cog-sci postdoc, ~5000 notes | **research** synthesis; **tagged summary**; **investigation canvas**; **mermaid** model diagram | citation rigor, tag quality, canvas legibility, diagram correctness |
| **Maya** | Psych undergrad, 22 | **lecture-note summary**; **flashcards**; **mermaid** concept map; translate | readable summary, well-formed cards, clear diagrams |

### Artifacts captured + rubric (score 1–5 each, flag <3)
For every artifact: render to PNG (HTML preview) **and** the export where applicable, then score:
1. **Completeness** — no load-bearing content dropped (process-flow endpoints, conclusions, framing).
2. **Layout integrity** — charts scale, tables align, no overflow/clipping, cards/borders render.
3. **Hierarchy/legibility** — headings, spacing, emphasis read cleanly for the persona.
4. **Brand/consistency** — colours/fonts/theme consistent; on-brand where set.
5. **Export fidelity** — PPTX/DOCX/PDF matches the preview (the HTML-vs-PPTX check).

### Artifact coverage
slides (HTML preview + PPTX) · minutes (md + DOCX) · summaries (note insert) · canvas (`.canvas` render) · flashcards (deck) · mermaid (rendered SVG) · document exports (PDF/DOCX/PPTX).

### A/B protocol (persona-fit)
For each persona × artifact: capture the rendered output, run the 5-point rubric (LLM-as-judge on the rendered PNG + a human spot-check), and record flaws with a screenshot. Re-run after any change to A/B against the prior capture (regression guard). The recent **bar-chart collapse** + **stripped card borders** are the canonical example of a "LAYOUT" flaw this track must catch.

---

## 3. Harness architecture (`npm run test:azure`)

```
scripts/persona-harness/
  driver.mjs                 # launch/attach (CDP), ensureVaultOpen, waitForPluginReady, runCommand
  azure-feature-sweep.mjs    # Track 1 service-layer sweep (summarize/tags/PDF/image/mermaid/translate)
  azure-ui-flows.mjs         # Track 1 UI flows (transcribe, minutes, multi-source, presentation) — TODO
  persona-layout-ab.mjs      # Track 2 persona-fit capture + rubric — TODO
  render-deck-html.mjs       # rasterize deck.html slides for fidelity diff
  sessions/<run>/            # report.json + screenshots + rendered PNGs (gitignored)
```

- **Service-layer where reliable** (summarize/tags/multimodal/mermaid/translate) — calls the exact production methods (`llmService.*`), fast + deterministic.
- **UI-driven where required** (transcribe/minutes/presentation/canvas) — drives the real modal so the *feature* (not just the transport) is exercised.
- **Result labelling** — each test emits `{ feature, result: PASS|QUOTA|BUG|LAYOUT, ms, throttle429, azureRouted, snippet }`.
- **Console/Notice monitoring** — captures `[rate-limit]`, real 429s, `AzureRateLimitError`, page errors throughout.
- `npm run test:azure` → runs the suite, writes a per-run `report.json` + a one-screen pass/fail matrix.

---

## 4. Running + interpreting

1. Close Obsidian. 2. `npm run build` (deploy current code). 3. `npm run test:azure`. 4. Read the matrix + `sessions/<run>/report.json`.

**Interpreting:**
- All **PASS** → green.
- **QUOTA** rows → expected under the current 10k TPM when hammered/large; not blockers. Re-run spaced, or after the quota raise, to confirm they flip to PASS.
- **BUG** rows → file + fix (the `/cycle` flow).
- **LAYOUT** rows → file with the screenshot; fix the renderer/sanitizer/prompt.

---

## 5. Known constraints
- **TPM = ~10k/min** on the dev deployment: large multimodal (full-res images, big PDFs) and rapid back-to-back use will hit it; the pacing retries, and the input-only fail-fast means small requests no longer hard-fail. A quota raise removes the ceiling (tracked separately by the team).
- **Single-instance**: the harness must own the Obsidian process (close it first).
- **Image size**: digitise/flashcard image paths resize via `ImageProcessorService` before send — tests must resize too, or they over-state token cost.

---

## 6. Status log
- **2026-06-05** — Plan created. Track-1 service sweep live (summarize/tags/PDF/image/mermaid/translate → 6/6 PASS in Azure mode after the input-only >TPM fix). Track-1 UI flows (transcribe/minutes/multi-source/presentation) + Track-2 persona-layout A/B: **TODO** (next build).
