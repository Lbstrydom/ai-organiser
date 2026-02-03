# Integrate Pending: Auto-Resolve All Content Types

**Status**: ✅ Implemented with multimodal PDF support. This is the source of truth for this work item.

**Goal**: Make "Integrate Pending Content" a one-stop command that automatically fetches web articles, transcribes YouTube/audio, extracts PDF content — then summarizes and integrates everything into the note. Eliminates need for separate "Smart Summarize" or "Resolve Embeds" for pending content.

## Update: Multimodal PDF Extraction (February 2026)

When a PDF-capable provider (Claude or Gemini) is configured, PDFs are now processed using **multimodal extraction** — the same quality as Smart Summarize:

- PDFs are sent as base64 to Claude/Gemini with an extraction prompt
- The LLM describes all content including images, diagrams, charts, and tables
- Falls back to text-only extraction (officeparser) when no multimodal provider is available

This ensures capability parity between Smart Summarize and Pending Integration.

---

## Current Flow (broken)

```
Pending section has: raw URLs, YouTube links, ![[audio.wav]], ![[report.pdf]]
  → buildIntegrationPrompt(pendingContent)  ← LLM sees raw text, not actual content
  → LLM produces poor integration (can't read links)
```

## New Flow

```
Pending section has: raw URLs, YouTube links, ![[audio.wav]], ![[report.pdf]]
  → detectEmbeddedContent()                 ← identify all source types
  → resolveAllPendingContent()              ← fetch/extract/transcribe each
  → buildIntegrationPrompt(enrichedContent) ← LLM sees actual article text, transcripts, etc.
  → LLM produces rich integration
  → movePendingSourcesToReferences()
  → clearPendingIntegration()
```

---

## Files to Modify

| File | Change |
|------|--------|
| `src/commands/integrationCommands.ts` | Add `resolveAllPendingContent()`, wire into command handler |
| `src/services/contentExtractionService.ts` | Add `audio` case to `extractSingleItem()`, add `extractPdfAsText()` method |
| `src/i18n/types.ts` | Add resolution message keys |
| `src/i18n/en.ts` | English strings |
| `src/i18n/zh-cn.ts` | Chinese strings |
| `tests/integrationResolve.test.ts` | Unit tests for content resolution |
| `docs/usertest.md` | Manual test cases |
| `docs/STATUS.md` | Status update |

---

## Step 1: Add Audio + Text-mode PDF to ContentExtractionService

**File**: `src/services/contentExtractionService.ts`

### 1a: Audio support

The service has no `audio` case. Add it following the same pattern as `youtubeGeminiConfig`.

1. Import `transcribeAudioWithFullWorkflow` from `audioTranscriptionService`
2. Add `audioTranscriptionConfig?: AudioTranscriptionConfig` property
3. Add `setAudioTranscriptionConfig()` setter
4. Add `case 'audio':` → `extractAudioContent()`
5. `extractAudioContent()`:
   - Return error for external audio (not supported)
   - Resolve vault file from `resolvedFile` or path lookup
   - Call `transcribeAudioWithFullWorkflow(app, file, options)`
   - Return `{ content: transcript, success: true }` on success

```typescript
interface AudioTranscriptionConfig {
    provider: 'openai' | 'groq';
    apiKey: string;
    language?: string;
}
```

### 1b: Text-mode PDF extraction

The existing `extractPdfContent()` returns base64 (for multimodal). Integration needs text. Add a **new method** `extractPdfAsText()` that uses `DocumentExtractionService.extractText()` (officeparser) for vault PDFs and `DocumentExtractionService.extractFromUrl()` for external PDFs. Both paths already handle PDFs correctly.

```typescript
private async extractPdfAsText(item: DetectedContent): Promise<ExtractedContent> {
    // External PDF: download + officeparser text extraction
    if (item.isExternal) {
        const result = await this.documentService.extractFromUrl(item.url);
        if (!result.success || !result.text) {
            return { source: item, content: '', success: false, error: result.error || 'PDF text extraction failed' };
        }
        return { source: item, content: result.text, success: true };
    }
    // Vault PDF: resolve file, use DocumentExtractionService.extractText()
    const file = item.resolvedFile || /* vault path lookup */;
    if (!file) return { source: item, content: '', success: false, error: 'PDF not found' };
    const result = await this.documentService.extractText(file);
    if (!result.success || !result.text) {
        return { source: item, content: '', success: false, error: result.error || 'PDF text extraction failed' };
    }
    return { source: item, content: result.text, success: true };
}
```

