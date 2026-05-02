# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

> **Note:** This is the canonical reference for all AI coding agents. Keep in sync with `CLAUDE.md`.

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

### Service Layer Architecture

**LLM Services** (`src/services/`)
- **Base abstractions**: `LLMService` interface defines contract for all providers
- **Two service types**:
  - `LocalLLMService`: Ollama, LM Studio, LocalAI, OpenAI-compatible endpoints
  - `CloudLLMService`: Cloud providers (OpenAI, Claude, Gemini, Groq, etc.)
- **Adapter pattern** (`src/services/adapters/`): Each cloud provider has its own adapter (e.g., `claudeAdapter.ts`, `geminiAdapter.ts`) handling API-specific formatting
- **Prompt engineering** (`src/services/prompts/`): XML-structured prompts optimized for Claude/GPT

**Key service flow**:
1. Plugin calls `llmService.analyzeTags(content, candidateTags, mode, maxTags, language)`
2. Service builds prompt via `buildTagPrompt()` with mode-specific instructions
3. For cloud: Adapter formats request → calls API → parses response
4. Returns `LLMResponse` with `suggestedTags` and `matchedExistingTags`

### Provider Registries

**LLM Provider Registry** (`src/services/adapters/providerRegistry.ts`):
- `ALL_ADAPTERS`: List of all 14 supported adapter types
- `PROVIDER_DEFAULT_MODEL`: Default model per provider
- `PROVIDER_ENDPOINT`: Default API endpoint per provider
- `buildProviderOptions(t)`: Generate dropdown options from translations

**Embedding Provider Registry** (`src/services/embeddings/embeddingRegistry.ts`):
- `EMBEDDING_DEFAULT_MODEL`: Default model per embedding provider (6 providers)
- `EMBEDDING_MODELS`: Available models per provider
- `getEmbeddingModelOptions(provider)`: UI-friendly labeled options

### Settings & Configuration

**Settings schema** (`src/core/settings.ts`):
- `AIOrganiserSettings` interface with 35+ configuration options
- Key settings: `serviceType`, `cloudServiceType`, `interfaceLanguage`, `enableSemanticSearch`, `embeddingProvider`
- Settings UI split into modular sections (`src/ui/settings/`), wrapped in 10 collapsible `<details>/<summary>` groups:
  - `LLMSettingsSection`: Service provider configuration, API keys, Getting Started info box
  - `SpecialistProvidersSettingsSection`: Dedicated providers for YouTube, PDF, Audio, Flashcards
  - `TaggingSettingsSection`: Max tags, folder exclusions, note structure toggle, taxonomy guardrail
  - `InterfaceSettingsSection`: Interface language, output languages
  - `SummarizationSettingsSection`: Summary style, personas, transcript options
  - `AudioTranscriptionSettingsSection`: Audio recording, transcription settings
  - `DigitisationSettingsSection`: Smart digitisation mode, image quality
  - `SketchSettingsSection`: Sketch pad output, auto-digitise, pen defaults
  - `MinutesSettingsSection`: Meeting minutes output, timezone, personas, GTD overlay
  - `SemanticSearchSettingsSection`: Embeddings, indexing, RAG settings
  - `KindleSettingsSection`: Kindle output folder, highlight style, sync options
  - `MermaidChatSettingsSection`: Mermaid chat context, staleness, alt-text, export options
  - `CanvasSettingsSection`: Canvas output, edge labels, LLM clustering
  - `BasesSettingsSection`: Structured metadata, migration
  - `NotebookLMSettingsSection`: NotebookLM export settings
  - `ExportSettingsSection`: Document export (flashcards, export theme: colour scheme, font, size)
  - `InterfaceSettingsSection`: Interface language, tag output language, summary language
  - `MobileSettingsSection`: Mobile provider mode, fallback settings
  - `ConfigurationSettingsSection`: Config files management

**Settings persistence**: Loaded in `loadSettings()`, saved via `saveSettings()`, triggers service reinitialization.

**Settings migration** (`src/core/settings.ts`):
- `migrateOldSettings()`: Pure function migrating old settings to current schema
- Called from `loadSettings()` in `main.ts` — all migrations in one testable function
- Handles: `ollama`→`local`, tag range→`maxTags`, `student`→`brief`, 5 retired minutes persona IDs→`standard`/`governance`, summary length rename (`comprehensive`→`detailed`→`standard`, order-safe)

### Internationalization (i18n)

**Translation system** (`src/i18n/`):
- Supported languages: English (`en.ts`) and Simplified Chinese (`zh-cn.ts`)
- Type-safe translations via `Translations` interface
- Access translations: `this.t.settings.someKey` or `plugin.t.messages.someMessage`
- Interface language change requires Obsidian restart

**Adding new i18n strings**:
1. Add to `Translations` interface in `types.ts`
2. Implement in both `en.ts` and `zh-cn.ts`
3. Reference via `t.section.key` in code

### Tag Utilities & Operations

**Core utilities** (`src/utils/tagUtils.ts`):
- `TagUtils.formatTags()`: Sanitizes tags (removes prefixes, enforces kebab-case)
- `TagUtils.updateNoteTags()`: Modifies frontmatter YAML, handles merge vs replace
- `TagUtils.getAllTags()`: Extracts all tags from vault frontmatter
- `TagUtils.getTagsFromFile()`: Reads predefined tags from markdown file

**Tag formatting rules**:
- Remove `#` prefix and malformed prefixes (`tag:`, `matchedExistingTags-`, etc.)
- Convert to kebab-case (spaces/special chars → hyphens)
- Preserve `/` for nested tags (e.g., `science/biology`)

### RAG & Semantic Search

**Vector Store** (`src/services/vector/`):
- `VoyVectorStore`: Production vector storage using Voy WASM
- `IVectorStore` interface for vector operations
- Chunk-based indexing with configurable size and overlap

**RAG Service** (`src/services/ragService.ts`):
- `RAGService.getRelatedNotes()`: Semantic note discovery
- `RAGService.retrieveContext()`: Context retrieval for RAG
- `RAGService.buildRAGPrompt()`: Enhanced prompt building with vault context
- `RAGService.formatSources()`: Source citation formatting

**Embedding Services** (`src/services/embeddings/`):
- **IEmbeddingService interface** with `generateEmbedding()`, `batchGenerateEmbeddings()`
- **5 Embedding Providers**:
  - **OpenAI** - text-embedding-3-small/large (1536/3072 dims)
  - **Ollama** - nomic-embed-text, mxbai-embed-large (local)
  - **Gemini** - text-embedding-004 (768 dims)
  - **Cohere** - embed-english-v3.0 (1024 dims)
  - **Voyage AI** - voyage-3/voyage-3-lite (high quality)
- **Factory pattern**: `createEmbeddingServiceFromSettings()` handles API key inheritance
- **Note**: Claude/Anthropic does NOT have an embeddings API - use Voyage AI instead

**Semantic Search Modal** (`src/commands/semanticSearchCommands.ts`):
- `SemanticSearchResultsModal`: Main search interface with multi-select and export
- **Selection Features**:
  - Checkboxes on each result for multi-select
  - "Select All" / "Deselect All" toggle in header
  - Selection count badge (live updates)
  - "Export Selected" button (disabled when none selected)
- **Export Functionality**:
  - `ExportSearchResultsModal`: Export selected results to notes
  - Target options: New note (with folder picker) or existing note
  - Format options: Links only or links with excerpts (1-line blockquotes)
  - Auto-opens new note after export
  - Appends to existing note with timestamp header

**Related Notes View** (`src/ui/views/RelatedNotesView.ts`):
- Persistent sidebar ItemView showing semantically similar notes
- Auto-updates with 500ms debounce on note switch
- Interactive features: click navigation, hover preview, copy markdown link
### Obsidian Bases Integration

**Overview**: Structured metadata system enabling dashboard views through Obsidian Bases plugin.

**Core Components** (`src/core/`, `src/utils/`, `src/services/`):
- `constants.ts`: AIO_META namespace with simple property names (`summary`, `source_url`, etc.)
- `frontmatterUtils.ts`: CRUD operations for metadata (updateAIOMetadata, getAIOMetadata, createSummaryHook)
- `structuredPrompts.ts`: JSON-structured prompts for LLMs (StructuredSummaryResponse interface)
- `responseParser.ts`: 4-tier fallback JSON parsing (direct parse → code fence → object search → plain text)

