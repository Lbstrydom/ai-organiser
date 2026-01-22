# Mobile Optimization Plan

**Date:** January 22, 2026
**Status:** Approved for Implementation
**Priority:** P2 (After Command Consolidation)

---

## Executive Summary

Obsidian Mobile runs in a constrained WebView environment with isolated network permissions, limited RAM, and restricted file access. This plan ensures AI Organiser works reliably on mobile while preserving full functionality on desktop.

---

## Key Constraints

| Constraint | Desktop | Mobile |
|------------|---------|--------|
| `localhost` access | ✅ Works | ❌ Points to phone |
| RAM availability | 8-32GB typical | 2-6GB shared |
| File system access | Full | Vault only |
| Network reliability | High | Variable |
| Battery impact | N/A | Critical |
| Touch interaction | Mouse/keyboard | Finger/gesture |

---

## Implementation Strategy

### 1. LLM Provider Fallback

**Problem:** `localhost:11434` works on desktop (Ollama) but fails on mobile.

**Solution:** Tri-state mobile provider mode with smart detection.

#### Settings Schema

```typescript
// src/core/settings.ts

export interface AIOrganiserSettings {
    // ... existing settings ...

    // Mobile Settings
    mobileProviderMode: 'auto' | 'cloud-only' | 'custom';
    mobileFallbackProvider: 'openai' | 'claude' | 'gemini' | 'groq';
    mobileFallbackModel: string;
    mobileCustomEndpoint: string; // For home server users
}

export const DEFAULT_SETTINGS: Partial<AIOrganiserSettings> = {
    // ... existing defaults ...
    mobileProviderMode: 'auto',
    mobileFallbackProvider: 'openai',
    mobileFallbackModel: 'gpt-4o-mini',
    mobileCustomEndpoint: '',
};
```

#### Detection Logic

```typescript
// src/services/serviceManager.ts (or similar)
import { Platform } from 'obsidian';

function isLocalhostEndpoint(endpoint: string): boolean {
    const lower = endpoint.toLowerCase();
    return lower.includes('localhost') ||
           lower.includes('127.0.0.1') ||
           lower.includes('0.0.0.0');
}

function getEffectiveConfig(settings: AIOrganiserSettings) {
    if (!Platform.isMobile) {
        // Desktop: Use user's settings as-is
        return {
            provider: settings.serviceType === 'local' ? 'local' : settings.cloudServiceType,
            endpoint: settings.localEndpoint,
            model: settings.modelName,
        };
    }

    // Mobile logic
    switch (settings.mobileProviderMode) {
        case 'cloud-only':
            return {
                provider: settings.mobileFallbackProvider,
                model: settings.mobileFallbackModel,
            };

        case 'custom':
            return {
                provider: 'local',
                endpoint: settings.mobileCustomEndpoint,
                model: settings.modelName,
            };

        case 'auto':
        default:
            // Auto-detect: If desktop uses localhost, switch to cloud
            if (settings.serviceType === 'local' && isLocalhostEndpoint(settings.localEndpoint)) {
                console.log('📱 Mobile: Localhost detected, switching to cloud fallback');
                return {
                    provider: settings.mobileFallbackProvider,
                    model: settings.mobileFallbackModel,
                };
            }
            // Otherwise (e.g., home server IP), use desktop settings
            return {
                provider: settings.serviceType === 'local' ? 'local' : settings.cloudServiceType,
                endpoint: settings.localEndpoint,
                model: settings.modelName,
            };
    }
}
```

---

### 2. Vector Search Memory Management

**Problem:** Large Voy indexes can crash mobile apps or drain battery.

| Vault Size | Vectors | Index Size | RAM Footprint | Mobile Safe? |
|------------|---------|------------|---------------|--------------|
| 100 notes | 500 | ~3 MB | ~10 MB | ✅ Safe |
| 1,000 notes | 5,000 | ~30 MB | ~100 MB | ⚠️ Risky |
| 10,000 notes | 50,000 | ~300 MB | ~1 GB | ❌ Crash |

**Solution:** Mobile indexing modes with size guards.

#### Settings Schema

```typescript
// src/core/settings.ts

export interface AIOrganiserSettings {
    // ... existing settings ...

    mobileIndexingMode: 'disabled' | 'read-only' | 'full';
    mobileIndexSizeLimit: number; // MB, default 20
}

export const DEFAULT_SETTINGS: Partial<AIOrganiserSettings> = {
    // ...
    mobileIndexingMode: 'read-only',
    mobileIndexSizeLimit: 20,
};
```

#### Implementation

