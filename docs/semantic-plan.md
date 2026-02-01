# Enhanced Semantic Search: Wide Net Retrieval + User Configuration

## Goal

Fix "light results" in Related Notes by solving three root causes:

1. **Query embedding dilution** — full 30K-char note content produces a blurred embedding that poorly matches focused 2K-char indexed chunks
2. **Chunk slot starvation** — only 6 results requested from vector store; multiple chunks from same file waste slots
3. **Placeholder similarity scores** — Voy WASM v0.6 doesn't return distances, so all results get hardcoded `score: 0.9`, breaking ranking and badges

Phase 3 (Tag Network visualization) is **deferred** — TagNetworkView uses D3.js with tag nodes (not file nodes), has no click events, and is architecturally incompatible with semantic note overlays.

---

## Review Resolution

Two external reviews identified 7 findings. Each was incorporated or challenged:

| # | Finding | Severity | Resolution |
|---|---------|----------|------------|
| 1 | Phase 3 targets TagNetworkView (D3 tag graph, not Vis.js note graph) | High | **Incorporated.** Deferred entirely — incompatible architecture. |
| 2 | Settings structure is flat, not `settings.semanticSearch.*` | High | **Incorporated.** Use flat `relatedNotesCount` on `AIOrganiserSettings`. |
| 3 | Exclude current file before dedup (otherwise best chunk = self, lost after slice) | High | **Incorporated.** Pipeline: over-fetch → filter → exclude self → dedup → slice. |
| 4 | Removing `score > 0` gate in SimpleVectorStore floods garbage results | Medium | **Incorporated.** Gate left unchanged — negative cosine similarity is genuinely irrelevant. |
| 5 | `fetchLimit = min(maxResults * 5, 100)` caps recall at high counts (e.g., 50) | Medium | **Challenged.** Raised cap to 200. Adaptive re-query rejected — adds retry logic and second embedding API call for a marginal edge case. At count=50, fetchLimit=200 with dedup should yield 40-100 unique files in most vaults. Fewer results means genuinely insufficient similar content. |
| 6 | i18n additions missing for new setting | Low | **Incorporated.** Added to Phase 2. |
| 7 | Scope of `relatedNotesCount` — sidebar only or all surfaces? | Clarify | **Incorporated.** Applies to all 4 call sites: sidebar, modal, Investigation Board, highlight chat. |

Additional finding during audit: `chatCommands.ts:389` hardcodes `5` — added as Phase 2.6.

---

## Phase 1: Wide Net Retrieval Strategy

### 1.1 `src/services/ragService.ts` — Core pipeline refactor

Refactor `getRelatedNotes()` to implement **Over-fetch → Filter → Exclude Self → Deduplicate → Slice**:

```typescript
public async getRelatedNotes(
    file: TFile,
    content: string,
    maxResults: number = 5,
    options?: { folderScope?: string | null }
): Promise<SearchResult[]> {
    // 1. Strip frontmatter + build focused query (title + first ~2000 chars of body)
    const body = content.replace(/^---[\s\S]*?---\n?/, '');
    const title = file.basename;
    const queryContent = `${title}\n\n${body}`.substring(0, QUERY_MAX_CHARS);

    // 2. Over-fetch: request 5x maxResults (capped at 200) for dedup headroom
    const fetchLimit = Math.min(maxResults * 5, MAX_FETCH_LIMIT);

    // 3. Build folder filter predicate (existing logic, unchanged)
    const folderScope = options?.folderScope;
    const filter = (folderScope && folderScope !== '' && folderScope !== '/')
        ? (doc: VectorDocument) => doc.filePath.startsWith(folderScope + '/')
        : undefined;

    const results = await this.vectorStore.searchByContent(
        queryContent, this.embeddingService, fetchLimit, filter
    );

    // 4. Exclude current file BEFORE dedup (reviewer finding #3)
    const filtered = results.filter(r => r.document.filePath !== file.path);

    // 5. Deduplicate by file: keep highest-scoring chunk per unique file
    const bestByFile = new Map<string, SearchResult>();
    for (const r of filtered) {
        const existing = bestByFile.get(r.document.filePath);
        if (!existing || r.score > existing.score) {
            bestByFile.set(r.document.filePath, r);
        }
    }

    // 6. Sort by score descending, slice to maxResults
    return Array.from(bestByFile.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults);
}
```

**Constants** (replace existing `MAX_QUERY_CHARS`):

```typescript
/** Maximum characters for the focused query embedding. Matches chunk granularity (2000 char chunks). */
const QUERY_MAX_CHARS = 2500;
/** Hard ceiling for over-fetch to keep Voy KNN performant. */
const MAX_FETCH_LIMIT = 200;
```

**Key decisions:**

