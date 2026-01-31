# AI Canvas Toolkit — Implementation Plan

## Summary

Three commands that programmatically create Obsidian `.canvas` JSON files from note context, RAG results, and tag clusters. Phased delivery: shared infrastructure first, then Investigation Board (MVP), Context Board, Cluster Board.

---

## Phase 0: Shared Infrastructure (Types, Layout, Utilities)

### New: `src/services/canvas/types.ts`

Canvas data types mirroring the exact Obsidian `.canvas` JSON spec, plus internal descriptors.

```typescript
// Obsidian canvas spec
export interface CanvasNode {
    id: string;
    type: 'file' | 'text' | 'link' | 'group';
    x: number; y: number; width: number; height: number;
    file?: string;      // type='file': vault-relative path
    text?: string;      // type='text': markdown content
    url?: string;       // type='link': URL
    label?: string;     // type='group': group label
    color?: string;     // "1"-"6" (1=red 2=orange 3=yellow 4=green 5=cyan 6=purple)
}

export interface CanvasEdge {
    id: string;
    fromNode: string; toNode: string;
    fromSide: 'top' | 'right' | 'bottom' | 'left';
    toSide: 'top' | 'right' | 'bottom' | 'left';
    label?: string;
    color?: string;     // "1"-"6"
}

export interface CanvasData { nodes: CanvasNode[]; edges: CanvasEdge[]; }

// Internal descriptors (pre-layout)
export interface NodeDescriptor {
    id: string;
    label: string;
    type: 'file' | 'text' | 'link';
    file?: string; url?: string; text?: string;
    color?: string;
    width?: number; height?: number;
}

export interface EdgeDescriptor { fromId: string; toId: string; label?: string; }

export interface ClusterDescriptor { label: string; nodeIds: string[]; color?: string; }

export interface CanvasResult { success: boolean; filePath?: string; error?: string; }
```

### New: `src/services/canvas/layouts.ts`

Pure math functions — no Obsidian imports, fully testable.

```typescript
export const DEFAULT_NODE_WIDTH = 400;
export const DEFAULT_NODE_HEIGHT = 200;
export const NODE_GAP = 60;
export const GROUP_PADDING = 60;

export function chooseLayout(count: number): 'radial' | 'grid';  // ≤12 → radial
export function radialLayout(count: number, centerIdx: number, w?, h?): LayoutNode[];
export function gridLayout(count: number, w?, h?): LayoutNode[];
export function adaptiveLayout(count: number, centerIdx?: number, w?, h?): LayoutNode[];
export function clusteredLayout(
    clusters: { label: string; nodeCount: number }[], w?, h?
): { nodes: LayoutNode[]; groups: GroupRect[] };
export function computeEdgeSides(
    from: { x: number; y: number }, to: { x: number; y: number }
): { fromSide: string; toSide: string };
```

**Radial algorithm**: Center at `(0,0)`. Satellites at angle `i * (2π / N)` on a radius of `(w + gap) * 1.5`.

**Grid algorithm**: `cols = ceil(sqrt(N))`. Node `i` at `x = (i % cols) * (w + gap)`, `y = floor(i / cols) * (h + gap)`.

**Clustered algorithm**: Groups rendered in a horizontal row. Each group contains a local grid of its nodes. Group node width/height = bounding box of children + `GROUP_PADDING * 2`.

**Edge side logic**: Compare `dx = to.x - from.x` vs `dy = to.y - from.y`. If `|dx| > |dy|` → left/right pair. Else → top/bottom pair.

### New: `src/services/canvas/canvasUtils.ts`

```typescript
export function generateId(): string;           // Date.now().toString(36) + random
export function buildCanvasNode(desc: NodeDescriptor, x: number, y: number): CanvasNode;
export function buildCanvasEdge(desc: EdgeDescriptor, positions: Map<string, {x,y}>): CanvasEdge;
export function serializeCanvas(data: CanvasData): string;  // JSON.stringify(data, null, 2)
export async function writeCanvasFile(app: App, folder: string, name: string, data: CanvasData): Promise<CanvasResult>;
export async function openCanvasFile(app: App, path: string): Promise<void>;
export function sanitizeCanvasName(name: string): string;   // strip / \ : * ? " < > |
```

