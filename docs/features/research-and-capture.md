# Research & Content Capture

> Subsystem detail moved out of [AGENTS.md](../../AGENTS.md) so the canonical
> context file stays invariant-sized. AGENTS.md keeps the one-line stub and the
> load-bearing rules; the operational depth lives here.

Pulling new content into the vault: the research assistant and its providers, article triage, fast source peeking, Kindle highlights, and the newsletter digest.

---

## Web Research Assistant

**Status**: Phases 1-3 ✅ Implemented (February 2026)

### Overview

Full-featured research chat mode with web search, smart escalation, usage guardrails, quality scoring, academic mode, vault pre-check, multi-perspective decomposition, and Zotero integration. Three phases: Core MVP, Bright Data Integration, Research Intelligence.

### Architecture

**Pipeline**: User question → LLM query decomposition → multi-provider search → LLM triage scoring → content extraction → LLM synthesis → note insertion

**3-Tier Escalation**: Free `requestUrl` + Readability → Bright Data Web Unlocker → Scraping Browser (CDP/WebSocket), each with user consent

### Core Components

**Research Types** (`src/services/research/researchTypes.ts`):
- `SearchResult`, `SearchProviderType`, `ResearchSessionState`, `PaidTier`, `UsageLedger`, `ResearchBudgetStatus`
- `SourceMetadata`, `CslJsonItem`, `VaultPrecheckResult`, `QualitySignals`

**Research Orchestrator** (`src/services/research/researchOrchestrator.ts`):
- `decomposeQuestion()`: LLM query decomposition with perspective-aware parsing
- `executeSearchCycle()`: Multi-query search → triage → quality scoring → extraction → synthesis
- `precheckVaultContext()`: RAGService integration for vault pre-check advisory
- Session persistence with save/load/clear/expiry

**Research Search Service** (`src/services/research/researchSearchService.ts`):
- Provider orchestrator: Tavily, Bright Data SERP, Claude Web Search adapters
- Multi-query merge with URL dedup via `normalizeUrl()` (from `src/utils/urlUtils.ts`)
- Academic query expansion via `buildAcademicQueries()`
- Provider fallback: If primary returns no results, tries remaining configured providers; `fallbackProviderUsed` flag for UI notice

**Research Mode Handler** (`src/ui/chat/ResearchModeHandler.ts`):
- Phase-based UI: idle → searching → reviewing → extracting → done
- Controls row: provider dropdown, scope dropdown, recency dropdown (Any time / Past week / Past year), academic mode toggle
- Budget warn/block messaging with one-time override
- Quality badges, academic DOI badges, perspective chips
- Vault pre-check 3-button advisory (Use Vault / Continue Web / Always Search Web)
- Zotero send + CSL-JSON copy + Save Findings actions in done phase
- Session persistence includes `dateRange` for recency filter resume

**Research Usage Service** (`src/services/research/researchUsageService.ts`):
- JSON ledger at `AI-Organiser/Config/research-usage.json`
- Per-operation cost tracking by provider/tier
- Warn threshold (default 80%) + hard block (default 100%) with `checkBudget()` convenience
- Month rollover auto-reset, malformed file recovery (.bak backup)

**Source Quality Service** (`src/services/research/sourceQualityService.ts`):
- 5 weighted signals: relevance (0.45), authority (0.20), freshness (0.15), depth (0.10), diversity (0.10)
- Built-in authority profiles for ~25 domains
- Deterministic scoring with explainable signal breakdown

**Academic Utils** (`src/services/research/academicUtils.ts`):
- `ACADEMIC_DOMAINS` exported const — shared by `urlUtils.ts` and query expansion (DRY)
- DOI extraction via regex, author/year parsing from snippets
- Academic query expansion with `site:` scoping for academic domains
- Citation formatting: numeric `[1]` and author-year `(Smith, 2024)`

**URL Utilities** (`src/utils/urlUtils.ts`):
- `normalizeUrl()`: Lowercase host, strip trailing slash, remove tracking params (UTM etc.) for dedup
- `extractDomain()`: Strip `www.` prefix for display
- `classifyUrlSource()`: Classify URL as `'web' | 'youtube' | 'academic' | 'pdf'` using `ACADEMIC_DOMAINS`

**Token Limits** (`src/services/tokenLimits.ts`):
- `PROVIDER_LIMITS`: Per-provider max input/output tokens and chars-per-token
- `MODEL_INPUT_TOKEN_OVERRIDES`: Model-specific input token overrides (e.g., Claude 4.6 → 1M tokens)
- `getMaxContentChars(provider)`: Provider-only budget
- `getMaxContentCharsForModel(provider, model?)`: Model-aware budget (prefers model override when matched)
- `truncateContent()`: Paragraph/sentence-boundary truncation with `[Content truncated...]` suffix

