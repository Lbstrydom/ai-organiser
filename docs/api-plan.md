# Obsidian API Upgrade Plan (v1.10-v1.11)

**Date:** January 27, 2026
**Status:** Phase 1 Implementation Complete - Pending Manual Testing
**Priority:** P1 (SecretStorage), P2 (SettingGroup), P3 (Bases API)

---

## Executive Summary

Upgrade AI Organiser to use new Obsidian APIs while maintaining DRY/SOLID principles, Gestalt UX principles, and backward compatibility.

| Feature | Obsidian Version | Priority | Effort | Impact |
|---------|------------------|----------|--------|--------|
| SecretStorage + SecretComponent | v1.11.0 | HIGH | Medium | Security + UX |
| SettingGroup | v1.11.0 | MEDIUM | Low | Consistency |
| Bases API | v1.10.0 | LOW | None | Not needed |

---

## Phase 1: SecretStorage Integration (HIGH PRIORITY)

### 1.1 Problem Statement

**Current State:**
- API keys stored in plain text in `data.json`
- Visual masking only (password fields)
- Users must enter same keys in multiple AI plugins
- No OS-level security (keychain/DPAPI)

**Target State:**
- API keys stored in OS keychain via SecretStorage
- Cross-plugin key sharing with standard identifiers
- Automatic migration from plain-text
- Graceful fallback for older Obsidian/mobile

### 1.2 Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    SecretStorageService                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ ISecretRead │  │ISecretWrite │  │ ISecretMigration    │  │
│  │ getSecret() │  │ setSecret() │  │ migrateFromPlainText│  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
      ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
      │SecretStorage │ │ data.json    │ │ providerMap  │
      │(OS Keychain) │ │ (Fallback)   │ │ (Inheritance)│
      └──────────────┘ └──────────────┘ └──────────────┘
```

### 1.3 Secret Identifiers

**Standard Cross-Plugin IDs** (shared with other AI plugins):
```typescript
// src/core/secretIds.ts
export const STANDARD_SECRET_IDS = {
    OPENAI: 'openai-api-key',
    ANTHROPIC: 'anthropic-api-key',
    GOOGLE_AI: 'google-ai-api-key',
    GROQ: 'groq-api-key',
    COHERE: 'cohere-api-key',
    VOYAGE: 'voyage-api-key',
    DEEPSEEK: 'deepseek-api-key',
    MISTRAL: 'mistral-api-key',
    OPENROUTER: 'openrouter-api-key',
    GROK: 'grok-api-key',
} as const;
```

**Plugin-Specific IDs** (AI Organiser only):
```typescript
export const PLUGIN_SECRET_IDS = {
    EMBEDDING: 'ai-organiser-embedding-key',
    YOUTUBE: 'ai-organiser-youtube-key',
    PDF: 'ai-organiser-pdf-key',
    AUDIO: 'ai-organiser-audio-key',
} as const;
```

**Provider Mapping** (DRY - single source of truth):
```typescript
export const PROVIDER_TO_SECRET_ID: Record<AdapterType, string> = {
    openai: STANDARD_SECRET_IDS.OPENAI,
    claude: STANDARD_SECRET_IDS.ANTHROPIC,
    gemini: STANDARD_SECRET_IDS.GOOGLE_AI,
    groq: STANDARD_SECRET_IDS.GROQ,
    // ... all 14 providers
};
```

### 1.4 SecretStorageService Interface

```typescript
// src/services/secretStorageService.ts
export interface ISecretStorageService {
    // Availability check
    isAvailable(): boolean;

    // Core operations
    getSecret(id: string): Promise<string | null>;
    setSecret(id: string, value: string): Promise<void>;
    removeSecret(id: string): Promise<void>;

    // Provider-aware operations (uses PROVIDER_TO_SECRET_ID mapping)
    getProviderKey(provider: AdapterType): Promise<string | null>;
    setProviderKey(provider: AdapterType, value: string): Promise<void>;