`writeCanvasFile` flow:
1. Ensure folder exists (`vault.createFolder` if missing, catch "already exists")
2. Sanitize name, append `.canvas`
3. If file exists, auto-increment: `Name 2.canvas`, `Name 3.canvas`
4. `vault.create(path, serializeCanvas(data))`
5. Return `{ success: true, filePath }`

---

## Phase 1: Investigation Board (MVP Hero Feature)

### New: `src/services/canvas/investigationBoard.ts`

```typescript
export interface InvestigationOptions {
    file: TFile;
    content: string;
    maxRelated: number;           // default 8
    enableEdgeLabels: boolean;
    canvasFolder: string;
    openAfterCreate: boolean;
}

export async function buildInvestigationBoard(
    app: App,
    ragService: RAGService,
    llmContext: LLMFacadeContext,
    options: InvestigationOptions
): Promise<CanvasResult>;

export function parseEdgeLabelResponse(response: string, pairCount: number): (string | undefined)[];
```

**Logic flow:**
1. `ragService.getRelatedNotes(file, content, maxRelated)` → `SearchResult[]`
2. If empty → return `{ success: false, error: 'No related notes found' }`
3. Build `NodeDescriptor[]`:
   - Index 0: current file (color `"5"` cyan)
   - Index 1-N: related files (color `"4"` green; `"6"` purple if score ≥ 0.8)
4. `adaptiveLayout(count, 0)` → positions with center at index 0
5. If `enableEdgeLabels`:
   - Build pairs: `[{ fromTitle, fromSnippet (first 500 chars), toTitle, toSnippet, pairIndex }]`
   - Single LLM call: `summarizeText(llmContext, buildEdgeLabelPrompt(pairs))`
   - Parse response with `parseEdgeLabelResponse()`
   - **Fallback**: if LLM fails, use score-based labels: "Closely related" (≥0.8), "Related" (≥0.6), "Loosely related" (<0.6)
6. Build `EdgeDescriptor[]` from center to each satellite
7. Assemble `CanvasData`, call `writeCanvasFile()`
8. If `openAfterCreate`, call `openCanvasFile()`

### New: `src/services/prompts/canvasPrompts.ts`

```typescript
export function buildEdgeLabelPrompt(
    pairs: Array<{ fromTitle: string; fromSnippet: string; toTitle: string; toSnippet: string; pairIndex: number }>
): string;
```

Prompt structure:
```xml
<task>
You are analyzing relationships between notes in a knowledge vault.
For each pair of notes below, provide a 1-4 word relationship label
describing how the second note relates to the first.
</task>

<pairs>
{pairs formatted as numbered list with titles and snippets}
</pairs>

<output_format>
Return a JSON object with a "labels" array. Each item has "pairIndex" (number) and "label" (string, 1-4 words).
Example: {"labels": [{"pairIndex": 0, "label": "Core Concept"}, {"pairIndex": 1, "label": "Application"}]}
</output_format>
```

**`parseEdgeLabelResponse`**: 3-tier fallback:
1. Direct JSON parse → extract `labels` array
2. Code fence extraction → parse
3. Regex for `"label"\s*:\s*"([^"]+)"` → collect in order
4. Return `undefined[]` on total failure (edges rendered without labels)

### New: `src/commands/canvasCommands.ts`

