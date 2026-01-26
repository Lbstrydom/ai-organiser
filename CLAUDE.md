# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Note:** This file and `AGENTS.md` should be kept in sync. `AGENTS.md` is the canonical reference for all AI coding agents.

## Build Commands

```bash
# Development build with watch mode and inline sourcemaps
npm run dev

# Production build (type-checks, then bundles)
npm run build

# Version bump (updates manifest.json and versions.json)
npm run version
```

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
- **Prompt engineering** (`src/services/prompts/tagPrompts.ts`): XML-structured prompts optimized for Claude/GPT with clear task/requirements/output sections

**Key service flow**:
1. Plugin calls `llmService.analyzeTags(content, candidateTags, mode, maxTags, language)`
2. Service builds prompt via `buildTagPrompt()` with mode-specific instructions
3. For cloud: Adapter formats request → calls API → parses response
4. Returns `LLMResponse` with `suggestedTags` and `matchedExistingTags`

### Provider Registries

**LLM Provider Registry** (`src/services/adapters/providerRegistry.ts`):
- `ALL_ADAPTERS`: List of all 14 supported adapter types
- `PROVIDER_DEFAULT_MODEL`: Default model per provider (e.g., `openai: 'gpt-5.2'`)
- `PROVIDER_ENDPOINT`: Default API endpoint per provider
- `buildProviderOptions(t)`: Generate dropdown options from translations

**Embedding Provider Registry** (`src/services/embeddings/embeddingRegistry.ts`):
- `EMBEDDING_DEFAULT_MODEL`: Default model per embedding provider (6 providers)
- `EMBEDDING_MODELS`: Available models per provider
- `getEmbeddingModelOptions(provider)`: UI-friendly labeled options with recommendations

**Usage pattern**:
```typescript
import { PROVIDER_DEFAULT_MODEL, PROVIDER_ENDPOINT } from './providerRegistry';
const defaultModel = PROVIDER_DEFAULT_MODEL[adapterType];
const endpoint = PROVIDER_ENDPOINT[adapterType];
```

### Tagging Modes

Four distinct modes in `TaggingMode` enum:
- **GenerateNew**: AI creates entirely new tags from content
- **PredefinedTags**: AI selects only from existing vault/file tags
- **Hybrid**: Combines both (generates new + matches existing)
- **Custom**: User-defined prompt with custom instructions

Mode selection affects prompt structure and tag merging logic in `analyzeAndTagNote()`.

### Settings & Configuration

**Settings schema** (`src/core/settings.ts`):
- `AIOrganiserSettings` interface with 35+ configuration options
- Key settings: `serviceType`, `cloudServiceType`, `interfaceLanguage`, `enableSemanticSearch`, `embeddingProvider`
- Settings UI split into modular sections (`src/ui/settings/`):
  - `LLMSettingsSection`: Service provider configuration, API keys
  - `TaggingSettingsSection`: Max tags, folder exclusions
  - `ConfigurationSettingsSection`: Config files management
  - `InterfaceSettingsSection`: Interface language, tag output language, summary language (consolidated)
  - `SemanticSearchSettingsSection`: Embeddings, indexing, RAG settings (Phase 4.4)
  - `SummarizationSettingsSection`: Summary style, personas, transcript options

**Settings persistence**: Loaded in `loadSettings()`, saved via `saveSettings()`, triggers service reinitialization.

### Internationalization (i18n)

**Translation system** (`src/i18n/`):
- Supported languages: English (`en.ts`) and Simplified Chinese (`zh-cn.ts`)
- Type-safe translations via `Translations` interface
- Access translations: `this.t.settings.someKey` or `plugin.t.messages.someMessage`
- Language switch requires Obsidian restart to update all UI elements

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

**Tag operations** (`src/utils/tagOperations.ts`):
- Batch processing with progress notifications
- Handles file reading, content analysis, frontmatter updates

### RAG & Semantic Search (Phase 4.4)

**Vector Store** (`src/services/vector/`):
- `VoyVectorStore`: Production vector storage using Voy WASM
- `IVectorStore` interface for vector operations
- Chunk-based indexing with configurable size and overlap

**RAG Service** (`src/services/ragService.ts`):
- `RAGService.getRelatedNotes()`: Semantic note discovery
- `RAGService.retrieveContext()`: Context retrieval for RAG
- `RAGService.buildRAGPrompt()`: Enhanced prompt building with vault context
- `RAGService.formatSources()`: Source citation formatting