    // Inheritance chain resolution
    resolveApiKey(options: KeyResolutionOptions): Promise<string | null>;

    // Migration
    migrateFromPlainText(): Promise<MigrationResult>;
}

export interface KeyResolutionOptions {
    primaryId?: string;           // e.g., PLUGIN_SECRET_IDS.EMBEDDING
    providerFallback?: AdapterType; // e.g., current embedding provider
    useMainKeyFallback?: boolean;   // fall back to main cloud key
}
```

### 1.5 Key Resolution Chain (Encapsulated)

```typescript
async resolveApiKey(options: KeyResolutionOptions): Promise<string | null> {
    const { primaryId, providerFallback, useMainKeyFallback = true } = options;

    // 1. Check primary plugin-specific key
    if (primaryId) {
        const key = await this.getSecret(primaryId);
        if (key) return key;
    }

    // 2. Check provider-specific key
    if (providerFallback) {
        const key = await this.getProviderKey(providerFallback);
        if (key) return key;
    }

    // 3. Check main cloud provider key
    if (useMainKeyFallback) {
        const mainProvider = this.settings.cloudServiceType;
        const key = await this.getProviderKey(mainProvider);
        if (key) return key;
    }

    // 4. Fallback to plain-text settings (backward compat)
    return this.getFallbackFromSettings(primaryId, providerFallback);
}
```

### 1.6 Multi-Device Behavior (IMPORTANT)

**SecretStorage is device-local by design.** This is standard security practice:
- macOS: Keychain (device-specific unless iCloud Keychain enabled)
- Windows: DPAPI/Credential Manager (device-specific)
- Linux: Secret Service/libsecret (device-specific)
- Mobile: Platform-specific secure storage

**User Experience:**
- Users must enter API keys on each device separately
- This matches industry standard (1Password, Bitwarden, VSCode, etc.)
- More secure than syncing plain-text keys via Obsidian Sync

**UI Communication:**
```typescript
// Show device-local badge in settings
new Setting(container)
    .setName(name)
    .setDesc(`${desc} 🔒 Stored on this device only`)
```

### 1.7 Migration Strategy

**User-Initiated Migration (Not Automatic):**

To avoid surprising users, migration should be opt-in with clear communication:

```typescript
async migrateFromPlainText(): Promise<MigrationResult> {
    if (!this.isAvailable()) {
        return { migrated: false, reason: 'SecretStorage unavailable' };
    }

    // Show confirmation notice to user
    const confirmed = await this.showMigrationConfirmation();
    if (!confirmed) {
        return { migrated: false, reason: 'User declined' };
    }

    const migrations: MigrationEntry[] = [];

    // Migrate main cloud key
    if (this.settings.cloudApiKey) {
        const secretId = PROVIDER_TO_SECRET_ID[this.settings.cloudServiceType];
        await this.setSecret(secretId, this.settings.cloudApiKey);
        this.settings.cloudApiKey = ''; // Clear from plain text
        migrations.push({ field: 'cloudApiKey', secretId });
    }

    // Migrate provider-specific keys
    for (const [provider, config] of Object.entries(this.settings.providerSettings)) {
        if (config?.apiKey) {
            const secretId = PROVIDER_TO_SECRET_ID[provider as AdapterType];
            await this.setSecret(secretId, config.apiKey);
            config.apiKey = '';
            migrations.push({ field: `providerSettings.${provider}`, secretId });
        }
    }

    // Migrate specialized keys (embedding, youtube, pdf, audio)
    // ... similar pattern

    // Show success notice with multi-device warning
    new Notice(this.t.settings.secretStorage.migrationComplete, 8000);

    await this.plugin.saveSettings();
    return { migrated: true, entries: migrations };
}