```typescript
export function registerCanvasCommands(plugin: AIOrganiserPlugin) {
    // Gate: desktop only
    // Investigation Board
    plugin.addCommand({
        id: 'build-investigation-canvas',
        name: plugin.t.commands.buildInvestigationCanvas,
        icon: 'network',
        callback: async () => {
            if (Platform.isMobile) {
                new Notice(plugin.t.canvas.desktopOnly);
                return;
            }
            if (!plugin.settings.enableSemanticSearch || !plugin.vectorStore) {
                new Notice(plugin.t.canvas.requiresSemanticSearch);
                return;
            }
            const file = plugin.app.workspace.getActiveFile();
            if (!file) { new Notice(plugin.t.messages.openNote); return; }
            const content = await plugin.app.vault.read(file);
            if (!content.trim()) { new Notice(plugin.t.canvas.emptyNote); return; }

            const ragService = new RAGService(
                plugin.vectorStore, plugin.settings, plugin.embeddingService
            );
            const result = await withBusyIndicator(plugin, () =>
                buildInvestigationBoard(plugin.app, ragService, pluginContext(plugin), {
                    file, content,
                    maxRelated: 8,
                    enableEdgeLabels: plugin.settings.canvasEnableEdgeLabels,
                    canvasFolder: getCanvasOutputFullPath(plugin.settings),
                    openAfterCreate: plugin.settings.canvasOpenAfterCreate,
                })
            );
            if (result.success) {
                new Notice(plugin.t.canvas.created);
            } else {
                new Notice(result.error || plugin.t.canvas.creationFailed);
            }
        }
    });

    // Context Board (added in Phase 2)
    // Cluster Board (added in Phase 3)
}
```

### Modify: `src/commands/index.ts`

Add `import { registerCanvasCommands } from './canvasCommands';` and call in `registerCommands()`.

---

## Phase 2: Context Board

### New: `src/services/canvas/contextBoard.ts`

```typescript
export interface ContextBoardOptions {
    file: TFile;
    content: string;
    canvasFolder: string;
    openAfterCreate: boolean;
}

export async function buildContextBoard(app: App, options: ContextBoardOptions): Promise<CanvasResult>;
export function mapContentTypeToNode(item: DetectedContent): NodeDescriptor;
```

**Logic flow:**
1. `detectEmbeddedContent(app, content, file)` → `DetectionResult`
2. Filter: exclude images (not useful as canvas nodes)
3. If no sources detected → `{ success: false, error: t.canvas.noSourcesDetected }`
4. Build center `NodeDescriptor` (current file, color `"5"`)
5. For each detected source, call `mapContentTypeToNode()`:
   - `youtube` → `type: 'link'`, `url: item.url`, color `"6"` purple
   - `pdf` with `resolvedFile` → `type: 'file'`, color `"4"` green
   - `pdf` without `resolvedFile` → `type: 'text'`, text `"Missing: filename"`, color `"1"` red
   - `web-link` → `type: 'link'`, color `"3"` yellow
   - `internal-link` with `resolvedFile` → `type: 'file'`, color `"5"` cyan
   - `internal-link` without `resolvedFile` → `type: 'text'`, color `"1"` red
   - `audio` → `type: 'file'` or text, color `"2"` orange
   - `document` → `type: 'file'` or text, color `"4"` green
6. `adaptiveLayout(count, 0)` with center index 0
7. Build edges from center to each source (no labels needed)
8. Write and optionally open

**No LLM call** — purely structural. Works without semantic search.

### Modify: `src/commands/canvasCommands.ts`

Add second command:
```typescript
plugin.addCommand({
    id: 'build-context-canvas',
    name: plugin.t.commands.buildContextCanvas,
    icon: 'git-branch',
    callback: async () => {
        // Gate: desktop only, active file, non-empty
        // No semantic search gate (works without it)
        ...
    }
});
```

---

## Phase 3: Cluster Board (Experimental)

### New: `src/services/canvas/clusterBoard.ts`

```typescript
export interface ClusterBoardOptions {
    tag: string;
    files: TFile[];
    canvasFolder: string;
    openAfterCreate: boolean;
    useLLMClustering: boolean;
}

export async function buildClusterBoard(
    app: App, llmContext: LLMFacadeContext, options: ClusterBoardOptions
): Promise<CanvasResult>;

export function deterministicClustering(files: TFile[], tag: string): ClusterDescriptor[];
export function computeMaxNotes(snippetChars: number, maxPromptTokens: number): number;
export function parseClusterResponse(response: string, noteCount: number): ClusterDescriptor[] | null;
```