- Frontmatter strip reuses existing regex from `frontmatterUtils.ts:177`
- Pipeline order: over-fetch → folder filter (in store) → exclude self → dedup → slice
- `QUERY_MAX_CHARS = 2500` aligns with 2000-char indexed chunks (title adds ~500 chars)
- SimpleVectorStore `score > 0` gate left unchanged (reviewer finding #4)

### 1.2 `src/services/vector/vectorMath.ts` — New shared module (DRY)

Extract `cosineSimilarity` from `simpleVectorStore.ts:12-30` into a shared module:

```typescript
/**
 * Vector math utilities shared across vector store implementations.
 */

/** Cosine similarity between two vectors. Returns 0 on dimension mismatch or zero magnitude. */
export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    magA = Math.sqrt(magA);
    magB = Math.sqrt(magB);
    if (magA === 0 || magB === 0) return 0;
    return dot / (magA * magB);
}
```

**SRP**: Math lives in its own module, imported by both stores.

### 1.3 `src/services/vector/voyVectorStore.ts` — Real similarity scores

Replace the hardcoded `score: 0.9` placeholder (line 189) with actual cosine similarity computed from the query vector and stored document embeddings.

**In `search()`** — use `queryVector` (already available as parameter) + `doc.embedding` (stored during upsert at line 126):

```typescript
const score = doc.embedding?.length
    ? cosineSimilarity(queryVector, doc.embedding)
    : 0.5;  // Fallback if embedding not stored (old index data)
```

Import `cosineSimilarity` from `./vectorMath`.

**Note**: `searchByContent()` already generates the query embedding and passes it to `search()` — no signature changes needed. The cosine computation is O(k * dims) where k <= 200 and dims <= 3072, which is negligible (<1ms).

### 1.4 `src/services/vector/simpleVectorStore.ts` — Import shared cosine

- Remove local `cosineSimilarity` function (lines 12-30)
- Add `import { cosineSimilarity } from './vectorMath';`
- No other changes (keep `score > 0` gate per reviewer finding #4)

---

## Phase 2: User Configuration

### 2.1 `src/core/settings.ts` — Add flat setting

Settings are flat on `AIOrganiserSettings` (not nested under `semanticSearch`).

**Interface** (after `ragIncludeMetadata` at line 125):
```typescript
relatedNotesCount: number;          // How many related notes to show (default: 15)
```

**Defaults** (after `ragIncludeMetadata` at line 250):
```typescript
relatedNotesCount: 15,
```

### 2.2 `src/ui/settings/SemanticSearchSettingsSection.ts` — Add numeric input

Add after the `ragIncludeMetadata` toggle (line 347), following existing `.addText()` pattern with parseInt validation:

```typescript
new Setting(sectionEl)
    .setName(t.settings.semanticSearch.relatedNotesCount.name)
    .setDesc(t.settings.semanticSearch.relatedNotesCount.description)
    .addText(text => text
        .setPlaceholder('15')
        .setValue(plugin.settings.relatedNotesCount.toString())
        .onChange(async (value) => {
            const n = parseInt(value);
            if (!isNaN(n) && n >= 1 && n <= 50) {
                plugin.settings.relatedNotesCount = n;
                await plugin.saveSettings();
            }
        }));
```

**Gestalt — Proximity**: Placed adjacent to existing RAG settings (context chunks, metadata toggle).
**Signifier**: Placeholder shows default (15); description shows valid range (1-50).

### 2.3 `src/ui/views/RelatedNotesView.ts` — Use setting

Replace hardcoded `5` at line 372:

```typescript
const limit = this.plugin.settings.relatedNotesCount || 15;
```

### 2.4 `src/ui/modals/RelatedNotesModal.ts` — Use setting

Replace hardcoded `5` at line 142:

```typescript
const limit = this.plugin.settings.relatedNotesCount || 15;
```

### 2.5 `src/commands/canvasCommands.ts` — Use setting

Replace hardcoded `8` at line 56:

```typescript
maxRelated: plugin.settings.relatedNotesCount || 15,
```

### 2.6 `src/commands/chatCommands.ts` — Use setting

Replace hardcoded `5` at line 389:

```typescript
const related = await ragService.getRelatedNotes(
    file, content, plugin.settings.relatedNotesCount || 15
);
```

### 2.7 `src/i18n/types.ts` + `en.ts` + `zh-cn.ts` — Add strings

Under `settings.semanticSearch`, following the `ragContextChunks` pattern (types.ts line 209):

```typescript
// types.ts
relatedNotesCount: {
    name: string;
    description: string;
};

// en.ts
relatedNotesCount: {
    name: "Related Notes Count",
    description: "Number of related notes to display in sidebar and modal (1-50)"
},

// zh-cn.ts
relatedNotesCount: {
    name: "相关笔记数量",
    description: "在侧边栏和弹窗中显示的相关笔记数量 (1-50)"
},
```

---

## Files Summary

| File | Change | Phase |
|------|--------|-------|
| `src/services/ragService.ts` | Refactor `getRelatedNotes`: focused query, over-fetch, dedup | 1.1 |
| `src/services/vector/vectorMath.ts` | **New**: Shared `cosineSimilarity` function | 1.2 |
| `src/services/vector/voyVectorStore.ts` | Real cosine scores replacing placeholder 0.9 | 1.3 |
| `src/services/vector/simpleVectorStore.ts` | Import shared cosine (DRY) | 1.4 |
| `src/core/settings.ts` | Add `relatedNotesCount: 15` | 2.1 |
| `src/ui/settings/SemanticSearchSettingsSection.ts` | Add numeric input control | 2.2 |
| `src/ui/views/RelatedNotesView.ts` | Use setting instead of hardcoded 5 | 2.3 |
| `src/ui/modals/RelatedNotesModal.ts` | Use setting instead of hardcoded 5 | 2.4 |
| `src/commands/canvasCommands.ts` | Use setting instead of hardcoded 8 | 2.5 |
| `src/commands/chatCommands.ts` | Use setting instead of hardcoded 5 | 2.6 |
| `src/i18n/types.ts` | Add `relatedNotesCount` type | 2.7 |
| `src/i18n/en.ts` | Add EN strings | 2.7 |
| `src/i18n/zh-cn.ts` | Add ZH-CN strings | 2.7 |
| `tests/vectorMath.test.ts` | **New**: Cosine similarity unit tests | Test |
| `tests/ragService.test.ts` | Update + new tests for dedup pipeline | Test |
| `docs/usertest.md` | Add manual test steps | Test |

---

## Architecture Principles

### SOLID

| Principle | Application |
|-----------|-------------|
| **SRP** | `vectorMath.ts` owns math; `RAGService` owns pipeline logic; stores own retrieval |
| **OCP** | Filter predicate pattern (`(doc) => boolean`) unchanged — open for new filter types without modifying stores |
| **LSP** | Both stores honour same `IVectorStore` interface with filter support |
| **ISP** | Callers pass `folderScope: string` — never import vector store types |
| **DIP** | `RAGService` depends on `IVectorStore` interface, not Voy/Simple concrete classes |

### DRY

| What | How |
|------|-----|
| `cosineSimilarity` | Extracted to `vectorMath.ts`, imported by both stores |
| `relatedNotesCount` | Single setting, read at 4 call sites with `\|\| 15` fallback |
| Frontmatter regex | Reuses existing pattern from `frontmatterUtils.ts:177` (inline, one-liner) |
| Filter predicate | Built once in `RAGService`, passed to store — no duplicate logic in view/modal |

### UX / Gestalt

| Principle | Application |
|-----------|-------------|
| **Proximity** | Setting placed adjacent to existing RAG settings (context chunks, metadata) |
| **Signifier** | Placeholder "15" and description "1-50" communicate valid range |
| **Feedback** | Real similarity scores fix color-coded badges (excellent >= 0.8, good >= 0.6, fair < 0.6) — currently all show "excellent" due to placeholder 0.9 |
| **Affordance** | Text input with parseInt follows established pattern for other numeric settings |

---

## Test Plan

### New: `tests/vectorMath.test.ts`

| Test | Expected |
|------|----------|
| Identical vectors | Returns 1.0 |
| Orthogonal vectors | Returns 0 |
| Dimension mismatch | Returns 0 |
| Zero-magnitude vector | Returns 0 |
| Known vectors `[1,0]` and `[1,1]` | Returns ~0.707 |

### Updated: `tests/ragService.test.ts`

| Test | Expected |
|------|----------|
| Deduplicate chunks from same file | Multi-chunk mock data, verify 1 result per file |
| Strip frontmatter from query | Content with YAML header, verify stripped before embedding |
| Over-fetch then slice | Verify store receives `fetchLimit > maxResults` |
| Use focused query (title + body) | Verify title prepended to stripped body |
| Existing tests | All continue passing (filter, folderScope, exclusion) |

### Manual: `docs/usertest.md` additions

1. Open a note that previously had few results — verify more unique files appear
2. Check similarity badges show varied scores (not all "excellent")
3. Change `relatedNotesCount` in settings to 3 — verify sidebar shows 3
4. Change to 25 — verify sidebar expands
5. Test folder scope still works with new pipeline
6. Test Investigation Board canvas uses setting count
7. Test highlight chat uses setting count

---

## Edge Cases

| Case | Behaviour |
|------|-----------|
| Notes with only frontmatter | After stripping, body is empty — title-only query (still valid embedding) |
| Notes at vault root | `folderScope` normalization unchanged (null = vault-wide) |
| Very small vaults (< 15 notes) | Returns fewer than requested — expected, not an error |
| Multi-chunk notes | Dedup ensures at most 1 result per file regardless of chunk count |
| `relatedNotesCount = 1` | Valid — shows single best match |
| `relatedNotesCount = 50` | `fetchLimit = 200`, dedup yields 40-100 unique files in typical vault |
| Embeddings not stored (old index) | Fallback score 0.5 in Voy — graceful degradation |
| Empty vault / no index | Existing error states unchanged |

---

## Verification Checklist

1. `npm test` — all tests pass including new vectorMath + ragService dedup tests
2. `npm run build` — compiles without errors
3. Deploy to `C:\obsidian\Second Brain\.obsidian\plugins\ai-organiser\`
4. Run manual test steps from usertest.md
5. Verify timestamps match between build and deploy folders