Add a `textOnly` flag to `extractContent()` (default: `false` for backward compat). When `textOnly=true`, PDF items route through `extractPdfAsText()` instead of `extractPdfContent()`. This keeps the existing multimodal path untouched.

```typescript
async extractContent(
    items: DetectedContent[],
    onProgress?: (current: number, total: number, item: string) => void,
    textOnly?: boolean  // NEW: when true, PDFs return text instead of base64
): Promise<ExtractionResult>
```

In `extractSingleItem()`:
```typescript
case 'pdf':
    return this.textOnly ? this.extractPdfAsText(item) : this.extractPdfContent(item);
```

(Pass `textOnly` as instance state set before `extractContent()` call, or as parameter — either works.)

---

## Step 2: Add `resolveAllPendingContent()` Function

**File**: `src/commands/integrationCommands.ts`

### Signature:

```typescript
interface ContentResolutionResult {
    enrichedContent: string;
    resolvedCount: number;
    failedCount: number;
    errors: string[];
}

async function resolveAllPendingContent(
    plugin: AIOrganiserPlugin,
    pendingContent: string,
    activeFile: TFile | undefined,
    onProgress?: (message: string, current: number, total: number) => void
): Promise<ContentResolutionResult>
```

### Logic:

1. Call `detectEmbeddedContent(app, pendingContent, activeFile)` to detect all sources
2. Filter to resolvable types: `web-link`, `youtube`, `pdf`, `document`, `audio`, `internal-link` (exclude `image`)
3. If nothing resolvable → return `{ enrichedContent: pendingContent, resolvedCount: 0, ... }`
4. **Privacy consent per cloud provider** (see Step 2a below)
5. **API key check** — get YouTube and audio keys; if missing, warn via Notice but **don't skip** YouTube (ContentExtractionService falls back to caption scraping without Gemini key):
   - YouTube items present → `getYouTubeGeminiApiKey(plugin)` — if null, show info notice (caption scraping will be used as fallback)
   - Audio items present → `getAudioTranscriptionApiKey(plugin)` — if null, show warning and **remove audio items from list** (no fallback available)
6. Create `ContentExtractionService` with YouTube config (if key available) and audio config (if key available)
7. Call `contentExtractionService.extractContent(resolvableItems, onProgress, true)` — `textOnly=true` for PDF text extraction
8. **Build enriched string using positional line-based replacement** (see Step 2b below)
9. Return result with counts

### Step 2a: Privacy consent — per-provider, not per-main-LLM

The resolver touches multiple cloud providers independently of the main LLM:
- Web URL fetching: No cloud LLM involved (uses Obsidian `requestUrl`)
- YouTube transcription: Uses **Gemini** (cloud)
- Audio transcription: Uses **OpenAI** or **Groq** (cloud)
- PDF/Document extraction: No cloud LLM (local officeparser)
- Integration LLM call: Uses **main LLM provider**

**Approach**: Call `ensurePrivacyConsent()` for each distinct cloud provider that will be used in this operation. Since the function tracks shown-state per session (not per call), duplicate calls for the same provider are no-ops.

```typescript
// Collect all cloud providers that will be used
const providersToConsent: string[] = [];

// Main LLM for integration
const mainProvider = plugin.settings.serviceType === 'cloud'
    ? plugin.settings.cloudServiceType : 'local';
providersToConsent.push(mainProvider);

// YouTube resolution uses Gemini
if (hasYouTubeItems && youtubeKey) {
    providersToConsent.push('gemini');
}

// Audio resolution uses OpenAI or Groq
if (hasAudioItems && audioConfig) {
    providersToConsent.push(audioConfig.provider);  // 'openai' or 'groq'
}

// Get consent for each unique cloud provider
const uniqueProviders = [...new Set(providersToConsent)];
for (const provider of uniqueProviders) {
    if (!await ensurePrivacyConsent(plugin, provider)) return;  // User declined
}
```

Since `ensurePrivacyConsent()` is session-scoped (shown once then auto-passes), this typically shows 0-1 dialogs.

### Step 2b: Positional replacement (not string-based)

**Problem**: `originalText` string matching can over-replace repeated text or mutate unintended matches.

**Solution**: Use line numbers from `DetectedContent.lineNumber` for positional replacement. Process replacements **bottom-up** (highest line number first) so earlier line numbers stay valid.