**`deterministicClustering` algorithm:**
1. For each file, extract parent folder name
2. Group files by folder
3. If all files are in the same folder, try sub-tag grouping:
   - Look for tags like `tag/subtag` in each file's frontmatter
   - Group by subtag
4. If still only one group, split alphabetically into chunks of 6

**`computeMaxNotes`**: `floor(maxPromptTokens / (snippetChars / 4 + overhead))` where overhead ~50 tokens per note for title/metadata.

### New: `src/services/prompts/canvasPrompts.ts` (append)

```typescript
export function buildClusterPrompt(
    tag: string,
    notes: Array<{ title: string; snippet: string }>,
    language: string
): string;
```

### New: `src/ui/modals/TagPickerModal.ts`

Simple `FuzzySuggestModal<string>` listing all vault tags from `app.metadataCache`. Returns selected tag via callback. Reusable.

### Modify: `src/commands/canvasCommands.ts`

Add third command using `TagPickerModal` → then `buildClusterBoard()`.

---

## Phase 4: Integration (Settings, i18n, Command Picker)

### Modify: `src/core/settings.ts`

Add to `AIOrganiserSettings` interface:
```typescript
// === CANVAS SETTINGS ===
canvasOutputFolder: string;         // Subfolder under pluginFolder
canvasOpenAfterCreate: boolean;     // Open canvas file after creation
canvasEnableEdgeLabels: boolean;    // Use LLM for edge labels (Investigation Board)
```

Add to `DEFAULT_SETTINGS`:
```typescript
canvasOutputFolder: 'Canvas',
canvasOpenAfterCreate: true,
canvasEnableEdgeLabels: true,
```

Add helper:
```typescript
export function getCanvasOutputFullPath(settings: AIOrganiserSettings): string {
    return resolvePluginPath(settings, settings.canvasOutputFolder, 'Canvas');
}
```

### New: `src/ui/settings/CanvasSettingsSection.ts`

Extends `BaseSettingSection`. Three settings with h2 header. Placed in settings tab after Semantic Search (canvas builds on RAG). Descriptive text: "Max ~8 notes analyzed per canvas." for the edge labels toggle.

### Modify: `src/ui/settings/AIOrganiserSettingTab.ts`

Import and instantiate `CanvasSettingsSection` after semantic search section.

### Modify: `src/ui/modals/CommandPickerModal.ts`

Add a Canvas group to the **Discover** category (fits "explore vault" mental model):

```typescript
// After 'find-notes-group' in the discover category:
{
    id: 'canvas-group',
    name: t.modals.commandPicker?.groupCanvas || 'Canvas',
    icon: 'layout-grid',
    aliases: ['canvas', 'board', 'investigation', 'context', 'cluster', 'visualize', 'map', 'diagram'],
    callback: () => {},
    subCommands: [
        {
            id: 'build-investigation-canvas',
            name: t.commands.buildInvestigationCanvas,
            icon: 'network',
            aliases: ['investigation', 'related', 'semantic', 'explore'],
            callback: () => executeCommand('ai-organiser:build-investigation-canvas')
        },
        {
            id: 'build-context-canvas',
            name: t.commands.buildContextCanvas,
            icon: 'git-branch',
            aliases: ['context', 'sources', 'links', 'references'],
            callback: () => executeCommand('ai-organiser:build-context-canvas')
        },
        {
            id: 'build-cluster-canvas',
            name: t.commands.buildClusterCanvas,
            icon: 'boxes',
            aliases: ['cluster', 'group', 'tag', 'organize'],
            callback: () => executeCommand('ai-organiser:build-cluster-canvas')
        }
    ]
}
```

### Modify: `src/i18n/types.ts`

Add to `Translations`:
```typescript
commands: {
    ...existing,
    buildInvestigationCanvas: string;
    buildContextCanvas: string;
    buildClusterCanvas: string;
};

canvas: {
    settingsTitle: string;
    settingsDescription: string;
    outputFolder: string;
    outputFolderDesc: string;
    openAfterCreate: string;
    openAfterCreateDesc: string;
    enableEdgeLabels: string;
    enableEdgeLabelsDesc: string;
    created: string;
    creationFailed: string;
    noSourcesDetected: string;
    noRelatedNotes: string;
    noNotesWithTag: string;
    requiresSemanticSearch: string;
    desktopOnly: string;
    emptyNote: string;
    selectTag: string;
};

modals: {
    commandPicker: {
        ...existing,
        groupCanvas: string;
    };
    tagPicker: {
        title: string;
        placeholder: string;
        noTags: string;
    };
};
```

