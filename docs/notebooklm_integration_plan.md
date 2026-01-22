# NotebookLM Consumer Mode Integration - Implementation Plan

## Overview

Build a **Source Pack Engine** inside the AI Organiser Obsidian plugin to prepare NotebookLM-ready sources locally, minimise ingestion noise, and make updates predictable.

**Problem:** NotebookLM is excellent at synthesis and Q&A, but in consumer mode it has no public API. The manual workflow (copy, paste, upload many files) is tedious.

**Solution:** Export selected Obsidian notes as sanitised, chunked Markdown files ready for NotebookLM upload.

---

## NotebookLM Constraints

Design around these platform limits:
- **50 sources per notebook** maximum
- **500,000 words per source** maximum
- **200MB per local upload** maximum
- Supported formats: Markdown, PDF, Google Docs, text files, web URLs, YouTube URLs

---

## Phase 1 Objectives

1. **Friction reduction**: Select notes and export NotebookLM-ready sources in 1-2 clicks
2. **Quality of ingestion**: Strip Obsidian-specific noise (Dataview, callouts, embeds)
3. **Limit awareness**: Keep exports within NotebookLM limits, show warnings
4. **Predictable updates**: Versioned exports with changelog for re-upload tracking
5. **Start fresh**: Post-export tag management (clear or archive selection tags)
6. **Local-first**: No cloud integration required

---

## Non-Goals (Phase 1)

- No NotebookLM Enterprise API integration
- No browser automation
- No audio transcription loop (parked for Phase 2+)
- No automatic syncing (consumer mode requires manual upload)

---

## User Workflow

### Selection Methods

Three ways to select notes for export:

1. **Tag selection**: Mark notes with `notebooklm` tag in frontmatter
2. **Toggle command**: "NotebookLM: Toggle selection" for current note
3. **Preview modal**: Review and adjust selection before export

### Preview Modal (Required)

Before writing files, show:
- Note count and list
- Total words and estimated module count
- **Limit warnings**: Near/over 50 sources, 500k words/module, 200MB/module
- Export mode selector: Auto | Modular | Single
- Post-export action: Keep tags | Clear tags | Archive to `notebooklm/exported`

### Export Command

**Command:** `AI Organiser: Export Source Pack (NotebookLM)`

**Output structure:**
```
AI-Organiser/NotebookLM/Pack_<scopeKey>_v###/
├── index.md           # Upload instructions, TOC, naming guidance
├── module_01.md       # NotebookLM source file
├── module_02.md       # (if modular mode)
├── manifest.json      # Sidecar metadata (not for upload)
├── changelog.md       # Added/removed/changed notes
└── assets/            # (optional) exported images
```

### Post-Export "Start Fresh"

After successful export, offer:
- Clear selection tag from exported notes, OR
- Replace with `notebooklm/exported` and add export metadata

Use `app.fileManager.processFrontMatter(file, fn)` for frontmatter mutations.

---

## Technical Design

### Directory Structure

Create: `src/services/notebooklm/`

```
src/services/notebooklm/
├── types.ts                 # Data contracts and config
├── sourcePackService.ts     # Orchestrator (scope -> export)
├── selectionService.ts      # Tag selection, manual selection, toggle
├── sanitiser/
│   ├── index.ts             # Pipeline orchestrator
│   ├── removeFrontmatter.ts
│   ├── stripDataview.ts     # dataview and dataviewjs blocks
│   ├── flattenCallouts.ts   # Multi-line callout handling
│   ├── handleEmbeds.ts      # Transclusions (![[Note]])
│   ├── transformLinks.ts    # WikiLinks to plain text
│   ├── stripImages.ts       # Default: remove image refs
│   └── stripPluginNoise.ts  # Templater markers, etc.
├── chunking.ts              # Partition notes by word budget
├── hashing.ts               # SHA256 per-note and pack hash
├── writer.ts                # Write pack folder files
└── registry.ts              # Pack registry and revision management
```

**UI files:**
- `src/ui/modals/NotebookLMExportModal.ts` - Preview modal
- `src/ui/settings/NotebookLMSettingsSection.ts` - Settings section

### Data Contracts

#### SourcePackConfig