**Zotero Bridge Service** (`src/services/research/zoteroBridgeService.ts`):
- Connector detection via `app.plugins.enabledPlugins`
- CSL-JSON transform with type inference (webpage/article-journal/report)
- HTTP send to `localhost:23119` with clipboard fallback
- Desktop only — disabled+tooltip when connector unavailable, hidden on mobile

**Bright Data Adapters** (`src/services/research/adapters/`, `src/services/research/brightdata/`):
- `brightdataSerpAdapter.ts`: SERP API search with date range support
- `webUnlocker.ts`: Anti-bot bypass for Cloudflare-protected sites
- `scrapingBrowser.ts` + `cdpClient.ts`: CDP/WebSocket for JS-rendered pages

**Research Prompts** (`src/services/prompts/researchPrompts.ts`):
- `buildQueryDecompositionPrompt()`: With `academicMode` and perspective-aware output
- `buildSourceTriagePrompt()`: Score 0-10 relevance assessment
- `buildSourceExtractionPrompt()`: Focused findings extraction
- `buildSynthesisPrompt()`: With `citationStyle` parameter

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `researchProvider` | `'claude-web-search'` | Search provider |
| `enableResearchUsageGuardrails` | `true` | Budget tracking and enforcement |
| `researchMonthlyBudgetUsd` | `10` | Monthly budget limit |
| `researchWarnThresholdPercent` | `80` | Warn at this % of budget |
| `researchBlockAtLimit` | `true` | Hard block at 100% |
| `enableResearchQualityScoring` | `true` | Deterministic quality ranking |
| `researchCitationStyle` | `'numeric'` | Citation format in synthesis |
| `enableResearchVaultPrecheck` | `true` | Check vault before web search |
| `researchVaultPrecheckMinSimilarity` | `0.65` | Min similarity for pre-check |
| `enableResearchPerspectiveQueries` | `true` | Multi-perspective decomposition |
| `researchPerspectivePreset` | `'balanced'` | Perspective preset |
| `enableResearchStreamingSynthesis` | `false` | Streaming synthesis (feature-flagged) |
| `enableResearchZoteroIntegration` | `false` | Zotero integration (feature-flagged) |

### Commands
- `research-web`: In Command Picker → Capture category

### Tests
- `tests/researchOrchestrator.test.ts`: 41 orchestrator tests (pipeline + Phase 3 budget/precheck/perspectives/quality/academic)
- `tests/researchUsageService.test.ts`: 24 usage ledger tests
- `tests/sourceQualityService.test.ts`: 20 quality scoring tests
- `tests/academicUtils.test.ts`: 18 academic utility tests
- `tests/zoteroBridgeService.test.ts`: 22 Zotero bridge tests (CSL-JSON + HTTP)
- `tests/researchPrompts.test.ts`: Prompt invariant tests
- `tests/streamingSynthesis.test.ts`: 76 tests (P2 fixes, adapter streaming, orchestrator streaming, Siliconflow)
- `tests/llmFacadeStream.test.ts`: 6 facade fallback tests (incl. abort guard)
- `scripts/automated-tests.js`: Research command + export integration checks

### Key Patterns
- **Phase-based UI**: Handler manages state machine transitions, action descriptors per phase
- **Budget delegation**: Orchestrator calls `usageService.checkBudget(tier)` — no budget math in orchestrator
- **Perspective fallback**: Structured `{ query, perspective }` JSON with backward-compatible plain `string[]` fallback
- **Vault pre-check**: Advisory only, never blocking. One-per-session guard. "Always Search Web" suppresses for remainder of session
- **Zotero gating**: `enableResearchZoteroIntegration` setting + connector awareness + Platform.isMobile check
- **Streaming synthesis**: SSE via native `fetch()` (not `requestUrl`), adapter-level `supportsStreaming()`/`formatStreamingRequest()`/`parseStreamingChunk()` with shared `BaseAdapter` helpers, `summarizeTextStream` facade with automatic fallback to `summarizeText`, AbortController wired in `ResearchModeHandler.dispose()`
- **Search retry**: `searchWithRetry` wrapper in `researchSearchService.ts` — 1 retry on 429/5xx with 2s delay
- **Provider fallback**: If primary provider returns 0 results, automatically tries remaining providers; `fallbackProviderUsed` flag triggers UI notice
- **Date range filtering**: `dateRange` on `SearchOptions` ('recent'|'year'|'any') — Tavily maps to `days` param (7/365), persisted in session state