```typescript
// src/services/vector/voyVectorStore.ts
import { Platform } from 'obsidian';

export class VoyVectorStore {
    async initialize() {
        if (Platform.isMobile) {
            const settings = this.plugin.settings;

            // Check if indexing is disabled on mobile
            if (settings.mobileIndexingMode === 'disabled') {
                console.log('📱 Mobile: Semantic search disabled');
                return;
            }

            // Size guard: Check index file size before loading
            const indexPath = this.getIndexPath();
            const stat = await this.app.vault.adapter.stat(indexPath);

            if (stat && stat.size > settings.mobileIndexSizeLimit * 1024 * 1024) {
                console.log(`📱 Mobile: Index too large (${Math.round(stat.size / 1024 / 1024)}MB), skipping load`);
                new Notice(`Vault index too large for mobile (${Math.round(stat.size / 1024 / 1024)}MB). Use desktop for semantic search.`);
                return;
            }

            // Lazy load on mobile (delay startup)
            setTimeout(() => this.loadIndex(), 3000);
        } else {
            // Desktop: Load immediately
            await this.loadIndex();
        }
    }

    // Disable background indexing on mobile read-only mode
    registerFileEvents() {
        if (Platform.isMobile && this.plugin.settings.mobileIndexingMode === 'read-only') {
            console.log('📱 Mobile: Read-only mode, skipping file event listeners');
            return;
        }

        // Normal event registration for desktop or mobile full mode
        this.plugin.registerEvent(
            this.app.vault.on('modify', this.handleFileModify.bind(this))
        );
        // ... other events
    }
}
```

---

### 3. UI Adaptations

#### 3.1 Tag Network: Graph → List

**Problem:** D3.js force-directed graphs are unusable on touch devices.

**Solution:** Render a simple tag list/cloud on mobile.

```typescript
// src/ui/views/TagNetworkView.ts
import { Platform } from 'obsidian';

export class TagNetworkView extends ItemView {
    async onOpen() {
        if (Platform.isMobile) {
            this.renderMobileTagList();
        } else {
            this.renderD3Graph();
        }
    }

    private renderMobileTagList() {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass('tag-network-mobile');

        container.createEl('h3', { text: 'Top Tags' });

        const tags = this.getTagsWithFrequency();
        const sortedTags = tags.sort((a, b) => b.count - a.count).slice(0, 50);

        const listEl = container.createEl('div', { cls: 'tag-cloud' });

        for (const tag of sortedTags) {
            const tagEl = listEl.createEl('span', {
                cls: 'tag-cloud-item',
                text: `#${tag.name} (${tag.count})`
            });
            tagEl.addEventListener('click', () => {
                // Open search for this tag
                this.app.internalPlugins.getPluginById('global-search')
                    ?.instance.openGlobalSearch(`tag:${tag.name}`);
            });
        }
    }
}
```

#### 3.2 Related Notes: Sidebar → Modal

**Problem:** Sidebars require gestures on mobile and are often hidden.

**Solution:** Open a modal on mobile instead of sidebar view.

```typescript
// src/commands/semanticSearchCommands.ts
import { Platform } from 'obsidian';

plugin.addCommand({
    id: 'show-related-notes',
    name: plugin.t.commands.showRelatedNotes,
    callback: () => {
        if (Platform.isMobile) {
            // Mobile: Open modal for better UX
            new RelatedNotesModal(plugin.app, plugin).open();
        } else {
            // Desktop: Open sidebar view
            plugin.activateView(RELATED_NOTES_VIEW_TYPE);
        }
    }
});
```

#### 3.3 File Pickers: Vault Only

**Problem:** External file access doesn't work on mobile.

**Solution:** Filter out external browsing options on mobile.

```typescript
// src/ui/modals/PdfSelectModal.ts
import { Platform } from 'obsidian';

export class PdfSelectModal extends Modal {
    onOpen() {
        // ... existing code ...

        // External file option - desktop only
        if (!Platform.isMobile) {
            new Setting(contentEl)
                .setName(this.plugin.t.modals.pdfSelect.browseLabel)
                .setDesc(this.plugin.t.modals.pdfSelect.browseDesc)
                .addButton(button => button
                    .setButtonText(this.plugin.t.modals.pdfSelect.browseButton)
                    .onClick(() => this.browseExternalFile()));
        }
    }
}
```

---

### 4. Network Hardening

#### 4.1 Mobile Timeouts

```typescript
// src/services/cloudService.ts or adapters

function getRequestTimeout(): number {
    if (Platform.isMobile) {
        return 60000; // 60 seconds for mobile
    }
    return 30000; // 30 seconds for desktop
}
```

#### 4.2 Data Usage Warnings

```typescript
// src/commands/summarizeCommands.ts

