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
| Pack | `contextPack.ts` (each note once: inside the pack the instructions point at the notes that follow instead of repeating them; a link to a shareable note that is not part of the pack reads `[not in this pack]`; the staleness hash ignores the workspace block and the blank lines it came with) | `buildContextPack`: instructions + project note + Area note + context sources, each with path and content hash. Links to notes that are not shareable read `[not shared]`; attachments are never included. **No link syntax is parsed by the plugin**: occurrences and positions come from Obsidian's metadata cache (`linkNeutraliser.ts`) and are replaced by offset. External web links (a markdown link or image whose target starts with http://, https:// or mailto:) are not links the cache missed: Obsidian does not report them and they point at nothing in the vault, so the workspace link the plugin itself writes never blocks a later pack. The cache is trusted only while it matches the text: an occurrence not found at its offset, a missing cache, or a link-like marker (outside code) that no occurrence covers leaves the note out of the pack (`links-unverified`, shown in the preview). Links written inside inline code trip the same check (over-blocking, never leaking); drawing blobs are dropped (`toModelText`). 400 KB budget, over it refuses (`pack-over-budget`). |
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

Command **Review AI hand-back** on the open note. Gate: `ai-workspaces` AND `capture-inbox` enabled (either off: no command, nothing changes). While it is active the inbox sweep and the capture inbox both skip hand-back notes, so only this review reads them and a capture Accept never changes a hand-back's id. In this version it is command-driven; routing a capture-inbox file to the review automatically, Office files, `captureDocuments` and the "Read it anyway" fallback extraction are not built.

| Part | File | What it is |
|---|---|---|
| Parser | `handoffParser.ts` | Grammar v1, deterministic, no provider call. First `Handoff` heading (level 1-3, outside code); `Project ID:` / `Chat project: name (app)`; Decisions / Next actions / Deliverables / Questions. Template placeholders echoed back are ignored. Nothing is silently truncated: items over 500 characters are flagged, items past 50 per section are counted (`more`). Malformed (no section, no header, conflicting or invalid id) returns reasons, never a guess. Item ids are `sha256(handbackId + section + text + ordinal)` computed by the plugin. |
| Matching | `handoffMatch.ts` | An id that resolves to exactly one project is exact; an unknown or duplicated id is rejected with no default. Otherwise scored from the remembered mapping (`aiWorkspaceChatMap`, key `<app>:<name>`), workspace chat names, title/file name, folder; pre-selected only with score >= 0.6 and a margin of >= 0.25. No semantic search yet. |
| Journal | `handbackJournal.ts` | `aiHandbacks[id]`: items frozen on first review; `pending / applying / applied / declined / failed`; an applied item is final; an `applying` item goes back to `pending` at start-up and is checked against its receipt. |
| Note edits | `handoffNoteEdit.ts` | Decisions and questions are added under `## Decisions` / `## Open questions` as one reviewed edit; each line carries `<!-- aio:handoff id=… -->`, so a replay adds nothing. |
| Service | `handbackService.ts` | `prepareHandback` (freeze + suggest) and `applyHandback`. Next actions become rows in the **sweep review** (same lists, dates, contexts; the project already linked); a stated `(due: …)` only pre-fills the date. Sweep item identity prevents duplicates on re-processing. |
| Review | `HandbackReviewModal.ts` | Project suggestion with the reason, one toggle per item (nothing ticked for you), deliverables listed but not filed. |

Transport from claude.ai (web or phone): [Import from Claude](claude-import.md) copies new files a Claude project saves in a Google Drive folder into the inbox; a hand-back among them offers this review for exactly one known project.

Not written: stamping the project id into the hand-back note's frontmatter (the journal and the mapping carry it).

### Sending a hand-back: the `vault-handback` skill

The sending side is a skill for AI apps, [`docs/skills/vault-handback/SKILL.md`](../skills/vault-handback/SKILL.md); install steps are in [`docs/skills/README.md`](../skills/README.md). No plugin behaviour changes. It writes one end-of-session hand-back in the grammar above, or one capture per note. With a file tool it writes a **new** file to `0 Inbox/From Claude/`: it never overwrites, it refuses a name that exists, and it does not create the folder. Without a file tool it prints paste-ready text with the note name above it and no outer fence, because a fenced `## Handoff` is not seen.

It never emits `aio-id` / `aio-role`, `capture-id` / `capture-status`, `aio:` markers or unquoted YAML, and it defaults decisions to `Suggested:`. **Drift:** the skill is hand-written, so `tests/vaultHandbackSkill.test.ts` pins its grammar block to `renderHandoffContract` and runs every example through `parseHandoff`, `looksLikeHandback`, the sweep guard and the capture text-first rules. Change the grammar and the test fails until the skill matches.

## Connector and vault map (AI sharing opt-in, pack tool)

Settings: **Apply this list to the connector and the vault map** (`aiShareRequireOptIn`, default off). It is on only while `ai-workspaces` is on (`shareOptInActive`).