**Plan**: [docs/completed/web-research-plan.md](../completed/web-research-plan.md)

## Claude Web Search Provider

**Status**: Phases 1-3 ✅ Implemented (February 2026)

### Overview

Alternative research provider using Anthropic's native web search tool. Replaces the 4-LLM-call pipeline (decompose → search → triage → extract → synthesize) with a single Claude API call that autonomously searches, fetches, filters with code, and synthesizes — with built-in citations.

### Architecture

**Single API Call**: User question → Claude API with `web_search` tool → Claude autonomously searches → fetches → filters → synthesizes → response with native citations + source metadata.

**Provider-Level Integration** (AD-1): Added as a search provider with an orchestrator-level branch, not a pipeline replacement. All existing providers remain fully functional.

### Core Components

**Claude Web Search Adapter** (`src/services/research/adapters/claudeWebSearchAdapter.ts`):
- `searchAndSynthesize()`: Single API call with web search tool, returns `ClaudeWebSearchResponse`
- `searchAndSynthesizeStream()`: SSE streaming with progressive text rendering and `citations_delta` support
- `searchAndSynthesizeMultiTurn()` / `searchAndSynthesizeMultiTurnStream()`: Multi-turn with conversation history
- `continueSearch()`: Auto-continue for `pause_turn` responses (max 3 continuations)
- `parseResponse()`: Extracts search results, citations, synthesis text from response blocks
- `buildToolDefinition()`: Domain filtering — academic takes precedence, mutually exclusive `allowed_domains`/`blocked_domains`
- `buildSystemPrompt()`: Language, citation style (forces author-year for academic mode), perspective instructions
- Tool version auto-detect: `web_search_20260209` (dynamic filtering) for Claude 4.6, `web_search_20250305` (basic) for older models
- Citation-frequency scoring: implicit quality signal from citation counts

**Orchestrator Branch** (`src/services/research/researchOrchestrator.ts`):
- `executeClaudeWebSearch()` / `executeClaudeWebSearchStream()`: Unified pipeline with budget check, `pause_turn` loop, usage recording, quality scoring
- `executeClaudeWebSearchMultiTurn()` / `executeClaudeWebSearchMultiTurnStream()`: Multi-turn with message history
- `buildSourceMetadataMap()`: Deduplicates citations by URL, propagates academic metadata (DOI, authors, year)
- Phase transitions: `searching` → `continuing` (on pause_turn) → `done`

**Research Mode Handler** (`src/ui/chat/ResearchModeHandler.ts`):
- `executeClaudeWebSearchCycle()`: Branch in `executeSearchCycle()` for `claude-web-search` provider
- Phase simplification: skips reviewing/extracting/synthesizing, goes straight to done
- `onClear()`: Resets conversation history and handler state
- Session persistence includes `conversationHistory` for multi-turn resume
- Perspective resolution from `PERSPECTIVE_PRESETS` for Claude Web Search system prompt

### Key Decisions

- **API Key Reuse** (AD-4): resolution is **provider-gated** (`getClaudeWebSearchKey`, `apiKeyHelpers.ts`). Under `azure-claude` the **Azure Foundry key wins** and any dedicated research key is IGNORED — a dedicated key is a DIRECT-Anthropic (`x-api-key`) credential, so Bearer-sending it to the Foundry passthrough 401s ("invalid subscription key"). For non-Azure providers: dedicated research key → main SecretStorage anthropic key → `cloudApiKey`. So Azure overrides while it's the selected provider; private keys reactivate when Azure is off. (Order is Azure-first by design — verified live against the Foundry endpoint June 2026; the old dedicated-first order was the root cause of a web-search 401.)
- **Domain Filtering** (AD-5): `researchExcludedSites` → `blocked_domains`; academic mode → `allowed_domains` for academic sites
- **Cost Tracking** (AD-6): `$0.01/search` via `usage.server_tool_use.web_search_requests` count
- **Dynamic Filtering** (AD-7): Auto-detect based on model prefix (`claude-opus-4-6`/`claude-sonnet-4-6`)
- **Phase Simplification** (AD-3): `idle` → `searching` → `done` (skips reviewing/extracting)

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `researchClaudeMaxSearches` | `5` | Max searches per query (1-10) |
| `researchClaudeUseDynamicFiltering` | `true` | Dynamic filtering (requires Claude 4.6) |