```typescript
interface SourcePackConfig {
    // Export mode
    exportMode: 'auto' | 'modular' | 'single';
    maxWordsPerModule: number;          // Default: 120,000 (cap: 500,000)

    // Sanitisation toggles
    removeFrontmatter: boolean;         // Default: true
    flattenCallouts: boolean;           // Default: true
    stripDataview: boolean;             // Default: true
    stripDataviewJs: boolean;           // Default: true

    // Embed handling
    resolveEmbeds: 'none' | 'titleOnly' | 'excerpt';  // Default: none
    embedMaxDepth: number;              // Default: 2
    embedMaxChars: number;              // Default: 2,000 per embed

    // Link context (optional)
    includeLinkContext: boolean;        // Default: false
    linkContextMaxChars: number;        // Default: 1,000
    linkContextDepth: number;           // Default: 1

    // Image handling
    imageHandling: 'strip' | 'placeholder' | 'exportAssets';  // Default: strip

    // Post-export
    postExportTagAction: 'keep' | 'clear' | 'archive';
}
```

#### manifest.json (Sidecar - Not for Upload)

```typescript
interface PackManifest {
    packId: string;                     // UUID
    revision: number;                   // Integer, increments on change
    generatedAt: string;                // ISO datetime
    scope: {
        type: 'folder' | 'tag' | 'query' | 'mixed';
        value: string;
    };
    stats: {
        noteCount: number;
        moduleCount: number;
        totalWords: number;
        totalBytes: number;
    };
    config: SourcePackConfig;           // Persisted config
    entries: PackEntry[];
}

interface PackEntry {
    filePath: string;
    title: string;
    mtime: string;                      // ISO datetime
    tags: string[];
    wordCount: number;
    byteCount: number;
    sha256: string;                     // After sanitisation
    shortId: string;                    // First 6-8 chars of sha
}
```

### Revision and Changelog

**Revisioning rules:**
1. Maintain local `pack-registry.json` keyed by `scopeKey`
2. On export, compute deterministic `packHash` over ordered entry hashes
3. If packHash changed, increment `revision`
4. Generate `changelog.md` comparing previous to new manifest:
   - Added notes
   - Removed notes
   - Changed notes (sha changes)
   - Warnings (cycles detected, embeds truncated, blocks stripped)

### Chunking Strategy

- Primary budget: **words** (NotebookLM limit expressed as words)
- Default `maxWordsPerModule = 120,000` (comfortably under 500k limit)
- Partition notes into modules based on cumulative word count after sanitisation
- **Warning threshold**: 50 modules (one notebook has 50 source limit)
- If exceeding 50 modules, suggest:
  - Increase `maxWordsPerModule`, OR
  - Reduce selection, OR
  - Export as single file (not recommended)

### Stable Anchors (Traceability)

Each note in a module begins with:

```markdown
## Note: <title> (id: <shortId>)
Source: <vaultPath> | Updated: <iso> | Tags: ...

[sanitised note content]
```

This gives NotebookLM stable citation handles and helps users map answers back to Obsidian.

### Sanitisation Pipeline

**Order of transforms:**

1. **Frontmatter**: Remove YAML frontmatter block
2. **Dataview**: Remove ` ```dataview ... ``` ` and ` ```dataviewjs ... ``` ` blocks
3. **Callouts**: Flatten multi-line callouts (`> [!TYPE] Title` + subsequent `>` lines)
4. **Embeds/Transclusions**: Handle `![[Note]]`, `![[Note#Heading]]`
   - Default: `resolveEmbeds = none` (omit embed content)
   - Optional: Insert `titleOnly` or `excerpt` with character budgets
5. **Links**: Replace WikiLinks with plain text + optional id reference
6. **Images**: Default strip entirely (no noise in NotebookLM)
7. **Plugin noise**: Strip templater markers, other non-content artefacts

#### Embed Resolution Algorithm

If `resolveEmbeds` is not `none`:

```typescript
function resolveEmbed(
    filePath: string,
    visited: Set<string>,
    currentDepth: number,
    options: {
        maxDepth: number;           // Default: 2
        maxCharsPerEmbed: number;   // Default: 2,000
        maxTotalEmbedChars: number; // Budget across all embeds
    }
): { content: string; warnings: string[] }
```

- **DFS traversal** with visited set for cycle detection
- On cycle: Insert placeholder `[Circular reference to: Note Title]`, log warning
- On depth exceed: Insert placeholder `[Embed depth exceeded: Note Title]`, log warning
- Track total chars to stay within budget

### Link Transform Strategy

NotebookLM won't follow Obsidian internal links, so prioritise readability:

