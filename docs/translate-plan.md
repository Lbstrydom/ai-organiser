# Multi-Source Translation Feature

## Status

### Phase 1: Multi-Source Translation — ✅ COMPLETE
All implementation, review fixes, and tests passing. Deployed.

**Files created:**
- `src/services/apiKeyHelpers.ts` — shared API key resolution (YouTube Gemini, audio transcription)
- `src/services/pdfTranslationService.ts` — shared PDF provider config + multimodal translation

**Files modified:**
- `src/commands/translateCommands.ts` — major rewrite with smart dispatch, multi-source orchestrator
- `src/commands/summarizeCommands.ts` — updated imports to shared modules, removed private duplicates
- `src/commands/smartNoteCommands.ts` — updated import to shared module
- `src/ui/modals/MultiSourceModal.ts` — parameterized for translate mode, i18n wired up
- `src/services/prompts/translatePrompts.ts` — added sourceType/sourceTitle context
- `src/services/adapters/deepseekAdapter.ts` — aligned fallback model with registry
- `src/i18n/types.ts` — added translate modal + message keys
- `src/i18n/en.ts` — English translations
- `src/i18n/zh-cn.ts` — Chinese translations

**Build:** 0 TypeScript errors, 678/678 tests passing.

### Phase 2: Wikilink Source Cleanup — ✅ COMPLETE
Extended `removeProcessedSources()` to clean up vault file wikilinks after processing.

**Files modified:**
- `src/utils/sourceDetection.ts` — added optional `vaultFiles` param to `removeProcessedSources()` and `shouldRemoveLine()`
- `src/commands/summarizeCommands.ts` — 2 call sites updated to pass vault file paths
- `src/commands/translateCommands.ts` — 1 call site updated to pass vault file paths
- `tests/sourceDetection.test.ts` — 11 new wikilink removal tests

**Build:** 0 TypeScript errors, 690/690 tests passing.
### Phase 3: External PDF URL Download — ✅ COMPLETE
Extended `readExternalPdfAsBase64()` to detect HTTP(S) URLs and download PDFs via Obsidian's `requestUrl` API. Fixes external PDF URLs for both summarize and translate multi-source flows.

**Files modified:**
- `src/services/pdfService.ts` — Added URL detection at top of `readExternalPdfAsBase64()`, new private `downloadPdfAsBase64()` method with HTTPS enforcement and 20MB size limit

**Files created:**
- `tests/pdfService.test.ts` — 11 tests covering HTTPS download, HTTP rejection, size limit, empty response, network errors, filename extraction, URL-encoded names, query parameters, and local file backward compatibility

**Build:** 0 TypeScript errors, 825/825 tests passing.

### Review Round 2 Fixes — ✅ COMPLETE
Fixed 3 findings from second code review.

**Files modified:**
- `src/commands/translateCommands.ts` — (1) Pass raw path as `link` instead of pre-wrapping with `[[]]`, fixing double-wrapped `[[[[path]]]]` references; (2) Map `source.type === 'document'` to new `'document'` SourceType; (3) Use `transcriptResult.videoInfo?.title || url` for YouTube title
- `src/utils/noteStructure.ts` — Added `'document'` to `SourceType` union and `'Document'` label in `formatSourceReference()`

**Build:** 0 TypeScript errors, 825/825 tests passing.

### Review Decisions (documented)

| Finding | Decision | Rationale |
|---------|----------|-----------|
| YouTube no-key fails | **Accepted** | Summarize multi-source has identical behavior (no caption fallback in multi-source path). Clear error message shown. |
| External audio blocked on all platforms | **Accepted** | Summarize does the same. "External audio" means files outside vault, not in-note recordings. Vault audio works. |
| External PDF URLs fail | **Phase 3 ✅** | `readExternalPdfAsBase64()` now detects HTTP(S) URLs and downloads via `requestUrl`. |
| Wikilink cleanup missing | **Phase 2 ✅** | Cross-cutting fix for both summarize and translate. Implemented. |
| Internal refs double-wrapped | **Fixed ✅** | Pass raw path as `link`; `formatSourceReference()` adds `[[]]`. |
| Documents labeled as "Note" | **Fixed ✅** | Added `'document'` SourceType with `'Document'` label. |
| YouTube title uses URL | **Fixed ✅** | Use `videoInfo?.title` from transcript result. |

## Overview
Enhance the translate command to detect embedded multi-source content (URLs, YouTube, PDFs, documents, audio) in the note and let the user select which sources to translate, similar to multi-source summarization.

## Smart Dispatch Logic

Current: `selection → translateSelection()` / `no selection → translateNote()`

New:
- **Selection present** → `TranslateModal` → `translateSelection()` (unchanged)
- **No selection + sources detected** → `MultiSourceTranslateModal` (parameterized `MultiSourceModal`) → `handleMultiSourceTranslate()`
- **No selection + no sources** → `TranslateModal` → `translateNote()` (unchanged)

