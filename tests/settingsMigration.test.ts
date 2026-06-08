/**
 * Settings Migration Tests
 * Tests for the migrateOldSettings() pure function
 */

import { migrateOldSettings, DEFAULT_SETTINGS } from '../src/core/settings';

describe('migrateOldSettings', () => {
    it('should return null for null input', () => {
        expect(migrateOldSettings(null)).toBeNull();
    });

    it('should migrate ollama serviceType to local', () => {
        const old = {
            serviceType: 'ollama',
            ollamaEndpoint: 'http://localhost:11434',
            ollamaModel: 'llama3'
        };
        const result = migrateOldSettings(old)!;
        expect(result.serviceType).toBe('local');
        expect(result.localEndpoint).toBe('http://localhost:11434');
        expect(result.localModel).toBe('llama3');
        expect(result.ollamaEndpoint).toBeUndefined();
        expect(result.ollamaModel).toBeUndefined();
    });

    it('should migrate old tag range settings to maxTags', () => {
        const old = { tagRangeGenerateMax: 8 } as any;
        const result = migrateOldSettings(old)!;
        expect(result.maxTags).toBe(8);
    });

    it('should use default maxTags when no range settings exist', () => {
        const old = {} as any;
        const result = migrateOldSettings(old)!;
        expect(result.maxTags).toBe(DEFAULT_SETTINGS.maxTags);
    });

    it('should not overwrite existing maxTags', () => {
        const old = { maxTags: 10, tagRangeGenerateMax: 8 } as any;
        const result = migrateOldSettings(old)!;
        expect(result.maxTags).toBe(10);
    });

    it('should migrate old student summary persona to brief', () => {
        const old = { defaultSummaryPersona: 'student' } as any;
        const result = migrateOldSettings(old)!;
        expect(result.defaultSummaryPersona).toBe('brief');
    });

    it('should not change already-migrated summary persona', () => {
        const old = { defaultSummaryPersona: 'brief' } as any;
        const result = migrateOldSettings(old)!;
        expect(result.defaultSummaryPersona).toBe('brief');
    });

    describe('summary length migration', () => {
        it('should migrate comprehensive to detailed', () => {
            const old = { summaryLength: 'comprehensive' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.summaryLength).toBe('detailed');
        });

        it('should migrate detailed to standard', () => {
            const old = { summaryLength: 'detailed' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.summaryLength).toBe('standard');
        });

        it('should not change brief', () => {
            const old = { summaryLength: 'brief' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.summaryLength).toBe('brief');
        });

        it('should not change already-migrated standard', () => {
            const old = { summaryLength: 'standard' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.summaryLength).toBe('standard');
        });

        it('should not double-migrate comprehensive (comprehensive→detailed, not →standard)', () => {
            const old = { summaryLength: 'comprehensive' } as any;
            const result = migrateOldSettings(old)!;
            // comprehensive should become detailed, NOT standard
            expect(result.summaryLength).toBe('detailed');
        });
    });

    describe('brand folder migration (Plan B)', () => {
        it('should seed brandFolderPath from the parent folder of presentationBrandGuidelinesPath', () => {
            const old = { presentationBrandGuidelinesPath: 'AI-Organiser/Config/brand-guidelines.md' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.brandFolderPath).toBe('AI-Organiser/Config');
        });

        it('should handle a nested brand path', () => {
            const old = { presentationBrandGuidelinesPath: 'a/b/c/brand.md' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.brandFolderPath).toBe('a/b/c');
        });

        it('should leave the deprecated field intact (non-destructive)', () => {
            const old = { presentationBrandGuidelinesPath: 'Brand/guidelines.md' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.presentationBrandGuidelinesPath).toBe('Brand/guidelines.md');
        });

        it('should NOT overwrite an already-customised brandFolderPath', () => {
            const old = {
                presentationBrandGuidelinesPath: 'Old/Path/brand.md',
                brandFolderPath: 'My_Brand',
            } as any;
            const result = migrateOldSettings(old)!;
            expect(result.brandFolderPath).toBe('My_Brand');
        });

        it('should seed over the default value when migration source is present', () => {
            const old = {
                presentationBrandGuidelinesPath: 'Corp/Brand/brand-guidelines.md',
                brandFolderPath: '999_Brand', // default — treated as unset
            } as any;
            const result = migrateOldSettings(old)!;
            expect(result.brandFolderPath).toBe('Corp/Brand');
        });

        it('should not seed when the deprecated path is empty', () => {
            const old = { presentationBrandGuidelinesPath: '' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.brandFolderPath).toBeUndefined();
        });

        it('should not seed when the deprecated path is a bare filename (no parent folder)', () => {
            const old = { presentationBrandGuidelinesPath: 'brand-guidelines.md' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.brandFolderPath).toBeUndefined();
        });

        it('should leave brandFolderPath untouched when no migration source exists', () => {
            const old = { maxTags: 5 } as any;
            const result = migrateOldSettings(old)!;
            expect(result.brandFolderPath).toBeUndefined();
        });
    });

    describe('sketch output folder migration', () => {
        it('should migrate legacy full path to subfolder', () => {
            const old = { sketchOutputFolder: 'AI-Organiser/Sketches' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.sketchOutputFolder).toBe('Sketches');
        });

        it('should not change already-migrated sketch folder', () => {
            const old = { sketchOutputFolder: 'Sketches' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.sketchOutputFolder).toBe('Sketches');
        });

        it('should not change custom sketch folder', () => {
            const old = { sketchOutputFolder: 'My Sketches' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.sketchOutputFolder).toBe('My Sketches');
        });
    });

    describe('minutes persona/detailLevel → minutesStyle migration', () => {
        it('should migrate governance persona to detailed style', () => {
            const old = { minutesDefaultPersona: 'governance', minutesDetailLevel: 'standard' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.minutesStyle).toBe('detailed');
            expect(result.minutesDefaultPersona).toBeUndefined();
            expect(result.minutesDetailLevel).toBeUndefined();
        });

        it('should migrate concise detail to smart-brevity style', () => {
            const old = { minutesDefaultPersona: 'standard', minutesDetailLevel: 'concise' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.minutesStyle).toBe('smart-brevity');
        });

        it('should migrate template detail to guided style', () => {
            const old = { minutesDetailLevel: 'template' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.minutesStyle).toBe('guided');
        });

        it('should migrate standard persona + standard detail to standard style', () => {
            const old = { minutesDefaultPersona: 'standard', minutesDetailLevel: 'standard' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.minutesStyle).toBe('standard');
        });

        it('should migrate custom persona to standard style', () => {
            const old = { minutesDefaultPersona: 'my-custom-persona', minutesDetailLevel: 'standard' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.minutesStyle).toBe('standard');
        });

        it('should not migrate if minutesStyle already set', () => {
            const old = { minutesStyle: 'detailed', minutesDefaultPersona: 'standard' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.minutesStyle).toBe('detailed');
            // Old key preserved because migration block was skipped
            expect(result.minutesDefaultPersona).toBe('standard');
        });

        it('should handle missing persona with detail only', () => {
            const old = { minutesDetailLevel: 'detailed' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.minutesStyle).toBe('detailed');
        });

        it('should handle missing detail with persona only', () => {
            const old = { minutesDefaultPersona: 'governance' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.minutesStyle).toBe('detailed');
        });
    });

    describe('audit settings defaults', () => {
        it('should have enableLLMAudit default to false', () => {
            expect(DEFAULT_SETTINGS.enableLLMAudit).toBe(false);
        });

        it('should have auditProvider default to main', () => {
            expect(DEFAULT_SETTINGS.auditProvider).toBe('main');
        });

        it('should have auditModel default to empty string', () => {
            expect(DEFAULT_SETTINGS.auditModel).toBe('');
        });

        it('should preserve existing audit settings during migration', () => {
            const old = {
                enableLLMAudit: true,
                auditProvider: 'claude',
                auditModel: 'claude-opus-4-6'
            } as any;
            const result = migrateOldSettings(old)!;
            expect(result.enableLLMAudit).toBe(true);
            expect(result.auditProvider).toBe('claude');
            expect(result.auditModel).toBe('claude-opus-4-6');
        });

        it('should not add audit settings if not present (handled by DEFAULT_SETTINGS merge)', () => {
            const old = {} as any;
            const result = migrateOldSettings(old)!;
            // migrateOldSettings doesn't add missing keys — that's done by {...DEFAULT_SETTINGS, ...loaded}
            expect(result.enableLLMAudit).toBeUndefined();
        });
    });

    describe('Gemini deprecated-id → latest-* sentinel migration', () => {
        it('migrates gemini-3-pro-preview → latest-pro (discontinued March 2026)', () => {
            const old = { youtubeGeminiModel: 'gemini-3-pro-preview', pdfModel: 'gemini-3-pro-preview' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.youtubeGeminiModel).toBe('latest-pro');
            expect(result.pdfModel).toBe('latest-pro');
        });

        it('migrates gemini-3-flash → latest-flash (never existed on Google API)', () => {
            const old = { youtubeGeminiModel: 'gemini-3-flash', pdfModel: 'gemini-3-flash' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.youtubeGeminiModel).toBe('latest-flash');
            expect(result.pdfModel).toBe('latest-flash');
        });

        it('migrates gemini-3.1-pro → latest-pro (never existed on Google API)', () => {
            const old = { youtubeGeminiModel: 'gemini-3.1-pro', pdfModel: 'gemini-3.1-pro' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.youtubeGeminiModel).toBe('latest-pro');
            expect(result.pdfModel).toBe('latest-pro');
        });

        it('migrates gemini-2.0-flash → latest-flash (deprecated)', () => {
            const old = { youtubeGeminiModel: 'gemini-2.0-flash' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.youtubeGeminiModel).toBe('latest-flash');
        });

        it('migrates gemini-2.0-flash-lite → latest-flash (deprecated)', () => {
            const old = { pdfModel: 'gemini-2.0-flash-lite' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.pdfModel).toBe('latest-flash');
        });

        it('leaves gemini-3.1-pro-preview unchanged (valid Google preview ID)', () => {
            const old = { youtubeGeminiModel: 'gemini-3.1-pro-preview', pdfModel: 'gemini-3.1-pro-preview' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.youtubeGeminiModel).toBe('gemini-3.1-pro-preview');
            expect(result.pdfModel).toBe('gemini-3.1-pro-preview');
        });

        it('leaves gemini-3-flash-preview unchanged (valid Google preview ID)', () => {
            const old = { youtubeGeminiModel: 'gemini-3-flash-preview', pdfModel: 'gemini-3-flash-preview' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.youtubeGeminiModel).toBe('gemini-3-flash-preview');
            expect(result.pdfModel).toBe('gemini-3-flash-preview');
        });

        it('leaves already-sentinel values unchanged', () => {
            const old = { youtubeGeminiModel: 'latest-flash', pdfModel: 'latest-pro' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.youtubeGeminiModel).toBe('latest-flash');
            expect(result.pdfModel).toBe('latest-pro');
        });

        it('should not change empty pdfModel', () => {
            const old = { pdfModel: '' } as any;
            const result = migrateOldSettings(old)!;
            expect(result.pdfModel).toBe('');
        });
    });

    describe('picker taxonomy migration (unified-feature-taxonomy Cluster B)', () => {
        it('copies pickerEssentialsCommandIds → pickerPinnedCommandIds and drops the old key', () => {
            const old = { pickerEssentialsCommandIds: ['chat-with-ai', 'smart-tag'] } as any;
            const result = migrateOldSettings(old)!;
            expect(result.pickerPinnedCommandIds).toEqual(['chat-with-ai', 'smart-tag']);
            expect('pickerEssentialsCommandIds' in result).toBe(false);
        });

        it('new key wins when both old and new are present (idempotent re-run)', () => {
            const old = {
                pickerEssentialsCommandIds: ['old'],
                pickerPinnedCommandIds: ['new'],
            } as any;
            const result = migrateOldSettings(old)!;
            expect(result.pickerPinnedCommandIds).toEqual(['new']);
            expect('pickerEssentialsCommandIds' in result).toBe(false);
        });

        it('remaps expanded category ids (essentials→pinned, manage→maintain) preserving order', () => {
            const old = { pickerExpandedCategoryIds: ['essentials', 'create', 'manage'] } as any;
            const result = migrateOldSettings(old)!;
            expect(result.pickerExpandedCategoryIds).toEqual(['pinned', 'create', 'maintain']);
        });

        it('de-duplicates when a remap collapses two ids onto one', () => {
            const old = { pickerExpandedCategoryIds: ['essentials', 'pinned', 'find'] } as any;
            const result = migrateOldSettings(old)!;
            expect(result.pickerExpandedCategoryIds).toEqual(['pinned', 'find']);
        });

        it('leaves unrecognised expanded ids untouched (harmless — expand nothing)', () => {
            const old = { pickerExpandedCategoryIds: ['find', 'totally-unknown'] } as any;
            const result = migrateOldSettings(old)!;
            expect(result.pickerExpandedCategoryIds).toEqual(['find', 'totally-unknown']);
        });

        it('is a no-op when neither picker key is present', () => {
            const old = { serviceType: 'local' } as any;
            const result = migrateOldSettings(old)!;
            expect('pickerPinnedCommandIds' in result).toBe(false);
        });
    });

    describe('azureCapabilities seeding (flexible Azure config)', () => {
        const caps = (old: any): any => (migrateOldSettings(old)! as any).azureCapabilities;

        it('non-azure user: azureCapabilities stays empty (never consulted off-azure)', () => {
            expect(caps({ cloudServiceType: 'claude' })).toEqual({});
        });

        it('Wärtsilä azure-claude: transcription+embeddings+websearch → azure (preserved)', () => {
            const c = caps({
                cloudServiceType: 'azure-claude',
                azureWhisperDeployment: 'whisper',
                embeddingProvider: 'openai',
                azureDeployments: { embeddings: 'text-embedding-3-large' },
                researchProvider: 'claude-web-search',
            });
            expect(c.transcription).toEqual({ mode: 'azure', deployment: 'whisper' });
            expect(c.embeddings).toEqual({ mode: 'azure', deployment: 'text-embedding-3-large' });
            expect(c.websearch).toEqual({ mode: 'azure' });
            expect(c.tts).toEqual({ mode: 'byo' });        // no azure path historically
            expect(c.youtube).toEqual({ mode: 'byo' });
        });

        it('azure-openai user on Tavily + Gemini embeddings: BYO preserved, not force-azure (G2)', () => {
            const c = caps({ cloudServiceType: 'azure-openai', embeddingProvider: 'gemini', researchProvider: 'tavily' });
            expect(c.embeddings).toEqual({ mode: 'byo' });
            expect(c.websearch).toEqual({ mode: 'byo' });
        });

        it('is idempotent — never clobbers an existing user choice', () => {
            const c = caps({ cloudServiceType: 'azure-claude', azureCapabilities: { transcription: { mode: 'off' } } });
            expect(c.transcription).toEqual({ mode: 'off' });
        });

        it('azureFirstMode (provider not yet azure) still seeds (treated as azure user)', () => {
            const c = caps({ azureFirstMode: true, cloudServiceType: 'claude', embeddingProvider: 'openai' });
            expect(c.transcription?.mode).toBe('azure');
        });
    });

    describe('Azure throttle defaults bump (v2)', () => {
        it('bumps the old defaults (2/10) once when V2 flag absent', () => {
            const r = migrateOldSettings({ azureMaxConcurrentRequests: 2, azureMaxRpm: 10 })!;
            expect(r.azureMaxConcurrentRequests).toBe(4);
            expect(r.azureMaxRpm).toBe(60);
            expect(r.azureThrottleDefaultsV2).toBe(true);
        });
        it('preserves a customised value (does not clobber)', () => {
            const r = migrateOldSettings({ azureMaxConcurrentRequests: 6, azureMaxRpm: 30 })!;
            expect(r.azureMaxConcurrentRequests).toBe(6);
            expect(r.azureMaxRpm).toBe(30);
            expect(r.azureThrottleDefaultsV2).toBe(true);
        });
        it('does not re-bump once V2 flag is set', () => {
            const r = migrateOldSettings({ azureMaxConcurrentRequests: 2, azureMaxRpm: 10, azureThrottleDefaultsV2: true })!;
            expect(r.azureMaxConcurrentRequests).toBe(2);
            expect(r.azureMaxRpm).toBe(10);
        });
    });

    describe('Azure model defaults V3 migration (azure-gated)', () => {
        it('bumps stale azureGPTModel gpt-5.3-chat → gpt-5.5 once', () => {
            const r = migrateOldSettings({ cloudServiceType: 'azure-openai', azureGPTModel: 'gpt-5.3-chat' })!;
            expect(r.azureGPTModel).toBe('gpt-5.5');
            expect(r.azureModelDefaultsV3).toBe(true);
        });
        it('bumps stale taskModels + cloudModel claude-opus-4-6 → claude-opus-4-7', () => {
            const r = migrateOldSettings({
                cloudServiceType: 'azure-claude',
                cloudModel: 'claude-opus-4-6',
                taskModels: { audit: 'claude-opus-4-6', research: 'claude-opus-4-6', tagging: 'claude-sonnet-4-6' },
            })!;
            const tm = r.taskModels as Record<string, string>;
            expect(r.cloudModel).toBe('claude-opus-4-7');
            expect(tm.audit).toBe('claude-opus-4-7');
            expect(tm.research).toBe('claude-opus-4-7');
            // current model untouched
            expect(tm.tagging).toBe('claude-sonnet-4-6');
        });
        it('self-heals an instance left stuck by the old default-true V2 guard', () => {
            // V2 stuck true on disk, model never bumped — V3 (absent) must re-fire.
            const r = migrateOldSettings({ cloudServiceType: 'azure-openai', azureGPTModel: 'gpt-5.3-chat', azureModelDefaultsV2: true })!;
            expect(r.azureGPTModel).toBe('gpt-5.5');
            expect(r.azureModelDefaultsV3).toBe(true);
        });
        it('exact-match only — never touches a custom deployment name', () => {
            const r = migrateOldSettings({ cloudServiceType: 'azure-openai', azureGPTModel: 'my-custom-gpt' })!;
            expect(r.azureGPTModel).toBe('my-custom-gpt');
        });
        it('does not re-bump once the V3 flag is set', () => {
            const r = migrateOldSettings({ cloudServiceType: 'azure-openai', azureGPTModel: 'gpt-5.3-chat', azureModelDefaultsV3: true })!;
            expect(r.azureGPTModel).toBe('gpt-5.3-chat');
        });
        it('does NOT touch a non-Azure user (cloudModel untouched, migration did not fire)', () => {
            const r = migrateOldSettings({ cloudServiceType: 'claude', cloudModel: 'claude-opus-4-6' })!;
            expect(r.cloudModel).toBe('claude-opus-4-6');
            // migration skipped → never set the guard (DEFAULT false is applied later in loadSettings)
            expect(r.azureModelDefaultsV3).toBeUndefined();
        });
        it('seeds the standard per-deployment RPM map when empty (azure)', () => {
            const r = migrateOldSettings({ cloudServiceType: 'azure-claude', azurePerDeploymentRpm: {} })!;
            const rpm = r.azurePerDeploymentRpm as Record<string, number>;
            expect(rpm.whisper).toBe(3);
            expect(rpm['gpt-5.5']).toBe(100);
            expect(rpm['gpt-4o-transcribe']).toBe(10000);
        });
        it('does NOT clobber an existing non-empty per-deployment map', () => {
            const r = migrateOldSettings({ cloudServiceType: 'azure-claude', azurePerDeploymentRpm: { whisper: 99 } })!;
            const rpm = r.azurePerDeploymentRpm as Record<string, number>;
            expect(rpm.whisper).toBe(99);
            expect(rpm['gpt-5.5']).toBeUndefined();
        });
        it('default settings ship the standard per-deployment RPM map', () => {
            expect(DEFAULT_SETTINGS.azurePerDeploymentRpm.whisper).toBe(3);
            expect(DEFAULT_SETTINGS.azurePerDeploymentRpm['claude-sonnet-4-6']).toBe(200);
        });
    });

    describe('per-deck Plan default (storyline vs direct)', () => {
        it('global consultant-mode default is OFF (new decks default to direct)', () => {
            expect(DEFAULT_SETTINGS.presentationConsultantMode).toBe(false);
        });
        it('leaves a user-set consultant mode untouched (it only seeds the per-deck Plan pill)', () => {
            expect(migrateOldSettings({ presentationConsultantMode: true })!.presentationConsultantMode).toBe(true);
            expect(migrateOldSettings({ presentationConsultantMode: false })!.presentationConsultantMode).toBe(false);
        });
    });

    describe('thinking default OFF migration (presentation-depth-controls D3)', () => {
        it('new-install default is "standard" (thinking opt-in)', () => {
            expect(DEFAULT_SETTINGS.claudeThinkingMode).toBe('standard');
            expect(DEFAULT_SETTINGS.thinkingDefaultOffV1).toBe(false);
        });

        it('flips a persisted "adaptive" → "standard" once and sets the guard', () => {
            const r = migrateOldSettings({ claudeThinkingMode: 'adaptive' })!;
            expect(r.claudeThinkingMode).toBe('standard');
            expect(r.thinkingDefaultOffV1).toBe(true);
        });

        it('preserves a deliberate "adaptive" set AFTER the guard is already true (no re-flip)', () => {
            const r = migrateOldSettings({ claudeThinkingMode: 'adaptive', thinkingDefaultOffV1: true })!;
            expect(r.claudeThinkingMode).toBe('adaptive');
            expect(r.thinkingDefaultOffV1).toBe(true);
        });

        it('leaves a persisted "standard" untouched and sets the guard', () => {
            const r = migrateOldSettings({ claudeThinkingMode: 'standard' })!;
            expect(r.claudeThinkingMode).toBe('standard');
            expect(r.thinkingDefaultOffV1).toBe(true);
        });

        it('does not introduce claudeThinkingMode when absent; still sets the guard', () => {
            const r = migrateOldSettings({})!;
            expect(r.claudeThinkingMode).toBeUndefined();
            expect(r.thinkingDefaultOffV1).toBe(true);
        });

        it('is idempotent — a second pass does not re-flip a now-"standard" value', () => {
            const once = migrateOldSettings({ claudeThinkingMode: 'adaptive' })!;
            const twice = migrateOldSettings({ ...once })!;
            expect(twice.claudeThinkingMode).toBe('standard');
            expect(twice.thinkingDefaultOffV1).toBe(true);
        });
    });

});
