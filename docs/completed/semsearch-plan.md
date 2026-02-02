# Semantic Search Stability & Quality Overhaul

## Goal
Fix critical index lifecycle bug, improve retrieval quality via metadata injection, and fix "Update Index" to be vault-wide. Incorporates expert feedback on gaps in prior implementation.

## What's Already Done (skip)
- Wide Net retrieval pipeline (over-fetch → dedup → slice) in `ragService.ts`
- Focused query (title + 2500 chars body) in `ragService.ts`
- Real cosine similarity in `voyVectorStore.ts` (replaced placeholder 0.9)
- Shared `vectorMath.ts` with `cosineSimilarity`
- `relatedNotesCount` setting (default 15, range 1–50) + all 4 call sites
- Semantic Search modal rewrite (textarea, Enter key, LLM query expansion, dedup)
- i18n strings for all new UI

## What's Rejected/Deferred
- **Remove `score > 0` gate** — REJECTED. Negative cosine = anti-correlated content, would flood garbage.
- **TagNetworkView semantic links** — DEFERRED. Architecture mismatch (tag graph, not file graph).

## Expert Corrections Integrated
1. Settings UI uses `.addText()` not a slider — noted, no change needed (text input is fine for numeric entry).
2. "Update Index" only re-indexes the active note, not vault-wide changed files — must fix.
3. Rename/move doesn't re-embed — with metadata injection, folder path in embedding becomes stale on rename. Must re-embed.
4. Need index schema version bump + one-time rebuild trigger for mixed old/new embeddings.

---

## Phase 1: Fix Index Lifecycle Bug (Critical)

**Problem**: Every `saveSettings()` call unconditionally clears the vector index.

**Call chain**:
```
saveSettings() [main.ts:93]
  → initializeEmbeddingService() [main.ts:96→103]
    → vectorStoreService.updateEmbeddingService() [main.ts:116]
      → this.vectorStore.clear() [vectorStoreService.ts:217]
```

### 1.1 `src/main.ts` — Conditional embedding reinit

Capture embedding config before save, only reinitialize if embedding settings changed:

```typescript
public async saveSettings(): Promise<void> {
    // Capture current embedding config before saving
    const prevEmbeddingProvider = this.settings.embeddingProvider;
    const prevEmbeddingModel = this.settings.embeddingModel;
    const prevEnableSemanticSearch = this.settings.enableSemanticSearch;

    await this.saveData(this.settings);
    await this.initializeLLMService();

    // Only reinitialize embedding service if embedding-related settings changed
    const embeddingSettingsChanged =
        this.settings.embeddingProvider !== prevEmbeddingProvider ||
        this.settings.embeddingModel !== prevEmbeddingModel ||
        this.settings.enableSemanticSearch !== prevEnableSemanticSearch;

    if (embeddingSettingsChanged) {
        await this.initializeEmbeddingService();
    }

    this.t = getTranslations(this.settings.interfaceLanguage);
}
```

**Note**: `initializeEmbeddingService()` must also be called on first load (in `onload()`), which already works — this change only gates the `saveSettings()` path.

### 1.2 `src/services/vector/vectorStoreService.ts` — Conditional clear

Change `updateEmbeddingService` to only clear when embedding physics actually changed:

```typescript
public async updateEmbeddingService(
    embeddingService: any,
    shouldClear: boolean = false
): Promise<void> {
    this.embeddingService = embeddingService;
    if (shouldClear && this.vectorStore) {
        await this.vectorStore.clear();
    }
}
```