**Note:** `editorCallback` provides `Editor` but NOT `MarkdownView`. To get `view.file` for source detection, use `app.workspace.getActiveViewOfType(MarkdownView)` inside the callback (same pattern as `summarizeCommands.ts`).

## Output Strategy
- **Note text**: Replaced in-place via `replaceMainContent()` (existing behavior)
- **External sources**: Each translated source appended as `## Translated: [title]` section before References
- **References**: Add citation link for each translated source to `## References` via `addToReferencesSection()`
- **Source cleanup**: Remove processed URLs/links from note body via `removeProcessedSources()`, move to References
  - **Known limitation**: `removeProcessedSources()` handles bare URLs and markdown links `[text](url)` but NOT wikilinks `![[file.pdf]]`. This is a pre-existing limitation shared with multi-source summarization. Filed as separate enhancement.
- **Single-source optimization**: If only 1 source selected, route to simpler handler

## Critical Design Decisions (from review)

### 1. Audio Included
Audio IS included in multi-source translation. Flow: transcribe audio first (via existing `transcribeAudioWithFullWorkflow()`), then translate the transcript text. The modal shows all source types including audio.

### 2. PDF Two-Tier Approach
- **Text-extractable PDFs**: Use `DocumentExtractionService` to extract text, then translate the text
- **Image-based PDFs**: Multimodal path (same pattern as `summarizePdfWithLLM()` in summarizeCommands):
  1. Read PDF as base64 via `PdfService.readPdfAsBase64()` (vault) or `readExternalPdfAsBase64()` (external)
     - Vault files resolved via `app.metadataCache.getFirstLinkpathDest()` with direct path fallback
  2. Get PDF provider config via `getPdfProviderConfig()` (extract to shared module - see DRY Prerequisites)
     - Respects `settings.pdfProvider` (`'claude' | 'gemini' | 'auto'`)
     - `pdfProvider: 'auto'` tries main provider first, falls back to any available multimodal provider
     - Dedicated PDF API key (`settings.pdfApiKey`) and model (`settings.pdfModel`) are respected
  3. If main provider matches PDF provider → use `plugin.llmService` directly
  4. If different → create **temporary `CloudLLMService`** with PDF provider config (same pattern as `summarizePdfWithLLM()` lines 3111-3119)
  5. Call multimodal translate with base64 PDF data + translation prompt
- Warn user if no multimodal provider available and the PDF can't be text-extracted (use `pdfNotTextExtractable` i18n key)

### 3. Content-Size Chunking
Reuse existing `chunkContent()` from `webContentService.ts` and `getMaxContentChars()` from `tokenLimits.ts`:
- **`chunkContent(content, maxCharsPerChunk)`** - Sync, char-based paragraph splitter in `webContentService.ts`
  - NOT `textChunker.ts` which exports `chunkPlainTextAsync()` (async, token-based, for meeting minutes)
- **`getMaxContentChars(provider: string)`** - takes a provider string, NOT settings object
- **Service type resolution** (same pattern as summarizeCommands):
  ```typescript
  const serviceType = plugin.settings.serviceType === 'cloud'
      ? plugin.settings.cloudServiceType
      : 'local';
  const maxChars = getMaxContentChars(serviceType);
  ```
- Check each source's extracted text against token limits
- If too large: split at paragraph boundaries, translate each chunk, concatenate results
- Preserves paragraph structure across chunk boundaries

### 4. Privacy Gating
- Call `ensurePrivacyConsent(plugin, serviceType)` before any external content fetching
  - `serviceType` resolved via: `settings.serviceType === 'cloud' ? settings.cloudServiceType : 'local'`
  - When `serviceType === 'local'`, `ensurePrivacyConsent()` returns `true` (no consent needed)
  - When cloud, shows consent modal for the specific cloud provider
- Check gating ONCE at orchestrator level, not per-source
- Applies to ALL external fetching (URLs, YouTube, external PDFs/documents)

### 5. YouTube Key Resolution
- Reuse `getYouTubeGeminiApiKey()` from shared `apiKeyHelpers.ts` (see DRY Prerequisites)
- Handle missing key gracefully: fall back to caption scraping (same as summarize)
- Configure Gemini model from `settings.youtubeGeminiModel`

### 6. Audio Key Resolution
- Reuse `getAudioTranscriptionApiKey()` from shared `apiKeyHelpers.ts` (see DRY Prerequisites)
- Returns `{ key: string; provider: 'openai' | 'groq' } | null`
- Must check for null and show error: "Audio transcription requires OpenAI or Groq API key"

### 7. Mobile Restrictions
- Same constraints as summarize: `Platform.isMobile` blocks external file access
- Vault-only file pickers on mobile
- Network hardening (timeouts) applies to URL/YouTube fetching

