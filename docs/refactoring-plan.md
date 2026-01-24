# Refactoring Plan: Remaining SOLID/DRY Improvements

**Created:** January 24, 2026
**Last Updated:** January 24, 2026
**Priority:** Medium (code quality improvements, not blocking features)
**Scope:** Minutes Modal SRP, Controller Extraction, Truncation UI DRY

---

## Overview

The following refactoring tasks address SRP violations in `MinutesCreationModal`, improve testability, and reduce duplicated UI logic. All new code must follow **no-stubs** policy: every public method is implemented and used by the modal and/or tests, or removed.

---

## Global Rules (No-Stubs Policy)

- **No placeholder methods.** If a method isn't used by modal or tests, remove it.
- **Public methods must have at least one call site.** Modal, other UI, or tests.
- **Private helpers are allowed** if they are used by public methods.
- **Errors are returned, not thrown** (except programmer misuse). Use `errors: string[]` on result objects.

---

## Task 1: Extract DocumentHandlingController from MinutesCreationModal

**File:** `src/ui/modals/MinutesCreationModal.ts`
**Priority:** High

### Problem
The modal currently mixes:
1. Meeting metadata form UI
2. Document detection, extraction, truncation, and errors
3. Dictionary CRUD and term extraction
4. Audio detection and transcription

### Solution
Extract **document handling** into a dedicated controller with explicit state and error handling.

### Controller Responsibilities
- Maintain document list and truncation choices
- Detect embedded documents
- Normalize and deduplicate documents
- Extract text (cache full content, slice on demand)
- Surface errors via result objects

### Document ID Strategy (Required)
Define a stable ID for dedupe, cache, and updates:
- **Vault files:** full path (e.g., `Folder/Sub/file.docx`)
- **External URLs:** normalized URL (lowercase host, remove trailing slash)

Add helper:
```typescript
function getDocumentId(item: DocumentItem): string { /* ... */ }
```

### DocumentHandlingController (Fully Implemented)
**New file:** `src/ui/controllers/DocumentHandlingController.ts`

```typescript
import { App, TFile } from 'obsidian';
import { DocumentExtractionService } from '../../services/documentExtractionService';
import { AIOrganiserPlugin } from '../../main';
import { TruncationChoice, DEFAULT_MAX_DOCUMENT_CHARS } from '../../core/constants';
import { EmbeddedContentDetector } from '../../utils/embeddedContentDetector';

export interface DocumentItem {
    name: string;
    path?: string;
    isExternal: boolean;
    url?: string;
    file?: TFile;
    truncationChoice?: TruncationChoice;
    charCount?: number;
}

export interface DocumentHandlingResult {
    documents: DocumentItem[];
    extractedContents: Map<string, string>;
    errors: string[];
}

export class DocumentHandlingController {
    private app: App;
    private plugin: AIOrganiserPlugin;
    private documentService: DocumentExtractionService;
    private embeddedDetector: EmbeddedContentDetector;
    private documents: DocumentItem[] = [];
    private contentCache: Map<string, string> = new Map();

    constructor(
        app: App,
        plugin: AIOrganiserPlugin,
        documentService: DocumentExtractionService,
        embeddedDetector: EmbeddedContentDetector
    ) {
        this.app = app;
        this.plugin = plugin;
        this.documentService = documentService;
        this.embeddedDetector = embeddedDetector;
    }

    getMaxChars(): number {
        return this.plugin.settings.maxDocumentChars || DEFAULT_MAX_DOCUMENT_CHARS;
    }

    getDocuments(): DocumentItem[] {
        return this.documents.map(d => ({ ...d }));
    }

    addFromVault(file: TFile): void {
        // Implement: normalize, dedupe by ID, add item
    }

    addFromUrl(url: string): void {
        // Implement: validate/normalize URL, dedupe by ID, add item
    }

    detectFromContent(content: string): DocumentItem[] {
        // Implement: return detected docs only (no state)
    }

    addDetectedFromContent(content: string): void {
        // Implement: detect + add to internal list
    }

    setTruncationChoice(docId: string, choice: TruncationChoice): void {
        // Implement: update by id
    }

    applyTruncationToAll(choice: TruncationChoice): void {
        // Implement: apply to all items
    }

    getOversizedDocuments(): DocumentItem[] {
        // Implement: compare charCount with max
    }

    async extractAll(): Promise<DocumentHandlingResult> {
        // Implement: extract missing content into cache
        // then slice per truncation choice
    }
}
```