private async showMigrationConfirmation(): Promise<boolean> {
    // Modal explaining:
    // 1. Keys will be stored in OS keychain (more secure)
    // 2. Keys are device-specific (re-enter on other devices)
    // 3. This action clears keys from synced settings file
    return new Promise((resolve) => {
        const modal = new MigrationConfirmModal(this.app, resolve);
        modal.open();
    });
}
```

### 1.8 Settings UI Updates

**Pattern for SecretComponent Integration:**
```typescript
// In any settings section that handles API keys
private renderApiKeyField(container: HTMLElement, options: ApiKeyFieldOptions): void {
    const { name, desc, secretId, provider, testCallback } = options;
    const secretService = this.plugin.secretStorageService;

    const setting = new Setting(container)
        .setName(name)
        .setDesc(`${desc} 🔒 ${this.t.settings.secretStorage.deviceOnly}`);

    if (secretService.isAvailable()) {
        // Native SecretComponent (Obsidian 1.11+)
        setting.addSecret(secret => secret
            .setSecretId(secretId)
            .setPlaceholder('Enter API key...')
        );
    } else {
        // Fallback: password text field (with user consent)
        setting.addText(text => {
            text.inputEl.type = 'password';
            text.setPlaceholder('Enter API key...');
            // ... existing password field logic
        });
        // Show warning that keys are stored in plain text
        setting.descEl.createEl('span', {
            text: ` ⚠️ ${this.t.settings.secretStorage.fallbackWarning}`,
            cls: 'mod-warning'
        });
    }

    // Add "Test Key" button for validation (since key is hidden)
    if (testCallback) {
        setting.addButton(btn => btn
            .setButtonText(this.t.settings.llm.testConnection)
            .onClick(async () => {
                btn.setDisabled(true);
                btn.setButtonText('Testing...');
                try {
                    const result = await testCallback();
                    if (result.success) {
                        new Notice('✓ API key valid', 3000);
                    } else {
                        new Notice(`✗ ${result.error}`, 5000);
                    }
                } finally {
                    btn.setDisabled(false);
                    btn.setButtonText(this.t.settings.llm.testConnection);
                }
            })
        );
    }
}
```

**Key Status Indicator:**
Since SecretComponent hides actual characters, users need feedback:
```typescript
// Show key status badge
private async renderKeyStatus(container: HTMLElement, secretId: string): Promise<void> {
    const hasKey = await this.plugin.secretStorageService.getSecret(secretId);
    const statusEl = container.createEl('span', {
        cls: hasKey ? 'ai-organiser-key-status-set' : 'ai-organiser-key-status-empty'
    });
    statusEl.setText(hasKey ? '✓ Key configured' : '○ No key set');
}
```

### 1.8 Files to Create/Modify

| File | Action | Status | Description |
|------|--------|--------|-------------|
| `src/core/secretIds.ts` | CREATE | ✅ Done | Secret identifier constants |
| `src/services/secretStorageService.ts` | CREATE | ✅ Done | Main secret management service |
| `src/services/index.ts` | MODIFY | ✅ Done | Export SecretStorageService |
| `src/main.ts` | MODIFY | ✅ Done | Initialize service, offer migration |
| `src/core/settings.ts` | MODIFY | ✅ Done | Add `secretStorageMigrated: boolean` flag |
| `src/ui/modals/MigrationConfirmModal.ts` | CREATE | ✅ Done | Migration confirmation with multi-device warning |
| `src/ui/settings/LLMSettingsSection.ts` | MODIFY | ✅ Done | Use SecretComponent + Test Key button + Migration CTA |
| `src/ui/settings/SemanticSearchSettingsSection.ts` | MODIFY | ✅ Done | Use SecretComponent + status indicator |
| `src/ui/settings/YouTubeSettingsSection.ts` | MODIFY | ✅ Done | Use SecretComponent |
| `src/ui/settings/PDFSettingsSection.ts` | MODIFY | ✅ Done | Use SecretComponent |
| `src/ui/settings/AudioTranscriptionSettingsSection.ts` | MODIFY | ✅ Done | Use SecretComponent |
| `src/ui/settings/BaseSettingSection.ts` | MODIFY | ✅ Done | Add `renderApiKeyField()` helper |
| `src/commands/summarizeCommands.ts` | MODIFY | ✅ Done | Async key resolution via SecretStorage |
| `src/commands/smartNoteCommands.ts` | MODIFY | ✅ Done | Async key resolution via SecretStorage |
| `src/i18n/en.ts` | MODIFY | ✅ Done | secretStorage i18n strings |
| `src/i18n/zh-cn.ts` | MODIFY | ✅ Done | secretStorage i18n strings |
| `tests/secretStorageService.test.ts` | CREATE | ⏳ Pending | Unit tests (30+ tests) |
| `tests/mocks/mockSecretStorage.ts` | CREATE | ⏳ Pending | Mock for CI/CD testing |
| `styles.css` | MODIFY | ⏳ Pending | Add key status indicator styles |

### 1.9 i18n Additions

```typescript
// src/i18n/types.ts - Add to settings section
secretStorage: {
    // Status messages
    deviceOnly: string;           // "Stored on this device only"
    keyConfigured: string;        // "Key configured"
    noKeySet: string;             // "No key set"

    // Migration
    migrationTitle: string;       // "Migrate to Secure Storage"
    migrationDesc: string;        // "Move API keys to your system's secure keychain..."
    migrationWarning: string;     // "Keys are device-specific. You'll need to re-enter on other devices."
    migrationComplete: string;    // "API keys migrated to secure storage"
    migrationDeclined: string;    // "Migration cancelled"

    // Fallback
    fallbackWarning: string;      // "Secure storage unavailable. Keys stored in settings file."
    fallbackConsent: string;      // "I understand keys will be stored in plain text"

    // Cross-plugin
    sharedKeyInfo: string;        // "This key may be shared with other Obsidian plugins"

    // Actions
    testKey: string;              // "Test Key"
    clearFromKeychain: string;    // "Remove from keychain"
    migrateNow: string;           // "Migrate Now"
};
```

### 1.10 Testing Infrastructure

**MockSecretStorage for CI/CD:**
Since real OS keychain is unavailable in CI/CD environments, we need a mock:

```typescript
// tests/mocks/mockSecretStorage.ts
export class MockSecretStorage implements ISecretStorageService {
    private store = new Map<string, string>();