### Modify: `src/i18n/en.ts` and `src/i18n/zh-cn.ts`

Implement all keys above in both languages.

---

## Files Summary

### New files (10)
| File | Purpose |
|------|---------|
| `src/services/canvas/types.ts` | Canvas JSON types + internal descriptors |
| `src/services/canvas/layouts.ts` | Pure layout algorithms (radial, grid, clustered) |
| `src/services/canvas/canvasUtils.ts` | File creation, node/edge builders, ID gen |
| `src/services/canvas/investigationBoard.ts` | Investigation Board builder |
| `src/services/canvas/contextBoard.ts` | Context Board builder |
| `src/services/canvas/clusterBoard.ts` | Cluster Board builder + deterministic fallback |
| `src/services/prompts/canvasPrompts.ts` | Edge label + cluster prompts |
| `src/commands/canvasCommands.ts` | Three command registrations |
| `src/ui/settings/CanvasSettingsSection.ts` | Settings section |
| `src/ui/modals/TagPickerModal.ts` | Tag picker for Cluster Board |

### Modified files (7)
| File | Change |
|------|--------|
| `src/core/settings.ts` | 3 new settings + defaults + `getCanvasOutputFullPath()` |
| `src/commands/index.ts` | Import + call `registerCanvasCommands` |
| `src/ui/settings/AIOrganiserSettingTab.ts` | Instantiate `CanvasSettingsSection` |
| `src/ui/modals/CommandPickerModal.ts` | Canvas group in Discover category |
| `src/i18n/types.ts` | `canvas` section + command names + modal keys |
| `src/i18n/en.ts` | English strings |
| `src/i18n/zh-cn.ts` | Chinese strings |

### New test files (5)
| File | Key tests |
|------|-----------|
| `tests/canvasLayouts.test.ts` | Layout algorithms, no-overlap verification, edge side computation |
| `tests/canvasUtils.test.ts` | ID uniqueness, node/edge building, name sanitization, JSON roundtrip |
| `tests/canvasPrompts.test.ts` | Prompt structure, XML tags present, output format specified |
| `tests/investigationBoard.test.ts` | Edge label parsing (valid JSON, code fence, malformed), score-based fallback |
| `tests/clusterBoard.test.ts` | Deterministic clustering by folder, token budget calc, LLM response parsing |

### Modified test file (1)
| File | Change |
|------|--------|
| `tests/commandPicker.test.ts` | Add canvas group to Discover category assertions |

---

## Test Plan

### Unit Tests (pure functions, no mocks)

**`tests/canvasLayouts.test.ts`:**
- `chooseLayout(1)` → radial, `chooseLayout(12)` → radial, `chooseLayout(13)` → grid
- `radialLayout(1, 0)` → single node at (0,0)
- `radialLayout(5, 0)` → center at (0,0), 4 satellites equidistant
- `gridLayout(9)` → 3x3, no overlapping rectangles
- `gridLayout(1)` → single node
- `adaptiveLayout(12, 0)` calls radial, `adaptiveLayout(13)` calls grid
- `clusteredLayout([{nodeCount:3}, {nodeCount:2}])` → groups don't overlap, children inside group bounds
- `computeEdgeSides` → all 4 quadrants produce correct side pairs
- **Overlap invariant**: for all layouts with N=1..20, no two nodes share overlapping bounding boxes

**`tests/canvasUtils.test.ts`:**
- `generateId()` → 100 calls, all unique
- `buildCanvasNode()` maps file/text/link correctly, applies position
- `buildCanvasEdge()` computes sides from positions
- `serializeCanvas()` → `JSON.parse()` roundtrip matches input
- `sanitizeCanvasName('My: Note / Title')` → `'My Note Title'`
- File path with auto-increment: `'Canvas.canvas'` → `'Canvas 2.canvas'` when exists

