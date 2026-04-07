# Plan: Presentation Engine V2 — Competitive Improvements

- **Date**: 2026-04-07
- **Status**: Draft
- **Author**: Claude + Louis

---

## 1. Current UI Audit

### What exists today

The presentation engine lives in the UnifiedChatModal's "slides" mode. The architecture is:

| Component | File | LOC | Role |
|-----------|------|-----|------|
| State machine & UI | `PresentationModeHandler.ts` | ~660 | Generation, refinement, export, version history |
| LLM orchestration | `presentationHtmlService.ts` | ~200 | `runHtmlTask()` → extract → validate → wrap |
| Data models | `presentationTypes.ts` | ~204 | Phases, versions, quality scoring, slide info |
| Prompts & extraction | `presentationChatPrompts.ts` | ~252 | System/user prompts, HTML extraction, validation |
| Iframe preview | `SlideIframePreview.ts` | ~345 | Render, navigate, scale, quality badge, DOM fixes |
| Brand theme | `brandThemeService.ts` | ~415 | Parse brand markdown, generate CSS, 80+ icons |
| Constants | `presentationConstants.ts` | ~38 | Geometry, timeouts, class names |

**Generation flow**: User prompt → `summarizeText()` (blocking, 45s timeout) → `extractHtmlFromResponse()` (regex cascade) → `validateDeckHtml()` (regex blacklist) → `wrapInDocument()` → iframe `srcdoc` → quality check → optional brand audit.

**Preview**: Direct `iframe.contentDocument` access (same-origin sandbox). Single-slide view via `.pres-nav-hidden` class toggle. External keyboard nav on wrapper element.

**Export**: dom-to-pptx (dynamic import) or HTML file to vault.

### Design language

- CSS prefix: `ai-organiser-pres-*`
- Quality badge: color-mix green/yellow/red pills
- Navigation: borderless buttons with disabled opacity
- Typography: 12px for chrome, Obsidian theme variables throughout
- Layout: flex column with 8px gaps

### Pain points identified

1. **45-second blank wait** during generation — no progress indicator beyond "Generating slides..."
2. **Regex-based sanitization** — blacklist strips known-bad tags but misses encoded variants
3. **Binary quality signal** — score 0-100 doesn't tell user if the deck is usable or broken
4. **Fragile HTML extraction** — 4-step regex cascade fails on edge cases (nested fences, partial HTML)
5. **No in-iframe interaction** — keyboard only works when wrapper is focused, not when clicking inside iframe
6. **No speaker notes visibility** — notes exist in HTML but are `display: none` with no toggle

---

## 2. User Flow & Wireframe

### Generation flow (current → improved)

```
CURRENT:
  User types → "Generating slides..." (45s) → Full deck appears → Navigate slides

IMPROVED:
  User types → Slides stream in progressively (800ms debounce) → Deck assembles live
             → Reliability badge appears → Background quality scan starts
             → Quality findings appear asynchronously
```

### Preview state transitions

```
┌─────────┐    setHtml('')     ┌──────┐
│streaming│──────────────────→│ idle │
│(new)    │    stream ends     │      │
└────┬────┘                    └──────┘
     │ checkpoint                 ↑
     │ (800ms debounce)           │ dispose/clear
     ↓                           │
┌─────────┐    final HTML     ┌──────────────┐
│ partial │──────────────────→│ ready        │
│         │                   │ + reliability │
└─────────┘                   └──────────────┘
```

### Reliability badge wireframe

```
┌──────────────────────────────────────┐
│  ┌─────────────────────────────────┐ │
│  │          SLIDE PREVIEW          │ │
│  └─────────────────────────────────┘ │
│  ◀  3 / 8  ▶    [✓ OK]  Quality: 85 │  ← reliability + quality side by side
│                                      │
│  [⚠ 2 findings]  ▸ Details          │  ← collapsible findings
└──────────────────────────────────────┘
```

---

## 3. UX Design Decisions

### Streaming preview (Principles: #11 Feedback, #24 Performance Perception, #1 Nielsen)

Users see slides building in real-time instead of a 45-second void. The 800ms debounce prevents flicker while keeping the preview responsive. Partial HTML is rendered as soon as a valid `</section>` is detected, giving immediate visual feedback.

### Reliability classification (Principles: #23 State Coverage, #17 Visual Hierarchy)

