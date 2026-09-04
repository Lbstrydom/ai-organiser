# Azure Providers & LLM Plumbing

> Subsystem detail moved out of [AGENTS.md](../../AGENTS.md) so the canonical
> context file stays invariant-sized. AGENTS.md keeps the one-line stub and the
> load-bearing rules; the operational depth lives here.

Everything between a command and a provider HTTP call: the two Azure AI Foundry surfaces, the audio adapters, request pacing under Azure's RPM cap, the fail-closed provider profile, and Anthropic prompt caching.

---

## Azure AI Foundry Providers

**Status**: ✅ Implemented (June 2026) — config-gated, default off

Two first-class providers for Azure AI Foundry, which exposes two surfaces under one resource + one API key (`azure-ai-foundry-key`):
- **`azure-claude`** — Claude via `/anthropic/v1/messages`, `Authorization: Bearer` + `anthropic-version: 2023-06-01`. Native Anthropic request/response (mirrors `ClaudeAdapter`).
- **`azure-openai`** — GPT chat + embeddings + Whisper via `/openai/v1/*` (model-based, model in body, no api-version) or `/openai/deployments/<dep>/...?api-version=` (deployment-based); `api-key` header. Mirrors `OpenAIAdapter`.

### Core components
- `src/services/adapters/azureClaudeAdapter.ts` / `azureOpenAIAdapter.ts` — thin variants of the public `claude`/`openai` adapters (auth header + endpoint + concrete default model differ; everything else identical). **Concrete default models, never `latest-*` sentinels** (Azure deployments lag; sentinel resolution is structurally absent on the Azure path).
- `src/services/azure/endpointResolver.ts` — single source of all Azure URLs (`getClaudeMessagesEndpoint`/`getOpenAIChatEndpoint`/`getOpenAIEmbeddingsEndpoint`/`getWhisperEndpoint`/`normalizeEndpointUrl`) + `isAzureMode(settings)` (= `cloudServiceType.startsWith('azure')`).
- `src/core/modelCatalog.ts` (+ `src/core/taskTypes.ts`) — model capabilities/defaults/aliases SSOT; embedding cross-dimension aliasing forbidden (would invalidate vector indexes).
- `src/services/azure/settingsValidator.ts` — pre-flight config validation (host-anchored `*.services.ai.azure.com` / `*.openai.azure.com`, https-only, deployment-name charset).
- `src/services/azure/azureConnectionTest.ts` — **live** connection test: real round-trips to all four surfaces (Claude / OpenAI chat / embeddings / Whisper-via-tiny-silent-WAV), per-surface `{ok, status, message}` with REDACTED messages (never echoes endpoint/key/headers).
- `src/services/azure/requestLimiter.ts` — `SimpleSemaphore` concurrency cap.

#### Routing modes + api-version (2026-08-12)
`azureRoutingMode` picks the surface, and BOTH must keep working — a resource or APIM front-end exposing only the standard deployment-qualified API 404s on the v1 paths, and vice versa:
- **model-based** (default) → `/openai/v1/chat/completions` · `/openai/v1/embeddings`, deployment in the body `model`, **no api-version** (the undated `preview` sentinel belongs to this surface and we omit the parameter entirely).
- **deployment-based** → `/openai/deployments/<dep>/{chat/completions,embeddings}?api-version=<dated>`, deployment in the PATH. Default `2025-03-01-preview` (matches upstream claude-engineering-skills `DEPLOYMENT_API_VERSION_DEFAULT`); pin per-operation via `azureApiVersionOverride.chat` / `.embeddings` (embeddings falls back to `chat`, so an existing single pin still works). Whisper keeps its own `2024-10-21` — separate operation, separate cadence.
- **The deployment is route state, not body state.** Anything selecting a different deployment MUST rebuild the URL (`azureTriageRouting` does); varying only the body `model` silently hits the deployment the URL already names. `blockOverride` drops `modelOverride` for `azure-openai` in both modes for this reason.
- **Never hardcode an operation path in an adapter.** The full URL is `config.endpoint` from the resolver; `AzureOpenAIAdapter.requestFormat.url` is bound to it (it once carried a stale `/openai/v1/responses` that the code never emitted).
- **APIM front-ends carry a BASE PATH.** `normalizeEndpointUrl` PRESERVES a path prefix (e.g. `https://<apim>.azure-api.net/foundry`) and every builder concatenates onto it — dropping it silently pointed every request at the APIM root. It still rejects an endpoint containing `/openai` or `/anthropic` (a pasted operation URL would yield `…/openai/v1/openai/v1/chat/completions`) and rejects a query/fragment (would corrupt the appended `?api-version=`). `settingsValidator` accepts `*.azure-api.net` alongside the direct-resource suffixes, host-anchored.
- **Test the EMITTED url, not the constructed config** — `tests/azureEmittedUrl.test.ts` injects a fake transport and asserts full string equality on what `requestUrl` is actually handed. Substring/`toContain` assertions on a resolver stay green while the transport gets a different URL; that is exactly how the upstream bug survived its whole life.