- **Off (default)**: the connector and the vault map serve exactly what they always did; the published scope document has no sharing fields while `ai-workspaces` is off, and its revision is the one it always had (pinned by a test that recomputes the legacy hash).
- **On**: the scope document gains `requireOptIn: true` and `shareFolders`; the server's `scopeAllows` (a transliteration kept in step by a generated-path parity suite) serves a note only if it is ALSO inside a share folder (default deny: an empty list serves nothing), and `folderVisible` shows a folder only if it is inside, or on the way to, one. The vault map applies the same filter, and the export confirmation is bound to the allow-list. A scope document that asks for the opt-in without a readable allow-list is invalid and the server fails closed.
- **Pack tool `get_workspace_pack { id }`**: listed only while the published scope carries `packs: { folder, revision }` (that is, while AI workspaces are on). It serves the latest pack of one project, read-only, and re-checks at serving time: the pointer (`latest.json`, written beside the pack with its `sources`) must carry the policy revision published now, every source must pass `scopeAllows` AND the share allow-list AND lie outside the pack folder, the pointer must name a pack file in that project's own folder, and the file's SHA-256 must equal the pointer's digest. Any failure is "no longer available"; changing the allow-list republishes the scope (new revision), which withdraws older packs at once. Packs follow the allow-list with or without the opt-in.
- Deviation from the original plan: the pack policy travels inside the scope document (one atomic, tombstoned publication) rather than a separate `share-policy.json`, so a scope and a policy can never disagree.

## Live pack (opt-in per project, desktop only)

While it is on, the plugin rebuilds a project's pack when its notes change and overwrites ONE file, `<project> - live pack.md`, in a
folder inside Google Drive for desktop (outside the vault). The Claude project's instructions gain a `<live_pack>` section telling
Claude to search Drive for that exact name at the start of each chat. Verified 2026-11-07: a claude.ai project chat on a phone found
such a file through Drive search; an in-place local edit reached Drive in about 12 s with the same file id; a new chat read the change.

| Part | File | What it is |
|---|---|---|
| Approval | `workspaceRecord.ts` (`live?: LiveApproval`) | Approved paths, policy revision, writer `deviceId`, destination `folder` + `fileName` (fixed at the first approval, kept by every re-review), `generation`. Absent = off, and the key is absent, so a record without it normalises exactly as before. An approval that fails validation but still names a file becomes a pending revocation in the migration. |
| Pure build | `livePack.ts` | `buildLivePack`: approved notes only; shareable but unapproved notes are **held** (listed under `## Held for review`, links to them read `[not in this pack]`); an approved note that is no longer shareable returns `revoke`; a renamed project note returns `needs-review`. Marker `aio-live-pack: <id>` as a top-level frontmatter key; the date is outside the digest. `buildLiveStub` is the "no longer shared" text. |
| Writer | `liveFileWriter.ts` | The only Node `fs` writer of the live pack. Folder checked like the offload mount (absolute, exists, not the vault). One handle per write: `lstat`, open `r+` (or `wx+`), `fstat` identity (`dev:ino` as strings), single link only, ownership marker read through the handle, the caller's authorization callback, the same checks again, a device-local intent record, `truncate`, full write loop, `sync`, bounded read-back (`LIVE_FILE_MAX_BYTES + 1`), close in `finally`. **In place, never rename-over**: that is what keeps the Drive id. |
| Service | `livePackService.ts` | One queue for review, confirm, refresh, turn off and revocations. An authorization epoch bumped synchronously by every settings save and consent change; each write re-checks epoch, approval, policy and source hashes immediately before it. Unchanged digest + verified file = no write. Status in `aiWorkspaceLiveStatus` (status only). |
| Scheduler | `livePackScheduler.ts` | Quiet time (`aiWorkspaceLiveDelayMinutes`, default 5) with a 30-minute maximum wait; watches the paths of the newest snapshot of each project (a changed `area` link is picked up when the project note changes). |
| Runtime | `livePackRuntime.ts` | Desktop only. Revoke-only reconciler at start-up (runs with the feature off; writes stubs only, saves nothing when nothing is pending), the settings-save hook, `onExternalSettingsChange`, the feature teardown. |
| UI | `LivePackReviewModal.ts`, `AiWorkspaceModal.ts`, `AiWorkspacesSettingsSection.ts` | Review with one checkbox per note (project note required, approved ticked, **new unticked**), the selected size from the exact live output, previews one at a time. Command **Refresh live pack now** (desktop). |

Invariants:
- **Off is unchanged.** No `live` key, no `<live_pack>` section, the same escaping, the same pack bytes (`tests/aiWorkspaceLiveOffPath.test.ts` pins them at `2b29b6b`), and nothing is saved at start-up when nothing is pending.
- **Consent is per note and per policy.** A change of the share policy pauses the live pack (`needs-review`); if an approved note is no longer shareable the file becomes the stub.
- **Revocation is durable.** A `PendingRevocation` is saved before an approval is cleared and removed only after the stub is written and read back; none is dropped for space. Only the writing computer writes; another one can only request it.
- **Never a foreign file.** A file without this project's marker (or an open intent for its exact `dev:ino`), a symlink or a hard link is never written.
- **Copies are not retracted.** What an AI app already read stays there; the settings, the review and the turn-off confirmation say so.
- Known limits: two computers turning on the same project while offline from each other is unsupported (the synced record keeps one owner; the other stops). An interrupted write can leave the Drive file empty until the writing computer runs again (Drive keeps version history).

## Not in this slice

Hand-back from the connector (a mailbox tool) is deferred by the roadmap. A signed manifest in the cryptographic sense is not built: the digest and the policy revision bind a pack to what the plugin wrote and published, in the same way the scope document is trusted (a vault write is already full access).