### Acceptance Criteria
- [ ] Modal delegates all document operations to controller
- [ ] Full content caching, truncation applied from cache
- [ ] Document ID normalization and dedupe enforced
- [ ] Errors returned via `DocumentHandlingResult.errors`
- [ ] Unit tests cover dedupe and truncation precedence

---

## Task 2: Extract DictionaryController from MinutesCreationModal

**File:** `src/ui/modals/MinutesCreationModal.ts`
**Priority:** Medium

### Solution
Create `DictionaryController` for state + CRUD + extraction + merging.

**New file:** `src/ui/controllers/DictionaryController.ts`

```typescript
import { DictionaryService, Dictionary, DictionaryEntry } from '../../services/dictionaryService';
import { LLMService } from '../../services/LLMService';

export interface DictionaryResult<T> {
    value?: T;
    errors: string[];
}

export class DictionaryController {
    private dictionaryService: DictionaryService;
    private currentDictionary: Dictionary | null = null;

    constructor(dictionaryService: DictionaryService) {
        this.dictionaryService = dictionaryService;
    }

    getCurrent(): Dictionary | null {
        return this.currentDictionary;
    }

    async listDictionaries(): Promise<string[]> {
        return this.dictionaryService.listDictionaries();
    }

    async loadDictionary(name: string): Promise<Dictionary> {
        this.currentDictionary = await this.dictionaryService.loadDictionary(name);
        return this.currentDictionary;
    }

    async createDictionary(name: string): Promise<Dictionary> {
        const created = await this.dictionaryService.createDictionary(name);
        this.currentDictionary = created;
        return created;
    }

    async extractTermsFromContent(
        documentContents: string[],
        llmService: LLMService
    ): Promise<DictionaryResult<DictionaryEntry[]>> {
        // Implement: extract, dedupe, return errors
    }

    async mergeEntries(entries: DictionaryEntry[]): Promise<DictionaryResult<void>> {
        // Implement: merge into current dictionary with dedupe
    }

    formatForPrompt(): string {
        return this.currentDictionary
            ? this.dictionaryService.formatForPrompt(this.currentDictionary)
            : '';
    }
}
```

### Acceptance Criteria
- [ ] Modal calls controller for all dictionary operations
- [ ] Term extraction returns errors array, no throws
- [ ] Merge uses case-insensitive dedupe

---

## Task 3: Extract AudioController from MinutesCreationModal

**File:** `src/ui/modals/MinutesCreationModal.ts`
**Priority:** Low

### Solution
Create `AudioController` to manage detection and transcription state.

**New file:** `src/ui/controllers/AudioController.ts`

```typescript
import { TFile } from 'obsidian';
import { AIOrganiserPlugin } from '../../main';

export interface AudioItem {
    file: TFile;
    duration?: number;
    transcript?: string;
    isTranscribing: boolean;
    error?: string;
}

export interface AudioResult<T> {
    value?: T;
    errors: string[];
}

export class AudioController {
    private plugin: AIOrganiserPlugin;
    private audioFiles: AudioItem[] = [];

    constructor(plugin: AIOrganiserPlugin) {
        this.plugin = plugin;
    }

    getItems(): AudioItem[] {
        return this.audioFiles.map(a => ({ ...a }));
    }

    detectFromContent(content: string): AudioItem[] {
        // Implement: detect embedded audio (no state)
    }

    addDetectedFromContent(content: string): void {
        // Implement: detect + add to internal list
    }

    async transcribe(itemId: string): Promise<AudioResult<string>> {
        // Implement: update state, return transcript or errors
    }

    async transcribeAll(): Promise<AudioResult<Map<string, string>>> {
        // Implement: transcribe all items
    }

    getCombinedTranscripts(): string {
        // Implement: join transcripts in order
    }
}
```

### Acceptance Criteria
- [ ] Audio operations delegated to controller
- [ ] Errors propagated via result objects
- [ ] Transcription state updated correctly