    isAvailable(): boolean {
        return true; // Always available in tests
    }

    async getSecret(id: string): Promise<string | null> {
        return this.store.get(id) || null;
    }

    async setSecret(id: string, value: string): Promise<void> {
        this.store.set(id, value);
    }

    async removeSecret(id: string): Promise<void> {
        this.store.delete(id);
    }

    // Test helpers
    clear(): void {
        this.store.clear();
    }

    getAll(): Map<string, string> {
        return new Map(this.store);
    }
}
```

**Test Scenarios:**
```typescript
describe('SecretStorageService', () => {
    let service: SecretStorageService;
    let mockStorage: MockSecretStorage;

    beforeEach(() => {
        mockStorage = new MockSecretStorage();
        service = new SecretStorageService(mockStorage, mockSettings);
    });

    it('should resolve key via inheritance chain', async () => {
        // Set only main provider key
        await mockStorage.setSecret('openai-api-key', 'sk-main');

        // Embedding key should fall back to main
        const key = await service.resolveApiKey({
            primaryId: PLUGIN_SECRET_IDS.EMBEDDING,
            providerFallback: 'openai',
            useMainKeyFallback: true
        });

        expect(key).toBe('sk-main');
    });

    it('should migrate from plain text', async () => {
        const settings = { cloudApiKey: 'sk-old', cloudServiceType: 'openai' };
        await service.migrateFromPlainText(settings);

        expect(settings.cloudApiKey).toBe(''); // Cleared
        expect(await mockStorage.getSecret('openai-api-key')).toBe('sk-old');
    });

    it('should fall back to settings when storage unavailable', async () => {
        const unavailableService = new SecretStorageService(null, mockSettings);
        mockSettings.cloudApiKey = 'sk-fallback';

        const key = await unavailableService.resolveApiKey({
            providerFallback: 'openai',
            useMainKeyFallback: true
        });

        expect(key).toBe('sk-fallback');
    });
});
```

---

## Phase 2: SettingGroup Integration (MEDIUM PRIORITY)

### 2.1 Problem Statement

**Current State:**
- Custom `createSectionHeader()` in BaseSettingSection
- Manual h1/h2 headers with Lucide icons
- CSS styling in `styles.css`

**Target State:**
- Native SettingGroup API when available
- Consistent styling with other plugins
- Backward compatible with older Obsidian

### 2.2 Wrapper Approach (Non-Breaking)

```typescript
// src/ui/settings/BaseSettingSection.ts
protected createSectionHeader(
    title: string,
    icon: string,
    level: 1 | 2 = 1,
    container?: HTMLElement
): HTMLElement {
    const targetEl = container || this.containerEl;

    // Use native SettingGroup for level 1 headers (Obsidian 1.11+)
    if (this.isSettingGroupAvailable() && level === 1) {
        return this.createNativeSettingGroup(targetEl, title, icon);
    }

    // Fallback to custom implementation
    return this.createCustomHeader(targetEl, title, icon, level);
}