### 8. Modal Reuse (avoid duplication)
Parameterize existing `MultiSourceModal` with config flags instead of creating a duplicate modal:
```typescript
interface MultiSourceModalConfig {
  mode: 'summarize' | 'translate';
  hidePersona?: boolean;      // true for translate
  hideFocusContext?: boolean;  // true for translate
  showLanguageSelector?: boolean; // true for translate
  ctaLabel?: string;          // "Translate" vs "Summarize"
}
```
This avoids UI drift between summarize and translate modals.

## DRY Prerequisites (extract before implementation)

Before implementing translate commands, extract these private functions to shared modules to eliminate duplication:

### `src/services/apiKeyHelpers.ts` (new shared module)

Extract from `summarizeCommands.ts` and `smartNoteCommands.ts`:

1. **`getYouTubeGeminiApiKey(plugin)`** - Currently duplicated identically in:
   - `summarizeCommands.ts:182` (private)
   - `smartNoteCommands.ts:31` (private)
   - New consumer: `translateCommands.ts`

2. **`getAudioTranscriptionApiKey(plugin)`** - Currently private in:
   - `summarizeCommands.ts:218` (private)
   - New consumer: `translateCommands.ts`

After extraction, update all existing consumers to import from shared module.

### `src/services/pdfTranslationService.ts` (new shared module)

Extract PDF provider resolution and multimodal call logic from `summarizeCommands.ts`:

3. **`getPdfProviderConfig(plugin)`** - Resolves PDF provider, API key, and model based on:
   - `settings.pdfProvider` (`'claude' | 'gemini' | 'auto'`)
   - `settings.pdfApiKey` (dedicated PDF key)
   - `settings.pdfModel` (dedicated PDF model)
   - Falls back to main provider if compatible
   - Uses SecretStorage via `PLUGIN_SECRET_IDS.PDF`

4. **`translatePdfWithLLM(plugin, pdfContent, prompt)`** - Multimodal PDF translation:
   - Gets PDF config via `getPdfProviderConfig()`
   - If main provider matches → use `plugin.llmService`
   - If different → create temporary `CloudLLMService` with dedicated config
   - Calls `cloudService.summarizePdf(base64Data, prompt)` (the method name is generic - sends base64 + prompt)
   - Same pattern as `summarizePdfWithLLM()` in summarizeCommands.ts

After extraction, update `summarizeCommands.ts` to import `getPdfProviderConfig` from shared module.

## Files to Modify

### 0. `src/services/apiKeyHelpers.ts` (new - DRY extraction)
Extract `getYouTubeGeminiApiKey()` and `getAudioTranscriptionApiKey()` from summarize/smartNote commands.

### 0b. `src/services/pdfTranslationService.ts` (new - DRY extraction)
Extract `getPdfProviderConfig()` from summarize commands. Add `translatePdfWithLLM()` for multimodal PDF translation (follows same temporary `CloudLLMService` pattern as `summarizePdfWithLLM()`).

### 0c. `src/commands/summarizeCommands.ts` (update imports)
Replace private `getYouTubeGeminiApiKey()`, `getAudioTranscriptionApiKey()`, and `getPdfProviderConfig()` with imports from shared modules.

### 0d. `src/commands/smartNoteCommands.ts` (update imports)
Replace private `getYouTubeGeminiApiKey()` with import from shared module.

### 1. `src/ui/modals/MultiSourceModal.ts` (parameterize)
Add config-driven behavior:
- When `mode: 'translate'`: show language dropdown, hide persona selector, hide focus context
- When `mode: 'summarize'`: existing behavior unchanged
- Source sections remain identical (URLs, YouTube, PDFs, Documents, Audio)
- CTA button text driven by config: "Translate N sources" / "Summarize N sources"

Result interface extended:
```typescript
export interface MultiSourceModalResult {
    // Existing fields...
    sources: { urls, youtube, pdfs, documents, audio };
    summarizeNote: boolean;
    focusContext?: string;
    personaId?: string;
    // New for translate mode:
    targetLanguage?: string;
    targetLanguageName?: string;
}
```

### 2. `src/commands/translateCommands.ts` (major rewrite)
**New imports**:
- `detectSourcesFromContent`, `hasAnySources`, `removeProcessedSources` from `sourceDetection.ts`
- `MultiSourceModal` from modals
- `fetchArticle`, `chunkContent` from `webContentService.ts`
- `DocumentExtractionService` from `documentExtractionService.ts`
- `PdfService` from `pdfService.ts`
- `getYouTubeGeminiApiKey`, `getAudioTranscriptionApiKey` from `apiKeyHelpers.ts`
- `getPdfProviderConfig`, `translatePdfWithLLM` from `pdfTranslationService.ts`
- `getMaxContentChars` from `tokenLimits.ts`
- `ensurePrivacyConsent` from `privacyNotice.ts`
- `transcribeAudioWithFullWorkflow` from `audioTranscriptionService.ts`
- `addToReferencesSection`, `SourceReference` from `noteStructure.ts`
- `MarkdownView`, `TFile` from `obsidian`