**Related Notes View** (`src/ui/views/RelatedNotesView.ts`):
- Persistent sidebar ItemView showing semantically similar notes
- Auto-updates with 500ms debounce on note switch
- State management: `RelatedNotesState` interface
- Interactive features: click navigation, hover preview, copy markdown link
- Color-coded similarity badges (excellent ≥0.8, good ≥0.6, fair <0.6)
- Error states: disabled, loading, empty, error, results

**RAG-Enhanced Summarization**:
- `summarizeTextWithLLM(useRAG: boolean)` in `src/commands/summarizeCommands.ts`
- Extracts query from prompt (first sentence)
- Retrieves 3 relevant chunks (similarity ≥ 0.7)
- Builds enhanced prompt with vault context
- Appends source citations to summary output
- Graceful fallback on RAG errors

**Semantic Search Settings** (`src/ui/settings/SemanticSearchSettingsSection.ts`):
- Master toggle for semantic search features
- Embedding provider selection (OpenAI, Claude/Voyage, Gemini, Ollama, etc.)
- Auto-updates embedding model on provider change
- Auto-fills API key from main LLM key
- API key masking (shows first 6 chars: `sk-abc•••••••`)
- Indexing options: auto-index, excluded folders, chunk size/overlap
- RAG options: vault chat, context chunks, metadata inclusion

### Tag Network Visualization

**Implementation** (`src/ui/views/TagNetworkView.ts`):
- Custom Obsidian `ItemView` for graph visualization
- Dynamically loads D3.js v7 from CDN
- Network data built by `TagNetworkManager` (`src/utils/tagNetworkUtils.ts`)
- Interactive features: search filtering, hover tooltips, node dragging

**Network structure**:
- Nodes: Tags with frequency and size
- Edges: Co-occurrence relationships between tags
- Color coding by frequency (low/medium/high)

## Command Registration

Commands registered in `src/commands/`:
- `generateCommands.ts`: Tag generation for notes/folders/vault
- `clearCommands.ts`: Clear tags from notes/folders/vault
- `predefinedTagsCommands.ts`: Assign predefined tags
- `utilityCommands.ts`: Collect tags, show network visualization
- `summarizeCommands.ts`: URL/PDF/YouTube/Audio summarization
- `translateCommands.ts`: Note and selection translation
- `smartNoteCommands.ts`: Improve note, find resources, diagrams
- `minutesCommands.ts`: Meeting minutes generation

All commands use `plugin.addCommand()` with i18n names and icon support.

## Important Implementation Patterns

### Prompt Engineering Standards

All prompts use XML-style structure:
```
<task>What to do</task>
<requirements>Constraints and rules</requirements>
<output_format>Expected format with examples</output_format>
```

This format optimized for Claude/GPT-4 comprehension. Include language instructions for non-English tag generation.

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
- Debug mode (`settings.debugMode`) enables console logging
- Graceful degradation: failed operations return `{success: false, message: ...}`

### RAG Integration Patterns (Phase 4.4)

**Semantic Search Enablement**:
- Always check `plugin.settings.enableSemanticSearch` before RAG operations
- Verify `plugin.vectorStore` exists before calling RAG methods
- Provide graceful fallback if RAG unavailable

**Related Notes Discovery**:
```typescript
if (plugin.vectorStore && plugin.settings.enableSemanticSearch) {
    const results = await plugin.ragService.getRelatedNotes(currentFilePath, { maxResults: 5, minSimilarity: 0.6 });
    // Display results in sidebar
}
```

**RAG-Enhanced Prompts**:
```typescript
if (useRAG && plugin.vectorStore && plugin.settings.enableSemanticSearch) {
    const query = extractQueryFromPrompt(prompt);
    const context = await plugin.ragService.retrieveContext(query, undefined, { maxChunks: 3, minSimilarity: 0.7 });
    const enhancedPrompt = plugin.ragService.buildRAGPrompt(prompt, context, systemPrompt);
    // Use enhanced prompt for LLM call
    const sources = plugin.ragService.formatSources(context.sources);
    // Append sources to response
}
```

**API Key Inheritance Chain**:
1. `plugin.settings.embeddingApiKey` (explicit embedding key)
2. `plugin.settings.providerSettings[provider]?.apiKey` (provider-specific key)
3. `plugin.settings.cloudApiKey` (main LLM API key)

**Embedding Model Auto-Update**:
- When provider changes, update model to provider default if:
  - Current model is empty, OR
  - Current model equals previous provider's default
- Use `getDefaultEmbeddingModel(provider)` helper

## Testing Approach

**Automated Tests**:
```bash
npm test              # Run Vitest unit tests (679 tests, 29 suites)
npm run test:watch    # Watch mode
npm run test:coverage # With coverage report
npm run test:auto     # Run automated integration tests (no Obsidian required)
npm run build         # Full build (source type-check + tests + bundle)
npm run build:quick   # Quick build (source type-check + bundle, skips test types)
```

