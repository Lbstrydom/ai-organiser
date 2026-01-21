# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

**Entry Point**: `src/main.ts` (`AITaggerPlugin` class)
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
  - `SupportSection`: Buy me a coffee (always last)

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

No formal test suite exists. Testing process:
1. Build plugin: `npm run build`
2. Copy `main.js`, `manifest.json`, `styles.css` to the Obsidian plugin folder:
   - **Deploy path**: `C:\obsidian\Second Brain\.obsidian\plugins\ai-organiser\`
3. Reload Obsidian (Ctrl/Cmd+R or restart)
4. Test with various LLM providers and tagging modes
5. Check console logs if `debugMode` is enabled

Manual testing script available: `test-sanitization.js` (see `TEST_INSTRUCTIONS.md`).

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

## Planned Features

See `docs/` folder for implementation plans:
- `web-summarization-feature-plan.md`: URL/PDF summarization with multimodal LLM support
- `semantic-search-rag-implementation-plan.md`: Phase 4 RAG implementation roadmap