**Updated smart dispatch** (in `editorCallback`):
```typescript
const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
const serviceType = plugin.settings.serviceType === 'cloud'
    ? plugin.settings.cloudServiceType
    : 'local';

if (hasSelection) → existing TranslateModal → translateSelection
else →
  detect sources via detectSourcesFromContent(content, app)
  if (hasAnySources) → MultiSourceModal({ mode: 'translate' }) → handleMultiSourceTranslate
  else → existing TranslateModal → translateNote
```

**New functions**:
- `handleMultiSourceTranslate(plugin, editor, view, result)` - Orchestrator:
  - Resolve `serviceType` once: `settings.serviceType === 'cloud' ? settings.cloudServiceType : 'local'`
  - Call `ensurePrivacyConsent(plugin, serviceType)` once upfront
  - Single-source optimization (note-only → existing `translateNote()`)
  - Sequential processing with progress notices per source
  - Per source: extract text → chunk if needed → build translate prompt → call LLM → collect result
  - Add each source citation to References via `addToReferencesSection()`
  - Remove processed source URLs from note body
  - Assemble output: note replacement + appended translated sections
- `translateSourceContent(plugin, text, targetLanguage, sourceContext?)` - Build prompt + handle chunking + call LLM
- `extractAndTranslateUrl(plugin, url, targetLanguage)` - Fetch article → translate
- `extractAndTranslateYouTube(plugin, url, targetLanguage)` - Get transcript (Gemini or caption scraping) → translate
- `extractAndTranslatePdf(plugin, pdfService, path, isVaultFile, targetLanguage, currentFilePath?)` - Two-tier:
    - Try text extraction via `DocumentExtractionService` first
    - If fails/empty: read as base64 via `PdfService.readPdfAsBase64()` (vault, with `getFirstLinkpathDest` resolution) or `readExternalPdfAsBase64()` (external) → call `translatePdfWithLLM()` for multimodal translation
- `extractAndTranslateDocument(plugin, path, isVaultFile, targetLanguage)` - Extract text → translate
- `extractAndTranslateAudio(plugin, path, targetLanguage)` - Get transcription key via `getAudioTranscriptionApiKey()` → transcribe → translate transcript
- `assembleTranslatedOutput(editor, noteTranslation, sourceTranslations)` - Build final note content

**Extraction reuse** from shared modules:
- URLs: `fetchArticle()` from `webContentService.ts`
- YouTube: `getYouTubeGeminiApiKey()` from `apiKeyHelpers.ts` + Gemini transcription / caption scraping fallback
- PDFs (text): `DocumentExtractionService` for text extraction
- PDFs (image): `PdfService.readPdfAsBase64()` + `translatePdfWithLLM()` from `pdfTranslationService.ts` (creates temp `CloudLLMService` when needed)
- Documents: `DocumentExtractionService`
- Audio: `getAudioTranscriptionApiKey()` from `apiKeyHelpers.ts` + `transcribeAudioWithFullWorkflow()` from `audioTranscriptionService.ts`

**Chunking per source** (text-based sources only; multimodal PDFs bypass chunking):
```typescript
const serviceType = plugin.settings.serviceType === 'cloud'
    ? plugin.settings.cloudServiceType
    : 'local';
const maxChars = getMaxContentChars(serviceType);
if (text.length > maxChars) {
    const chunks = chunkContent(text, maxChars);
    const translatedChunks = [];
    for (const chunk of chunks) {
        translatedChunks.push(await translateSourceContent(plugin, chunk, targetLanguage));
    }
    return translatedChunks.join('\n\n');
}
```

### 3. `src/services/prompts/translatePrompts.ts` (minor)
Add optional source context to the prompt:
```typescript
export interface TranslatePromptOptions {
    targetLanguage: string;
    sourceType?: string;   // NEW: 'web article', 'YouTube transcript', 'audio transcript', etc.
    sourceTitle?: string;  // NEW: title for context
}
```
Update `buildTranslatePrompt()` to include source context when provided (e.g., "This is a YouTube transcript" helps the LLM produce better translation).

### 4. `src/i18n/types.ts`
Add under `modals.multiSource` (extend existing, not new section):
```typescript
// Add to existing multiSource interface:
translateButton: string;
translateOne: string;
translateMultiple: string;
languageLabel: string;
languageDesc: string;
```

Add under `messages`:
```typescript
translatingMultipleSources: string;
translatingSourceProgress: string;  // "Translating {current}/{total}: {name}"
extractingForTranslation: string;
transcribingForTranslation: string;
multiSourceTranslateComplete: string;
multiSourceTranslatePartial: string;  // "{success} of {total} sources translated"
pdfNotTextExtractable: string;  // Warning for image-based PDFs without multimodal provider
audioTranscriptionKeyMissing: string;  // Warning when audio key not configured
```

### 5. `src/i18n/en.ts` - Add English translations for new keys
### 6. `src/i18n/zh-cn.ts` - Add Chinese translations for new keys

### 7. `src/ui/modals/CommandPickerModal.ts`
No changes needed - the existing `smart-translate` command already covers this.

## Output Assembly Detail