### Tests
- `tests/claudeWebSearchAdapter.test.ts`: 60 adapter tests (parseResponse, isConfigured, searchAndSynthesize, buildSystemPrompt, tool version, scoring, pause_turn, academic, perspective, multi-turn)
- `tests/claudeWebSearchIntegration.test.ts`: 22 orchestrator integration tests (pipeline, pause_turn accumulation, metadata dedup, budget, quality scoring, academic enrichment, multi-turn)
- `tests/claudeWebSearchStreaming.test.ts`: 56 streaming tests (SSE parsing, citations_delta, mode-switch abort, continuing phase, multi-turn stream)
- **Total**: 138 Claude Web Search tests

### Key Patterns
- **Preamble filtering**: `parseResponse()` excludes pre-search narrative ("I'll search for...") from synthesis
- **Citation-frequency scoring**: Citation counts normalized by max → implicit quality ranking
- **Snippet enrichment**: First `cited_text` per URL fills empty `snippet` on search results
- **Academic metadata propagation**: DOI/authors/year from enriched `SearchResult` copied to `SourceMetadata`
- **Stale-generation guard**: Streaming callbacks check `isStaleGeneration()` to prevent writes after mode switch
- **3-layer abort**: Network abort → callback suppression → final-write guard

**Plan**: docs/claude-web-search-plan.md (`docs/claude-web-search-plan.md` — removed)

## Web Reader

**Status**: ✅ Implemented (February 2026)

### Overview
Article triage workflow: extract web URLs from a note, fetch brief LLM summaries, present in an interactive modal for multi-select grouping, create notes ready for full summarization.

### Core Components
- `src/services/prompts/triagePrompts.ts`: 5-10 line triage prompt
- `src/services/webReaderService.ts`: Fetch + triage + note creation
- `src/ui/modals/WebReaderModal.ts`: Two-phase modal (progress → triage)
- `src/commands/webReaderCommands.ts`: Command registration

### Key Patterns
- Sequential fetch with progressive rendering
- LLM failure → Readability excerpt fallback
- Iterative multi-select: create note → remove from list → repeat
- Output notes contain URLs only (user runs normal summarization)
- AbortController for cancellation during fetch phase
- Privacy consent gate before LLM calls
- URL count warning threshold (20+) with confirmation modal

### Settings
| Setting | Default | Description |
|---------|---------|-------------|
| `webReaderOutputFolder` | `'Web Reader'` | Subfolder under plugin folder for output notes |

### Commands
- `web-reader`: In Command Picker → Capture category

### Tests
- `tests/triagePrompts.test.ts`: 17 prompt invariant tests (10 base + 7 content-type)
- `tests/webReaderService.test.ts`: 13 service tests (fetch, LLM fallback, progress, note creation)
- `scripts/automated-tests.js`: 2 integration checks (command registration + index)

## Quick Peek — Fast Triage

**Status**: ✅ Implemented (March 2026)

### Overview

Fast 1-paragraph triage summaries for embedded sources (URLs, PDFs, YouTube, documents, audio) with action cards. Three trigger modes: command palette (full note), right-click selection, right-click cursor-on-link.

### Core Components

- `src/services/quickPeekService.ts`: Orchestrator — detect → extract → triage per source with specialist/main provider
- `src/ui/modals/QuickPeekModal.ts`: Phase-based modal (detecting → extracting → triaging → done) with source cards
- `src/commands/quickPeekCommands.ts`: Command registration + smart dispatch
- `src/services/prompts/triagePrompts.ts`: Extended with `contentType` parameter and type-specific hints

### Smart Dispatch (3 Trigger Modes)

- **Command palette**: All sources in active note
- **Right-click selection**: Links in selection range (line-filtered)
- **Right-click cursor on link**: Single link under cursor

### Source Cards

- Type icon + display name per source
- Triage paragraph (or error/fallback excerpt with ⚠ indicator)
- **Full Summary**: Opens MultiSourceModal with single source pre-selected
- **Open**: Platform-safe via `openInBrowser()` or `openLinkText()`
- **Remove from Note**: Content-match removal with 5-second undo notice

### Key Patterns

- **Specialist provider**: Follows flashcard/audit pattern — `quickPeekProvider` + `quickPeekModel` settings
- **API key inheritance**: SecretStorage → provider key → main key (3-level fallback)
- **Source filter**: `getQuickPeekSources()` includes web-link, youtube, pdf, document, audio; excludes image, internal-link
- **Insert All Peeks**: Idempotent `## Quick Peek` section via `insertOrReplaceQuickPeekSection()`
- **Fallback excerpt**: First 200 chars of extracted content when LLM fails
- **AbortSignal**: Best-effort cancellation on modal close
- **Privacy consent**: Gated before LLM calls
- **Content-type hints**: `buildTriagePrompt()` receives source type for targeted prompts

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `quickPeekProvider` | `'main'` | Specialist or main LLM provider |
| `quickPeekModel` | `''` | Model override (empty = provider default) |

