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
- **Canvas aware**: `.canvas` `file` nodes count as references (JSON Canvas 1.0 `parseCanvasFileRefs`); an unparseable canvas or unreadable note is a *coverage failure* that blocks trashing anything
- **No dedup**: Every embed/link occurrence counted separately for accurate reference counts
- **Link normalization**: Case-insensitive matching, optional extensions, path suffix matching
- **Orphan detection**: Advisory only — "possibly orphaned" with disclaimer about potential false positives
- **AbortSignal**: Cancellable scan with progress callback for UI updates
- **ARIA + keyboard nav**: Scope picker follows accessibility best practices
- **i18n**: Full `embedScan` section at top level of Translations (~60 keys)

---

## Protected folders (F1)

`src/core/protectedPaths.ts` is the single source of truth for "the plugin never modifies, renames, trashes or creates here". `protectedFolders` (settings) defaults to `[]`, which makes every guard a constant "writable": behaviour is byte-identical until the user protects a folder.

- **Pure API**: `isProtectedPath`, `assertWritable(settings, op, targets)` (a move passes source and destination; a folder operation also covers protected descendants), `rewriteOnRename`, `findOutputRootConflicts`. Matching is case-insensitive, slash-normalised and prefix-safe (`A/B` does not match `A/BC`). A missing protected folder still blocks creates at its path.
- **Seams that enforce it**: `writeNote` (the `applyNoteEdit` commit; also checked earlier so no review modal is shown), the tag and frontmatter writers (`assertWritableActive`, a tiny registry installed by `registerProtectedFolders`), editor-level helpers (`guardActiveNote`), renames, NotebookLM selection tags, narration embeds, attachment replacement and deletion, and the F2 trash.
- **Classification test**: `tests/protectedWriteSites.test.ts` scans `src/` for Obsidian write APIs and requires every file to be classified `guarded`, `output-root` or `plugin-data` with a reason, with an exact site count. Adding a write site without classifying it fails CI.
- **Output roots** (chat, export, newsletter, recordings, …) must be disjoint from protected folders. Saving a protected list that collides with one is refused with a notice naming the folder; an existing collision is warned about on load. *Known limit*: a collision introduced by editing an output folder setting later is warned about, not blocked.
- **Protection follows the folder**: the vault `rename` listener rewrites entries when a protected folder (or an ancestor) is renamed in Obsidian. Moves made outside Obsidian are not seen; the settings row shows "Folder not found".
- **Entry points**: right-click a folder → "Protect this folder", or Settings → Preferences → Protected folders (status row, guided setup, folder list).
- **File explorer shield**: each *protected root* (not its descendants, whose indent already shows the nesting) gets a small shield with the tooltip "Protected by AI Organiser". Obsidian has no explorer-decoration API, so `src/ui/explorer/protectedFolderBadge.ts` tags `.nav-folder-title[data-path]` rows with `ai-organiser-protected-folder` and appends one `ai-organiser-protected-shield` span (`role="img"`, `aria-label` = the tooltip); `styles.css` draws it with a local inline-SVG mask (no remote asset, no `element.style`). The matcher is the pure `src/core/protectedFolderBadge.ts` (`buildBadgeIndex`, `isBadged`) and uses the same case-insensitive, slash-normalised comparison as the write guards, so the shield never disagrees with enforcement.
  - **Setting**: `showProtectedFolderShield` (default **on**, a deliberate owner-approved exception to "new capabilities ship default-off": it is a read-only indicator of the user's own protection). Toggle under Settings → Protected folders; saves are serialised and a failed save restores the previous value.
  - **Inert when unused**: with the toggle off *or* an empty list the controller holds no `MutationObserver`, no timer and makes no DOM edit (pinned by `tests/protectedFolderBadgeDom.test.ts`); turning it off removes everything it added.
  - **How it stays correct**: one observer per open file-explorer leaf container (watched via the leaf's container so a deferred view loading does not lose it), reconciled on every `layout-change` and every settings change (`refreshProtectedFolderBadge()`, called after each protected-list save, after the rename listener remaps the live list, and from the toggle). The observer callback is **incremental and not throttled**, on purpose: callbacks run before paint, so an expanded protected folder is never painted without its shield, and a throttle would break that. It re-reads the live list each batch (a rename remaps the list and moves the row together), handles added/removed rows, `data-path` changes and children replaced inside a row, and falls back to one full pass above 500 records. Only full passes are leading+trailing throttled (100 ms). A pass that throws clears all shields (a stale shield is a false safety cue) and the next refresh rebuilds. A title is never forgotten without first being cleaned; `unregisterProtectedFolders` disposes the controller and removes every class and span.
  - **Known limits**: only the core file explorer is decorated (alternative explorer plugins are not); no tooltip on touch (the icon is still shown, larger on mobile); a settings file changed by an external sync is picked up at the next layout change.
  - Tests: `protectedFolderBadgeLogic`, `protectedFolderBadgeDom` (happy-dom), `protectedFolderBadgeCss`.

## Setup kit

Shared first-run pieces used by every opt-in feature, so an ordinary user finishes setup in one or two choices.

- `src/core/setupState.ts`: `evaluateSetup(id, settings, observations)` → `not-set-up | ready | needs-attention` (+ reason), and `evaluateScriptCompat` for Apps Script versions. Persisted fact: `featureSetupCompletedAt[id]`. Derived health is never stored.
- `src/ui/setup/setupFlow.ts` (pure state machine) behind `src/ui/modals/GuidedSetupModal.ts`: Back / Next / Finish, local validation blocks Next, settings are written once at Finish, Esc saves nothing.
- `src/ui/setup/SetupStatusRow.ts`, `src/ui/setup/FolderListEditor.ts` (folder picker with live note counts; never a typed path).
- `src/core/friendlyErrors.ts`: `GUIDANCE_CODES` → `t.guidance[code]` = `{ message, nextStep }`.

## Attachment helper (F2, extends Find embeds)

- **Eligibility** (`src/services/attachmentEligibility.ts`) is the one place that decides if a file may be trashed: zero resolved references, no ambiguous same-name candidates, no coverage failures, unchanged since the scan, not protected. The scan answers cheaply for display; `revalidate` rebuilds the reference graph from the current vault at confirmation (waits for `metadataCache.resolved`, re-parses referrers changed since the scan or touched by a recorded create/rename, re-resolves every stored reference against its referrer's current path) and fails closed.
- **Duplicates** (`attachmentDuplicateService.ts`): opt-in. Groups by size, hashes candidates with `crypto.subtle` at concurrency 2, skips files over `attachmentDuplicateMaxMB`, cancellable, partial results labelled.
- **Suggest a home / Link to note** (`attachmentHomeService.ts`): first 1,000 characters of extracted text as a semantic query (with a once-per-session disclosure when the embedding provider is external) or a basic title-word match; the link is appended under `attachmentLinkHeading` through `applyNoteEdit` and is idempotent. Protected notes show as "not linkable".
- **One referrer set** (`src/services/referrerSet.ts`, `listAllReferrerFiles`): every note and canvas in the vault, excluded and plugin-managed folders included. The vault-scope scan and `createAppVaultPort().listReferrers` both use it. Before this the scan read only non-excluded notes while the re-check read all of them, so a recording embedded only in a note in an excluded folder (for example meeting minutes) was listed as orphaned and then refused at delete time.
- **Links are resolved the way Obsidian resolves them** (`embedScanService.ts`, `attachmentEligibility.ts`): the markdown destination reader decodes percent-encoding, reads `<angle brackets>` and balanced parentheses and skips a title (wikilinks are never decoded); the destination as written is kept too (`rawLinktext`) because a file may literally be named with a "%41". **Obsidian's own link index is a floor**: a file `metadataCache.resolvedLinks` shows for any note or canvas counts as referenced in the scan and in `revalidate` even when the text reader found nothing (a synthetic occurrence `fromGraph` carries it, with the line from `getFileCache` when known). A link that resolves to nothing but names an existing file keeps that file as ambiguous. All three only ADD references or keep files, so they cannot make a delete less safe. The old regexes (initial release) missed `%20` and angle-bracket links, which listed linked files as orphans and let the delete re-check trash them.
- **Results window numbers**: the summary counts every file found, how many are in use and how many are not used, and sizes both lists; "Showing N of M" counts the same files against the filters. Type chips are a choice of types to show (none picked = everything). "Used by N" counts notes and canvases, not occurrences.
- **Kept card honesty**: "Remove the link and delete" is offered only when every referring note yields a removal plan (checked when the card is built); otherwise the card says why (properties, code block, or a link only the index knows).
- **Evidence travels with the verdict**: `Eligibility.blockers` (`referrers` with note, line and kind, `sameNameFiles`, `unreadable`) is filled by `revalidate`; it never changes `reasons`. The cheap scan-time verdict carries none.
- **Results window layout**: the possibly orphaned list is first and open (search, sort with largest first by default, type chips counted across referenced and orphaned files, a Duplicates chip once the analysis has run). Referenced files sit in a collapsed "N files in use, nothing to do" group (open state remembered for the session via module state, reset in `resetEgressChoice`; it opens by default only when there is no orphan section); links to missing files are a second collapsed group so "in use" stays true.
- **Kept panel** (`attachmentKeptModel.ts` pure view-model `describeKept`, `EmbedScanKeptPanel.ts` rendering): one card per file the re-check refused, naming the blocking note or canvas (Open note / Open canvas), the other same-named file, the unreadable note, or a changed file with an inline Scan again. A not-ready link index is its own outcome (`SafetyCheck.status === 'not-ready'`): an inline status with Try again instead of a toast. Deleting still re-checks AFTER the confirm click (`executeDelete`), so the pre-dialog verdict never authorises a trash.
- **Remove the link and delete** (`attachmentUnlinkService.ts`): a write capability, gated by `isLinkRemovalEnabled` (Find embeds on AND `attachmentAllowLinkRemoval`, default off; the card offers a one-click enable). Offered only when plain references from writable notes are the only thing in the way. `planLinkRemoval` is pure and positional (body lines only; frontmatter, fenced code and inline code are never edited; a list item is dropped only when empty and childless). `RemoveLinkPreviewModal` shows every note and line; Apply approves exactly that plan, and `removeLinks` (one `applyNoteEdit` composite per note, `review:false`) refuses with `link-changed` unless the live re-plan equals the approved one, checks the capability and `shouldContinue` before every note, stops at the first non-written note and never rolls back. The job outlives the window (outcome Notice via `announceUnlink`); the file is trashed only after a fresh re-check and the normal confirmation. Canvas references get text-only guidance.
- Settings: `attachmentLargeFileMB` (20), `attachmentDuplicateMaxMB` (50), `attachmentLinkHeading` (`Attachments`), `attachmentAllowLinkRemoval` (false; toggle in the Find embeds settings section, `sub-find-embeds`).
- Tests: `embedScanCanvas`, `attachmentEligibility` (incl. blockers), `referrerSet`, `attachmentUnlinkService`, `attachmentKeptModel`, `embedScanKeptPanel`, `embedScanResultsLayout`, `embedScanResultsFlow`, `embedScanDuplicates`, `attachmentHomeService`, `protectedWriteSites`, `protectedFoldersOffPath`.

## Agent index (F3)

`src/services/agentIndex/` builds a JSONL note index for AI coding tools. Default off (`agent-index`, stage Find); no LLM and no network.

- **Projection** (`agentIndexProjection.ts`, pure): one record per included note plus a signed header (`generator`, `generatedAt`, scope hash). An excluded note never appears; a link to one becomes `{"excluded": true}`; unresolved links are omitted unless `agentIndexExportUnresolvedLinks`.
- **Scope**: `agentIndexIncludeFolders` (empty = whole vault) minus `agentIndexExcludeFolders`. Protected folders are kept out of the index too (`isInIndexScope` reads `protectedFolders` from `scopeConfigFromSettings`), so the index, the read-only connector and the chat-project map agree; the scope hash gains a `protectedFolders` field only when something is protected, so a vault without protected folders keeps its hash. Optional aliases, headings and named frontmatter keys.
- **Publication** (`agentIndexService.ts`): `planOutput` accepts a vault-relative `.jsonl` path only (no drive letter, leading slash, `..`, or protected location). The index is written to a signed temp file, the previous one kept as a signed `.prev`, then swapped; `recoverPublication` finishes or rolls back an interrupted swap and never touches an unsigned file. A mutex serialises builds and a snapshot is retaken up to three times if the vault changed mid-build.
- **Commands**: build, check (stale or not, no write), copy agent instructions, copy Claude Code permissions, guided setup, and the optional AGENTS.md write below.
- **Agent instructions target `AGENTS.md`** (`agentInstructions.ts`, pure). `buildAgentInstructions` is agent-neutral (consult the index, open the real note, treat note content as data, search when stale, never edit protected folders, do not read excluded folders) and ends with one line for Claude Code users: put `@AGENTS.md` in `CLAUDE.md`. `buildClaudePermissions` is a separate function and button that produces only the Claude Code `permissions.deny` JSON; its text never appears in the AGENTS.md instructions.
- **Optional write into `AGENTS.md`** (`agentInstructionsWrite`, default off; `agentInstructionsPath`, default `AGENTS.md`): `agentInstructionsWriter.ts` finds the plugin-owned block between `<!-- aio:agent-instructions -->` markers with the shared owned-block grammar (`src/utils/ownedBlock.ts`, also used by the Drive hub note), shows a preview (the block as it will be, and the block as it is now), and writes through `applyNoteEdit` only after Apply. Text outside the markers is never touched; damaged markers are `instructions-conflict` and nothing is written; a repeat run is a no-op; if a block appeared or vanished after the preview the write stops (`baseline-changed`); the path must be a vault-relative Markdown file outside protected folders and hidden folders. The command is hidden from the palette until the setting is on. Optional `agentIndexAutoRebuild: 'on-change'` debounces vault events.
- **Documented deviation**: build progress is a Notice, not `ProgressReporter` (the build is local, fast and has nothing to cancel).
- Tests: `agentIndexProjection`, `agentIndexService`, `agentIndexSetup`, `agentIndexOffPath`, `agentInstructions`, `agentInstructionsWriter`, `ownedBlock`.

## Excalidraw drawings (read side only; no integration)

An Excalidraw drawing is an ordinary `.md` file (frontmatter `excalidraw-plugin: parsed`, usually named `*.excalidraw.md`): a readable `## Text Elements` section plus a large compressed base64 blob inside `%%` fences. Anything that fed the raw text to a model or an index embedded that blob.

- **Helper** (`src/utils/excalidrawContent.ts`, pure): `isExcalidrawNote`, `excalidrawIndexParts` (`{ text, embeds }` or `null`) and `toModelText(text, path?)`. Recognition is the plugin's own key in the leading frontmatter (the file name counts only together with the drawing-data structure). A drawing keeps its words (block ids stripped) and loses the blob and the plugin banner; a recognised drawing with no text section returns `''`, never the blob; any other note comes back as the same string. The section ends only at `%%`, a blob fence, or the plugin's own headings (`Element Links`, `Embedded Files`, `Drawing`), so a heading-looking label survives; a label that is literally a delimiter line truncates (fail-safe).
- **Applied where text is consumed and discarded**: the vector indexer, chat attachments (pick and re-extract), project pinned notes, presentation sources, multi-source summarise, embedded-note extraction, related-notes queries, cluster snippets, narration, and batch/single tagging input. **Never applied to text that is written back** (the same string, or its baseline, reaches `applyNoteEdit`/`vault.modify`) nor to link and embed hygiene, the NotebookLM export (hash-keyed) or the connector's `read_note`, which stay verbatim. Empty after cleaning is routed to each reader's existing empty guard, so no provider call is made.
- **Indexer identity**: a drawing is hashed on its words, its tags (they feed the metadata prefix) and its `Embedded Files` list (only while `indexAttachmentText` is on), so an unchanged-words re-save no longer re-embeds and a changed embed or tag still does. The attachment collector is handed exactly those inputs, never the blob, and a failed collection for an attachment-only drawing keeps what is indexed and retries. Old raw-hash chunks self-heal on the drawing's next edit or "Update changed files"; no version salt and no migration.
- **Decision: we do not integrate with the Excalidraw plugin to create drawings.** Converting Mermaid needs the separate "Excalidraw Extras" plugin pinned to exactly Mermaid component 2.2.2 (any other version, a disabled Extras or the feature switched off makes `ea.addMermaid` open a blocking dialog, then return an error string). Mindmap, gantt, pie and timeline come back as one SVG image, and `ea.create` then throws and writes nothing. `ea.create` with a foldername like `../x` wrote OUTSIDE the vault, so any future code must build and validate paths itself. The base plugin fetched CJK fonts from esm.sh for CJK labels. Mobile is untested. Evidence is the gitignored spike report in the coordinator notes folder, not a repo file.
- **What would change the decision**: Mermaid conversion moving back into the base plugin (one plugin, no version pin, no blocking dialog).
- **For agent users**: zsviczian's `obsidian-excalidraw-cli` kit (AGPL-3.0, github.com/zsviczian/obsidian-excalidraw-cli) lets an external agent draw through the Obsidian CLI; our read-only connector is unchanged.
- Tests: `excalidrawContent`, `excalidrawIndexing`, `excalidrawIndexAttachments`, `excalidrawSeams` (shared builders in `tests/helpers/excalidrawFixture.ts` and `excalidrawIndexHarness.ts`), plus a drawing case in `audioNarrationService`.