For multiple sources, the final note content is assembled as:

```markdown
---
[existing frontmatter]
---

[Translated note content - if note was selected]

## Translated: Web Article Title
[Translated web content]

## Translated: YouTube Video Title
[Translated transcript]

## Translated: document.pdf
[Translated PDF text]

## Translated: recording.mp3
[Translated audio transcript]

---
## References
[Preserved existing references]
> **Web:** [Web Article Title](https://example.com) (2026-01-29)
> **YouTube:** [YouTube Video Title](https://youtube.com/...) (2026-01-29)

---
## Pending Integration
[Preserved if exists]
```

If the note was NOT selected for translation (only external sources), the original note content is preserved and translated sections are appended before the References divider.

## DRY/SOLID Compliance

### DRY (Don't Repeat Yourself)
- **API key helpers**: Extracted to `apiKeyHelpers.ts` - eliminates duplication across 3 command files
- **PDF config resolution**: Extracted to `pdfTranslationService.ts` - `getPdfProviderConfig()` shared between summarize and translate
- **Modal reuse**: Parameterized `MultiSourceModal` instead of creating duplicate modal
- **Source detection**: Reuses existing `detectSourcesFromContent()`, `hasAnySources()`, `removeProcessedSources()`
- **Content extraction**: Reuses `fetchArticle()`, `DocumentExtractionService`, `transcribeAudioWithFullWorkflow()`
- **Token limits**: Reuses `getMaxContentChars(provider)` and `chunkContent()` - no hardcoded limits
- **Privacy gating**: Reuses `ensurePrivacyConsent()` - no duplicate consent logic
- **i18n**: Extends existing `multiSource` section instead of creating new keys

### SOLID Principles
- **SRP**: Each `extractAndTranslate*` function handles one source type
- **OCP**: `MultiSourceModal` extended via config object, not modified internally for translate
- **LSP**: N/A (no inheritance hierarchy)
- **ISP**: Translate orchestrator only imports the interfaces it needs
- **DIP**: Uses `serviceSupportsMultimodal()` abstraction instead of hardcoding provider names; uses `getPdfProviderConfig()` instead of inline provider logic

### No Hardcoding
- Provider names checked via `serviceSupportsMultimodal()` (encapsulates `['claude', 'gemini']`)
- Token limits via `getMaxContentChars(provider)` (reads from `PROVIDER_LIMITS` registry)
- PDF provider via `settings.pdfProvider` + `getPdfProviderConfig()` (not hardcoded to any provider)
- Secret IDs via `PLUGIN_SECRET_IDS` and `STANDARD_SECRET_IDS` constants
- All user-facing strings via i18n keys

## Key Patterns to Follow