### Commands
- `quick-peek`: In Command Picker → Active Note category

### Tests
- `tests/quickPeekService.test.ts` (9 tests): Pipeline, provider resolution, abort, fallback excerpt
- `tests/triagePrompts.test.ts` (17 tests): Shared with Web Reader — includes 7 content-type tests
- `scripts/automated-tests.js`: 3 Quick Peek integration checks

**Plan**: [docs/completed/quic-plan.md](../completed/quic-plan.md)

## Kindle Sync

**Status**: Phases 1-3 ✅ Implemented (February 2026) | Phase 4 ⏳ TODO

### Overview

Kindle highlights sync with dual-mode import: My Clippings.txt file import and Amazon cloud sync via direct HTTP using Obsidian's `requestUrl`. Differential sync, note creation/update, four-phase modal UX, and ASIN-keyed deduplication for Amazon path.

### Core Components

**Kindle Types** (`src/services/kindle/kindleTypes.ts`):
- `KindleHighlight`, `KindleBook`, `KindleSyncState`, `KindleSyncProgress`, `KindleSyncResult`
- `KindleCookiePayload`, `KindleCDPCookie`, `KindleScrapedBook`
- Hash functions: `generateHighlightId()`, `generateBookKey()`, `generateAmazonHighlightId()`
- `toKindleBook()`: Convert scraped book + highlights → `KindleBook`

**Clippings Parser** (`src/services/kindle/kindleClippingsParser.ts`):
- `parseClippings(content)`: Splits by `==========`, parses metadata regex, groups by book
- Deduplicates by content hash, attaches notes to highlights, skips bookmarks

**Note Builder** (`src/services/kindle/kindleNoteBuilder.ts`):
- `buildBookNote()`, `buildFrontmatter()`, `formatHighlight()` (3 styles: blockquote/callout/bullet)
- `appendHighlightsToExisting()`, `updateFrontmatterInContent()` for incremental sync

**Auth Service** (`src/services/kindle/kindleAuthService.ts`):
- `validateCookies()`: HTTP validation via `requestUrl` against notebook page
- `getNotebookUrl()`: Region-specific domains (read.amazon.com, lesen.amazon.de, etc.)
- `buildRequestHeaders()`: Cookie + User-Agent headers for all requests
- `openAmazonInBrowser()`: Opens notebook URL in system browser
- `detectAuthExpiry()`: HTML-based login page detection
- Cookie CRUD: `isAuthenticated()`, `getStoredCookies()`, `storeCookies()`, `clearCookies()`
- `parseManualCookies()`: Cookie string validation (session-id + ubid required)

**Scraper Service** (`src/services/kindle/kindleScraperService.ts`):
- `fetchPageHTML()`: Core HTTP fetcher using `requestUrl` with Cookie auth
- `fetchBookList()` + `parseBookListHTML()`: Book list from Amazon notebook page
- `fetchHighlightsForBook()`: Per-book highlights with server-side pagination
- `parseHighlightsHTML()`: Highlight text, color, location, notes extraction
- `fetchAllHighlights()`: Orchestrator for all ASINs
- Pagination via `contentLimitState` + `token` hidden inputs

**Sync Service** (`src/services/kindle/kindleSyncService.ts`):
- `syncFromClippings()`: Clippings file import path
- `syncFromAmazon()`: Amazon cloud sync via HTTP, auth expiry detection
- `getNewHighlights(book, state, asin?)`: Optional ASIN-keyed lookup
- `updateSyncState(plugin, book, highlights, asin?)`: Dual-write state

**Login Modal** (`src/ui/modals/KindleLoginModal.ts`):
- 3-step flow: open Amazon in browser → copy cookies → paste and validate
- HTTP validation before storing cookies

**Sync Modal** (`src/ui/modals/KindleSyncModal.ts`):
- Four-phase modal supporting both clippings import and Amazon cloud sync
- Mobile vault file picker, cancel support, file tracking

**Settings** (`src/ui/settings/KindleSettingsSection.ts`):
- Amazon Region, Login/Logout, output folder, highlight style, toggles

### Architecture: Direct HTTP (v2)

