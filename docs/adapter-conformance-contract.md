# Adapter Conformance Contract

**Last updated**: 2026-07-14

This is the write-up of the shared `BaseAdapter` contract every registered LLM provider adapter must honour — derived from the actual code below, not invented. The **enforcement** is [tests/adapterConformance.test.ts](../tests/adapterConformance.test.ts), which is the single source of truth for behaviour; this doc explains *why* each assertion exists and cites the exact call sites that would break if an obligation were silently dropped.

## The registry

- [src/services/adapters/index.ts:29-31](../src/services/adapters/index.ts) — `AdapterType` union (16 members: `openai | gemini | deepseek | aliyun | claude | groq | vertex | openrouter | bedrock | requesty | cohere | grok | mistral | openai-compatible | azure-claude | azure-openai`).
- [src/services/adapters/providerRegistry.ts](../src/services/adapters/providerRegistry.ts) — `ALL_ADAPTERS`, a literal tuple of the same 16 (with a compile-time exhaustiveness assertion against `AdapterType` — see below).
- [src/services/adapters/index.ts:33-111](../src/services/adapters/index.ts) — `createAdapter(type, config): BaseAdapter`, the one factory, `switch` over `AdapterType`.

`tests/adapterConformance.test.ts` iterates `ALL_ADAPTERS` directly and constructs each adapter via `createAdapter()` — the same code path `CloudLLMService` uses. A 17th adapter added to the registry is automatically covered with zero test-file edits; an entry with no `createAdapter()` case fails construction and fails the suite.

## Required obligations (every adapter, all 16)

Derived from [src/services/adapters/baseAdapter.ts](../src/services/adapters/baseAdapter.ts) (concrete, inherited-by-default methods) and the call sites in [src/services/cloudService.ts](../src/services/cloudService.ts) that assume every adapter provides them:

| Method | Base default | Call sites that depend on it |
|---|---|---|
| `getEndpoint()` | `baseAdapter.ts:148-150` | `cloudService.ts:116, 150, 190, 660, 978` |
| `getHeaders()` | `baseAdapter.ts:152-156` | `cloudService.ts:152, 683, 980` |
| `validateConfig()` | `baseAdapter.ts:118-120` | `cloudService.ts:136` |
| `formatRequest()` | `baseAdapter.ts:18-32` | `cloudService.ts:153, 428` |
| `parseResponseContent()` | `baseAdapter.ts:224-246` — catches all errors internally, always returns a string | `cloudService.ts:570, 618, 1009` |
| `parseResponse()` | `baseAdapter.ts:34-92`, returns `BaseResponse` | tagging path (`generateTags`) |
| `getMultimodalCapability()` | `baseAdapter.ts:264-266`, default `'text-only'` | `cloudService.ts:958, 1074` |
| `formatMultimodalRequest()` | `baseAdapter.ts:276-279`, default text-only fallback | `cloudService.ts:976` |

**Conformance suite assertions**: every adapter has each of these as a function; `parseResponseContent(garbage)` never throws regardless of input shape (`null`, `{}`, malformed strings); `parseResponse()`'s tag-normalisation (`baseAdapter.ts:73-87` — non-array `matchedTags`/`newTags` coerced to `[]`, values trimmed) holds per-adapter, inside the same registry loop (not a one-off spot-check — see "Why per-adapter, not once" below).

## Capability-gated obligations (only when declared)

| Declaration | Base default | Call sites | Real crash risk if violated |
|---|---|---|---|
| `supportsStreaming?()` | `undefined` (baseAdapter.ts:184) | `cloudService.ts:1090`, presence-checked | — |
| `formatStreamingRequest?()` | `undefined` (baseAdapter.ts:187) | `cloudService.ts:1094` — **non-null-asserted** | If `supportsStreaming()` is `true` but this is undefined, `CloudLLMService` throws a `TypeError` at request time |
| `parseStreamingChunk?()` | `undefined` (baseAdapter.ts:190) | `cloudService.ts:1148, 1157` — **non-null-asserted** | Same crash risk, independently |

This is not a hypothetical: `cloudService.ts:1094`/`1148` non-null-assert both methods separately. An adapter whose `supportsStreaming()` lies about its own code path crashes in production, not in a test.

**Confirmed real capability variance** (not assumed): `vertexAdapter.ts`, `bedrockAdapter.ts`, `cohereAdapter.ts` override **neither** `supportsStreaming` nor `getMultimodalCapability` (both stay at defaults). `claudeAdapter.ts`, `geminiAdapter.ts`, `openaiAdapter.ts`, `azureClaudeAdapter.ts`, `azureOpenAIAdapter.ts` override `getMultimodalCapability` (`'image'` or `'image+document'`). 13 of 16 override `supportsStreaming` (all except vertex/bedrock/cohere).

