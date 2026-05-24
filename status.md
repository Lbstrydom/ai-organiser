# Project Status Log

## 2026-05-24 — Deepgram Nova-3 acoustic diarization v2 (opt-in, live-verified)

### Changes
- Delivered the full `docs/plans/deepgram-diarization-v2.md` plan in one cycle: 5 new files + 16 modified, +29 unit tests, all 4654 vitest tests still passing, `npm run build:quick` green, `npm run lint` exit 0 (6 sentence-case warnings on legitimate brand-name strings only).
- Plan went through **4 GPT-5.4 audit rounds + 3 Gemini final-review rounds = 43 findings, all fixed** before implementation started. Iteration halted per the rigor-pressure rule when Gemini G3 began surfacing memory-overhead concerns that drove the v2 file-size cap from 500 MB → 200 MB (covers ≈3.5 hours of 128 kbps audio).
- **D0** — `secretIds.PLUGIN_SECRET_IDS.DEEPGRAM`, `settings.deepgramApiKey` field, `secretStorageService` migration block (persist-then-clear-plaintext pattern matching YouTube/PDF/audio).
- **D1** — `src/services/diarization/types.ts` (`DiarizationProvider` interface, `DiarizationResult`, `DEEPGRAM_COST_PER_MIN_USD = 0.0043`, `DEEPGRAM_MAX_FILE_BYTES = 200 MB`, `DEEPGRAM_LARGE_FILE_WARN_BYTES = 100 MB`) + `deepgramAdapter.ts` (~290 LOC) with full HTTP contract: `mip_opt_out=true` enforced, MIME sniffing via shared `getAudioMimeType` (G4 DRY), retry-on-429 with injectable sleeper/jitter (R4 M4), transport-level error classification (`network-dns` / `network-tls` / `network-csp` / `network-offline`), seconds→ms conversion (G2-H2), 1-indexed "Speaker N" labels (G2-L1), cost computed from `metadata.duration * (rate/60)` (G2). 23 fixture-driven tests against a SHAPE-only sanitized `tests/fixtures/diarization/deepgram-sanitized-20min.json` (no PII per Gemini G1).
- **D2** — `getDeepgramApiKey(plugin)` in `apiKeyHelpers.ts` with `useMainKeyFallback: false` explicitly disabled (Deepgram has no main-LLM equivalent — without this, `resolveApiKey` hands the user's Claude key to Deepgram and returns http-401).
- **D3** — `AudioAttachCoordinator` extended with `setDiarizationOptIn()` / `shouldUseDiarization()` / `canTranscribeNow()` (single-file constraint per R3 H1 — Deepgram speaker IDs are per-request, multi-file would silently corrupt identity) / `getUpfrontSourceSize()` / `estimateAudioCostUsd()` / `formatCostPreview()` / `transcribeDiarized()` (pre-import size guard + post-import second-line guard + DIP via optional `provider?` constructor argument).
- **D4** — `AudioAttachHelper` extended with `diarizationToggle?` options (visible / checked / disabled / costPreviewText / onChange callback); inline checkbox rendered between trio and items list. New `DiarizationPrivacyModal.ts` (~90 LOC) with 3-button-state handling (accept / reject / ESC-as-reject). 6 modal tests passing.
- **D5** — `MinutesCreationModal` + `TranscribeOnlyModal` both wire the toggle, async-resolve key on `onOpen()` with race guard, branch `handleTranscribeAudio` → `handleTranscribeAudioDiarized` when opted in, push `DiarizationResult` cost/provider/language into the transcript-note frontmatter via the existing `saveTranscriptToDisk` + extended `TranscriptNoteFrontmatterSchema`.
- **D6** — `MinutesSettingsSection` enables the previously-disabled `audioDiarisationProvider` dropdown for `'none'` / `'deepgram'`; AssemblyAI option labelled "(coming soon — not available)" + reverts to prior value via `onChange` Notice (R4 M2 — no per-option disabled support in Obsidian's `addDropdown`). Conditional Deepgram password input renders only when provider === 'deepgram'.
- **D-i18n** — new `t.diarization` top-level namespace with 13 keys × 2 locales (EN + ZH-CN); `costPreview` template uses `{cost}` substitution with pre-formatted formatter output (R4 M1 — fixes earlier double-tilde risk).
- **Whisper preservation** — explicitly verified: default `audioDiarisationProvider='none'` runs the v1 Whisper+LLM path unchanged; checkbox hidden on `Platform.isMobile`; even when Deepgram configured the per-session checkbox starts unchecked; multi-file attach disables Transcribe with `t.diarization.multiFileDisabledTooltip`; mobile users keep the v1 path forever.

### Files Affected
- **New**: `src/services/diarization/types.ts`, `src/services/diarization/deepgramAdapter.ts`, `src/ui/modals/DiarizationPrivacyModal.ts`, `tests/diarization/deepgramAdapter.test.ts`, `tests/diarizationPrivacyModal.test.ts`, `tests/fixtures/diarization/deepgram-sanitized-20min.json`, `scripts/spikes/sanitize-diarization-fixture.mjs` (run-once, gitignored under `scripts/`).
- **Modified**: `src/core/secretIds.ts`, `src/core/settings.ts`, `src/services/apiKeyHelpers.ts`, `src/services/audioTranscriptionService.ts` (export `getAudioMimeType` for adapter reuse), `src/services/secretStorageService.ts`, `src/services/transcriptNoteService.ts` (3 optional diarization frontmatter fields), `src/main.ts` (2 session flags), `src/ui/components/AudioAttachHelper.ts`, `src/ui/coordinators/AudioAttachCoordinator.ts`, `src/ui/modals/MinutesCreationModal.ts`, `src/ui/modals/TranscribeOnlyModal.ts`, `src/ui/settings/MinutesSettingsSection.ts`, `src/i18n/types.ts`, `src/i18n/en.ts`, `src/i18n/zh-cn.ts`, `styles.css`, `tests/mocks/obsidian.ts` (added `titleEl`, `focus()`, `blur()`, `dataset`).

### Decisions Made
- **v2 desktop-only for diarization** (R1 M5 + Gemini G3): checkbox hidden on mobile via `Platform.isMobile` guard. Mobile users keep the v1 Whisper+LLM path forever — this is a scope decision, not a fallback. Mobile diarization is a separate v3 follow-up.
- **File-size cap 200 MB** (Gemini G3): originally proposed 500 MB; lowered after Gemini flagged Obsidian Sync per-file limits (~100-200 MB on standard tier) and Electron renderer IPC memory doubling. 200 MB covers >95% of meetings; `DEEPGRAM_LARGE_FILE_WARN_BYTES = 100 MB` advisory Notice fires once per session above the Sync threshold.
- **Single-file constraint when diarized** (R3 H1): Deepgram speaker IDs (0, 1, 2…) are scoped to a single API request — `speaker 0` in chunk A ≠ `speaker 0` in chunk B. v2 enforces single-file at coordinator-level (`canTranscribeNow()`) when opt-in is active; multi-file Whisper path remains untouched. v3 reconciliation deferred until real users hit this.
- **Cost is computed not reported** (Gemini G2): Deepgram's response body has no per-request cost field. We compute `actualCostUsd = durationSec/60 * DEEPGRAM_COST_PER_MIN_USD` from the authoritative `metadata.duration` and write it into transcript-note frontmatter. Null fallback only when `metadata.duration` missing.
- **`useMainKeyFallback: false`** in `getDeepgramApiKey` — discovered during live testing that omitting this flag causes `resolveApiKey` to fall through to the user's main LLM key (e.g. Anthropic), which Deepgram correctly rejects with http-401. The plan §7 noted "no main-LLM equivalent" but the bug was in the implementation — the live persona test caught what unit tests missed.
- **Lift diarization opt-in state to the modal** — `rerenderModal()` (called whenever audio is attached via Pick from vault) recreates the `AudioAttachCoordinator` from scratch. Storing `diarizationOptedIn` only on the coordinator would wipe the user's "Identify speakers" choice every time they attach a file. Fix: keep `private diarizationOptedIn = false` on the modal itself, re-apply to each new coordinator via `setDiarizationOptIn()` in `onOpen()`. Also a live-test catch — unit-test scope didn't cross the rerender boundary.

### Live verification
Pat persona harness (`scripts/persona-harness/pat-diarization-v2-rerun.mjs`) drove the full opt-in flow against `AI-Organiser/Recordings/hamina-board-first-20min.mp3` (18.3 MB / 20-min Finnish board meeting):

```
✅ Checkbox renders when Deepgram + key configured
✅ Privacy modal fires on first opt-in
✅ Accept persists opt-in (checkbox stays checked)
✅ Opt-in SURVIVES rerenderModal (after fix #1)
✅ Pick-from-vault attached the right file
✅ Cost preview "~$0.09 for this file" matches spike's $0.086 prediction
✅ Transcribe routed through Deepgram (not Whisper) — after fix #2 (useMainKeyFallback)
✅ Transcription completed in 34.8s (vs spike's 7.6s — Obsidian I/O + buffer overhead)
✅ Post-transcription cleanup modal fired
✅ Transcript note saved with frontmatter:
       diarization_provider: deepgram
       diarization_cost_usd: 0.086
       diarization_language: en
```

Both live-discovered bugs (rerender state-wipe + useMainKeyFallback) are now fixed in the same commit set as the original implementation.

### Next Steps
- Optional v3 candidates (all deferred, see plan §12): Speechmatics / AssemblyAI adapters, voice profiles, Deepgram region selection, multi-file speaker reconciliation, exact-duration cost preview (vs file-size estimate), "Test connection" settings button.
- Mobile diarization is genuinely out of scope for v2 — Whisper stays the universal path on mobile. If real-world mobile users request it, the work item is small (the adapter already uses Obsidian's `requestUrl`).

---

## 2026-05-23 — Speaker-aware transcription UX (plan v1 complete + live-verified)

### Changes
- Delivered the full `docs/plans/speaker-aware-transcription-ux.md` plan across 10 commits (~8,500 LOC added, +155 tests). Three persona-test P0s and the P1 from session `pat-transcription-speakers` (2026-05-23) are now closed in code AND verified live against a real 20-minute Finnish board-meeting recording.
- **F0** — extracted `tryNativeFilePicker` + `openVaultFilePicker` from `FreeChatModeHandler` into `src/ui/utils/filePickers.ts` so the audio-attach work reuses (not duplicates) the chat file-picker logic.
- **F1 foundation** — `TimedTranscript` / `LabelledTimedTranscript` types in `src/services/transcriptTypes.ts`, `AudioSourcePicker` (desktop / mobile webview / vault adapters — closes Pat's mobile attach P0), `AudioPreviewSource` (URL resolver + cleanup), `speakerReviewState` discriminated unions.
- **F1 wire** — `audioImportService` (vault persistence for non-vault sources), `AudioAttachCoordinator` (single orchestration owner), `AudioAttachHelper` (strict presentational component).
- **F1b** — wired the helper into `MinutesCreationModal`: the audio attach trio renders unconditionally at the top of the audio section (Pat P0 #1 closed).
- **F2** — `labelSpeakersTimed()` pipeline + `SpeakerReviewPanel` component + modal integration with `canGenerateMinutes()` CTA gating (Pat P0 #2 closed).
- **F5** — `src/services/speakerAttribution/` module: deterministic post-pass that rewrites `action.owner` using provenance + language-specific rules (English strategy + NoOp for other languages). Action ownership now derives from "who actually said it" instead of LLM inference alone.
- **F4** — opt-in document auto-inject via chip prompt + `DocumentMultiPickerModal` (Pat P1 closed — no more silent injection of GTD PDFs into Q3 budget meetings).
- **F3** — top-level `transcribe-audio` command + `TranscribeOnlyModal` + `transcriptNoteService` (Zod schema + base64+gzip body per Gemini-r1 G5 / Gemini-r2 G1) + picker leaf + `transcriptOutputFolder` setting (Pat P0 #3 closed).
- **Post-persona-test fixes** — aria-label double-prefix on Speaker rows; Whisper `detected_language` now threads through `TranscriptionResult.language` → `transcriptionResultToTimedTranscript` → both consumers (no more hardcoded `'und'`).

### Files Affected
- `src/services/transcriptTypes.ts` — canonical TimedTranscript contract (R1 H2 + R2 H5)
- `src/services/transcriptNoteService.ts` — Zod-validated read/write for transcript notes; base64+gzip body
- `src/services/speakerLabellingService.ts` — extended with `labelSpeakersTimed()` + `transcriptionResultToTimedTranscript()`
- `src/services/speakerAttribution/{types,englishStrategy,noOpStrategy,registry,provenanceBackfill,index}.ts` — F5 attribution module
- `src/services/audioTranscriptionService.ts` — `TranscriptionResult.language` field
- `src/services/audio/audioImportService.ts` — per-kind vault persistence
- `src/ui/utils/filePickers.ts`, `src/ui/utils/AudioSourcePicker.ts` — shared file pickers + platform-aware audio source picker
- `src/ui/coordinators/AudioAttachCoordinator.ts`, `src/ui/coordinators/AudioPreviewSource.ts` — orchestration + preview-URL lifecycle
- `src/ui/components/AudioAttachHelper.ts`, `src/ui/components/SpeakerReviewPanel.ts`, `src/ui/components/speakerReviewState.ts` — presentational components + state unions
- `src/ui/modals/TranscribeOnlyModal.ts`, `src/ui/modals/DocumentMultiPickerModal.ts` — two new modals
- `src/ui/modals/MinutesCreationModal.ts` — major rework: unconditional audio section, opt-in doc chip, speaker review panel, CTA gating
- `src/ui/modals/CommandPickerModal.ts` — new transcribe-audio leaf + alias additions on minutes leaf
- `src/commands/transcribeCommands.ts` — new `ai-organiser:transcribe-audio` registration
- `src/core/settings.ts` — `transcriptOutputFolder` setting + `getTranscriptOutputFullPath()` helper
- `src/i18n/{types,en,zh-cn}.ts` — ~40 new keys with full EN + ZH-CN parity
- `styles.css` — new class families for speaker review, doc-multi-picker, transcribe-only modal, offscreen-input
- 11 new test files (155 tests across audio, speaker, attribution, picker, transcript)

### Decisions Made
- **AudioSourceResolver collapsed into AudioAttachCoordinator** — the plan listed them as separate classes, but the resolver was a one-line delegation after import service. Same observable behaviour, one less indirection. Documented in F1-wire commit.
- **Speaker preview suppressed entirely when `timestampSource === 'none'`** (R1 H2 contract) — no line-index estimates, no misleading wrong-speaker clips. The plan's earlier "best-effort" approach was deleted.
- **Transcript-note JSON is always base64-encoded** (Gemini-r1 G5) — protects against transcripts containing literal `-->` from breaking the comment fence. Gzip path triggers above 32KB for large transcripts.
- **`read/writeTranscriptNote` are async** (Gemini-r2 G1) — browser-native gzip via `CompressionStream` is stream-only.
- **Single-source rule for `speakers_verified`** (R3 M3) — transcript-note is canonical; minutes inherit via `MinutesGenerationInput` → `MinutesJSON.metadata` → rendered frontmatter without mutation.
- **Skip-path is silent by design** — when the user explicitly clicks "Skip — labels look fine", the panel renders no banner (conscious choice, no need to explain). Banners only show for `detection-failed` / `detection-unavailable` / `failed`.

### Next Steps
- Plan v1 complete. v2 candidates (deferred per plan §12): real acoustic diarization (Deepgram/AssemblyAI), `generate-minutes-from-transcript` follow-up command + hydration adapter, voice profiles, TranscriptView workspace pane, editor-decoration speaker chips.

---

## 2026-04-03 — Newsletter scheduler debug logging

### Changes
- Added debug logging to newsletter auto-fetch scheduler in `src/main.ts`
- All early-return paths now log why the scheduler/fetch was skipped (disabled, missing URL, already fetching, interval not elapsed)
- Scheduler start logs interval, last fetch time, and script URL presence

### Files Affected
- `src/main.ts` — `startNewsletterScheduler()` and `runScheduledNewsletterFetch()` methods

### Decisions Made
- Uses existing `logger.debug('Newsletter', ...)` pattern — output suppressed unless debugMode is enabled

### Next Steps
- None — observability improvement only

---