async function summarizeAudio(plugin: AIOrganiserPlugin, filePath: string) {
    const stat = await plugin.app.vault.adapter.stat(filePath);
    const sizeMB = stat ? stat.size / (1024 * 1024) : 0;

    // Warn on mobile for large uploads
    if (Platform.isMobile && sizeMB > 10) {
        const confirmed = await confirmDialog(
            plugin.app,
            `Upload ${sizeMB.toFixed(1)}MB?`,
            `This will upload ${sizeMB.toFixed(1)}MB of audio data. Continue on mobile network?`
        );
        if (!confirmed) return;
    }

    // Proceed with transcription
    // ...
}
```

---

### 5. Settings UI Updates

#### Mobile Settings Section

Add a new section in settings for mobile-specific options.

```typescript
// src/ui/settings/MobileSettingsSection.ts

export class MobileSettingsSection extends BaseSettingSection {
    display(): void {
        this.containerEl.createEl('h1', { text: 'Mobile' });

        // Provider Mode
        new Setting(this.containerEl)
            .setName('Mobile Provider')
            .setDesc('How to handle AI provider on mobile devices')
            .addDropdown(dropdown => dropdown
                .addOption('auto', 'Auto-detect (recommended)')
                .addOption('cloud-only', 'Always use cloud')
                .addOption('custom', 'Custom endpoint')
                .setValue(this.plugin.settings.mobileProviderMode)
                .onChange(async (value) => {
                    this.plugin.settings.mobileProviderMode = value as any;
                    await this.plugin.saveSettings();
                    this.settingsTab.display(); // Refresh to show/hide options
                }));

        // Fallback provider (shown when auto or cloud-only)
        if (this.plugin.settings.mobileProviderMode !== 'custom') {
            new Setting(this.containerEl)
                .setName('Fallback Provider')
                .setDesc('Cloud provider to use on mobile')
                .addDropdown(dropdown => dropdown
                    .addOption('openai', 'OpenAI')
                    .addOption('claude', 'Claude')
                    .addOption('gemini', 'Gemini')
                    .addOption('groq', 'Groq')
                    .setValue(this.plugin.settings.mobileFallbackProvider)
                    .onChange(async (value) => {
                        this.plugin.settings.mobileFallbackProvider = value as any;
                        await this.plugin.saveSettings();
                    }));

            // Warning if API key missing
            const provider = this.plugin.settings.mobileFallbackProvider;
            const hasKey = this.plugin.settings.cloudApiKey ||
                          this.plugin.settings.providerSettings?.[provider]?.apiKey;

            if (!hasKey) {
                const warning = this.containerEl.createEl('div', { cls: 'ai-settings-warning' });
                warning.setText(`⚠️ No API key for ${provider}. Mobile features will fail.`);
            }
        }

        // Custom endpoint (shown when custom mode)
        if (this.plugin.settings.mobileProviderMode === 'custom') {
            new Setting(this.containerEl)
                .setName('Mobile Endpoint')
                .setDesc('Your home server URL (e.g., http://192.168.1.50:11434)')
                .addText(text => text
                    .setValue(this.plugin.settings.mobileCustomEndpoint)
                    .onChange(async (value) => {
                        this.plugin.settings.mobileCustomEndpoint = value;
                        await this.plugin.saveSettings();
                    }));
        }

        // Semantic Search on Mobile
        this.containerEl.createEl('h3', { text: 'Semantic Search' });

        new Setting(this.containerEl)
            .setName('Mobile Indexing')
            .setDesc('How semantic search works on mobile')
            .addDropdown(dropdown => dropdown
                .addOption('read-only', 'Search only (recommended)')
                .addOption('full', 'Full indexing')
                .addOption('disabled', 'Disabled')
                .setValue(this.plugin.settings.mobileIndexingMode)
                .onChange(async (value) => {
                    this.plugin.settings.mobileIndexingMode = value as any;
                    await this.plugin.saveSettings();
                }));

        new Setting(this.containerEl)
            .setName('Index Size Limit')
            .setDesc('Maximum index size to load on mobile (MB)')
            .addSlider(slider => slider
                .setLimits(5, 50, 5)
                .setValue(this.plugin.settings.mobileIndexSizeLimit)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.mobileIndexSizeLimit = value;
                    await this.plugin.saveSettings();
                }));

        // Sync Warning
        const syncWarning = this.containerEl.createEl('div', { cls: 'ai-settings-info' });
        syncWarning.setText('ℹ️ API keys are synced with your vault. Ensure your sync method is secure.');
    }
}
```

---

## Files to Modify

### New Files
- `src/ui/settings/MobileSettingsSection.ts`
- `src/ui/modals/RelatedNotesModal.ts` (mobile version)

### Modified Files
- `src/core/settings.ts` - Add mobile settings fields
- `src/services/vector/voyVectorStore.ts` - Size guards, lazy loading
- `src/services/cloudService.ts` - Mobile timeouts
- `src/ui/views/TagNetworkView.ts` - Mobile list fallback
- `src/ui/views/RelatedNotesView.ts` - Modal dispatch
- `src/ui/modals/PdfSelectModal.ts` - Hide external browse on mobile
- `src/ui/modals/AudioSelectModal.ts` - Hide external browse on mobile
- `src/ui/settings/AIOrganiserSettingTab.ts` - Add mobile section
- `src/commands/summarizeCommands.ts` - Data usage warnings
- `src/i18n/en.ts` - Mobile strings
- `src/i18n/zh-cn.ts` - Mobile strings

---

## i18n Keys to Add

```typescript
settings: {
    mobile: {
        title: "Mobile",
        providerMode: "Mobile Provider",
        providerModeDesc: "How to handle AI provider on mobile",
        auto: "Auto-detect (recommended)",
        cloudOnly: "Always use cloud",
        custom: "Custom endpoint",
        fallbackProvider: "Fallback Provider",
        fallbackProviderDesc: "Cloud provider to use on mobile",
        customEndpoint: "Mobile Endpoint",
        customEndpointDesc: "Your home server URL",
        indexingMode: "Mobile Indexing",
        indexingModeDesc: "How semantic search works on mobile",
        readOnly: "Search only (recommended)",
        full: "Full indexing",
        disabled: "Disabled",
        indexSizeLimit: "Index Size Limit",
        indexSizeLimitDesc: "Maximum index size to load (MB)",
        noApiKeyWarning: "No API key for {provider}. Mobile features will fail.",
        syncWarning: "API keys sync with your vault. Ensure your sync method is secure."
    }
},
messages: {
    mobileIndexTooLarge: "Index too large for mobile ({size}MB). Use desktop for search.",
    mobileDataWarning: "Upload {size}MB on mobile?",
    mobileExternalNotSupported: "External files not supported on mobile. Move file to vault."
}
```

---

## Testing Checklist

### Mobile Provider Fallback
- [ ] Auto mode: Desktop localhost → mobile switches to cloud
- [ ] Auto mode: Desktop home server IP → mobile uses same IP
- [ ] Cloud-only mode: Always uses cloud on mobile
- [ ] Custom mode: Uses specified endpoint
- [ ] Warning shows when fallback provider has no API key

### Vector Search
- [ ] Large index (>20MB) shows warning and doesn't load on mobile
- [ ] Small index loads successfully on mobile
- [ ] Read-only mode: Search works, no background indexing
- [ ] Disabled mode: No vector operations on mobile

### UI Adaptations
- [ ] Tag Network shows list view on mobile
- [ ] Related Notes opens as modal on mobile
- [ ] PDF picker hides external browse on mobile
- [ ] Audio picker hides external browse on mobile

### Network
- [ ] Requests use 60s timeout on mobile
- [ ] Large audio upload shows data warning on mobile

---

## Implementation Priority

| Priority | Task | Effort |
|----------|------|--------|
| P1 | Mobile provider auto-detection | Medium |
| P1 | Settings UI for mobile options | Medium |
| P2 | Vector store size guards | Low |
| P2 | Related Notes modal on mobile | Low |
| P2 | Hide external file browse on mobile | Low |
| P3 | Tag Network list fallback | Medium |
| P3 | Data usage warnings | Low |
| P3 | Extended timeouts | Low |

---

## Success Criteria

1. Plugin loads without crash on iOS/Android
2. AI features work using cloud fallback when local unavailable
3. Semantic search works for vaults <1,000 notes
4. No "localhost connection refused" errors on mobile
5. Battery drain is minimal (no background indexing)
6. All file operations work within vault (no external access attempts)


---

## Updated Documents

- `docs/STATUS.md` - Add a Mobile Optimization section and reflect 56% command reduction.
- `AGENTS.md` - Add Mobile Considerations section with `Platform.isMobile` usage guidance.
- `docs/mobile-optimization-plan.md` - Expand to full spec with settings UI, i18n keys, and tests.

---

## Document Summary for Implementation Team

This spec covers:
- Tri-state mobile provider mode (auto/cloud-only/custom) with localhost detection + cloud fallback.
- Vector store size guard (MB limit), lazy loading on mobile, and read-only indexing.
- Mobile UI adaptations: Tag Network list view, Related Notes modal, vault-only file pickers.
- Network hardening: 60s mobile timeouts and data-usage warnings for large uploads.
- Mobile settings section with provider mode, fallback provider, custom endpoint, indexing mode, and size limit.
- i18n additions and a concrete testing checklist for iOS/Android.
