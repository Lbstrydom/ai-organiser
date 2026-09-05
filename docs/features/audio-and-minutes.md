# Audio, Transcription & Meeting Minutes

> Subsystem detail moved out of [AGENTS.md](../../AGENTS.md) so the canonical
> context file stays invariant-sized. AGENTS.md keeps the one-line stub and the
> load-bearing rules; the operational depth lives here.

Recording, transcription (Whisper and the opt-in Deepgram/Azure diarization lanes), speaker review, narration, and the meeting-minutes generator with its controller architecture.

---

## Audio Recording

**Status**: ✅ Implemented (January 2026)

In-plugin audio recording using MediaRecorder API. Works on desktop and mobile (iOS/Android).

**Core Components**:
- `src/services/audioRecordingService.ts`: MediaRecorder wrapper, mime negotiation (`audio/mp4` → `audio/webm;codecs=opus` → fallbacks), actual chunk size tracking via 1-second timeslice, 64kbps bitrate
- `src/ui/modals/AudioRecorderModal.ts`: Recording modal with states (idle → recording → stopped → saving → transcribing → done), platform-aware transcription, close safety

**Post-Transcription Cleanup** (`src/services/audioCleanupService.ts`):
- `offerPostTranscriptionCleanup(plugin, options)`: Shared utility for all audio transcription paths
- 3-option modal: keep original / replace with compressed / delete audio
- Respects `postRecordingStorage` policy (`'ask' | 'keep-original' | 'keep-compressed' | 'delete'`)
- Checks >10% savings threshold before offering compression
- Wired into: standalone summarize, multi-source summarize, multi-source translate, minutes transcription

**Integration Points**:
- Standalone `record-audio` command in Command Picker Capture category
- Minutes modal: Record button rendered OUTSIDE `!Platform.isMobile` gate
- Multi-Source modal: Record button in BOTH render paths via shared helper (survives rerenders)
- Settings: `autoTranscribeRecordings`, `embedAudioInNote` in Audio Transcription section
- Recordings saved to `AI-Organiser/Recordings/`

**Mobile Safeguards**: Feature detection, mime negotiation with fallback, actual size tracking (not estimate), direct `transcribeAudio()` (no FFmpeg), 64kbps bitrate (~52 min under 25MB), close safety (auto-save).

## Speaker-Aware Transcription UX

**Status**: ✅ Implemented (May 2026) — v1 closes Pat persona-test P0s + P1

### Overview

Audio-attach trio in Minutes modal, dedicated Transcribe-audio command, SpeakerReviewPanel with audio preview + rename + Same-as merge, deterministic action-attribution post-pass. Closes the three P0 findings + the P1 from persona-test session `pat-transcription-speakers`: Transcribe-as-a-verb is discoverable, attaching audio from any context works (including mobile webview file input), and action owners derive from "who actually said it" instead of LLM inference alone.

### Core Components

**Canonical transcript contract** (`src/services/transcriptTypes.ts`):
- `TimedTranscript` — Whisper `verbose_json` output with real timestamps + BCP-47 `languageCode`. Producer: `audioTranscriptionService.transcribeAudio*()`. Consumer: `labelSpeakersTimed()`.
- `LabelledTimedTranscript` — segments with `speaker?: string` per segment + `speakers[]` in first-appearance order.
- `timestampSource: 'whisper-verbose-json' | 'none'` — drives preview suppression. When `'none'`, downstream components hide audio preview entirely (R1 H2 contract).

