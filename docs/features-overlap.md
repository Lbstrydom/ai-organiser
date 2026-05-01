# Features & Overlap Tracker

Living document tracking every user-facing feature in AI Organiser, how personas experience them, and where overlaps, duplications, or inefficiencies exist.

Populated incrementally as persona-test sessions run against `C:\obsidian\Second Brain`. Each pass updates the tables below rather than appending new sections.

**Status**: scaffolded. Command picker pass pending smoke-test confirmation.

---

## 0. Entry-point inventory

Captured via `npm run persona:entry-points` (2026-04-19).

| Surface | Plugin items | Condition |
|---|---|---|
| Ribbon icon "AI organiser" | Opens Command Picker modal | always |
| Ribbon icon "Tag this note" | Runs tag command | always (second icon — worth reviewing if necessary) |
| File tree right-click, single MD file | Tag this note | md extension |
| File tree right-click, multi-select | Tag N notes | ≥1 md selected |
| File tree right-click, folder | Create bases dashboard | via dashboardCommands |
| Editor right-click, no selection | _(nothing — only Obsidian core items)_ | |
| Editor right-click, selection | Highlight · Ask AI · Translate · Add to pending | selection non-empty |
| Editor right-click, selection with link | + Quick Peek | selection contains a link |
| Editor right-click, cursor on image embed | AI: digitise | cursor on `![[...]]` image |
| Editor right-click, cursor inside mermaid fence | AI: edit diagram | cursor inside ```mermaid fence |
| Command palette (Ctrl+P) | 54 commands, all prefixed "AI Organiser:" | always |
| Command picker modal (ribbon) | ~36 leaves across 4 top-level categories | always |

Key observation: **command palette exposes 54 commands, the picker exposes ~36** — the 18-command gap is palette-only (highlight colours, quick-add variants, metadata upgrade, ensure-structure, collect-all-tags, drop-selection-pending, manage-index, show-tag-network, newsletter-open-digest). Worth reviewing whether any of these should appear in the picker or be removed/consolidated.

---

## 1. Command Picker Map

The Command Picker is the primary entry point. All commands are listed below in their picker grouping so we can audit ordering, naming, and duplication at a glance.

Source: [src/ui/modals/CommandPickerModal.ts](../src/ui/modals/CommandPickerModal.ts)

### Active Note
_Commands that operate on the currently open note._

| Sub-group | Command ID | User-facing name | Notes |
|---|---|---|---|
| — | _(to fill)_ | | |

### Capture
_Bring external content into the vault._

| Sub-group | Command ID | User-facing name | Notes |
|---|---|---|---|
| — | `smart-summarize` | Smart summarize | |
| — | `create-meeting-minutes` | Create meeting minutes | |
| — | `record-audio` | Record audio | |
| — | `web-reader` | Web reader | |
| — | `research-web` | Research | |
| — | `kindle-sync` | Kindle sync | |
| — | `newsletter-fetch` | Fetch newsletters | Recently flattened from sub-group (2026-04-19) |
| — | `new-sketch` | New sketch | |

### Vault
_Explore the knowledge base._

| Sub-group | Command ID | User-facing name | Notes |
|---|---|---|---|
| Ask & search | `chat-with-ai` | Chat with AI | |
| Ask & search | `semantic-search` | Semantic search | |
| Visualize | _(to fill)_ | | |
| — | `find-embeds` | Find embeds | Flattened from single-child group |

### Tools
_Specialized / bulk operations._

| Sub-group | Command ID | User-facing name | Notes |
|---|---|---|---|
| NotebookLM | _(to fill)_ | | |

---

## 2. Feature inventory (one row per user-visible feature)

| Feature | Entry point(s) | Produces | Consumes | LLM calls | Related features | Overlap risk |
|---|---|---|---|---|---|---|
| _(to fill per pass)_ | | | | | | |

---

## 3. Known / suspected overlaps

Candidates for consolidation, surfaced either from code inspection or persona sessions. Each entry states the symptom, the suspected cause, and what a persona confused about it reported (if observed).

### 3.1. Summarization variants
- **Smart summarize** (URL/PDF/YouTube/audio/documents)
- **Multi-source summarize** (bundled)
- **Quick peek** (fast triage, 1 paragraph)
- **Web reader** (triage web links before deciding to summarize)

**Question**: Does a new user understand the difference between Quick Peek, Web Reader, and Smart Summarize? All three take URLs and produce shorter-than-full summaries.

### 3.2. Research flows
- **Research web** (full pipeline with scoring/citations)
- **Web reader** (triage only)
- **Smart summarize → URL** (single-source summary)
- **Chat with AI** (free-form, optionally with web context via Claude Web Search)

**Question**: Where does a researcher start? What signals which tool fits which task?

### 3.3. Meeting content
- **Create meeting minutes** (structured)
- **Record audio** → transcribe → summarize (ad-hoc)
- **Smart summarize → audio** (single-source)

**Question**: Overlap between minutes generation and audio summarization when the user records a meeting.

### 3.4. Chat surfaces
- **Chat with AI** (free-form with attachments)
- **Mermaid chat** (diagram editing)
- **Presentation chat** (slide building)
- **Highlight chat** (chat about highlights)

**Question**: Four chat modes. Do personas discover them? Does the naming signal which to choose?

---

## 4. Persona findings

Appended as sessions run. Each finding links back to the relevant feature row above.

| Date | Persona | Focus area | Finding | Severity | Feature(s) |
|---|---|---|---|---|---|
| 2026-04-19 | (harness) | Command registration | **54** `ai-organiser:*` commands registered vs **~36** leaves in picker — 18 palette-only commands (7 highlight colours, tag network, manage index, quick-add × 2 variants, metadata upgrade × 2, ensure-structure, collect-all-tags, drop-selection-pending). Is every palette-only command discoverable enough? | P2 | Command registration |
| 2026-04-19 | (harness) | Palette search UX | Every command is prefixed "AI Organiser:" — typing "AI organiser" matches all 54. User who knows feature name doesn't need prefix; user who doesn't gets a 54-item list. Obsidian prefixes with manifest name, not tweakable per-command. | P2 | Command palette |
| 2026-04-19 | (harness) | Command tree interaction | ArrowDown + Enter on a group header ran the first sub-item rather than expanding the group. Either the tree is keyboard-hostile, or Enter-on-group is deliberate "open first" behaviour. Needs persona confirmation — could be surprising. | P2 | Command Picker |
| 2026-04-19 | Maya (student) | Smart Summarize on Test URL.md | **Reclassified 2026-04-19** from P0 to harness artefact: follow-up manual testing by the user confirmed the plugin flow works end-to-end and produces the structured summary preview modal as expected. The "silent failure" was a Playwright/CDP automation gap where modal submit events didn't complete fully — not a plugin bug. Fixes still shipped as defence in depth: preflight config check, conditional URL removal on failure, modal clutter disclosure. | — (harness) | Smart Summarize — flow verified working |
| 2026-04-19 | Maya (student) | Summarize-sources modal layout | 5 empty source-type cards (YouTube / PDF / Office / Audio / Images) plus empty URL-add row push primary CTA below the fold on 1080p. Detected URL card + "Summarize 1 source" button are the only things she needs, but she scrolls past ~400px of irrelevant empty cards to reach the action. | P1 | Smart Summarize modal |
| 2026-04-19 | Maya (student) | Overlap — Capture category | Four sibling commands compete for the same user intent ("I have a URL, give me a summary"): Smart summarize / Quick peek / Web reader / Research. Names don't signal fidelity tier (triage vs brief vs full vs citation-grade). Descriptions only visible on keyboard highlight. Maya guessed correctly by name, but it was guesswork. | P2 | Smart Summarize, Quick Peek, Web Reader, Research |
| 2026-04-19 | Maya (student) | "Include note content" label | Checkbox under "Current note" in summarize modal: label ambiguous when the note IS the URL. Unclear whether checking it adds context, duplicates, or does nothing. | P2 | Smart Summarize modal |
| 2026-04-19 | Maya (student) | Privacy notice (positive) | "Privacy notice" modal before first LLM call was clear, proportionate, once-per-session. No friction beyond one click. | ✓ positive | Privacy consent |
| 2026-04-19 | Dr. Chen (postdoc) | Research Web — source quality scoring | **P0** — asked "what does recent research say about fMRI reliability in cognitive neuroscience" (academic mode on). Got **67 sources / 80 selected**, all on-topic peer-reviewed papers (Botvinik-Nezer multiverse, test-retest reliability, replicability meta-analyses, Nature Communications / PMC / PubMed). BUT **every single source is labelled "Low quality"** except one "Medium". For a domain expert, seeing Nature Communications papers tagged Low quality destroys trust instantly. Either the authority scoring doesn't recognise academic domains, or the label thresholds are miscalibrated. | P0 | Research Web — quality scoring |
| 2026-04-19 | Dr. Chen (postdoc) | Research Web — progress granularity | **P1** — after sending query, UI showed generic "Thinking..." for **150+ seconds** with zero information about which phase was active. Backend was running multi-search + fetching academic sources. Dr. Chen is patient but would still question whether it's stuck at 100s. Phase transitions exist in the code (decomposing → searching → triaging → extracting → synthesizing) but aren't surfaced. | P1 | Research Web — progress UX |
| 2026-04-19 | Dr. Chen (postdoc) | Research Web — Search/Synthesize radio | **P2** — Search and Synthesize radio buttons have no inline description. Persona defaulted to Search (pre-selected) without knowing the difference. For her question she wanted Synthesize with citations. Power user had to guess. | P2 | Research Web — mode selection |
| 2026-04-19 | Dr. Chen (postdoc) | Research Web — sources count phrasing | **P3** — header says "67 sources found · 80 selected". 80 > 67 — phrasing is confusing (maybe the dedup/cross-search accounting makes it technically correct but a reader can't tell). | P3 | Research Web — header |
| 2026-04-19 | Dr. Chen (postdoc) | Research Web — DOI/URL rendering | **P3** — one source link shows `DOI: 10.1038/s41586-020-2314-9&amp=&pmid=32483374` — the `&amp=` suggests a URL encoding / rendering bug. Not fatal but unprofessional for an expert audience. | P3 | Research Web — source rendering |
| 2026-04-19 | Dr. Chen (postdoc) | Research Web — academic sources (positive) | ✓ Sources were genuinely on-topic, cited the right papers (Botvinik-Nezer, Carp, Kennedy, test-retest reliability meta-analyses), included DOIs and publication dates, covered both classic and recent literature. Content quality is strong; labelling is the problem. | ✓ positive | Research Web — retrieval quality |
| 2026-04-19 | Pat (exec) | Quick Peek — multi-source, 5 sources | **P1** — time-to-first-useful-output **~45s** for 5 sources (3 URLs + audio + PDF). Pat's patience threshold for fast features is ~30s. For an exec who expects "seconds not minutes", Quick Peek feels like Slow Peek. | P1 | Quick Peek — speed |
| 2026-04-19 | Pat (exec) | Quick Peek — modal auto-scroll | **P2** — modal renders cards as sources complete (good!) but does NOT auto-scroll to reveal new ones. Pat saw 2 cards in viewport; 3 more were below. Scrolling manually (with ArrowRight / End keys) didn't help. | P2 | Quick Peek — modal layout |
| 2026-04-19 | Pat (exec) | Quick Peek — YouTube failure handling | **P2** — one source (YouTube URL) rendered as just "⚠ Extraction failed" with no explanation. Pat would shrug; Dr. Chen would lose trust. Probably Gemini/YouTube specialist provider not configured, but UI doesn't say that. | P2 | Quick Peek — failure surface |
| 2026-04-19 | Pat (exec) | Quick Peek — triage paragraph quality (positive) | ✓ Three successful sources (audio, 2 URLs) produced substantive, decision-supporting triage paragraphs — who-it's-for and what's-inside framing. Exactly what Pat wants. Each card has Summarize / Open / Remove action buttons for next action clarity. | ✓ positive | Quick Peek — content |
| 2026-04-19 | Pat (exec) | Quick Peek — source name visible (positive) | ✓ Unlike Research Web's generic "Thinking...", Quick Peek shows *which* source is being extracted. Progress is narratively meaningful. | ✓ positive | Quick Peek — progress UX |
| 2026-04-19 | Pat (exec) | **Quick Peek — verification re-run** | ✓ After fix: 5 sources triaged in ~15s (vs ~45s+ before). "N/M done" counter visible throughout. Incremental card rendering — each card replaces its "Triaging…" placeholder as it completes. Cards with extraction failures now show actionable hints. Pat's core complaints addressed. | ✓ verified | Quick Peek — speed, progress, error surface |
| 2026-04-19 | Dr. Chen (postdoc) | **Research Web — verification re-run** | ✓ After fix: same fMRI query now returns **"Medium quality"** on every peer-reviewed source (was uniformly "Low quality"). PubMed / PMC / Nature / ScienceDirect / Wiley / Springer all properly identified. No more instant-trust-loss. Ideally some sources would show "High quality" for top-tier citations — that would need higher relevance signals, a follow-up concern. | ✓ verified | Research Web — quality scoring |
| 2026-04-19 | Maya (student) | **Smart Tag — 2nd session (1886-word transcript)** | ✓ Output quality: 5 relevant kebab-case tags applied (AI, computer-science, claude-skills, workflow-automation, mcp-servers). Clear domain labels she'd actually use for retrieval. Core ask delivered. | ✓ positive | Smart Tag — output quality |
| 2026-04-19 | Maya (student) | Smart Tag — nested scope modals | **P1** — two modals before tagging starts: (1) "Tag notes" with This note / Current folder / Entire vault; (2) "Select folder scope — Choose a root folder to constrain AI suggestions within your organizational structure." Modal 1 = what to tag; modal 2 = where to draw tag taxonomy from. Semantically different questions but persona can't tell — "I already picked This note, why another folder?" Low-patience friction. | P1 | Smart Tag — scope UX |
| 2026-04-19 | Maya (student) | Smart Tag — scope-modal folder count | **P2** — first scope modal shows "Current folder: AI-Organiser/Persona test (0 notes)" but the folder contains 20+ visible test files. Either the count is wrong or semantically narrower than the label suggests (untagged only?). Needs clearer label. | P2 | Smart Tag — scope modal |
| 2026-04-19 | Maya (student) | Smart Tag — bonus AI suggestions modal | **P3 observation** — after tags are applied, an "AI suggestions" modal appears offering (a) a suggested title and (b) a suggested folder, each with independent toggles. Can be perceived positively (power-user feature) or as scope-creep (asked to tag, got offered to rename/relocate). Skip button is clear. Not a bug but a UX design choice to watch. | P3 (mixed) | Smart Tag — post-tag suggestions |
| 2026-04-19 | Maya (student) | Smart Tag — "Analyzing..." toast (positive) | ✓ Unlike Research Web's generic "Thinking...", Smart Tag shows "Analyzing..." as a persistent top-right toast AND populates status bar. Persona knows work is in progress. | ✓ positive | Smart Tag — progress UX |
| 2026-04-19 | Maya (student) | Smart Tag — end-to-end time | **P2** — ~50 seconds from click to tags-applied for a 1886-word note + ~780-note vault taxonomy. For Maya's "student needs it fast" persona, borderline. Could be acceptable if progress was finer-grained. | P2 | Smart Tag — speed |
| 2026-04-19 | Dr. Chen (postdoc) | **Semantic Search — query expansion + RAG** | ✓ Strongest feature tested so far. Query: "AI reasoning and chain-of-thought prompting techniques". Returned 10 ranked results: Chain of Thought (71%), Chain of thought variations (70%), Memory Techniques for Prompting (68%), Google White paper on Prompting (65%), etc. All genuinely relevant. Similarity % visible on every result; full file path (PARA structure: `2 Areas/6 Tech & AI/...`); summary preview from frontmatter; "AI-expanded" label transparent about query enhancement; multi-select + export pattern. | ✓ positive | Semantic Search — output quality |
| 2026-04-19 | Dr. Chen (postdoc) | Semantic Search — modal design (positive) | ✓ Clean modal: title + 1-line purpose statement, text input, "Expand query with AI" checkbox, Search button, helpful bottom hint. No nested scope modals. | ✓ positive | Semantic Search — modal |
| 2026-04-19 | Dr. Chen (postdoc) | Semantic Search — "AI processing..." lingering | **P3** — status-bar "AI processing..." persisted even after search results rendered. Suggests busy-indicator ref-count bug (e.g. didn't decrement on completion, or an unrelated concurrent op is holding it). Minor — the modal itself correctly showed results — but inconsistent UI state. | P3 | Busy indicator |
| 2026-04-19 | Dr. Chen (postdoc) | Semantic Search — speed | **P3** — ~30-45s for semantic search with AI query expansion on a ~780-note vault. Fine for Dr. Chen's patience profile. Could log as a baseline. | P3 | Semantic Search — speed |
| 2026-04-19 | Pat (exec) | **Meeting Minutes — auto-population (positive)** | ✓ Modal auto-detected the 3 PDF embeds in the note (text extracted, char counts shown), auto-detected the MP3 audio file, pre-filled title/date/times/location. Smart default-guessing saves Pat significant data entry. Also offers Terminology Dictionary + Record Audio. | ✓ positive | Meeting Minutes — auto-detection |
| 2026-04-19 | Pat (exec) | Meeting Minutes — form density | **P2** — modal is long and field-heavy. Auto-detected audio + PDFs are below the fold — Pat had to scroll past the main transcript textarea to find them. Low-patience persona sees "fill in meeting title, date, location, agenda, transcript..." before realizing the tool already did it. A "quick-start" path (collapse empty fields, surface detected inputs first) would better serve the persona. | P2 | Meeting Minutes — modal layout |
| 2026-04-19 | Pat (exec) | Meeting Minutes — "Load from vault" transcript picker | **P2** — clicking "Load from vault" next to the Transcript field opened a generic vault-file picker that showed `.md` notes (not filtered). Pat expected to pick her MP3 recording there — but audio has its own section further down. File picker should filter by expected type (transcript text files only) or have a label indicating what it accepts. | P2 | Meeting Minutes — file picker filter |
| 2026-04-19 | Pat (exec) | Meeting Minutes — transcription speed + progress | **P1** — clicked Transcribe on a meeting MP3, waited 100+ seconds with no visible progress other than the status-bar "AI processing..." (same problem as Research Web). For a feature that commonly takes 30s-several minutes on real meetings, Pat NEEDS explicit progress ("Transcribing… 2:30 of 45:00 minutes" or similar). Without it she'd close the modal. | P1 | Meeting Minutes — transcription progress |
| 2026-04-19 | Dr. Chen (postdoc) | **Mermaid Chat — hypothesis-testing flowchart** | ✓ Strong result. Typed "Create a flowchart of the hypothesis testing cycle: observation, hypothesis, experiment, results, theory update". After privacy Proceed, ~29s to rendered diagram: Form Hypothesis → Design Experiment → Collect Results → Results Support Hypothesis? (decision diamond) → Update Theory. Properly colour-coded (green/orange/yellow), correct flowchart grammar. "✓ Diagram updated" confirmation. Action buttons present: Convert to / Copy code / Templates / Export / Save as template / Discard. | ✓ positive | Mermaid Chat — output quality |
| 2026-04-19 | Dr. Chen (postdoc) | Mermaid Chat — modal design (positive) | ✓ Compact modal (not overwhelming like Meeting Minutes). Clear intent. "No diagram detected — describe one to create ☝" status line is helpful. Templates button offers starting points. | ✓ positive | Mermaid Chat — modal |
| 2026-04-19 | Pat (exec) | **Newsletter Fetch — zero-UI one-click** | ✓ Pat's IDEAL interaction: runs as a command, shows "Fetching newsletters..." toast, operates in background, writes digest to configured folder. No modal, no form, no prompts. Total persona-visible interaction: 1 click → done. Today's digest already existed so this was a no-op run but the flow is clear. | ✓ positive | Newsletter Fetch — interaction model |
| 2026-04-19 | Maya (student) | Flashcards — modal design (positive) | ✓ Clean compact modal: Source / Card style / Export format / optional context fields. Much more restrained than Smart Tag's two-modal scope picker. Generate button prominent. | ✓ positive | Flashcards — modal |
| 2026-04-19 | Maya (student) | Flashcards — generation time + silent long-running | **P2** — after clicking Generate, process ran for 100+ seconds with status-bar "AI processing..." indicator only. Same pattern as Smart Tag/Research Web. Full-note flashcard generation is inherently expensive (many Q&A pairs to craft) but the user gets no progress context. Could show "Generating card 3 of 15..." if streaming per-card, or at least phase labels. | P2 | Flashcards — progress |
| 2026-04-19 | Maya (student) | **Presentation Chat — slides mode** | **P1** — same "Thinking..." gap as Research Web (pre-fix). Sat for 2+ minutes on a 5-slide request with only generic "Thinking..." indicator. The phase-progress fix I shipped for Research Web needs to extend to Slides mode (same UnifiedChatModal, different handler). | P1 | Presentation Chat — progress |
| 2026-04-19 | Maya (student) | Presentation Chat — modal design (positive) | ✓ Clean UI: tab-based mode picker, On-brand toggle, Polish iterate button, Export PPTX / Export HTML / Export / Project dropdown. Clear bot greeting explaining what happens. | ✓ positive | Presentation Chat — modal |
| 2026-04-19 | Dr. Chen (postdoc) | **Digitise Image** | ✓ Strong result. ~19s end-to-end. Clean "Digitisation preview" modal with source image + extracted content side-by-side. OCR accurate, preserved structure (headings, bullets, point values like "97-100 POINTS"). Clear action buttons: Discard / Copy to clipboard / Insert Below. | ✓ positive | Digitise Image |
| 2026-04-19 | Dr. Chen (postdoc) | **Canvas — Investigation Board** | ✓ Works. ~80+s. Generated a canvas with multiple note nodes connected by relationships (Test PDFs, Image Collection, Sketch-based, etc.). The canvas rendered correctly in a new tab. | ✓ positive (with P2 on speed + progress) | Canvas — Investigation Board |
| 2026-04-19 | Dr. Chen (postdoc) | Canvas — folder picker modal (positive) | ✓ Before generation, a "Save canvas — Choose where to save the canvas" modal picks the output folder. Simple list + search. No surprise on save location. | ✓ positive | Canvas — save modal |
| 2026-04-19 | Dr. Chen (postdoc) | Canvas — progress during generation | **P2** — 80+s with only "AI processing..." indicator. Investigation Board does a semantic search + edge labelling via LLM — those phases could be surfaced ("Finding related notes… / Labelling edges…"). | P2 | Canvas — progress |

---

## 5. Proposed changes

Queue of concrete UX changes emerging from the findings above. Each item: what, why, which persona surfaced it.

| # | Proposal | Rationale | Sourced from | Status |
|---|---|---|---|---|
| 1 | Smart Summarize defensive fixes — preflight `checkMainProviderConfigured()` before destructive actions, conditional URL removal (only on insert success), 10s auth-error notice | Maya session 1 root cause turned out to be automation-only; real plugin path healthy. Fixes remain as defence in depth. | Maya session 1 P0 → reclassified | ✅ Shipped 2026-04-19 |
| 2 | Collapse empty source-type cards in summarize-sources modal behind a "+ Add other sources" disclosure | Low-patience persona scrolled past 400px of empty UI. | Maya session 1 P1 | ✅ Shipped 2026-04-19 (verified) |
| 5 | Expand `AUTHORITY_TIERS` with academic domains (50+ added: `pmc.ncbi.nlm.nih.gov`, `sciencedirect`, `wiley`, `springer`, `plos`, `frontiersin`, etc.); raise uncited-but-retrieved baseline from `0.1 → 0.5` in `assignCitationScores` | Dr. Chen P0: Nature Communications papers labelled "Low quality". Instant trust-loss for a power-user persona. | Dr. Chen session 1 P0 | ✅ Shipped 2026-04-19 (verified: all Medium now) |
| 10 | Quick Peek — N/M counter header + incremental card rendering (placeholder "Triaging…" replaced in-place as each source completes) + modal cards already `max-height: 60vh` with scroll | Pat saw 2 of 5 cards, didn't realise 3 more existed. | Pat session 1 P2 | ✅ Shipped 2026-04-19 (verified) |
| 11 | Quick Peek — parallelise source triage via `Promise.all`; per-source completion callback so UI updates as each finishes | Pat's patience maxes at 30s. Serial took ~45s for 5 sources. | Pat session 1 P1 | ✅ Shipped 2026-04-19 (verified: ~15s for 5 sources) |
| 12 | Quick Peek — `getExtractionFailureHint()` shows contextual guidance (YouTube → Gemini key, audio → OpenAI/Groq key) when extraction fails and the relevant specialist provider isn't configured | Bare "⚠ Extraction failed" dead-ends the user. | Pat session 1 P2 | ✅ Shipped 2026-04-19 (not triggered in verification run because Gemini key IS configured) |
| 6 | **Surface Research phase transitions in chat** — replace generic "Thinking..." with live phase status: "Decomposing → Searching (2/5) → Extracting → Synthesizing". Orchestrator already has phase state; just needs to bubble to the chat placeholder | Dr. Chen waited 150+s for fMRI query with zero progress signal. Patient but questioned whether stuck. | Dr. Chen session 1 P1 | ⏳ Deferred — P1 |
| 7 | Research phase-stepper affordance rework — the dots next to "Search" / "Synthesize" visually read as radio buttons. Either add a "Progress:" label, use arrows/connectors between phases, or restyle the dots so they don't look selectable | Persona read the phase stepper as radios that she should pick between. Affordance, not label. | Dr. Chen session 1 P2 (reclassified) | ⏳ Deferred — P2 |
| 8 | Fix "67 sources found · 80 selected" header math. Either show honest dedup counts ("67 unique sources, 80 total citations across N searches") or simplify to a single metric | Apparent arithmetic error (selected > found) undermines perceived rigour. | Dr. Chen session 1 P3 | ⏳ Deferred — P3 |
| 9 | Fix URL/DOI rendering artefact — `&amp=` seen on Google Scholar DOI links in Research source list | Looks unprofessional to academic users. | Dr. Chen session 1 P3 | ⏳ Deferred — P3 |
| 3 | Command picker — make descriptions visible on first paint (not only on keyboard highlight) for the Capture category where multiple commands sound similar; OR rename to signal fidelity tier (e.g. "Triage (Quick Peek)" / "Brief (Smart Summarize)" / "Research (with citations)") | Four overlapping commands; guess-by-name is fragile. | Maya session 1 P2 | ⏳ Deferred — P2 |
| 4 | Clarify "Include note content" checkbox — tooltip or inline label explaining behaviour when the note body IS the URL target | Persona unsure whether checking adds context, duplicates, or does nothing. | Maya session 1 P2 | ⏳ Deferred — P2 |

**Deferred summary (to revisit after round 2):** 1 P1, 3 P2, 2 P3.

### Round 2 findings — new proposals

| # | Proposal | Rationale | Sourced from | Status |
|---|---|---|---|---|
| 13 | Smart Tag — merge the two scope modals (target scope + taxonomy scope) into one modal with clear sections, or add a subtitle to the second explaining "your existing tag vocabulary will come from this folder" | Two nested scope modals confused Maya; she asked "why another folder?" | Maya session 5 P1 | ⏳ Deferred — P1 |
| 14 | Smart Tag — first scope modal shows "(0 notes)" for a folder with 20+ notes. Either fix the count or clarify what it means (e.g. "0 untagged notes in this folder"). | Count is either wrong or semantically narrower than label suggests. | Maya session 5 P2 | ⏳ Deferred — P2 |
| 15 | Extend progress-phase pattern to Research Web + Meeting Minutes transcription. Both show only "Thinking..." / "AI processing..." for long operations (100+ sec) that have internal phase state available. Quick Peek's per-source counter is the template to follow. | Universal persona complaint across three features. | Dr. Chen sessions 1+3, Pat session 3 P1 | ⏳ Deferred — P1 (highest leverage cross-cutting fix) |
| 16 | Busy-indicator ref-count — status-bar "AI processing..." persisted after Dr. Chen's semantic search completed. Suggests a decrement bug in `busyIndicator.ts` (possibly an unawaited promise or ref never released). | Dr. Chen session 3 P3. | Dr. Chen session 3 P3 | ⏳ Deferred — P3 |
| 17 | Meeting Minutes — re-order modal to surface auto-detected inputs (audio + context docs) ABOVE the transcript textarea. Currently Pat had to scroll past empty Transcript field before realising the audio was already detected below. | Pat session 3 P2. | Pat session 3 P2 | ⏳ Deferred — P2 |
| 18 | Meeting Minutes — "Load from vault" button next to Transcript opens an unfiltered vault file picker. Filter to `.txt`/`.md` or label the button "Load transcript text" so it's clear this isn't for audio. | Pat expected to pick her MP3 from this button. | Pat session 3 P2 | ⏳ Deferred — P2 |

---

## 6. Cross-persona patterns

### Round 1 (Smart Summarize, Research Web, Quick Peek)

Three sessions, three personas, five different AI features exercised (Smart Summarize, Research Web, Quick Peek). A few patterns jump out:

**Progress UX**: the plugin's "AI processing..." status-bar indicator is too subtle and too uninformative. Every persona hit long waits (Smart Summarize ~30s, Research ~150s, Quick Peek ~45s+ for 5 sources) and every persona wanted more granularity. The code knows which phase is running (decompose / fetch / search / extract / synthesize / per-source triage) — it just doesn't surface that to the UI. Fixing the signal, not the speed, would help all three personas.

**Progressive rendering works** where it exists. Quick Peek renders cards as sources complete — Pat liked it. Smart Summarize shows a final preview modal — Maya was OK with it once it arrived. Research Web goes from input straight to final answer — Dr. Chen suffered the most wait. Extending Quick Peek's "render as you go" pattern to Research Web would be high-leverage.

**Configuration surfaces**: when something is misconfigured or fails, the messages are generic. "Extraction failed" (Pat, YouTube). "Summarization failed" (Maya, on the original silent-fail path). "Low quality" label on Nature Comm (Dr. Chen). Each persona bounces off the opaqueness differently. Actionable error messages with "Settings → …" links would catch all three.

**Overlapping entry points are still suspicious**: Maya guessed correctly between Smart Summarize / Quick Peek / Web Reader / Research. We haven't actually tested whether that guess holds across personas with different intents. Dr. Chen went straight to Research; Pat went straight to Quick Peek. Neither considered the alternatives. Worth revisiting in round 2.

### Round 2 (Smart Tag, Semantic Search, Meeting Minutes)

Round 2 exercised broader features; three patterns strengthened:

**Progress-phase gap is the single largest cross-cutting issue.** Maya/Smart Tag (~50s), Dr. Chen/Research Web (~150s+), Pat/Meeting Minutes transcription (100+s) — all long operations, all showing only the generic "AI processing..." status-bar indicator. Quick Peek's counter/card pattern (already fixed) is the template; extending it to every long-running feature would improve every persona. This is now Proposal #15 and is the highest-leverage cross-cutting fix.

**Auto-detection is a huge quiet win where it appears.** Smart Summarize auto-detected the URL; Meeting Minutes auto-detected PDFs *and* the MP3 audio *and* filled meeting metadata. The problem in both is form layout — the auto-detected items are buried below fold. Surfacing detected inputs ABOVE the empty-field labels would better reward the smart behaviour.

**Semantic Search is the strongest feature tested so far.** Dr. Chen's ruthless standards: all met. Similarity percentages visible, file paths shown, "AI-expanded" label transparent, query-expansion toggle configurable. If Research Web adopted this modal's design patterns (transparency + provenance + multi-select export), the round-1 P0 would have been much less severe.

### Cross-round themes

| Theme | Affected features | Status |
|---|---|---|
| Progress-phase granularity | Smart Summarize, Smart Tag, Research Web, Meeting Minutes transcription, Flashcards | Quick Peek ✓; Research Web chat placeholder ✓ (2026-04-19); cross-cutting work still needed for Minutes transcription (#17) + Flashcards progress + Smart Tag |
| Form density / auto-detection placement | Smart Summarize modal, Meeting Minutes modal | Smart Summarize fixed (#2); Meeting Minutes layout needs rework (#17) |
| Config-vs-extraction error clarity | Quick Peek (YouTube), Smart Summarize (missing key) | Quick Peek hint added (#12); pattern worth extending |
| Scope / taxonomy modal design | Smart Tag | Needs single-modal merge or clearer copy (#13) |
| Multi-select + export + provenance | Semantic Search ✓, Research Web, Quick Peek | Semantic Search is the template to emulate |
| Zero-UI command pattern (1 click → done) | Newsletter Fetch ✓ | Strong exemplar — no modal, toast progress, background op. Replicate for other "just run it" features |

### Round 4 (Presentation Chat, Digitise Image, Canvas Investigation Board)

Round 4 adds three more positive-verdict features and confirms where the phase-progress fix needs to extend next:

- **Digitise Image** — ~19s, high-accuracy OCR with structure preservation, clean preview modal. Another standalone positive feature.
- **Canvas Investigation Board** — works, generates a proper relational canvas. ~80s wait is the trade-off (semantic search + edge labelling). Progress granularity gap same as everywhere else.
- **Presentation Chat** — Slides mode is the sibling of Research mode and has the identical "Thinking..." placeholder problem that I just fixed for Research. The fix should extend to the Presentation handler (same UnifiedChatModal, same ChatModeHandler interface; add `setPhase`-equivalent bubbling).

### Round 3 (Mermaid Chat, Flashcards, Newsletter Fetch)

Round 3 exercised three different features — one per persona. Three patterns emerged:

**Three more positive features added to the catalogue.** Mermaid Chat, Flashcards, Newsletter Fetch all work cleanly. Mermaid Chat in particular is one of the strongest features — fast (29s), high-quality diagram output, compact modal, full action suite (Convert/Copy/Templates/Export).

**Newsletter Fetch is the cleanest interaction pattern in the whole plugin.** One click → toast → done, no modal. Pat (low-patience exec) would use this daily. It's a template worth emulating for anything that doesn't need per-operation parameters.

**Flashcards reinforces the progress-granularity issue.** 100+s with just "AI processing..." indicator is Maya's same complaint from Smart Tag. Same root cause, same fix pattern needed.

### Roll-up after 9 sessions across 9 features

**Positive features (high confidence ready for users):**
- Semantic Search — transparency, multi-select, AI-expanded label
- Mermaid Chat — compact, fast, high-quality output
- Newsletter Fetch — zero-UI, background, toast
- Quick Peek (post-fix) — parallel, counter, incremental cards

**Works-but-friction features (need targeted fixes):**
- Smart Summarize (post-fix, verified) — modal clutter fixed
- Research Web (post-fix, verified) — phase progress now visible; quality labels fixed; still deferred: affordance + header count
- Smart Tag (post-fix) — single scope modal; phased progress
- Flashcards (post-fix) — phased progress across all 3 code paths
- Meeting Minutes (post-fix) — dedicated progress panel for transcription
- Presentation Chat — same "Thinking..." gap as Research was; phase progress should extend
- Canvas Investigation Board — 80s with opaque indicator

## Methodology

- Personas stored in `scripts/persona-harness/personas.json` (Maya, Dr. Chen, Pat)
- Test substrate: `C:\obsidian\Second Brain\AI-Organiser\Persona test\` — pre-populated notes covering URL, YouTube, PDF, Minutes, Translate, Multi-source, Vision, Cluster Board
- Driver: `scripts/persona-harness/driver.mjs` (Playwright + CDP attach)
- One persona × one focus area per session; short sessions (8-12 actions) following the `/persona-test` skill's Plan → Act → Reflect format
- Findings logged verbatim to §4 before interpretation — avoid rewriting persona voice
- Severities: P0 blocker, P1 major friction, P2 minor friction, P3 polish
- Any P0/P1 fix should bump tests and redeploy before the next session so personas test current code