Update `initializeEmbeddingService()` in `main.ts` to pass `shouldClear: true` (since it's only called when embedding settings changed now).

---

## Phase 2: Fix "Update Index" to Vault-Wide Modified-Only

**Problem**: `handleUpdateIndex()` in `ManageIndexModal.ts` only re-indexes the active note. Users expect it to update all changed files.

### 2.1 `src/ui/modals/ManageIndexModal.ts` — Vault-wide update

Replace `handleUpdateIndex()`:

```typescript
private async handleUpdateIndex(): Promise<void> {
    if (!this.ensureIndexingAvailable() || !this.plugin.vectorStoreService) {
        return;
    }

    const statusNotice = new Notice(this.plugin.t.messages.updatingIndex, 0);
    try {
        // Vault-wide modified-only pass (change tracker skips unchanged files)
        const result = await this.plugin.vectorStoreService.indexVault();
        statusNotice.hide();
        new Notice(
            this.plugin.t.messages.indexBuildComplete
                .replace('{indexed}', String(result.indexed))
                .replace('{failed}', String(result.failed))
        );
    } catch (error) {
        statusNotice.hide();
        new Notice(`${this.plugin.t.messages.indexUpdateFailed}: ${(error as any).message}`);
    }
}
```

**Note**: `indexVault()` already uses the change tracker — `indexNote()` calls `hasChanged()` at line 249 and skips unchanged files. So calling `indexVault()` effectively does "update changed files" without any new code in the service layer.

### 2.2 `src/i18n/en.ts` + `zh-cn.ts` — Update labels

```typescript
// en.ts
updateLabel: "Update changed files",
updateDesc: "Re-index notes that have changed since last indexing",

// zh-cn.ts
updateLabel: "更新已修改文件",
updateDesc: "重新索引自上次索引以来已更改的笔记",
```

---

## Phase 3: Metadata Injection

**Problem**: Embeddings only capture note content, not categorical context. "GROW Model" note in `Coaching/` folder doesn't embed the concept "coaching" unless the note text says it.

### 3.1 `src/services/vector/vectorStoreService.ts` — Prepend metadata to chunks

In `indexNote()`, after chunking and before embedding, prepend structural context:

```typescript
// After line 266 (chunks created), before line 270 (document creation loop)
const tags = this.getFileTags(file);
const folderPath = file.parent?.path || '';

// Build metadata prefix (bounded length)
const metadataPrefix = this.buildMetadataPrefix(file.basename, folderPath, tags);
```

New private method:

```typescript
/** Max chars for metadata prefix to avoid diluting actual content */
private static readonly METADATA_PREFIX_MAX_CHARS = 200;

private buildMetadataPrefix(title: string, folderPath: string, tags: string[]): string {
    const parts: string[] = [];
    if (title) parts.push(`Title: ${title}`);
    if (folderPath) parts.push(`Path: ${folderPath}`);
    if (tags.length > 0) parts.push(`Tags: ${tags.join(', ')}`);

    let prefix = parts.join('\n');
    if (prefix.length > VectorStoreService.METADATA_PREFIX_MAX_CHARS) {
        prefix = prefix.substring(0, VectorStoreService.METADATA_PREFIX_MAX_CHARS);
    }
    return prefix ? prefix + '\n---\n' : '';
}

private getFileTags(file: TFile): string[] {
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache) return [];
    const tags: string[] = [];
    // Frontmatter tags
    if (cache.frontmatter?.tags) {
        const fmTags = Array.isArray(cache.frontmatter.tags)
            ? cache.frontmatter.tags
            : [cache.frontmatter.tags];
        tags.push(...fmTags.map((t: string) => t.replace(/^#/, '')));
    }
    // Inline tags
    if (cache.tags) {
        tags.push(...cache.tags.map(t => t.tag.replace(/^#/, '')));
    }
    return [...new Set(tags)];
}
```

Then in the document creation loop, prepend to content for embedding (but store raw content for display):

```typescript
for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkHash = createContentHash(chunk);

    documents.push({
        id: `${file.path}-${i}`,
        filePath: file.path,
        chunkIndex: i,
        content: chunk,  // Raw content for display/preview
        metadata: {
            title: file.basename,
            createdTime: file.stat?.ctime || Date.now(),
            modifiedTime: file.stat?.mtime || Date.now(),
            contentHash: chunkHash,
            wordCount: chunk.split(/\s+/).length,
            tokens: Math.ceil(chunk.length / 4)
        }
    });
}

// Embed with metadata prefix (not stored in content, only used for embedding)
const textsForEmbedding = documents.map(doc => metadataPrefix + doc.content);
const embeddingResult = await this.embeddingService.batchGenerateEmbeddings(textsForEmbedding);
```

**Key design choice**: The metadata prefix is prepended for embedding generation only. The stored `content` field remains raw text so previews and highlights don't show "Title: GROW\nPath: Coaching/" prefix.

### 3.2 Index Schema Version Bump

Update both stores' default metadata version:

```typescript
// In voyVectorStore.ts and simpleVectorStore.ts
version: '2.0.0'  // Was '1.0.0'
```

### 3.3 One-Time Rebuild Detection

In `vectorStoreService.ts`, after loading index, check version and prompt rebuild:

```typescript
const INDEX_SCHEMA_VERSION = '2.0.0';

private async checkIndexVersion(): Promise<boolean> {
    if (!this.vectorStore) return false;
    const metadata = await this.vectorStore.getMetadata();
    return metadata.version === INDEX_SCHEMA_VERSION;
}
```

Call this in `ensureIndexLoaded()`. If version mismatch, log a warning. The ManageIndexModal "Build Index" button (which does a full clear + reindex) handles the actual rebuild — we just need to surface the staleness.

### 3.4 Staleness Notice

In `ManageIndexModal.onOpen()`, check index version and show a notice if outdated:

```typescript
// After rendering buttons
if (this.plugin.vectorStoreService) {
    const metadata = await this.plugin.vectorStore?.getMetadata();
    if (metadata && metadata.version !== INDEX_SCHEMA_VERSION) {
        contentEl.createEl('p', {
            text: t.modals.manageIndex.indexOutdated || 'Index was built with an older version. Rebuild recommended for best results.',
            cls: 'ai-organiser-warning'
        });
    }
}
```

Add i18n strings for `indexOutdated` in EN and ZH-CN.

---

## Phase 4: Re-embed on Rename/Move

**Problem**: `renameFile()` only rewrites document IDs and file paths. With metadata injection, the folder path baked into embeddings becomes stale.

### 4.1 `src/services/vector/vectorStoreService.ts` — Re-embed on rename

Replace the lightweight path-rewrite with a full re-index, with fallback for when embedding service is unavailable:

```typescript
public async renameNote(oldPath: string, newPath: string): Promise<void> {
    if (!this.vectorStore) return;
    await this.ensureIndexLoaded();

    if (this.embeddingService) {
        // Full re-embed with correct metadata prefix
        await this.vectorStore.removeFile(oldPath);
        const file = this.app.vault.getFileByPath(newPath);
        if (file instanceof TFile) {
            await this.indexNote(file);
        }
    } else {
        // Lightweight path rewrite (no embedding service available)
        await this.vectorStore.renameFile(oldPath, newPath);
    }
    this.searchCache.clear();
}
```

**Cost consideration**: Rename/move triggers one embedding API call per file (batch for all chunks). This is acceptable for individual file renames.

**Fallback**: If `embeddingService` is null (semantic search disabled), fall back to the current path-rewrite behavior to avoid data loss.

### 4.2 Bulk Rename Guard

**Problem**: Obsidian fires individual `rename` events per file. Renaming a root folder with 500 notes triggers 500 re-embed calls — massive cost for cloud providers (~$0.50–$2.00 on OpenAI) and app freeze for local/Ollama users.

**Solution**: Batch rename detection with debounced queue in `vectorStoreService.ts`:

```typescript
/** Threshold above which bulk rename requires user confirmation */
private static readonly BULK_RENAME_THRESHOLD = 10;
/** Debounce window to collect rename events from a single folder rename (ms) */
private static readonly RENAME_DEBOUNCE_MS = 500;

private pendingRenames: Array<{ oldPath: string; newPath: string }> = [];
private renameTimer: ReturnType<typeof setTimeout> | null = null;

public queueRenameNote(oldPath: string, newPath: string): void {
    this.pendingRenames.push({ oldPath, newPath });

    if (this.renameTimer) clearTimeout(this.renameTimer);
    this.renameTimer = setTimeout(() => this.flushRenames(), VectorStoreService.RENAME_DEBOUNCE_MS);
}

private async flushRenames(): Promise<void> {
    const batch = [...this.pendingRenames];
    this.pendingRenames = [];
    this.renameTimer = null;

    if (batch.length > VectorStoreService.BULK_RENAME_THRESHOLD) {
        // Show notice — user can rebuild via Manage Index instead
        new Notice(
            `${batch.length} notes moved. Run "Update Changed Files" in Manage Index to re-embed with updated paths.`,
            10000
        );
        // Do lightweight path rewrites only (preserves old embeddings, avoids cost)
        for (const { oldPath, newPath } of batch) {
            if (this.vectorStore) {
                await this.vectorStore.renameFile(oldPath, newPath);
            }
        }
        this.searchCache.clear();
    } else {
        // Small batch — re-embed each file
        for (const { oldPath, newPath } of batch) {
            await this.renameNote(oldPath, newPath);
        }
    }
}
```

Update the event handler in `registerFileEventHandlers()` to use the queue:

```typescript
this.fileEventRefs.push(this.app.vault.on('rename', async (file, oldPath) => {
    if (file instanceof TFile && file.extension === 'md' && !this.isIndexing) {
        this.queueRenameNote(oldPath, file.path);
    }
}));
```

**Behavior**:
- ≤10 files renamed: Re-embed each immediately (current plan)
- >10 files renamed: Lightweight path rewrite + notice to rebuild via Manage Index
- Debounce window (500ms) collects all events from a single folder rename before deciding

---

## Reviewer Notes (addressed)

### Content hash vs mtime
The reviewer suggested using content hash instead of mtime for change detection. This is **already implemented** — `vectorStoreService.ts` uses `createContentHash(content)` (line 244) and `changeTracker.hasChanged(filePath, contentHash)` (line 246). The change tracker stores content hashes, not timestamps. Files that were "touched" without content changes are correctly skipped.

### Score > 0 gate
Kept as-is. If users still report light results after metadata injection, we can revisit by lowering to a small negative threshold (e.g., -0.05) as a follow-up, but this should not be needed — metadata injection solves the categorical gap that was the actual root cause. The Top-K limit already prevents garbage from reaching users.

---

## Files Summary

| File | Change | Phase |
|------|--------|-------|
| `src/main.ts` | Conditional embedding reinit on save | 1.1 |
| `src/services/vector/vectorStoreService.ts` | Conditional clear, metadata prefix, re-embed on rename, schema check | 1.2, 3.1, 4.1 |
| `src/ui/modals/ManageIndexModal.ts` | Vault-wide update, staleness notice | 2.1, 3.4 |
| `src/i18n/en.ts` | Update labels + staleness string | 2.2, 3.4 |
| `src/i18n/zh-cn.ts` | Update labels + staleness string | 2.2, 3.4 |
| `src/i18n/types.ts` | Add `indexOutdated` string type | 3.4 |
| `src/services/vector/voyVectorStore.ts` | Version bump to 2.0.0 | 3.2 |
| `src/services/vector/simpleVectorStore.ts` | Version bump to 2.0.0 | 3.2 |

## Tests

### New tests
- `main.ts saveSettings` — Mock: change non-embedding setting → verify `vectorStore.clear()` NOT called
- `main.ts saveSettings` — Mock: change embedding provider → verify `vectorStore.clear()` IS called
- `vectorStoreService.buildMetadataPrefix` — Verify format and bounded length
- `vectorStoreService.buildMetadataPrefix` — Verify truncation at METADATA_PREFIX_MAX_CHARS
- `vectorStoreService.renameNote` — Verify removes old + re-indexes at new path
- `vectorStoreService.renameNote` — Verify fallback to path rewrite when no embedding service
- `vectorStoreService.flushRenames` — ≤10 files → each re-embedded
- `vectorStoreService.flushRenames` — >10 files → lightweight rewrite only + notice

### Existing test updates
- `ragService.test.ts` — No changes needed (pipeline logic unchanged)

## Verification Checklist

### Stability
- [ ] Change interface language in settings → Related Notes still works (index NOT wiped)
- [ ] Change embedding provider → index IS cleared, rebuild starts
- [ ] Change max tags setting → index NOT wiped

### Quality (requires rebuild after deploy)
- [ ] Create note "GROW" in `Coaching/` folder (don't write "coaching" in body)
- [ ] Rebuild index
- [ ] Semantic Search "Coaching models" → GROW note appears (folder path in embedding)

### Update Index
- [ ] "Update Changed Files" → re-indexes all modified notes vault-wide (not just active note)
- [ ] Unchanged notes are skipped (change tracker)

### Rename/Move
- [ ] Rename a note → related notes still find it with correct context
- [ ] Move a note to different folder → semantic search reflects new folder category
- [ ] Rename with semantic search disabled → lightweight path rewrite (no error)
- [ ] Rename folder with >10 notes → notice shown, lightweight rewrite (no mass re-embed)
- [ ] Rename folder with ≤10 notes → each re-embedded silently

### Schema Migration
- [ ] Open Manage Index with old index → staleness warning shown
- [ ] "Build Index" → rebuilds with new schema version
- [ ] After rebuild → staleness warning gone

## Edge Cases
- **Rename during indexing** (`this.isIndexing` flag) — existing guard skips rename handler during bulk indexing
- **Bulk folder rename (500+ notes)** — debounce queue collects events, >10 triggers lightweight rewrite + notice instead of mass re-embed
- **Notes with no tags and root-level** — prefix is just `Title: X\n---\n` (still useful)
- **Very long folder paths** — bounded by `METADATA_PREFIX_MAX_CHARS` (200 chars)
- **Embedding service unavailable on rename** — falls back to path rewrite
- **First load after upgrade** — old index works but with stale embeddings; ManageIndex shows staleness notice
- **Content hash already in use** — `createContentHash(content)` + `changeTracker.hasChanged()` already prevents re-embedding unchanged files (not mtime-based)