private isSettingGroupAvailable(): boolean {
    // Check if SettingGroup exists in Obsidian API
    return typeof (window as any).SettingGroup !== 'undefined';
}

private createNativeSettingGroup(
    container: HTMLElement,
    title: string,
    icon: string
): HTMLElement {
    const SettingGroup = (window as any).SettingGroup;
    const group = new SettingGroup(container);
    group.setHeading(title);
    if (icon) group.setIcon(icon);
    return group.settingEl;
}

private createCustomHeader(
    container: HTMLElement,
    title: string,
    icon: string,
    level: 1 | 2
): HTMLElement {
    // Existing implementation
    const headerEl = container.createEl(level === 1 ? 'h1' : 'h2', {
        cls: 'ai-organiser-settings-header'
    });
    const iconEl = headerEl.createSpan({ cls: 'ai-organiser-settings-header-icon' });
    setIcon(iconEl, icon);
    headerEl.createSpan({ text: title });
    return headerEl;
}
```

### 2.3 Files to Modify

| File | Action | Description |
|------|--------|-------------|
| `src/ui/settings/BaseSettingSection.ts` | MODIFY | Add SettingGroup wrapper |
| `styles.css` | REVIEW | Keep custom styles as fallback |

### 2.4 Benefits

- **Zero breaking changes** to existing section classes
- **Progressive enhancement** - native API used when available
- **Consistent UX** with other Obsidian plugins
- **Reduced maintenance** - Obsidian handles styling updates

### 2.5 Gestalt UI Preservation Guarantees

**This plan explicitly preserves the existing settings architecture:**

| Gestalt Principle | Current Implementation | After Upgrade |
|-------------------|------------------------|---------------|
| **Proximity** | Related settings grouped in sections | Unchanged - same 14 sections |
| **Similarity** | Consistent h1/h2 headers with icons | Unchanged - same visual hierarchy |
| **Common Region** | Settings grouped by feature area | Unchanged - same section structure |
| **Continuity** | Logical flow: Setup → Core → Advanced | Unchanged - same section order |

**Section Hierarchy Preserved:**
```
1. AI Provider (h1)           ← Setup
2. Tagging (h1)               ← Core feature
3. Summarization (h1)         ← Core feature
   └── YouTube (h2)           ← Input source
   └── Audio (h2)             ← Input source