**Build Configuration**:
- `tsconfig.json` - Full config including tests (for IDE)
- `tsconfig.build.json` - Source-only config (for production builds)

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
   - **Deploy path**: `C:\obsidian\Second Brain\.obsidian\plugins\ai-organiser\`
3. Reload Obsidian (Ctrl/Cmd+R or restart)
4. Test with various LLM providers and features

See `docs/usertest.md` for manual testing checklist.

## Deployment Verification ⚠️ CRITICAL

**Always verify deployment after building.** Stale builds in the Obsidian vault cause confusion when changes appear not to work.

### Deploy Path
```
C:\obsidian\Second Brain\.obsidian\plugins\ai-organiser\
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
ls -la "C:/obsidian/Second Brain/.obsidian/plugins/ai-organiser/main.js"

# Deploy if timestamps don't match
cp main.js manifest.json styles.css "C:/obsidian/Second Brain/.obsidian/plugins/ai-organiser/"
```

### Common Issue: Stale Builds
If changes don't appear after Obsidian restart:
1. Compare timestamps between repo and vault
2. Check file sizes match
3. Re-deploy all three files
4. Restart Obsidian completely (not just reload)

### Quick Deploy Command
```bash
npm run build && cp main.js manifest.json styles.css "C:/obsidian/Second Brain/.obsidian/plugins/ai-organiser/"
```

## Code Organization Principles

### Modular Settings UI
Each settings section is a separate class extending `BaseSettingSection`. Add new sections by creating a class in `src/ui/settings/` and instantiating in `AITaggerSettingTab.ts`.

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
- **Prompt changes**: Edit `src/services/prompts/` (tagPrompts, summaryPrompts, etc.)
- **UI modifications**: `src/ui/settings/AITaggerSettingTab.ts` and section files
- **New LLM providers**: `src/services/adapters/` and update `cloudService.ts`
- **Tag processing logic**: `src/utils/tagUtils.ts`
- **RAG features**: `src/services/ragService.ts`, `src/services/vector/vectorStoreService.ts`
- **Semantic views**: `src/ui/views/RelatedNotesView.ts`
- **Translations**: `src/i18n/en.ts` and `src/i18n/zh-cn.ts`

## Version Management

Version is stored in three places (must stay in sync):
- `package.json` → `version`
- `manifest.json` → `version`
- `versions.json` → add new entry

Use `npm run version` to bump all three automatically via `version-bump.mjs`.

## Known Constraints

- Obsidian API externals must match platform version (defined in `esbuild.config.mjs`)
- TypeScript compilation is strict mode with ES2020 target
- D3.js loaded dynamically from CDN (no bundling) for network visualization
- Interface language change requires Obsidian restart (output languages do not)
- Tag formatting preserves `/` for nested tags but converts other special chars to hyphens
- Claude/Anthropic has no embeddings API (use Voyage AI instead)
- URL detection may include trailing punctuation (e.g., `https://example.com.` includes the period)

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

## Settings UX Patterns

### Language Settings Consolidation
All language settings are consolidated in `InterfaceSettingsSection`:
- **Interface Language**: UI language (requires restart)
- **Tag Output Language**: Language for generated tags
- **Summary Language**: Language for summaries

### API Key Inheritance
Embedding API key follows a fallback chain:
1. `embeddingApiKey` (explicit embedding key)
2. `providerSettings[provider].apiKey` (provider-specific key)
3. `cloudApiKey` (main LLM API key)

The UI shows "Use main API key" button when same provider is selected.

### Excluded Folders Toggle
Semantic search indexing can share tagging exclusions or use custom list:
- `useSharedExcludedFolders: true` → uses `excludedFolders` from tagging
- `useSharedExcludedFolders: false` → uses `indexExcludedFolders` custom list

### Embedding Model Dropdowns
Embedding models are provider-specific dropdowns (not free text):
- Each provider has curated model options with recommended defaults
- Custom models can still be used (shown as "custom" if not in list)

## Semantic Search & RAG Implementation Status ✅ COMPLETE

### Embedding Service Infrastructure
**Location:** `src/services/embeddings/`

- **IEmbeddingService interface** with `generateEmbedding()`, `batchGenerateEmbeddings()`
- **5 Embedding Providers**:
  - **OpenAI** - text-embedding-3-small/large (1536/3072 dims)
  - **Ollama** - nomic-embed-text, mxbai-embed-large (local)
  - **Gemini** - text-embedding-004 (768 dims)
  - **Cohere** - embed-english-v3.0 (1024 dims)
  - **Voyage AI** - voyage-3/voyage-3-lite (high quality)
