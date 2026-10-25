# Capture Inbox

The **Clarify** step before the inbox sweep. It makes the raw things that already arrived in your inbox folders readable (a voice memo, a photo of a whiteboard, a quick typed or dictated note, a forwarded email) and proposes a title, tags and a folder. Nothing is committed until you accept. Default off (`capture-inbox`, stage Refine, requires a provider) and byte-identical when off.

It does **not** move captures into the vault. How a capture gets into the folder is up to you: a sync tool, an email-to-vault plugin, a phone shortcut, a share action, the phone's own dictation, or typing. See [Where captures come from](#where-captures-come-from).

## How it fits the rest

| Step | Where | Here? |
|---|---|---|
| Capture (transport) | whatever drops a note and/or attachments into an inbox folder | never built here |
| **Clarify** | this feature: text first, transcribe or digitise only when needed, propose title, tags, folder | yes |
| Organise | **Create note** after you accept: a new note in a folder you pick, with a link back | yes, an explicit action |
| Reflect | the inbox sweep, vault upkeep | existing |
| Engage | tasks the sweep proposes and the Google Tasks export | existing: **the sweep is the only task consumer** |

There is no task extraction, task review or export in this feature.

## What the user does

`Set up capture inbox` (inbox folders and an optional destination folder; **what to keep out**, which is required; limits, the privacy statement and a preview that counts without contacting a provider). `Process capture inbox` shows an estimate (counts, megabytes of audio, images, a cost range) and the privacy statement, then processes one capture at a time. A status-bar item shows "N captures to review"; `Review captures` opens a compact queue. The review window has three separate consequences:

1. **Accept text.** Adds one labelled section and two properties to the note. Machine text (a transcript, text read from an image) must be accepted before 2 and 3 are offered.
2. **Create note in <folder>.** A new note with a link back. The original is not moved or renamed.
3. **Run inbox sweep (all inbox notes).** The existing sweep, with its own confirmation, review and export gates. It covers the whole inbox, not only this capture.

## One inbox, one privacy policy

The inbox folders and the keep-out rules are the inbox sweep's settings (`sweepInboxFolders`, `sweepExcluded*`, `sweepNothingToExclude`). Two lists that mean the same thing would drift, so there is one. Consequences that hold **with the sweep switched off**: the capture feature has its own run precondition (`captureBlocker`: an inbox folder, and a keep-out rule or the explicit "nothing to keep out"), its own setup marker (`featureSetupCompletedAt['capture-inbox']`), and its own rename tracking for the shared folder settings (`remapSharedScope`, idempotent next to the sweep's).

## Pipeline

| Stage | File | Notes |
|---|---|---|
| Scan | `services/captureInbox/captureScanner.ts` | Inbox folders and subfolders only. A kept-out note's path is judged before its text is read. Media that any note embeds belongs to that note: it is never a bare capture, so a kept-out note keeps its media out. Only captures created after the setup (`captureSince`, set once) are picked up automatically. |
| Stability | `stabilityTracker.ts` | File events are hints. A capture is `ready` only when the note and every attachment are unchanged across observations at least `captureStabilitySeconds` apart; a missing or zero-byte attachment waits. An old mtime counts as stable only on scans you start, not on file events. A capture still missing its attachment after a day is set aside (it would hold the sweep off the note forever). Optional completion marker (`capture-complete: true` or a `.done` file). |
| Text first | `textFirst.ts` | A note with enough written words (`captureMinWords`) is used as it is and its audio is **not** uploaded; the review says so and offers "Transcribe the audio anyway". Audio is transcribed only when there is no usable text; images are read when the existing `digitisation` feature is on. |
| Guard | `capturePolicy.ts`, `inboxSweep/sweepGuard.ts` | The sweep's guard, run on paths, on the note text, again on the live note immediately before every provider call, and on machine text before it is stored or sent anywhere. |
| Media | `mediaSignature.ts`, `captureProcessor.ts` | Bytes are read once, checked against the format's signature and the size cap, and those same bytes go to `transcribeAudioFromData` (with the file's real extension). A renamed, truncated or oversized file is skipped without upload. No chunking and no temporary copies. |
| Classify | `captureClassify.ts` | The existing tagging prompt, with the capture text wrapped as data (prompt-structure tags defused) and a deliberately small folder list: the top-level folders directly under the destination folder, at most 20, minus protected, kept-out and plugin-output folders. No existing tags. The answer is validated locally; a folder the model invented is dropped. |
| Journal | `captureJournal.ts`, `captureJournalStore.ts` | Data-only key `capture-inbox-journal`. A stage marker is written before every provider call and results are stored before the next stage (at most 50 KB per entry). Nothing is stored for a capture the guard excluded. |
| Review | `ui/modals/CaptureReviewModal.ts`, `CaptureInboxQueueModal.ts`, `ui/components/CaptureInboxStatusBar.ts` | See above. |
| Write | `captureWriter.ts` | The only code that writes. Accept = one `applyNoteEdit` composite (`review: false`, the window is the gate) inserting the block and two keys; for a bare media capture it creates a companion note. |