1. **Sequential processing with progress** (from multi-source summarize)
2. **Single-source optimization** (route to simpler handler when only 1 source)
3. **Error isolation** (failed sources don't stop processing, track per-source status)
4. **Source detection reuse** (`detectSourcesFromContent()` as-is)
5. **Translate each source individually** (not combined - translation is 1:1)
6. **Prompt injection protection** (existing translate prompt already has this)
7. **Privacy consent gating** (call `ensurePrivacyConsent(plugin, provider)` before external fetch)
8. **Content chunking** (reuse `chunkContent()` from `webContentService.ts` for large text content, merge translated chunks)
9. **Modal reuse** (parameterize `MultiSourceModal` to avoid UI duplication/drift)
10. **Mobile restrictions** (same as summarize - vault-only on mobile)
11. **MarkdownView access** (use `getActiveViewOfType(MarkdownView)` for `view.file`)

## Implementation Order

1. **DRY prerequisites**: Extract `apiKeyHelpers.ts` and `pdfTranslationService.ts`, update existing consumers
2. i18n types + EN + ZH translations
3. Parameterize `MultiSourceModal.ts` with translate mode config
4. `translatePrompts.ts` (add source context support)
5. `translateCommands.ts` (smart dispatch + orchestration + chunking + privacy)
6. Build + test

## Verification

1. `npm run build:quick` - Verify compilation
2. `npm test` - Verify no regressions (801+ tests pass)
3. Deploy to Obsidian vault
4. Manual tests:
   - Note with no sources → shows simple TranslateModal (backward compat)
   - Note with YouTube URLs + web URLs + audio → shows MultiSourceModal in translate mode
   - Select language, check sources, translate → translated sections + References entries
   - Original source links removed from note body after translation
   - Selection → bypasses multi-source, translates selection directly
   - Single source selected → optimized path
   - Error handling: one source fails → others still translate
   - Large content → chunked, translated, merged correctly
   - Privacy consent shown before external fetch
   - PDF (text-based) → extracted and translated
   - PDF (image-based) without multimodal provider → shows warning
   - PDF with dedicated `pdfProvider` setting → uses correct provider/key/model
   - Audio → transcribed then translated (key resolved via shared helper)
   - Audio without API key → shows clear error message
   - Local mode → `getMaxContentChars('local')` used, privacy consent skipped
   - PDF (image-based) with dedicated pdfProvider different from main → temporary CloudLLMService created
   - Mobile → external file access blocked appropriately
   - Existing summarize commands still work (no regression from DRY extraction)

## Known Limitations (v1)

1. **Parallel translation**: Sources are processed sequentially. Parallel processing could improve speed but adds complexity. Not needed for v1.

---

## Phase 2: Wikilink Source Cleanup

### Problem Statement

`removeProcessedSources()` in `sourceDetection.ts` currently handles two line patterns:
1. **Bare URLs**: `https://example.com` (with optional list marker `- `)
2. **Markdown links**: `[Title](https://example.com)` (with optional list marker)

It does NOT handle vault-internal source references:
3. **Wikilinks**: `[[file.pdf]]`, `[[recording.mp3]]`, `[[document.docx]]`
4. **Embed wikilinks**: `![[file.pdf]]`, `![[recording.mp3]]`, `![[document.docx]]`
5. **Wikilinks with display text**: `[[file.pdf|My PDF]]`, `![[file.pdf|My PDF]]`

This means after multi-source summarize or translate processes a vault PDF/audio/document, the original `![[file.pdf]]` line remains in the note body even though its content has been incorporated.

### Scope

This is a **cross-cutting fix** that benefits:
- Multi-source summarization (existing feature)
- Multi-source translation (new feature from Phase 1)
- Any future multi-source feature

### Current Detection vs Cleanup Gap

**Detection** (working correctly):
```
VAULT_PDF_PATTERN    = /\[\[([^\]]+\.pdf)\]\]/gi        → detects [[file.pdf]] and ![[file.pdf]]
VAULT_AUDIO_PATTERN  = /\[\[([^\]]+\.(mp3|wav|...))\]\]/gi  → detects [[audio.mp3]] and ![[audio.mp3]]
VAULT_DOCUMENT_PATTERN = /\[\[([^\]]+\.(docx|...))\]\]/gi   → detects [[doc.docx]] and ![[doc.docx]]
```

Detection captures the **inner path** (e.g., `file.pdf`) as `DetectedSource.value` with `isVaultFile: true`.

**Cleanup** (missing):
`shouldRemoveLine()` only checks for URL patterns. It has no concept of wikilink syntax.

### Design

#### Approach: Extend `removeProcessedSources()` to accept vault file paths

**Current signature:**
```typescript
export function removeProcessedSources(content: string, urls: string[]): string
```

**New signature:**
```typescript
export function removeProcessedSources(
    content: string,
    urls: string[],
    vaultFiles?: string[]   // NEW: vault file paths to remove (e.g., ['meeting.pdf', 'recording.mp3'])
): string
```

The `vaultFiles` parameter is optional for backward compatibility. Existing callers (summarize) continue to work unchanged.

#### New patterns in `shouldRemoveLine()`

Add 3 new cases to match vault file references:

```typescript
// Case 3: Wikilink on its own line (with optional list marker)
// Matches: [[file.pdf]], - [[file.pdf]], * [[file.pdf]]
^\s*[-*]?\s*\[\[{filePath}\]\]\s*$

// Case 4: Embed wikilink on its own line (with optional list marker)
// Matches: ![[file.pdf]], - ![[file.pdf]], * ![[file.pdf]]
^\s*[-*]?\s*!\[\[{filePath}\]\]\s*$

// Case 5: Wikilink with display text on its own line (with optional list marker)
// Matches: [[file.pdf|My Document]], ![[file.pdf|My Document]]
^\s*[-*]?\s*!?\[\[{filePath}\|[^\]]*\]\]\s*$
```

All three can be combined into one regex per file path:
```typescript
// Combined: optional !, [[filePath optionally |display text]]
^\s*[-*]?\s*!?\[\[{escapedPath}(?:\|[^\]]*)?]\]\s*$
```

#### Section rules (unchanged)
- **Main content**: Wikilinks removed (same as URLs)
- **## References**: Wikilinks kept (same as URLs)
- **## Pending Integration**: Wikilinks removed (same as URLs)

### Files to Modify

#### 1. `src/utils/sourceDetection.ts`

**`removeProcessedSources()`** - Add optional `vaultFiles` parameter:
```typescript
export function removeProcessedSources(
    content: string,
    urls: string[],
    vaultFiles?: string[]
): string {
    if (urls.length === 0 && (!vaultFiles || vaultFiles.length === 0)) return content;
    // ... existing URL logic unchanged ...
    // Add: const shouldRemove = shouldRemoveLine(line, urls, vaultFiles);
}
```

**`shouldRemoveLine()`** - Add vault file matching:
```typescript
function shouldRemoveLine(line: string, urls: string[], vaultFiles?: string[]): boolean {
    // Existing Case 1 & 2 (URLs) unchanged...

    // NEW: Check vault file wikilinks
    if (vaultFiles) {
        for (const filePath of vaultFiles) {
            const escaped = escapeRegex(filePath);
            // Combined pattern: optional embed !, [[path optionally |alias]]
            if (new RegExp(String.raw`^\s*[-*]?\s*!?\[\[` + escaped + String.raw`(?:\|[^\]]*)?]\]\s*$`).test(line)) {
                return true;
            }
        }
    }
    return false;
}
```