- **Factory pattern**: `createEmbeddingServiceFromSettings()` handles API key inheritance
- **Note**: Claude/Anthropic does NOT have an embeddings API - use Voyage AI instead

### Phase 4.4 RAG Enhancements (All Complete)
- ✅ **Phase 4.4.1**: Related Notes Sidebar View (458 lines)
- ✅ **Phase 4.4.2**: RAG-Enhanced Summarization
- ✅ **Phase 4.4.3**: Search Result Caching (5-min TTL, LRU eviction)

### Local Setup Wizard
**Location:** `src/ui/modals/LocalSetupWizardModal.ts`

3-step wizard for local AI setup:
1. Install Ollama with platform-specific instructions
2. Download models with RAM-based recommendations
3. Test connection and apply settings

2026 model recommendations included: Llama 3.3, Qwen 2.5, DeepSeek R1, Mistral 7B, Phi-4.

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

- `summarizeAndInsert()` modified (lines 1515-1599):
  - **If `enableStructuredMetadata`**:
    - Use `buildStructuredSummaryPrompt()`
    - Parse JSON response with `parseStructuredResponse()`
    - Extract `body_content`, `summary_hook`, `suggested_tags`, `content_type`
    - Insert body content into note
    - Update metadata with `updateNoteMetadataAfterSummary()`
  - **Else**: Use traditional `buildSummaryPrompt()` (backward compatibility)

### Key Implementation Patterns

**Simple Property Names**: Metadata uses clean, user-friendly names (`summary`, `source_url`) for better readability

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

## Meeting Minutes Generation

**Status**: ✅ Implemented (January 2026)

### Overview

Generate structured meeting minutes from transcripts with persona-based output styles, terminology dictionaries for transcription accuracy, and context document support.

### Core Components

**Minutes Service** (`src/services/minutesService.ts`):
- `generateMinutes()`: Main generation function with transcript chunking
- Supports transcripts over 5000 tokens via chunked processing
- Context chaining between chunks for coherent output
- Consolidation pass for final unified minutes
- Accepts `dictionaryContent` and `contextDocuments` for enhanced accuracy

**Dictionary Service** (`src/services/dictionaryService.ts`):
- `listDictionaries()`, `loadDictionary()`, `saveDictionary()`: CRUD operations
- `addEntries()`: Merge entries with case-insensitive deduplication
- `formatForPrompt()`: Format dictionary as XML for LLM injection
- `buildExtractionPrompt()`: Prompt for extracting terms from documents
- `parseExtractionResponse()`: Parse LLM response into dictionary entries
- Dictionaries stored as markdown in `AI-Organiser/Config/dictionaries/` (syncs across devices)

**Dictionary Entry Categories**:
- `person`: Names with roles/titles
- `acronym`: Abbreviations with expansions
- `term`: Domain-specific terminology
- `project`: Project names and codes
- `organization`: Company/team names

**Minutes Prompts** (`src/services/prompts/minutesPrompts.ts`):
- `buildMinutesPrompt()`: XML-structured prompt for LLM
- Includes meeting metadata, participants, agenda, transcript
- Persona-based tone and style instructions
- Obsidian Tasks format support for action items
- Dictionary injection for name/term consistency

**Minutes Modal** (`src/ui/modals/MinutesCreationModal.ts`):
- Comprehensive meeting input form
- Fields: title, date, time, location, participants, agenda, transcript
- Context Documents section: attach agendas, presentations, spreadsheets
- Dictionary section: select, create, edit, or extract terminology
- Audio Transcription section: transcribe embedded audio files
- UX flow: Documents → Dictionary → Audio (dependency-first ordering)
- Persona selector from `minutes-personas.md`
- Dual output toggle (internal + public versions)
- Obsidian Tasks format toggle

**Minutes Settings** (`src/ui/settings/MinutesSettingsSection.ts`):
- Output folder configuration
- Default timezone (IANA format)
- Default persona selection
- Obsidian Tasks format toggle

**Minutes Utilities** (`src/utils/minutesUtils.ts`):
- `formatMinutesFilename()`: Generate standardized filenames
- `parseMinutesResponse()`: Extract structured data from LLM response
- `formatMinutesMarkdown()`: Convert to final markdown output

**Text Chunker** (`src/utils/textChunker.ts`):
- `chunkText()`: Split long transcripts by token count
- Sentence boundary detection for clean splits
- Overlap support for context continuity

### Configuration Files

**Minutes Personas** (`AI-Organiser/Config/minutes-personas.md`):
```markdown
## Executive Summary
- **Description**: Brief, action-focused minutes for executives
- **Tone**: Professional, concise, results-oriented
```