- `[[Note Title]]` → `Note Title`
- If target note is in pack: append ` (see note id: <shortId>)`
- Add "Link Index" section at end of each module:
  ```markdown
  ---
  ### Link Index
  - Note Title → id: abc123
  - Other Note → (not included in pack)
  ```

### Image Handling

| Mode | Behaviour |
|------|-----------|
| `strip` (default) | Remove image references entirely |
| `placeholder` | Replace with `[Image: filename.png]` |
| `exportAssets` | Copy to `assets/` folder, keep reference |

Default is `strip` to avoid noise in NotebookLM answers.

---

## Commands

| Command | Description |
|---------|-------------|
| `NotebookLM: Toggle selection` | Add/remove `notebooklm` tag on current note |
| `NotebookLM: Export Source Pack` | Open preview modal, then export |
| `NotebookLM: Clear selection tags` | Clear from exported/folder/vault |
| `NotebookLM: Open export folder` | Open pack folder in file explorer |

---

## Settings (NotebookLM Section)

| Setting | Default | Description |
|---------|---------|-------------|
| Selection tag(s) | `notebooklm` | Tag to mark notes for export |
| Export root folder | `AI-Organiser/NotebookLM/` | Where packs are saved |
| Export mode | `auto` | auto/modular/single |
| Module word budget | `120,000` | Words per module file |
| Remove frontmatter | `true` | Strip YAML frontmatter |
| Flatten callouts | `true` | Convert callouts to plain text |
| Strip Dataview | `true` | Remove dataview blocks |
| Strip DataviewJS | `true` | Remove dataviewjs blocks |
| Resolve embeds | `none` | none/titleOnly/excerpt |
| Embed max depth | `2` | Max recursion for embeds |
| Embed max chars | `2,000` | Chars per resolved embed |
| Image handling | `strip` | strip/placeholder/exportAssets |
| Post-export action | `keep` | keep/clear/archive tags |

---

## index.md Content Template

```markdown
# Source Pack: {scopeKey}
**Revision:** {revision}
**Generated:** {timestamp}
**Notes:** {noteCount} | **Words:** {totalWords} | **Modules:** {moduleCount}

## Upload Instructions

1. Open NotebookLM and create/open a notebook
2. Click "Add Source" → "Upload"
3. Upload all `module_*.md` files from this folder
4. Do NOT upload `manifest.json` or `changelog.md`

## Recommended Notebook Naming

`Project - {scopeKey} - v{revision}`

## Updating Sources

When you re-export:
1. A new revision folder is created
2. Check `changelog.md` for what changed
3. In NotebookLM: remove changed sources, re-upload new versions
4. Or: create new notebook with new revision

## Module Contents

| Module | Notes | Words |
|--------|-------|-------|
| module_01.md | Note A, Note B, Note C | 45,000 |
| module_02.md | Note D, Note E | 38,000 |

## Note Index

| Note | Module | ID |
|------|--------|----|
| Note A | module_01 | abc123 |
| Note B | module_01 | def456 |
...
```

---

## Implementation Order

### Sprint 1: Core Infrastructure
1. `src/services/notebooklm/types.ts` - Interfaces and config
2. `src/services/notebooklm/selectionService.ts` - Tag-based selection
3. `src/services/notebooklm/hashing.ts` - SHA256 utilities
4. `src/core/settings.ts` - Add NotebookLM settings

### Sprint 2: Sanitisation Pipeline
1. `src/services/notebooklm/sanitiser/index.ts` - Pipeline orchestrator
2. `src/services/notebooklm/sanitiser/removeFrontmatter.ts`
3. `src/services/notebooklm/sanitiser/stripDataview.ts`
4. `src/services/notebooklm/sanitiser/flattenCallouts.ts`
5. `src/services/notebooklm/sanitiser/handleEmbeds.ts`
6. `src/services/notebooklm/sanitiser/transformLinks.ts`
7. `src/services/notebooklm/sanitiser/stripImages.ts`
8. `src/services/notebooklm/sanitiser/stripPluginNoise.ts`

### Sprint 3: Export Engine
1. `src/services/notebooklm/chunking.ts` - Module partitioning
2. `src/services/notebooklm/writer.ts` - File generation
3. `src/services/notebooklm/registry.ts` - Pack registry
4. `src/services/notebooklm/sourcePackService.ts` - Orchestrator