All scraping via Obsidian's native `requestUrl` with Cookie header:
- Amazon notebook is server-rendered HTML — no JavaScript execution needed
- Region-specific reading domains (`REGION_DOMAINS` mapping, 11 regions)
- Server-side pagination via `contentLimitState` + `token` hidden inputs
- Cookie persistence in SecretStorage with structured `KindleCookiePayload`
- No external dependencies (no Bright Data, no CDP, no WebSocket)

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `kindleOutputFolder` | `'Kindle'` | Subfolder under plugin folder |
| `kindleAmazonRegion` | `'com'` | Amazon domain for cloud sync |
| `kindleHighlightStyle` | `'blockquote'` | How highlights render |
| `kindleGroupByColor` | `false` | Group highlights by color |
| `kindleIncludeCoverImage` | `true` | Embed cover image in note |
| `kindleAutoTag` | `true` | Run AI tagging after import |

### Commands
- `kindle-sync`: In Command Picker → Capture category

### Tests
- `tests/kindleClippingsParser.test.ts`: 21 parser tests
- `tests/kindleNoteBuilder.test.ts`: 34 builder tests
- `tests/kindleSyncService.test.ts`: 26 service tests (clippings + Amazon sync)
- `tests/kindleAuthService.test.ts`: 25 auth tests (cookie CRUD, headers, URL building)
- `tests/kindleScraperService.test.ts`: 20 scraper tests (HTML parsing, ID generation)
- `tests/fixtures/amazon-*.html`: HTML fixtures for `happy-dom` tests

### Remaining Work
- Phase 4: AI enhancement + polish
- Plan: docs/kindle-plan.md (`docs/kindle-plan.md` — removed)

## Newsletter Digest

**Status**: ✅ Tier 1 Implemented (March 2026)

### Overview

Fetches unread Gmail newsletters via a deployed Google Apps Script (single `doGet` with `action` parameter: default fetches unread, `action=confirm` marks read + archives). Triages each newsletter with AI and writes individual notes + a rolling daily digest.

### Core Components

- `src/services/newsletter/newsletterService.ts`: `fetchFromAppsScript()` passes `?label=...&limit=...` query params; `fetchAndProcess()` sets `hitLimit` flag; `createVaultNotes()` appends `## Key Links` section (top 10 content links, spam-filtered via `extractNewsletterLinks()`); `buildDigestEntry()` writes digest line
- `src/services/newsletter/newsletterTypes.ts`: `NewsletterFetchResult` with `hitLimit: boolean`; `ProcessedNewsletter` with `_rawBody?: string`
- `src/commands/newsletterCommands.ts`: `registerNewsletterCommands()` registers `newsletter-fetch`; `showNewsletterFetchResultNotice()` shows hit-limit warning when fetch count reached limit
- `src/main.ts`: `newsletterLastFetchTime` public field; `startNewsletterScheduler()` / `stopNewsletterScheduler()` / `runScheduledNewsletterFetch()` — interval-based auto-fetch with overdue-check on startup
- `src/ui/settings/NewsletterSettingsSection.ts`: Gmail label, fetch limit dropdown, Test Connection button (uses static `requestUrl` import), auto-fetch toggle + interval, Last Fetched display, Reset Import History

### Key Patterns
- **GET-only Apps Script**: Single `doGet` routes on `action` param (`fetch` default, `confirm` marks read + archives via `getThread().moveToArchive()`). POST was removed — Apps Script redirects POST (302→GET) dropping the body
- **Seen-ID dedup**: persisted in plugin data (`newsletter-seen-ids`); in-memory cache on plugin object
- **HTML login detection**: `response.text.trimStart().startsWith('<')` → throws actionable error before `JSON.parse`
- **Static requestUrl**: must use static import from `'obsidian'` — dynamic `import('obsidian')` hangs in bundled plugins
- **Auto-fetch scheduler**: `setInterval` + overdue-check on startup; stopped in `onunload()`

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `newsletterEnabled` | `false` | Master toggle |
| `newsletterSource` | `'apps-script'` | Connection method |
| `newsletterScriptUrl` | `''` | Deployed Apps Script URL |
| `newsletterGmailLabel` | `'Newsletters'` | Gmail label to fetch from |
| `newsletterFetchLimit` | `20` | Max emails per fetch (10/20/30/50) |
| `newsletterAutoFetch` | `false` | Background auto-fetch |
| `newsletterAutoFetchIntervalMins` | `60` | Interval in minutes |
| `newsletterOutputFolder` | `'Newsletter Inbox'` | Subfolder under plugin folder |
| `newsletterAutoTag` | `false` | Run AI tagging after import |
| `newsletterHomeRegion` | `''` | `''` = off. Semicolon/comma-separated aliases, e.g. `Leidschendam; Voorburg; Netherlands` |
| `newsletterStoryMemory` | `true` | Cross-day story memory; `false` also PURGES both data keys |

