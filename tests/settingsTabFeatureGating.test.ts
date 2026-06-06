import { describe, it, expect, vi } from 'vitest';

// Stub every settings-section module to a no-op class so the render-spy test
// exercises ONLY the tab's gating logic (renderIfEnabled / empty-umbrella),
// never real section DOM rendering. The tab still builds the real collapsibles.
// NOTE: vi.mock is hoisted — each factory must be self-contained (no shared var).
vi.mock('../src/ui/settings/LLMSettingsSection', () => ({ LLMSettingsSection: class { display() {} } }));
vi.mock('../src/ui/settings/SpecialistProvidersSettingsSection', () => ({ SpecialistProvidersSettingsSection: class { display() {} } }));
vi.mock('../src/ui/settings/TaggingSettingsSection', () => ({ TaggingSettingsSection: class { display() {} } }));
vi.mock('../src/ui/settings/InterfaceSettingsSection', () => ({ InterfaceSettingsSection: class { display() {} } }));
vi.mock('../src/ui/settings/QuickCommandsSettingsSection', () => ({ QuickCommandsSettingsSection: class { display() {} } }));
vi.mock('../src/ui/settings/SummarizationSettingsSection', () => ({ SummarizationSettingsSection: class { display() {} } }));
vi.mock('../src/ui/settings/MinutesSettingsSection', () => ({ MinutesSettingsSection: class { display() {} } }));
vi.mock('../src/ui/settings/ConfigurationSettingsSection', () => ({ ConfigurationSettingsSection: class { display() {} } }));
vi.mock('../src/ui/settings/SemanticSearchSettingsSection', () => ({ SemanticSearchSettingsSection: class { display() {} } }));
vi.mock('../src/ui/settings/MobileSettingsSection', () => ({ MobileSettingsSection: class { display() {} } }));
vi.mock('../src/ui/settings/BasesSettingsSection', () => ({ BasesSettingsSection: class { display() {} } }));
vi.mock('../src/ui/settings/NotebookLMSettingsSection', () => ({ NotebookLMSettingsSection: class { display() {} } }));
vi.mock('../src/ui/settings/AudioTranscriptionSettingsSection', () => ({ AudioTranscriptionSettingsSection: class { display() {} } }));
vi.mock('../src/ui/settings/AudioNarrationSettingsSection', () => ({ AudioNarrationSettingsSection: class { display() {} } }));
vi.mock('../src/ui/settings/ExportSettingsSection', () => ({ ExportSettingsSection: class { display() {} } }));
vi.mock('../src/ui/settings/NewsletterSettingsSection', () => ({ NewsletterSettingsSection: class { display() {} } }));
vi.mock('../src/ui/settings/CanvasSettingsSection', () => ({ CanvasSettingsSection: class { display() {} } }));
vi.mock('../src/ui/settings/KindleSettingsSection', () => ({ KindleSettingsSection: class { display() {} } }));
vi.mock('../src/ui/settings/DigitisationSettingsSection', () => ({ DigitisationSettingsSection: class { display() {} } }));
vi.mock('../src/ui/settings/SketchSettingsSection', () => ({ SketchSettingsSection: class { display() {} } }));
vi.mock('../src/ui/settings/ResearchSettingsSection', () => ({ ResearchSettingsSection: class { display() {} } }));
vi.mock('../src/ui/settings/MermaidChatSettingsSection', () => ({ MermaidChatSettingsSection: class { display() {} } }));
vi.mock('../src/ui/settings/AIChatSettingsSection', () => ({ AIChatSettingsSection: class { display() {} } }));
vi.mock('../src/ui/settings/BrandSettingsSection', () => ({ BrandSettingsSection: class { display() {} } }));
// Features control panel renders OUTSIDE renderIfEnabled (it is the gate) — stub it too so
// the render-spy exercises only the tab's gating logic.
vi.mock('../src/ui/settings/FeaturesSettingsSection', () => ({ FeaturesSettingsSection: class { display() {} } }));

import { AIOrganiserSettingTab } from '../src/ui/settings/AIOrganiserSettingTab';
import { SECTION_FEATURE, INFRA_SECTIONS, FEATURE_REGISTRY } from '../src/core/features';
import { en } from '../src/i18n/en';

function makeTab(featureFlags: Record<string, boolean>): { tab: AIOrganiserSettingTab; captured: string[] } {
    const plugin = { settings: { featureFlags }, t: en } as never;
    const tab = new AIOrganiserSettingTab({} as never, plugin);
    const captured: string[] = [];
    tab.sectionRenderSpy = (id) => captured.push(id);
    return { tab, captured };
}

async function runDisplay(tab: AIOrganiserSettingTab): Promise<void> {
    await (tab as unknown as { displayAsync(): Promise<void> }).displayAsync();
}

const allEnabled = (): Record<string, boolean> => {
    const f: Record<string, boolean> = {};
    for (const def of FEATURE_REGISTRY) if (!def.core) f[def.id] = true;
    return f;
};

const expectedIds = new Set<string>([...Object.keys(SECTION_FEATURE), ...INFRA_SECTIONS]);

describe('AIOrganiserSettingTab render-spy (FT-4 completeness invariant (d))', () => {
    it('the captured section ids exactly equal SECTION_FEATURE keys ∪ INFRA_SECTIONS', async () => {
        const { tab, captured } = makeTab(allEnabled());
        await runDisplay(tab);
        expect(new Set(captured)).toEqual(expectedIds);
    });

    it('no captured id is an orphan (every rendered section has a feature owner or is infra)', async () => {
        const { tab, captured } = makeTab(allEnabled());
        await runDisplay(tab);
        for (const id of captured) {
            expect(expectedIds.has(id), `orphan section id '${id}'`).toBe(true);
        }
    });

    it('the spy records every section regardless of enabled state (guard records before gating)', async () => {
        // All non-core features OFF → far fewer sections actually render, but the
        // spy must still observe the full id set (renderIfEnabled records first).
        const { tab, captured } = makeTab({});
        await runDisplay(tab);
        expect(new Set(captured)).toEqual(expectedIds);
    });
});