---

## Task 4: Consolidate Truncation UI Components

**Files:** `styles.css`, `MinutesCreationModal.ts`, `MultiSourceModal.ts`
**Priority:** Low

### Solution
Create reusable UI components and shared truncation options utility.

**New file:** `src/ui/utils/truncation.ts`

```typescript
import { TruncationChoice } from '../../core/constants';

export type TruncationOption = {
    label: string;
    tooltip: string;
};

export function getTruncationOptions(t: any): Record<TruncationChoice, TruncationOption> {
    // Implement using translations
}
```

**New file:** `src/ui/components/TruncationControls.ts`

```typescript
import { TruncationChoice } from '../../core/constants';
import { TruncationOption } from '../utils/truncation';

export function createTruncationDropdown(
    containerEl: HTMLElement,
    currentChoice: TruncationChoice,
    options: Record<TruncationChoice, TruncationOption>,
    onChange: (choice: TruncationChoice) => void
): HTMLSelectElement {
    // Implement
}

export function createTruncationWarning(
    containerEl: HTMLElement,
    charCount: number,
    maxChars: number,
    t: any
): HTMLElement {
    // Implement
}

export function createBulkTruncationControls(
    containerEl: HTMLElement,
    options: Record<TruncationChoice, TruncationOption>,
    onApplyAll: (choice: TruncationChoice) => void
): HTMLElement {
    // Implement
}
```

### Acceptance Criteria
- [ ] Shared truncation components used in both modals
- [ ] No modal imports inside components
- [ ] Labels/tooltips sourced from `getTruncationOptions`

---

## Task 5: Document Extraction Strategy Pattern (Deferred)

**Priority:** Deferred unless new formats are planned soon

### Rationale
Current `DocumentExtractionService` uses a readable switch with 4-5 cases. Strategy pattern adds files and indirection without clear payoff. Revisit **only if**:
- You plan to add multiple new formats, or
- You need extractors reused across services (vault + URL + other flows)

---

## Controller Lifecycle

Instantiate controllers **per modal open** to avoid stale state:

```typescript
onOpen() {
    this.docController = new DocumentHandlingController(
        this.app,
        this.plugin,
        this.documentService,
        this.embeddedDetector
    );
    this.dictController = new DictionaryController(this.dictionaryService);
    this.audioController = new AudioController(this.plugin);
}
```

No explicit reset needed; GC handles cleanup.

---

## MinutesModalDependencies Transition

**Phase 1 (Migration):** keep services and add controller overrides.

```typescript
export interface MinutesModalDependencies {
    minutesService?: MinutesService;
    dictionaryService?: DictionaryService;
    documentService?: DocumentExtractionService;
    docController?: DocumentHandlingController;
    dictController?: DictionaryController;
    audioController?: AudioController;
}
```

**Phase 2 (Cleanup):** remove service injection once controllers fully wrap them.

---

## Implementation Order (Sequential PRs)

1. **DocumentHandlingController + modal integration**
2. **DictionaryController + modal integration**
3. **AudioController + modal integration**
4. **TruncationControls extraction**
5. **Cleanup PR (remove dead code, finalize DI interface)**

---

## Testing Strategy

- **Unit tests** for each controller (mock services + Obsidian APIs)
- **Behavioral tests** for truncation precedence and dedupe
- **Manual test checklist** from `docs/usertest.md`

### Test File Structure
```
tests/
+-- documentHandlingController.test.ts
+-- dictionaryController.test.ts
+-- audioController.test.ts
+-- components/
    +-- truncationControls.test.ts
```

---

## Success Metrics

**Structural**
- [ ] `MinutesCreationModal` imports no document/dictionary/audio services directly
- [ ] No TODOs or placeholder implementations in new files
- [ ] All public controller methods have call sites

**Behavioral**
- [ ] Document deduplication: same vault path = same document
- [ ] URL normalization: `https://X.com/path/` == `https://x.com/path`
- [ ] Truncation: per-doc choice overrides global setting
- [ ] Dictionary merge: case-insensitive dedupe on entry term
- [ ] Audio transcription errors propagate to UI

**UX**
- [ ] Truncation controls appear in same location with same labels
- [ ] Manual test checklist passes