4. Meeting Minutes (h1)       ← Separate workflow
5. Semantic Search (h1)       ← Advanced feature
6. Integrations (h1)          ← External tools
7. Preferences (h1)           ← Language, Mobile
8. Configuration (h1)         ← Advanced config
```

**API Key Fields Follow Proximity:**
- `renderApiKeyField()` groups: label + input + test button + status indicator
- All in same visual row, not scattered across sections

**No Breaking Changes:**
- `createSectionHeader(title, icon, level)` signature unchanged
- Existing section classes work without modification
- SettingGroup only used for h1 when available (h2 remains custom)
- CSS fallback styles preserved

---

## Phase 3: Bases API Assessment (LOW PRIORITY)

### 3.1 Current Implementation

- Creates `.base` files with YAML configuration
- Uses `AIO_META` constants for frontmatter properties
- No direct Bases plugin API calls
- Works independently (no Bases dependency)

### 3.2 New Bases API Features (v1.10)

- `reduce()`, `html()`, `random()` functions
- Custom view types API
- `open-link` event

### 3.3 Decision: No Changes Needed

**Rationale:**
1. Current file-based approach is robust and sufficient
2. No dependency on Bases plugin installation
3. Dashboard templates work via standard YAML syntax
4. No clear benefit to programmatic API for current use cases

**Future Enhancement (Deferred):**
- Custom "AI Suggestions" view type could leverage Bases API
- Would require Bases plugin as optional dependency

---

## Implementation Schedule

### Week 1: SecretStorage Foundation ✅ COMPLETE

**Day 1-2: Core Infrastructure** ✅
- [x] Create `src/core/secretIds.ts` with all identifiers and PROVIDER_TO_SECRET_ID mapping
- [x] Create `src/services/secretStorageService.ts` interface and implementation
- [ ] Create `tests/mocks/mockSecretStorage.ts` for CI/CD testing
- [x] Add exports to `src/services/index.ts`

**Day 3-4: Integration & Migration** ✅
- [x] Modify `src/main.ts` to initialize SecretStorageService
- [x] Add `secretStorageMigrated` flag to settings
- [x] Create `src/ui/modals/MigrationConfirmModal.ts` with multi-device warning
- [x] Implement user-initiated migration logic (not automatic)

**Day 5: Testing** ⏳ Pending
- [ ] Create `tests/secretStorageService.test.ts` (30+ tests)
- [ ] Test migration scenarios (accept/decline)
- [ ] Test fallback with consent behavior
- [ ] Test inheritance chain resolution

### Week 2: Settings UI + SettingGroup ✅ COMPLETE

**Day 1-2: Settings UI Updates** ✅
- [x] Add `renderApiKeyField()` helper to BaseSettingSection
- [x] Update LLMSettingsSection with SecretComponent + Test Key button + Migration CTA
- [x] Update SemanticSearchSettingsSection with key status indicator
- [x] Update YouTubeSettingsSection, PDFSettingsSection, AudioTranscriptionSettingsSection

**Day 3: SettingGroup Integration** ⏳ Deferred (Phase 2)
- [ ] Modify BaseSettingSection with SettingGroup wrapper
- [ ] Add key status indicator styles to styles.css
- [ ] Review/update existing header styles for conflicts

**Day 4-5: i18n and Testing** ✅
- [x] Add i18n keys for secret storage messages (EN + ZH)
- [ ] Manual testing across Obsidian versions (1.10, 1.11+)
- [ ] Mobile fallback testing (iOS, Android)
- [ ] Multi-device scenario testing

### Week 3: Documentation and Release ⏳ Pending

- [ ] Update CLAUDE.md with SecretStorage architecture
- [ ] Update AGENTS.md with SecretStorage section
- [ ] Update STATUS.md with implementation status
- [ ] Add usertest.md items for secret storage verification
- [ ] Version bump to 1.0.16
- [ ] Deploy and manual smoke test

### Implementation Notes (2026-01-27)

**Completed by external LLM:**
- Core SecretStorageService with `resolveApiKey()` inheritance chain
- Secret identifiers (STANDARD_SECRET_IDS, PLUGIN_SECRET_IDS, PROVIDER_TO_SECRET_ID)
- MigrationConfirmModal with multi-device warning
- renderApiKeyField() with SecretComponent detection and Test Key button
- Settings section updates (LLM, YouTube, PDF, Audio, SemanticSearch)
- Async key resolution in summarizeCommands.ts and smartNoteCommands.ts
- i18n strings (en.ts, zh-cn.ts) for secretStorage section

**Fixed by Claude (TypeScript errors):**
- Added missing `await` on async functions in summarizeCommands.ts (lines 1449, 1660, 2370, 3090)
- Fixed PROVIDER_TO_SECRET_ID type safety in AudioTranscriptionSettingsSection.ts
- Fixed PROVIDER_TO_SECRET_ID type safety in YouTubeSettingsSection.ts

**Build Status:** ✅ Passes (798 tests)

---

## Verification Checklist

### SecretStorage Tests (Manual - Requires Obsidian 1.11+)

- [ ] **Fresh Install**: New user enters key - stored in SecretStorage
- [ ] **Migration Prompt**: Existing user sees migration confirmation modal
- [ ] **Migration Accept**: Keys move to keychain, cleared from data.json
- [ ] **Migration Decline**: Keys remain in data.json, no changes
- [ ] **Fallback with Consent**: SecretStorage unavailable - shows warning, user consents
- [ ] **Cross-Plugin**: Standard key IDs (e.g., `openai-api-key`) readable by other plugins
- [ ] **Mobile Fallback**: Works correctly on iOS/Android with appropriate storage
- [ ] **Inheritance Chain**: Embedding key → provider key → main key resolution
- [ ] **Multi-Device**: Clear "device-only" badge shown in UI
- [ ] **Test Key Button**: Validates key works without showing actual value
- [ ] **Key Status Indicator**: Shows "✓ Key configured" or "○ No key set"

### SettingGroup Tests (Deferred to Phase 2)

- [ ] **Obsidian 1.11+**: Native SettingGroup renders correctly
- [ ] **Older Obsidian**: Custom headers render correctly
- [ ] **Async Sections**: SummarizationSettingsSection maintains order
- [ ] **Styling**: No visual regression

### Integration Tests ✅

- [x] Build passes: `npm run build:quick`
- [x] All tests pass: `npm test` (798 tests)
- [x] i18n parity: EN/ZH complete
- [ ] Deploy and reload Obsidian

---

## Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Multi-device sync expectation** | Medium | Clear UI badge "🔒 Stored on this device only". Migration modal explains device-specific behavior. This is standard security practice. |
| SecretStorage unavailable on mobile | Medium | Fallback to plain-text WITH explicit user consent and warning |
| User downgrades Obsidian | Low | Keys remain in SecretStorage; fallback chain reads from data.json if available |
| SettingGroup styling mismatch | Low | Keep custom CSS as fallback |
| Cross-plugin key conflicts | Low | Use standard key IDs with clear documentation |
| Migration fails mid-process | Medium | Atomic migration with rollback on error |
| User can't verify key is correct | Medium | "Test Key" button validates without revealing value |
| Silent fallback to insecure storage | High | NEVER silent fallback - always show warning and require consent |

---

## SOLID/DRY Compliance

| Principle | Implementation |
|-----------|----------------|
| **SRP** | SecretStorageService handles only secret management |
| **OCP** | New providers added via PROVIDER_TO_SECRET_ID mapping |
| **LSP** | ISecretStorageService interface allows mock implementations |
| **ISP** | Separate interfaces for read/write/migrate operations |
| **DIP** | Settings sections depend on ISecretStorageService, not concrete class |
| **DRY** | Single PROVIDER_TO_SECRET_ID mapping, single renderApiKeyField pattern |

---

## References

- [Obsidian 1.11 Changelog](https://obsidian.md/changelog/2026-01-12-desktop-v1.11.4/)
- [Obsidian API Repository](https://github.com/obsidianmd/obsidian-api)
- [Obsidian Developer Documentation](https://docs.obsidian.md/)
- [SecretStorage Forum Discussion](https://forum.obsidian.md/t/cross-platform-secure-storage-for-secrets-and-tokens-that-can-be-syncd/100716)
