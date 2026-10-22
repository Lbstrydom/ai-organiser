# Vault Upkeep

An optional scheduler that checks the vault and **proposes** what needs attention. It never links, trashes, offloads or edits a note. Default off (`vault-upkeep`, stage Maintain) and byte-identical when off: no command, no timer, no listener, inert settings. It is separate from the Inbox Sweep (different settings, report and feature id); they may share the generic `IntervalJob` later.

## What the user does

`Set up vault upkeep` (two steps: how often and what to check, defaults daily and the checks whose feature is on; then a **dry run** that shows the counts and writes nothing). Afterwards `Run vault upkeep now` is always available, whatever the interval. A review window lists what was found; every button opens the place that already handles that change safely.

## Checks and proposals

| Check | Needs | Proposes |
|---|---|---|
| Agent index | `agent-index` | `agent-index-stale` (counts); `agent-index-refreshed` when the opt-in rebuild ran |
| Drive inventories | `cloud-inventory`, a paired folder and a valid link | `inventory-differs` per pair (read-only; the only check that uses the network). A pair that could not be read fails the check, never "unchanged". |
| Attachments | `embed-scan` | `attachment-unreferenced`, `attachment-large`, `attachment-duplicate` (only if enabled) and `link-suggestion` from the basic title-word matcher only (no model, no embedding, no egress) |

The matcher (`upkeepTasks.suggestLinks`) tokenises note titles once into an inverted index, proposes a note that shares two title words (or the attachment's only long word), keeps one suggestion per attachment and 50 in all, and runs in chunks that yield and check the run context.

## Execution

- **One core, two entry points** (`upkeepService.executeTasks`): `runUpkeep` (saved settings, the index may be rebuilt when opted in, result retained and announced) and `previewUpkeep` (unsaved draft selections, `allowIndexPublish: false`, nothing retained or saved).
- **Contracts**: `TaskOutcome` (`ok | skipped | failed | cancelled`), `RunSummary` (`ok | partial | failed`; a failed or partial run with zero proposals is never shown as nothing to review), a discriminated `Proposal`, and a bounded collector (100 items per check, exact totals per kind, an omitted count; 200 persisted, details clipped to 200 characters).
- **Scheduler** (`intervalJob.ts`, injected clock): `plugin.registerInterval` so Obsidian clears it on unload; the first tick after start is immediate (an overdue run happens at start-up); single flight; a mutex released in `finally`; skipped while the page is hidden, on mobile unless opted in, or while interactive model work is in flight; backoff `max(interval, min(interval * 2^failures, max(interval, 24 h)))` from the end of the failed attempt, so never earlier than the interval; a run cap (`RunContext` with a signal and a deadline) that stops between checks and ends the run as partial. The index rebuild is not interrupted once publication begins.
- **Announcements**: a manual run opens the review (or says "Nothing to review", or shows the failure). A scheduled run never opens a window; it shows one Notice with **Open review** only when its proposals differ from the last announced set, and one Notice per failure streak. An open review does not change under the user: it offers "Show it" when a newer result exists.
- **Report**: runs never write a note. **Save report as note** in the review is the explicit action; it creates `Vault upkeep report.md` in the chosen folder (the vault root when empty) and replaces it only when its first line is the plugin's signature.

## Settings

`upkeepInterval`, `upkeepCustomMinutes`, `upkeepTasks`, `upkeepAutoRefreshIndex`, `upkeepIncludeDuplicates`, `upkeepReportFolder`, `upkeepRunOnMobile`, `upkeepRunCapSeconds`, plus the retained `upkeepLastRun`, `upkeepLastProposals` (capped), `upkeepFailures`, `upkeepLastNotified`.

## Tests

`intervalJob`, `upkeepTasks`, `upkeepService`, `upkeepRuntime` (no vault writes during a run, mutex, interval registration and cleanup, context gates, dry run), `upkeepReport`, `vaultUpkeepOffPath`, `protectedWriteSites`.