### Commands
- `newsletter-fetch`: Fetch newsletters now — in Command Picker → Capture
- `newsletter-mark-caught-up`: Assert you are up to date, so earlier stories stop repeating — Capture

## Newsletter Story Memory (consumption-aware) + local-news fairness

**Status**: ✅ Implemented (September 2026)

Three defects in the daily brief, one root cause — what `generateAndInjectBrief` was allowed
to know. It saw only that bucket's newsletters, so a recurring story was retold every day.

### The model: two independent facts, joined purely

"Already told" is a JOIN of what was **published** (ledger) and what was **consumed**
(watermark). Keeping them apart is what makes catch-up expressible at all.

- `newsletterMemoryTypes.ts` — neutral types; everything else imports downward into it.
- `newsletterStoryLedger.ts` (key `newsletter-story-ledger`) — the ledger is derived by
  **parsing the brief we already generated**, so it costs no extra LLM call. `storyKey` is a
  normalised, stemmed token SET (not a slug) so a retitled continuing story still matches.
- `newsletterConsumption.ts` (key `newsletter-consumed-briefs`) — **revision-scoped, never a
  per-bucket boolean.** A live bucket regenerates on every fetch, so a boolean would mark
  stories that arrived *after* the reader listened as heard.
- `newsletterRecall.ts` — `selectRecall`, pure, no I/O. Spans buckets **up to and including**
  the one being regenerated, using its pre-generation snapshot.

### Seven invariants that are each load-bearing

Every one of these was a real defect — four caught in review, three caught only by
BENCHMARKING AGAINST A REAL VAULT (219 stories over 7 days). Changing any of them silently
breaks the feature while tests and lint still pass.

1. **Two revisions per story, not one.** `firstRevision` answers "did it exist when they
   listened" (background); `contentRevision` answers "has it changed since" (update). Within a
   live bucket the merge overwrites the entry, so a single revision makes a *changed* story
   look brand-new and the reader gets it re-explained instead of just the delta.
2. **The merge is a UNION.** A key absent from the new brief is RETAINED. The afternoon brief
   correctly *omits* an already-heard story, and dropping it here would erase the record that
   it was ever told, so tomorrow it would be retold from scratch.
3. **Re-stamp `contentRevision` on a changed gist.** Without it, a new development on an
   already-heard story is born already-consumed and can never be surfaced.
4. **Three-way classification** (`heard` / `continuing` / `unheard`). Two states cannot express
   "knows the background, has an unheard update", so a continuing story either loses its
   update or gets fully re-explained.
5. **Story identity is SIMILARITY, not equality** (`newsletterStoryIdentity.ts`). Exact
   token-set equality caught 2 continuations in 219 real stories; similarity at 0.42 catches 11.
   A continuing story is precisely the case where the headline gains or loses a qualifier
   ("…86 tonnes of gold from the US" vs "…78 tonnes of gold from US and Canada"), so equality
   misses the cases the feature exists for. The threshold sits in a NARROW measured gap —
   weakest true pair 0.444, strongest false pair 0.375 — and `newsletterStoryIdentity.test.ts`
   pins both ends with the real headlines.
6. **`heard` renders TITLE-ONLY, and `cap()` is charged for what is RENDERED.** Charging every
   list for its gists truncated a week of memory to 12 of ~150 entries — the model saw 8% of
   what the reader had heard, so a story running all week never entered the window and the
   feature looked inert. If the render ever adds the gist back, the budget becomes fiction.
7. **Memory entries carry their DATE, and length scales with how many dates a story spans.**
   This is the only mechanism that compresses a big running story, because nothing else can:
   the Iran conflict ran 7 days as bank sanctions → munitions → strikes → Hormuz → bases in
   Jordan, headlines sharing almost no words. Entity threading was tested and REJECTED — it
   groups Iran correctly but merges 17 unrelated Anthropic stories, and a false merge silently
   suppresses real news the reader can never know they missed.

Ordering is fixed: **read recall → build prompt → synthesise → post-process → record the new
revision.**

### The prompt is not trusted for global properties

Two defects appeared in real generated output. **Measured** (simulation reports raw model
output alongside the post-processed brief, so the two layers can be told apart):