#### 2. `src/commands/summarizeCommands.ts` (update ALL 3 callers)

There are 3 call sites for `removeProcessedSources()` in summarizeCommands.ts:

1. **Line ~1034** - Multi-source orchestrator (failure/partial path)
2. **Line ~1108** - Multi-source orchestrator (success path)
3. **Line ~1152** - `removeSourceFromEditor()` single-source helper

All three need the `vaultFiles` parameter:

```typescript
// Collect vault file paths from processed sources (for call sites 1 & 2)
const vaultFilePaths = [
    ...result.sources.pdfs.filter(p => p.isVaultFile).map(p => p.path),
    ...result.sources.audio.filter(a => a.isVaultFile).map(a => a.path),
    ...result.sources.documents.filter(d => d.isVaultFile).map(d => d.path),
];

// Remove both URLs and vault file references
const cleanedContent = removeProcessedSources(content, processedUrls, vaultFilePaths);
```

For call site 3 (`removeSourceFromEditor`), it currently only handles URLs. Add optional `vaultFile` parameter:
```typescript
function removeSourceFromEditor(editor: Editor, url: string, vaultFile?: string): void {
    const fullContent = editor.getValue();
    const cleanedContent = removeProcessedSources(fullContent, [url], vaultFile ? [vaultFile] : undefined);
    // ...
}
```

#### 3. `src/commands/translateCommands.ts` (update caller)

Same pattern as summarize - collect vault file paths and pass to cleanup:
```typescript
const vaultFilePaths = [
    ...result.sources.pdfs.filter(p => p.isVaultFile).map(p => p.path),
    ...result.sources.audio.filter(a => a.isVaultFile).map(a => a.path),
    ...result.sources.documents.filter(d => d.isVaultFile).map(d => d.path),
];
const cleanedContent = removeProcessedSources(content, processedUrls, vaultFilePaths);
```

#### 4. `tests/sourceDetection.test.ts` (new test cases)

Add to the existing `removeProcessedSources` describe block:

```typescript
describe('Vault Wikilink Removal', () => {
    it('should remove wikilink on its own line', () => {
        const content = `Some text\n[[meeting.pdf]]\nMore text`;
        const result = removeProcessedSources(content, [], ['meeting.pdf']);
        expect(result).not.toContain('[[meeting.pdf]]');
        expect(result).toContain('Some text');
        expect(result).toContain('More text');
    });

    it('should remove embed wikilink on its own line', () => {
        const content = `Some text\n![[recording.mp3]]\nMore text`;
        const result = removeProcessedSources(content, [], ['recording.mp3']);
        expect(result).not.toContain('![[recording.mp3]]');
    });

    it('should remove wikilink with display text', () => {
        const content = `- [[report.pdf|Q4 Report]]\nNotes`;
        const result = removeProcessedSources(content, [], ['report.pdf']);
        expect(result).not.toContain('[[report.pdf|Q4 Report]]');
        expect(result).toContain('Notes');
    });

    it('should remove wikilink with list marker', () => {
        const content = `- [[file.docx]]\n* ![[audio.wav]]`;
        const result = removeProcessedSources(content, [], ['file.docx', 'audio.wav']);
        expect(result).not.toContain('[[file.docx]]');
        expect(result).not.toContain('![[audio.wav]]');
    });

    it('should NOT remove wikilink inside sentence', () => {
        const content = 'See the report [[meeting.pdf]] for details.';
        const result = removeProcessedSources(content, [], ['meeting.pdf']);
        expect(result).toContain('[[meeting.pdf]]');
    });

    it('should keep wikilinks in References section', () => {
        const content = `![[file.pdf]]\n## References\n- [[file.pdf]]\n## Notes`;
        const result = removeProcessedSources(content, [], ['file.pdf']);
        expect(result).toContain('## References');
        expect(result).toContain('- [[file.pdf]]');
        // The one outside References should be removed
        expect(result).not.toContain('![[file.pdf]]');
    });

    it('should handle mixed URLs and wikilinks', () => {
        const content = `https://example.com\n![[meeting.pdf]]\nNotes`;
        const result = removeProcessedSources(content, ['https://example.com'], ['meeting.pdf']);
        expect(result).not.toContain('https://example.com');
        expect(result).not.toContain('![[meeting.pdf]]');
        expect(result).toContain('Notes');
    });

    it('should handle path with subdirectory', () => {
        const content = `![[Attachments/report.pdf]]`;
        const result = removeProcessedSources(content, [], ['Attachments/report.pdf']);
        expect(result).not.toContain('![[Attachments/report.pdf]]');
    });
});
```

### Edge Cases

| Case | Input | Expected |
|------|-------|----------|
| Bare wikilink | `[[file.pdf]]` | Removed |
| Embed wikilink | `![[file.pdf]]` | Removed |
| With alias | `[[file.pdf\|My File]]` | Removed |
| With list marker | `- ![[file.pdf]]` | Removed |
| Inline in text | `See [[file.pdf]] here` | Kept (not on its own line) |
| In References | `## References\n[[file.pdf]]` | Kept |
| Subdirectory path | `![[Attachments/report.pdf]]` | Removed |
| Spaces in path | `![[My Documents/file.pdf]]` | Removed (escapeRegex handles spaces) |
| Multiple on one line | `[[a.pdf]] [[b.pdf]]` | Kept (not a single wikilink line) |