```typescript
function buildEnrichedContent(
    pendingContent: string,
    extractionResult: ExtractionResult
): string {
    const lines = pendingContent.split('\n');

    // Sort extracted items by line number descending (bottom-up replacement)
    const successItems = extractionResult.items
        .filter(item => item.success && item.content)
        .sort((a, b) => b.source.lineNumber - a.source.lineNumber);

    for (const item of successItems) {
        const lineIdx = item.source.lineNumber - 1;  // 0-indexed
        if (lineIdx < 0 || lineIdx >= lines.length) continue;

        const line = lines[lineIdx];
        const originalText = item.source.originalText;

        // Replace only the first occurrence on this specific line
        const pos = line.indexOf(originalText);
        if (pos === -1) continue;

        const replacement = `\n### Content: ${item.source.displayName}\n\n${item.content}\n`;
        lines[lineIdx] = line.slice(0, pos) + replacement + line.slice(pos + originalText.length);
    }

    return lines.join('\n');
}
```

This is safe because:
- Each `DetectedContent` has a unique `lineNumber` from the detector
- We replace only on the specific line where the match was found
- Bottom-up processing preserves line indices for earlier items
- `indexOf` on the specific line avoids cross-line false matches

---

## Step 3: Wire Into Integration Command Handler

**File**: `src/commands/integrationCommands.ts`

In the `integrate-pending-content` command callback, after the modal confirms (the `onSubmit` callback), before `buildIntegrationPrompt()`:

```typescript
// EXISTING: persona prompt loaded

// NEW: Resolve embedded content (includes privacy consent)
const resolutionResult = await resolveAllPendingContent(
    plugin,
    pendingContent,
    view.file ?? undefined,
    (message, current, total) => {
        new Notice(plugin.t.messages.integrationResolvingProgress
            .replace('{current}', String(current))
            .replace('{total}', String(total))
            .replace('{item}', message));
    }
);

// Show resolution summary
if (resolutionResult.resolvedCount > 0) {
    new Notice(plugin.t.messages.integrationResolutionComplete
        .replace('{count}', String(resolutionResult.resolvedCount)));
}

// Use enriched content for the prompt
const enrichedPending = resolutionResult.enrichedContent;

// EXISTING (modified): build prompt with enriched content
const prompt = buildIntegrationPrompt(mainContent, enrichedPending, plugin, personaPrompt, placement, format, detail);
```

### Truncation budget — account for full prompt

**Problem**: Truncating only pending content ignores `<main_content>` and prompt overhead.

**Fix**: Calculate available budget by subtracting main content size and prompt overhead from provider limit:

```typescript
const maxTotal = getMaxContentChars(serviceType);
const promptOverhead = 2000;  // XML tags, instructions, format requirements
const mainContentChars = (placement === 'callout' || placement === 'merge') ? mainContent.length : 0;
const availableForPending = maxTotal - mainContentChars - promptOverhead;

if (enrichedPending.length > availableForPending && availableForPending > 0) {
    enrichedPending = enrichedPending.slice(0, availableForPending);
    new Notice(plugin.t.messages.integrationContentTruncated);
}
```

This ensures the combined prompt (main + pending + overhead) stays within model limits for all placement strategies.

Key: `buildIntegrationPrompt()` signature unchanged — it still takes `pendingContent: string`. We just pass richer content now.

---

## Step 4: i18n Strings

**Files**: `src/i18n/types.ts`, `en.ts`, `zh-cn.ts`

Add under `messages`:

```typescript
integrationResolvingContent: string;     // "Resolving embedded content..."
integrationResolvingProgress: string;    // "Resolving {current}/{total}: {item}"
integrationResolutionComplete: string;   // "Resolved {count} source(s)"
integrationAudioKeyMissing: string;      // "Audio transcription requires OpenAI/Groq API key — audio files will be skipped"
integrationContentTruncated: string;     // "Content was truncated to fit provider limits"
```

Note: No `youtubeKeyMissing` string needed — ContentExtractionService already falls back to caption scraping silently when no Gemini key is configured.

---

## Step 5: Tests

**New file**: `tests/integrationResolve.test.ts`

### Core resolution tests:
1. **No sources** → returns pendingContent unchanged, resolvedCount=0
2. **Web URL** → mock fetchArticle → replaces URL with extracted text
3. **YouTube link without Gemini key** → falls back to caption scraping (not skipped)
4. **YouTube link with Gemini key** → uses Gemini transcription
5. **![[file.pdf]]** → mock documentService.extractText → replaces with text
6. **![[recording.wav]]** → mock transcribeAudioWithFullWorkflow → replaces with transcript
7. **Mixed sources** → verifies all resolved in sequence
8. **Failed source** → leaves original text unchanged, increments failedCount
9. **Missing audio API key** → audio items removed from list, warning in errors

### Positional replacement tests:
10. **Repeated URL on different lines** → both replaced independently at correct positions
11. **Same URL in `> From:` structured block AND bare URL** → detector deduplicates, only one item, replaced once
12. **URL appearing as substring of another URL** → no cross-contamination (line-scoped replacement)

### Privacy consent tests:
13. **Local main LLM + Gemini YouTube + OpenAI audio** → consent requested for both `gemini` and `openai`, not for `local`
14. **Cloud main LLM (Claude) only, no YouTube/audio** → consent for `claude` only
15. **User declines consent** → resolution returns early, no extraction attempted

### Truncation tests:
16. **Enriched content exceeds budget after accounting for main content** → truncated with notice
17. **`cursor` placement** → main content not counted in budget (only pending + overhead)
18. **`merge` placement** → main content counted in budget

### Edge cases:
19. **Already-enriched pending text containing URLs** (e.g., `### Content: article\n\nhttps://example.com in body`) — detector finds the URL, but it's inside already-resolved content. This is handled naturally: the URL would be detected and fetched, but since it's in resolved content the replacement is harmless (replaces a bare URL with its content).
20. **External PDF** → goes through `DocumentExtractionService.extractFromUrl()` (officeparser), not base64 path. Verify text is returned.

