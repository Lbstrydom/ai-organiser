# Vault Intelligence Tools

> Subsystem detail moved out of [AGENTS.md](../../AGENTS.md) so the canonical
> context file stays invariant-sized. AGENTS.md keeps the one-line stub and the
> load-bearing rules; the operational depth lives here.

Tools that operate over the whole vault rather than one note: Bases metadata + dashboards, the canvas boards, and the embed/hygiene scanner.

---

## Obsidian Bases Integration

**Status**: ✅ Fully Implemented (January 2025)

See docs/bases_integration.md (`docs/bases_integration.md` — removed) for complete implementation details and docs/bases_user_guide.md (`docs/bases_user_guide.md` — removed) for user documentation.

### Overview

The Bases integration enables structured metadata and dashboard generation for seamless integration with the Obsidian Bases plugin. This allows users to:
- Auto-populate 10 metadata properties during AI operations
- Migrate existing notes to the new metadata format
- Generate dashboard views with 5 built-in templates
- Query and organize notes using Bases' powerful filtering system

### Core Components

**Metadata Namespace** ([src/core/constants.ts](../../src/core/constants.ts))
- `AIO_META` object: Simple, user-friendly property names (no prefix)
- Core properties: `summary`, `source_url` (minimal set used by default)
- Additional properties available: `status`, `type`, `processed`, `model`, `source`, `word_count`, `language`, `persona`
- Type definitions: `ContentType`, `StatusValue`, `SourceType` enums
- `SUMMARY_HOOK_MAX_LENGTH = 280` (optimized for Bases preview pane)

**Frontmatter Utilities** ([src/utils/frontmatterUtils.ts](../../src/utils/frontmatterUtils.ts))
- `updateAIOMetadata(app, file, metadata)`: CRUD operations preserving existing frontmatter
- `getAIOMetadata(app, file)`: Read all AI Organiser metadata properties
- `createSummaryHook(summary)`: Truncate to 280 chars at sentence boundaries
- `isAIOProcessed(app, file)`: Check processing status
- `countWords(content)` and `detectLanguage(content)`: Auto-population helpers

**Structured Prompts** ([src/services/prompts/structuredPrompts.ts](../../src/services/prompts/structuredPrompts.ts))
- `StructuredSummaryResponse` interface: 5 fields (summary_hook, body_content, suggested_tags, content_type, detected_language)
- `buildStructuredSummaryPrompt(options)`: XML-style prompt requesting JSON output
- `insertContentIntoStructuredPrompt(prompt, content)`: Template function

**Response Parser** ([src/utils/responseParser.ts](../../src/utils/responseParser.ts))
- 4-tier fallback JSON parsing:
  1. Direct `JSON.parse()` of response
  2. Extract from markdown code fence (```json ... ```)
  3. Search for JSON object in text ({...})
  4. Create fallback from plain text (keyword detection)
- `createFallbackResponse(text)`: Infers type from keywords, extracts #tags, uses first sentences
- `sanitizeSummaryHook(hook)`: Validates 280-char limit

### Migration System

**Migration Service** ([src/services/migrationService.ts](../../src/services/migrationService.ts))
- `analyzeMigrationScope(folder?)`: Counts `needsMigration` vs `alreadyMigrated`
- `migrateNote(file, options)`: Extracts summaries from `##Summary`/`##TL;DR`/first paragraph
- `determineStatus()`: Checks for existing tags (processed vs pending)
- `detectContentType()`: Analyzes keywords (research/meeting/project/reference)
- `migrateFolder()` and `migrateVault()`: Batch operations with progress callbacks
- `extractSummaryFromContent()`: Regex patterns for section extraction
- `getMarkdownFilesInFolder()`: Recursive traversal

**Migration Modal** ([src/ui/modals/MigrationModal.ts](../../src/ui/modals/MigrationModal.ts))
- 4-stage UI workflow:
  1. **Analysis**: Display stats (total/needsMigration/alreadyMigrated)
  2. **Options**: Toggle `overwriteExisting`, `extractSummary`
  3. **Progress**: Live progress bar with updates
  4. **Results**: Summary with error details
- Each stage has dedicated `renderStage()` method with proper cleanup

**Commands** ([src/commands/migrationCommands.ts](../../src/commands/migrationCommands.ts))
- `upgrade-metadata`: Opens MigrationModal for entire vault
- `upgrade-folder-metadata`: Opens MigrationModal scoped to current folder

### Dashboard Generation

**Templates** ([src/services/configurationService.ts](../../src/services/configurationService.ts))
- Single "Notes Dashboard" template for simplicity
- YAML structure with `filters:` (plural), `columns:`, optional `sorting:`
- Folder filtering automatically applied via `file.inFolder()` function

**Dashboard Service** ([src/services/dashboardService.ts](../../src/services/dashboardService.ts))
- `createDashboard(options)`: Create `.base` file from template with folder filtering
- `injectFolderFilter(content, folderPath)`: Automatically adds `file.inFolder("path")` filter
- `getRecommendedDashboardFolder()`: Searches for 'Dashboards'/'Views'/'Bases'
- Folder filter includes all subfolders recursively
- Uses `filters:` (plural) syntax as required by Obsidian Bases

**Dashboard Modal** ([src/ui/modals/DashboardCreationModal.ts](../../src/ui/modals/DashboardCreationModal.ts))
- Simple confirmation dialog (not template picker)
- Shows target folder path with change option
- Single "Create Dashboard" action
- Dashboard automatically scoped to selected folder

**Commands** ([src/commands/dashboardCommands.ts](../../src/commands/dashboardCommands.ts))
- `create-bases-dashboard`: Opens DashboardCreationModal

### Settings Integration

**Bases Settings Section** ([src/ui/settings/BasesSettingsSection.ts](../../src/ui/settings/BasesSettingsSection.ts))
- 3 toggle settings:
  - `enableStructuredMetadata`: Enable Bases integration (default: true)
  - `includeModelInMetadata`: Add `model` property (default: true)
  - `autoDetectContentType`: Auto-detect content type from keywords (default: true)
- Info box with usage guidance (3 bullet points)
- Migration action button (icon: database): Calls `upgrade-metadata` command
- Dashboard creation via right-click folder context menu

### Summarization Integration

**Conditional Structured Output** ([src/commands/summarizeCommands.ts](../../src/commands/summarizeCommands.ts))
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

**i18n**: English-only (`en.ts`) — zh-cn locale retired 2026-06 (i18n system retained)

**4-Tier JSON Parsing**: Handles various LLM response formats gracefully

**Backward Compatibility**: Structured output controlled by settings toggle, preserves existing summarization behavior when disabled

### Integration Points

**Tag Generation**: Suggested tags from structured responses automatically added to frontmatter

**Semantic Search**: Content type filters improve RAG context retrieval

**Smart Summarization**: Auto-detects source type based on input (URL → 'url', PDF → 'pdf', YouTube → 'youtube')

**Batch Operations**: Migration service supports folder and vault-wide operations with progress tracking

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
