# Inbox Sweep and Google Tasks Export

Reads the notes in the folders you choose and proposes next actions, waiting-for items, projects and someday items. You review every item first; only what you approve is added to one sweep report note, and your source notes are never changed. Optional: send the approved tasks to one Google Tasks list through your own Apps Script. Both are default off (`inbox-sweep`, stage Refine, requires a provider; `google-tasks-export`, external-account boundary, requires `inbox-sweep`) and byte-identical when off.

> **Capture inbox.** The [capture inbox](capture-inbox.md) is the Clarify step before this sweep. It reads the same inbox folders and keep-out rules (one inbox, one privacy policy), keeps captures it still holds out of the sweep (`sweepRunPolicy`), and leaves tasks to this sweep. Its keep-out and inbox-folder wizard steps are shared code (`ui/setup/inboxScopeSteps.ts`).

## What the user does

`Set up inbox sweep` (three steps: inbox folders and the report note; **what to keep out**, which is required; a preview that counts notes without contacting any AI provider). Then `Sweep inbox`: a confirmation with the number of notes and characters (plus a once-per-session notice when the provider is a cloud service), a review window where every item starts unchecked, and **Add N to sweep report**. `Set up Google Tasks` is three steps too: connect a setup script, pick a list, then lock the script to that list.

## Pipeline

| Stage | File | Notes |
|---|---|---|
| Snapshot | `services/inboxSweep/noteSnapshot.ts` | Each note is read once. Tags and properties are parsed from the same bytes, never from the metadata cache. |
| Guard | `services/inboxSweep/sweepGuard.ts` | Pure and fail-closed, runs before any model call on the full text. Excludes by folder, protected folder, tag (nested too), `key: value` property, term, or anything unknown (unreadable frontmatter, too large, not a string). Only it can produce a `GuardedSnapshot`, which is all the prompt builder accepts. The policy revision is re-checked immediately before every call. Ships no built-in company, folder or term. |
| Extraction | `services/prompts/sweepPrompts.ts`, `inboxSweep/sweepService.ts` | XML-structured prompt returning the minutes `gtd_processing` shape with an `evidence` quote per item. Evidence not found in the note drops the item. The schema degrades: text is truncated, unknown contexts become empty, malformed items are dropped and counted. |
| Review | `ui/modals/InboxSweepReviewModal.ts` | Unchecked by default; edit text and context; per-note "mark as swept". Footer reads "Add N to sweep report", or "Mark reviewed" when none are ticked. |
| Outbox | `inboxSweep/sweepCommit.ts`, `sweepLedger.ts` | Order: persist the approval record, write the report section, mark items reported and apply the dispositions, then export. Each step is repeatable; recovery reads the report note and compares the ids it holds with the record. |
| Report | `inboxSweep/sweepReport.ts` | Owned `<!-- aio:sweep run=... -->` sections. Task text is inline data only: newlines and control characters collapse, comment delimiters and `[[ ]]` are neutralised, text is capped, the context is restricted to the known `@` set. A damaged or partial section is a conflict that writes nothing. |
| Tasks script | `inboxSweep/tasksScriptTemplate.ts` | Setup deployment (no list approved: cannot create anything) then operational deployment (locked to one list id, enforced in the script). Script lock, at most 25 items per request, a four minute budget, `[aio:<id>]` markers in task notes so a retry never duplicates. |
| Export | `inboxSweep/tasksExportService.ts` | Only `reported` items, in batches of 25, over the shared Apps Script client. The guard is re-run on each item's current source note first. One way: completion is never read back. |

## Invariants

- Excluded text never reaches the provider; a test spies on the model call.
- A note is offered again only when its content hash changed. Ledger keys follow renames (`rename` listener in `inboxSweepCommands.ts`).
- **The same item is never added twice.** When a changed note is read again every item in it is proposed again, so each approved item carries identity keys (`itemKeys` in `sweepItemIdentity.ts`: the quoted line and the wording, normalised, one pair for the model's wording and one for the user's edit) remembered per source note (`sweepReportedItems`, at most 500 keys per note, written in the same save as the ledger, moved by the rename listener; tasks recorded by 1.1.1 or earlier are recognised from their stored text, and a task whose export failed still counts because it is in the report). `reportedMatch` has two outcomes. **Exact** (same wording): the review shows the item disabled as "Already in your sweep report", and `commitReview` drops it (and repeats inside a batch, and keyless tasks judged by their text) before anything is persisted, so neither the report nor the Google Tasks export can receive it twice. **Similar** (same quoted line, wording overlapping by at least half): probably the model's rewording, but a sentence can hold two commitments ("Send the invoice to Alice and to Bob"), so the item stays addable with the note "Looks like one you already added" and the user decides. A note with nothing new defaults to "swept". Limits: matching is per note (the same task in two notes is two items), and a task deleted from the report by hand is still treated as added.
- Source notes are never modified. The report note is written with `applyNoteEdit` (no review modal because the review window is the gate), created only after `validateReportPath` and a writability check.
- A failure after the approval record is saved leaves it saved: the next sweep or "Send approved tasks" finishes the record before doing anything else.
- No keep-out rule and no explicit "Nothing to keep out" means no sweep (`sweep-keepout-required`).

## Settings

`sweepInboxFolders`, `sweepExcludedFolders`, `sweepExcludedTags`, `sweepExcludedProperties`, `sweepExcludedTerms`, `sweepNothingToExclude`, `sweepReportPath`, `sweepMaxNotes` (20), `sweepMaxChars` (12 000), `sweepLedger`, `sweepApprovals`, `sweepReportedItems`; `tasksScriptUrl`, `tasksListId`, `tasksListName`, `tasksLastTest`. The Tasks secret is in SecretStorage (`ai-organiser-google-tasks-secret`), created when the setup script is first copied.

## Tests

`sweepGuard`, `sweepService`, `sweepReport`, `sweepLedger`, `sweepCommit`, `sweepItemKeys`, `sweepReportedItems`, `sweepReoffer`, `sweepReofferRollback`, `sweepReviewReported`, `tasksScriptTemplate` (including the script run against a fake Tasks service), `tasksExportService`, `inboxSweepSetup`, `inboxSweepOffPath`.