**`tests/investigationBoard.test.ts`:**
- `parseEdgeLabelResponse('{"labels":[{"pairIndex":0,"label":"Core"}]}', 1)` → `["Core"]`
- `parseEdgeLabelResponse('```json\n{"labels":[...]}\n```', N)` → parses correctly
- `parseEdgeLabelResponse('invalid', 3)` → `[undefined, undefined, undefined]`
- Score-based fallback labels: ≥0.8 → "Closely related", ≥0.6 → "Related", <0.6 → "Loosely related"

**`tests/clusterBoard.test.ts`:**
- `deterministicClustering` with files in different folders → groups by folder name
- `deterministicClustering` with all files in same folder → tries sub-tag grouping
- `computeMaxNotes(500, 4000)` → reasonable number (not 0, not > 50)
- `parseClusterResponse` valid JSON → correct clusters
- `parseClusterResponse` malformed → `null` (triggers fallback)

**`tests/canvasPrompts.test.ts`:**
- `buildEdgeLabelPrompt(pairs)` includes `<task>`, `<pairs>`, `<output_format>` XML tags
- `buildClusterPrompt(tag, notes)` includes tag name and all note titles

### Integration Tests

**`tests/commandPicker.test.ts`:**
- Discover category contains 'canvas-group'
- Canvas group has 3 subCommands

### Manual Verification

1. `npm run build` — compiles clean
2. `npm test` — all tests pass including new ones
3. `npm run test:auto` — i18n parity passes (EN/ZH-CN structure match)
4. Deploy to Obsidian, open a note that's been indexed
5. Run "Build Investigation Board" → `.canvas` file created and opens
6. Verify nodes are positioned without overlap
7. Verify edges have correct arrow directions
8. Run "Build Context Board" on a note with YouTube/PDF links → sources appear as nodes
9. Missing file links → red text nodes (not crash)
10. Run "Build Cluster Board" → tag picker opens, select tag, canvas generated with groups
11. Disable semantic search → Investigation Board shows notice, Context Board still works
12. Mobile: commands show "desktop only" notice

---

## Implementation Order

```
Phase 0 (no dependencies):
  1. src/services/canvas/types.ts
  2. src/services/canvas/layouts.ts
  3. tests/canvasLayouts.test.ts          ← validate immediately
  4. src/services/canvas/canvasUtils.ts
  5. tests/canvasUtils.test.ts            ← validate immediately

Phase 1 (depends on Phase 0):
  6. src/services/prompts/canvasPrompts.ts (edge label prompt only)
  7. tests/canvasPrompts.test.ts
  8. src/i18n/types.ts + en.ts + zh-cn.ts (canvas section + commands)
  9. src/core/settings.ts                 (3 settings + defaults + helper)
  10. src/ui/settings/CanvasSettingsSection.ts
  11. src/ui/settings/AIOrganiserSettingTab.ts (import section)
  12. src/services/canvas/investigationBoard.ts
  13. tests/investigationBoard.test.ts
  14. src/commands/canvasCommands.ts        (Investigation Board only)
  15. src/commands/index.ts                 (register)
  16. src/ui/modals/CommandPickerModal.ts   (Canvas group)
  17. tests/commandPicker.test.ts           (update assertions)
  → npm run build && npm test             ← gate check

Phase 2 (depends on Phase 0):
  18. src/services/canvas/contextBoard.ts
  19. tests/contextBoard.test.ts
  20. Add Context Board command to canvasCommands.ts
  → npm run build && npm test

Phase 3 (depends on Phase 0 + 1):
  21. src/services/prompts/canvasPrompts.ts (add cluster prompt)
  22. src/ui/modals/TagPickerModal.ts
  23. src/services/canvas/clusterBoard.ts
  24. tests/clusterBoard.test.ts
  25. Add Cluster Board command to canvasCommands.ts
  → npm run build && npm test && deploy + manual test
```
