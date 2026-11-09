# Import from Claude

What you make with Claude on the web or on your phone comes back into Obsidian. A claude.ai project's Google Drive connector
can **create** (not edit) Markdown files in a Drive folder; Google Drive for desktop syncs that folder to the computer; this
feature copies each new file into a vault folder, where the existing reviewed flows take over: the **capture inbox**
clarifies and files a deliverable, and a file with a `## Handoff` for a known project offers the existing **Review AI
hand-back** window. The importer only copies. It adds no third review and applies nothing.

Feature id `claude-import` (stage Capture, requires nothing, **default off**, desktop only). Off: no command, no settings
section, no runtime, no data key, and the AI workspace instructions, packs and live packs are byte-identical
(`tests/claudeImportInstructions.test.ts` pins them against the commit before the importer, `756c05d`).

## Turn it on and try it

1. Settings → Features → **Import from Claude** on, then reload Obsidian.
2. Settings → Integrations → **Import from Claude**:
   - **Folder in Google Drive for desktop**: `G:\My Drive\Apps\AI Organiser\From Claude` (choosing it on this computer makes
     it the computer that imports). **Check folder** confirms it can be read and is outside the vault.
   - **Vault folder for imported notes**: `0 Inbox/From Claude` (the default). Inside an inbox folder (`sweepInboxFolders`)
     the capture inbox and the Process view pick the notes up; elsewhere the settings say they will not.
   - **What Claude is told** shows the Drive folder named in the instructions (`Apps/AI Organiser/From Claude`).
3. Command **Import from Claude now** (or **Import now** in the settings). With the two sample files in the folder
   (`From Claude test - 2026-11-09.md`, `From Claude phone test.md`) the result window lists both as imported under
   `0 Inbox/From Claude/`. The phone file carries a `## Handoff`: if its Project ID is an adopted project and AI workspaces
   plus the capture inbox are on, the row offers **Review hand-back**; otherwise it says why nothing was applied.
4. Run it again: "Nothing new in the folder." The originals in Drive are untouched.
5. Copy the instructions of an AI workspace again (or let the live pack refresh): the `<handoff>` section now ends with one
   line telling Claude where and how to save deliverables.

## Parts

| Part | File | What it is |
|---|---|---|
| Gate | `src/services/claudeImport/importGate.ts` | `claudeImportActive` (on + a source folder), the Drive folder for the instructions, `checkDestination` (plain vault folder, no climb, not the config folder, not protected). |
| Policy | `importPolicy.ts` | Candidate names (`.md`/`.txt`, not hidden), stability, the fair read order, admission, copy names, `driveDisplayPath`. Pure. |
| Record | `importLedger.ts`, `ledgerStore.ts` | Data-only key `claude-import-ledger`: `pending` (write-ahead intents), `imported` (by sha256), `seen` and `refused` (by source name). Strict decoder; an unreadable record stops the importer (`claude-import-ledger-corrupt`) and **Reset import record** keeps the last three unreadable ones under `claude-import-ledger-backup`. |
| Source | `sourceFolder.ts` | The only code that touches the Drive folder, and it only reads (pinned by a test whose fake fs refuses any other call). |
| Writer | `importWriter.ts` | `createFolder` and `createBinary` of a new note, each after `assertWritable`. Never overwrites, modifies, moves or deletes. |
| Run | `importService.ts` | `runImport(env, trigger)`: never rejects; returns a report (imported with routing, outstanding and new refusals, ambiguous copies, waiting). |
| Hand-back routing | `handoffRoute.ts` | `looksLikeHandback` + `parseHandoff`: routed only when the Project ID names exactly one adopted, non-duplicated project whose note is not protected and the review exists. |
| Runtime | `importRuntime.ts` | Desktop only, while on. One run at a time; a generation that a relevant settings save, the feature turning off or unload bumps; the automatic look (`claudeImportAutoMinutes`, default 10, 0 = only on request) and one re-check when a settling file is due. |
| UI | `ClaudeImportSettingsSection.ts`, `ClaudeImportResultModal.ts`, `claudeImportCommands.ts` | Settings, the result window (each section shows its total, 50 rows then **Show 50 more**), commands `import-from-claude` (desktop) and `open-claude-import-settings`. |
| Instructions | `workspaceInstructions.ts` (`importFolder?`) | One line at the end of `<handoff>`, only while on. |

## One run

1. **Gate**: on, desktop, this computer owns the import (`claudeImportDeviceId`; a manual run on a computer with no owner
   claims it, another computer's import is not run here), the record is readable, no other run in flight.
2. **Folders**: the source is checked like the offload's mount (absolute, existing, not inside or around the vault,
   resolved with `realpath`) on every run; the destination with `checkDestination`.