| Defect | Prompt rule alone | Needs the code guard |
|---|---|---|
| Memory label as a source, `(Sources: continuing)` | **fixed** — 0 in raw output both days | no |
| Same story under a topical heading AND "Closer to home" | **not fixed** — 2 duplicates in raw output | **yes** |

The label leak was cured by RENAMING the sections (`THEY_MISSED_THESE_ENTIRELY` etc.) so they
cannot read as a newsletter name — a catch-up story comes from the ledger, not from today's
newsletters, so it has no source and the model was filling the slot with the nearest label it
could see. Do not rename them back to something source-shaped.

De-duplication is still doing real work every run, and **prefers the home-region copy**: that
section renders last, so a keep-the-first rule would always discard the local placement and
undo the section's purpose.

General lesson, now with evidence on both sides: a rule about LOCAL wording (what may appear in
one field) is followed; a rule about a GLOBAL property of a long document ("never repeat a story
anywhere") is not. Guard the second kind in code.

### Benchmarks read the live vault

`tests/bench/newsletter*.bench.test.ts` measure against real vault content rather than
fixtures, which is how invariants 5-7 were found. `newsletterSimulation.bench.test.ts` replays
chosen days through the real prompt and the user's own model (`NL_SIM=1`, costs LLM calls);
the others are free and deterministic. Re-run them rather than trusting the numbers quoted here.

### Consumption signals

- **Audio**: `audioPlayerEnhancer` measures coverage from the media element's `played`
  TimeRanges. A scrub to the end plays nothing and extends no range, so it does not count.
  The signal consumes **the revision that recording was rendered from** (`bucket.audio[name]`,
  stamped from a revision captured BEFORE the podcast/TTS pipeline starts) — never the current
  one, which could mark unheard afternoon stories as heard.
- **Manual**: `newsletter-mark-caught-up`, single-flight, shares
  `resolveCatchUpTargetDate` + the notice formatter with the settings button.
- An **unparseable brief** sets `parseFailedAt`: stories are preserved (no data loss) but the
  bucket is EXCLUDED from recall until a successful parse, so drift degrades to today's
  behaviour rather than asserting stale memory.

### Local-news fairness

`newsletterHomeRegion` (default `''`, so unconfigured installs are byte-identical) adds a
"Closer to home" heading, exempts local stories from the multi-source priority rule, and
orders the trimmer's drop pass `(local ASC, length ASC)` — every non-local source is exhausted
before the first local one, because length-only ordering dropped the shortest first, which is
exactly the shape of a local paper.

**Aliases are matched as complete phrases; there is NO automatic word splitting.** Splitting
"New York" yields the token "new", which whole-word-matches nearly every newsletter — every
source would be flagged local and the protection would degenerate into none.

### Persistence (fixes a latent lost-update)

`src/core/pluginDataStore.ts` is the ONLY module that calls `plugin.saveData`. Obsidian's
`saveData` writes the WHOLE object, so separate keys give no isolation — six unserialised
writers shared it, and `this.settings` carried a load-time snapshot of the newsletter data
keys, so a settings save after a fetch rolled back seen-ids.
- `saveSettingsData` is **replacement-based**, preserving only `DATA_ONLY_KEYS`. An overlay
  would resurrect every legacy key a migration deletes, silently disabling migrations.
- `updatePluginData`'s mutator returns `{changed}`, so a no-op decided inside the lock skips
  the write.
- Two ESLint guards enforce it. **They are COMPOSED from named fragments, and the broad block
  is declared FIRST**: flat config *replaces* a rule value rather than merging it, and adding
  the plugin-data guard silently disabled all four note-edit write-seam selectors for the
  command layer. `tests/eslintGuards.test.ts` asserts the EFFECTIVE rule per file, which is
  the only way to observe that.

### Tests
`tests/{pluginDataStore,newsletterStoryLedger,newsletterStoryIdentity,newsletterConsumption,newsletterRecall,newsletterPrompts,briefPostProcess,briefAudioResolver,audioPlayerEnhancer,eslintGuards}.test.ts`.
The catch-up matrix in `newsletterRecall.test.ts` is the one to read first;
`newsletterStoryIdentity.test.ts` is the one that will fail if the threshold is nudged.

**Plan**: [docs/plans/newsletter-story-memory-local-news.md](../plans/newsletter-story-memory-local-news.md)

### Tests
- `tests/newsletterServiceIntegration.test.ts` (27 tests): fetch pipeline, seen-ID dedup, two-phase confirmation, HTML detection, key links extraction, hit-limit flag

**Plan**: [docs/completed/newsletter-digest-plan.md](../completed/newsletter-digest-plan.md)

