# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

> **Note:** This is the canonical reference for all AI coding agents. Keep in sync with `CLAUDE.md`.

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
- **Prompt engineering** (`src/services/prompts/`): XML-structured prompts optimized for Claude/GPT

**Key service flow**:
1. Plugin calls `llmService.analyzeTags(content, candidateTags, mode, maxTags, language)`
2. Service builds prompt via `buildTagPrompt()` with mode-specific instructions
3. For cloud: Adapter formats request → calls API → parses response
4. Returns `LLMResponse` with `suggestedTags` and `matchedExistingTags`

### Settings & Configuration

**Settings schema** (`src/core/settings.ts`):
- `AIOrganiserSettings` interface with 35+ configuration options
- Key settings: `serviceType`, `cloudServiceType`, `interfaceLanguage`, `enableSemanticSearch`, `embeddingProvider`
- Settings UI split into modular sections (`src/ui/settings/`):
  - `LLMSettingsSection`: Service provider configuration, API keys
  - `TaggingSettingsSection`: Max tags, folder exclusions, note structure toggle
  - `InterfaceSettingsSection`: Interface language, output languages
  - `SummarizationSettingsSection`: Summary style, personas, transcript options
  - `SemanticSearchSettingsSection`: Embeddings, indexing, RAG settings
  - `ConfigurationSettingsSection`: Config files management

**Settings persistence**: Loaded in `loadSettings()`, saved via `saveSettings()`, triggers service reinitialization.

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
- `summarizeCommands.ts`: URL/PDF/YouTube/Audio summarization
- `translateCommands.ts`: Translation commands
- `smartNoteCommands.ts`: Improve note, find resources, diagrams
- `flashcardCommands.ts`: Flashcard export (Anki/Brainscape)
- `utilityCommands.ts`: Collect tags, tag network

All commands use `plugin.addCommand()` with i18n names and icon support.

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
- **RAG features**: `src/services/ragService.ts`, `src/services/vector/vectorStoreService.ts`
- **Semantic views**: `src/ui/views/RelatedNotesView.ts`
- **Bases integration**: `src/utils/frontmatterUtils.ts`, `src/services/migrationService.ts`, `src/services/dashboardService.ts`
- **Metadata handling**: `src/core/constants.ts`, `src/utils/responseParser.ts`
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

## Planned Features

See `docs/` folder for implementation plans:
- [docs/notebooklm_integration_plan.md](docs/notebooklm_integration_plan.md): NotebookLM Source Pack export for consumer mode
