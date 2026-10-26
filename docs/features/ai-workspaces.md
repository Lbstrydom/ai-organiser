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

## Hand-back (markdown `## Handoff`)

Command **Review AI hand-back** on the open note. Gate: `ai-workspaces` AND `capture-inbox` enabled (either off: no command, nothing changes). In this version it is command-driven; routing a capture-inbox file to the review automatically, Office files, `captureDocuments` and the "Read it anyway" fallback extraction are not built.

| Part | File | What it is |
|---|---|---|
| Parser | `handoffParser.ts` | Grammar v1, deterministic, no provider call. First `Handoff` heading (level 1-3, outside code); `Project ID:` / `Chat project: name (app)`; Decisions / Next actions / Deliverables / Questions. Template placeholders echoed back are ignored. Nothing is silently truncated: items over 500 characters are flagged, items past 50 per section are counted (`more`). Malformed (no section, no header, conflicting or invalid id) returns reasons, never a guess. Item ids are `sha256(handbackId + section + text + ordinal)` computed by the plugin. |
| Matching | `handoffMatch.ts` | An id that resolves to exactly one project is exact; an unknown or duplicated id is rejected with no default. Otherwise scored from the remembered mapping (`aiWorkspaceChatMap`, key `<app>:<name>`), workspace chat names, title/file name, folder; pre-selected only with score >= 0.6 and a margin of >= 0.25. No semantic search yet. |
| Journal | `handbackJournal.ts` | `aiHandbacks[id]`: items frozen on first review; `pending / applying / applied / declined / failed`; an applied item is final; an `applying` item goes back to `pending` at start-up and is checked against its receipt. |
| Note edits | `handoffNoteEdit.ts` | Decisions and questions are added under `## Decisions` / `## Open questions` as one reviewed edit; each line carries `<!-- aio:handoff id=… -->`, so a replay adds nothing. |
| Service | `handbackService.ts` | `prepareHandback` (freeze + suggest) and `applyHandback`. Next actions become rows in the **sweep review** (same lists, dates, contexts; the project already linked); a stated `(due: …)` only pre-fills the date. Sweep item identity prevents duplicates on re-processing. |
| Review | `HandbackReviewModal.ts` | Project suggestion with the reason, one toggle per item (nothing ticked for you), deliverables listed but not filed. |

Not written: stamping the project id into the hand-back note's frontmatter (the journal and the mapping carry it).

## Connector and vault map (AI sharing opt-in, pack tool)

Settings: **Apply this list to the connector and the vault map** (`aiShareRequireOptIn`, default off). It is on only while `ai-workspaces` is on (`shareOptInActive`).

- **Off (default)**: the connector and the vault map serve exactly what they always did; the published scope document has no sharing fields while `ai-workspaces` is off, and its revision is the one it always had (pinned by a test that recomputes the legacy hash).
- **On**: the scope document gains `requireOptIn: true` and `shareFolders`; the server's `scopeAllows` (a transliteration kept in step by a generated-path parity suite) serves a note only if it is ALSO inside a share folder (default deny: an empty list serves nothing), and `folderVisible` shows a folder only if it is inside, or on the way to, one. The vault map applies the same filter, and the export confirmation is bound to the allow-list. A scope document that asks for the opt-in without a readable allow-list is invalid and the server fails closed.
- **Pack tool `get_workspace_pack { id }`**: listed only while the published scope carries `packs: { folder, revision }` (that is, while AI workspaces are on). It serves the latest pack of one project, read-only, and re-checks at serving time: the pointer (`latest.json`, written beside the pack with its `sources`) must carry the policy revision published now, every source must pass `scopeAllows` AND the share allow-list AND lie outside the pack folder, the pointer must name a pack file in that project's own folder, and the file's SHA-256 must equal the pointer's digest. Any failure is "no longer available"; changing the allow-list republishes the scope (new revision), which withdraws older packs at once. Packs follow the allow-list with or without the opt-in.
- Deviation from the original plan: the pack policy travels inside the scope document (one atomic, tombstoned publication) rather than a separate `share-policy.json`, so a scope and a policy can never disagree.

## Not in this slice

Hand-back from the connector (a mailbox tool) is deferred by the roadmap. A signed manifest in the cryptographic sense is not built: the digest and the policy revision bind a pack to what the plugin wrote and published, in the same way the scope document is trusted (a vault write is already full access).