### Azure mode (auto-routing, no silent fallback)
`isAzureMode` (main provider is `azure-*`) auto-routes specialist services to the right Azure surface — both surfaces share one resource+key:
- **Audio → Azure Whisper**, **embeddings → Azure OpenAI**, **PDF → Azure Claude** (documents). **No silent fallback**: in Azure mode a missing/invalid Azure surface surfaces a clear error, never quietly borrows the user's personal key. **YouTube** genuinely needs a separate Gemini key (Azure has no path) — shown explicitly, not a fallback.
- Settings UI streamlines in Azure-first mode: provider choice lives in the Azure section; the generic provider config (endpoint/key/model/test) is suppressed (`displayCloudSettings` early-returns on `isAzureMode`); Specialist Providers show "handled by Azure". A "use a different provider" escape hatch reveals the full provider dropdown to switch (a switch, NOT a fallback).

#### Flexible per-capability Azure routing (azure-capability-flexibility, 2026-06-07)
Azure specialist routing is **config-driven, not hardcoded** — any user's Foundry (full / partial / no coverage) is handled, nothing fails silently. SSOT registry `src/services/azure/azureCapabilities.ts` declares the 5 specialist capabilities (transcription, embeddings, websearch, tts, youtube) with support level (full/partial/none), surface, BYO providers, and feature gates. Each is configured **3-state** per capability via `settings.azureCapabilities[id] = {mode: 'azure'|'byo'|'off', deployment?}` (the map is consulted ONLY in Azure mode; non-Azure byte-identical):
- **Resolution**: `resolveAzureCapability.ts` is the single decision owner — fail-closed off-Azure, **never-throws** (wraps the SSOT endpoint builders), `isByoConfigured` uses LOW-LEVEL SecretStorage/settings primitives (NOT the resolver-aware key helpers → no recursion), reason on the caller's stack (no shared-state race). Wired at each capability's existing resolution entry (`getAudioTranscriptionApiKey`, `getClaudeWebSearchKey`, `getYouTubeGeminiApiKey`, narration `prepareNarration`, newsletter podcast). `getAzureApiKey` extracted to `azure/azureKey.ts` to break the apiKeyHelpers↔resolver module cycle.
- **TTS now HAS an Azure path**: `azureSpeechTtsEngine.ts` (Azure OpenAI Speech, PCM via `getSpeechEndpoint` SSOT, `abortableRequestUrl`) — registered as the `internalOnly` `azure-openai` narration provider (not shown in the non-azure dropdown). Narration + newsletter podcast select it when `tts` capability = azure; byo → Gemini; off/unavailable → clear notice. (For a Foundry with no speech deployment, `mode:'azure'` → `unavailable('no-deployment')`.)
- **Web search works for azure-openai-main too** (Foundry Claude surface + a configured Claude deployment), gated on the websearch capability `mode==='azure'` (`researchSearchService` only hands the Claude adapter the azure base when `wsAzure`).
- **UI**: `AzureCapabilitiesSettingsSection` renders the per-capability rows (Use Azure deployment / Bring your own / Off) under AI provider → Azure capabilities, with a ✓/⚠/✗ situation line; BYO shows a configured/not-set status (no key field — keys live in the existing specialist sections).
- **Migration** (`migrateOldSettings`, sync, no secret reads): seeds `azureCapabilities` from observable specialist settings to PRESERVE each capability's prior reachable behaviour — azure-claude users keep transcription/embeddings/websearch on Azure; an azure-openai user on Tavily/non-OpenAI-embeddings keeps BYO (never force-converted to a blank Azure deployment).
- **Deferred follow-ups**: Azure connection-test tts/websearch probes, TTS request-pacer integration, `resolveEndpoint` azure-claude SSOT routing, research fallback-on-throw.
- **Plan**: [docs/completed/azure-capability-flexibility.md](../completed/azure-capability-flexibility.md).

### Key patterns
- **`getAzureApiKey(plugin, provider)`** — `useMainKeyFallback: false` always (no personal-key borrow). `azure-openai` falls back to the shared Foundry key via two sequential lookups.
- **`blockOverride = adapterType === 'azure-openai'`** in `cloudService` drops `modelOverride` on the deployment-routed URL.
- **Capability detection**: the resolved canonical model id flows as `modelName` (so `modelCapabilities`/`tokenLimits` regexes match); the deployment name never escapes the adapter.
- **Hygiene**: `PROVIDER_ENDPOINT` Azure entries `''`; no corporate endpoints/keys in defaults; redacted logs. `docs/plans/sync/azure-providers.md` (+ audit summary) are gitignored.

### Tests
`tests/azureClaudeAdapter.test.ts`, `tests/azureOpenAIAdapter.test.ts`, `tests/endpointResolver.test.ts`, `tests/modelCatalog.test.ts`, `tests/requestLimiter.test.ts`, `tests/openaiEmbeddingService.test.ts`, `tests/azureMode.test.ts` (isAzureMode, no-fallback, connection-test redaction).