## Invariants

- **The original is touched at most once, by insertion only, and only after Accept.** The block lives between `<!-- aio:capture -->` and `<!-- /aio:capture -->`; the keys are `capture-id` (a stable id, not the path) and `capture-status`. The fingerprint (note with the block and keys removed, whitespace-normalised, plus attachment sizes) is unchanged by the plugin's own write.
- **Accept refuses and writes nothing** when the note changed since it was processed, when the sweep already read it, when the guard now excludes it, on a damaged capture section, an unclosed code fence or unreadable properties, or when the journal could not save the write-ahead marker. The check is repeated inside the atomic edit.
- **Machine text cannot open structure in your note:** code fences, checkboxes and `#tags` are defused, and the block must be findable again after it is written.
- **Held captures are invisible to the sweep.** `sweepRunPolicy` adds every capture not yet accepted to the sweep's exclusions (exact paths). Until the journal has loaded the sweep refuses to run (`sweep-capture-loading`). The held set is frozen for the length of a sweep run. With the feature off `sweepRunPolicy` is exactly `sweepPolicy`.
- **No provider call without the guard**, and an in-flight call cannot be aborted: its result is discarded before it is stored if the run was cancelled or the feature was switched off.
- **Backpressure:** processing stops at 20 captures awaiting review. Non-terminal entries are never pruned; accepted and skipped ones become compact tombstones.
- **Crash recovery:** startup fails only `processing` entries (attempts + 1, at most 3) and resumes only the Accept write that was in flight. A bare-media Accept that reached the companion note completes its journal half, so the companion is never offered as a new capture.
- **One action at a time per capture** (accept, create note, skip): a double click writes once.
- **Routing never moves the original.** "Create note" makes a new note and links back; a real move is a possible later addition.

## What reaches a provider

Audio goes to the transcription provider and images to the multimodal provider **before their content can be checked against your keep-out words**, so do not put sensitive voice memos or photos in this folder (attachment names are matched against the words). The tagging step sends the capture text, your tag taxonomy and the names of the folders directly under your destination folder. Notes and attachments in kept-out or protected folders are never sent. The setup and the run confirmation both say so.

## Settings