### Sprint 4: UI & Commands
1. `src/ui/modals/NotebookLMExportModal.ts` - Preview modal
2. `src/ui/settings/NotebookLMSettingsSection.ts` - Settings UI
3. `src/commands/notebookLMCommands.ts` - All commands
4. i18n strings (en.ts, zh-cn.ts)

---

## File Summary

### New Files (15)

| File | Purpose |
|------|---------|
| `src/services/notebooklm/types.ts` | Data contracts |
| `src/services/notebooklm/sourcePackService.ts` | Main orchestrator |
| `src/services/notebooklm/selectionService.ts` | Note selection |
| `src/services/notebooklm/sanitiser/index.ts` | Pipeline runner |
| `src/services/notebooklm/sanitiser/removeFrontmatter.ts` | YAML removal |
| `src/services/notebooklm/sanitiser/stripDataview.ts` | Dataview removal |
| `src/services/notebooklm/sanitiser/flattenCallouts.ts` | Callout handling |
| `src/services/notebooklm/sanitiser/handleEmbeds.ts` | Embed resolution |
| `src/services/notebooklm/sanitiser/transformLinks.ts` | Link transforms |
| `src/services/notebooklm/sanitiser/stripImages.ts` | Image handling |
| `src/services/notebooklm/sanitiser/stripPluginNoise.ts` | Plugin cleanup |
| `src/services/notebooklm/chunking.ts` | Module partitioning |
| `src/services/notebooklm/hashing.ts` | SHA256 utilities |
| `src/services/notebooklm/writer.ts` | File writing |
| `src/services/notebooklm/registry.ts` | Pack registry |
| `src/ui/modals/NotebookLMExportModal.ts` | Export preview |
| `src/ui/settings/NotebookLMSettingsSection.ts` | Settings section |
| `src/commands/notebookLMCommands.ts` | Commands |

### Modified Files (4)

| File | Changes |
|------|---------|
| `src/core/settings.ts` | Add ~15 NotebookLM settings |
| `src/commands/index.ts` | Register NotebookLM commands |
| `src/i18n/en.ts` | Add ~30 translation strings |
| `src/i18n/zh-cn.ts` | Add ~30 translation strings |

---

## Acceptance Criteria

### Export
- [ ] Produces pack folder with `index.md`, modules, `manifest.json`, `changelog.md`
- [ ] Modular export respects word budget
- [ ] Warns when approaching NotebookLM limits (50 sources, 500k words)
- [ ] Stable anchors appear for every included note
- [ ] Pack folder uses timestamp in name to avoid overwrites

### Sanitisation
- [ ] Dataview and dataviewjs blocks removed
- [ ] Callouts flattened correctly (including multi-line)
- [ ] Embeds do not recurse infinitely
- [ ] Cycles detected and reported in changelog
- [ ] WikiLinks converted to plain text with optional id reference

### Selection & Tags
- [ ] Toggle selection works on current note
- [ ] Export uses preview modal with stats
- [ ] "Clear selection tags" uses `processFrontMatter` API
- [ ] Post-export archive creates `notebooklm/exported` tag

### Revisioning
- [ ] Revision increments only when content changes
- [ ] Changelog correctly reports added/removed/changed notes
- [ ] Pack registry persists across sessions

---

## Obsidian API Notes

- **Frontmatter edits**: Use `app.fileManager.processFrontMatter(file, fn)`
- **Tag/cache reading**: Use `app.metadataCache.getFileCache(file)`, fallback to frontmatter text
- **File writing**: Use `app.vault.create()` and `app.vault.modify()`
- **Avoid unnecessary rewrites**: Check content hash before writing
- **Batch operations**: Use async batching to keep UI responsive on large vaults

---

## Verification

### Manual Testing
1. Tag 3-5 notes with `notebooklm`
2. Run "Export Source Pack" command
3. Verify preview modal shows correct stats
4. Complete export
5. Check output folder contains expected files
6. Open `module_01.md` and verify:
   - No frontmatter
   - No dataview blocks
   - Callouts flattened
   - Stable anchors present
7. Upload to NotebookLM and verify ingestion works
8. Re-export and verify revision increments, changelog shows changes

---

## Future Phases (Parked)

### Phase 2: Audio Return Loop
- Watch folder for NotebookLM audio exports
- Transcribe returned audio using Whisper
- Create note from transcription
- Link back to source pack

This is deferred as it adds complexity and has external dependencies (transcription service).