**Terminology Dictionaries** (`AI-Organiser/Config/dictionaries/`):
- Stored as markdown files with YAML frontmatter
- Reusable across multiple meetings
- Auto-deduplicates when adding new terms

### Key Patterns

- **Transcript Chunking**: Long meetings split into 5000-token chunks
- **Context Chaining**: Each chunk receives previous chunk's summary
- **Persona System**: Reuses existing persona infrastructure
- **Obsidian Tasks**: Actions formatted as `- [ ] Task @due(date)`
- **Dual Output**: Optional public version with confidential info redacted
- **Dictionary-First Workflow**: Extract terms from documents before transcription
- **Cross-Meeting Reuse**: Same dictionary works for January and February meetings
- **Document Truncation**: Inline controls for oversized documents (truncate/full/skip) with configurable settings

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
```typescript
// Document character limits (single source of truth)
export const DEFAULT_MAX_DOCUMENT_CHARS = 50000;
export const DEFAULT_MULTI_SOURCE_MAX_DOCUMENT_CHARS = 100000;

// Type aliases for clarity
export type TruncationChoice = 'truncate' | 'full' | 'skip';
export type OversizedBehavior = 'ask' | 'truncate' | 'full';
```

**Unified Truncation Options** (`src/ui/modals/MinutesCreationModal.ts`):
- `getTruncationOptions(t)`: Returns `Record<TruncationChoice, {label, tooltip}>`
- Single source for labels and tooltips used in dropdowns and bulk actions
- DRY: Eliminates duplicate string definitions across modal

**Dependency Injection** (`src/ui/modals/MinutesCreationModal.ts`):
```typescript
export interface MinutesModalDependencies {
    minutesService?: MinutesService;
    dictionaryService?: DictionaryService;
    documentService?: DocumentExtractionService;
}

// Constructor supports optional DI for testability
constructor(app: App, plugin: AIOrganiserPlugin, deps?: MinutesModalDependencies) {
    this.minutesService = deps?.minutesService ?? new MinutesService(plugin);
    // ... etc
}
```

**Key Patterns**:
- **DRY Extensions**: All extension checks use constants from `constants.ts`
- **DRY Limits**: Character limits use `DEFAULT_MAX_DOCUMENT_CHARS` and `DEFAULT_MULTI_SOURCE_MAX_DOCUMENT_CHARS`
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

Controllers are instantiated per modal open to ensure fresh state:

```typescript
onOpen() {
    this.docController = new DocumentHandlingController(
        this.app, this.plugin, this.documentService, this.embeddedDetector
    );
    this.dictController = new DictionaryController(this.dictionaryService);
    this.audioController = new AudioController(this.app); // App only (ISP)
}
```

### No-Stubs Policy

**Critical**: All new code must follow the no-stubs policy:

- **No placeholder methods**: If a method isn't used by modal or tests, remove it
- **Public methods must have call sites**: Modal, other UI, or tests
- **Private helpers allowed**: If used by public methods
- **Errors returned, not thrown**: Use `errors: string[]` on result objects (except programmer misuse)

### Key Patterns

- **Immutable external interface**: All getters return shallow copies to prevent mutation
- **ID-based tracking**: File paths for vault items, normalized URLs for external items
- **Result objects**: `DocumentHandlingResult`, `DictionaryResult<T>`, `AudioResult<T>` with `errors: string[]`
- **Callback-based UI**: TruncationControls uses callbacks (IoC pattern), no modal dependencies
- **Type-safe translations**: `TruncationTranslations` interface for truncation UI text

### Testing

**Service tests**: `tests/minutesService.test.ts`, `tests/ragService.test.ts`
**Controller tests**: `tests/documentHandlingController.test.ts`, `tests/dictionaryController.test.ts`, `tests/audioController.test.ts`
**Component tests**: `tests/components/truncationControls.test.ts`
**Prompt tests**: `tests/promptInvariants.test.ts`, `tests/minutesPrompts.test.ts`
**Utility tests**: `tests/responseParser.test.ts`, `tests/textChunker.test.ts`, `tests/sourceDetection.test.ts`, `tests/frontmatterUtils.test.ts`, `tests/dashboardService.test.ts`

Total: 679 unit tests (29 suites) + 22 automated integration tests

## Documentation

See `docs/` folder for additional documentation:
- [docs/STATUS.md](docs/STATUS.md): Development status and recent updates
- [docs/bases_user_guide.md](docs/bases_user_guide.md): Obsidian Bases integration guide
- [docs/usertest.md](docs/usertest.md): Manual testing checklist

