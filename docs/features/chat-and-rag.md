# Chat, Attachments & Semantic Retrieval

> Subsystem detail moved out of [AGENTS.md](../../AGENTS.md) so the canonical
> context file stays invariant-sized. AGENTS.md keeps the one-line stub and the
> load-bearing rules; the operational depth lives here.

Free-form chat, project-scoped conversations, attachment indexing, the Mermaid diagram chat, and the visual (page-image) search lane.

---

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

## Visual Search (Cohere v4 page-image lane — azure-capability-completion-v2)

**Status**: ✅ Implemented (June 2026) — Clusters A–D, per-cluster GPT fix-gates + consolidated Gemini final gate APPROVE. Default **OFF** (`visual-search` feature, requires `semantic-search`).

Makes **figures/charts in embedded PDFs** semantically searchable: figure-bearing pages are rendered (Obsidian's bundled pdf.js — never our own), embedded as IMAGES via **Cohere Embed v4** (text + images share ONE vector space, so a text query retrieves page-image vectors), stored in a **second Voy lane**, and surfaced into vault-chat RAG as page TEXT (+ optionally the rendered image to a vision LLM).

### Architecture (`src/services/visualEmbedding/`, `src/services/pdf/`)
- **Backend selection (DP-2)**: `visualBackendResolver.selectVisualBackend` is the SSOT — Azure-served (`visual-embeddings` capability, probe-green) → BYO Cohere-native (`PLUGIN_SECRET_IDS.COHERE_VISUAL`, DEDICATED — never the text-lane key, G2/C22) → unavailable-with-reason. `azureCohereV4ImageProbe` is a CONTRACT test cached by full identity (endpoint+model+dim+key-hash); **CA2**: definitive 4xx/shape → `unsupported` (cached), transient 408/429/5xx/network/throw → `needs-retry` (NEVER cached).
- **Two wire shapes** (`cohereV4VisualEmbeddingService`): native = Cohere v2 (`inputs:[{content}]`); Azure = **Foundry inference shape** (`/models/{images/,}embeddings?api-version=2024-05-01-preview` on `azureAIEndpoint`, `{model, input:[{image}]}` → `{data:[{index,embedding}]}`, ONE image/request, index set validated as exactly `{0..n-1}`). Plan C2 assumed a shared serializer — the live Azure API differs; the probe verifies.
- **Indexing lane**: `visualIndexService` (an `AttachmentConsumer` on the SAME Phase-1 coordinator, C16; self-gates on the flag C12) — **embeds only** (`getFileCache().embeds`; a plain `[[deck.pdf]]` mention never transmits page images, C18/C24) → fingerprint gate (C9 cheap prefilter → lazy hash; budget-aware cache invalidation) → `detectFigurePages` (C7 signals, G3 page cap) → POINTER tasks on a `GenericEmbeddingQueue<VisualPageTask>` (C25 — images render lazily INSIDE the batch via the CA1 ref-counted+TTL `pdfHandlePool`, discarded post-request). Persist callbacks re-validate liveness (host exists + still embeds). Host-note lifecycle (C24): delete→purge, rename→drop-pending+rekey+re-index, modify→reconcile. On-enable backfill (C23) runs WITHOUT reload; `teardownFeature('visual-search')` unregisters-then-disposes (CA3) and purges the WHOLE namespace (C14).
- **Repository** (`visualIndexRepository`): second `VoyVectorStore` at `.ai-organiser/vector-index-visual` + registry sidecar (the C9 cache AND the C19 scope index). **C19 scoped search is PRE-topK** (registry-eligible hosts → exact cosine → topK). C8 identity sidecar mismatch/corruption → `needsRebuild` blocks writes+search; rebuild = wipe+re-derive (documented deviation from C8's temp-swap — the index is fully re-derivable). Sidecars deliberately non-transactional (self-healing convergence, tested both one-sided-failure directions).
- **Retrieval/synthesis (Phase 7)**: `visualRetrievalService` owns query embedding (C1, graceful `ok([])` on EVERY unavailability); `ragContextMerger` (pure) dedups by **EVIDENCE identity** `kind:filePath:attachmentPath:page:chunkIndex:modelId` (C4 — never host-filePath; that stays display-only, C20) with per-host/per-attachment/global budgets; `ragPayloadBuilder` enforces the gates IN CODE: images → vision LLM only when `allowVisualSynthesisImages` (C5, default false) AND vision-capable AND within count+byte budget, else deterministic degrade to page text (DP-1); `allowVisualPageTextInRag=false` omits visual items ENTIRELY (C18 #2). `RAGService` takes an optional `visualRetrieval` collaborator (absent ⇒ byte-identical text-only); `VaultModeHandler` wires `plugin.visualRetrieval`.
- **Pacing**: Azure → the per-deployment pacer bucket (`buildAzureClaudeDeploymentKey`, shares `azurePerDeploymentRpm` for e.g. `embed-v-4-0`); native → its own dual-gate pacer at `cohereVisualRpm`; 429 → a DEDICATED visual cooldown (never pauses text indexing).
- **Consent UI (C15/C17/C18) + auto-enable (2026-06-10)**: `VisualSearchSettingsSection` renders INSIDE the semantic-search section UNGATED on the flag (`SECTION_HOSTED_FEATURES` SSOT in `features.ts` keeps the completeness CI invariant honest) — the copy names all THREE transmissions (page images → embedding backend; page text → active LLM; rendered images → vision LLM); the probe runs from the panel. **Configuring a working backend IS the enable act** (deliberate C15 simplification): saving the dedicated Cohere key / a green probe / a ready backend detected at startup auto-enables the feature via `shouldAutoEnableVisualSearch` — but ONLY when the flag is UNTOUCHED (`undefined`); an explicit disable (`featureFlags['visual-search'] === false`) is always respected and re-enable then goes through the Enable button.

### Key patterns
- **Whisper-stays-forever analog**: default OFF; non-enabled users are byte-identical everywhere (text queue wrapper is a behavior-preserving D3 extraction, pinned by the pre-existing `embeddingQueue.test.ts`).
- **`useMainKeyFallback:false`** for `getCohereVisualApiKey` (Deepgram lesson) + a dedicated secret — visual image transmission is its own consent surface.
- **Graceful everywhere (D12)**: probe red + no BYO → clear unavailable reason; pdf.js absent → `needs-retry` skips (G1, never cached-as-done); render fail → that page degrades; visual retrieval can never break text RAG.

### Tests
`tests/{cohereV4VisualEmbeddingService,azureCohereV4ImageProbe,visualBackendResolver,pdfPageRenderer,pdfHandlePool,embeddingQueueGeneric,visualIndexRepositoryScope,visualIndexService,visualSearchTeardown,visualSearchEnableBackfill,visualRetrievalService,ragContextMerger,ragPayloadBuilder}.test.ts` + extended `resolveAzureCapability`/`attachmentTextIndexer`. Plan + audit summary gitignored (`docs/completed/azure-capability-completion-v2*.md`).
