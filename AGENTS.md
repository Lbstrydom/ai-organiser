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

**Automated Tests**: 95 unit tests using Vitest
```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # With coverage report
```

**Manual Testing**:
1. Build plugin: `npm run build`
2. Copy `main.js`, `manifest.json`, `styles.css` to Obsidian plugin folder:
   - **Deploy path**: `C:\obsidian\Second Brain\.obsidian\plugins\ai-organiser\`
3. Reload Obsidian (Ctrl/Cmd+R or restart)
4. Test with various LLM providers and features

See `docs/usertest.md` for manual testing checklist.

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
- **Prompt changes**: Edit `src/services/prompts/` (tagPrompts, summaryPrompts, etc.)
- **UI modifications**: `src/ui/settings/AIOrganiserSettingTab.ts` and section files
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

## CSS Conventions

- Use `ai-organiser-*` prefix for all CSS classes
- Modal styles in `styles.css`
- Settings section styles follow Obsidian conventions

## Planned Features

See `docs/` folder for implementation plans:
- `command-consolidation-proposal.md`: Smart Dispatcher pattern for command reduction
- `command-consolidation-implementation-prompt.md`: Implementation instructions