### Implementation Order

1. Add wikilink cases to `shouldRemoveLine()` in `sourceDetection.ts`
2. Update `removeProcessedSources()` signature with optional `vaultFiles` param
3. Add test cases to `sourceDetection.test.ts`
4. Run `npm test` to verify new tests pass and no regressions
5. Update `summarizeCommands.ts` caller to pass vault file paths
6. Update `translateCommands.ts` caller to pass vault file paths
7. Build + test full suite

### Backward Compatibility

- `vaultFiles` parameter is **optional** with default `undefined`
- All existing callers continue to work with `removeProcessedSources(content, urls)`
- No changes to `DetectedSource` interface
- No changes to detection logic (only cleanup)
- Existing tests unchanged (new tests added alongside)

---

## Phase 3: External PDF URL Download Support

### Problem Statement

`readExternalPdfAsBase64()` in `pdfService.ts` uses `fs.stat` and `fs.readFile` — it only works with **local file paths**, not URLs. When a user's note contains an external PDF URL like `https://example.com/report.pdf`, the multi-source flow detects it correctly and sets `isVaultFile: false`, but the backend call to `readExternalPdfAsBase64(url)` fails because it tries to stat a URL string as a filesystem path.

This is a **cross-cutting gap** that affects:
- Multi-source summarization (existing feature — same bug at `summarizeCommands.ts:602` via `summarizePdfWithFullWorkflow`)
- Multi-source translation (new feature from Phase 1)

### Current Behavior

1. **Detection** (working): `detectSourcesFromContent()` finds `https://example.com/report.pdf` and classifies it as `{ value: 'https://...', isVaultFile: false }`
2. **Modal** (working): User sees the detected PDF and can select it
3. **Processing** (broken): Backend calls `pdfService.readExternalPdfAsBase64('https://...')` → `fs.stat(url)` → ENOENT

### Proposed Design

Add a URL download path to external PDF processing. When `isVaultFile: false` and the path looks like an HTTP(S) URL, download the PDF to a temp buffer and convert to base64.

#### Option A: Extend `PdfService.readExternalPdfAsBase64()`

Add URL detection at the top of the existing function:

```typescript
async readExternalPdfAsBase64(filePathOrUrl: string): Promise<PdfServiceResult> {
    // NEW: If it's a URL, download first
    if (filePathOrUrl.startsWith('http://') || filePathOrUrl.startsWith('https://')) {
        return this.downloadAndReadPdf(filePathOrUrl);
    }
    // Existing local file path logic...
}

private async downloadAndReadPdf(url: string): Promise<PdfServiceResult> {
    // Download via requestUrl (Obsidian's network API — works on mobile too)
    // Enforce HTTPS
    // Size check against MAX_PDF_SIZE_BYTES
    // Convert ArrayBuffer to base64
}
```

#### Option B: Add separate `readPdfFromUrl()` method

Keep `readExternalPdfAsBase64()` for local paths only. Add a new method and let callers choose.

**Recommendation**: Option A is simpler — callers don't need to branch. The parameter name change to `filePathOrUrl` documents the dual behavior.

### Security Constraints

- **HTTPS only** (consistent with `DocumentExtractionService.extractFromUrl()`)
- **Size limit**: Same `MAX_PDF_SIZE_BYTES` (20MB) check on `Content-Length` header before download
- **Timeout**: Use `requestUrl` with configurable timeout (reuse `summarizeTimeoutSeconds`)
- **No redirects to file://**: Only follow HTTP(S) redirects

### Files to Modify

1. **`src/services/pdfService.ts`** — Add URL download path to `readExternalPdfAsBase64()`
2. **`tests/pdfService.test.ts`** — Add test cases for URL detection, HTTPS enforcement, size limits

### Scope

- Fixes external PDF URLs for **both** summarize and translate (single fix, two beneficiaries)
- No changes needed in `summarizeCommands.ts` or `translateCommands.ts` — they already call `readExternalPdfAsBase64()` with the URL string
- Mobile compatible via Obsidian's `requestUrl` API

### Verification

1. Paste `https://example.com/report.pdf` into a note
2. Trigger multi-source summarize or translate
3. PDF should be downloaded, base64-encoded, and processed
4. Local file paths still work unchanged (backward compatible)