**Conformance suite assertions**:
- When `supportsStreaming?.() === true`: assert **both** `formatStreamingRequest` and `parseStreamingChunk` are functions (explicitly, as two separate assertions — this is the exact non-null-assertion crash path above). Then assert `formatStreamingRequest(prompt)` returns `{url, headers, body}` (the family-agnostic, always-true shape). Separately, assert `body.stream === true` as a labelled, **convention-specific** check — true for all 13 of today's streaming adapters (11 via the shared `BaseAdapter.buildOpenAIStreamingRequest()` helper, plus Claude/AzureClaude's independent bespoke implementations, which also happen to use `stream: true`) — but NOT an inherent consequence of the shared contract. A future adapter using a genuinely different activation mechanism (a header, a URL suffix) would need its own named mechanism-specific assertion alongside this one, not a forced `stream: true` field.
- When `getMultimodalCapability() !== 'text-only'`: assert the capability-appropriate `formatMultimodalRequest()` override actually represents the given content, not just that the method exists. `formatMultimodalRequest(parts, options?): Record<string, unknown>` ([baseAdapter.ts:276](../src/services/adapters/baseAdapter.ts), called by `CloudLLMService` at [cloudService.ts:976](../src/services/cloudService.ts)) always returns a plain object — confirmed by reading every override (Claude embeds `part.data` verbatim at `source.data`; Gemini and OpenAI follow the same pattern). The probe is **capability-specific**: an `'image'`/`'image+document'` adapter is sent a synthetic image `ContentPart` with a unique sentinel value and the test asserts `JSON.stringify(formatMultimodalRequest(parts)).includes(sentinelValue)`; a `'document'`/`'image+document'` adapter gets the same treatment with a document `ContentPart` and a distinct sentinel. An adapter is **never** probed with a modality it doesn't declare (a future `'document'`-only adapter must not be sent an unsupported image).

## Response normalisation — once, not per-adapter (corrected during implementation)

An earlier draft of this doc (and the Gemini final-gate review, G1) proposed asserting `parseResponse()`'s tag-normalisation once per adapter, inside the registry loop, for future-proofing against a hypothetical future override. Implementation showed this doesn't survive contact with the actual code: **12 of the 16 adapters** (`deepseek`, `aliyun`, `claude`, `groq`, `vertex`, `openrouter`, `bedrock`, `requesty`, `cohere`, `grok`, `openai-compatible`, `azure-claude`) parse their **own provider-specific raw response envelope shape** — most by overriding `parseResponse()` outright, and a couple (`claude`, `azure-claude`) by relying on the inherited `BaseAdapter` default but with a `this.provider.responseFormat` configuration that expects a non-OpenAI-shaped envelope. A single generic (OpenAI-shaped) fixture only satisfies 4 of 16 (`openai`, `gemini`, `mistral`, `azure-openai`). Testing this per-adapter with the correct shape for each would require 16 provider-shaped fixtures — exactly the "per-provider request/response fixture" work this plan's addendum explicitly scoped out.

The suite tests this **once**, against `openai` as the representative example of `BaseAdapter`'s inherited normalisation logic ([baseAdapter.ts:73-87](../src/services/adapters/baseAdapter.ts)) — see `tests/adapterConformance.test.ts`'s "Response normalisation" block. This is a narrower guarantee than the future-proofing goal originally intended, but an honest one: this suite cannot verify tag-normalisation behaviour for an adapter that legitimately parses its own response shape, because doing so correctly requires exactly the fixture engineering explicitly out of scope.

## Fixture factory

`baseConfig(type: AdapterType): AdapterConfig` builds `{ endpoint: PROVIDER_ENDPOINT[type] || 'https://example.test', apiKey: 'test-key-not-real', modelName: PROVIDER_DEFAULT_MODEL[type] }` from the real registry defaults in `providerRegistry.ts` — no invented per-provider fixtures. The exact 4 `MultimodalCapability` values are `'text-only' | 'image' | 'document' | 'image+document'` ([src/services/adapters/types.ts:10](../src/services/adapters/types.ts)).

## Failure message format

`expect(actual, \`[${adapterType}][${clause}] expected ${expectedDesc}; observed ${observedDesc}\`).toBe(expected)` — Vitest's built-in `expect(value, message)` second argument, no new helper abstraction. Every failure names the adapter, the contract clause, and observed vs expected.

## Explicitly out of scope (this pass)

- **VCR/record-replay fixtures** against real historical API payloads, **live-key testing**, **provider-specific behavioural correctness** beyond the shared contract — adapters never perform I/O themselves (`BaseAdapter.makeRequest()` at [baseAdapter.ts:141-146](../src/services/adapters/baseAdapter.ts) explicitly rejects if called; `CloudLLMService` does I/O via Obsidian's `requestUrl`), so there is no network boundary inside an adapter to mock, and no live key is ever needed to exercise this suite.
- **Registry schema validation** (every provider has consistent metadata/model config/UI-visible config) — noted as a possible cheap follow-on if it ever falls out of this contract for free; not deliberately scoped in.
