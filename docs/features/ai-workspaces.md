# AI workspaces

Prepare what a Claude or ChatGPT project needs, from notes the person chose to share. The plugin never sends anything to an AI
app: it builds text, shows the exact notes, and the person copies or uploads it.

Feature id `ai-workspaces` (stage Create, requires `agent-index`, **default off**). Off, no command, no settings section and no
write exists. It adds `ai-workspaces` as a consumer of the project service (`projectServiceActive`).

## Parts (this slice)

| Part | File | What it is |
|---|---|---|
| Share scope | `src/services/aiWorkspaces/aiShareScope.ts` | `isAiShareable(path)` = in the index scope AND inside an `aiShareFolders` entry AND not in the pack folder. Default deny: an empty list shares nothing. `sharePolicyRevision` hashes everything that decides shareability. |
| Record | `workspaceRecord.ts` | `aiWorkspaces[aio-id]`: chat projects, context sources, packs made, released. Validated on every read; a chat URL is accepted only for `https://claude.ai/project/…` and `https://chatgpt.com/…`. |
| Block | `workspaceBlock.ts` | The plugin-owned `<!-- aio:workspace -->` section in the project note (shared owned-block grammar). A damaged marker is `workspace-block-conflict`, nothing is written. Written through `applyNoteEdit`, so it is a reviewed edit. |
| Handoff contract | `handoffGrammar.ts` | The `## Handoff` shape shown in the instructions. The parser that reads it back belongs to the hand-back slice and must use this same definition. |
| Instructions | `workspaceInstructions.ts` | `buildWorkspaceInstructions`: XML-structured, deterministic. Project body ≤ 8 KB, the Area's `AI context` section ≤ 4 KB; plugin-owned blocks and frontmatter left out. |
| Pack | `contextPack.ts` | `buildContextPack`: instructions + project note + Area note + context sources, each with path and content hash. Links to notes that are not shareable read `[not shared]`; attachments are never included. **No link syntax is parsed by the plugin**: occurrences and positions come from Obsidian's metadata cache (`linkNeutraliser.ts`) and are replaced by offset. The cache is trusted only while it matches the text: an occurrence not found at its offset, a missing cache, or a link-like marker (outside code) that no occurrence covers leaves the note out of the pack (`links-unverified`, shown in the preview). Links written inside inline code trip the same check (over-blocking, never leaking); drawing blobs are dropped (`toModelText`). 400 KB budget, over it refuses (`pack-over-budget`). |
| Store | `packStore.ts` | `<pack folder>/<aio-id>/pack-YYYYMMDD-HHmmss-<hash12>.md` + `latest.json`, newest five kept. Only files matching the store's own name are ever trashed. |
| Service | `workspaceService.ts` | `preparePack` → preview → `confirmPack` / `confirmInstructions`. |

## Invariants

- **The preview is bound to a snapshot.** A prepared pack carries each source's content hash and the share-policy revision;
  confirming re-reads both and refuses a stale preview (`pack-preview-stale`). What is copied or written is what the preview showed.
- **A pack never makes itself stale**: a source's hash is taken on the note *without* its workspace block.
- **Pack names carry seconds and 12 hex digits of the digest**; an existing file is trusted only when its bytes equal the confirmed pack, writes and confirmations run one at a time, and the pack just written is never pruned.
- **The pack folder is never shared back**: `isAiShareable` refuses anything inside it.
- **Revoking cannot retract an upload.** The settings say so; removing a folder only stops future packs including it.
- The Area comes from the project note's `area` property (a link), never from folders.

## Not in this slice

The read-only connector tool `get_workspace_pack`, the signed share-policy publication and the `aiShareRequireOptIn` toggle for
the connector and vault map are a later change. `aiShareRequireOptIn` exists in the schema (default false, part of the policy
revision) but has no settings row yet, because nothing reads it. Hand-back of the `## Handoff` section is the next slice.