Four tiers replace the opaque 0-100 score:

| Tier | Badge | Meaning | Action |
|------|-------|---------|--------|
| `ok` | ✓ green | Clean deck, ready to export | None needed |
| `warning` | ⚠ yellow | Minor issues, usable | Optional refinement |
| `structurally-damaged` | ✕ orange | Layout broken, needs regeneration | Suggest regenerate |
| `unreliable` | ✕✕ red | Parse failed or >50 sanitizer rejections | Force regenerate |

Users get an immediate signal about whether to iterate or start over — recognition over recall (#14).

### HTML markers (Principle: #12 Error Prevention)

Explicit `---HTML_START---` / `---HTML_END---` markers eliminate ambiguity in extraction. The LLM is instructed to use them; the parser falls back to current regex cascade if markers are absent (backward compatibility).

### Allowlist sanitization (Principle: #37 CSP Compliance)

Switching from regex blacklist to tag/attribute allowlist eliminates encoding bypass vulnerabilities. CSP meta tag injection provides defence-in-depth.

### 2-pass quality review (Principles: #11 Feedback, #13 Progressive Disclosure)

Pass 1 (fast, deterministic + cheap LLM) runs in the background immediately after generation. Results appear as a collapsible findings panel. Pass 2 (deeper model) is optional and user-triggered. Findings don't block the user — they can export immediately and address issues if they choose.

### postMessage protocol (Principles: #28 Modularity, #32 State Locality)

Decouples iframe state from parent state. The iframe owns its own navigation, the parent sends commands. This enables the injected slide runtime to handle keyboard events natively.

### Injected slide runtime (Principles: #19 Keyboard Navigation, #25 Responsive)

A ~2KB script injected into the iframe handles arrow key navigation, speaker notes toggle (N key), and print layout. This means keyboard works whether focus is on the wrapper or inside the iframe.

---

## 4. Technical Architecture

### Phase 1: Streaming Preview + HTML Markers (HIGH)

```
PresentationModeHandler
  │
  ├─→ presentationHtmlService.generateHtmlStream()    ← NEW streaming entry point
  │     │
  │     ├─→ summarizeTextStream(prompt, onChunk)      ← existing streaming API
  │     │
  │     ├─→ StreamingHtmlAssembler                    ← NEW: accumulates chunks
  │     │     ├── detectMarkers()                     ← ---HTML_START--- / ---HTML_END---
  │     │     ├── extractCheckpoint()                 ← valid partial HTML at </section> boundaries
  │     │     └── getReliability()                    ← tracks sanitizer rejections
  │     │
  │     └─→ onCheckpoint(partialHtml) callback        ← debounced at 800ms
  │
  └─→ SlideIframePreview
        ├── setHtml(html)                             ← existing, called per checkpoint
        ├── setStreaming(active: boolean)              ← NEW: shows streaming indicator
        └── setReliability(tier)                       ← NEW: updates reliability badge
```

### Phase 2: Allowlist Sanitization + CSP (HIGH)

```
presentationSanitizer.ts                              ← NEW file
  ├── sanitizeHtml(raw) → { html, rejectionCount }
  │     ├── ALLOWED_TAGS: Set<string>                  ← section, div, span, h1-6, p, ul, ol, li, etc.
  │     ├── ALLOWED_ATTRS: Map<tag, Set<attr>>         ← data-*, class, id, style (no on*)
  │     ├── BLOCKED_URL_SCHEMES: Set                   ← javascript:, data: (except images)
  │     └── injectCSP(doc) → adds <meta> CSP tag
  │
  └── replaces validateDeckHtml() regex approach
```

### Phase 3: Reliability Classification (MEDIUM)

```
presentationTypes.ts additions:
  ├── ReliabilityTier = 'ok' | 'warning' | 'structurally-damaged' | 'unreliable'
  ├── classifyReliability(slides, rejectionCount, parseTimedOut) → ReliabilityTier
  └── RELIABILITY_THRESHOLDS (constants)

SlideIframePreview additions:
  └── renderReliabilityBadge(tier) → colored pill next to quality badge
```

### Phase 4: 2-Pass Async Quality Review (MEDIUM)

```
presentationQualityService.ts                         ← NEW file
  ├── runFastScan(html, signal)                       ← Haiku: color, typography, overflow, density
  │     ├── Token budget: 4096
  │     ├── Categories: colour, typography, overflow, density, gestalt, consistency
  │     └── Returns: QualityFinding[]
  │
  ├── runDeepScan(html, signal)                       ← Main model: spatial, contrast, alignment
  │     ├── Token budget: 8192
  │     ├── Only runs if Pass 1 succeeded
  │     └── Returns: QualityFinding[] (merged, Pass 2 takes precedence)
  │
  ├── deduplicateFindings(pass1, pass2)               ← key: slideIndex:category:msg[:80]
  │
  └── sampleLargeDeck(slides)                         ← stratified: first 10, random mid, random end
```

### Phase 5: postMessage Protocol (LOW)

```
SlideIframePreview (parent side):
  ├── sendMessage(action, payload)                    ← postMessage to iframe
  ├── onMessage(handler)                              ← addEventListener('message')
  └── Protocol:
        Parent → Iframe: { action: 'goToSlide', index }
                         { action: 'toggleNotes' }
        Iframe → Parent: { action: 'slideChanged', index, slideCount }
                         { action: 'ready' }
                         { action: 'error', error }

slideRuntime.ts (injected into iframe):               ← NEW file
  ├── Keyboard: ArrowLeft/Right, Home/End, N (notes)
  ├── Navigation: show/hide slides, update counter
  ├── Print: forces display:block on all slides
  └── postMessage to parent on slide change
```

### Phase 6: Injected Slide Runtime (LOW)

```
slideRuntime.ts → bundled as string constant
  ├── ~2KB minified, injected via <script> in wrapInDocument()
  ├── Keyboard navigation (arrows, Home, End)
  ├── Speaker notes toggle (N key)
  ├── Canonical selector: section[data-slide] || .slide || section
  └── Print @media support
```

---

## 5. State Map

### SlideIframePreview — Extended States

| State | Visual | User action | Transition |
|-------|--------|-------------|------------|
| `idle` | Empty container | — | → `streaming` (generation starts) |
| `streaming` | Partial slides + pulsing indicator | Wait / cancel | → `loading` (stream ends) |
| `loading` | "Loading preview..." | Wait | → `ready` / `empty` / `error` |
| `ready` | Full slides + nav + badges | Navigate, export | → `streaming` (refine) |
| `empty` | "No slides found" | Edit prompt | → `streaming` |
| `error` | Error message | Retry | → `streaming` |

### Reliability Badge — States

| Tier | Visual | Condition |
|------|--------|-----------|
| `ok` | `✓` green pill | 0 rejections, slides parsed, no timeout |
| `warning` | `⚠` yellow pill | 1-10 rejections, structure intact |
| `structurally-damaged` | `✕` orange pill | Missing `.deck` or `.slide`, or >10 rejections |
| `unreliable` | `✕✕` red pill | DOM parse timeout (>3s) or >50 rejections |

### Quality Review — Async States

| State | Visual | Trigger |
|-------|--------|---------|
| Not started | No findings panel | — |
| Pass 1 running | Spinner in findings header | Auto after generation |
| Pass 1 complete | Findings list (collapsible) | — |
| Pass 2 running | "Deep scan..." spinner | User-triggered or auto |
| Pass 2 complete | Merged findings list | — |
| Error | "Quality scan unavailable" | LLM failure |

---

## 6. File-Level Plan

### Phase 1: Streaming Preview + HTML Markers

| File | Action | Key changes |
|------|--------|-------------|
| `src/services/chat/streamingHtmlAssembler.ts` | **NEW** | Accumulates LLM chunks, detects markers, extracts checkpoints at `</section>` boundaries, tracks sanitizer rejections |
| `src/services/chat/presentationHtmlService.ts` | MODIFY | Add `generateHtmlStream()` using `summarizeTextStream()` + `StreamingHtmlAssembler` + debounced checkpoint callback |
| `src/ui/chat/PresentationModeHandler.ts` | MODIFY | Call `generateHtmlStream()` instead of `generateHtml()`, pass checkpoint callback that updates preview |
| `src/ui/components/SlideIframePreview.ts` | MODIFY | Add `setStreaming(active)` for pulsing indicator, handle rapid `setHtml()` calls during streaming |
| `src/services/prompts/presentationChatPrompts.ts` | MODIFY | Add `---HTML_START---` / `---HTML_END---` markers to system prompt output format instructions |
| `src/services/chat/presentationConstants.ts` | MODIFY | Add `STREAM_RENDER_DEBOUNCE_MS = 800`, `HTML_START_MARKER`, `HTML_END_MARKER` |
| `styles.css` | MODIFY | Add `.ai-organiser-pres-streaming-indicator` pulse animation |
| `src/i18n/en.ts` | MODIFY | Add streaming status strings |
| `src/i18n/zh-cn.ts` | MODIFY | Add Chinese translations |

**Tests:**
- `tests/streamingHtmlAssembler.test.ts` — **NEW**: marker detection, checkpoint extraction, partial HTML handling, rejection counting
- `tests/presentationHtmlService.test.ts` — update: streaming generation tests
- `tests/presentationChatPrompts.test.ts` — update: marker presence in system prompt

### Phase 2: Allowlist Sanitization + CSP

| File | Action | Key changes |
|------|--------|-------------|
| `src/services/chat/presentationSanitizer.ts` | **NEW** | `sanitizePresentation()`: DOMParser-based allowlist sanitizer, CSP injection, rejection counting |
| `src/services/prompts/presentationChatPrompts.ts` | MODIFY | Replace `validateDeckHtml()` regex with call to `sanitizePresentation()` |
| `src/services/chat/presentationHtmlService.ts` | MODIFY | Use new sanitizer in `runHtmlTask()` pipeline |
| `src/services/chat/presentationConstants.ts` | MODIFY | Add `ALLOWED_TAGS`, `ALLOWED_ATTRS`, `MAX_SANITIZER_REJECTIONS = 50`, `DOM_PARSE_TIMEOUT_MS = 3000` |

**Tests:**
- `tests/presentationSanitizer.test.ts` — **NEW**: allowlist enforcement, encoding bypass resistance, CSP injection, rejection counting, edge cases (empty, malformed, huge)

### Phase 3: Reliability Classification

| File | Action | Key changes |
|------|--------|-------------|
| `src/services/chat/presentationTypes.ts` | MODIFY | Add `ReliabilityTier` type, `classifyReliability()` function, thresholds |
| `src/ui/components/SlideIframePreview.ts` | MODIFY | Add `setReliability(tier)`, render reliability pill next to quality badge |
| `src/services/chat/presentationHtmlService.ts` | MODIFY | Return rejection count and parse status from `runHtmlTask()` |
| `src/ui/chat/PresentationModeHandler.ts` | MODIFY | Pass reliability to preview after generation |
| `styles.css` | MODIFY | Add `.ai-organiser-pres-reliability-*` badge styles (4 tiers) |
| `src/i18n/en.ts` | MODIFY | Add reliability tier labels |
| `src/i18n/zh-cn.ts` | MODIFY | Add Chinese translations |

**Tests:**
- `tests/presentationTypes.test.ts` — update: `classifyReliability()` tier boundaries, edge cases

### Phase 4: 2-Pass Async Quality Review

| File | Action | Key changes |
|------|--------|-------------|
| `src/services/chat/presentationQualityService.ts` | **NEW** | `runFastScan()` (Haiku), `runDeepScan()` (main model), `deduplicateFindings()`, `sampleLargeDeck()` |
| `src/services/prompts/presentationQualityPrompts.ts` | **NEW** | Fast scan and deep scan prompt builders |
| `src/ui/chat/PresentationModeHandler.ts` | MODIFY | Launch background quality scan after generation, render async findings |
| `src/ui/components/SlideIframePreview.ts` | MODIFY | Add findings panel with async loading state |
| `src/services/chat/presentationConstants.ts` | MODIFY | Add `FAST_SCAN_TOKEN_BUDGET = 4096`, `DEEP_SCAN_TOKEN_BUDGET = 8192`, `MAX_SLIDES_WARNING = 40`, `SAMPLE_BATCH_MAX_CHARS = 15000` |
| `src/i18n/en.ts` | MODIFY | Add quality scan strings |
| `src/i18n/zh-cn.ts` | MODIFY | Add Chinese translations |

**Tests:**
- `tests/presentationQualityService.test.ts` — **NEW**: fast scan, deep scan, dedup, sampling
- `tests/presentationQualityPrompts.test.ts` — **NEW**: prompt invariants

### Phase 5: postMessage Protocol

| File | Action | Key changes |
|------|--------|-------------|
| `src/ui/components/SlideIframePreview.ts` | MODIFY | Replace direct DOM access with postMessage for navigation commands; add message listener |
| `src/services/chat/presentationConstants.ts` | MODIFY | Add message action types |
| `src/ui/chat/PresentationModeHandler.ts` | MODIFY | Adapt export flow to use message protocol for slide visibility |

**Tests:**
- `tests/SlideIframePreview.test.ts` — **NEW**: postMessage send/receive, protocol validation

### Phase 6: Injected Slide Runtime

| File | Action | Key changes |
|------|--------|-------------|
| `src/services/chat/slideRuntime.ts` | **NEW** | ~2KB runtime string constant: keyboard nav, notes toggle, print support, postMessage to parent |
| `src/services/prompts/presentationChatPrompts.ts` | MODIFY | Inject runtime `<script>` in `wrapInDocument()` |
| `src/services/chat/presentationConstants.ts` | MODIFY | Add `data-slide` as canonical selector alongside `.slide` |

**Tests:**
- `tests/slideRuntime.test.ts` — **NEW**: keyboard event handling, notes toggle, postMessage emission

---

## 7. Risk & Trade-off Register

| Risk | Mitigation | Severity |
|------|-----------|----------|
| Streaming checkpoints render broken HTML | Only render at `</section>` boundaries; validate before render | MEDIUM |
| DOMParser not available in Obsidian mobile | Use regex fallback if DOMParser fails; test on mobile | MEDIUM |
| Allowlist too restrictive — strips valid LLM output | Start with generous allowlist, log rejections, tune | LOW |
| 2-pass quality burns API tokens on every generation | Pass 1 uses cheapest model (Haiku); Pass 2 is opt-in | LOW |
| postMessage origin validation | Check `event.origin` matches iframe srcdoc (null origin for srcdoc) | LOW |
| Slide runtime `<script>` in iframe triggers sanitizer | Inject runtime AFTER sanitization in `wrapInDocument()` | LOW |
| Backward compatibility — old sessions have no reliability | Default to `null` reliability; only compute on new generations | NONE |
| i18n string count growth | ~20 new strings across 6 phases; manageable | NONE |

### Deliberate deferrals

- **Thumbnail strip** — nice UX but significant rendering cost; defer to future
- **Collaborative editing** — requires sync infrastructure; out of scope
- **Template library** — valuable but orthogonal to engine improvements; separate plan
- **Font embedding in PPTX** — complex licensing; defer
- **WCAG contrast validation** — good idea but needs color analysis library; defer

---

## 8. Testing Strategy

### Unit tests (per phase)

| Phase | Test file | Coverage |
|-------|-----------|----------|
| 1 | `streamingHtmlAssembler.test.ts` | Marker detection, checkpoint boundaries, partial HTML, empty stream, abort mid-stream |
| 2 | `presentationSanitizer.test.ts` | Allowlist tags/attrs, encoding bypasses (`&#x6f;nclick`), CSP injection, rejection counting, empty/malformed input |
| 3 | `presentationTypes.test.ts` | Tier classification boundaries (0/1/10/11/50/51 rejections), parse timeout, missing structure |
| 4 | `presentationQualityService.test.ts` | Fast scan parsing, deep scan parsing, dedup logic, sampling for 5/30/50/100 slides |
| 5 | `SlideIframePreview.test.ts` | postMessage send, receive, origin check, unknown action handling |
| 6 | `slideRuntime.test.ts` | Key events, notes toggle, slide boundaries, postMessage emission |

### Manual testing checklist

- [ ] Generate 5-slide deck — verify slides stream in progressively
- [ ] Generate 30+ slide deck — verify sampling and quality scan complete
- [ ] Inject `<script>alert(1)</script>` in prompt — verify sanitizer strips it
- [ ] Inject `<img onerror="alert(1)">` — verify event handler removed
- [ ] Inject `<a href="javascript:void(0)">` — verify URL scheme blocked
- [ ] Check reliability badge shows correct tier for clean/damaged/broken decks
- [ ] Toggle speaker notes with N key inside iframe
- [ ] Arrow key navigation inside iframe (not just wrapper)
- [ ] Export PPTX after streaming generation — verify all slides included
- [ ] Resume persisted session — verify no reliability/quality regression
- [ ] Mobile: verify streaming works on iOS/Android
- [ ] Brand audit + streaming: verify no race condition

### Accessibility testing

- [ ] Keyboard: Tab to preview, arrows to navigate, N for notes
- [ ] Screen reader: Slide change announcements via live region
- [ ] Reduced motion: Streaming indicator respects `prefers-reduced-motion`
- [ ] Contrast: All badge tiers meet WCAG AA (4.5:1)

---

## 9. Implementation Order

Phases are designed for independent, incremental delivery:

```
Phase 1 (Streaming + Markers)     ← Biggest UX win, unblocks Phase 3
  ↓
Phase 2 (Sanitizer)               ← Security fix, unblocks Phase 3
  ↓
Phase 3 (Reliability)             ← Depends on sanitizer rejection count from Phase 2
  ↓
Phase 4 (2-Pass Quality)          ← Independent, can run in parallel with Phase 3
  ↓
Phase 5 (postMessage)             ← Prereq for Phase 6
  ↓
Phase 6 (Slide Runtime)           ← Depends on Phase 5 protocol
```

Estimated new test count: ~120 tests across 6 new test files.
Estimated new/modified files: 12 new, 10 modified.
Estimated i18n strings: ~25 new keys in en.ts + zh-cn.ts.

---

## 10. Audit Remediation (GPT-5.4 Round 1)

**Verdict**: NEEDS_REVISION — H:5 M:4 L:0
**Disposition**: 7 accepted, 2 partially accepted (severity adjusted)

### [H1] ACCEPTED — Missing async lifecycle ownership

**Problem**: Streaming + background quality + cancel creates race conditions without explicit session/abort ownership.

**Remediation**: Add `PresentationGenerationSession` to Phase 1:

```typescript
interface PresentationGenerationSession {
    id: string;                          // unique per generation/refinement
    rootAbort: AbortController;          // parent abort
    streamAbort: AbortController;        // child: streaming LLM call
    sanitizeAbort: AbortController;      // child: final sanitization pass
    fastScanAbort: AbortController;      // child: Phase 4 Haiku scan
    deepScanAbort: AbortController;      // child: Phase 4 deep scan
    phase: 'streaming' | 'sanitizing' | 'scanning' | 'complete' | 'aborted';
}
```

- `PresentationModeHandler` creates a session at generation start, cancels previous session
- Every callback/result checks `session.id` matches current session before mutating state
- `rootAbort.abort()` cascades to all child controllers
- Session ID stored on version entries for traceability

### [H2] ACCEPTED — No canonical deck source of truth

**Problem**: No separation between canonical artifact and ephemeral preview state.

**Remediation**: Add `PresentationSnapshot` to `presentationTypes.ts`:

```typescript
interface PresentationSnapshot {
    sessionId: string;
    html: string;                        // final sanitized HTML
    slides: SlideInfo[];                 // parsed slide model
    reliability: ReliabilityTier;
    rejectionCount: number;
    qualityFindings: QualityFinding[];   // attached after async scan
    brandAuditResult: AuditResult | null;
    timestamp: number;
}
```

- Preview renders from snapshot, never from raw LLM output
- Export reads `snapshot.html`, not iframe DOM (except for dom-to-pptx which needs live DOM)
- Version history stores snapshots, not raw HTML strings
- Streaming partials are ephemeral — only final result becomes a snapshot

### [H3] ACCEPTED — Regex fallback defeats sanitizer purpose

**Problem**: Mobile regex fallback reintroduces the vulnerability the allowlist is meant to fix.

**Remediation**: Remove regex fallback from plan. Instead:

1. **Verify DOMParser availability**: Test on Obsidian mobile (iOS WebKit, Android WebView). DOMParser is available in all modern webviews — Obsidian's minimum is iOS 16+ / Android 9+.
2. **If DOMParser unavailable**: Block presentation generation on that platform with a user-friendly message, don't silently degrade security.
3. **Add to Phase 2 testing**: Explicit mobile DOMParser availability test in manual checklist.

### [H4] PARTIAL → MEDIUM — Iframe sandbox/postMessage security

**Problem**: `srcdoc` null origin is not a trustworthy authenticator; sandbox flags unspecified.

**Remediation**: Specify explicitly in Phase 5:

- **Sandbox flags**: `sandbox="allow-same-origin allow-scripts"` (required for injected runtime)
- **Authentication**: `event.source === iframe.contentWindow` check (not origin), plus per-session nonce in messages
- **Message schema**: `{ nonce: string, action: string, payload: unknown }` — reject messages without matching nonce
- **Severity adjusted** to MEDIUM: `event.source` check is standard practice for same-page iframes; nonce adds defence-in-depth

### [H5] ACCEPTED — Missing persistence/versioning integration

**Problem**: Plan never defines when streaming/reliability/quality enter persisted state.

**Remediation**: Add persistence rules:

| State | Persisted? | Rule |
|-------|-----------|------|
| Streaming partials | NO | Ephemeral, discarded on completion or abort |
| Final snapshot | YES | Committed to version history on generation/refinement completion |
| Reliability tier | YES | Stored on `PresentationSnapshot`, serialised in `PresentationSession` |
| Quality findings | YES | Attached to snapshot after async scan completes, triggers re-save |
| Brand audit result | YES | Attached to snapshot, triggers re-save |
| Session schema | MIGRATE | `schemaVersion: 2` adds `reliability`, `qualityFindings`, `rejectionCount` to versions. Migration: old versions default `reliability: null`, `qualityFindings: []` |

### [M1] ACCEPTED — Style attribute needs CSS property validation

**Problem**: Allowing `style` attribute without property validation is a gap.

**Remediation**: Add CSS property allowlist to Phase 2 sanitizer:

```typescript
const ALLOWED_CSS_PROPERTIES = new Set([
    'color', 'background', 'background-color', 'font-size', 'font-weight',
    'font-family', 'text-align', 'text-decoration', 'line-height',
    'margin', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right',
    'padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right',
    'width', 'height', 'max-width', 'max-height', 'min-width', 'min-height',
    'display', 'flex', 'flex-direction', 'gap', 'align-items', 'justify-content',
    'border', 'border-radius', 'border-color', 'border-width',
    'opacity', 'overflow', 'position', 'top', 'left', 'right', 'bottom',
    'transform', 'transition', 'grid-template-columns', 'grid-gap',
]);
```

- Reject `url()` values in any CSS property
- Reject `expression()`, `behavior:`, `-moz-binding`
- Strip entire `style` attribute if any property fails validation

### [M2] ACCEPTED — Quality service must follow project patterns

**Problem**: New services should use `Result<T>`, XML prompts, Zod validation.

**Remediation**: Phase 4 quality service will:

- Return `Result<QualityFinding[]>` from both scan functions
- Use XML-structured prompts: `<task>`, `<requirements>`, `<output_format>`
- Define `QualityFindingSchema` via Zod for response validation
- Use `logger.debug('Pres', msg)` / `logger.warn()` / `logger.error()` — no console.log
- Finding identity: `{slideIndex}:{ruleId}:{normalizedMsg.slice(0,80)}` — deterministic dedup key

### [M3] ACCEPTED — Checkpoint rendering is too expensive for large decks

**Problem**: Full iframe replacement every 800ms for 50-slide decks is wasteful.

**Remediation**: Smart checkpoint strategy in `StreamingHtmlAssembler`:

1. **Checkpoint trigger**: Only when completed slide count increases (not on every chunk)
2. **Minimum delta**: At least 1 new complete `</section>` since last checkpoint
3. **Lightweight validation**: Count `.slide` classes via regex, don't DOMParse partials
4. **Full sanitization**: Only on final HTML after stream ends
5. **Partial render**: Wrap incomplete HTML in closing tags for valid document, but don't sanitize mid-stream

### [M4] PARTIAL — Structural validation coupled to CSS classes

**Problem**: Reliability uses `.deck`/`.slide` while runtime uses `section[data-slide]`.

**Remediation**: Introduce `DeckParser` as single point of slide detection:

```typescript
// presentationParser.ts — NEW
export function parseSlides(doc: Document): ParsedSlide[] {
    // Priority: section[data-slide] > .slide > bare section
    const selectors = ['section[data-slide]', '.slide', 'section'];
    for (const sel of selectors) {
        const nodes = doc.querySelectorAll(sel);
        if (nodes.length > 0) return Array.from(nodes).map(parseSingleSlide);
    }
    return [];
}
```

- Used by: reliability classification, preview navigation, export preparation, quality scanning
- Markup changes happen in one place
- `extractSlideInfo()` in `presentationTypes.ts` delegates to `DeckParser`