---

## Step 6: Documentation

- `docs/usertest.md`: Add integration content resolution test cases
- `docs/STATUS.md`: Add entry for this enhancement

---

## Step 7: "Resolve Embeds" Command

**Decision: Keep it** — it serves a different use case (manual preview/edit of extracted text before integration). No code changes needed.

---

## Implementation Order

1. Step 1 — Add audio + text-mode PDF to ContentExtractionService
2. Step 4 — i18n strings (needed before Step 2)
3. Step 2 — `resolveAllPendingContent()` function with privacy consent + positional replacement
4. Step 3 — Wire into command handler with truncation budget
5. Step 5 — Tests
6. Step 6 — Documentation
7. Build + deploy

---

## Review Responses

### Addressed Findings

| Finding | Severity | Response |
|---------|----------|----------|
| Privacy consent scope wrong for resolver calls | Blocker | Fixed: consent now called per cloud provider actually used (Gemini for YouTube, OpenAI/Groq for audio, main LLM for integration), not just main LLM. See Step 2a. |
| YouTube key check regresses existing behavior | Blocker | Fixed: YouTube is never skipped. ContentExtractionService falls back to caption scraping when no Gemini key. Plan passes no config, letting existing fallback work. |
| PDF remap to document risky for external PDFs | Blocker | Fixed: No remapping. New `extractPdfAsText()` method uses `DocumentExtractionService.extractFromUrl()` for external PDFs and `extractText()` for vault PDFs. Both paths handle PDFs via officeparser. Existing base64 path untouched via `textOnly` flag. |
| String replacement brittle | High | Fixed: Positional line-based replacement using `DetectedContent.lineNumber`, processed bottom-up. No string splitting or global replace. |
| Truncation budget incomplete | High | Fixed: Budget now accounts for main content size (for callout/merge) and prompt overhead before truncating pending content. |
| Test gaps | High | Fixed: Added 20 tests covering per-provider privacy consent, repeated URLs, URL substrings, external PDFs, truncation per placement strategy, already-enriched content. |

---

## Verification

1. `npm run build` — type-check passes
2. `npm test` — all tests pass
3. Manual in Obsidian:
   - Pending with web URL → integration includes article text
   - Pending with YouTube link + Gemini key → transcript used in integration
   - Pending with YouTube link + NO Gemini key → caption scraping fallback works (not skipped)
   - Pending with `![[recording.wav]]` + OpenAI key → transcribed and integrated
   - Pending with `![[recording.wav]]` + NO audio key → notice shown, audio skipped, rest works
   - Pending with `![[report.pdf]]` (vault) → text extracted via officeparser
   - Pending with external PDF URL → text extracted via `extractFromUrl`
   - Pending with `![[data.docx]]` → text extracted and integrated
   - Mixed sources → all resolved, rich integration produced
   - Failed source (bad URL) → graceful skip, rest still integrated
   - Sources moved to References after integration
   - Local LLM + YouTube/audio → privacy consent shown for Gemini/OpenAI specifically
   - `merge` placement with large enriched content → truncated to fit model limits
   - Duplicate URL in structured `> From:` and bare text → handled once (detector deduplicates)
   - Chinese locale → all new strings translated
4. Deploy: `npm run build && cp main.js manifest.json styles.css "C:/obsidian/Second Brain/.obsidian/plugins/ai-organiser/"`