Shared (the sweep's): `sweepInboxFolders`, `sweepExcludedFolders`, `sweepExcludedTags`, `sweepExcludedProperties`, `sweepExcludedTerms`, `sweepNothingToExclude`. Capture's own: `captureOnOpen` (false), `captureOnOpenMaxPerRun` (3), `captureMaxPerRun` (10), `captureMaxAttachmentMB` (10), `captureMinWords` (3), `captureDigitiseImages` (false), `captureMaxImagesPerCapture` (3), `captureMaxTextChars` (12 000), `captureStabilitySeconds` (8), `captureRequireMarker` (false), `captureDestinationRoot` (empty: no folder is proposed), `captureConfirmedAt`, `captureSince`. Process-when-opened runs only after one confirmed manual run, at most `captureOnOpenMaxPerRun` captures, at least 15 minutes apart, and never widens its scope to old notes.

## Fail closed, and what identifies a capture

- **A saved journal that cannot be fully read stops the capture inbox.** An empty fallback would forget which captures were handled, so each would be processed and charged again, and held captures and pending writes would be lost. Nothing is decoded or overwritten; the sweep refuses with `capture-journal-corrupt`; the settings offer **Reset capture journal**, which keeps a copy of the unreadable data (the last three) and then starts empty. A `data.json` that cannot be read at all is treated the same way, not as a first run.
- **A capture is identified by its note text and by a sha256 digest of each attachment's bytes** (plus path and size), so swapping a file for another of the same length is a different capture. Digests are read only for attachments that already passed the exclusion guard and the size cap, and are cached by path, size and modification time, so an unchanged file is read once. The bytes sent for transcription must match the digest, and Accept re-checks it. An attachment that cannot be read yet makes its capture wait.
- **An image is digitised from the bytes that were validated.** The processor hands the buffer that passed the signature, size and digest checks to `VisionService.digitiseBytes` (`ImageProcessorService.processImageBytes`); the pipeline never re-reads the path, so a file swapped after the check is not digitised. The path-based `digitise(file)` / `processImage(file)` entry points are unchanged for every other caller.
- **Every capture service boundary returns `Result<T>`.** `scanInbox`, the vault port reads (`readText`, `digestOf`, `readBytes`) and the journal store (`load`, `mutate`, `mutateLazy`, `flush`, `resetCorrupt`) never throw or reject past their contract. A failed scan is `capture-scan-failed` (the run does not happen); an unreadable note waits for the next scan; an unreadable attachment fails the capture as retriable; a durable journal write that cannot be saved is `capture-journal-unsaved`; a corrupt journal is `capture-journal-corrupt` from `load` and the feature stays stopped.
- **Frontmatter is judged by parsing the YAML**, not by how its lines look: scalar, list, flow-style, null-like and unparseable frontmatter is refused, and `capture-id` / `capture-status` in any spelling (quoted, flow) blocks the insertion. A link inside a code fence or code span is text, not an attachment.

- **The user's text is held, shown and copied as typed (line endings and indentation included).** `userText` removes only what is not theirs (frontmatter, the plugin block, a heading that repeats the file name); links, URLs, dates and clock times stay. `usableText` (the stripped words) is for counting words and for the classify prompt only and is never written back to a note.
- **"Mark as processed" lets the inbox empty without moving or deleting an original.** From the review window of an accepted or organised capture the user previews and confirms one change: the plugin's own `capture-status` value on the note that carries it (the original, or the companion of a bare media capture) becomes `processed`. Undo writes back `accepted-text`, byte for byte. Search the inbox with `-[capture-status:processed]` to hide processed items. An accepted or organised capture whose original is not yet marked stays in the queue (and in the journal, up to 50 beyond the recent window) until it is; marked ones are hidden behind "Show processed" so the mark can still be undone. The organised note copies the user's text from the note itself, not from the held preview. The write is refused for a note that lost its `capture-id` or is now kept out, and the fingerprint ignores the status value.

- **Nothing is set aside without a reason.** A skipped capture leaves a tombstone with its reason (`reason` on `CaptureTombstone`). The queue lists them under "Not processed" with what to do (too large, unsupported format named by extension, damaged file, image reading off, missing attachment) and a "Try again" button that forgets the skip so the next scan judges it afresh; kept-out captures are only counted. The run notice counts scan-level skips too.
- **Waiting and failed captures explain themselves.** A settling capture shows about how many seconds are left; settling and ready are told apart ("Ready to process" waits for Process now); a long run of waiting rows is summarised so the reviewable ones are not buried. A failed capture shows its reason and guidance per stage; Retry says it is back in line; the status bar counts failed ones. Starting a run while only a background look at the inbox is in flight waits for it instead of saying a run is in progress.
- **The run confirmation states what the run will really do.** `selectForRun` picks the settled captures, oldest first, at most one run's worth; the numbers are worked out for both states of "Also process existing notes" and change when it is ticked; after a capped run the notice says how many remain.
- **A protected folder inside the inbox skips only that folder.** The setup check refuses an inbox that is or sits inside a protected folder (or overlaps a plugin output folder), not one that merely contains a protected subfolder; notes there are skipped as kept out.
- **The buttons say what they do.** "Add suggestions to this note" (one labelled section and two properties in the original), "Copy into {folder}" (a new note; the original stays until marked processed), then "Open new note"; Copy is disabled until a folder is chosen. The sweep says "held for review" for captures it leaves out until they are accepted, instead of "kept out".

- **Render-check fixes.** Every guided setup window wraps a control under its label on a narrow screen (one rule on the setup body, so the sweep, capture and upkeep windows share it); the settling countdown ticks while the queue is open; a capture waiting for an attachment that has not arrived says so instead of counting down (`waitReason: attachment`); the status bar shows ready and settling separately; the confirmation counts only what a run sends by the same text-first rules (`outlayOf`: audio under a note's own text and images while image reading is off are not counted); a provider failure shows one friendly sentence (`friendlyProviderError`) and the raw answer goes to the debug log; a fallback title keeps the clock time the user wrote.

## Known limits (deliberate)

- **Not changed here (design or other surfaces):** a spoken task in a transcript stays an escaped checkbox inside the block (it is machine text; the sweep reads the note's own text); several plugin inboxes (newsletters, recordings, Kindle) still need to be pointed at the capture inbox by hand; the "Reload Obsidian" notice after toggling a feature is the shared feature-toggle behaviour; the setup preview, the run confirmation and the sweep preview count different things (held captures, bare media, older notes) and are not merged.
- **A capture that fails to tag degrades to a title from its text** and stays reviewable; a failed tagging call is not a failed capture.
- **While a sweep runs the held set is frozen**, so a capture that arrives during the run is held from the next run on. The sweep's own scope is fixed at its start, and the policy fail-closes if it does change.
- **If the capture feature fails to start** (its journal cannot load) the sweep keeps waiting rather than read held captures; reload the plugin after fixing the cause.
- **A line that equals the note's file name is ignored as written text, heading or not**, so a transport that repeats the title as body text does not suppress transcription. A genuine note whose only line is its own title is treated as having no text.
- The audit also reported items in settings migrations, Azure defaults, shared CSS and unrelated i18n copy in files this change touches. They predate this feature and are not part of it.

## Mobile

Runs only while Obsidian is in the foreground, yields between jobs, reads one attachment at a time, and shows no status-bar item (command and picker only). **This has not been tested on a phone.** Real-device checklist: cold start with a queued capture; the audio formats each transport produces (m4a, mp3, wav, webm, ogg and mp4 are accepted; caf, 3gp, amr, aac and flac are skipped with the format named); microphone permission and offline behaviour in the transport; an interrupted recording (zero-byte or truncated file); app suspension during an upload (the call fails and the capture returns to retry); a 10 MB audio file and a 10 MB image under low memory; an attachment that arrives after its note; offline then online recovery; duplicate file events; a vault with 2 000 files; very long note names; an hour of foreground use on battery; `visibilitychange` after the phone locks; HEIC photos.

## Where captures come from

The plugin does not ship or depend on a transport. Options that work today: a **sync tool** that puts a phone's voice-memo or photo folder into your vault; a **phone shortcut or share action** that writes a note and attachment into the inbox folder; an **email-to-vault plugin**, **with the caution that a disposable-address service is not private** (anyone who learns the address can read what arrives, so do not use it for sensitive mail); the **phone's own dictation** into a note. Set `captureRequireMarker` if your transport can write `capture-complete: true` or a `.done` file when a capture is whole.

## Pilot measure

For a small consent-based pilot (3 to 5 people, two weeks, a dedicated folder), read the on-device "Capture inbox activity" counts (processed, accepted, skipped by you, failed). They are local counters only: no network, no telemetry, and the volunteer copies them out with the "Copy summary" button. Success: at least 70% of processed captures accepted with at most one edit; at most 5% failing non-retriably; a median decision time under 30 seconds; zero originals changed outside the block and two keys, zero writes into a protected folder, zero duplicates; no unexpected upload. A breach of the last two stops the pilot.

## Out of scope

A second Gmail label through the newsletter script (captures need their own consumer, and the newsletter's date-based retention would delete them); an in-plugin quick-capture window; moving or deleting originals; a triage board or leaf view; live transcription; any transport, phone app, mail server or share extension; automatic acceptance; our own task extraction or export; per-folder routing rules.

## Tests

`captureInboxStateMachine`, `captureInboxJournal`, `captureInboxJournalStore`, `captureInboxStability`, `captureInboxMedia`, `captureInboxTextFirst`, `captureInboxBlock` (the insertions-only invariant), `captureInboxClassify`, `captureInboxPolicy`, `captureInboxTitle`, `captureInboxScanner`, `captureInboxWriter`, `captureInboxProcessor` (spies prove excluded text never reaches a provider), `captureInboxRuntime` (recovery), `captureInboxSharedSettings`, `captureInboxSweepInterop`, `captureInboxOffPath`, `captureInboxUi`, `inboxSweepWizardSteps` (the sweep wizard, pinned before its steps were shared), `audioTranscriptionExtension`.
