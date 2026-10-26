# Projects, Operations and the Google Script Row (Layer 0)

The shared foundation under the GTD and PARA work: **one project service** that is the only code that knows what a project is, **one operation index** that lists unfinished work in one place, and **one status row** for the user's Google script. Plans: `docs/plans/aio-gtd-para-roadmap.md` (sections 2-6; the plans are gitignored and live in a working checkout). Gated, default off and byte-identical when off: with no consumer enabled nothing here is built, registered or written.

## Gate

`projectServiceActive` and `operationIndexActive` (`projects/projectService.ts`, `operations/operationIndex.ts`) read `isFeatureEnabled`; today the one consumer is `google-tasks-export`. **Each slice that adds a consumer adds it to those two functions, once.** The project commands are registered under that feature only (`REGISTER_BY_FEATURE`), the Projects settings section is owned by it (`sub-projects`), and the integration status row shows only while `google-tasks-export` or `cloud-inventory` is on. `getProjectService(plugin)` returns `null` when no consumer is on, so nothing is built and no listener is registered; `peekProjectService` never creates one (safe from a render).

## Project identity

Two hidden frontmatter keys, owned by the service: `aio-id` (a UUID v4) and `aio-role` (`project`, `area` or `container`). Paths, names and remembered mappings never override the id.

- **Index** (`projects/projectIndex.ts`, pure): `buildProjectIndex(notes, { roots })` -> `projects` (with `status`, `rootKind`, `folder`, `pairing`), `anchors` (any role), `duplicates` (an id on two notes: both listed, **nothing resolves** for that id until the user keeps one) and `unadopted` (an id with no role, an unknown role or an invalid id: offered for adoption). `resolveAnchor` resolves any role, `resolveProject` only role `project`. The Obsidian-facing wrapper (`ProjectService`) rebuilds the index lazily after a metadata-cache change, delete or rename.
- **Adopt** (`projects/projectAdoption.ts`, `ProjectService.adoptProject`): one reviewed edit through `applyNoteEdit` adds `aio-id`, `aio-role` and, for a project with none, `status: active`, as a pure **insertion** into the frontmatter (`utils/frontmatterKeys.ts`: nothing the user wrote is re-serialised). A note with an id but no role keeps its id and gets only the role. Refused with a stable code: an invalid id, an existing role of another kind, an already adopted note, frontmatter that cannot take keys. The first plan fixes the id, so the preview and the write add the same bytes. Nothing is moved or renamed. `adoptContainer` gives an Area or a container (a Reference anchor) no status.
- **Source to project** (`resolveSourceProject`, one shared resolver): (1) the note is itself a project note; (2) a `project` frontmatter link to a project note; (3) containment, where a project's scope is its note's folder only when that note is the folder's single project note, and the innermost scope wins; (4) none. `ambiguous` (a duplicated id) never sets an id.
- **PARA roots** (`projects/paraRoots.ts`): the one shared setting `paraRoots: { path, kind: inbox|projects|areas|reference|archive, driveRootId? }[]` (default `[]`, at most 12). It is only normalised and **validated** here (exists, not protected, not a plugin output folder, inbox roots equal the capture/sweep inbox folders, no overlap between kinds); setting it moves nothing. Edited in Settings -> Integrations -> Projects.
- **Shared picker** (`ui/components/ProjectPicker.ts`): one searchable list (title, folder, root kind, status, pairing badge). It highlights a suggestion only when the caller says it is clearly ahead, with the reason beside it, and never pre-selects an ambiguous match. Used today by **Open project**.

Commands: `Adopt note as project` (the active note) and `Open project`.

## Operation index

`operations/operationSummary.ts` (pure) and `operations/operationIndex.ts`. One small file per operation in `<plugin folder>/operations/<opId>.json` (so two devices never overwrite each other's entries). **Domain journals stay authoritative**: a journal step newer than its summary repairs the summary, a summary without a journal is shown as orphaned, an unreadable journal is surfaced and never trusted. Finished entries older than 30 days are pruned; unfinished ones never. Storage is created by the first write only (`list` never creates the folder).

Cross-device policy, stated honestly: there is no lock over a synced vault. Each summary records a random per-installation `device` id (kept in local storage). Another device's unfinished operation **blocks an overlapping one** (same resource keys) and is shown as running elsewhere; **Take over** is allowed only after 24 hours without an update and with the user's confirmation that the plugin is not running there; the owner field then changes and an original device that resumes later reads it and stops (as timely as sync). Only the owner updates an operation. Nothing writes summaries yet in this slice: the sweep export is the first writer (next PR).

## Google script capability checks

`googleScript/modulePing.ts`: `normaliseModulePing(module, response)` gives each module `{ version, capabilities }`. A validated **legacy** v1 answer gets exactly what v1 had (tasks: `upsert`, `lists`; inventory: `list`), so a newer plugin keeps working with an older deployment; a malformed answer gets no capabilities (the setup state). It also reads the standalone v2 form (a top-level `capabilities` array) and the combined form (`modules.<module>`). A feature declares the capability it needs; a missing one disables **only that feature** with `script-capability-missing` guidance. `pingModule` is the one network call (through `appsScriptClient`; the secret stays in the body).

The **integration status row** (`ui/settings/IntegrationStatusRow.ts`, top of Integrations) shows each configured module's version and capabilities from a "Check now" ping, what it lacks, how many items wait for a script update, and states the real Google access the script has and what it never does.

## Tests

`projectIdentity` (keys, adoption, index, resolvers, PARA roots, the service over a faked vault, registration and off path), `operationsAndScriptCapabilities`, `modulePing`, `protectedWriteSites` (the operation store is a `plugin-data` site).