**Migration System** (`src/services/migrationService.ts`, `src/ui/modals/MigrationModal.ts`):
- Analyzes vault scope (needsMigration vs alreadyMigrated counts)
- Extracts summaries from note body (##Summary, ##TL;DR, first paragraph)
- Determines status from existing tags (processed vs pending)
- Auto-detects content type from keywords (research, meeting, project, reference)
- 4-stage modal UI: Analysis → Options → Progress → Results

**Dashboard Generation** (`src/services/dashboardService.ts`, `src/services/configurationService.ts`):
- Single "Notes Dashboard" template for simplicity
- Template structure: YAML with `filters:` (plural), `columns:`, optional `sorting:`
- `injectFolderFilter()`: Auto-adds `file.inFolder("path")` for folder scoping
- DashboardCreationModal as simple confirmation dialog
- Dashboard created via right-click folder context menu

**Settings Integration** (`src/ui/settings/BasesSettingsSection.ts`):
- 3 toggle settings: enableStructuredMetadata, includeModelInMetadata, autoDetectContentType
- Quick action buttons: Migrate (launches migration modal), Create Dashboards (launches dashboard modal)
- Info box with usage guidance

**Summarization Integration** (`src/commands/summarizeCommands.ts`):
- Conditional structured output: if `enableStructuredMetadata` → use `buildStructuredSummaryPrompt()`, else traditional
- Parses JSON response → extracts body_content, summary_hook, suggested_tags, content_type
- Updates frontmatter with `updateNoteMetadataAfterSummary()` after URL/PDF/YouTube summarization
- Tracks source type and URL for web content

**Commands** (`src/commands/migrationCommands.ts`, `src/commands/dashboardCommands.ts`):
- `ai-organiser:upgrade-metadata` - Migrate entire vault
- `ai-organiser:upgrade-folder-metadata` - Migrate current folder
- `ai-organiser:create-bases-dashboard` - Launch dashboard creator

**Key Patterns**:
- **Simple property names**: Metadata uses clean, user-friendly names (`summary`, `source_url`) for readability
- **Minimal metadata**: Only essential fields stored by default (summary hook and source URL)
- **280-char summaries**: Optimized for Bases preview pane, truncates at sentence boundaries
- **Graceful degradation**: Works without Bases plugin (metadata still useful for Dataview, search)
- **Type safety**: ContentType, StatusValue, SourceType enums in constants.ts
- **Bilingual**: Complete EN + ZH-CN translations for all UI elements

**Integration Points**:
- Tag generation: Suggested tags from structured responses added to frontmatter
- Semantic search: Content type filters improve RAG context retrieval
- Smart summarization: Auto-detects source type based on input (URL → 'url', PDF → 'pdf')
### Tag Network Visualization

**Implementation** (`src/ui/views/TagNetworkView.ts`):
- Custom Obsidian `ItemView` for graph visualization
- Dynamically loads D3.js v7 from CDN
- Network data built by `TagNetworkManager` (`src/utils/tagNetworkUtils.ts`)
- Interactive features: search filtering, hover tooltips, node dragging

## Command Registration

Commands registered in `src/commands/`:
- `generateCommands.ts`: Tag generation for notes/folders/vault
- `clearCommands.ts`: Clear tags from notes/folders/vault
- `summarizeCommands.ts`: URL/PDF/YouTube/Audio summarization + audio recording command
- `translateCommands.ts`: Note, selection, and multi-source translation
- `smartNoteCommands.ts`: Improve note, find resources, diagrams, mermaid chat
- `integrationCommands.ts`: Pending content integration with placement/format/detail strategies
- `minutesCommands.ts`: Meeting minutes generation + Word document export
- `canvasCommands.ts`: Investigation, Context, and Cluster Board canvas generation
- `chatCommands.ts`: Highlight chat (chat about highlights)
- `flashcardCommands.ts`: Flashcard export (Anki/Brainscape)
- `digitisationCommands.ts`: Smart digitisation of images (handwriting, diagrams, whiteboards)
- `sketchCommands.ts`: Built-in sketch pad with perfect-freehand
- `kindleCommands.ts`: Kindle highlights sync (My Clippings.txt import)
- `embedScanCommands.ts`: Find embeds / vault hygiene scan
- `quickPeekCommands.ts`: Quick Peek fast triage for embedded sources
- `utilityCommands.ts`: Collect tags, tag network

All commands use `plugin.addCommand()` with i18n names and icon support.

**Command Picker Categories** (`CommandPickerModal.ts`) — output-anchored, two-layer (locked 2026-05-02):
```
Essentials   ← User-configurable favourites (max 5; default = Chat / Search / Quick peek)
Create       ← Outputs (verb-anchored sub-groups + 3 direct leaves):
               • Write       (summarize, minutes, translate, export note, export minutes)
               • Visualise   (presentation, diagram, sketch, 3 canvas variants)
               • Audio narration / Flashcards / Tags (direct leaves)
Refine       ← Mutations on existing notes (improve, integrate, digitise, etc.)
Find         ← Search (chat + semantic-search at top via cross-listing) +
               • Discover    (web reader, research, find related, insert related)
               • Audit vault (find embeds, tag network, collect tags)
Manage       ← Recurring + admin: Kindle, Newsletter, recording, dashboards,
               metadata migration, NotebookLM export
```

**User-configurable Essentials** (added 2026-05-02): `settings.pickerEssentialsCommandIds` (max 5). Empty = static defaults. UI in *Settings → Language → Quick commands* — pick from any leaf via FuzzySuggestModal. Selected leaves keep cross-listing identity (same `PickerCommand` object reference), so search dedup still works.

**Sub-grouping**: only Create + Find. Refine and Manage stay flat (≤ 8 leaves each). Sub-group labels are action-verbs (`Write`, `Visualise`, `Discover`, `Audit vault`) — sub-groups collapse by default; user expands via chevron click.

**Cross-listing**: Chat / Vault search / Quick peek live in Essentials AND in Find / Refine. Browse mode renders both placements; search mode dedupes by `command.id` and shows the canonical (Essentials) chip via `canonicalCategoryId`.

**Requirement gating**: Each leaf declares `requires?: RequirementKind` (`'none' | 'active-note' | 'selection' | 'vault' | 'semantic-search'`). The picker renders an orange chip + dims the row + intercepts clicks with a Notice when the precondition isn't met. Built into `pickerRequirements.ts` with a minimal `RequirementContext` (no Obsidian `App` dependency — fully unit-testable). Context is rebuilt per render AND per click — no cache leak across the boundary.

**Backward-compat search**: Each leaf optionally declares `legacyHomes: string[]` (e.g. `'active-note-export'`); the helper auto-derives legacy aliases (`'active note'`, `'export'`) so users who learned the old taxonomy still find moved commands.

**Command Picker Architecture**: Custom `Modal` (not FuzzySuggestModal) with inline tree expansion. Pure view-model logic in `commandPickerViewModel.ts` (`buildVisibleItems`, `flattenSingleChildGroups`, `buildSearchResults` with explicit canonical-placement reduce). Browse mode = expandable tree; search mode = flat deduplicated results via `prepareFuzzySearch()`. 38 unique commands surfaced (41 picker rows including 3 cross-listings). All commands have i18n descriptions shown on highlight.

## AI Chat + Presentation Builder

**Status**: ✅ Implemented (March 2026)

AI free-form chat inside `UnifiedChatModal`.

### Core Components

- `src/ui/chat/FreeChatModeHandler.ts`: Main handler for AI Chat, attachments, On-brand toggle, slides mode, build actions, and export flow
- `src/services/chat/presentationService.ts`: Phase 2 pipeline — generate → brand audit → layout audit → refine
- `src/services/chat/presentationAuditService.ts`: Deterministic audit execution and repair retry handling
- `src/services/chat/presentationTypes.ts`: `DeckModel`, `AuditFinding`, `BuildState`, `PresentationSnapshot`, and related contracts
- `src/services/prompts/presentationPrompts.ts`: Slide generation, audit, refinement, attachment packing, and brand-guideline prompts
- `src/ui/settings/AIChatSettingsSection.ts`: AI Chat settings UI

### Key Patterns

- **Model routing**: Opus reasoning for generation/refinement, non-reasoning Sonnet for audits
- **Handler-owned UI**: attachments and stateful actions live in `FreeChatModeHandler`, not the modal
- **Single deck model**: exports and refinement operate on the same normalized `DeckModel`
- **No streaming**: build progress shown as sequential state updates

### Tests

- `tests/freeChatModeHandler.test.ts`
- `tests/presentationTypes.test.ts`
- `tests/presentationPrompts.test.ts`
- `tests/presentationAuditService.test.ts`
- `tests/presentationService.test.ts`
- `tests/presentationExport.test.ts`
- `tests/brandedPptx.test.ts`

**Plan**: [docs/completed/pres-plan.md](docs/completed/pres-plan.md)

## Smart Document Indexing (AI Chat)

**Status**: ✅ Implemented (March 2026)

RAG-based large attachment handling for AI Chat. When attachments exceed `MAX_ATT_CHARS`, users choose: create a project (persistent vault notes + vector index), chat temporarily (ephemeral in-memory index), or truncate (legacy behavior).

### Core Components

**AttachmentIndexService** (`src/services/chat/attachmentIndexService.ts`):
- Single-flight indexing: chunk → batch embed → cosine similarity retrieval
- `query(text, topK)`: Returns top-K relevant chunks per user message
- `isPartial` / `totalChunks` getters for partial-success tracking (some embedding batches failed)
- `dispose()`: Cleanup for ephemeral indexes on modal close
- Inline cosine similarity (no VoyVectorStore dependency — simpler for per-attachment scope)

**IndexingChoiceModal** (`src/ui/modals/IndexingChoiceModal.ts`):
- Promise-based 3-choice modal: project / temporary / truncate
- Shown when attachment exceeds `MAX_ATT_CHARS`

**FreeChatModeHandler** (`src/ui/chat/FreeChatModeHandler.ts`):
- `handleLargeAttachment()`: Orchestrates choice → indexing → project persistence
- `ProjectIndexRequest` interface + `onProjectIndexRequest` callback for cross-boundary project operations
- `notifyRerender()`: Triggers UI refresh after background rehydration
- Partial pill display: `indexingPillPartial` shows `{actual}/{total} chunks` when `isPartial`
- `isProjectActive` detection via `this.projectInstructions !== null` (type-safe)

**UnifiedChatModal** (`src/ui/modals/UnifiedChatModal.ts`):
- `handleProjectIndexRequest()`: Creates/uses project, delegates to `ProjectService.saveIndexedDocument()`
- `rehydrateIndexedDocuments()`: Re-indexes from vault notes on project load, calls `notifyRerender()`

**ProjectService** (`src/services/chat/projectService.ts`):
- `saveIndexedDocument()`: Creates vault note at `{project.folderPath}/indexed/{sanitizedFilename}.md`
- `appendIndexedDocumentManifest()`: Appends entry to `## Indexed Documents` section in `_project.md`
- Path collision handling with incrementing suffix

### Key Patterns

- **Callback pattern**: Handler → Modal delegation via `FreeChatCallbacks.onProjectIndexRequest` (handler lacks ProjectService access)
- **Partial-success tracking**: `totalChunks` vs `chunkCount` detects embedding batch failures; UI shows warning-tinted pill
- **Rehydration**: Project load reads manifest → re-reads vault notes → re-indexes → `notifyRerender()`
- **Ephemeral cleanup**: `dispose()` on modal close for temporary indexes
- **No VoyVectorStore**: Inline cosine similarity avoids WASM dependency for per-attachment scope

### Tests

- `tests/attachmentIndexService.test.ts` (19 tests): Indexing pipeline, retrieval, partial success
- `tests/indexingChoiceModal.test.ts` (8 tests): Modal choices, promise resolution

### CSS

- `.ai-organiser-free-chat-att-pill.is-indexed`: Accent left border for indexed pills
- `.ai-organiser-free-chat-att-indexed.is-partial`: Warning-tinted text for partial indexing

**Plan**: Completed (see CLAUDE.md "Free Chat & Smart Document Indexing" section)

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

**Automated Integration Tests** (`tests/automated-tests.js`):
- TypeScript compilation verification
- i18n completeness (EN/ZH structure parity)
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
After every build, also copy to `docs/mobile/` and the OneDrive Basket so the latest artifacts are easily accessible for manual transfer to mobile devices (Obsidian Sync does not sync plugin files):
```bash
cp main.js manifest.json styles.css docs/mobile/
cp main.js manifest.json styles.css "C:/Users/User/OneDrive/Across Devices/Basket/"
```
The `docs/mobile/` folder is gitignored. The OneDrive Basket (`C:\Users\User\OneDrive\Across Devices\Basket\`) syncs automatically — files appear on phone/tablet via the OneDrive app. Copy these 3 files to `<vault>/.obsidian/plugins/ai-organiser/` on each mobile device.

## Code Organization Principles

### Modular Settings UI
Each settings section is a separate class extending `BaseSettingSection`. Add new sections by creating a class in `src/ui/settings/` and instantiating in `AIOrganiserSettingTab.ts`.

### Service Adapters
New cloud providers require:
1. Create adapter in `src/services/adapters/[provider]Adapter.ts`
2. Implement `CloudServiceAdapter` interface
3. Add to `AdapterType` type and `adapters` map in `index.ts`
4. Update settings UI dropdown

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
- **Editor insertion**: `src/utils/editorUtils.ts` (insertAtCursor, appendAsNewSections)
- **Integration prompts**: `src/services/prompts/integrationPrompts.ts`
- **RAG features**: `src/services/ragService.ts`, `src/services/vector/vectorStoreService.ts`
- **Semantic views**: `src/ui/views/RelatedNotesView.ts`
- **Bases integration**: `src/utils/frontmatterUtils.ts`, `src/services/migrationService.ts`, `src/services/dashboardService.ts`
- **Metadata handling**: `src/core/constants.ts`, `src/utils/responseParser.ts`
- **Translations**: `src/i18n/en.ts` and `src/i18n/zh-cn.ts`
- **Logging**: `src/utils/logger.ts` — centralised Logger singleton (use `logger.debug/warn/error('Tag', msg)`)
- **Result type**: `src/core/result.ts` — `Result<T>` discriminated union for service boundaries
- **Event cleanup helper**: `src/ui/utils/domUtils.ts` — `listen()` helper for modal event listener cleanup
- **Modal conventions**: `src/ui/modals/_conventions.md` — standard lifecycle pattern for modals
- **API key resolution**: `src/services/apiKeyHelpers.ts` — `resolveSpecialistProvider()` + per-feature wrappers

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

## Large-Content Ingestion — Quality-Aware Chunking

**Status**: ✅ Implemented (April 2026)

**Plan**: [docs/completed/large-content-ingestion.md](docs/completed/large-content-ingestion.md)

Replaces scattered `isContentTooLarge` checks + flat map-reduce summarization with a quality-aware chunking pipeline. Fixes the "2-hour meeting crashes" user report by bumping `CHUNK_TOKEN_LIMIT` from 6000 → 12000 (halves call count for long meetings) and introducing hierarchical map-reduce for non-minutes content.

### Key components

| File | Purpose |
|---|---|
| [src/services/contentSizePolicy.ts](src/services/contentSizePolicy.ts) | Single source of truth for quality thresholds (40K/48K/192K chars per content type) + fast-model capability check + `estimateCharsPerToken()` heuristic (Latin/CJK/code) |
| [src/services/chunkingOrchestrator.ts](src/services/chunkingOrchestrator.ts) | Generalised hierarchical map-reduce with rolling `continuationContext` between chunks + per-chunk error isolation (no `[Error summarizing section N]` markers in output) |
| [src/core/constants.ts:64](src/core/constants.ts#L64) | `CHUNK_TOKEN_LIMIT = 12_000` (bumped from 6000) |
| [src/services/minutesService.ts:111-125](src/services/minutesService.ts) | `EXTRACTION_OPTIONS.maxTokens = 8192` (up from 4096); `MERGE_OPTIONS.maxTokens = 12288` (up from 4096); `overlapChars = 1000` (up from 500) |
| [src/commands/summarizeCommands.ts:1615,1676,2094](src/commands/summarizeCommands.ts) | Quality-threshold auto-chunking: URL / text / audio transcripts above ~40K chars auto-route to `summarizeInChunks` instead of one-shot |

### Chunking strategy by content type

| ContentType | Auto-chunk above | Hierarchical reduce above |
|-------------|-----------------|--------------------------|
| `summarization` | 40 000 chars | 120 000 chars (4+ chunks) |
| `minutes` | 48 000 chars | 192 000 chars (4+ chunks) |
| `document` | 40 000 chars | 120 000 chars |

### Fast-model routing

When `useHaikuForFastTasks = true` AND provider is `claude`, map-phase calls use `latest-haiku` (cheap + fast); reduce-phase uses the main model. Non-Claude providers fall back to main model for both phases (graceful degradation).

### Tests

- `tests/contentSizePolicy.test.ts` — 21 tests (assessment, threshold resolution, fast-model gating, char-per-token heuristics)
- `tests/chunkingOrchestrator.test.ts` — 10 tests (map/reduce flow, continuation context, per-chunk error isolation, hierarchical batching, single-chunk short-circuit)

## ProgressReporter — Universal Progress Indicator

**Status**: ✅ Infrastructure + hot-list migration delivered (April 2026)

**Plan**: [docs/completed/progress-reporter.md](docs/completed/progress-reporter.md)

Unifies progress UX across LLM-calling code paths via one typed, phase-aware helper. Replaces the prior mix of `busyIndicator` (status bar only), `executeWithNotice` (one-shot toasts), and ad-hoc `new Notice(msg, 0) + setMessage()` copy-pasted across 8+ files.

### API

```typescript
import { withProgress, withProgressResult, ProgressReporter } from 'src/services/progress';

// Canonical call-site pattern
const r = await withProgress(
    { plugin, initialPhase: { key: 'working' }, resolvePhase: (p) => plugin.t.progress.foo[p.key] },
    async (reporter) => {
        reporter.setPhase({ key: 'fetching', params: { current: 1, total: 5 } });
        return await doWork();
    },
);
if (!r.ok) return; // reporter fired the toast — caller does NOT
use(r.value);
```

- **Three surfaces**: status-bar broker ticket (ambient) + persistent Notice (primary) + optional host-inline modal label
- **Terminal states**: `succeed() | fail(err) | cancel() | timedOut(ms)` — reporter owns all notifications
- **Typed phases**: `TKey` union narrowed to per-flow vocabulary; i18n-gated via `plugin.t.progress.{flow}.{phase}`
- **Cancellation**: optional `AbortController` → Cancel button in Notice; `reporter.signal` propagated to downstream work
- **Cancel sentinel**: `{ ok: false, error: 'cancelled' }` routes to neutral "Cancelled" toast, not red "Failed"
- **Stable DOM**: build once, mutate `.textContent` + CSS var; no focus loss, no listener leaks
- **Heartbeat watchdog**: 30s passive ping keeps status bar alive across long single-phase work; 3min leak protection

### Migrated flows (PR 2)

| Flow | Location | Pattern |
|---|---|---|
| Smart note — diagram + improve | [smartNoteCommands.ts:230](src/commands/smartNoteCommands.ts) | `withProgress<Phase>` with phase transitions |
| Newsletter — fetch + audio regen | [newsletterCommands.ts:43](src/commands/newsletterCommands.ts) | `withProgress` with per-item `triaging` phase |
| Multi-source summarize | [summarizeCommands.ts:449](src/commands/summarizeCommands.ts) | Persistent Notice + `setMessage` + `hideProgress()` on all exits |
| Multi-source translate | [translateCommands.ts:322](src/commands/translateCommands.ts) | Same pattern |
| Integration — resolve + merge | [integrationCommands.ts:148](src/commands/integrationCommands.ts) | Persistent Notice + `setMessage` + finally-hide |
| YouTube summarize (pre-existing) | [summarizeCommands.ts:2277](src/commands/summarizeCommands.ts) | Ad-hoc persistent Notice (fixed April 2026) |

### Intentionally deferred (plan §11 Out of Scope)

- Kindle sync — already has modal-internal progress callback
- Presentation builder — already uses `GenerationProgressController` with phases
- Flashcards / canvas / generate / digitisation — already using correct ad-hoc pattern; cosmetic consolidation deferred to avoid regression risk
- `ChatModeHandler`/`FreeChatModeHandler` — modal-internal progress already good
- `embedScanCommands` custom progress-bar DOM — battle-tested
- Per-flow `ProgressPhase` unions — defined inline at each call site

### Tests

- `tests/progressReporter.test.ts` — 21 tests (state machine, surfaces, terminals, normalizeError)
- `tests/withProgress.test.ts` — 17 tests (Result contract, cancel sentinel, toast ownership)
- `tests/transcriptSanitizer.test.ts` — 8 tests (paste sanitizer for Minutes)

### Transcript paste sanitizer (April 2026 hotfix)

User pasted Office 365 HTML into Minutes transcript field → hundreds of `file:///…/msohtmlclip1/…/clip_imageXXX.gif` references survived to LLM output note → Obsidian CSP blocked each one → UI freeze. Fix: [src/utils/transcriptSanitizer.ts](src/utils/transcriptSanitizer.ts) strips file:// refs + markdown image syntax + bare clip_imageNNN tokens on paste (input) AND in `renderMinutesFromJson` output (belt-and-braces).

## Known Constraints

- Obsidian API externals must match platform version (defined in `esbuild.config.mjs`)
- TypeScript compilation is strict mode with ES2020 target
- D3.js loaded dynamically from CDN (no bundling) for network visualization
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

## UI/UX Design Principles

Apply consistently across all UI: settings, modals, sidebars, command palettes.

### Gestalt Principles

- **Proximity**: Group related items (settings under parent features, commands by workflow)
- **Similarity**: Consistent styling (icons, headers, spacing) for similar elements
- **Common Region**: Visual containers (header levels, borders) to group related items
- **Continuity**: Logical flow - setup → core → advanced → preferences

### User Task-Based Organization

Organize by **user mental model**, not technical implementation:

**Settings:** Collapsible sections (10 groups) - Setup → Core → Advanced → Preferences → Config
```
▾ AI Provider              — Configure your main LLM provider                [open by default]
▸ Specialist Providers     — Dedicated providers for YouTube, PDF, Audio, Flashcards
▸ Tagging                  — AI-powered tag generation and management
▸ Summarization            — Summary styles, personas, and output options
▸ Capture & Input          — Audio recording, image digitisation, sketch pad
    h2 Audio & Recording
    h2 Smart Digitisation
    h2 Sketch Pad
▸ Meeting Minutes          — Generate structured meeting minutes from transcripts
▸ Vault Intelligence       — Semantic search, RAG, and canvas visualizations
    h2 Semantic Search
    h2 Canvas Boards
▸ Integrations             — External tools and export options
    h2 Obsidian Bases
    h2 NotebookLM
    h2 Document Export
▸ Preferences              — Language, interface, and mobile settings
    h2 Language & Interface
    h2 Mobile
▸ Advanced                 — Configuration files and management
```
**Collapsible state:** Persists across re-renders via `expandedSections: Set<string>` on tab instance. Toggle listener updates Set; `createCollapsibleSection()` reads from Set on re-render.

**Sub-collapsible sections:** Umbrella groups (Capture & Input, Vault Intelligence, Integrations, Preferences) use `createSubCollapsibleSection(container, id, title, icon)` to wrap each child section class in its own nested `<details>`. The same `expandedSections` Set tracks state. CSS class `ai-organiser-settings-sub-section*` styles the nested headers; inner `h2.ai-organiser-settings-header` is hidden via CSS (sub-collapsible summary is the visual header).

**Command Picker Categories** (`CommandPickerModal.ts`) — output-anchored, two-layer:
```
Essentials   ← User-configurable favourites (max 5; default = chat / search / quick peek)
Create       ← Write + Visualise sub-groups + 3 direct leaves
Refine       ← Mutations on existing notes (flat)
Find         ← Search at top + Discover / Audit-vault sub-groups
Manage       ← Recurring + admin (flat)
```

**Modal Sections:** Inputs first → Options → Actions last

### Visual Hierarchy

**Settings structure:**
- `<details>/<summary>`: Collapsible top-level containers (with chevron indicators)
- `h1` + icon: Main sections (`createSectionHeader(title, icon, 1)`) - hidden inside collapsibles via CSS
- `h2` + icon: Subsections (`createSectionHeader(title, icon, 2)`)
- `h4` plain: Group labels (`createEl('h4')`)

**Summary sections:** Title + icon + description in collapsible header
**CSS:** `.ai-organiser-settings-section-content > h1` hidden (summary already shows title)

**Icons:** Every section/command needs contextual Lucide icon. Use `sparkles` for AI actions.

**Buttons:** Primary = `mod-cta`, destructive = `mod-warning`

### Async Rendering

Await async `display()` methods to maintain order:
```typescript
await this.summarizationSection.display();  // Correct
```

### Modal UX

- **Dependency-first:** Documents → Dictionary → Audio (extract terms before transcription)
- **Inline controls:** Place actions next to affected items (Gestalt proximity)
- **Progressive disclosure:** Collapse advanced options

## Obsidian Bases Integration

**Status**: ✅ Fully Implemented (January 2025)

See [docs/bases_integration.md](docs/bases_integration.md) for complete implementation details and [docs/bases_user_guide.md](docs/bases_user_guide.md) for user documentation.

### Overview

The Bases integration enables structured metadata and dashboard generation for seamless integration with the Obsidian Bases plugin. This allows users to:
- Auto-populate 10 metadata properties during AI operations
- Migrate existing notes to the new metadata format
- Generate dashboard views with 5 built-in templates
- Query and organize notes using Bases' powerful filtering system

### Core Components

**Metadata Namespace** ([src/core/constants.ts](src/core/constants.ts))
- `AIO_META` object: Simple, user-friendly property names (no prefix)
- Core properties: `summary`, `source_url` (minimal set used by default)
- Additional properties available: `status`, `type`, `processed`, `model`, `source`, `word_count`, `language`, `persona`
- Type definitions: `ContentType`, `StatusValue`, `SourceType` enums
- `SUMMARY_HOOK_MAX_LENGTH = 280` (optimized for Bases preview pane)

**Frontmatter Utilities** ([src/utils/frontmatterUtils.ts](src/utils/frontmatterUtils.ts))
- `updateAIOMetadata(app, file, metadata)`: CRUD operations preserving existing frontmatter
- `getAIOMetadata(app, file)`: Read all AI Organiser metadata properties
- `createSummaryHook(summary)`: Truncate to 280 chars at sentence boundaries
- `isAIOProcessed(app, file)`: Check processing status
- `countWords(content)` and `detectLanguage(content)`: Auto-population helpers

**Structured Prompts** ([src/services/prompts/structuredPrompts.ts](src/services/prompts/structuredPrompts.ts))
- `StructuredSummaryResponse` interface: 5 fields (summary_hook, body_content, suggested_tags, content_type, detected_language)
- `buildStructuredSummaryPrompt(options)`: XML-style prompt requesting JSON output
- `insertContentIntoStructuredPrompt(prompt, content)`: Template function

**Response Parser** ([src/utils/responseParser.ts](src/utils/responseParser.ts))
- 4-tier fallback JSON parsing:
  1. Direct `JSON.parse()` of response
  2. Extract from markdown code fence (```json ... ```)
  3. Search for JSON object in text ({...})
  4. Create fallback from plain text (keyword detection)
- `createFallbackResponse(text)`: Infers type from keywords, extracts #tags, uses first sentences
- `sanitizeSummaryHook(hook)`: Validates 280-char limit

### Migration System

**Migration Service** ([src/services/migrationService.ts](src/services/migrationService.ts))
- `analyzeMigrationScope(folder?)`: Counts `needsMigration` vs `alreadyMigrated`
- `migrateNote(file, options)`: Extracts summaries from `##Summary`/`##TL;DR`/first paragraph
- `determineStatus()`: Checks for existing tags (processed vs pending)
- `detectContentType()`: Analyzes keywords (research/meeting/project/reference)
- `migrateFolder()` and `migrateVault()`: Batch operations with progress callbacks
- `extractSummaryFromContent()`: Regex patterns for section extraction
- `getMarkdownFilesInFolder()`: Recursive traversal

**Migration Modal** ([src/ui/modals/MigrationModal.ts](src/ui/modals/MigrationModal.ts))
- 4-stage UI workflow:
  1. **Analysis**: Display stats (total/needsMigration/alreadyMigrated)
  2. **Options**: Toggle `overwriteExisting`, `extractSummary`
  3. **Progress**: Live progress bar with updates
  4. **Results**: Summary with error details
- Each stage has dedicated `renderStage()` method with proper cleanup

**Commands** ([src/commands/migrationCommands.ts](src/commands/migrationCommands.ts))
- `upgrade-metadata`: Opens MigrationModal for entire vault
- `upgrade-folder-metadata`: Opens MigrationModal scoped to current folder

### Dashboard Generation

**Templates** ([src/services/configurationService.ts](src/services/configurationService.ts))
- Single "Notes Dashboard" template for simplicity
- YAML structure with `filters:` (plural), `columns:`, optional `sorting:`
- Folder filtering automatically applied via `file.inFolder()` function

**Dashboard Service** ([src/services/dashboardService.ts](src/services/dashboardService.ts))
- `createDashboard(options)`: Create `.base` file from template with folder filtering
- `injectFolderFilter(content, folderPath)`: Automatically adds `file.inFolder("path")` filter
- `getRecommendedDashboardFolder()`: Searches for 'Dashboards'/'Views'/'Bases'
- Folder filter includes all subfolders recursively
- Uses `filters:` (plural) syntax as required by Obsidian Bases

**Dashboard Modal** ([src/ui/modals/DashboardCreationModal.ts](src/ui/modals/DashboardCreationModal.ts))
- Simple confirmation dialog (not template picker)
- Shows target folder path with change option
- Single "Create Dashboard" action
- Dashboard automatically scoped to selected folder

**Commands** ([src/commands/dashboardCommands.ts](src/commands/dashboardCommands.ts))
- `create-bases-dashboard`: Opens DashboardCreationModal

### Settings Integration

**Bases Settings Section** ([src/ui/settings/BasesSettingsSection.ts](src/ui/settings/BasesSettingsSection.ts))
- 3 toggle settings:
  - `enableStructuredMetadata`: Enable Bases integration (default: true)
  - `includeModelInMetadata`: Add `model` property (default: true)
  - `autoDetectContentType`: Auto-detect content type from keywords (default: true)
- Info box with usage guidance (3 bullet points)
- Migration action button (icon: database): Calls `upgrade-metadata` command
- Dashboard creation via right-click folder context menu

### Summarization Integration

**Conditional Structured Output** ([src/commands/summarizeCommands.ts](src/commands/summarizeCommands.ts))
- `updateNoteMetadataAfterSummary()` function:
  - Checks `enableStructuredMetadata` setting
  - Builds minimal metadata: `summary` (hook) and `source_url` (if available)
  - Calls `updateAIOMetadata()` to write frontmatter

- `summarizeAndInsert()` modified:
  - **If `enableStructuredMetadata`**:
    - Use `buildStructuredSummaryPrompt()`
    - Parse JSON response with `parseStructuredResponse()`
    - Extract `body_content`, `summary_hook`, `suggested_tags`, `content_type`
    - Insert body content into note
    - Update metadata with `updateNoteMetadataAfterSummary()`
  - **Else**: Use traditional `buildSummaryPrompt()` (backward compatibility)

**Unified Workflow Functions** (DRY/SOLID pattern):
- `transcribeAudioWithFullWorkflow()` in `src/services/audioTranscriptionService.ts`:
  - Handles all audio paths: chunked (>20 min), compressed (>25MB), direct
  - Used by both multi-source and standalone audio handlers
  - Progress callback for UI updates
- `summarizePdfWithFullWorkflow()` in `src/commands/summarizeCommands.ts`:
  - Handles both vault and external PDFs
  - Uses `getFirstLinkpathDest()` for wiki-link resolution
  - Used by both multi-source and standalone PDF handlers

### Key Implementation Patterns

**Simple Property Names**: Metadata uses clean, user-friendly names (`summary`, `source_url`) for better readability

**Minimal Metadata**: Only essential fields stored by default (summary hook and source URL)

**280-Char Summaries**: Optimized for Bases preview pane, truncates at sentence boundaries

**Graceful Degradation**: Works without Bases plugin (metadata still useful for Dataview, search)

**Type Safety**: `ContentType`, `StatusValue`, `SourceType` enums in constants.ts

**Bilingual Support**: Complete EN + ZH-CN translations for all UI elements (130+ strings)

**4-Tier JSON Parsing**: Handles various LLM response formats gracefully

**Backward Compatibility**: Structured output controlled by settings toggle, preserves existing summarization behavior when disabled

### Integration Points

**Tag Generation**: Suggested tags from structured responses automatically added to frontmatter

**Semantic Search**: Content type filters improve RAG context retrieval

**Smart Summarization**: Auto-detects source type based on input (URL → 'url', PDF → 'pdf', YouTube → 'youtube')

**Batch Operations**: Migration service supports folder and vault-wide operations with progress tracking

## Audio Recording

**Status**: ✅ Implemented (January 2026)

In-plugin audio recording using MediaRecorder API. Works on desktop and mobile (iOS/Android).

**Core Components**:
- `src/services/audioRecordingService.ts`: MediaRecorder wrapper, mime negotiation (`audio/mp4` → `audio/webm;codecs=opus` → fallbacks), actual chunk size tracking via 1-second timeslice, 64kbps bitrate
- `src/ui/modals/AudioRecorderModal.ts`: Recording modal with states (idle → recording → stopped → saving → transcribing → done), platform-aware transcription, close safety

**Post-Transcription Cleanup** (`src/services/audioCleanupService.ts`):
- `offerPostTranscriptionCleanup(plugin, options)`: Shared utility for all audio transcription paths
- 3-option modal: keep original / replace with compressed / delete audio
- Respects `postRecordingStorage` policy (`'ask' | 'keep-original' | 'keep-compressed' | 'delete'`)
- Checks >10% savings threshold before offering compression
- Wired into: standalone summarize, multi-source summarize, multi-source translate, minutes transcription

**Integration Points**:
- Standalone `record-audio` command in Command Picker Capture category
- Minutes modal: Record button rendered OUTSIDE `!Platform.isMobile` gate
- Multi-Source modal: Record button in BOTH render paths via shared helper (survives rerenders)
- Settings: `autoTranscribeRecordings`, `embedAudioInNote` in Audio Transcription section
- Recordings saved to `AI-Organiser/Recordings/`

**Mobile Safeguards**: Feature detection, mime negotiation with fallback, actual size tracking (not estimate), direct `transcribeAudio()` (no FFmpeg), 64kbps bitrate (~52 min under 25MB), close safety (auto-save).

## Canvas Toolkit

**Status**: ✅ Implemented (January 2026)

### Overview

Three commands that create Obsidian `.canvas` JSON files from note context, RAG results, and tag clusters. Desktop only (gated by `Platform.isMobile`).

### Canvas Types (`src/services/canvas/types.ts`)

- `CanvasNode`, `CanvasEdge`, `CanvasData`: Mirror Obsidian `.canvas` JSON spec
- `NodeDescriptor`, `EdgeDescriptor`, `ClusterDescriptor`: Internal pre-layout descriptors
- `CanvasResult`: Operation result with optional `errorCode: CanvasErrorCode`
- `CanvasErrorCode`: `'no-related-notes' | 'no-sources-detected' | 'no-notes-with-tag' | 'creation-failed'`

### Layout Algorithms (`src/services/canvas/layouts.ts`)

Pure math functions — no Obsidian imports, fully testable:
- `radialLayout(count, centerIdx)`: Center node at (0,0), satellites at equal angles
- `gridLayout(count)`: `cols = ceil(sqrt(N))` grid arrangement
- `adaptiveLayout(count, centerIdx?)`: ≤12 nodes → radial, >12 → grid
- `clusteredLayout(clusters)`: Groups in horizontal row, each with internal grid
- `computeEdgeSides(from, to)`: Determines left/right/top/bottom based on dx vs dy

### Canvas Utilities (`src/services/canvas/canvasUtils.ts`)

- `generateId()`: 16-char lowercase hex via `crypto.getRandomValues` (matches Obsidian's native convention); falls back to base36 timestamp+random if Web Crypto unavailable
- `buildCanvasNode()`, `buildCanvasEdge()`: Construct canvas JSON objects
- `writeCanvasFile()`: Create `.canvas` file with folder creation and auto-increment naming
- `sanitizeCanvasName()`: Strip invalid characters (`/ \ : * ? " < > |`)
- Safety cap: `getAvailableCanvasPath` tries up to 999 increments

### Three Board Types

**Investigation Board** (`src/services/canvas/investigationBoard.ts`):
- Uses RAG to find related notes → radial/grid layout with center note
- Optional LLM edge labels (single batch call via `buildEdgeLabelPrompt`)
- Score-based fallback labels: "Closely related" (≥0.8), "Related" (≥0.6), "Loosely related"
- Requires semantic search enabled

**Context Board** (`src/services/canvas/contextBoard.ts`):
- Detects embedded content (YouTube, PDF, links, audio, documents) via `embeddedContentDetector`
- No LLM call — purely structural visualization
- Works without semantic search
- Color-coded nodes by type (YouTube=purple, PDF=green, web=yellow, etc.)

**Cluster Board** (`src/services/canvas/clusterBoard.ts`):
- Groups notes by tag using LLM clustering or deterministic fallback
- Deterministic algorithm: folder grouping → subtag grouping → chunk-based (size 6)
- `computeMaxNotes()`: Token budget calculation for LLM prompt
- `parseClusterResponse()`: 3-tier JSON parsing via shared `tryExtractJson`
- TagPickerModal (`src/ui/modals/TagPickerModal.ts`) for tag selection

### Prompts (`src/services/prompts/canvasPrompts.ts`)

- `buildEdgeLabelPrompt(pairs, language)`: 1-4 word relationship labels with language support
- `buildClusterPrompt(tag, notes, language)`: Group notes into meaningful clusters

### Settings (`src/core/settings.ts`)

| Setting | Default | Description |
|---------|---------|-------------|
| `canvasOutputFolder` | `'Canvas'` | Subfolder under plugin folder |
| `canvasOpenAfterCreate` | `true` | Open canvas file after creation |
| `canvasEnableEdgeLabels` | `true` | Use LLM for Investigation Board edge labels |
| `canvasUseLLMClustering` | `true` | Use LLM for Cluster Board grouping |

Settings UI: `src/ui/settings/CanvasSettingsSection.ts` (4 toggles, placed after Semantic Search)

### Commands (`src/commands/canvasCommands.ts`)

- `build-investigation-canvas`: Investigation Board (requires semantic search)
- `build-context-canvas`: Context Board (works without semantic search)
- `build-cluster-canvas`: Cluster Board with TagPickerModal

Investigation and Context boards are in Command Picker → Active Note → Note Maps. Cluster Board is in Command Picker → Vault Intelligence → Vault Visualizations.

### Shared Utilities (DRY)

- `tryExtractJson()` in `responseParser.ts`: 3-tier JSON extraction (direct → code fence → object search)
- `extractTagsFromCache()` in `tagUtils.ts`: Shared tag extraction from metadata cache
- Error codes on `CanvasResult` replace string matching in command handlers

### Testing

- `tests/canvasLayouts.test.ts`: 15 tests (radial, grid, clustered, edge sides, edge cases)
- `tests/canvasUtils.test.ts`: 17 tests (sanitize, node/edge building, write paths, ID format, fallback)
- `tests/canvasPrompts.test.ts`: 8 tests (language, structure, empty arrays)
- `tests/investigationBoard.test.ts`: 8 tests (JSON parsing, fallback labels, boundaries)
- `tests/clusterBoard.test.ts`: 10 tests (folder/subtag grouping, token budget, parsing)
- `tests/responseParser.test.ts`: 60 tests (includes 14 for generic JSON extraction)

---

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

## Meeting Minutes Generation

**Status**: ✅ Implemented (January 2026)

### Overview

Generate structured meeting minutes from transcripts with persona-based output styles, GTD action classification overlay, terminology dictionaries for transcription accuracy, and context document support.

### Personas (2 built-in)

| ID | Name | Icon | Description |
|----|------|------|-------------|
| `standard` | Standard | `file-text` | Concise, action-oriented minutes (default) |
| `governance` | Governance | `landmark` | Formal governance minutes with resolutions and fiduciary matters |

Personas stored in `AI-Organiser/Config/minutes-personas.md`. Users can add custom personas following the same `### Name [icon: icon-name]` format.

### GTD Overlay

Optional GTD (Getting Things Done) action classification. When enabled (`minutesGTDOverlay` setting or per-session toggle in modal):
- **Next Actions**: Classified by context (`@office`, `@home`, `@call`, `@computer`, `@agenda`, `@errand`) with energy tags (`low`/`high` — `medium` omitted)
- **Waiting For**: Items with `waiting_on` person and optional `chase_date`
- **Projects**: Multi-step commitments (names only)
- **Someday/Maybe**: Ideas not yet committed to

GTD schema injected conditionally via `getStyleSystemPrompt({ useGTD: true })`. Chunk extraction excluded from GTD.

**GTD interfaces** in `minutesPrompts.ts`: `GTDAction`, `GTDWaitingItem`, `GTDProcessing`, `MinutesJSON.gtd_processing?`

**GTD rendering** in `minutesUtils.ts`: `renderMinutesFromJson(json, style, obsidianTasksFormat?)` — context keys sorted alphabetically, `- [ ]` checkboxes when obsidianTasksFormat is true.

### Core Components

**Minutes Service** (`src/services/minutesService.ts`):
- `generateMinutes()`: Main generation function with transcript chunking
- `MinutesGenerationInput` includes `useGTD?: boolean`
- Supports long transcripts via 5000-token chunked processing
- Context chaining between chunks for coherent output
- Passes `ChunkExtractionContext` (chunkIndex, totalChunks, participants) to chunk extraction prompts
- Passes `IntermediateMergeContext` (chunkCount, participants) to intermediate merge prompts
- Accepts `dictionaryContent` and `contextDocuments` for enhanced accuracy

**Dictionary Service** (`src/services/dictionaryService.ts`):
- CRUD operations for terminology dictionaries stored as markdown
- `addEntries()`: Merge with case-insensitive deduplication
- `formatForPrompt()`: Format dictionary as XML for LLM injection
- `buildExtractionPrompt()`: Extract terms from context documents
- Storage: `AI-Organiser/Config/dictionaries/` (syncs across devices)
- Entry categories: person, acronym, term, project, organization

**Minutes Prompts** (`src/services/prompts/minutesPrompts.ts`):
- `getStyleSystemPrompt(options: MinutesStylePromptOptions)`: Style-specific system prompt with `{ style, outputLanguage, personaInstructions, useGTD? }`
- `buildChunkExtractionPrompt(context: ChunkExtractionContext)`: Chunk-aware extraction with participant list and position label
- `buildIntermediateMergePrompt(context: IntermediateMergeContext)`: Merge prompt with `deferred_items` for irreconcilable conflicts
- `buildStyleConsolidationPrompt(options)`: Style-aware consolidation for chunked processing
- Conditional GTD schema injection and self-check item #9
- Dictionary injection for name/term consistency

**Minutes DOCX Export** (`src/services/export/minutesDocxGenerator.ts`):
- `generateMinutesDocx(json)`: Generates Word document from `MinutesJSON` using `docx` library
- `extractMinutesJsonFromNote(content)`: Parses `<!-- minutes-json: ... -->` HTML comment from note
- Structured sections: header, metadata table, agenda, discussion items, action items, decisions, GTD
- Desktop: system Save dialog via Electron; Mobile: vault file fallback

**Minutes Modal** (`src/ui/modals/MinutesCreationModal.ts`):
- Meeting input form: title, date, time, participants, agenda, transcript
- Context Documents section: attach agendas, presentations, spreadsheets
- Dictionary section: select, create, edit, or extract terminology
- Audio Transcription section: transcribe embedded audio files
- UX flow: Documents → Dictionary → Audio (dependency-first ordering)
- Persona selector, GTD toggle, dual output toggle, Obsidian Tasks toggle

**Minutes Settings** (`src/ui/settings/MinutesSettingsSection.ts`):
- Output folder, default timezone, default persona, Obsidian Tasks format, GTD overlay default

**Text Chunker** (`src/utils/textChunker.ts`):
- `chunkText()`: Split long transcripts by token count with sentence boundaries
- `chunkPlainTextAsync()`: Paragraph → sentence → word boundary lookback splitting (no mid-word cuts)

### Key Patterns

- **Transcript Chunking**: Long meetings split into manageable chunks
- **Context Chaining**: Each chunk receives previous summary for continuity
- **Persona System**: 2 built-in personas (`standard`, `governance`) + custom via config file
- **GTD Overlay**: Optional action classification by GTD context, renders as separate sections
- **Obsidian Tasks + GTD**: When both enabled, GTD next-actions render as `- [ ]` checkboxes
- **Options Object Pattern**: `MinutesSystemPromptOptions` for extensible prompt configuration
- **Dictionary-First Workflow**: Extract terms from documents before transcription
- **Cross-Meeting Reuse**: Same dictionary works across multiple meetings
- **Document Truncation**: Inline controls for oversized documents with configurable settings

## Document Extraction System

**Status**: ✅ Implemented (January 2026)

### Overview

Centralized document detection and extraction supporting Office documents (docx, xlsx, pptx), text formats (txt, rtf), and PDFs across Minutes, Multi-Source Summarization, and NotebookLM features.

### Core Components

**Constants** (`src/core/constants.ts`):
- `EXTRACTABLE_DOCUMENT_EXTENSIONS`: ['docx', 'xlsx', 'pptx', 'txt', 'rtf']
- `ALL_DOCUMENT_EXTENSIONS`: ['pdf', ...EXTRACTABLE_DOCUMENT_EXTENSIONS]
- `DOCUMENT_EXTENSIONS_WITH_DOTS`: For file detection with dots

**Document Extraction Service** (`src/services/documentExtractionService.ts`):
- `extractText(file)`: Extract from vault files (uses officeparser for Office formats)
- `extractFromUrl(url, onProgress?)`: Download and extract from external URLs (HTTPS only)
- `canExtract(file)`: Check if file type is supported
- RTF parsing with hex/unicode decode and readability validation
- TXT direct read support

**Content Extraction Service** (`src/services/contentExtractionService.ts`):
- `extractDocumentContent(item)`: Unified extraction for vault and external documents
- Handles `isExternal` flag for URL-based documents
- Returns `ExtractedContent` with success/error status

**Embedded Content Detector** (`src/utils/embeddedContentDetector.ts`):
- `detectEmbeddedContent()`: Detect documents in note content
- `classifyUrl()`: Classify external URLs including document URLs
- `getExtractableContent()`: Filter for extractable items including documents

### Feature Integration

**Minutes** (`src/ui/modals/MinutesCreationModal.ts`):
- Context Documents section with inline truncation controls
- Settings: `maxDocumentChars`, `oversizedDocumentBehavior`
- Bulk "Apply to all" for multiple oversized documents

**Multi-Source** (`src/ui/modals/MultiSourceModal.ts`):
- Documents section between PDFs and Audio
- Detection from note content and manual input
- Settings: `multiSourceMaxDocumentChars`, `multiSourceOversizedBehavior`

**NotebookLM** (`src/services/notebooklm/sourcePackService.ts`):
- `detectLinkedDocuments()`: Find linked documents in selected notes
- Display in export preview modal

**Pending Integration** (`src/commands/integrationCommands.ts`):
- "Resolve pending embeds" command extracts text from embedded docs
- Replaces embed syntax with extracted content for review

### SOLID/DRY Patterns

**Centralized Constants** (`src/core/constants.ts`):
- `DEFAULT_MAX_DOCUMENT_CHARS = 50000`: Minutes document limit
- `DEFAULT_MULTI_SOURCE_MAX_DOCUMENT_CHARS = 100000`: Multi-source limit
- `TruncationChoice`: Type alias for 'truncate' | 'full' | 'skip'
- `OversizedBehavior`: Type alias for 'ask' | 'truncate' | 'full'

**Unified UI Text** (`src/ui/modals/MinutesCreationModal.ts`):
- `getTruncationOptions(t)`: Single source for truncation labels/tooltips
- Returns `Record<TruncationChoice, {label, tooltip}>` for DRY dropdown rendering

**Dependency Injection** (`src/ui/modals/MinutesCreationModal.ts`):
- `MinutesModalDependencies` interface for optional service injection
- Services: `minutesService`, `dictionaryService`, `documentService`
- Supports testability without modifying production code

**Key Patterns**:
- **DRY Extensions**: All extension checks use constants from `constants.ts`
- **DRY Limits**: Use `DEFAULT_MAX_DOCUMENT_CHARS` / `DEFAULT_MULTI_SOURCE_MAX_DOCUMENT_CHARS`
- **DRY UI Text**: Truncation labels/tooltips via `getTruncationOptions()` helper
- **DIP**: Modal services injectable via `MinutesModalDependencies` interface
- **HTTPS Only**: External URLs must use HTTPS (security requirement)
- **Inline Truncation**: Gestalt proximity - controls next to affected documents
- **Graceful Errors**: RTF validation catches complex formatting, shows user-friendly message

## Controller Architecture (MinutesCreationModal)

**Status**: Implemented (January 2026)

The MinutesCreationModal uses a controller-based architecture to separate concerns and improve testability.

### Controllers

**Location**: `src/ui/controllers/`

| Controller | Responsibility | Tests |
|------------|----------------|-------|
| `DocumentHandlingController` | Document detection, extraction, caching, truncation | 23 |
| `DictionaryController` | Dictionary CRUD, term extraction, merging | 56 |
| `AudioController` | Audio detection and transcription state | 35 |

**Shared Components**: `src/ui/components/TruncationControls.ts` (8 tests)

### Controller Lifecycle

Controllers instantiated per modal open for fresh state:

```typescript
onOpen() {
    this.docController = new DocumentHandlingController(app, plugin, documentService, embeddedDetector);
    this.dictController = new DictionaryController(dictionaryService);
    this.audioController = new AudioController(app); // App only (ISP)
}
```

### No-Stubs Policy

**Critical**: All new code must follow the no-stubs policy:

- **No placeholder methods**: If a method isn't used by modal or tests, remove it
- **Public methods must have call sites**: Modal, other UI, or tests
- **Private helpers allowed**: If used by public methods
- **Errors returned, not thrown**: Use `errors: string[]` on result objects

### Key Patterns

- **Immutable external interface**: All getters return shallow copies
- **ID-based tracking**: File paths for vault items, normalized URLs for external
- **Result objects**: `DocumentHandlingResult`, `DictionaryResult<T>`, `AudioResult<T>` with `errors: string[]`
- **Callback-based UI**: TruncationControls uses callbacks (IoC), no modal dependencies
- **Type-safe translations**: `TruncationTranslations` interface

### Testing

**Service Tests**:
- `tests/minutesService.test.ts` (23 tests): Chunked/non-chunked generation, language fallback
- `tests/ragService.test.ts` (19 tests): Context retrieval, RAG prompt building

**Export Tests**:
- `tests/minutesDocxGenerator.test.ts` (14 tests): DOCX generation, JSON extraction, section structure

**Controller Tests**:
- `tests/documentHandlingController.test.ts` (23 tests)
- `tests/dictionaryController.test.ts` (56 tests)
- `tests/audioController.test.ts` (35 tests)
- `tests/components/truncationControls.test.ts` (8 tests)

**Prompt Tests**:
- `tests/promptInvariants.test.ts` (56 tests): Invariant tests for 8 prompt modules
- `tests/minutesPrompts.test.ts` (102 tests): Prompt generation, chunk extraction, intermediate merge, consolidation, style extraction, context extraction

**Utility Tests**:
- `tests/responseParser.test.ts` (40 tests): 4-tier JSON extraction, sanitization
- `tests/textChunker.test.ts` (35 tests): Transcript chunking, overlap handling, sentence-boundary splitting
- `tests/sourceDetection.test.ts` (58 tests): URL/YouTube/PDF/audio detection
- `tests/frontmatterUtils.test.ts` (45 tests): Summary hooks, word counting, language detection
- `tests/dashboardService.test.ts` (23 tests): Filter injection, folder paths
- `tests/vectorMath.test.ts` (5 tests): Cosine similarity

**GTD & Migration Tests**:
- `tests/minutesGTDRendering.test.ts` (11 tests): GTD rendering, context sorting, checkbox integration
- `tests/settingsMigration.test.ts` (14 tests): `migrateOldSettings()` pure function coverage

**Digitisation Tests**:
- `tests/multimodal.test.ts`: Capability gating, adapter formatting, token handling
- `tests/imageProcessor.test.ts`: Resize, format conversion, MIME validation
- `tests/digitisePrompts.test.ts`: Prompt invariants for all digitise modes
- `tests/strokeManager.test.ts` (185 tests): Add/undo/redo/erase/clear stroke operations
- `tests/sketchExport.test.ts` (49 tests): Canvas mock → blob → vault file
- `tests/mediaCompression.test.ts` (143 lines): Compression offer logic, vault replacement

- `tests/streamingSynthesis.test.ts` (76 tests): P2 fixes, adapter streaming, orchestrator streaming, Siliconflow
- `tests/llmFacadeStream.test.ts` (6 tests): Streaming facade fallback (incl. abort guard)
- `tests/claudeAdapterThinking.test.ts` (31 tests): Adaptive thinking params, response parsing, streaming chunks
- `tests/claudeWebSearchAdapter.test.ts` (60 tests): Adapter unit tests (parseResponse, domain filtering, academic, perspective, multi-turn)
- `tests/claudeWebSearchIntegration.test.ts` (22 tests): Orchestrator integration tests (pipeline, pause_turn, metadata, budget)
- `tests/claudeWebSearchStreaming.test.ts` (56 tests): Streaming tests (SSE, citations_delta, mode-switch abort, multi-turn stream)

- `tests/embedScanService.test.ts` (70 tests): normalizeEmbedPath, classifyExtension, formatFileSize, getEmbedTypeIcon, hasEmbedTypeExtension, isExternalUrl, extractReferencesFromLine, EMBED_TYPE_EXTENSIONS
- `tests/mermaidChangeDetector.test.ts` (24 tests): Snapshot capture, staleness check, snooze, Jaccard similarity
- `tests/mermaidContextService.test.ts` (15 tests): Budget constants, sibling diagrams, context gathering
- `tests/mermaidTemplateService.test.ts` (20 tests): Fallback templates, template file parsing, load/save
- `tests/mermaidExportService.test.ts` (15 tests): .mermaid file, SVG, PNG, canvas export, appendToCanvas

- `tests/quickPeekService.test.ts` (9 tests): Pipeline, provider resolution, abort, fallback excerpt

Total: 3375 unit tests (136 suites) + 39 automated integration tests

## Multi-Source Translation

**Status**: ✅ Implemented (January 2026)

Translate note content and external sources (URLs, YouTube, PDFs, documents, audio) into 20+ languages.

**Smart Dispatch**: Selection → translate selection; no selection + sources → multi-source modal; no selection + no sources → translate note.

**Key Files**:
- `src/commands/translateCommands.ts`: Smart dispatch + multi-source orchestrator
- `src/services/apiKeyHelpers.ts`: Shared YouTube/audio API key resolution (DRY extraction)
- `src/services/pdfTranslationService.ts`: Shared PDF provider config (DRY extraction)
- `src/ui/modals/MultiSourceModal.ts`: Parameterized for both summarize and translate modes

**Patterns**: Modal reuse via config, sequential processing with error isolation, content chunking, privacy consent gating, wikilink + URL source cleanup after processing.

## Enhanced Pending Integration

**Status**: ✅ Implemented (February 2026)

Auto-resolves all embedded content (web articles, YouTube, audio, PDFs, documents) before integration. 3 strategy dropdowns (placement/format/detail) + auto-tag toggle.

**Auto-Resolve Pipeline** (`resolveAllPendingContent()` in `integrationCommands.ts`):
1. Detects embedded content via `detectEmbeddedContent()` (web, YouTube, audio, PDF, documents)
2. Per-provider privacy consent (Gemini/OpenAI/Groq independent of main LLM)
3. Extracts content via `ContentExtractionService` — text-only or multimodal PDF
4. Positional line-based replacement (bottom-up by `lineNumber`)
5. Truncates to fit provider limits (main content + overhead budget)

**Key behaviors**: YouTube falls back to caption scraping without Gemini key; audio skipped without API key; PDF uses multimodal when available, else officeparser text.

**Key Files**:
- `src/commands/integrationCommands.ts`: Command handler, `resolveAllPendingContent()`, `buildEnrichedContent()`, `IntegrationConfirmModal`, `buildIntegrationPrompt()`
- `src/services/contentExtractionService.ts`: Audio support, `extractPdfAsText()`, `extractPdfWithMultimodal()`, `textOnly` flag
- `src/services/prompts/integrationPrompts.ts`: Strategy-specific prompt helpers, `buildPdfExtractionPrompt()`
- `src/utils/editorUtils.ts`: `insertAtCursor()`, `appendAsNewSections()` (shared DRY utility)
- `src/core/constants.ts`: `PlacementStrategy`, `FormatStrategy`, `DetailStrategy` types + defaults

**Patterns**: Per-provider privacy consent (session-scoped), positional line-based replacement, truncation budget (main content for callout/merge + 2000 overhead), guard branching, editor buffer for auto-tag.

## Summary Result Preview Modal

**Status**: ✅ Implemented (January 2026)

Preview modal for all summary insert functions with insert/copy/discard actions.

**Key Files**:
- `src/ui/modals/SummaryResultModal.ts`: Modal with MarkdownRenderer preview
- `src/commands/summarizeCommands.ts`: `showSummaryPreviewOrInsert()` DRY helper

**Patterns**: Action-based return type, ESC-safe `onClose()` fires discard, metadata gated on cursor action only, scrollable `.ai-organiser-summary-preview` CSS.

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

**Plan**: [docs/completed/web-research-plan.md](docs/completed/web-research-plan.md)

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

- **API Key Reuse** (AD-4): 3-level fallback — dedicated research key → SecretStorage anthropic key → main `cloudApiKey`
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

**Plan**: [docs/claude-web-search-plan.md](docs/claude-web-search-plan.md)

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

**Plan**: [docs/completed/quic-plan.md](docs/completed/quic-plan.md)

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
- Plan: [docs/kindle-plan.md](docs/kindle-plan.md)

## Document Export & Theme

**Status**: ✅ Implemented (March 2026)

### Overview

Export notes as PDF, Word (.docx), or PowerPoint (.pptx) with configurable theme. Users set a default colour scheme, font family, and body font size in settings; the theme applies uniformly across all PPTX and DOCX exports.

### Core Components

**Export Service** (`src/services/export/exportService.ts`):
- `ExportService.exportNotes(config)`: Orchestrates single/multi-note export to PDF, DOCX, PPTX
- `ExportConfig.theme?: ExportTheme`: Forwarded to both generators

**PPTX Generator** (`src/services/export/markdownPptxGenerator.ts`):
- `ExportTheme` interface: `primaryColor`, `accentColor`, `sectionBg`, `bodyColor`, `fontFace`, `fontSize`
- `COLOR_SCHEMES`: 5 preset palettes (navy-gold, forest-amber, slate-coral, burgundy-champagne, charcoal-sky)
- `resolveTheme()`: Pure function mapping scheme name + custom overrides to full `ExportTheme`
- `generatePptx()`: Markdown → slides (H1/H2 splits), themed headings/body/tables
- `generatePptxFromDeck()`: Structured `DeckModel` → themed slides with types (title/section/content/closing)
- Colour math helpers: `darkenHex()`, `lightenHex()` for custom scheme derivation

**DOCX Generator** (`src/services/export/markdownDocxGenerator.ts`):
- `DocxOptions.fontFace` / `DocxOptions.fontSize`: Override defaults (Calibri/11pt)
- Body text uses half-points (`pt × 2`); headings retain proportional constants

**Export Modal** (`src/ui/modals/ExportModal.ts`):
- Builds theme from settings via `resolveTheme()` and passes to `exportNotes()`

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `exportColorScheme` | `'navy-gold'` | Preset palette or `'custom'` |
| `exportPrimaryColor` | `'1A3A5C'` | Custom primary hex (headings, title bg) |
| `exportAccentColor` | `'F5C842'` | Custom accent hex (bars, table headers) |
| `exportFontFace` | `'Noto Sans'` | Font family for exports |
| `exportFontSize` | `14` | Body font size in points (10–18) |

Settings UI: `src/ui/settings/ExportSettingsSection.ts` — colour scheme dropdown with inline colour swatch preview, native colour pickers for custom mode, font dropdown, font size slider with `setDynamicTooltip()`.

## Smart Digitisation & Multimodal Architecture

**Status**: ✅ Implemented (February 2026)

### Overview

Unified multimodal pipeline, image processing, smart digitisation of handwritten notes/whiteboards/diagrams, built-in sketch pad, and media compression with vault replacement. Five phases delivered on branch `claude/smart-digit-plan-O4GpF`.

**Full plan**: [docs/completed/smart-digitisation-plan.md](docs/completed/smart-digitisation-plan.md)

### Multimodal Architecture (Phase 1)

**Adapter pipeline** (`src/services/adapters/`):
- `ContentPart` type: `text | image | document` content parts
- `MultimodalCapability`: `'text-only' | 'image' | 'document' | 'image+document'`
- `formatMultimodalRequest()` on adapters: Claude, Gemini, OpenAI override; others inherit text-only default
- `sendMultimodal()` on `CloudLLMService`: Unified method replacing `analyzeImage`, `summarizePdf`, `analyzeMultipleContent`
- Strict capability validation: Returns error for unsupported media types (no silent drops)
- `extractTextFromParts()` in `src/utils/adapterUtils.ts`: Safe text extraction from `ContentPart[]`

### Image Processing (Phase 2)

**ImageProcessorService** (`src/services/imageProcessorService.ts`):
- Canvas 2D pipeline: load → detect format → convert → resize → compress → base64
- Format conversion: BMP/TIFF/AVIF → JPEG, SVG → PNG (via canvas rasterisation)
- HEIC: Not supported in-plugin (throws with guidance to set iPhone to "Most Compatible")
- MIME validation with `VLM_NATIVE_IMAGE_FORMATS` whitelist
- `processImage(file, options)` → `ProcessedImage` with dimensions, sizes, conversion flags
- `replaceOriginal(file, processedImage)` → backlink-safe vault replacement via `fileManager.renameFile()`

### Smart Digitisation (Phase 3)

**VisionService** (`src/services/visionService.ts`):
- `digitise(file)` / `digitiseWithImage(file)`: Image → VLM → structured markdown + Mermaid
- `canDigitise()`: Provider capability check (returns false for local/text-only providers)
- `findNearestImage()`: Cursor-aware image embed detection (±3 lines)
- `resolveImageEmbed()`: Wiki-link image resolution via vault API

**Digitise Prompts** (`src/services/prompts/digitisePrompts.ts`):
- 5 modes: `auto | handwriting | diagram | whiteboard | mixed`
- XML-structured prompts with `<task>`, `<requirements>`, `<output_format>` sections
- Outputs: `## Extracted Text` (markdown), `## Diagram` (mermaid), `## Uncertainties`

**VisionPreviewModal** (`src/ui/modals/VisionPreviewModal.ts`):
- Split layout: source image | rendered markdown+mermaid output
- Actions: Discard (mod-warning) | Copy to Clipboard | Insert Below (mod-cta)
- Component lifecycle with `component.unload()` cleanup

**Commands** (`src/commands/digitisationCommands.ts`):
- `digitise-image`: Cursor-aware image detection, single/multi image picker
- Context menu entry for image embeds (cursor-position-based, not selection-based)

### Built-in Sketch Pad (Phase 4)

**SketchPadModal** (`src/ui/modals/SketchPadModal.ts`):
- Canvas 2D drawing surface with `perfect-freehand` (1.2 KB, pressure-sensitive strokes)
- Pointer Events API: pressure, tilt, `pointerType` discrimination
- `touch-action: none` prevents iPadOS Scribble interference
- Toolbar: colour picker (black/blue/red), pen width (thin/med/thick), undo/redo/eraser/clear

**StrokeManager** (`src/services/sketch/strokeManager.ts`):
- Stroke-level undo/redo stack
- Eraser: distance-based hit test against stroke bounding boxes
- `getStrokes()` returns shallow copies (immutable external interface)

**SketchExport** (`src/services/sketch/sketchExport.ts`):
- `canvas.toBlob()` → `vault.createBinary()` → embed `![[sketch-*.png]]` in note
- "Done & Digitise" button: saves + digitises in one step

**Commands** (`src/commands/sketchCommands.ts`):
- `new-sketch`: Opens SketchPadModal, saves PNG, embeds in current note

**Settings**: `sketchOutputFolder`, `sketchAutoDigitise`, `sketchDefaultPenColour`, `sketchDefaultPenWidth`

### Media Compression (Phase 5)

**CompressionConfirmModal** (`src/ui/modals/CompressionConfirmModal.ts`):
- 3-action modal: keep original / replace with compressed / delete file
- `CompressionChoice`: `{ action: CompressionAction }` where `CompressionAction = 'keep-original' | 'keep-compressed' | 'delete'`
- `compressedSizeBytes` optional — modal adapts title and hides compress button when no compression available
- Used after digitisation (images) and after transcription (audio via `audioCleanupService`)

**Image compression** (`src/services/imageProcessorService.ts`):
- `replaceOriginal()`: `vault.modifyBinary()` + `fileManager.renameFile()` for backlink safety
- `getEstimate()`: Pre-processing size estimation for UI

**Audio cleanup** (`src/services/audioCleanupService.ts`):
- `offerPostTranscriptionCleanup()`: Shared post-transcription cleanup for all audio paths
- Respects `postRecordingStorage` policy setting
- Auto-actions for `keep-compressed` and `delete` policies; modal shown for `ask`

**Audio compression** (`src/services/audioCompressionService.ts`):
- `replaceAudioFile()`: Backlink-safe audio vault replacement

**Settings**: `offerMediaCompression` (`'always' | 'large-files' | 'never'`), `mediaCompressionThreshold` (image-scoped); `postRecordingStorage` (`'ask' | 'keep-original' | 'keep-compressed' | 'delete'`) for audio cleanup

### Digitisation Settings

**DigitisationSettingsSection** (`src/ui/settings/DigitisationSettingsSection.ts`):
- `digitiseDefaultMode`, `digitiseMaxDimension`, `digitiseImageQuality`

**SketchSettingsSection** (`src/ui/settings/SketchSettingsSection.ts`):
- `sketchOutputFolder`, `sketchAutoDigitise`, `sketchDefaultPenColour`, `sketchDefaultPenWidth`

## Mermaid Chat (Conversational Diagram Editing)

**Status**: ✅ Implemented (March 2026) — Phases 1-4

### Overview

Conversational Mermaid diagram editing modal. Users describe diagrams in natural language; LLM generates/modifies Mermaid code with live preview, version history, diff view, templates, and multi-format export.

### Core Components

**MermaidChatModal** (`src/ui/modals/MermaidChatModal.ts`):
- Split-pane layout: chat left, preview right (desktop); tabbed toggle (mobile)
- Streaming LLM responses with live preview rendering
- Version history navigation (prev/next within session)
- Line-level diff view between consecutive versions
- Edit coalescing: rapid applies within 5s reuse tracked range
- Type conversion via `DiagramTypePickerModal` (12 target types)
- Block fingerprinting for in-place diagram updates
- Privacy consent gating on all LLM calls (chat, alt-text, export)

**MermaidContextService** (`src/services/mermaidContextService.ts`):
- `gatherContext(file, currentDiagram)`: Sibling diagram detection, backlink context, RAG integration
- Token budget management (siblings 2000, backlinks 1500, RAG 1500 chars)

**MermaidChangeDetector** (`src/services/mermaidChangeDetector.ts`):
- Jaccard similarity on word sets + heading structure comparison
- `MIN_JACCARD_SIMILARITY = 0.70`, 30-minute snooze duration
- Captures snapshots on apply, checks staleness on modal re-open

**MermaidTemplateService** (`src/services/mermaidTemplateService.ts`):
- Built-in fallback templates (flowchart, sequence, mindmap, gantt)
- User-defined templates in `AI-Organiser/Config/mermaid-templates.md`
- `parseTemplateFile()` / `saveAsTemplate()` for CRUD

**MermaidExportService** (`src/services/mermaidExportService.ts`):
- `.mermaid` text file, SVG, PNG (Canvas API @ 2x), new canvas, append to existing canvas
- Alt-text injection for SVG (`<title>`) and PNG (companion `.alt.txt` sidecar)
- `CanvasPickerModal` for selecting existing `.canvas` files

**Supporting UI**:
- `MermaidBlockPickerModal`: FuzzySuggestModal for selecting existing mermaid blocks in note
- `MermaidTemplatePickerModal`: FuzzySuggestModal for template selection
- `MermaidChatSettingsSection`: Context toggles, staleness notice, alt-text, export options
- `mermaidStalenessGutter.ts`: Editor gutter extension for stale diagram indicators

**Utilities**:
- `mermaidUtils.ts`: `findMermaidBlocks()`, `resolveBlockByFingerprint()`, `cleanMermaidOutput()`
- `mermaidDiff.ts`: `computeLineDiff()`, `getDiffStats()`, `hasMeaningfulChanges()`

### Prompts (`src/services/prompts/mermaidChatPrompts.ts`)

- `buildMermaidChatSystemPrompt()`: System prompt with provider/model awareness
- `buildMermaidChatUserPrompt()`: User prompt with note context, siblings, backlinks, RAG
- `buildTypeConversionInstruction()`: Type conversion instructions
- `buildDiagramAltTextPrompt()`: Accessibility alt-text generation
- `formatConversationTurn()`: Conversation history formatting

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mermaidChatIncludeNoteContext` | `true` | Include note content in prompts |
| `mermaidChatIncludeBacklinks` | `false` | Include backlink context |
| `mermaidChatIncludeRAG` | `false` | Include RAG context |
| `mermaidChatStalenessNotice` | `false` | Show stale diagram warnings (opt-in) |
| `mermaidChatGenerateAltText` | `false` | Generate accessibility alt-text on export |
| `mermaidChatExportTheme` | `'default'` | Export theme (not yet applied — uses Obsidian theme) |

### Commands
- `mermaid-chat`: In Command Picker → Active Note (via `smartNoteCommands.ts`)

### Tests
- `tests/mermaidDiff.test.ts`: Line diff computation, stats, meaningful change detection
- `tests/mermaidChangeDetector.test.ts` (24 tests): Snapshot, staleness, snooze, Jaccard
- `tests/mermaidContextService.test.ts` (15 tests): Budget, siblings, context gathering
- `tests/mermaidTemplateService.test.ts` (20 tests): Fallback templates, parsing, load/save
- `tests/mermaidExportService.test.ts` (15 tests): All export formats, appendToCanvas

### Key Patterns
- **Block fingerprinting**: First 80 chars of diagram code + line proximity for re-resolution
- **Edit coalescing**: 5-second window to prevent undo-stack noise from rapid applies
- **Consent gating**: All LLM calls (chat, alt-text) require `ensurePrivacyConsent()` — session-scoped
- **Context toggles**: Each context source (note, backlinks, RAG) independently toggled in settings
- **SonarQube compliance**: `handleSend` CC=12, `applyToNote` CC=10 (limit 15)

---

## Find Embeds / Vault Hygiene

**Status**: ✅ Implemented (February 2026)

### Overview

Vault hygiene command that scans for all embedded and linked files, showing reference counts, file sizes, types, and orphan detection. Helps users find assets before deleting notes.

### Core Components

**Embed Scan Service** (`src/services/embedScanService.ts`):
- `scanNotes()`: Main scan function with AbortSignal cancellation and progress callbacks
- `normalizeEmbedPath()`: Case-insensitive, extension-optional, path suffix matching
- `classifyExtension()`: Type classification (image, audio, video, pdf, document, canvas, other)
- `formatFileSize()`: Human-readable size formatting
- `extractReferencesFromLine()`: 4 regex patterns (markdown/wiki × embed/link)
- `getMarkdownFilesInFolder()`: Recursive folder traversal for scope support
- No deduplication — counts every reference occurrence for accurate counts
- Orphan detection: files with 0 inbound references flagged as possibly orphaned

**Embed Scan Results Modal** (`src/ui/modals/EmbedScanResultsModal.ts`):
- Interactive results with expandable rows showing referencing notes
- Filter/sort/search: text search, type chip toggles, min file size filter
- Sort by reference count, file size, or name (ascending/descending)
- "Possibly Orphaned" collapsed section with disclaimer
- File size display with human-readable formatting

**Embed Scan Scope Modal** (`src/ui/modals/EmbedScanScopeModal.ts`):
- Scope picker: current note, current folder, entire vault
- Arrow key navigation + ARIA attributes for accessibility
- Enter/Space activation

**Commands** (`src/commands/embedScanCommands.ts`):
- `find-embeds`: In Command Picker → Tools → Vault Hygiene

### Settings

No dedicated settings — uses existing plugin folder configuration.

### Tests
- `tests/embedScanService.test.ts` (70 tests): normalizeEmbedPath, classifyExtension, formatFileSize, getEmbedTypeIcon, hasEmbedTypeExtension, isExternalUrl, extractReferencesFromLine, EMBED_TYPE_EXTENSIONS
- `tests/commandPicker.test.ts`: Updated leaf count (31→32), added find-embeds command

### Key Patterns
- **No dedup**: Every embed/link occurrence counted separately for accurate reference counts
- **Link normalization**: Case-insensitive matching, optional extensions, path suffix matching
- **Orphan detection**: Advisory only — "possibly orphaned" with disclaimer about potential false positives
- **AbortSignal**: Cancellable scan with progress callback for UI updates
- **ARIA + keyboard nav**: Scope picker follows accessibility best practices
- **i18n**: Full `embedScan` section at top level of Translations (~60 keys)

## Free Chat & Smart Document Indexing (Plan 3)

**Status**: ✅ Implemented (March 2026)

### Overview

Full-featured free-form chat mode with file attachments, smart document indexing (ONNX RAG), project-based persistent conversations, auto-memory extraction, and conversation persistence with resume.

### Core Components

**FreeChatModeHandler** (`src/ui/chat/FreeChatModeHandler.ts`):
- `AttachmentEntry` / `IndexedAttachmentEntry` interfaces for attachment state
- Vault file picker + native OS file picker (Electron dialog, desktop only)
- `handleLargeAttachment()`: triggers `IndexingChoiceModal` when file exceeds token budget
- `indexAttachment()`: creates `AttachmentIndexService`, indexes in background, updates pill state
- `tryAutoBootstrapEmbeddings()`: lazy-initialises ONNX embedding service when no API key is configured
- `rehydrateIndexedDocument()`: re-embeds a persisted document on project load
- `tryReextractAttachment()`: re-reads vault or external files for attachments restored without text
- `resolveProviderAndModel()`: checks `serviceType === 'local'` first for correct token budget
- `addGlobalMemoryFact()` / `addProjectMemoryFact()`: live in-memory update after async vault saves
- `clearProjectContext()`: disposes + removes `indexMode === 'project'` attachments on project switch
- `getProjectName()`: returns `projectConfig.name` for dropdown label
- Prompt budget fractions: system 2%, project instructions 5%, project memory 3%, global memory 3%, history 30%, indexed RAG 25%, flat attachments 20%

**AttachmentIndexService** (`src/services/chat/attachmentIndexService.ts`):
- In-memory cosine-similarity RAG; chunks via `chunkPlainTextAsync`, batched ONNX embedding (10/batch)
- `queryRelevantChunks(query, { topK, maxChars })`: returns trimmed relevant context
- Mobile 200-chunk cap with `isPartial` flag and `totalChunks` for accurate pill display
- `dispose()`: releases embedding references

**IndexingChoiceModal** (`src/ui/modals/IndexingChoiceModal.ts`):
- Options: Project (persist to vault), Temporary (in-session), Truncate, Open Settings (when no embeddings)
- `waitForChoice()`: async Promise with single-flight guard (`resolved` flag prevents double-resolution)
- `onClose()` defaults to `'truncate'` (safe fallback)
- Label changes: "Create project" (no active project) vs "Index into project" (project active)

**LocalOnnxEmbeddingService** (`src/services/embeddings/localOnnxEmbeddingService.ts`):
- Wraps `@xenova/transformers` v2 pipeline (dynamic import, not bundled by default)
- `@xenova/transformers` added to `optionalDependencies` and removed from esbuild externals — **must bundle** for Obsidian deployment (node_modules not available at plugin runtime)
- Bundle size: 7.1 MB → 8.5 MB
- Model: `Xenova/all-MiniLM-L6-v2` (384 dims, 512 token max) — zero-setup fallback

**ConversationPersistenceService** (`src/services/chat/conversationPersistenceService.ts`):
- Per-mode file tracking via `currentFiles: Map<ChatMode, TFile | null>`
- `startNew(mode)`: clears handle so next save creates a fresh file in the correct folder
- `scheduleSave(state)`: 1-second debounced save
- `saveNow(state)`: bypasses debounce (called in `onClose()` before `cancelAllPending()`)
- `pruneOldConversations(days)`: housekeeping on modal open
- `listRecent(n)`: feeds the resume picker

**ConversationCompactionService** (`src/services/chat/conversationCompactionService.ts`):
- Token-aware history trimming with `[Compacted N messages]` marker
- `resetAll()`: called in `onClose()` for clean teardown

**ProjectService** (`src/services/chat/projectService.ts`):
- `createProject(name)` → slug + `_project.md` with YAML frontmatter
- `saveIndexedDocument(projectId, fileName, extractedText, chunkCount)`: creates vault note at `Projects/<slug>/indexed/<name>.md`, appends `- [[indexed/<name>]] (N chunks)` to `## Indexed Documents` in `_project.md`; deduplicates: existing entries have chunk count updated in-place
- `loadIndexedDocuments(config)`: parses manifest, re-reads vault notes for rehydration

**GlobalMemoryService** (`src/services/chat/globalMemoryService.ts`):
- Facts stored at `AI-Organiser/Config/global-memory.md`
- Deduplication on add, pruning support

**UnifiedChatModal wiring**:
- `onClose()` calls `saveNow()` before `cancelAllPending()` — guards 1s debounce window
- All three "enter project" paths call `persistenceService.startNew('free')` — clears stale file handle
- `loadProjectContext()` calls `clearProjectContext()` first — prevents stale attachment leak
- `processMemoryMarkers()` calls `addGlobalMemoryFact()` / `addProjectMemoryFact()` after async saves
- `renderProjectDropdown()` uses `freeChatHandler.getProjectName()` for the active label

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `enableChatPersistence` | `true` | Persist conversations to vault |
| `chatRootFolder` | `'AI Chat'` | Root folder under plugin folder |
| `chatRetentionDays` | `30` | Days before conversations are pruned |

### Tests

- `tests/attachmentIndexService.test.ts`
- `tests/chatPersistenceUtils.test.ts`
- `tests/conversationCompaction.test.ts`
- `tests/globalMemoryService.test.ts`
- `tests/indexingChoiceModal.test.ts` (13 tests: waitForChoice, DOM structure, onClose cleanup)
- `tests/localOnnxEmbeddingService.test.ts`
- `tests/projectService.test.ts`
- `tests/projectServicePersistence.test.ts` (8 tests: saveIndexedDocument, loadIndexedDocuments)

Total: 3375 unit tests (136 suites)

### Key Patterns

- **ONNX fallback**: `embeddingServiceFactory` falls back to `LocalOnnxEmbeddingService` when provider needs API key but none configured — zero-setup path
- **Bundled ONNX**: `@xenova/transformers` must be in bundle, not external — Obsidian plugins cannot access `node_modules` at runtime
- **resolveProviderAndModel()**: always check `serviceType === 'local'` before reading cloud settings for token budgets
- **Single-flight guard**: `IndexingChoiceModal.resolved` flag prevents double-resolution on multiple `onClose()` calls
- **clearProjectContext()**: must dispose `indexMode === 'project'` attachments to prevent memory leaks on project switch
- **saveNow in onClose**: critical for conversations closed within the 1-second debounce window

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

### Commands
- `newsletter-fetch`: Fetch newsletters now — in Command Picker → Capture

### Tests
- `tests/newsletterServiceIntegration.test.ts` (27 tests): fetch pipeline, seen-ID dedup, two-phase confirmation, HTML detection, key links extraction, hit-limit flag

**Plan**: [docs/completed/newsletter-digest-plan.md](docs/completed/newsletter-digest-plan.md)

## Reviewed Edits Modal

**Status**: ✅ Implemented (March 2026)

### Overview

Inline diff review shown before any write command (Improve Note, Translate, Integrate Pending) modifies the active note. User sees a GitHub-style diff and chooses Accept, Copy to Clipboard, or Reject.

### Core Components

- `src/ui/modals/ReviewEditsModal.ts`: `ReviewEditsModal` extends `Modal`; takes `DiffLine[]`, `DiffStats`, `newContent`, and `onAction` callback; `simulateAction()` for testing; ESC-safe `onClose()` fires reject if no action taken
- `src/utils/reviewEditsHelper.ts`: `showReviewEditsModal()` helper that wraps `computeLineDiff()` + modal open into a single awaitable call
- `src/commands/smartNoteCommands.ts`, `translateCommands.ts`, `integrationCommands.ts`: call `showReviewEditsModal()` before applying writes when `settings.reviewEditsEnabled`

### Key Patterns
- **Action types**: `'accept' | 'copy' | 'reject'` — copy writes to clipboard without modifying note
- **Double-fire guard**: `actionFired` boolean prevents `onClose()` from re-firing after button click
- **Diff rendering**: prefix gutter (`+`/`−`) in separate `<span>`, content in separate `<span>` — allows independent CSS targeting
- **Stats chips**: color-coded pills using `color-mix(in srgb, var(--color-green/red) 15%, transparent)` — adapts to light/dark mode
- **Diff tints**: `color-mix(in srgb, var(--color-green/red) 10%, transparent)` for line backgrounds — no hardcoded RGB, fully theme-adaptive

### Settings
| Setting | Default | Description |
|---------|---------|-------------|
| `reviewEditsEnabled` | `true` | Show diff review before applying writes |

### Tests
- `tests/reviewEditsHelper.test.ts`: helper wiring, action dispatch
- `tests/reviewEditsModal.test.ts`: action dispatch, ESC safety, double-fire guard

**Plan**: [docs/completed/reviewed-edits-plan.md](docs/completed/reviewed-edits-plan.md)

## Documentation

See `docs/` folder for additional documentation:
- [docs/STATUS.md](docs/STATUS.md): Development status and recent updates
- [docs/bases_user_guide.md](docs/bases_user_guide.md): Obsidian Bases integration guide
- [docs/usertest.md](docs/usertest.md): Manual testing checklist
- [docs/format-specs.md](docs/format-specs.md): File format compliance checklist (Canvas, Bases, Markdown)
- [docs/kindle-plan.md](docs/kindle-plan.md): Kindle Sync implementation plan (Phases 3-4 pending)
- [docs/claude-web-search-plan.md](docs/claude-web-search-plan.md): Claude Web Search provider plan
- [docs/completed/reviewed-edits-plan.md](docs/completed/reviewed-edits-plan.md): Inline diff review for write commands (Improve, Translate, Integrate)
- [docs/completed/newsletter-digest-plan.md](docs/completed/newsletter-digest-plan.md): Gmail newsletters → AI triage summary → vault inbox
- [docs/completed/pres-plan.md](docs/completed/pres-plan.md): AI Chat + Presentation Builder implementation plan
- [docs/completed/web-research-plan.md](docs/completed/web-research-plan.md): Web Research Assistant implementation plan (Phases 1-3)
- [docs/completed/smart-digitisation-plan.md](docs/completed/smart-digitisation-plan.md): Smart Digitisation project plan
- [docs/completed/quic-plan.md](docs/completed/quic-plan.md): Quick Peek fast triage implementation plan
- [docs/plans/command-picker-ux.md](docs/plans/command-picker-ux.md): Command Picker UX overhaul plan (implemented)
- [docs/cde-plan.md](docs/cde-plan.md): Chunking, Decomposition & Extraction quality plan (6 phases)
- [docs/det-plan.md](docs/det-plan.md): Deterministic Validation & LLM Audit plan (6 phases)
