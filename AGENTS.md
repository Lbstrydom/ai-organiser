# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

> **Canonical shared context.** Every AI coding agent reads this file — Claude Code,
> Copilot, Cursor, Windsurf, Codex. [CLAUDE.md](./CLAUDE.md) is a thin addendum that
> `@`-imports it and holds Claude-Code-only notes; edit shared rules here, never there.
>
> **This file holds load-bearing invariants, not dossiers.** It is loaded every
> session by every agent, so its size is a per-session cost and depth buried in it
> degrades recall of the rules that matter. Subsystem-grade operational detail
> (pipelines, component inventories, test rosters, phase histories) belongs in
> [`docs/features/`](docs/features/) behind a *what-it-is / when-you-need-it /
> pointer* stub here — the same progressive-disclosure split a skill uses between
> its `SKILL.md` and its `references/`.
>
> **Enforced.** `node scripts/.claude-skills/check-context-drift.mjs --strict` fails
> on `ctx/oversized-agents-md` past **92 000 characters**. When you add a subsystem,
> add a row to [Feature Subsystems](#feature-subsystems) and put the depth in
> `docs/features/<domain>.md` — condense a dossier rather than raising the cap.
> Raising it needs a justification recorded in `.claude-context-allowlist.json`.

## Build Commands

```bash
# Development build with watch mode and inline sourcemaps
npm run dev

# Production build (source type-check + tests + bundle)
npm run build

# Quick production build (source type-check + bundle, skips test types)
npm run build:quick

# Version bump (updates manifest.json and versions.json)
npm run version
```

**Build Configuration**:
- `tsconfig.json` - Full config including tests (for IDE)
- `tsconfig.build.json` - Source-only config (for production builds)

The build process uses esbuild to bundle `src/main.ts` into `main.js`. Production builds disable sourcemaps; dev builds enable inline sourcemaps.

## Architecture Overview

### Core Plugin Structure

**Entry Point**: `src/main.ts` (`AIOrganiserPlugin` class)
- Main plugin class extending Obsidian's `Plugin`
- Manages lifecycle: settings loading, LLM service initialization, command registration
- Handles tag operations: `analyzeAndTagNote()`, `showTagNetwork()`, batch processing
- Central coordinator between services, UI, and Obsidian API
- Owns the plugin-scoped singletons: `providerProfile`, `foregroundGate`, `embeddingQueue`, `embeddingCooldown` -> [platform](docs/features/platform.md)

### Service Layer Architecture

**LLM Services** (`src/services/`)
- **Base abstractions**: `LLMService` interface defines contract for all providers
- **Two service types**:
  - `LocalLLMService`: Ollama, LM Studio, LocalAI, OpenAI-compatible endpoints
  - `CloudLLMService`: Cloud providers (OpenAI, Claude, Gemini, Groq, Azure, etc.)
- **Adapter pattern** (`src/services/adapters/`): Each cloud provider has its own adapter (e.g., `claudeAdapter.ts`, `geminiAdapter.ts`) handling API-specific formatting
- **Prompt engineering** (`src/services/prompts/`): XML-structured prompts optimized for Claude/GPT

**Key service flow**:
1. Plugin calls `llmService.analyzeTags(content, candidateTags, mode, maxTags, language)`
2. Service builds prompt via `buildTagPrompt()` with mode-specific instructions
3. For cloud: Adapter formats request -> calls API -> parses response
4. Returns `LLMResponse` with `suggestedTags` and `matchedExistingTags`

Azure routing, request pacing, prompt caching and the fail-closed provider profile all
sit on this layer -> [azure-and-llm](docs/features/azure-and-llm.md).

### Provider Registries

**LLM Provider Registry** (`src/services/adapters/providerRegistry.ts`):
- `ALL_ADAPTERS`: List of all supported adapter types
- `PROVIDER_DEFAULT_MODEL`: Default model per provider
- `PROVIDER_ENDPOINT`: Default API endpoint per provider
- `buildProviderOptions(t)`: Generate dropdown options from translations

**Embedding Provider Registry** (`src/services/embeddings/embeddingRegistry.ts`):
- `EMBEDDING_DEFAULT_MODEL`: Default model per embedding provider
- `EMBEDDING_MODELS`: Available models per provider
- `getEmbeddingModelOptions(provider)`: UI-friendly labeled options

**Model catalog** (`src/core/modelCatalog.ts`): capabilities, defaults and aliases SSOT.
Embedding cross-dimension aliasing is forbidden — it would invalidate vector indexes.

### Settings & Configuration

**Settings schema** (`src/core/settings.ts`): the `AIOrganiserSettings` interface.
Settings UI is split into modular sections under `src/ui/settings/`, each extending
`BaseSettingSection` and wrapped in collapsible groups. The full group-by-group map is
in [platform](docs/features/platform.md#settings-ui-map).

**Settings persistence**: Loaded in `loadSettings()`, saved via `saveSettings()`, triggers service reinitialization.

**Settings migration** (`src/core/settings.ts`):
- `migrateOldSettings()`: pure function migrating stored settings to the current schema
- Called from `loadSettings()` in `main.ts` — every migration in one testable function
- Migrations must be **order-safe** and idempotent; a guarded one-shot marker
  (e.g. `thinkingDefaultOffV1`) is how a default flip preserves a deliberate opt-in

### Internationalization (i18n)

**Translation system** (`src/i18n/`):
- **English only** (`en.ts`). The i18n system stays (typed `t.*` access), but the Simplified-Chinese locale was retired 2026-06 — the EN/ZH parity maintenance burden outweighed its use. `migrateOldSettings` coerces any stored `interfaceLanguage: 'zh-cn'` -> `'en'`.
- Type-safe translations via the `Translations` interface
- Access translations: `this.t.settings.someKey` or `plugin.t.messages.someMessage`
- Interface language change requires Obsidian restart
- Re-adding a locale later = add a `Translations` impl + an entry in `src/i18n/index.ts`

**Adding new i18n strings**: add to the `Translations` interface in `types.ts` ->
implement in `en.ts` -> reference as `t.section.key`.

### Tag Utilities & Operations

**Core utilities** (`src/utils/tagUtils.ts`):
- `TagUtils.formatTags()`: Sanitizes tags (removes prefixes, enforces kebab-case)
- `TagUtils.updateNoteTags()`: Modifies frontmatter YAML, handles merge vs replace
- `TagUtils.getAllTags()`: Extracts all tags from vault frontmatter
- `TagUtils.getTagsFromFile()`: Reads predefined tags from markdown file

**Tag formatting rules**:
- Remove `#` prefix and malformed prefixes (`tag:`, `matchedExistingTags-`, etc.)
- Convert to kebab-case (spaces/special chars -> hyphens)
- Preserve `/` for nested tags (e.g., `science/biology`)

### RAG & Semantic Search

- **Vector store** (`src/services/vector/`): `VoyVectorStore` (Voy WASM) behind an
  `IVectorStore` interface; chunk-based indexing with configurable size and overlap.
- **RAG service** (`src/services/ragService.ts`): `getRelatedNotes()`,
  `retrieveContext()`, `buildRAGPrompt()`, `formatSources()`.
- **Embedding services** (`src/services/embeddings/`): `IEmbeddingService` with
  `generateEmbedding()` / `batchGenerateEmbeddings()` / `maxBatchSize`, implemented by
  OpenAI, Ollama, Gemini, Cohere, Voyage AI and a zero-setup local ONNX fallback.
  `createEmbeddingServiceFromSettings()` handles API-key inheritance.
- **Claude/Anthropic has no embeddings API** — use Voyage AI instead.
- **All indexing goes through the plugin-scoped cap-1 `embeddingQueue`**, never
  directly at the service -> [platform](docs/features/platform.md).

Search UI, the related-notes sidebar view and the visual (page-image) lane are detailed
in [chat-and-rag](docs/features/chat-and-rag.md).

### Tag Network Visualization

**Implementation** (`src/ui/views/TagNetworkView.ts`): a custom Obsidian `ItemView`
with search filtering, hover tooltips and node dragging; network data built by
`TagNetworkManager` (`src/utils/tagNetworkUtils.ts`). **D3 is bundled as submodules,
never CDN-loaded** — see [Known Constraints](#known-constraints).

## Command Registration

Commands are registered per category in `src/commands/`:

| File | Commands |
|---|---|
| `generateCommands.ts` / `clearCommands.ts` | Tag generation and clearing for note / folder / vault |
| `summarizeCommands.ts` | URL, PDF, YouTube and audio summarization + audio recording |
| `translateCommands.ts` | Note, selection and multi-source translation |
| `smartNoteCommands.ts` | Improve note, find resources, diagrams, mermaid chat |
| `integrationCommands.ts` | Pending-content integration (placement / format / detail strategies) |
| `minutesCommands.ts` / `transcribeCommands.ts` | Meeting minutes + Word export; transcribe-only |
| `canvasCommands.ts` | Investigation, context and cluster boards |
| `chatCommands.ts` | Highlight chat, presentation commands |
| `flashcardCommands.ts` | Flashcard export (Anki / Brainscape) |
| `digitisationCommands.ts` / `sketchCommands.ts` | Image digitisation; built-in sketch pad |
| `kindleCommands.ts` / `newsletterCommands.ts` | Kindle sync; newsletter fetch + audio regen |
| `embedScanCommands.ts` / `quickPeekCommands.ts` | Vault hygiene scan; fast source triage |
| `webReaderCommands.ts` / `migrationCommands.ts` / `dashboardCommands.ts` | Article triage; Bases migration and dashboards |
| `utilityCommands.ts` | Collect tags, tag network |
| `oneDriveLinkCommands.ts` | Insert / refresh links to local OneDrive files |

```typescript
plugin.addCommand({
    id: 'unique-command-id',
    name: plugin.t.commands.commandName,
    icon: 'lucide-icon-name',
    callback: async () => { /* implementation */ }
});
```

All commands use i18n names and a contextual Lucide icon, and every registrar is gated
by its feature (`REGISTER_BY_FEATURE`) so a disabled feature leaks no command into the
native palette.

**Top-level picker categories are Pinned + the five workflow stages** (`capture`,
`create`, `refine`, `find`, `maintain`), declared once in `src/core/workflowStages.ts`
and projected into both the settings menu and the command picker. A cross-surface CI
test fails the build when the two disagree. Adding or moving a leaf:
[platform](docs/features/platform.md#command-picker-architecture).

## Feature Subsystems

Each row is a subsystem whose operational depth lives in `docs/features/`. Read the
linked file **before changing that subsystem** — the invariants that would otherwise be
violated silently (fail-closed gates, byte-identical-when-off guarantees, schema
degradation rules, audit findings that shaped the design) are recorded there, not here.
Repo-wide rules that bind *every* subsystem are in
[Cross-Cutting Invariants](#cross-cutting-invariants).

### [Presentation & Slides](docs/features/presentation.md)

| Subsystem | What it is | Read it when |
|---|---|---|
| Consultant-quality slides | Storyboard -> reviewable dot-dash storyline -> IR deck, with deterministic evidence grounding | Touching storyboard generation, grounding, or the storyline round-trip |
| AI chat + presentation builder | The chat mode, deck model, and generate -> audit -> refine pipeline | Changing deck generation or the build actions |
| Depth controls | Speed pill + per-call `modelOverride`; the Claude-path override fix | Routing a call to a different model, or enabling thinking per-call |
| Per-slide polish | All-or-nothing selective refine of chosen slides | Changing refine validation or the polish selector |
| Reliability fixes | Brand re-render, busy guard, storyline rebuild command | Debugging a wedged deck lock or a stale brand toggle |
| Side-rail workspace | Canvas-dominant layout, filmstrip, mobile bottom sheet | Changing slides-mode layout or thumbnails |
| Sanitizer (DOMPurify) | The trust boundary for LLM-generated slide HTML | Adding CSS or markup to a slide renderer — **see the CSSOM longhand rule below** |
| Brand fidelity | Vault brand pack -> export theme, safe areas, font embedding | Changing PPTX/DOCX theming or brand asset handling |

### [Azure Providers & LLM Plumbing](docs/features/azure-and-llm.md)

| Subsystem | What it is | Read it when |
|---|---|---|
| Azure AI Foundry providers | `azure-claude` + `azure-openai`, routing modes, per-capability flexibility | Touching Azure endpoints, deployments, or api-version handling |
| Azure audio adapters | In-region Azure AI Speech vs private gpt-audio, behind a compliance policy gate | Adding a TTS or diarization path |
| 429 throttling | Per-deployment RPM pacer + Azure-aware retry across every egress | Adding any new outbound Azure call |
| LLM gateway-lite | Fail-closed provider profile, foreground gate, embedding queue | Changing service init, indexing contention, or call attribution |
| Anthropic prompt caching | The `stablePrefix` contract and the stable/volatile split discipline | Adding a call site with a large reusable prefix |

### [Audio, Transcription & Meeting Minutes](docs/features/audio-and-minutes.md)

| Subsystem | What it is | Read it when |
|---|---|---|
| Audio recording | MediaRecorder capture with mobile-safe mime negotiation | Changing capture or post-recording cleanup |
| Speaker-aware transcription | Audio attach trio, speaker review panel, deterministic action attribution | Changing the attach pipeline or speaker handling |
| Deepgram diarization (v2) | Opt-in acoustic diarization behind two independent gates | Adding a diarization provider |
| Read-this-note enhancement | Opt-in LLM pre-stage that runs before TTS | Changing narration preprocessing or its fingerprint |
| Meeting minutes | Personas, GTD overlay, dictionaries, chunked generation | Changing minutes prompts or output |
| Controller architecture | Document / dictionary / audio controllers behind the minutes modal | Adding a controller or changing its result contract |

### [Research & Content Capture](docs/features/research-and-capture.md)

| Subsystem | What it is | Read it when |
|---|---|---|
| Web research assistant | Decompose -> search -> triage -> extract -> synthesize, with budgets and quality scoring | Changing the research pipeline or adding a provider |
| Claude web search | Single-call native web search replacing the four-call pipeline | Changing the Claude search branch or its citations |
| Web reader | Bulk URL triage into notes ready for summarization | Changing article triage |
| Quick peek | One-paragraph triage of embedded sources with action cards | Changing fast triage |
| Kindle sync | Clippings import + Amazon cloud sync over `requestUrl` | Changing highlight import or auth |
| Newsletter digest | Apps Script fetch -> triage -> daily brief + optional podcast | Changing fetch, brief generation, or the scheduler |
| Newsletter story memory | Consumption-aware cross-day recall + local-news fairness, so a running story compresses instead of repeating | Changing recall, the story ledger, the brief prompt, or listen tracking |

### [Chat, Attachments & Semantic Retrieval](docs/features/chat-and-rag.md)

| Subsystem | What it is | Read it when |
|---|---|---|
| Free chat + projects | Attachments, project persistence, memory, conversation compaction | Changing chat prompt assembly — **the stable/volatile split is load-bearing** |
| Smart document indexing | Large-attachment RAG with project / temporary / truncate choice | Changing attachment indexing |
| Mermaid chat | Conversational diagram editing with versions, diff, templates, export | Changing diagram generation or export |
| Visual search | Cohere v4 page-image lane over embedded PDFs (default off) | Changing visual indexing or the RAG merge |

### [Vault Intelligence Tools](docs/features/vault-tools.md)

| Subsystem | What it is | Read it when |
|---|---|---|
| Obsidian Bases | Structured frontmatter metadata, migration, dashboards | Changing metadata properties or dashboard templates |
| Canvas toolkit | Investigation / context / cluster boards as `.canvas` files | Changing layouts or board generation |
| Find embeds | Vault hygiene scan with reference counts and orphan detection | Changing the embed scanner |

### [Content Pipeline & Note Writes](docs/features/content-pipeline.md)

| Subsystem | What it is | Read it when |
|---|---|---|
| Document extraction | Office / PDF / RTF / TXT extraction from vault files and URLs | Adding a source format |
| Large-content ingestion | Quality-aware chunking and hierarchical map-reduce | Changing chunk thresholds or the orchestrator |
| Smart digitisation | Multimodal image -> markdown, sketch pad, media compression | Changing the multimodal pipeline |
| Multi-source translate / integrate | Multi-source orchestration and pending-content resolution | Changing either flow |
| Document export | PDF / DOCX / PPTX behind the shared export theme | Changing export output |
| Note-edit write seam | `applyNoteEdit` — **the only way a command mutates a note** | Any command that writes to a note |
| Reviewed edits | Inline diff review before a write lands | Changing the review modal |

### [Platform & Cross-Surface Infrastructure](docs/features/platform.md)

| Subsystem | What it is | Read it when |
|---|---|---|
| ProgressReporter | `withProgress` / `withProgressResult` — the one progress surface | Adding a long-running LLM flow |
| Feature toggles | Per-feature on/off gating; `isFeatureEnabled` is the SSOT | Adding a feature or a gated surface |
| Unified feature taxonomy | Workflow stages shared by settings and the picker, CI-enforced | Adding a feature or a picker leaf |
| Settings UI map | Where each settings group lives, and the collapsible mechanics | Adding a settings section |
| Command picker architecture | Cross-listing, requirement gating, the view-model | Adding or moving a picker leaf |

## Cross-Cutting Invariants

Rules that bind **every** subsystem. Each was learned from a real defect; the subsystem
doc named alongside carries the incident. Violating one is not a style issue — it is how
a silent failure gets shipped.

**Models and providers**
- **Never hardcode a model version.** Use `latest-*` sentinels or the provider's own
  `*-latest` alias, resolved against the live catalog. Azure is the stated exception and
  says so explicitly: deployments lag, so its adapters pin concrete defaults.
- **`useMainKeyFallback: false` for every specialist provider** with no main-LLM
  equivalent (Deepgram, Cohere visual, the narration enhancers). Without it the resolver
  silently hands out the user's main LLM key and the call 401s somewhere confusing.
  -> [azure-and-llm](docs/features/azure-and-llm.md)
- **In Azure mode there is no silent fallback to a personal key.** A missing Azure
  surface raises a clear error; it never quietly borrows another credential.
- **A misconfigured Azure provider installs `NullLLMService`** — a separate fail-closed
  class with no network path, not a flag on the real service.

**Opt-in discipline**
- **A new capability ships default-off and byte-identical when off.** "Whisper stays
  forever": the existing path stays reachable and unchanged. Prove it with a test that
  pins the off-path output, not by inspection.
- **Fail closed on anything unknown** — an unrecognised feature id, capability or
  provider is disabled, never assumed available.

**Contracts and failure**
- **Return `Result<T>` from `src/core/result.ts` at service boundaries**, not a
  hand-rolled `{ success, error? }` bag. Batch operations use `BatchResult<T>`.
- **A service-boundary export must never reject past its contract** — wrap throws into
  `Result.err`.
- **Schemas degrade, they do not hard-fail.** A fixable structural or length problem
  truncates, pads or coerces; only a genuine structural break errors. An LLM repair
  retry reproduces the same mistake, so a rejecting schema turns one bad field into a
  dead generation. -> [presentation](docs/features/presentation.md)
- **Never `console.log`.** Use `logger.debug/warn/error('Tag', msg)` from
  `src/utils/logger.ts`; debug and warn are suppressed unless `debugMode` is on.

**Writes and egress**
- **Every command note-write goes through `applyNoteEdit`** — ESLint-enforced in the
  command layer, where a direct `editor.setValue` / `replaceRange` / `vault.modify` is a
  lint error. -> [content-pipeline](docs/features/content-pipeline.md)
- **Outbound HTTP uses Obsidian's `requestUrl`** (via `abortableRequestUrl` where
  cancellation matters). Native `fetch` is only for SSE streaming, which `requestUrl`
  cannot do.
- **Every Azure egress is paced** through the per-deployment pacer, and the lease is held
  only for the in-flight request — never across a backoff.

**Rendering and caching**
- **New slide CSS must have its CSSOM *longhands* allowlisted** in
  `presentationSanitizePolicy.ts`. A shorthand in the allowlist is dead: the sanitizer
  enumerates longhands, which is how `gap` passed unit tests and was stripped in the real
  browser. Verify in a real render, not happy-dom.
  -> [presentation](docs/features/presentation.md)
- **A cached stable prefix must be byte-stable across calls.** No timestamps, ids or
  counters before the cache marker; volatile content strictly after it.
- **A fingerprint's inputs are its contract.** Salting one (prompt version, preprocessor
  version) invalidates every cache keyed on it — branch by mode rather than bumping a
  shared version.

**Obsidian platform**
- **No remote `<script>` injection, ever** — the review bot treats it as blocking. See
  [Obsidian community-review compliance](#obsidian-community-review-compliance).
- **Feature-gated surfaces check `isFeatureEnabled(settings, id)`** — commands, views,
  settings sections, picker leaves, chat modes and background services alike.

## Important Implementation Patterns

### Modal Naming Convention
- Modal files: `[Feature]Modal.ts` in `src/ui/modals/`
- Class names: `[Feature]Modal` extending Obsidian's `Modal`

### Prompt Engineering Standards

All prompts use XML-style structure:
```
<task>What to do</task>
<requirements>Constraints and rules</requirements>
<output_format>Expected format with examples</output_format>
```

This format optimized for Claude/GPT-4 comprehension.

### Claude Adaptive Thinking

**Claude adaptive thinking** (`claudeAdapter.ts`): Opus 4.6 and Sonnet 4.6 support adaptive thinking where Claude decides when to think deeply. Controlled by `claudeThinkingMode` setting (`standard` | `adaptive`). `applyThinkingParams()` injects `thinking: { type: 'adaptive' }`, bumps `max_tokens` to 64000, removes temperature. `parseResponseContent()` skips thinking blocks; `parseStreamingChunk()` skips `thinking_delta` events.

### Tag Sanitization Pipeline

Always sanitize LLM outputs:
1. Extract tags from response (handle JSON, markdown, plain text)
2. Apply `formatTags()` to strip malformed prefixes
3. Normalize to kebab-case
4. Remove duplicates and empty strings

### Frontmatter Handling

Use Obsidian's `metadataCache` for reading, `vault.modify()` for writing:
- Parse YAML with `js-yaml` library
- Preserve non-tag frontmatter fields
- Handle edge cases: no frontmatter, malformed YAML, empty tags

### Error Handling

- Use `TagOperationResult` interface for operation outcomes
- Show user-friendly notices via `Notice` class
- **Logging**: Use `logger.debug('Tag', msg)` / `logger.warn()` / `logger.error()` from `src/utils/logger.ts` — never use `console.log` directly. Debug/warn output is suppressed unless `debugMode` is enabled; errors always log.
- New services should return `Result<T>` from `src/core/result.ts` at service boundaries
- Graceful degradation: failed operations return `{success: false, message: ...}`

### RAG Integration Patterns

**Semantic Search Enablement**:
- Always check `plugin.settings.enableSemanticSearch` before RAG operations
- Verify `plugin.vectorStore` exists before calling RAG methods
- Provide graceful fallback if RAG unavailable

**API Key Inheritance Chain**:
1. `plugin.settings.embeddingApiKey` (explicit embedding key)
2. `plugin.settings.providerSettings[provider]?.apiKey` (provider-specific key)
3. `plugin.settings.cloudApiKey` (main LLM API key)

## Testing Approach

**Automated Tests**:
```bash
npm test              # Run Vitest unit tests
npm run test:watch    # Watch mode
npm run test:coverage # With coverage report
npm run test:auto     # Run automated integration tests (no Obsidian required)
```

**Automated Integration Tests** (`scripts/automated-tests.js`, run by `npm run test:auto`):
- TypeScript compilation verification
- i18n completeness (every `Translations` key implemented in `en.ts` — English is the only locale since zh-cn was retired 2026-06)
- Template syntax validation (Bases `filters:` syntax)
- Filter injection logic (folder filtering for dashboards)
- Sanitization pipeline verification
- Settings defaults validation
- Command registration checks
- Import/export consistency

**Manual Testing**:
1. Build plugin: `npm run build`
2. Copy `main.js`, `manifest.json`, `styles.css` to Obsidian plugin folder:
   - **Deploy path**: `C:\obsidian\<vault-name>\.obsidian\plugins/ai-organiser/`
3. Reload Obsidian (Ctrl/Cmd+R or restart)
4. Test with various LLM providers and features

See `docs/usertest.md` for manual testing checklist.

## Deployment Verification ⚠️ CRITICAL

**Auto-deploy (since June 2026)**: `esbuild.config.mjs` copies `main.js`/`manifest.json`/`styles.css` to BOTH the Second Brain vault plugin folder AND `C:\Users\User\OneDrive\Across Devices\mobile` after every build (`npm run dev`/`build:quick`/`build`). Each target is parent-guarded (skipped silently on machines/CI without that path) and overridable via `AIORG_DEPLOY_TARGETS` (`;`-separated dirs). The manual steps below remain a fallback / for other machines.

**Always verify deployment after building.** Stale builds in the Obsidian vault cause confusion when changes appear not to work.

### Deploy Path
```
C:\obsidian\<vault-name>\.obsidian\plugins/ai-organiser/
```

### Required Files to Deploy
After `npm run build`, copy these files to the deploy path:
- `main.js` (required)
- `manifest.json` (required)
- `styles.css` (required)

### Verification Steps
After every build, verify the deployed files are current:

```bash
# Check repo build timestamp
ls -la main.js

# Check deployed file timestamp
ls -la "<vault>/.obsidian/plugins/ai-organiser/main.js"

# Deploy if timestamps don't match
cp main.js manifest.json styles.css "<vault>/.obsidian/plugins/ai-organiser/"
```

### Common Issue: Stale Builds
If changes don't appear after Obsidian restart:
1. Compare timestamps between repo and vault
2. Check file sizes match
3. Re-deploy all three files
4. Restart Obsidian completely (not just reload)

### Quick Deploy Command
```bash
npm run build && cp main.js manifest.json styles.css "<vault>/.obsidian/plugins/ai-organiser/"
```

### Mobile Deploy Staging
The OneDrive **mobile** folder (`C:\Users\User\OneDrive\Across Devices\mobile\`) is now populated **automatically** by the post-build deploy in `esbuild.config.mjs` (see Auto-deploy above) — no manual copy needed; files sync to phone/tablet via the OneDrive app. To also stage into the gitignored `docs/mobile/` (optional, manual):
```bash
cp main.js manifest.json styles.css docs/mobile/
cp main.js manifest.json styles.css "C:/Users/User/OneDrive/Across Devices/mobile/"
```
The `docs/mobile/` folder is gitignored. The OneDrive folder (`C:\Users\User\OneDrive\Across Devices\mobile\`) syncs automatically — files appear on phone/tablet via the OneDrive app. Copy these 3 files to `<vault>/.obsidian/plugins/ai-organiser/` on each mobile device.

## Code Organization Principles

### Modular Settings UI
Each settings section is a separate class extending `BaseSettingSection`. Add new sections by creating a class in `src/ui/settings/` and instantiating in `AIOrganiserSettingTab.ts`.

### Service Adapters
New cloud providers require:
1. Create adapter in `src/services/adapters/[provider]Adapter.ts`
2. Extend `BaseAdapter` (`baseAdapter.ts`) — there is no separate `CloudServiceAdapter` interface
3. Add to `AdapterType` type, `ALL_ADAPTERS` (`providerRegistry.ts`), and the `createAdapter()` switch in `index.ts`
4. Update settings UI dropdown
5. The adapter is automatically covered by `tests/adapterConformance.test.ts` (registry-driven — no test file edits needed). See [docs/adapter-conformance-contract.md](docs/adapter-conformance-contract.md) for the full derived contract.

### Command Pattern
Commands are isolated in `src/commands/` by category. New commands follow pattern:
```typescript
plugin.addCommand({
    id: 'unique-command-id',
    name: plugin.t.commands.commandName,
    icon: 'lucide-icon-name',
    callback: async () => { /* implementation */ }
});
```

## Critical Files for Modifications

- **Adding features**: Start with `src/main.ts` to understand plugin flow
- **Prompt changes**: Edit `src/services/prompts/` (tagPrompts, summaryPrompts, structuredPrompts)
- **UI modifications**: `src/ui/settings/AIOrganiserSettingTab.ts` and section files
- **New LLM providers**: `src/services/adapters/` and update `cloudService.ts`
- **Tag processing logic**: `src/utils/tagUtils.ts`
- **Note writes**: `src/services/noteEdit/applyNoteEdit.ts` — the only sanctioned write seam for commands (ESLint-enforced); `src/utils/editorUtils.ts` holds the low-level helpers it builds on
- **Integration prompts**: `src/services/prompts/integrationPrompts.ts`
- **RAG features**: `src/services/ragService.ts`, `src/services/vector/vectorStoreService.ts`
- **Semantic views**: `src/ui/views/RelatedNotesView.ts`
- **Bases integration**: `src/utils/frontmatterUtils.ts`, `src/services/migrationService.ts`, `src/services/dashboardService.ts`
- **Metadata handling**: `src/core/constants.ts`, `src/utils/responseParser.ts`
- **Translations**: `src/i18n/en.ts` (English-only; zh-cn retired 2026-06)
- **Logging**: `src/utils/logger.ts` — centralised Logger singleton (use `logger.debug/warn/error('Tag', msg)`)
- **Result type**: `src/core/result.ts` — `Result<T>` discriminated union for service boundaries
- **Event cleanup helper**: `src/ui/utils/domUtils.ts` — `listen()` helper for modal event listener cleanup
- **Modal conventions**: `src/ui/modals/_conventions.md` — standard lifecycle pattern for modals
- **API key resolution**: `src/services/apiKeyHelpers.ts` — `resolveSpecialistProvider()` + per-feature wrappers (pass `useMainKeyFallback: false` for a provider with no main-LLM equivalent)
- **Feature gating**: `src/core/features.ts` + `src/services/featureService.ts` — `isFeatureEnabled()` is the SSOT
- **Subsystem depth**: [`docs/features/`](docs/features/) — read the relevant file before changing a subsystem

## Git Remotes

This repo pushes to one remote:
- `origin` → Lbstrydom/ai-organiser (public)

Push to origin after committing:
```bash
git push origin main
```

## Version Management

Version is stored in three places (must stay in sync):
- `package.json` → `version`
- `manifest.json` → `version`
- `versions.json` → add new entry

Use `npm run version` to bump all three automatically via `version-bump.mjs`.

## ESLint (Obsidian Review Bot Compliance)

**Config**: `eslint.config.mjs` using `eslint-plugin-obsidianmd` with `recommendedWithLocalesEn` — matches the exact config the Obsidian review bot runs on PR submissions.

**Full bot rules reference**: [docs/obsidian-review-bot.md](docs/obsidian-review-bot.md)

Run `npm run lint` before submitting PRs. Key rules:
- `sentence-case` + `sentence-case-locale-module` — ALL UI strings and i18n values must be sentence case
- `no-static-styles-assignment` — use CSS classes, not `element.style.*`
- `no-tfile-tfolder-cast` — use `instanceof TFile` checks, not `as TFile`
- `prefer-file-manager-trash-file` — use `fileManager.trashFile()`, not `vault.delete()`
- `no-explicit-any` — use `unknown` + type guards (bot rejects eslint-disable for this rule)
- `no-misused-promises` / `no-floating-promises` — all promises awaited, caught, or voided
- `import/no-nodejs-modules` — use `desktopRequire()` helper (bot rejects eslint-disable)

The precommit script runs lint + full test suite: `npm run precommit`.

## Obsidian community-review compliance

The plugin is GPL-3.0 and passes the community review bot's automated scan with **zero blocking errors** (1.0.19). Invariants future changes MUST preserve:

- **`minAppVersion` is `1.11.4`** (manifest.json + versions.json) — the newest Obsidian API the code uses is `SecretStorage` (v1.11.4). The `obsidianmd/no-unsupported-api` ESLint rule is enabled (`eslint.config.mjs`) and reads `minAppVersion`; using an API newer than it is a lint error. If you adopt a newer API, bump `minAppVersion` to the version the rule reports.
- **No remote `<script>` injection.** Obsidian's bot flags `document.createElement("script")` (with or without `src`) as "dynamic script injection" — a blocking error. D3 is bundled (not CDN); the old `heic2any` CDN loader was removed. Don't reintroduce either.
- **The dead `setImmediate` `<script>` polyfill is neutralised at build time.** `jszip` (via `docx`/`pptxgenjs`) bundles an IE-era `setImmediate` polyfill that does `createElement("script")` (empty, no `src`, dead in Electron). The `neutralizeSetImmediateScriptPolyfill` esbuild plugin (`esbuild.config.mjs`) swaps it to `createElement("span")` **per-occurrence**, only at sites within 60 chars of the polyfill's `onreadystatechange` signature — so a genuine script-with-`src` loader (now or in a future dep) is left intact. Verify with `grep -c 'createElement("script")' main.js` → must be `0`. If you add a dep that legitimately creates a script element, the proximity guard protects it; don't broaden the swap.
- **Release attestation**: `.github/workflows/release.yml` builds via `npm ci` (needs `.npmrc` `legacy-peer-deps=true`) + `actions/attest-build-provenance`. Tag pushes (no `v` prefix) trigger it.
- **Disclosed, accepted warnings** (non-blocking): >5 MB bundle (single-file + local ONNX + export suite), `fs`/`child_process` (FFmpeg, desktop-gated), `eval`/`new Function` (bundled-dep polyfills), opt-in newsletter `setInterval`, transitive vuln deps (xlsx/jspdf/dompurify/@xmldom/protobufjs/ws).
- **Build-artifact-level invariants** (bundle content, version-file sync) are mechanically enforced by `scripts/verify-build.mjs`, run automatically inside `esbuild.config.mjs`'s production path (before the local auto-deploy step, so a failing check blocks deploy) on every `build`/`build:quick`; also available standalone via `npm run verify:build`. See [docs/build-invariants.md](docs/build-invariants.md) for what each check verifies, why, and the commit where it was learned.

## Obsidian API Quirks

Subtle Obsidian-API behaviours that the review bot and TypeScript do NOT catch. Follow these conventions to avoid regressions.

### `ButtonComponent.setIcon()` clobbers button text

Both `setIcon(name)` and `setButtonText(text)` overwrite the button's inner DOM — the one called LAST wins. Chaining `.setButtonText('Import file').setIcon('file-up')` produces an icon-only button with no visible label.

**Convention: call `setIcon()` BEFORE `setButtonText()`.** Text wins and is visible; the icon is lost, but text is the critical discoverability signal — an icon-only button is useless for first-time users who can't hover to see a tooltip.

```typescript
// ❌ Wrong — renders icon-only, empty label
new ButtonComponent(el)
    .setButtonText(t.importFile)
    .setIcon('file-up')
    .setCta();

// ✅ Right — text visible, icon sacrificed
new ButtonComponent(el)
    .setIcon('file-up')
    .setButtonText(t.importFile)
    .setCta();
```

If you genuinely need an icon + text in one button, skip the chain and build the DOM:
```typescript
const btn = new ButtonComponent(el).setButtonText(text);
const iconEl = btn.buttonEl.createSpan();
setIcon(iconEl, 'file-up');
btn.buttonEl.prepend(iconEl);
```

Caught via persona round 5: Kindle Sync modal rendered two empty-label buttons ("" + "" instead of "Import file" + "Sync from amazon"). Six buttons across four files were affected (KindleSyncModal, KindleLoginModal, SemanticSearchSettingsSection, BasesSettingsSection).

## File Format Conventions

This plugin generates `.canvas`, `.base`, and `.md` files. All implementations align with official Obsidian conventions. See [docs/format-specs.md](docs/format-specs.md) for the full audited compliance checklist.

### Authoritative Specs

- **JSON Canvas 1.0**: https://jsoncanvas.org/spec/1.0/
- **Obsidian Agent Skills** (kepano): https://github.com/kepano/obsidian-skills
- **Agent Skills Spec**: https://agentskills.io/specification

### For AI Agents

Install the official Obsidian Agent Skills for format reference when working with Obsidian vault files:
```
/plugin marketplace add kepano/obsidian-skills
```

### Key Convention Rules

- **Canvas IDs**: 16-char lowercase hex via `crypto.getRandomValues` with base36 fallback (see `canvasUtils.ts`)
- **Canvas colors**: Preset strings `'1'`-`'6'`, never hex colors
- **Canvas spacing**: `NODE_GAP` 60px (spec range 50-100), `GROUP_PADDING` 40px (spec range 20-50)
- **Bases filters**: Always use `filters:` (plural), `file.inFolder()`, `and:`/`or:` operators
- **Markdown**: Standard Obsidian Flavored Markdown (OFM) syntax only

---

## UI/UX Design Principles

Apply consistently across all UI: settings, modals, sidebars, command palettes.

### Gestalt Principles

- **Proximity**: Group related items (settings under parent features, commands by workflow)
- **Similarity**: Consistent styling (icons, headers, spacing) for similar elements
- **Common Region**: Visual containers (header levels, borders) to group related items
- **Continuity**: Logical flow — setup -> core -> advanced -> preferences

### Organize by user mental model, not implementation

Settings run setup -> core -> advanced -> preferences -> config; the command picker is
anchored on the workflow stage the user is in, not on the code that implements it. The
concrete group-by-group map, the collapsible mechanics and the picker's construction
live in [platform](docs/features/platform.md#settings-ui-map).

**Modal sections**: inputs first -> options -> actions last.

### Visual Hierarchy

- `<details>/<summary>` for collapsible top-level containers
- `h1` + icon for main sections (`createSectionHeader(title, icon, 1)`), hidden inside collapsibles via CSS
- `h2` + icon for subsections; plain `h4` for group labels
- **Icons**: every section and command needs a contextual Lucide icon; `sparkles` for AI actions
- **Buttons**: primary = `mod-cta`, destructive = `mod-warning`

### Async Rendering

Await async `display()` methods so section order is deterministic:

```typescript
await this.summarizationSection.display();  // Correct
```

### Modal UX

- **Dependency-first**: Documents -> Dictionary -> Audio (extract terms before transcription)
- **Inline controls**: place actions next to the items they affect (Gestalt proximity)
- **Progressive disclosure**: collapse advanced options

## Known Constraints

- Obsidian API externals must match platform version (defined in `esbuild.config.mjs`)
- TypeScript compilation is strict mode with ES2020 target
- D3.js is **bundled** as submodules (`d3-selection`/`d3-force`/`d3-drag`/`d3-zoom`) for the tag-network view — **never** CDN-loaded. Obsidian's review bot blocks remote `<script>` injection; do NOT reintroduce a CDN `<script>` loader (or a `heic2any`-style runtime script fetch). See "Obsidian community-review compliance".
- Interface language change requires Obsidian restart (output languages do not)
- Tag formatting preserves `/` for nested tags but converts other special chars to hyphens
- Claude/Anthropic has no embeddings API (use Voyage AI instead)
- URL detection may include trailing punctuation (e.g., `https://example.com.` includes the period) - documented limitation in tests

## CSS Conventions

- Use `ai-organiser-*` prefix for all CSS classes
- Modal styles in `styles.css`
- Settings section styles follow Obsidian conventions

## Mobile Considerations

Use `Platform.isMobile` from Obsidian API to detect mobile environment:

```typescript
import { Platform } from 'obsidian';

if (Platform.isMobile) {
    // Mobile-specific behavior
}
```

Key mobile constraints:
- `localhost` URLs fail (points to phone, not desktop)
- Limited RAM (~2-6GB shared)
- Vault-only file access (no external files)
- Touch interaction (sidebars are awkward)
- Battery drain from background operations

Mobile settings section in plugin settings provides:
- Tri-state provider mode (auto/cloud-only/custom)
- Fallback provider selection
- Index size limits and read-only mode
- Custom endpoint for home servers

## Documentation

**Subsystem detail** lives in [`docs/features/`](docs/features/) — see
[Feature Subsystems](#feature-subsystems) for the index. Everything else:

| Doc | What it covers |
|---|---|
| [docs/architecture-map.md](docs/architecture-map.md) | Generated symbol index — start here to find an existing symbol before writing a new one |
| [docs/adapter-conformance-contract.md](docs/adapter-conformance-contract.md) | The contract every LLM adapter is tested against |
| [docs/build-invariants.md](docs/build-invariants.md) | What `scripts/verify-build.mjs` checks, and why each check exists |
| [docs/brand-setup.md](docs/brand-setup.md) | User guide for the vault brand pack |
| [docs/azure-test-plan.md](docs/azure-test-plan.md) | Azure provider verification plan |
| [docs/requirements-map.md](docs/requirements-map.md) | Requirement -> implementation mapping |
| [docs/features-overlap.md](docs/features-overlap.md) | Where features overlap, and why they stay separate |
| [docs/dependency-accepted-risks.md](docs/dependency-accepted-risks.md) | Transitive vulnerabilities accepted, with reasoning |
| [status.md](status.md) | Session log — what shipped, when, and how it was verified |

Plan documents (`docs/plans/`, `docs/completed/`) are **gitignored by design** — they
carry working detail and are not distributed. Links to them from inside `docs/features/`
resolve only in a working checkout; that is expected, not rot.