3. **Recovery** of `pending` intents: target bytes hash to the intent's hash → imported; target missing → dropped; target
   with other bytes → **ambiguous**, listed under "Check these" with **It is the import** / **Import a fresh copy**; it is
   never resolved automatically.
4. **List** the whole top level (more than 5000 entries refuses the run). Links and folders are ignored; a `.md`/`.txt`
   name that cannot be a note name is refused `unsupported-name`.
5. **Settle**: unchanged across two looks at least `claudeImportStabilitySeconds` (default 30) apart. On a run you start, a
   modified time older than that also counts; a background run never trusts it (Drive can stamp a still-arriving file with
   the cloud's older time). Empty files wait.
6. **Size** before reading: over `claudeImportMaxKB` (default 512) is refused `too-large`, never read, never cut.
7. **Read** at most 50 files per run, in a fair order (never attempted first, then least recently attempted), so every file
   is reached and a failing read cannot hold the queue. Safe open: the handle's identity (`dev:ino`), link count, size and
   modified time must equal the listing's, before and after the read; at most cap + 1 bytes; a 20 s deadline (an online-only
   Drive file can stall; it waits). Windows has no no-follow open, so the identity check is the guard there.
8. **Dedup** by sha256. The per-name cache is only an optimisation: a manual run reads every listed file again (within
   the bound), a background run at most daily, so an edit that kept the size and modified time is still found.
9. **Admit** the exact bytes (refusals are reasons, not repairs): not UTF-8 or a NUL → `not-text`; properties that do not
   parse to a mapping → `frontmatter-unreadable`; a property starting `aio-`, `aio_` or `capture-` (any case) →
   `reserved-property`; any `<!-- aio:` marker → `reserved-marker`; a code block in `dataviewjs`, `js-engine`, `run-js`,
   `customjs`, `meta-bind-js`, `button` or `templater`, an inline `` `$= `` or a `<%` → `active-content`.
10. **Write**: name `<source stem>.md`, then `<stem>-<8 hex of sha256>.md`; a file with exactly these bytes already at the
    name counts as the import. The intent is saved first (or nothing is created), then `createBinary` with the original
    bytes (a BOM and CRLF kept), read back, recorded (`verified` false if the read-back differs; never deleted or retried).
11. **Report**. A manual run opens the result window with every outstanding refusal; a background run shows a notice only
    when it imported something or found a new refusal.

## Invariants

- **The Drive folder is an untrusted mailbox.** Provenance is what the plugin observed (name, size, modified time,
  sha256, when, where to); nothing a file says about itself is recorded, followed or executed.
- **The originals are never written, moved, renamed or deleted.** `sourceFolder.ts` has no write call;
  `tests/claudeImportService.test.ts` proves only reads reach the source.
- **A copy is byte-identical or does not exist**; publication is the create, and the importer never deletes, trashes,
  moves or rewrites a note it published.
- **Nothing is imported twice** (content hash) and **a ledger failure never makes a duplicate** (write-ahead intent,
  equal-content check, ambiguous left to the person).
- **Every refusal names what to do next** (`claude-import-*` guidance codes).
- **Off is byte-identical**: instructions, context pack and live pack (pinned).

## Known limits

- The content checks are a **known-pattern filter, not execution prevention**: a renderer not on the list passes. Point
  the importer only at a folder that only your own AI apps write to (the settings say so).
- **No atomic exclusive create.** Obsidian gives plugins none: the writer checks the vault index and the disk right before `createBinary`, which itself refuses an indexed path. Only the instant between those awaits is open.
- **A read cannot be cancelled.** One that outlives its 20 s deadline keeps its slot until it settles; the same file is never read twice at once and at most three may be outstanding. A drive that never answers leaves them waiting until Obsidian restarts.
- One importing computer per vault; two computers that share a synced vault import on the owner only.
- No pruning of the record (originals are never deleted, so a pruned hash would import again); about 200 bytes per import.
- Top level of the folder only; Markdown and plain text only (no Google Docs or Office conversion).
- Hand-backs are routed to the existing review; the review itself, and the capture inbox's handling of deliverables, are
  unchanged.

## Tests

`claudeImportPolicy` (names, stability, fair order, admission, codec, gate, routing), `claudeImportService` (the run end to
end against a fake fs and vault), `claudeImportRuntime` (off path, single flight, ownership, generation, corrupt record),
`claudeImportInstructions` (off pins, the one added line, escaping), `protectedWriteSites` (the writer is classified).