**Speaker labelling** (`src/services/speakerLabellingService.ts`):
- `labelSpeakersTimed(plugin, timed, participants, meetingContext?)` — wraps the existing string-based LLM labeller in a TimedTranscript pipeline. Word-stream positional walker (`mapLabelledTextToSegments`) maps LLM-emitted `Name: text` lines back to Whisper segments.
- `transcriptionResultToTimedTranscript(result, fallbackLanguageCode)` — adapter from existing `TranscriptionResult` to the canonical contract. Prefers `result.language` (Whisper's `detected_language`) when present.

**Audio attach pipeline** (presentational + orchestration split per R1 M3):
- `src/ui/utils/AudioSourcePicker.ts` — three platform-aware adapters: `pickAudioFromDesktop()` (Electron `@electron/remote`), `pickAudioFromMobileWebview()` (programmatic `<input type="file" accept="audio/*">`), `pickAudioFromVault()` (FuzzySuggestModal filtered to audio). Returns unified `AudioSource` discriminated union (`vault | desktop-path | webview-blob | recorder`).
- `src/ui/coordinators/AudioAttachCoordinator.ts` — single orchestration owner: picker dispatch, `importToVault()` delegation, `attachPreview()` lifecycle. `dispose()` in `Modal.onClose()` revokes all object URLs.
- `src/ui/coordinators/AudioPreviewSource.ts` — `resolvePreview(source, app)` returns `AudioPreviewHandle { url, dispose }`. Vault → `app.vault.getResourcePath()`; desktop-path → `file://` URL; blob → `URL.createObjectURL` + idempotent `revokeObjectURL` on dispose.
- `src/services/audio/audioImportService.ts` — `importAudioToVault(app, source, opts)` writes non-vault audio sources to the vault (MIME whitelist, collision-safe suffix, AbortSignal → trash partial writes via `fileManager.trashFile`).
- `src/ui/components/AudioAttachHelper.ts` — strict presentational component. Renders trio + per-item rows per `AudioAttachViewState` discriminated union. All intents emit via callbacks.
- `src/ui/components/speakerReviewState.ts` — discriminated unions (`AudioAttachViewState`, `SpeakerReviewState`, `AudioAttachItem`, `DetectedSpeaker`) + pure derivations (`canGenerateMinutes`, `deriveSpeakerDetectionStatus`, `areSpeakersVerified`).

**Speaker review surface** (`src/ui/components/SpeakerReviewPanel.ts`):
- Renders one row per `DetectedSpeaker` with audio preview (5-second time-fragment URI from real Whisper `startMs`), rename input + participant datalist, Same-as merge dropdown.
- Preview suppressed when `timestampsAvailable === false` OR preview handle is null — explanatory subtext shown instead of misleading clips.
- Confirm validates every row has a name before firing `onConfirm(mapping)`; Skip fires immediately.
- Banners for `failed` / `detection-failed` / `detection-unavailable` states; user-skip is silent.

**TranscribeOnlyModal** (`src/ui/modals/TranscribeOnlyModal.ts`):
- Slim purpose-built modal: attach → transcribe → confirm speakers → save `.md` note with `type: transcript` frontmatter. Distinct from `MinutesCreationModal` because the user might want JUST a labelled transcript (no meeting metadata, no minutes generation).
- Composes (not duplicates) `AudioAttachCoordinator` + `AudioAttachHelper` + `labelSpeakersTimed` + `SpeakerReviewPanel` + `writeTranscriptNote`.
- Save gated on labelled transcript + terminal speaker-review state.

**Transcript-note format** (`src/services/transcriptNoteService.ts`):
- Zod-validated `TranscriptNoteFrontmatterSchema` (type / audio / language / duration_seconds / speakers / speakers_verified / speaker_detection_status / timestamp_source / created_at).
- Body: `## Transcript` heading + HTML-comment-fenced `enc=base64[+gzip]` payload + human-readable markdown rendering below.
- **Always base64-encoded** (Gemini-r1 G5 injection guard) so transcripts containing literal `-->` can't break the comment fence. Payloads >32KB use base64+gzip via `CompressionStream`.
- **Async** (Gemini-r2 G1) because browser-native gzip is stream-based async.

**Deterministic action attribution** (`src/services/speakerAttribution/`):
- `applyDeterministicAttribution(input, languageCode): Result<AttributionResult>` runs as a post-pass in `minutesService.generateMinutes` AFTER `parseMinutesResponse` returns.
- Phase 1: `provenanceBackfill.attemptBackfill(action, labelled)` — for actions missing `source_timecodes`, runs token-set Jaccard similarity over a sliding 3-segment window. Match ≥0.35 fills timecodes; below threshold drops confidence to 'low' + emits `missing-provenance` flag.
- Phase 2: `getStrategyForLanguage(code)` dispatches to per-language strategy. English (`'en'` / `'en-*'`) → three rules in priority order:
  1. Provenance + first-person → owner = `speakerMapping[segmentSpeaker]`
  2. Third-person → owner = captured proper noun (case-normalised to canonical participant spelling)
  3. LLM owner not in participants → rewritten to "TBC" + `non-participant-owner` flag
- All other languages route to `NoOpAttributionStrategy` which emits a single `unsupported-language` flag (visible warning, not silent skip).
- Adding a new language: implement `SpeakerAttributionStrategy` in a sibling file + add a case to `registry.ts`. No orchestrator changes.

### Wiring

- `MinutesCreationModal` instantiates `AudioAttachCoordinator` in `onOpen()` (target folder `AI-Organiser/Imports/`), disposes in `onClose()`. Renders helper + speaker review slot at top. After successful transcription: `transcriptionResultToTimedTranscript(result, result.language || setting || 'und')` → `runSpeakerLabelling()` → transitions `speakerReview` state. Submit button class `.ai-organiser-minutes-submit` gated via `canGenerateMinutes()` pure derivation.
- `MinutesGenerationInput` extended with optional `labelledTranscript`, `transcriptLanguageCode`, `speakerMapping`, `speakersVerified`, `speakerDetectionStatus`. `MinutesJSON.metadata` extended with `speakers_verified?` + `speaker_detection_status?` for renderer passthrough (Gemini G4).
- `TranscribeOnlyModal` registered via `src/commands/transcribeCommands.ts` → `ai-organiser:transcribe-audio` command + picker leaf in `create-write` sub-group (after `create-meeting-minutes`). Aliases on both leaves: `['transcribe', 'audio', 'speech-to-text', 'whisper', 'minutes']` so users typing the natural verb find either.
- `transcriptOutputFolder` setting (default `'Transcripts'`) + `getTranscriptOutputFullPath()` helper mirror the existing minutes-folder pattern.

### Key Patterns

- **Discriminated unions over boolean soup** (R1 M1): `AudioAttachViewState` + `SpeakerReviewState` replace `speakerMapping | speakersVerified | speakersTouched | lastTranscribedAudioUrl`. CTA enablement is a pure derivation, not a stored flag.
- **Presentational vs orchestration split** (R1 M3): `AudioAttachHelper` + `SpeakerReviewPanel` have NO service imports. Hosts wire callbacks. `AudioAttachCoordinator` owns picker dispatch + preview lifecycle.
- **Single-source rule for speaker metadata** (R3 M3): transcript-note frontmatter is canonical. Minutes inherit via `MinutesGenerationInput` → `MinutesJSON.metadata` → rendered frontmatter without mutation.
- **Real timestamps or no preview** (R1 H2): when `timestampSource === 'none'`, `SpeakerReviewPanel` suppresses audio preview controls entirely. No estimate fallback.
- **Graceful degradation everywhere**: missing `labelledTranscript` → attribution emits a warning, doesn't throw. Missing `source_timecodes` → backfill or `confidence='low'` flag, never aborts. Unsupported language → NoOp + flag, action owners preserved.

### Tests (155 added across F0-F5)

- `tests/audioImportService.test.ts` (11), `tests/audioAttachCoordinator.test.ts` (13), `tests/audioAttachHelper.test.ts` (16), `tests/audioSourcePicker.test.ts` (21), `tests/audioPreviewSource.test.ts` (12), `tests/filePickers.test.ts` (13), `tests/transcriptTypes.test.ts` (10), `tests/transcriptNoteService.test.ts` (9), `tests/speakerLabellingTimed.test.ts` (14), `tests/speakerReviewPanel.test.ts` (21), `tests/speakerAttributionProvenanceBackfill.test.ts` (6), `tests/speakerAttributionEnglishStrategy.test.ts` (12), `tests/speakerAttributionRegistry.test.ts` (12), `tests/documentControllerAddDocuments.test.ts` (4), `tests/documentMultiPickerModal.test.ts` (5), `tests/commandPicker.test.ts` extended

### Live verification

Persona-test session `pat-transcription-speakers-v3` against `AI-Organiser/Recordings/hamina-board-first-20min.mp3` (20-min Finnish board meeting). Full flow: picker → trio → vault pick → transcribe → SpeakerReviewPanel with 2 detected speakers + real Whisper-timestamp previews → Skip → save → transcript note opened in workspace with valid `TranscriptNoteFrontmatterSchema` frontmatter + base64+gzip body. Screenshots in `scripts/persona-harness/sessions/pat-transcription-speakers-v3/`.

**Plan**: [docs/completed/speaker-aware-transcription-ux.md](../completed/speaker-aware-transcription-ux.md) — 5 audit rounds (3 GPT + 2 Gemini), 32 findings accepted + fixed, severity decreased each round.

## Deepgram Nova-3 Acoustic Diarization (v2)

**Status**: ✅ Implemented (May 2026) — opt-in extension of v1 speaker-aware transcription. Whisper remains the universal default and the only mobile path.

### Overview

Opt-in acoustic speaker diarization via Deepgram Nova-3, gated twice (settings provider + per-session checkbox) and isolated behind a `DiarizationProvider` interface so v3 can swap in Speechmatics/AssemblyAI without touching modal code.

When the user attaches audio with "Identify speakers" checked, the coordinator bypasses Whisper + `labelSpeakersTimed()` entirely and POSTs the bytes to Deepgram's `/v1/listen?model=nova-3&diarize=true&utterances=true&detect_language=true&smart_format=true&punctuate=true&mip_opt_out=true`. Per-utterance speaker labels land directly in `LabelledTimedTranscript` and feed the existing `SpeakerReviewPanel` unchanged.

### Core Components

- `src/services/diarization/types.ts`: `DiarizationProvider` interface, `DiarizationOptions { signal?, languageHint?, timeoutMs?, filename?, mimeType? }`, `DiarizationResult { labelled, transcriptText, durationSec, detectedLanguage, provider, actualCostUsd }`, `DEEPGRAM_COST_PER_MIN_USD = 0.0043`, `DEEPGRAM_MAX_FILE_BYTES = 200 MB`, `DEEPGRAM_LARGE_FILE_WARN_BYTES = 100 MB`.
- `src/services/diarization/deepgramAdapter.ts`: `DeepgramAdapter implements DiarizationProvider`. Uses Obsidian `requestUrl` via the shared `abortableRequestUrl` wrapper. Cost computed deterministically from `metadata.duration` (Deepgram's response has no cost field). Seconds→ms conversion (`startMs = Math.round(utt.start * 1000)`). 1-indexed `Speaker N` labels for UX parity with Whisper+LLM path. Retry-on-429 with injectable `_sleeper?` and `_jitter?` test hooks (3 attempts max, base backoffs 1s/4s). Transport-rejection classification (`network-dns` / `network-tls` / `network-csp` / `network-offline` / `network-other:<msg>`). 5xx payload sanitization (truncated 200 chars, headers redacted).
- `src/ui/coordinators/AudioAttachCoordinator.ts`: extended with `setDiarizationOptIn(value)` / `shouldUseDiarization()` / `canTranscribeNow()` (single-file constraint when opt-in active — Deepgram speaker IDs are per-request) / `getUpfrontSourceSize(source)` (returns size hint from `File.size` / `Blob.size` / `TFile.stat.size`, null for webview-blob) / `estimateAudioCostUsd()` / `formatCostPreview()` / `transcribeDiarized(item, apiKey, signal?)`. Constructor accepts optional `provider?: DiarizationProvider` for DIP — production uses singleton `deepgramAdapter`, tests inject mocks.
- `src/ui/components/AudioAttachHelper.ts`: extended `AudioAttachOptions` with `diarizationToggle?: { visible, checked, disabled, costPreviewText, onChange }`. Pure presentational addition — host owns state.
- `src/ui/modals/DiarizationPrivacyModal.ts`: first-time-per-session disclosure with 3-state outcome (accept / reject / ESC-as-reject). On reject, leaves `plugin.diarizationDisclosureShownThisSession = false` so user can re-trigger by re-checking. Modal does NOT re-fire during the same toggle gesture (only on `unchecked → checked` transition).
- `src/services/transcriptNoteService.ts`: schema extended with optional `diarization_provider: 'deepgram'`, `diarization_cost_usd: number`, `diarization_language: string`. All absent → byte-identical to v1 Whisper notes.
- `src/services/apiKeyHelpers.ts`: `getDeepgramApiKey(plugin)` follows the SecretStorage 3-level pattern but **MUST pass `useMainKeyFallback: false`** — Deepgram has no main-LLM equivalent; without this flag `resolveApiKey` returns the user's Claude key and triggers `http-401`.

### Key Patterns

- **Whisper-stays-forever (user-facing promise)**: default `audioDiarisationProvider='none'` runs the unchanged v1 path. Checkbox hidden on `Platform.isMobile`. Per-session checkbox starts unchecked even when Deepgram configured. Multi-file attach disables Transcribe when opt-in active (single-file constraint via `canTranscribeNow()`). Mobile users keep Whisper indefinitely.
- **Diarization opt-in lives on the modal, not the coordinator**: `rerenderModal()` recreates the coordinator on every audio attach. Storing `diarizationOptedIn` only on the coordinator would silently wipe the user's choice. The modal keeps `private diarizationOptedIn = false` and re-applies it via `setDiarizationOptIn()` after every coordinator construction in `onOpen()`.
- **`useMainKeyFallback: false` is critical** for any specialist provider without a main-LLM analogue. Without it, `resolveApiKey` falls through to the user's main LLM key. Discovered during live persona testing.
- **Single-file constraint**: Deepgram's speaker IDs (0, 1, 2...) are scoped to a single API request. Multi-file batching would silently corrupt speaker identity across chunks. v2 enforces single-file at coordinator level; Whisper path unchanged.
- **Cost is computed, not provider-reported**: `actualCostUsd = (durationSec / 60) * DEEPGRAM_COST_PER_MIN_USD`. Null fallback only when `metadata.duration` missing; transcript-note frontmatter omits the field when null.
- **Sanitized fixture (no PII)**: `tests/fixtures/diarization/deepgram-sanitized-20min.json` preserves SHAPE only — utterance text replaced with `<utterance-N>` placeholders, speaker IDs / timings / confidence / languages preserved verbatim. Generated once via `scripts/spikes/sanitize-diarization-fixture.mjs`.
- **Honest abort semantics**: `abortableRequestUrl` stops the adapter from awaiting locally, but does NOT cancel the in-flight upload — Deepgram MAY still bill. Surfaces honestly via `'aborted'` / `'timeout'` error codes.

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `audioDiarisationProvider` | `'none'` | `'none'` (Whisper only) / `'deepgram'`. `'assemblyai'` stays in the enum but reverts via Notice (R4 M2). |
| `deepgramApiKey` | `''` | Transient plaintext field — migrated to SecretStorage on save via `persistApiKeysToSecretStorage()`. |
| `diarizationDisclosureShownThisSession` | `false` (plugin-instance field, not in settings) | Resets on plugin reload. Drives whether the privacy modal fires on opt-in. |
| `diarizationLargeFileWarningShownThisSession` | `false` (plugin-instance field) | Notice fires once per session above `DEEPGRAM_LARGE_FILE_WARN_BYTES` (100 MB). |

### i18n

New top-level namespace `t.diarization` with 13 keys (EN + ZH-CN parity verified by `npm run test:auto`). Cost-preview template uses `{cost}` substitution with pre-formatted formatter output — `~$X.XX` always 2 decimals with `~$0.01` floor.

### Commands

No new commands — opt-in via the existing `ai-organiser:create-meeting-minutes` (and `ai-organiser:transcribe-audio` from v1) modals.

### Tests

- `tests/diarization/deepgramAdapter.test.ts` (23 tests): happy path against sanitized fixture, all error codes (401/429/500/malformed/no-utterances/empty/aborted), retry policy with mocked sleeper (proves base backoffs `[1000, 4000]`), transport rejection classification, MIME override, JSON-path parsing.
- `tests/diarizationPrivacyModal.test.ts` (6 tests): accept/reject/ESC dispatch, double-fire guard, body mentions `mip_opt_out` literally.
- Live persona harness: `scripts/persona-harness/pat-diarization-v2-rerun.mjs` drives the end-to-end opt-in flow against `AI-Organiser/Recordings/hamina-board-first-20min.mp3` — verifies checkbox renders + privacy modal fires + opt-in survives `rerenderModal()` + Deepgram path routes + transcript-note frontmatter contains `diarization_provider: deepgram`, `diarization_cost_usd: 0.086`, `diarization_language: en`.

**Plan**: [docs/completed/deepgram-diarization-v2.md](../completed/deepgram-diarization-v2.md) — 4 GPT-5.4 audit rounds + 3 Gemini final-review rounds, 43 findings, all fixed before implementation. Two additional bugs caught + fixed during live persona testing (rerender state-wipe + useMainKeyFallback default).

## Read-this-note LLM Enhancement (audioNarration extension)

**Status**: ✅ Implemented (May 2026) — opt-in pre-stage of `prepareNarration` that summarises mermaid diagrams + large tables + expands acronyms before TTS. Default off; zero behaviour change for existing users.

### Architecture

Strictly additive to the existing `src/services/audioNarration/` module. The LLM pre-stage feeds CLEANED MARKDOWN into the existing deterministic `transformToSpokenProse` transformer — does NOT replace it. The transformer is still the single source of truth for sentence/section boundaries and TTS chunking.

> **Spoken-content modes (wired 2026-06-07)**: `transformToSpokenProse` accepts `codeBlockMode`/`tableMode`/`imageMode`. These are now threaded from settings via `proseOptionsFromSettings(plugin)` at BOTH call sites (`prepareNarration` + the LLM-enhanced path) and exposed as Code blocks / Tables / Images dropdowns in `AudioNarrationSettingsSection`. Defaults equal `DEFAULT_PROSE_OPTIONS` (`placeholder`/`row-prose`/`alt-text`), so a user who never changes them gets byte-identical spokenText and an unchanged narration fingerprint. (Previously the settings existed but were never read — dead config.)

Two-stage flow (R1 H2 fix — no billing before consent):
```
narrate-note command
  → prepareNarration(plugin, file)          [pure; NO LLM call, NO key in PreparedNarration]
      → vault.read(file) → rawMarkdown
      → transformToSpokenProse(raw) → spokenText for TTS-cost estimate
      → if mode='on' AND hasLlmEnhancementKey(): set llmIntent + estimateLlmEnhancementCostUsd
      → fingerprint MODE-BRANCHED:
          off-mode → sha256([file.path, spokenText, voice, modelId, PREPROCESSOR_VERSION=1])  ← BYTE-IDENTICAL v1
          on-mode  → sha256([file.path, mtime, voice, modelId, llmIntent.providerId, ..., 'llm-on'])
  → CostConfirmModal — extra rows shown only when llmIntent set:
      • AI cost line ($ amount)
      • Variance hint ("Final TTS cost may vary ±15%")
      • Privacy hint ("Your note will be sent to <provider>")
  → user confirms → executeNarration(plugin, prepared, { signal, onProgress })
      → TOCTOU mtime re-check → STALE_PREPARED if file changed during modal
      → if prepared.llmIntent AND settings still match (R3 H2):
          resolveLlmEnhancementApiKey(plugin, providerId) → apiKey
          enhanceMarkdown(rawNote, provider, apiKey, {onChunkComplete}, signal)
            → splitByH2 (fence-aware: skips ## inside code/mermaid/frontmatter/callouts)
            → 4-parallel via mapWithConcurrency(signal-aware)
            → per-chunk retryWithBackoff on 429/503 (1s/4s ±25% jitter + Retry-After honour)
            → graceful: failed chunk → original markdown pass-through + warning
            → total failure → Result.err → caller falls back to literal
          → hard cap: enhancedSpokenText.length > rawNote.length * 1.2 → reject, warn
          → spokenText = transformToSpokenProse(enhancedMarkdown)
      → TTS synth + MP3 write + syncEmbed (unchanged from v1)
      → return NarrateOutcome { ..., warnings: NarrationWarning[] }
  → command renders one Notice per warning code via t.audioNarration.enhancement.warnings[code]
```

### Core Components

- `src/services/audioNarration/llmEnhancerPrompts.ts`: XML-structured prompt (`<task>`, `<requirements>`, `<output_format>`); `LLM_ENHANCEMENT_PROMPT_VERSION` salts on-mode fingerprint; `neutraliseEnvelopeMarkers` (audit-code M8) zero-width-spaces user-supplied envelope tags to prevent prompt injection.
- `src/services/audioNarration/llmEnhancerProvider.ts`: `LlmEnhancementProvider` interface + Gemini Flash + Claude Haiku impls. All HTTP via `abortableRequestUrl`. Discriminated `EnhancerCallOutcome` (not `Result<T>`) carries per-call metadata — safe for concurrent invocation (Gemini G2-H1 race fix). Gemini uses `gemini-flash-latest` URL alias + `x-goog-api-key` HEADER (audit-code H10 — not URL query). Haiku resolves newest via `/v1/models` query, cached per-account (audit-code M15).
- `src/services/audioNarration/llmMarkdownEnhancer.ts`: `splitByH2` fence-aware splitter (skips `## ` inside code/mermaid/frontmatter/callouts). `enhanceMarkdown` orchestrates 4-parallel chunks with signal-aware worker pool (audit-code H7 — drops queued chunks on abort), `retryWithBackoff` shared from `tts/ttsRetry`, `onChunkComplete` throw-guard (audit-code M16), graceful per-chunk fallback.
- `src/services/audioNarration/audioNarrationService.ts`: `prepareNarration` extended to estimate LLM cost without calling the LLM and snapshot `llmIntent` (provider + sentinel, NOT key). `executeNarration` runs the LLM AFTER cost confirmation with TOCTOU mtime check, settings-race intent validation, hard cap on enhanced length.
- `src/services/apiKeyHelpers.ts`: `hasLlmEnhancementKey` (boolean, no key exposure) + `resolveLlmEnhancementApiKey` (primitive `string | null`, no audioNarration types imported — avoids upward layering violation per Gemini G2-M2). Both pass `useMainKeyFallback: false` (Deepgram v2 lesson). Optional `llmEnhancerReuseYoutubeKey` toggle reuses the full `getYouTubeGeminiApiKey` chain (Gemini G2-M1).
- `src/services/audioNarration/narrationCostEstimator.ts`: `estimateLlmEnhancementCostUsd(noteChars, provider)` — deterministic char-based math; no LLM call.

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `audioNarrationLlmEnhancement` | `'off'` | Master toggle. Off = zero behaviour change. |
| `audioNarrationLlmProvider` | `'gemini'` | `'gemini'` (Gemini Flash, ~$0.01/long-note) or `'haiku'` (~$0.10). |
| `llmEnhancerGeminiApiKey` | `''` | Transient; migrated to SecretStorage on save. |
| `llmEnhancerAnthropicApiKey` | `''` | Transient; migrated to SecretStorage on save. |
| `llmEnhancerReuseYoutubeKey` | `false` | Opt-in fallback to YouTube Gemini key when no dedicated key set. |

### Fingerprint discipline

`PREPROCESSOR_VERSION` stays at 1 (never bumped in this plan) — preserves all existing literal-mode caches. `LLM_ENHANCEMENT_PROMPT_VERSION` lives separately and salts only the on-mode fingerprint. Mode-branched inputs guarantee off-mode users get byte-identical hashes to v1.

### Tests

- `tests/audioNarration/llmMarkdownEnhancer.test.ts` (17 tests): fence-aware split, concurrency cap, partial/total failure, abort pre-check + mid-run abort, onChunkComplete throw-guard.
- `tests/audioNarration/llmEnhancerProvider.test.ts` (12 tests): Gemini (URL alias + x-goog-api-key header + cost from usage), Haiku (`/v1/models` discovery + cache + cost).
- `tests/audioNarration/llmEnhancerPrompts.test.ts` (6 tests): XML envelope, prompt-injection escape variants, escapeXml.
- `tests/fixtures/llmEnhancer/input-mermaid-heavy.md`: real-shape fixture with H1 + 2 H2s + mermaid + table + frontmatter + callout.

### Key Patterns

- **Default off; explicit opt-in**: zero behaviour change for existing users. Per Whisper-stays-forever rule.
- **LLM call AFTER consent, NEVER in prepare** (R1 H2): cost-confirmation modal shows the estimate; LLM runs only if the user clicks Generate.
- **Provider identity in `PreparedNarration`, key in `executeNarration` only** (R2 M1): `llmIntent` carries `{ providerId, modelSentinel }` only; key resolution happens at execute time.
- **Mode-branched fingerprint** (R2 H2 + Gemini G-M1): off-mode tuple is byte-identical to v1; on-mode uses distinct `'llm-on'` domain.
- **Hard cap on enhanced output** (R3 H4 + Gemini G-H1): `enhanced.length > rawNote.length * 1.2` (4 KB floor) — prevents prompt-injection cost blowout. Compare to RAW markdown length, NOT stripped spokenText (which collapses diagrams to "[diagram omitted]" — would yield false-positive rejection).
- **`useMainKeyFallback: false` always** (Deepgram v2 lesson): Gemini/Haiku enhancer keys never silently use the user's main LLM key.
- **`abortableRequestUrl` for ALL outbound HTTP** (audit-code H8/H12): cancellable, consistent.
- **`x-goog-api-key` header for Gemini** (audit-code H10): never in URL query (leaks to logs).
- **Per-account Haiku model cache** (audit-code M15): keyed by `apiKey.slice(0, 16)` so multi-account users don't cross-contaminate.
- **Prompt-injection escape** (audit-code M8): user notes containing `</note_section>` or other envelope tags get zero-width-space-separated to prevent them closing the prompt envelope early.
- **Signal-aware worker pool** (audit-code H7): workers re-check `signal.aborted` before picking up each chunk; queued work drops on abort.

**Plan**: [docs/completed/read-this-note-llm-enhancement.md](../completed/read-this-note-llm-enhancement.md) — 3 GPT-5.4 audit rounds + 2 Gemini final-review rounds (27 plan findings) + 1 audit-code round (7 in-scope post-impl fixes), all addressed.

## Meeting Minutes Generation

**Status**: ✅ Implemented (January 2026)

### Overview

Generate structured meeting minutes from transcripts with persona-based output styles, GTD action classification overlay, terminology dictionaries for transcription accuracy, and context document support.

### Personas (2 built-in)

| ID | Name | Icon | Description |
|----|------|------|-------------|
| `standard` | Standard | `file-text` | Concise, action-oriented minutes (default) |
| `governance` | Governance | `landmark` | Formal governance minutes with resolutions and fiduciary matters |

Personas stored in `AI-Organiser/Config/minutes-personas.md`. Users can add custom personas following the same `### Name [icon: icon-name]` format.

### GTD Overlay

Optional GTD (Getting Things Done) action classification. When enabled (`minutesGTDOverlay` setting or per-session toggle in modal):
- **Next Actions**: Classified by context (`@office`, `@home`, `@call`, `@computer`, `@agenda`, `@errand`) with energy tags (`low`/`high` — `medium` omitted)
- **Waiting For**: Items with `waiting_on` person and optional `chase_date`
- **Projects**: Multi-step commitments (names only)
- **Someday/Maybe**: Ideas not yet committed to

GTD schema injected conditionally via `getStyleSystemPrompt({ useGTD: true })`. Chunk extraction excluded from GTD.

**GTD interfaces** in `minutesPrompts.ts`: `GTDAction`, `GTDWaitingItem`, `GTDProcessing`, `MinutesJSON.gtd_processing?`

**GTD rendering** in `minutesUtils.ts`: `renderMinutesFromJson(json, style, obsidianTasksFormat?)` — context keys sorted alphabetically, `- [ ]` checkboxes when obsidianTasksFormat is true.

### Core Components

**Minutes Service** (`src/services/minutesService.ts`):
- `generateMinutes()`: Main generation function with transcript chunking
- `MinutesGenerationInput` includes `useGTD?: boolean`
- Supports long transcripts via 5000-token chunked processing
- Context chaining between chunks for coherent output
- Passes `ChunkExtractionContext` (chunkIndex, totalChunks, participants) to chunk extraction prompts
- Passes `IntermediateMergeContext` (chunkCount, participants) to intermediate merge prompts
- Accepts `dictionaryContent` and `contextDocuments` for enhanced accuracy

**Dictionary Service** (`src/services/dictionaryService.ts`):
- CRUD operations for terminology dictionaries stored as markdown
- `addEntries()`: Merge with case-insensitive deduplication
- `formatForPrompt()`: Format dictionary as XML for LLM injection
- `buildExtractionPrompt()`: Extract terms from context documents
- Storage: `AI-Organiser/Config/dictionaries/` (syncs across devices)
- Entry categories: person, acronym, term, project, organization

**Minutes Prompts** (`src/services/prompts/minutesPrompts.ts`):
- `getStyleSystemPrompt(options: MinutesStylePromptOptions)`: Style-specific system prompt with `{ style, outputLanguage, personaInstructions, useGTD? }`
- `buildChunkExtractionPrompt(context: ChunkExtractionContext)`: Chunk-aware extraction with participant list and position label
- `buildIntermediateMergePrompt(context: IntermediateMergeContext)`: Merge prompt with `deferred_items` for irreconcilable conflicts
- `buildStyleConsolidationPrompt(options)`: Style-aware consolidation for chunked processing
- Conditional GTD schema injection and self-check item #9
- Dictionary injection for name/term consistency

**Minutes DOCX Export** (`src/services/export/minutesDocxGenerator.ts`):
- `generateMinutesDocx(json)`: Generates Word document from `MinutesJSON` using `docx` library
- `extractMinutesJsonFromNote(content)`: Parses `<!-- minutes-json: ... -->` HTML comment from note
- Structured sections: header, metadata table, agenda, discussion items, action items, decisions, GTD
- Desktop: system Save dialog via Electron; Mobile: vault file fallback

**Minutes Modal** (`src/ui/modals/MinutesCreationModal.ts`):
- Meeting input form: title, date, time, participants, agenda, transcript
- Context Documents section: attach agendas, presentations, spreadsheets
- Dictionary section: select, create, edit, or extract terminology
- Audio Transcription section: transcribe embedded audio files
- UX flow: Documents → Dictionary → Audio (dependency-first ordering)
- Persona selector, GTD toggle, dual output toggle, Obsidian Tasks toggle

**Minutes Settings** (`src/ui/settings/MinutesSettingsSection.ts`):
- Output folder, default timezone, default persona, Obsidian Tasks format, GTD overlay default

**Text Chunker** (`src/utils/textChunker.ts`):
- `chunkText()`: Split long transcripts by token count with sentence boundaries
- `chunkPlainTextAsync()`: Paragraph → sentence → word boundary lookback splitting (no mid-word cuts)

### Key Patterns

- **Transcript Chunking**: Long meetings split into manageable chunks
- **Context Chaining**: Each chunk receives previous summary for continuity
- **Persona System**: 2 built-in personas (`standard`, `governance`) + custom via config file
- **GTD Overlay**: Optional action classification by GTD context, renders as separate sections
- **Obsidian Tasks + GTD**: When both enabled, GTD next-actions render as `- [ ]` checkboxes
- **Options Object Pattern**: `MinutesSystemPromptOptions` for extensible prompt configuration
- **Dictionary-First Workflow**: Extract terms from documents before transcription
- **Cross-Meeting Reuse**: Same dictionary works across multiple meetings
- **Document Truncation**: Inline controls for oversized documents with configurable settings

## Controller Architecture (MinutesCreationModal)

**Status**: Implemented (January 2026)

The MinutesCreationModal uses a controller-based architecture to separate concerns and improve testability.

### Controllers

**Location**: `src/ui/controllers/`

| Controller | Responsibility | Tests |
|------------|----------------|-------|
| `DocumentHandlingController` | Document detection, extraction, caching, truncation | 23 |
| `DictionaryController` | Dictionary CRUD, term extraction, merging | 56 |
| `AudioController` | Audio detection and transcription state | 35 |

**Shared Components**: `src/ui/components/TruncationControls.ts` (8 tests)

### Controller Lifecycle

Controllers instantiated per modal open for fresh state:

```typescript
onOpen() {
    this.docController = new DocumentHandlingController(app, plugin, documentService, embeddedDetector);
    this.dictController = new DictionaryController(dictionaryService);
    this.audioController = new AudioController(app); // App only (ISP)
}
```

### No-Stubs Policy

**Critical**: All new code must follow the no-stubs policy:

- **No placeholder methods**: If a method isn't used by modal or tests, remove it
- **Public methods must have call sites**: Modal, other UI, or tests
- **Private helpers allowed**: If used by public methods
- **Errors returned, not thrown**: Use `errors: string[]` on result objects

### Key Patterns

- **Immutable external interface**: All getters return shallow copies
- **ID-based tracking**: File paths for vault items, normalized URLs for external
- **Result objects**: `DocumentHandlingResult`, `DictionaryResult<T>`, `AudioResult<T>` with `errors: string[]`
- **Callback-based UI**: TruncationControls uses callbacks (IoC), no modal dependencies
- **Type-safe translations**: `TruncationTranslations` interface

### Testing

**Service Tests**:
- `tests/minutesService.test.ts` (23 tests): Chunked/non-chunked generation, language fallback
- `tests/ragService.test.ts` (19 tests): Context retrieval, RAG prompt building

**Export Tests**:
- `tests/minutesDocxGenerator.test.ts` (14 tests): DOCX generation, JSON extraction, section structure

**Controller Tests**:
- `tests/documentHandlingController.test.ts` (23 tests)
- `tests/dictionaryController.test.ts` (56 tests)
- `tests/audioController.test.ts` (35 tests)
- `tests/components/truncationControls.test.ts` (8 tests)

**Prompt Tests**:
- `tests/promptInvariants.test.ts` (56 tests): Invariant tests for 8 prompt modules
- `tests/minutesPrompts.test.ts` (102 tests): Prompt generation, chunk extraction, intermediate merge, consolidation, style extraction, context extraction

**Utility Tests**:
- `tests/responseParser.test.ts` (40 tests): 4-tier JSON extraction, sanitization
- `tests/textChunker.test.ts` (35 tests): Transcript chunking, overlap handling, sentence-boundary splitting
- `tests/sourceDetection.test.ts` (58 tests): URL/YouTube/PDF/audio detection
- `tests/frontmatterUtils.test.ts` (45 tests): Summary hooks, word counting, language detection
- `tests/dashboardService.test.ts` (23 tests): Filter injection, folder paths
- `tests/vectorMath.test.ts` (5 tests): Cosine similarity

**GTD & Migration Tests**:
- `tests/minutesGTDRendering.test.ts` (11 tests): GTD rendering, context sorting, checkbox integration
- `tests/settingsMigration.test.ts` (14 tests): `migrateOldSettings()` pure function coverage

**Digitisation Tests**:
- `tests/multimodal.test.ts`: Capability gating, adapter formatting, token handling
- `tests/imageProcessor.test.ts`: Resize, format conversion, MIME validation
- `tests/digitisePrompts.test.ts`: Prompt invariants for all digitise modes
- `tests/strokeManager.test.ts` (185 tests): Add/undo/redo/erase/clear stroke operations
- `tests/sketchExport.test.ts` (49 tests): Canvas mock → blob → vault file
- `tests/mediaCompression.test.ts` (143 lines): Compression offer logic, vault replacement

- `tests/streamingSynthesis.test.ts` (76 tests): P2 fixes, adapter streaming, orchestrator streaming, Siliconflow
- `tests/llmFacadeStream.test.ts` (6 tests): Streaming facade fallback (incl. abort guard)
- `tests/claudeAdapterThinking.test.ts` (31 tests): Adaptive thinking params, response parsing, streaming chunks
- `tests/claudeWebSearchAdapter.test.ts` (60 tests): Adapter unit tests (parseResponse, domain filtering, academic, perspective, multi-turn)
- `tests/claudeWebSearchIntegration.test.ts` (22 tests): Orchestrator integration tests (pipeline, pause_turn, metadata, budget)
- `tests/claudeWebSearchStreaming.test.ts` (56 tests): Streaming tests (SSE, citations_delta, mode-switch abort, multi-turn stream)

- `tests/embedScanService.test.ts` (70 tests): normalizeEmbedPath, classifyExtension, formatFileSize, getEmbedTypeIcon, hasEmbedTypeExtension, isExternalUrl, extractReferencesFromLine, EMBED_TYPE_EXTENSIONS
- `tests/mermaidChangeDetector.test.ts` (24 tests): Snapshot capture, staleness check, snooze, Jaccard similarity
- `tests/mermaidContextService.test.ts` (15 tests): Budget constants, sibling diagrams, context gathering
- `tests/mermaidTemplateService.test.ts` (20 tests): Fallback templates, template file parsing, load/save
- `tests/mermaidExportService.test.ts` (15 tests): .mermaid file, SVG, PNG, canvas export, appendToCanvas

- `tests/quickPeekService.test.ts` (9 tests): Pipeline, provider resolution, abort, fallback excerpt

Total: 3375 unit tests (136 suites) + 39 automated integration tests