## Azure Audio Adapters (Azure AI Speech in-region + gpt-audio private)

**Status**: ✅ Implemented (June 2026) — Clusters A–D via `/cycle --autonomous`, per-cluster GPT fix-gates + consolidated Gemini gate (R1 CONCERNS → **R2 APPROVE**). Plan archived (gitignored): `docs/completed/azure-audio-adapters.md`.

First-class **text-to-speech** and **speaker-diarizing speech-to-text** for BOTH audiences: **Azure AI Speech** (regional → in-region processing — the Wärtsilä-compliant path) and **gpt-audio** (OpenAI-direct, Global-Standard — private/BYO ONLY). The governance pivot (D1): Azure OpenAI audio (Whisper, `/audio/speech`, gpt-audio) is Global-Standard, so the in-region boundary is modelled as a **new `AzureSurface` `'azure-speech'`** — different host (`{region}.tts.speech.microsoft.com` / `<resource>.cognitiveservices.azure.com`), auth (`Ocp-Apim-Subscription-Key`), and body shapes (SSML / multipart).

### Core components
- `src/services/azure/audioProviderPolicy.ts` — **`assertAllowed(plugin,{op,providerId,resolvedSurface?})`**, the SINGLE call-time compliance guard (D5/D8) consulted by narration, engine factories, transcription key resolution, and coordinator diarization selection. Matrix: non-Azure → azure surfaces refused; Azure + `azureSpeechRequired` STRICT → azure-speech ONLY (Whisper//audio/speech/gpt-audio/BYO all refused fail-closed); Azure strict-OFF → legacy + BYO stay reachable EXCEPT `openai-gpt-audio` (never in Azure mode). Unknown provider ids + provider/op mismatches (e.g. deepgram TTS) fail CLOSED.
- `src/services/azure/azureSpeechCredential.ts` — `resolveAzureSpeechCredential` (dedicated `PLUGIN_SECRET_IDS.AZURE_SPEECH` secret → shared Foundry key, NEVER a personal key) + per-op readiness (TTS = region+key; Fast Transcription = explicit custom-domain endpoint+key — no prefix derivation, D10).
- `endpointResolver.ts` — Speech builders return typed `Result` and are host-anchored (R2-M2): `getSpeechFastTranscriptionEndpoint` (`.cognitiveservices.azure.com` + `:transcribe?api-version=2025-10-15`), `getSpeechRealtimeTtsEndpoint`/`getSpeechVoicesListEndpoint` (regional TTS host, charset-validated region).
- `resolveAzureCapability` — strict-aware audio branch: strict ON → speech-only with typed reasons (`no-region`/`no-voice`/`no-key`/`no-endpoint`); strict OFF + mode azure → speech once configured, else legacy azure-openai (UI discloses Global-Standard); explicit BYO respected when strict OFF.
- `src/services/diarization/azureSpeechDiarizationAdapter.ts` — second `DiarizationProvider` (D2): Fast Transcription transcribes-and-diarizes in ONE call. **Seam change (H3): `transcribeWithDiarization(app,bytes,opts)` — the positional `apiKey` is GONE; each provider resolves its own creds** (Deepgram → `createDeepgramProvider(plugin)`). **Typed cost (M6)**: `cost {kind:'actual'|'estimated'|'unknown', usd?, basis?}` (Deepgram actual, Azure unknown). Multipart gotcha (§A, live-verified): the `definition` part MUST be inline `application/json` (a file-shaped part is silently ignored → no diarization). v1 is single-call, 200 MB shared cap (G4 — chunked Azure diarization deferred §8).
- `audioTranscriptionService.ts` — shared `fastTranscribeRequest` (paced via `buildAzureSpeechKey` resource buckets, Azure-aware 429 backoff, abortable) + plain `azure-speech` STT + **gpt-audio bounded STT** (G1/G2: wav/mp3 only, ~5-min caps — Chat Completions bills audio against the context window; ineligible clips fall back to Whisper with the SAME OpenAI key, warning carried, never silent) + `PROVIDER_PRODUCES_TIMESTAMPS` (R2-M4 — gpt-audio false → speaker preview/attribution degrade via `timestampSource:'none'`) + `normalizeSpeechLocale` (short code → BCP-47, §2e).
- `src/services/tts/` — `ssmlBuilder.ts` (D11/H6: XML-escapes untrusted note text, strips XML-forbidden control chars BEFORE empty/budget validation, validates voices incl. dialect subtags `zh-CN-liaoning-*` + `:DragonHD` variants, fail-closed), `voiceCatalogService.ts` (cached regional `voices/list`, grammar backstop offline), `cognitiveSpeechTtsEngine.ts` (SSML → `raw-24khz-16bit-mono-pcm` Int16Array; binds `azureSpeechVoice`), `gptAudioTtsEngine.ts` (Chat Completions `modalities:['text','audio']` `pcm16` = 24 kHz mono LE; newest `gpt-audio-*` from the live catalog, segment-wise version sort). Registry: `azure-speech` + `azure-openai` are `internalOnly` (capability-resolved; `listProviders()` filters them); `openai-gpt-audio` is user-selectable private-only.
- `AudioAttachCoordinator.resolveDiarizationSelection()` — policy-driven provider selection: Azure mode → in-region azure-speech first once configured; strict NEVER falls back to BYO; private + `'deepgram'` → Deepgram (unchanged). Modals gate on availability (no key handling) and use **provider-aware copy**: Deepgram cost preview + third-party disclosure are Deepgram-only; azure-speech shows the own-resource billing note and skips the disclosure.

### Key patterns
- **Compatibility ≠ compliance (D3)**: `azureSpeechRequired` strict mode is fail-closed — an unconfigured Speech surface yields a typed `unavailable` Notice, never a silent Global-Standard fallback. Default OFF = existing users byte-identical.
- **`useMainKeyFallback`-class discipline**: the Speech chain never borrows personal keys; `getGptAudioApiKey` uses main `cloudApiKey` ONLY when the main provider IS openai.
- **Engines never cross surfaces**: the azure-openai `/audio/speech` engine refuses `azure-speech` resolutions and vice versa (factory guards) — a resolution's SURFACE picks the engine.
- **Latest-sentinel rule**: gpt-audio model resolved from the live OpenAI catalog (`gpt-audio-<ver>` newest), pinned fallback only offline.

### Tests
`tests/{audioProviderPolicy(19),azureSpeechCredential(11),azureSpeechDiarizationAdapter(21),ssmlBuilder(15),cognitiveSpeechTtsEngine(11),gptAudioTtsEngine(17),azureCapabilitiesSettingsSection(5)}.test.ts` + extended `endpointResolver`/`resolveAzureCapability`/`settingsMigration`/`tests/diarization/deepgramAdapter` (seam-migrated) + fixture `tests/fixtures/azureSpeech/fast-transcription-2speaker.json` (live-verified §A shape).

## Azure 429 Rate-Limit Throttling (RPM pacing + Azure-aware retry)

**Status**: ✅ Implemented (June 2026) — pass 1 (text egress) + **coverage pass (ALL egress)**

Paces outbound Azure requests under the low Azure RPM cap (~10/min) so batch tagging / index rebuilds don't 429-storm, + Azure-aware retry. A concurrency cap **alone is not RPM pacing** (cap-2 × fast calls ≈ hundreds/min), so the pacer enforces TWO gates.

### Coverage (azure-throttle-coverage) — EVERY Azure egress is paced
Non-Azure byte-identical; embeddings excluded (already cap-1 `embeddingQueue`):
- **Shared seam**: `withAzureLease(key, signal, fn)` (the ONE lease wrapper for fetch/cross-module egress) + **SSOT key builders** `buildAzureClaudeDeploymentKey` / `buildAzureOpenAIDeploymentKey` (over the ONE canonical `normalizeAzureEndpointToHost` — no raw fallback; host+model canonicalized) + `isAzureHost`. The old divergent `azureRateLimitKey` was REMOVED. `cloudService.pacedRequestUrl` + `azurePacerKey()` route through these.
- **Multimodal** (`sendMultimodal`, PDF/image — the high-TPM gap): paced + retried + an **exhausted-token-429 → actionable `AzureRateLimitError`** fallback. **No pre-emptive >TPM fail-fast** — a base64 body has no reliable client-side token estimate and `max_tokens` is only a ceiling, so `estimateMultimodalMinTokens` returns 0 (`classifyTpm` never fires for multimodal); every 429 retries and a genuine >TPM surfaces via the exhausted path.
- **Streaming** (`summarizeTextStream` + web-search `runStreamLoop`): **admission-ONLY** lease — wraps just the initial fetch + status read so the RPM start is counted, then releases; the SSE body streams un-leased (a whole-stream lease would freeze all other Azure calls at `maxConcurrent`). Initial-429 retries outside the lease.
- **Web-search** (`claudeWebSearchAdapter`): per-attempt admission lease on the **SAME** `buildAzureClaudeDeploymentKey` bucket the text path uses → text + research share ONE deployment RPM budget (released before the WS backoff — deadlock-safe).
- **Audio/Whisper** (`audioTranscriptionService`): `pacedWhisperRequest` **self-detects** Azure from the resolved endpoint (`resolveWhisperPacingKey` → `extractWhisperDeployment`) — NO `TranscriptionOptions` change, NO edits to the 9 call sites. It OWNS its request timeout via an internal `AbortController` (clears the timer + aborts the retry loop on timeout → no leaked timer, no zombie paced loop; at most one in-flight `requestUrl` dangles since Obsidian can't cancel it).
- Tests: `withAzureLease.test.ts`, `cloudServiceAzureThrottle.test.ts` (extended), `claudeWebSearchPacing.test.ts`, `audioTranscriptionPacing.test.ts`. **Plan**: [docs/completed/azure-throttle-coverage.md](../completed/azure-throttle-coverage.md).

### Pass 1 (text egress) — the pacer core
- `src/services/azure/azureRequestPacer.ts` — **`AzureRequestPacer`**: a self-contained, bounded-FIFO, two-gate scheduler — (a) max-concurrency + (b) a rolling-60s **request-START window** (max-RPM admission). Single FIFO, atomic dual-gate grant (start ts recorded at grant), **abortable leases** (cancel-while-queued removes the waiter), **in-place `setPolicy`** (preserves window/active/FIFO — no recreation), injectable `{now,setTimeout,clearTimeout}`. Per-deployment registry `getAzurePacer(key)` keyed by the SSOT `buildAzure{Claude,OpenAI}DeploymentKey` builders (see Coverage above); `setAzurePacerPolicy` (global, in-place) + `disposeAzurePacers` (unload). `AZURE_PACER_MAX_QUEUE=256`. **Supersedes** the previously-unused `requestLimiter.SimpleSemaphore` for the Azure path (a fixed-size semaphore queue can't express a dual gate).
- `src/services/azure/azureRateLimitHeaders.ts` (pure) — parse BOTH Azure header shapes (`x-ratelimit-*` + `-reset-*`/`-renewalperiod-*` + `retry-after` + `retry-after-ms`/`x-ms-retry-after-ms`). **`computeAzureBackoffMs`**: exhausted-dimension reset → MAX-of-resets (never min — min re-429s) → capped exponential; **authoritative resets/retry-after honoured uncapped**, only the fallback capped at 60s. **`classifyTpm` + `estimateMinProcessedTokens`** — the text >TPM fail-fast = token-dim 429 body AND the **INPUT-ONLY** lower bound (`len/5`) > `limit-tokens`. It does NOT count `max_tokens` (a ceiling, not committed usage): live-proven that counting it hard-failed a tiny Mermaid prompt as "~64k tokens" at a 10k TPM when it would have succeeded on retry. Fail-fast only when the INPUT alone can never fit; everything else retries. `logAzureRateLimitHeaders` (allowlisted numeric headers only).
- `src/services/azure/azureRateLimitError.ts` — typed `AzureRateLimitError{kind:'tpm-exceeded'|'queue-full'}`; `formatAzureRateLimitNotice.ts` — shared i18n mapper (`t.azureRateLimit.*`).
- `cloudService.ts` — wired into BOTH `postWithRetry` (summarize) + `makeRequestWithRetry`/`tryOneRequest` (tagging) via `pacedRequestUrl`, **Azure-gated** (`isAzureAdapter` = `adapterType.startsWith('azure')`). The lease is held ONLY for the in-flight HTTP (released before backoff → no pool stall — the deadlock crux). >TPM throws `AzureRateLimitError` (non-retriable via `isNonRetriableError`). **Non-Azure path byte-identical.** Summarize path propagates the caller `AbortSignal`; tagging path has no caller signal (pre-existing, not cancellable) → waiters drain via the RPM window + are rejected on dispose.
- `main.ts` sets the policy from settings on init + change, disposes on unload. Settings: `azureMaxConcurrentRequests` (2) + `azureMaxRpm` (10) + migration + `LLMSettingsSection` controls.
- Tests: `azureRequestPacer.test.ts` (FIFO/RPM-window/abort/deadlock/NaN/policy/dispose), `azureRateLimitHeaders.test.ts`, `cloudServiceAzureThrottle.test.ts` (>TPM fail-fast, non-Azure-untouched, RPM-retry), `formatAzureRateLimitNotice.test.ts`, `azureThrottleWiring.test.ts`. **Plan**: [docs/completed/azure-429-throttling.md](../completed/azure-429-throttling.md) (GPT R1-R2 + Gemini; caught: concurrency≠RPM, output-budget TPM, single-FIFO cancellation, dimension-aware backoff).

## LLM Gateway-Lite (fail-closed profile + observability + contention-safe indexing)

**Status**: ✅ Implemented (June 2026)

A thin coordination layer over the existing long-lived LLM service — NOT a gateway rewrite. Three plugin-scoped SSOTs the rest of the code reads, fixing three live-session failures (Azure routing leak, background-indexer 429 storm, invisible call fan-out).

### Core components
- `src/services/providerProfile.ts` — `resolveProviderProfile(plugin): ProviderProfile` (D1 SSOT): `{ valid, mode: 'azure'|'personal'|'local', provider, providerLabel, endpointHost, model, keySource, error? }`. Composes `isAzureMode`/`resolveEndpoint`/`getAzureApiKey`/`getProviderKey`; never throws (secret lookups wrapped); Azure validity requires a well-formed **HTTPS** endpoint + non-blank key.
- `src/services/llm/nullLLMService.ts` — `NullLLMService` (D2): a SEPARATE fail-closed class (not a flag) implementing `MultimodalLLMService` whose every method returns `{ success:false, error }` with **no network path**. Installed by `initializeLLMService` when `mode==='azure' && !valid` + one Notice. The structural reason the negative test holds.
- `src/services/foregroundGate.ts` — `ForegroundGate` (D3): ref-counted boolean mutex. `isActive()`, `withForeground<T>(fn)` (acquire→`try/finally` release — leak-safe, the ONLY access), `onIdle(listener)` (fires on end→idle, returns unsubscribe). Constructed ONCE in `onload`.
- `src/services/embeddings/embeddingCooldown.ts` — `EmbeddingCooldown` (D4.2): `note429(retryAfterHeader)` sets `max(Retry-After, escalating backoff)` clamped to a **10-min ceiling**; `isCoolingDown()`/`remainingMs()`/`reset()`. `parseRetryAfter` handles delta-seconds + HTTP-date. Injectable clock for tests.
- `src/services/vector/embeddingQueue.ts` — `EmbeddingQueue` (D4.4): plugin-scoped cap-1 serializer. One enqueue = one note (`ChunkTask[]` + `onBatchSuccess`). The drain dequeues exactly `maxBatchSize` **chunks**/iteration so one iteration = one request (no double-billing on partial failure). Typed re-enqueue on `cooldown`/`rate-limit`; drop+settle on `error`/throw; **90s per-request timeout** (cap-1 liveness); foreground-yield via one-shot `onIdle`; path-dedup/supersede; per-batch completion promise. **Disposed only in `onunload`** (NOT `vectorStoreService.dispose()`, which runs on settings re-init).
- `src/ui/components/providerBadge.ts` — pure `renderProviderBadge(container, profile, t)`: `🏢 Azure`/`👤 Personal`/`💻 Local`/`⚠ not configured` pill, `role="img"` + `aria-label`, host tooltip. Warns for ANY invalid profile.
- `src/utils/abortableSleep.ts` — `abortableSleep(ms, signal)`: resolves early on abort, clears timer, never rejects.

### Key wiring
- `main.ts`: constructs `foregroundGate`/`embeddingCooldown`/`embeddingQueue` ONCE in `onload`; `initializeLLMService` resolves+caches `providerProfile` (init-epoch guard so the latest init wins), installs `NullLLMService` on invalid Azure, wires the `onCall` counter + `onProfileChange` listener set. Plugin contract gains `providerProfile`, `foregroundGate`, `withForeground`, `onProfileChange`, `llmCallCounter`, `embeddingQueue`, `embeddingCooldown`.
- `IEmbeddingService` (`embeddings/types.ts`) gains a typed failure `reason: 'cooldown'|'rate-limit'|'error'` + `readonly maxBatchSize` (implemented on all 6 providers). Only network providers set cooldown/rate-limit. `openaiEmbeddingService` short-circuits on cooldown, uses `requestUrl({throw:false})`, reads `Retry-After`. The shared cooldown is injected via `createEmbeddingServiceFromSettings(settings, key, cooldown)`.
- `vectorStoreService`: splits notes → `ChunkTask` → `embeddingQueue.enqueue`; `indexNote` is fire-and-forget, `rebuildVault`/`indexAllNotes` `await` the per-batch completion (truthful "rebuild complete"); `removePath` on delete/rename. `batchGenerateEmbeddings` CONTRACT: any-size input → multi-request → strict 1:1 output (the queue passes ≤`maxBatchSize`; bulk callers rely on the split loop).
- `CloudLLMService`: per-call attribution `logger.debug('LLM', …)` + injected `onCall()` counter + `options.label`; `postWithRetry` threads `signal` + `onRetryStatus`, uses `abortableSleep` (Cancel interrupts a 429 stall), an aborted op throws `'Aborted'` (not the last 429 response). `summarizeTextStream` gains a trailing `options` param; the facade merges options into the stream→non-stream fallback.
- `withForeground` wraps user-entry flows: chat send (`UnifiedChatModal.handleSend`), presentation build/polish/brand-audit (`PresentationModeHandler`), `summarize`/`translate`/`minutes` (the minutes wrap is in `MinutesCreationModal` — the real LLM call site). Tagging + newsletter deferred (graceful, additive).

### Patterns
- **NullLLMService over a flag**: no two-mode service, no method can forget the guard. Negative test (`azureMode.test.ts`): misconfigured Azure ⇒ `NullLLMService` ⇒ zero `requestUrl` calls to any `anthropic.com` host.
- **Cap-1 serializer is the real thundering-herd fix** (not the cooldown alone): the first 429 sets the cooldown before the next request fires.
- **Queue reaches the CURRENT embedding service indirectly** (`getEmbeddingService()` accessor) so a settings-driven swap doesn't leave a stale instance.
- **i18n**: `t.llmGateway.*` (badge labels, status line, retry/cancel, Azure-misconfig notice).

### Tests
`tests/providerProfile.test.ts`, `tests/foregroundGate.test.ts`, `tests/embeddingCooldown.test.ts`, `tests/embeddingQueue.test.ts`, `tests/providerBadge.test.ts`, `tests/abortableSleep.test.ts`, extended `tests/azureMode.test.ts` (keystone negative test) + `tests/openaiEmbeddingService.test.ts` (cooldown short-circuit + Retry-After + maxBatchSize).

**Plan**: [docs/completed/llm-gateway-lite.md](../completed/llm-gateway-lite.md) · **Audit summary** (gitignored): `docs/completed/llm-gateway-lite-audit-summary.md`.

## Anthropic Prompt Caching (Phases 1/2/2c/3)

**Status**: ✅ Implemented (May 2026) — Claude-only, opt-in per call

### Overview

The Claude adapter emits `cache_control: {type: 'ephemeral'}` markers on stable prompt prefixes so repeat calls within the 5-minute TTL read prefix tokens at 0.1× the input cost instead of 1× (Anthropic's 90% cache-read discount). Cache writes cost 1.25× — we only emit the marker when the prefix clears the per-model minimum (4096 chars for Sonnet/Opus, 8192 for Haiku) so we never pay the write penalty for a prefix Anthropic would silently refuse to cache.

### Architecture

**Provider-neutral API** ([src/services/types.ts:96-127](../../src/services/types.ts)):
- `SummarizeOptions.stablePrefix?: string` — optional cacheable prefix
- Callers pass volatile content via `prompt`, stable content via `stablePrefix`
- Non-Claude providers (Gemini, OpenAI) silently concatenate via `effectivePrompt` in [src/services/cloudService.ts:518-595](../../src/services/cloudService.ts) — no caller-side branching needed

**Claude-specific shaping** ([src/services/cloudService.ts:632-720](../../src/services/cloudService.ts)):
- `buildClaudeSystemAndUser(systemPrompt, prompt, modelName, stablePrefix)` helper returns `{ systemField, userContent }`
- Above threshold: `systemField = [{type:text, boilerplate}, {type:text, stablePrefix, cache_control:{type:'ephemeral'}}]`, `userContent = prompt`
- Below threshold OR no stablePrefix: `systemField = string boilerplate`, `userContent = stablePrefix ? `${stablePrefix}\n\n${prompt}` : prompt`
- Composes with adaptive thinking — both can be present in the same body

**Cache usage instrumentation** ([src/services/adapters/claudeAdapter.ts:151-167, 206-225](../../src/services/adapters/claudeAdapter.ts)):
- `logCacheUsage(usage, source)` called from `parseResponseContent` (non-streaming) and `parseStreamingChunk` on `message_start`
- Format: `[Cache] claude {response|stream-start} model=X in=N cache_write=N cache_read=N out=N`
- Routes through `logger.debug` — silent in production, visible when `debugMode` is on
- Foundation for measuring hit rates without external metrics pipeline

### Wired call sites

| Site | File | Stable header | Volatile payload |
|---|---|---|---|
| Minutes chunked extraction (Phase 2) | [minutesService.ts:587-606](../../src/services/minutesService.ts) | `buildChunkExtractionPrompt({dictionary, agenda, participants, contextSummary, ...})` | per-chunk transcript |
| Minutes single-call (Phase 2c) | [minutesService.ts:302-336](../../src/services/minutesService.ts) | `getStyleSystemPrompt({...})` | `buildMinutesUserPrompt({...meta, transcript, ...})` JSON |
| Minutes consolidation (Phase 2c) | [minutesService.ts:672-700](../../src/services/minutesService.ts) | `buildStyleConsolidationPrompt({...})` | `JSON.stringify(consolidationPayload)` |
| Minutes intermediate-merge (Phase 2c) | [minutesService.ts:909-919](../../src/services/minutesService.ts) | `buildIntermediateMergePrompt(mergeContext)` | `Extracts to merge:\n${JSON.stringify(batch)}` |
| Free Chat (Phase 3) | [FreeChatModeHandler.ts:203-333](../../src/ui/chat/FreeChatModeHandler.ts) | auto-memory instruction + global memory + project instructions/memory/files + flat attachments | conversation history + RAG retrieval + question |

### Where caching pays off

- **Chunked minutes** (90-min meeting → 12+ sequential calls): 1 write + 11 reads = ~80% prefix-token cost reduction
- **Truncation retries** (`retryIfTruncated` re-fires with same prefix + larger maxTokens): write on attempt 1, read on attempts 2-3
- **Regeneration** (user re-runs minutes for same meeting after tweaking persona / re-running on Low-coverage warning): cache_read across runs within TTL
- **Multi-turn chat** (project mode with substantial instructions + attached files): write on turn 1, read on turns 2-N. TTL refreshes on every hit
- **Hierarchical merge** (multiple batches within one reduction pass): same merge header reused across batches

### Phase 3 — chat stable/volatile split discipline

Free Chat reorganised `buildPrompt` ([FreeChatModeHandler.ts:203-333](../../src/ui/chat/FreeChatModeHandler.ts)) so stable parts collect into one contiguous prefix, volatile parts into a separate suffix:

```
STABLE (eligible for cache_control):
  1. auto_memory_instruction          ← only when memory exists
  2. global_memory
  3. project_instructions
  4. project_memory
  5. project_files (pinned)
  6. flat attachments                  ← moved AHEAD of history to stay contiguous

VOLATILE (must come AFTER cache marker):
  7. conversation_history              ← grows per turn
  8. attachment_context (RAG retrieval) ← varies per query
  9. question                          ← the new user input
```

`SendResult.stablePrefix?: string` ([ChatModeHandler.ts:110-133](../../src/ui/chat/ChatModeHandler.ts)) carries the split; `UnifiedChatModal.processChatRequest` forwards it to `summarizeText` options when present.

### officeparser bundling fix (related)

Phase 2 work surfaced that officeparser was silently broken in the production bundle (cascade: `util.inherits is not a function` → `file-type` chain throws → esbuild's `__commonJS` caches half-initialised exports → all subsequent calls return broken module with missing `parseOffice`). Root cause: the original `electronBuiltinShimPlugin` in [esbuild.config.mjs:42-60](../../esbuild.config.mjs) wrote literal `require('util')` inside the shim, which esbuild's static scanner rewrote to point at the shim itself — infinite cycle, esbuild returned `{}`. Fixed by resolving require indirectly via `window.require || globalThis.require || null` so esbuild can't see the call site. Also added [src/stubs/tesseractNoop.cjs](../../src/stubs/tesseractNoop.cjs) and aliased `'tesseract.js' → stub` so officeparser's eager `require('tesseract.js')` (for OCR support we never use) doesn't pull in Web Worker spawning code that fails to bundle for Electron renderer. Diagnostic logging in [documentExtractionService.ts:148-172](../../src/services/documentExtractionService.ts) surfaces the actual exception on future officeparser load failures + defensively returns null when `parseOffice` is missing.

### Verifying caching is working

1. Enable Debug mode (Settings → AI Organiser → AI provider)
2. Open Dev Tools (Ctrl+Shift+I), filter Console by `Cache`
3. Run any Claude-routed flow that has a long stable prefix (Minutes with a loaded dictionary, chat with a project + memory + attached doc)
4. Look for `cache_write=N` on first call, `cache_read=N` on subsequent calls within 5 min
5. If `cache_write` stays 0: prefix is below the threshold (4096 chars for Sonnet/Opus, 8192 for Haiku) — add more stable context
6. If writes happen but `cache_read` stays 0 between calls: something dynamic is busting the prefix (timestamp? date? user-id?) — diff two consecutive prefixes

### Tests (25 new + 5 modified)

- [tests/claudeAdapterCacheUsage.test.ts](../../tests/claudeAdapterCacheUsage.test.ts) (10 tests): `logCacheUsage` fires correctly on both code paths, silent when `debugMode` off, graceful when `usage` field missing or response is null/undefined
- [tests/claudePromptCaching.test.ts](../../tests/claudePromptCaching.test.ts) (10 tests): body shape transformation, per-model thresholds (Sonnet 4096 / Haiku 8192), idempotency (same prefix → byte-identical system field across calls), no marker for non-Claude providers, composes with adaptive thinking
- `tests/freeChatModeHandler.test.ts` (5 new): stable/volatile split, prefix invariance across turns with same context, prefix-busting when memory is added between turns
- `tests/minutesService.test.ts` (5 updated): assertions migrated from `prompt`-only to combined `prompt + options.stablePrefix` (style instructions moved out of user message into stablePrefix)

### Key patterns
- **Threshold gate**: cloud service falls back to silent concatenation when stablePrefix < per-model minimum. Avoids paying 1.25× write penalty for a prefix Anthropic won't cache. Below-threshold callers get no behaviour change.
- **Fingerprint discipline**: same patterns from audio narration's `LLM_ENHANCEMENT_PROMPT_VERSION` salting apply here — any change before the cache marker busts the cache hash. Avoid embedding timestamps, dynamic IDs, or per-call counters in the stable prefix.
- **Volatile-after-stable invariant** (chat handler): test `freeChatModeHandler.test.ts` asserts `stablePrefix` is byte-identical between turns 1 and 2 when context doesn't change. The reorder of "flat attachments above history" is what makes this true — pre-Phase-3, attachments sat AFTER history, so the prefix wasn't contiguous.
- **Provider-neutral API**: `stablePrefix` on generic `SummarizeOptions` works for all providers. Claude uses it for `cache_control`; others silently concatenate. Adding Gemini context caching later doesn't require changing callers.
