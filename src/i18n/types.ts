import type { RefineErrorCode } from '../services/chat/refineDeckIrSelectiveTypes';
import type { GuidanceCode, GuidanceEntry } from '../core/friendlyErrors';
import type { SetupReason } from '../core/setupState';

export interface Translations {
    // Features settings section (feature-toggle UI). Per-feature label/desc keyed by
    // FeatureId — the registry's labelKey/descKey point here (i18n is the SSOT for copy).
    features: {
        title: string;
        desc: string;
        alwaysOn: string;
        reloadNotice: string;
        reloadPending: string;
        alsoEnabled: string;            // "Also enabled: {features}"
        disableConfirmTitle: string;
        disableConfirmBody: string;     // "...{feature}...{dependents}"
        disableConfirmConfirm: string;
        cancel: string;
        intro: string;
        saveError: string;
        managedInFeatures: string;      // hint shown inside a feature's own section
        /** Settings-only group labels (the workflow-stage groups use top-level `workflowStages.*`). */
        clusters: {
            core: string;
            integrations: string;
        };
        provider: { label: string; desc: string };
        tagging: { label: string; desc: string };
        chat: { label: string; desc: string };
        summarize: { label: string; desc: string };
        translate: { label: string; desc: string };
        'smart-note': { label: string; desc: string };
        presentation: { label: string; desc: string };
        minutes: { label: string; desc: string };
        'audio-narration': { label: string; desc: string };
        'semantic-search': { label: string; desc: string };
        'visual-search': { label: string; desc: string };
        research: { label: string; desc: string };
        'web-reader': { label: string; desc: string };
        'quick-peek': { label: string; desc: string };
        canvas: { label: string; desc: string };
        'mermaid-chat': { label: string; desc: string };
        flashcards: { label: string; desc: string };
        digitisation: { label: string; desc: string };
        sketch: { label: string; desc: string };
        kindle: { label: string; desc: string };
        newsletter: { label: string; desc: string };
        notebooklm: { label: string; desc: string };
        bases: { label: string; desc: string };
        export: { label: string; desc: string };
        'embed-scan': { label: string; desc: string };
        'agent-index': { label: string; desc: string };
        'cloud-inventory': { label: string; desc: string };
        'cloud-offload': { label: string; desc: string };
        'inbox-sweep': { label: string; desc: string };
        'capture-inbox': { label: string; desc: string };
        'google-tasks-export': { label: string; desc: string };
        'vault-upkeep': { label: string; desc: string };
        'agent-connectors': { label: string; desc: string };
        'onedrive-link': { label: string; desc: string };
    };
    // Shared workflow-stage labels — the unified taxonomy vocabulary used by BOTH the
    // Features settings groups and the Command Picker top-level categories (one SSOT).
    workflowStages: {
        capture: string;
        create: string;
        refine: string;
        find: string;
        maintain: string;
    };
    // Settings sections
    settings: {
        llm: {
            title: string;
            serviceType: string;
            serviceTypeDesc: string;
            cloudProvider: string;
            cloudProviderDesc: string;
            localEndpoint: string;
            localEndpointDesc: string;
            modelName: string;
            modelNameDesc: string;
            apiEndpoint: string;
            apiEndpointDesc: string;
            apiKey: string;
            apiKeyDesc: string;
            connectionTest: string;
            connectionTestDesc: string;
            testConnection: string;
            testing: string;
            connectionSuccessful: string;
            connectionFailed: string;
            debugMode: string;
            debugModeDesc: string;
            debugEnabled: string;
            debugDisabled: string;
            tipsPopularTools: string;
            providerCapabilities: {
                title: string;
                youtube: string;
                audio: string;
                pdf: string;
                embeddings: string;
                narration: string;
            };
            thinkingMode: string;
            thinkingModeDesc: string;
            thinkingStandard: string;
            thinkingAdaptive: string;
            gettingStarted: {
                title: string;
                claudeDesc: string;
                otherProviders: string;
                viewAllProviders: string;
                apiKeyLink: string;
            };
            localRecommendation: {
                title: string;
                description: string;
                setupWizard: string;
            };
            azure: {
                firstMode: string;
                firstModeDesc: string;
                banner: string;
                foundryHeading: string;
                apiKey: string;
                apiKeyDesc: string;
                apiKeyPlaceholder: string;
                aiEndpoint: string;
                aiEndpointDesc: string;
                openAIEndpoint: string;
                openAIEndpointDesc: string;
                whisperDeployment: string;
                whisperDeploymentDesc: string;
                whisperDeploymentPlaceholder: string;
                defaultModel: string;
                defaultModelDesc: string;
                modelSonnet55: string;
                modelOpus55: string;
                modelSonnet: string;
                modelOpus: string;
                modelCustom: string;
                customModelName: string;
                customModelNameDesc: string;
                customModelNamePlaceholder: string;
                configTransfer: string;
                configTransferDesc: string;
                exportButton: string;
                importButton: string;
                exportCopied: string;
                exportCopyFailed: string;
                importInvalidJson: string;
                importNoFields: string;
                importApplied: string;
                importModalHeading: string;
                importModalDesc: string;
                importModalApplyButton: string;
                testConfig: string;
                testConfigDesc: string;
                testButton: string;
                testingButton: string;
                configInvalid: string;
                configOkWarnings: string;
                configValid: string;
                liveTestHeading: string;
                surfaceClaude: string;
                surfaceOpenAIChat: string;
                surfaceEmbeddings: string;
                surfaceWhisper: string;
                surfaceTts: string;
                surfaceSpeechTts: string;
                surfaceSpeechStt: string;
                surfaceWebsearch: string;
                embeddingModel: string;
                embeddingModelDesc: string;
                embeddingModelPlaceholder: string;
                gptModel: string;
                gptModelDesc: string;
                gptModelPlaceholder: string;
                maxConcurrent: string;
                maxConcurrentDesc: string;
                maxRpm: string;
                maxRpmDesc: string;
                routingMode: string;
                routingModeDesc: string;
                routingModel: string;
                routingDeployment: string;
                chatDeployment: string;
                chatDeploymentDesc: string;
                embeddingsDeployment: string;
                embeddingsDeploymentDesc: string;
                claudeViaGateway: string;
                claudeViaGatewayDesc: string;
                gatewayAdviceTitle: string;
                gatewayAdviceIntro: string;
                gatewayFixRouting: string;
                gatewayFixClaude: string;
                gatewayFixChatDeployment: string;
                gatewayFixEmbeddingsDeployment: string;
                gatewayAdviceApply: string;
                gatewayAdviceDismiss: string;
                gatewayAdviceApplied: string;
                gatewayAdviceTestHint: string;
                mainProviderChoice: string;
                mainProviderChoiceDesc: string;
                providerAzureClaude: string;
                providerAzureOpenAI: string;
                useDifferentProvider: string;
                handledByAzureHeading: string;
                handledByAzureDesc: string;
                autoAudio: string;
                autoPdf: string;
                autoEmbeddings: string;
                youtubeSeparateNote: string;
                perDeploymentRpm: string;
                perDeploymentRpmDesc: string;
                perDeploymentRpmActiveLabel: string;
                perDeploymentRpmActiveNone: string;
                perDeploymentRpmMissingWarning: string;
                perDeploymentRpmNamePlaceholder: string;
                perDeploymentRpmValuePlaceholder: string;
                perDeploymentRpmAdd: string;
                perDeploymentRpmRemove: string;
            };
        };
        tagging: {
            title: string;
            maxTags: string;
            maxTagsDesc: string;
            outputLanguage: string;
            outputLanguageDesc: string;
            autoEnsureNoteStructure: {
                name: string;
                description: string;
            };
            fileExclusion: string;
            excludedFiles: string;
            excludedFilesDesc: string;
            manage: string;
            noExclusions: string;
            patternsConfigured: string;
            taxonomyEnforcement: string;
            enableGuardrail: string;
            enableGuardrailDesc: string;
            autoAddNovel: string;
            autoAddNovelDesc: string;
        };
        support: {
            title: string;
            description: string;
            supportText: string;
            buyMeACoffee: string;
            buyCoffee: string;
        };
        interface: {
            title: string;
            language: string;
            languageDesc: string;
            outputLanguage: string;
            outputLanguageDesc: string;
            // Command picker — Essentials customisation (added 2026-05-02)
            pinnedTitle: string;
            pinnedDesc: string;
            pinnedAddButton: string;
            pinnedRemoveAria: string;
            pinnedLimitNotice: string;
            pinnedResetButton: string;
            pinnedPickerPlaceholder: string;
            pinnedEmpty: string;
        };
        summarization: {
            title: string;
            enableFeature: string;
            enableFeatureDesc: string;
            outputOptions: string;
            length: string;
            lengthDesc: string;
            brief: string;
            standard: string;
            detailed: string;
            includeMetadata: string;
            includeMetadataDesc: string;
            language: string;
            languageDesc: string;
            defaultPersona: string;
            defaultPersonaDesc: string;
            editPersonas: string;
            editPersonasDesc: string;
            openPersonasFile: string;
            multiSourceDocuments: string;
            multiSourceMaxDocumentChars: string;
            multiSourceMaxDocumentCharsDesc: string;
            multiSourceOversizedBehavior: string;
            multiSourceOversizedBehaviorDesc: string;
            multiSourceOversizedAsk: string;
            multiSourceOversizedTruncate: string;
            multiSourceOversizedFull: string;
            transcriptOptions: string;
            saveTranscripts: string;
            saveTranscriptsDesc: string;
            transcriptNone: string;
            transcriptFile: string;
            transcriptFolder: string;
            transcriptFolderDesc: string;
            advancedOptions: string;
            timeout: string;
            timeoutDesc: string;
            resetToDefault: string;
            enableCompanion: string;
            enableCompanionDesc: string;
            webReaderOutputFolder: string;
            webReaderOutputFolderDesc: string;
            azureFastModel: string;
            azureFastModelDesc: string;
            azureFastModelOpenAIPlaceholder: string;
            azureFastModelClaudePlaceholder: string;
        };
        minutes: {
            title: string;
            description: string;
            outputFolder: string;
            outputFolderDesc: string;
            defaultTimezone: string;
            defaultTimezoneDesc: string;
            obsidianTasks: string;
            obsidianTasksDesc: string;
            maxDocumentChars: string;
            maxDocumentCharsDesc: string;
            oversizedBehavior: string;
            oversizedBehaviorDesc: string;
            oversizedAsk: string;
            oversizedTruncate: string;
            oversizedFull: string;
            gtdOverlay: string;
            gtdOverlayDesc: string;
            // Phase 2 TRA: Style system
            style: string;
            styleDesc: string;
            styleSmartBrevity: string;
            styleStandard: string;
            styleDetailed: string;
            styleGuided: string;
            // Phase 4 TRA: Speaker labelling
            speakerLabelling: string;
            speakerLabellingDesc: string;
            // Phase 4 TRA: Diarisation placeholder
            diarisationProvider: string;
            diarisationProviderDesc: string;
            diarisationNone: string;
            diarisationAssemblyAI: string;
            diarisationDeepgram: string;
        };
        kindle: {
            title: string;
            description: string;
            region: string;
            regionDesc: string;
            regionChangedCookiesCleared: string;
            amazonAccount: string;
            loginButton: string;
            logoutButton: string;
            connected: string;
            notConnected: string;
            outputFolder: string;
            outputFolderDesc: string;
            highlightStyle: string;
            highlightStyleDesc: string;
            groupByColor: string;
            groupByColorDesc: string;
            includeCoverImage: string;
            includeCoverImageDesc: string;
            autoTag: string;
            autoTagDesc: string;
            cookieAge: string;
            cookieAgeStale: string;
            desktopSignIn: string;
            reAuth: string;
            amazonEmail: string;
            amazonEmailDesc: string;
            amazonPassword: string;
            amazonPasswordDesc: string;
            credentialsSaved: string;
            credentialsCleared: string;
        };
        azureCapabilities: {
            title: string;
            description: string;
            modeAzure: string;
            modeByo: string;
            modeOff: string;
            deploymentLabel: string;
            deploymentPlaceholder: string;
            statusHas: string;
            statusPartial: string;
            statusNone: string;
            byoConfigured: string;
            byoNotConfigured: string;
            transcription: string; transcriptionDesc: string;
            embeddings: string; embeddingsDesc: string;
            visualEmbeddings: string; visualEmbeddingsDesc: string;
            websearch: string; websearchDesc: string;
            tts: string; ttsDesc: string;
            youtube: string; youtubeDesc: string;
        };
        azureSpeech: {
            title: string;
            description: string;
            region: string; regionDesc: string; regionPlaceholder: string;
            endpoint: string; endpointDesc: string; endpointPlaceholder: string;
            deriveEndpoint: string; deriveEndpointDesc: string; deriveEndpointDone: string;
            apiKey: string; apiKeyDesc: string; apiKeyNoSecretStorage: string;
            voice: string; voiceDesc: string; voicePlaceholder: string;
            browseVoices: string; voicePickerPlaceholder: string; voicePicked: string;
            maxSpeakers: string; maxSpeakersDesc: string;
            strictMode: string; strictModeDesc: string;
            legacyGlobalStandardNotice: string;
            strictUnavailableNotice: string;
            reasonNoRegion: string;
            reasonNoEndpoint: string;
            reasonNoKey: string;
            reasonNoVoice: string;
            reasonStrictRequired: string;
            gptAudioRequiresNonAzure: string;
            notAzureMode: string;
            voicesLoading: string;
            voicesError: string;
            voicesEmpty: string;
            voicesRetry: string;
            chunkedSpeakersDisclosure: string;
        };
        visualSearch: {
            title: string;
            description: string;
            consentHeading: string;
            consentIndexing: string;
            consentPageText: string;
            consentSynthesisImages: string;
            enableButton: string;
            disableButton: string;
            autoEnabled: string;
            statusEnabledAzure: string;
            statusEnabledNative: string;
            statusDisabled: string;
            statusMissingKey: string;
            statusNoDeployment: string;
            statusNoEndpoint: string;
            statusNoKey: string;
            statusOff: string;
            statusAzureUnsupportedNoByo: string;
            statusProbeNeeded: string;
            statusProbeRunning: string;
            statusNeedsRebuild: string;
            statusIndexing: string;
            probeButton: string;
            probeSupported: string;
            probeUnsupported: string;
            probeRetry: string;
            byoKeyName: string;
            byoKeyDesc: string;
            pageTextToggle: string;
            pageTextToggleDesc: string;
            synthesisImagesToggle: string;
            synthesisImagesToggleDesc: string;
            dimLabel: string;
            dimDesc: string;
            maxPagesLabel: string;
            maxPagesDesc: string;
            pptGuidance: string;
        };
        research: {
            title: string;
            provider: string;
            providerDesc: string;
            azureWebSearchNote: string;
            apiKey: string;
            apiKeyDesc: string;
            tavilyInfo: string;
            testConnection: string;
            testConnectionSuccess: string;
            testConnectionFailed: string;
            preferredSitesHeader: string;
            preferredSites: string;
            preferredSitesDesc: string;
            excludedSites: string;
            excludedSitesDesc: string;
            outputHeader: string;
            outputFolder: string;
            outputFolderDesc: string;
            defaultOutput: string;
            defaultOutputDesc: string;
            includeCitations: string;
            includeCitationsDesc: string;
            brightDataSection: string;
            brightDataInfo: string;
            serpKey: string;
            serpKeyDesc: string;
            webUnlockerKey: string;
            webUnlockerKeyDesc: string;
            scrapingBrowserUrl: string;
            scrapingBrowserDesc: string;
            budgetSection: string;
            qualitySection: string;
            smartSection: string;
            integrationsSection: string;
            monthlyBudget: string;
            monthlyBudgetDesc: string;
            warnThreshold: string;
            warnThresholdDesc: string;
            blockAtLimit: string;
            blockAtLimitDesc: string;
            currentUsage: string;
            resetUsage: string;
            resetUsageConfirm: string;
            resetUsageSuccess: string;
            qualityScoring: string;
            qualityScoringDesc: string;
            citationStyle: string;
            citationStyleDesc: string;
            citationNumeric: string;
            citationAuthorYear: string;
            vaultPrecheck: string;
            vaultPrecheckDesc: string;
            vaultPrecheckSimilarity: string;
            vaultPrecheckSimilarityDesc: string;
            perspectives: string;
            perspectivesDesc: string;
            perspectivePreset: string;
            perspectiveCustom: string;
            perspectiveCustomDesc: string;
            streaming: string;
            streamingDesc: string;
            claudeWebSearch: string;
            claudeWebSearchKeyDesc: string;
            claudeWebSearchInfo: string;
            useMainClaudeKey: string;
            keyCopied: string;
            noMainKey: string;
            claudeMaxSearches: string;
            claudeMaxSearchesDesc: string;
            claudeDynamicFiltering: string;
            claudeDynamicFilteringDesc: string;
            zotero: string;
            zoteroDesc: string;
            zoteroCollection: string;
            zoteroCollectionDesc: string;
        };
        configuration: {
            title: string;
            outputRootFolder: string;
            outputRootFolderDesc: string;
            useConfigFiles: string;
            useConfigFilesDesc: string;
            configFolder: string;
            configFolderDesc: string;
            openConfigFolder: string;
            createConfigFiles: string;
            configFilesCreated: string;
            resetToDefaults: string;
            resetConfirm: string;
            suggestThemes: string;
            suggestDisciplines: string;
            analyzing: string;
        };
        aichat: {
            chatRootFolderTitle: string;
            chatRootFolderDesc: string;
            enablePersistenceTitle: string;
            enablePersistenceDesc: string;
            enableCompactionTitle: string;
            enableCompactionDesc: string;
            chatRetentionTitle: string;
            chatRetentionDesc: string;
            globalMemoryTitle: string;
            globalMemoryDesc: string;
            globalMemoryEdit: string;
            globalMemoryCount: string;
            globalMemoryCountEmpty: string;
            presentationOutputFolderTitle: string;
            presentationOutputFolderDesc: string;
            presentationBrandGuidelinesTitle: string;
            presentationBrandGuidelinesDesc: string;
            refinementPassesTitle: string;
            refinementPassesDesc: string;
            brandToggleDefaultTitle: string;
            brandToggleDefaultDesc: string;
            groundWebSearchTitle: string;
            groundWebSearchDesc: string;
            brandConfigMoved: string;
        };
        brand: {
            title: string;
            description: string;
            folderPathTitle: string;
            folderPathDesc: string;
            onBrandDefaultTitle: string;
            onBrandDefaultDesc: string;
            resolvedFontTitle: string;
            resolvedFontDesc: string;
            minFontLabel: string;
            statusHeading: string;
            statusChecking: string;
            statusNotConfigured: string;
            statusPartial: string;
            statusOk: string;
            statusInvalid: string;
            checkGuidelines: string;
            checkGuidelinesMissing: string;
            checkLogo: string;
            checkLogoMissing: string;
            checkIcons: string;
            checkIconsMissing: string;
            checkFonts: string;
            checkFontsMissing: string;
            usingExample: string;
            minFontHeading: string;
            minFontDesc: string;
            minFontBodyTitle: string;
            minFontCaptionTitle: string;
            minFontTableTitle: string;
            setupGuideText: string;
        };
        semanticSearch: {
            title: string;
            description: string;
            enableSemanticSearch: {
                name: string;
                description: string;
            };
            enableToConfigureMessage: string;
            embeddingProvider: {
                name: string;
                description: string;
            };
            embeddingModel: {
                name: string;
                description: string;
            };
            embeddingApiKey: {
                name: string;
                description: string;
            };
            embeddingEndpoint: {
                name: string;
                description: string;
            };
            indexing: {
                title: string;
            };
            autoIndexNewNotes: {
                name: string;
                description: string;
            };
            indexAttachmentText: {
                name: string;
                description: string;
            };
            maxAttachmentCharsPerNote: {
                name: string;
                description: string;
            };
            useSharedExcludedFolders: {
                name: string;
                description: string;
            };
            indexExcludedFolders: {
                name: string;
                description: string;
            };
            usingTaggingExclusions: string;
            chunkSize: {
                name: string;
                description: string;
            };
            chunkOverlap: {
                name: string;
                description: string;
            };
            maxChunksPerNote: {
                name: string;
                description: string;
            };
            manageIndexAction: string;
            manageIndexActionDesc: string;
            manageIndexButton: string;
            rag: {
                title: string;
            };
            enableVaultChat: {
                name: string;
                description: string;
            };
            enableVaultChatForRag: string;
            ragContextChunks: {
                name: string;
                description: string;
            };
            ragIncludeMetadata: {
                name: string;
                description: string;
            };
            relatedNotesCount: {
                name: string;
                description: string;
            };
            chatExportFolder: string;
            chatExportFolderDesc: string;
            testConnection: string;
            testing: string;
            connectionSuccessful: string;
            connectionFailed: string;
            localSetup: string;
            localSetupDesc: string;
            openLocalSetup: string;
            localOnnxLabel: string;
            localOnnxDesc: string;
            localOnnxRecommendation: string;
            localOnnxSwitchButton: string;
            localOnnxReady: string;
            localOnnxConsentToggleName: string;
            localOnnxConsentToggleDesc: string;
            localOnnxConsentSaveFailed: string;
            localOnnxNotConsentedBanner: string;
            localOnnxNotConsentedBannerButton: string;
        };
        mobile: {
            title: string;
            description: string;
            providerMode: string;
            providerModeDesc: string;
            providerAuto: string;
            providerCloudOnly: string;
            providerCustom: string;
            fallbackProvider: string;
            fallbackProviderDesc: string;
            fallbackModel: string;
            fallbackModelDesc: string;
            customEndpoint: string;
            customEndpointDesc: string;
            indexMode: string;
            indexModeDesc: string;
            indexDisabled: string;
            indexReadOnly: string;
            indexFull: string;
            indexSizeLimit: string;
            indexSizeLimitDesc: string;
            desktopOnlyNote: string;
            azureAutomatic: string;
        };
        captureInput: {
            title: string;
        };
        vaultIntelligence: {
            title: string;
        };
        preferences: {
            title: string;
        };
        integrations: {
            title: string;
            description: string;
        };
        bases: {
            title: string;
            description: string;
            enableStructuredMetadata: string;
            enableStructuredMetadataDesc: string;
            includeModelInMetadata: string;
            includeModelInMetadataDesc: string;
            autoDetectContentType: string;
            autoDetectContentTypeDesc: string;
            infoTitle: string;
            info1: string;
            info2: string;
            info3: string;
            migrateAction: string;
            migrateActionDesc: string;
            migrateButton: string;
            dashboardAction: string;
            dashboardActionDesc: string;
            dashboardButton: string;
            dashboardInfo: string;
            editTemplates: string;
            editTemplatesDesc: string;
            editTemplatesButton: string;
        };
        export: {
            title: string;
            description: string;
            outputFolder: string;
            outputFolderDesc: string;
            flashcardProvider: string;
            flashcardProviderDesc: string;
            flashcardProviderMain: string;
            flashcardModel: string;
            flashcardModelDesc: string;
            themeHeader: string;
            colorScheme: string;
            colorSchemeDesc: string;
            colorSchemeCustom: string;
            primaryColor: string;
            primaryColorDesc: string;
            accentColor: string;
            accentColorDesc: string;
            fontFace: string;
            fontFaceDesc: string;
            fontSize: string;
            fontSizeDesc: string;
        };
        newsletter: {
            title: string;
            description: string;
            enabled: string;
            enabledDesc: string;
            source: string;
            sourceAppsScript: string;
            sourceGmailApi: string;
            scriptUrl: string;
            scriptUrlDesc: string;
            scriptUrlPlaceholder: string;
            copyTemplate: string;
            copyTemplateSuccess: string;
            outputFolder: string;
            outputFolderDesc: string;
            autoTag: string;
            autoTagDesc: string;
            fetchNow: string;
            fetching: string;
            fetchSuccess: string;
            fetchEmpty: string;
            fetchError: string;
            setupTitle: string;
            setupStep1: string;
            setupStep2: string;
            setupStep3: string;
            setupStep4: string;
            notEnabled: string;
            noScriptUrl: string;
            autoFetch: string;
            autoFetchDesc: string;
            autoFetchInterval: string;
            autoFetchIntervalDesc: string;
            autoFetchInterval30min: string;
            autoFetchInterval1h: string;
            autoFetchInterval2h: string;
            autoFetchInterval6h: string;
            autoFetchInterval12h: string;
            autoFetchInterval24h: string;
            gmailLabel: string;
            gmailLabelDesc: string;
            fetchLimit: string;
            fetchLimitDesc: string;
            hitLimitWarning: string;
            testConnection: string;
            testConnectionConnected: string;
            testConnectionEmpty: string;
            testConnectionFailed: string;
            lastFetched: string;
            lastFetchedNever: string;
            resetHistory: string;
            resetHistoryDesc: string;
            resetHistoryDone: string;
            preferredLanguage: string;
            preferredLanguageDesc: string;
            dailyBrief: string;
            dailyBriefDesc: string;
            audioPodcast: string;
            audioPodcastDesc: string;
            audioPodcastOffNotice: string;
            audioRegenerating: string;
            audioRegenerated: string;
            audioRegenerateFailed: string;
            audioRegenerateForToday: string;
            audioRegenerateForTodayDesc: string;
            audioRegenerateButton: string;
            podcastVoice: string;
            podcastVoiceDesc: string;
            podcastVoiceCharon: string;
            podcastVoicePuck: string;
            podcastVoiceKore: string;
            podcastMaxMins: string;
            podcastMaxMinsDesc: string;
            briefCutoffHour: string;
            briefCutoffHourDesc: string;
            briefCutoffMinute: string;
            briefCutoffMinuteDesc: string;
            homeRegion: string;
            homeRegionDesc: string;
            storyMemory: string;
            storyMemoryDesc: string;
            readMode: string;
            readModeDesc: string;
            readModeOff: string;
            readModeExplicit: string;
            readModeReadThrough: string;
            forgetRead: string;
            forgetReadDesc: string;
            forgetReadButton: string;
            forgetReadDone: string;
            briefMarkedRead: string;      // "{n}" stories newly counted
            briefAlreadyRead: string;
            listenReadKnown: string;
            listenReadKnownDesc: string;
            markCaughtUp: string;
            markCaughtUpDesc: string;
            markCaughtUpButton: string;
            caughtUpOk: string;
            caughtUpNoop: string;
            caughtUpOkNone: string;
            markCaughtUpConfirm: string;
            caughtUpDisabled: string;
            caughtUpError: string;
            retentionDays: string;
            retentionDaysDesc: string;
            briefMemoryHeading: string;
            catchUp: {
                heading: string;
                modeLabel: string;
                modeDescOnDemand: string;
                modeDescSmartDaily: string;
                modeDescDaily: string;
                modeOnDemand: string;
                modeSmartDaily: string;
                modeDaily: string;
                modeNotice: string;
                lookbackDays: string;
                lookbackDaysDesc: string;
                maxMins: string;
                maxMinsDesc: string;
                statusBar: string;
                statusBarDesc: string;
                memoryOffNote: string;
                whenBehindLabel: string;
                whenBehindDesc: string;
                whenBehindWait: string;
                whenBehindReplace: string;
                cleanupDays: string;
                cleanupDaysDesc: string;
                cleanupOff: string;
                cleanupNotice: string;         // "{count}" (plural)
                cleanupNoticeOne: string;      // exactly one episode
                lookbackClampNote: string;     // "{n}" days actually kept
                audioRemovedLine: string;      // "{date}"
                dailyPreviewNote: string;      // shown above the disabled catch-up controls in Daily mode
            };
        };
        audioNarration: {
            title: string;
            description: string;
            azureNote: string;
            voice: string;
            voiceDesc: string;
            provider: string;
            providerDesc: string;
            providerGemini: string;
            providerGptAudio: string;
            gptAudioVoiceAlloy: string;
            gptAudioVoiceCedar: string;
            gptAudioVoiceMarin: string;
            gptAudioVoiceNova: string;
            gptAudioVoiceOnyx: string;
            gptAudioVoiceShimmer: string;
            testVoice: string;
            testVoiceDesc: string;
            testVoiceButton: string;
            testVoiceRunning: string;
            testVoiceSample: string;
            testVoiceOk: string;
            testVoiceFailed: string;
            outputFolder: string;
            outputFolderDesc: string;
            embedInNote: string;
            embedInNoteDesc: string;
            defaultPlaybackSpeed: string;
            defaultPlaybackSpeedDesc: string;
            infoBox: string;
            modes: {
                codeBlockLabel: string;
                codeBlockDesc: string;
                codeBlockPlaceholder: string;
                codeBlockOmit: string;
                codeBlockReadInline: string;
                tableLabel: string;
                tableDesc: string;
                tableRowProse: string;
                tableHeaderSummary: string;
                tableOmit: string;
                imageLabel: string;
                imageDesc: string;
                imageAltText: string;
                imageOmit: string;
            };
            notices: {
                empty: string;
                noKey: string;
                azureUnavailable: string;
                consentDeclined: string;
                success: string;
                open: string;
                playWithControls: string;
                dismiss: string;
                alreadyExists: string;
                cancelled: string;
                failed: string;
                inFlight: string;
                embedSkipped: string;
                transformFailed: string;
                writeFailed: string;
                encodeFailed: string;
                unsupportedPlatform: string;
            };
            // LLM enhancement opt-in (audioNarration.enhancement namespace per plan §7)
            enhancement: {
                label: string;
                description: string;
                off: string;
                on: string;
                providerLabel: string;
                providerGemini: string;
                providerHaiku: string;
                costExampleHint: string;        // template: "Typical cost on a 20-page note: about {cost}"
                varianceHint: string;
                privacyHint: string;            // template: "Your note will be sent to {provider} for AI enhancement before narration"
                costLineLabel: string;          // cost-confirmation modal row label
                geminiKeyLabel: string;
                geminiKeyPlaceholder: string;
                reuseYoutubeKeyLabel: string;
                anthropicKeyLabel: string;
                anthropicKeyPlaceholder: string;
                anthropicKeyReuseHint: string;
                warnings: {
                    'llm-enhancement-disabled-no-key': string;
                    'llm-enhancement-partial': string;     // template: includes {count}
                    'llm-enhancement-failed': string;
                    'llm-enhancement-rate-limited': string;
                    'llm-enhancement-aborted': string;
                };
            };
        };
        notebookLM: {
            title: string;
            description: string;
            selectionTitle: string;
            selectionTag: string;
            selectionTagDesc: string;
            exportFolder: string;
            exportFolderDesc: string;
            exportTitle: string;
            exportFormatTitle: string;
            exportFormat: string;
            exportFormatDesc: string;
            formatText: string;
            formatPdf: string;
            contentSettingsTitle: string;
            includeFrontmatter: string;
            includeFrontmatterDesc: string;
            includeTitle: string;
            includeTitleDesc: string;
            exportMode: string;
            exportModeDesc: string;
            modeAuto: string;
            modeModular: string;
            modeSingle: string;
            maxWords: string;
            maxWordsDesc: string;
            postExport: string;
            postExportDesc: string;
            actionKeep: string;
            actionClear: string;
            actionArchive: string;
            pdfSettingsTitle: string;
            pdfPageSize: string;
            pdfPageSizeDesc: string;
            pdfFontName: string;
            pdfFontNameDesc: string;
            pdfFontSize: string;
            pdfFontSizeDesc: string;
            pdfIncludeFrontmatter: string;
            pdfIncludeFrontmatterDesc: string;
            pdfIncludeTitle: string;
            pdfIncludeTitleDesc: string;
            sanitisationTitle: string;
            removeFrontmatter: string;
            removeFrontmatterDesc: string;
            flattenCallouts: string;
            flattenCalloutsDesc: string;
            stripDataview: string;
            stripDataviewDesc: string;
            stripDataviewJs: string;
            stripDataviewJsDesc: string;
            imageHandling: string;
            imageHandlingDesc: string;
            imageStrip: string;
            imagePlaceholder: string;
            imageExport: string;
            embedTitle: string;
            resolveEmbeds: string;
            resolveEmbedsDesc: string;
            embedNone: string;
            embedTitleOnly: string;
            embedExcerpt: string;
            embedMaxDepth: string;
            embedMaxDepthDesc: string;
            embedMaxChars: string;
            embedMaxCharsDesc: string;
            linkContextTitle: string;
            includeLinkContext: string;
            includeLinkContextDesc: string;
            linkContextMaxChars: string;
            linkContextMaxCharsDesc: string;
        };
        specialistProviders: {
            title: string;
            description: string;
            youtubeHeader: string;
            pdfHeader: string;
            audioHeader: string;
            flashcardHeader: string;
            auditHeader: string;
            auditEnable: string;
            auditEnableDesc: string;
            auditProvider: string;
            auditProviderDesc: string;
            auditProviderMain: string;
            auditModel: string;
            auditModelDesc: string;
            quickPeekHeader: string;
            quickPeekProvider: string;
            quickPeekProviderDesc: string;
            quickPeekProviderMain: string;
            quickPeekModel: string;
            quickPeekModelDesc: string;
        };
        youtube: {
            title: string;
            description: string;
            usingMainKey: string;
            usingDedicatedKey: string;
            usingProviderKey: string;
            apiKey: string;
            apiKeyDesc: string;
            replaceApiKey: string;
            replaceApiKeyDesc: string;
            clearStoredKey: string;
            clearStoredKeyDesc: string;
            clearStoredKeyButton: string;
            showKey: string;
            getApiKey: string;
            model: string;
            modelDesc: string;
            noKeyWarning: string;
        };
        pdf: {
            title: string;
            description: string;
            usingMainProvider: string;
            provider: string;
            providerDesc: string;
            providerAuto: string;
            apiKey: string;
            apiKeyDesc: string;
            showKey: string;
            getClaudeKey: string;
            getGeminiKey: string;
            model: string;
            modelDesc: string;
            noProviderConfigured: string;
        };
        audioTranscription: {
            title: string;
            description: string;
            usingOpenAIKey: string;
            usingGroqKey: string;
            noKeyWarning: string;
            provider: string;
            providerDesc: string;
            apiKey: string;
            apiKeyDesc: string;
            showKey: string;
            getApiKey: string;
        };
        digitisation: {
            title: string;
            description: string;
            defaultMode: string;
            defaultModeDesc: string;
            maxDimension: string;
            maxDimensionDesc: string;
            imageQuality: string;
            imageQualityDesc: string;
            resetToDefault: string;
            offerCompression: string;
            offerCompressionDesc: string;
            compressionAlways: string;
            compressionLargeFiles: string;
            compressionNever: string;
            threshold: string;
            thresholdDesc: string;
            modes: {
                auto: string;
                handwriting: string;
                diagram: string;
                whiteboard: string;
                mixed: string;
            };
        };
        sketch: {
            title: string;
            outputFolder: string;
            outputFolderDesc: string;
            autoDigitise: string;
            autoDigitiseDesc: string;
            defaultPenColour: string;
            defaultPenColourDesc: string;
            defaultPenWidth: string;
            defaultPenWidthDesc: string;
            colours: {
                black: string;
                blue: string;
                red: string;
            };
        };
        secretStorage: {
            deviceOnly: string;
            keyConfigured: string;
            noKeySet: string;
            keySaved: string;
            migrationTitle: string;
            migrationDesc: string;
            benefitsTitle: string;
            benefit1: string;
            benefit2: string;
            benefit3: string;
            importantTitle: string;
            warning1: string;
            warning2: string;
            warning3: string;
            migrationComplete: string;
            migrationDeclined: string;
            fallbackWarning: string;
            fallbackConsent: string;
            sharedKeyInfo: string;
            testKey: string;
            apiKeyPlaceholder: string;
            testing: string;
            valid: string;
            invalid: string;
            error: string;
            clearFromKeychain: string;
            migrateNow: string;
            cancel: string;
        };
        sectionDescriptions: {
            aiProvider: string;
            specialistProviders: string;
            tagging: string;
            summarization: string;
            captureInput: string;
            meetingMinutes: string;
            vaultIntelligence: string;
            integrations: string;
            preferences: string;
            advanced: string;
        };
    };

    // Commands
    commands: {
        generateForCurrentNote: string;
        generateTagsForCurrentNote: string;
        generateForCurrentFolder: string;
        generateTagsForCurrentFolder: string;
        generateForVault: string;
        generateTagsForVault: string;
        clearTagsForCurrentNote: string;
        clearTagsForCurrentFolder: string;
        clearTagsForVault: string;
        collectAllTags: string;
        showTagNetwork: string;
        aiTagSelectedNotes: string;
        aiTagThisNote: string;
        summarize: string;
        summarizeFromUrl: string;
        summarizeFromPdf: string;
        summarizeFromYouTube: string;
        summarizeFromAudio: string;
        summarizeSmart: string;
        translate: string;
        translateNote: string;
        translateSelection: string;
        tag: string;
        clearTags: string;
        enhance: string;
        improveNote: string;
        findResources: string;
        openCommandPicker: string;
        ribbonTooltip: string;
        generateMermaidDiagram: string;
        highlightSelection: string;
        highlightWith: string;
        removeHighlight: string;
        exportFlashcards: string;
        buildSemanticIndex: string;
        updateSemanticIndex: string;
        clearSemanticIndex: string;
        manageIndex: string;
        showRelatedNotes: string;
        searchSemanticVault: string;
        chatWithAI: string;
        insertRelatedNotes: string;
        upgradeToBases: string;
        upgradeFolderToBases: string;
        createBasesDashboard: string;
        createBasesDashboardHere: string;
        notebookLMExport: string;
        notebookLMToggle: string;
        notebookLMClear: string;
        notebookLMOpenFolder: string;
        exportNote: string;
        mapRelatedConcepts: string;
        mapAttachments: string;
        summarizeNote: string;
        summarizeWebYouTube: string;
        groupNotesByTag: string;
        visualizeTagGraph: string;
        createMeetingMinutes: string;
        /** Plan F3 — new top-level "Transcribe audio" command */
        transcribeAudio: string;
        addToPendingIntegration: string;
        integratePendingContent: string;
        resolvePendingEmbeds: string;
        ensureNoteStructure: string;
        quickAddTextPending: string;
        quickAddUrlPending: string;
        dropSelectionPending: string;
        recordAudio: string;
        buildInvestigationCanvas: string;
        buildContextCanvas: string;
        buildClusterCanvas: string;
        webReader: string;
        kindleSync: string;
        newsletterFetch: string;
        newsletterRegenerateAudio: string;
        newsletterMarkCaughtUp: string;
        newsletterAudio: string;
        newsletterMarkCatchUpListened: string;
        newsletterMarkBriefRead: string;
        narrateNote: string;
        playNarration: string;
        digitiseImage: string;
        newSketch: string;
        researchWeb: string;
        exportMinutesDocx: string;
        findEmbeds: string;
        buildAgentIndex: string;
        checkAgentIndex: string;
        copyAgentInstructions: string;
        setupAgentIndex: string;
        refreshCloudInventories: string;
        checkCloudInventories: string;
        setupCloudInventory: string;
        resumeOffload: string;
        copyClaudePermissions: string;
        writeAgentInstructions: string;
        runVaultUpkeep: string;
        openAgentConnectors: string;
        exportVaultMap: string;
        setupVaultUpkeep: string;
        openUpkeepReview: string;
        sweepInbox: string;
        setupInboxSweep: string;
        processCaptureInbox: string;
        adoptProject: string;
        refreshTaskStatus: string;
        openProject: string;
        reviewCaptures: string;
        setupCaptureInbox: string;
        sendTasksToGoogle: string;
        setupGoogleTasks: string;
        insertOneDriveLink: string;
        refreshOneDriveEmbed: string;
        editMermaidDiagram: string;
        presentationChat: string;
        buildFromStoryline: string;
        quickPeek: string;
        quickPeekNoSources: string;
    };

    // Context Menu (right-click)
    contextMenu: {
        askAI: string;
        translate: string;
        addToPending: string;
        digitise: string;
        editDiagram: string;
        quickPeek: string;
    };

    // Canvas
    presentationModels: {
        settingsTitle: string;
        settingsDescription: string;
        consultantModeName: string;
        consultantModeDesc: string;
        storylineGateName: string;
        storylineGateDesc: string;
        storylineGateReview: string;
        storylineGateAutoBuild: string;
        mainOption: string;
        generatorName: string;
        generatorDesc: string;
        criticName: string;
        criticDesc: string;
        noKeyWarning: string;
    };
    canvas: {
        settingsTitle: string;
        settingsDescription: string;
        outputFolder: string;
        outputFolderDesc: string;
        openAfterCreate: string;
        openAfterCreateDesc: string;
        enableEdgeLabels: string;
        enableEdgeLabelsDesc: string;
        useLLMClustering: string;
        useLLMClusteringDesc: string;
        created: string;
        creationFailed: string;
        building: string;
        progressFindingRelated: string;
        progressLabelingRelationships: string;
        progressBuildingCanvas: string;
        noSourcesDetected: string;
        noRelatedNotes: string;
        noNotesWithTag: string;
        requiresSemanticSearch: string;
        desktopOnly: string;
        emptyNote: string;
        edgeCloselyRelated: string;
        edgeRelated: string;
        edgeLooselyRelated: string;
        chooseFolder: string;
        chooseFolderDesc: string;
    };

    // Smart Digitisation (Phase 3)
    digitisation: {
        previewTitle: string;
        sourceImage: string;
        digitisedContent: string;
        discard: string;
        copyToClipboard: string;
        insertBelow: string;
        noImageFound: string;
        digitising: string;
        inserted: string;
        copied: string;
        selectImage: string;
        selectImages: string;
        digitiseCount: string;
        selectAll: string;
        deselectAll: string;
        editTab: string;
        previewTab: string;
        discardConfirm: string;
        copyFailed: string;
        noActiveView: string;
    };

    // Sketch Pad (Phase 4)
    sketch: {
        title: string;
        undo: string;
        redo: string;
        pen: string;
        eraser: string;
        clear: string;
        done: string;
        doneAndDigitise: string;
        noContent: string;
        saved: string;
        saveFailed: string;
        thin: string;
        medium: string;
        thick: string;
    };

    // Media Compression (Phase 5)
    compression: {
        confirmTitle: string;
        postTranscriptionTitle: string;
        originalSize: string;
        compressedSize: string;
        savings: string;
        replaceOriginal: string;
        keepOriginal: string;
        deleteAudio: string;
        deleteAudioDesc: string;
        backlinkNote: string;
        backlinksMigrated: string;
        replaceFailed: string;
        replaceSuccess: string;
        audioDeleted: string;
    };

    // Tag Network
    tagNetwork: {
        title: string;
        description: string;
        searchPlaceholder: string;
        noTagsFound: string;
        noMatchingTags: string;
        coOccurringTags: string;
        legendFrequency: string;
        legendLow: string;
        legendMedium: string;
        legendHigh: string;
        tooltipFrequency: string;
        tooltipConnections: string;
        loadingVisualization: string;
        loadFailed: string;
    };

    // Messages and notifications
    messages: {
        openNote: string;
        noContent: string;
        analyzing: string;
        failedToGenerate: string;
        operationCancelled: string;
        noMdFiles: string;
        noParentFolder: string;
        buildingTagNetwork: string;
        noTagsFound: string;
        noTagConnections: string;
        failedToBuildNetwork: string;
        successfullyClearedAll: string;
        failedToClearVault: string;
        pleaseOpenNote: string;
        failedToUpdate: string;
        analyzingFiles: string;
        successfullyTagged: string;
        progress: string;
        completed: string;
        connectionTestSuccess: string;
        connectionTestFailed: string;
        localServiceNotRunning: string;
        localServiceNotAvailable: string;
        tagsAlreadyUpToDate: string;
        noValidTags: string;
        errorClearingTags: string;
        errorUpdatingTags: string;
        tagsSavedTo: string;
        novelDisciplinesAdded: string;
        taxonomyGuardrailSkipped: string;
        errorSavingTags: string;
        failedToLoadEndpoints: string;
        debugModeToggle: string;
        openNoteFirst: string;
        noParentFolderFound: string;
        noMarkdownFilesFound: string;
        noContentToAnalyze: string;
        failedToGenerateTags: string;
        generateTagsForFolderConfirm: string;
        generateTagsForVaultConfirm: string;
        generateTagsForSelectedConfirm: string;
        generateTagsInProgress: string;
        tagsGeneratedSuccessfully: string;
        failedToGenerateForFiles: string;
        progressPrefix: string;
        completedPrefix: string;
        restartRequired: string;
        languageChangeNotice: string;
        clearTagsForFolderConfirm: string;
        clearTagsAllNotesConfirm: string;
        clearTagsProtectedConfirm: string;
        clearTagsProtectedResult: string;
        clearTagsAllProtected: string;
        tagsClearedFrom: string;
        failedToClearTags: string;
        noTagsInVault: string;
        successfullyClearedAllVault: string;
        failedToClearVaultTags: string;
        viewTagNetwork: string;
        noMatchingFiles: string;
        errorLoadingFiles: string;
        noActiveFile: string;
        noPredefinedTagsFound: string;
        fetchingUrl: string;
        fetchFailed: string;
        openingBrowser: string;
        pdfInstructions: string;
        pdfNotSupported: string;
        noPdfsFound: string;
        readingPdf: string;
        summaryInserted: string;
        companionCreated: string;
        companionCreateFailed: string;
        copiedToClipboard: string;
        // Note-edit write seam (applyNoteEdit) — §5 failure matrix
        noteDeletedEditCancelled: string;
        nothingToInsert: string;
        noteChangedReRun: string;
        couldNotWriteNote: string;
        protectedNoteNotModified: string;
        insertionPointMovedAppended: string;
        summarizingChunk: string;
        combiningChunks: string;
        urlValidationError: string;
        contentTruncated: string;
        savingPdfFromUrl: string;
        smartSummarizeNoContent: string;
        externalFilesDesktopOnly: string;
        noSelection: string;
        translating: string;
        translatingFullNote: string;
        translationComplete: string;
        noteTranslatedSuccess: string;
        selectionTranslatedSuccess: string;
        translationFailed: string;
        unknownError: string;
        invalidYouTubeUrl: string;
        fetchingTranscript: string;
        noCaptionsAvailable: string;
        fileAlreadyExists: string;
        suggestionsApplied: string;
        failedToApplySuggestions: string;
        noEmbeddedContent: string;
        noItemsSelected: string;
        extractAllConfirm: string;
        extractingContent: string;
        extracting: string;
        extractionFailed: string;
        multimodalNotSupported: string;
        noTextContent: string;
        generatingNote: string;
        noteGenerated: string;
        generationFailed: string;
        improvingNote: string;
        noteImproved: string;
        translatingMultipleSources: string;
        translatingSourceProgress: string;
        extractingForTranslation: string;
        transcribingForTranslation: string;
        multiSourceTranslateComplete: string;
        multiSourceTranslatePartial: string;
        pdfNotTextExtractable: string;
        audioTranscriptionKeyMissing: string;
        improvementFailed: string;
        searchingResources: string;
        searchFailed: string;
        noSearchTerms: string;
        noResourcesFound: string;
        transcriptionNotAvailable: string;
        audioFileTooLarge: string;
        audioMaxSize: string;
        transcribingAudio: string;
        transcriptionFailed: string;
        summarizingTranscript: string;
        noAudioFiles: string;
        compressingAudio: string;
        compressionFailed: string;
        generatingDiagram: string;
        diagramGenerated: string;
        diagramGenerationFailed: string;
        generatingFlashcards: string;
        flashcardGenerationFailed: string;
        flashcardsExported: string;
        flashcardsTo: string;
        noValidFlashcards: string;
        buildingIndex: string;
        indexBuildComplete: string;
        indexBuildFailed: string;
        updatingIndex: string;
        indexUpdateComplete: string;
        indexUpdateFailed: string;
        clearingIndex: string;
        indexCleared: string;
        indexClearFailed: string;
        noIndexFound: string;
        indexingFile: string;
        findingRelatedNotes: string;
        noRelatedNotes: string;
        relatedNotesFailed: string;
        searchingVault: string;
        noSearchResults: string;
        chatInitializing: string;
        chatReady: string;
        chatFailed: string;
        embeddingGenerationFailed: string;
        vectorStoreFailed: string;
        semanticSearchDisabled: string;
        localOnnxNotConsented: string;
        localOnnxLoadFailed: string;
        localOnnxModelUnsupported: string;
        externalCompressionNotSupported: string;
        mobileIndexTooLarge: string;
        mobileDataWarning: string;
        mobileExternalNotSupported: string;
        notebookLMServiceNotReady: string;
        notebookLMNoSelection: string;
        notebookLMExporting: string;
        notebookLMExportComplete: string;
        notebookLMExportFailed: string;
        notebookLMSelectionAdded: string;
        notebookLMSelectionRemoved: string;
        notebookLMToggleFailed: string;
        notebookLMSelectionCleared: string;
        notebookLMClearFailed: string;
        notebookLMFolderNotFound: string;
        notebookLMOpenFolderFailed: string;
        notebookLMStatusSelected: string;
        notebookLMGeneratingName: string;
        desktopOnly: string;
        // Chat/RAG messages
        searchingVaultContext: string;
        foundRelevantChunks: string;
        semanticSearchNotEnabledDetailed: string;
        vectorStoreNotInitialized: string;
        noDocumentsIndexedYet: string;
        noContentToAnalyzeDetailed: string;
        searchingForRelevantInfo: string;
        noRelevantInformationFound: string;
        answerInserted: string;
        failedToGenerateAnswer: string;
        findingRelatedNotesDetailed: string;
        insertedRelatedNotes: string;
        // Integration messages
        contentAddedToPending: string;
        noPendingContentToIntegrate: string;
        noMainContentToIntegrateInto: string;
        integratingContent: string;
        integratingContentFailed: string;
        contentIntegratedSuccessfully: string;
        integrationResolvingContent: string;
        integrationResolvingProgress: string;
        integrationResolutionComplete: string;
        integrationAudioKeyMissing: string;
        integrationContentTruncated: string;
        integrationValidationWarnings: string;
        minutesValidationWarnings: string;
        auditFlaggedIntegration: string;
        auditSkipped: string;
        noteStructureAdded: string;
        urlAddedToPending: string;
        selectTextFirst: string;
        selectionAddedToPending: string;
        contentRequired: string;
        noResponseFromLlm: string;
        addedTimestamp: string;
        // Related notes view messages
        relatedNotesCopiedToClipboard: string;
        cacheClearedSuccessfully: string;
        // Summarize commands messages (new i18n keys for multi-source summarization)
        webSummarizationDisabled: string;
        noSourcesSelected: string;
        processingXSources: string;
        processingSourceXofY: string;
        summarizingNoteContent: string;
        fetchingWebPage: string;
        summarizingTitle: string;
        failedToFetchUrl: string;
        processingYouTubeWithGemini: string;
        failedToProcessYouTube: string;
        errorProcessingPdf: string;
        couldNotFindPdfFile: string;
        errorProcessingExternalPdf: string;
        errorProcessingDocument: string;
        summarizedTitle: string;
        noContentCouldBeSummarized: string;
        errorGeneric: string;
        aiProcessing: string;
        summaryCombinedFromSections: string;
        // Kindle messages
        kindleSyncComplete: string;
        kindleSyncFailed: string;
        quickPeekProviderFallback: string;
        quickPeekExtracting: string;
        quickPeekTriaging: string;
        quickPeekDetecting: string;
        quickPeekComplete: string;
        quickPeekInserted: string;
    };

    // Common UI strings
    common: {
        cancel: string;
        close: string;
        back: string;
        next: string;
        save: string;
        delete: string;
        confirm: string;
        openSettings: string;
    };

    // Modal dialogs
    modals: {
        warning: string;
        confirm: string;
        cancel: string;
        newsletterCatchUp: {
            title: string;
            statusBarLabel: string;       // "Newsletter audio: {summary} pending"
            statusBarTooltip: string;
            statusBarUnheard: string;     // "{n} not listened"
            autoReady: string;            // "Your newsletter audio for {range} is ready."
            notAnEpisode: string;
            ackFailed: string;
            discardFailed: string;
            daysOne: string;
            daysMany: string;             // "{n} days"
            newslettersOne: string;
            newslettersMany: string;      // "{n} newsletters"
            pendingSummary: string;       // "{days} · {newsletters}"
            pendingLine: string;          // "{summary} pending"
            covers: string;               // "Covers {from} to {to}"
            coversOne: string;            // "Covers {date}"
            coversList: string;           // "Covers {dates}" for days that are not consecutive
            skippedHeard: string;         // "{n} earlier days are left out ...: {dates}."
            skippedHeardOne: string;
            includeSkipped: string;       // "Include them too"
            skippedOpen: string;          // "{dates} is left out until the day closes ..."
            includeAll: string;           // "Include all {n} days again"
            includeAllOne: string;
            datesMore: string;            // "and {n} more"
            sizeUnknown: string;
            markMapHint: string;
            tidyLabel: string;            // "Also remove the daily audio for these days ({count} files, {size})"
            tidyLabelOne: string;
            tidyDone: string;             // "{n}", "{size}"
            tidyDoneOne: string;
            tidyPartial: string;          // "{left}", "{total}"
            tidyUnknown: string;
            tidyWhyHalted: string;
            tidyWhyProtected: string;
            tidyWhyLinked: string;
            tidyWhyChanged: string;
            tidyWhyChecking: string;
            statusBarSkipped: string;     // "{n} days left out (already listened to)"
            statusBarSkippedOne: string;
            evidenceDegraded: string;     // the listening history could not be read
            waitingTitleOne: string;      // "Waiting: your last episode is unheard, {pending}."
            waitingTitleMany: string;     // "Waiting: {count} episodes are unheard, {pending}."
            waitingPending: string;       // "{days} pending"
            waitingEndsOne: string;
            waitingEndsMany: string;
            statusBarWaiting: string;     // "Waiting: last episode unheard · {pending}"
            replaceOne: string;           // the Replace button
            replaceMany: string;          // "... {count} ..."
            replaceChecking: string;
            replaceBlockedTitle: string;
            replaceBlockedIntro: string;
            replaceWhyPlaying: string;
            replaceWhyPlayed: string;
            replaceWhyTooNew: string;
            replaceWhyLinked: string;
            waitingReplaceSoon: string;
            replaceWhyProtected: string;
            replaceWhyChecking: string;
            replaceWhyInFlight: string;
            replaceWhyAcked: string;
            replaceWhyOther: string;
            replaceWhyNothing: string;
            replaceConfirmOne: string;
            replaceConfirmMany: string;   // "{count}"
            replaceTrashIntro: string;
            replaceTrashItem: string;     // "{note} · {audio} ({size})"
            replaceMakes: string;         // "{summary}", "{dates}"
            replaceLost: string;          // "{n}", "{dates}"
            replaceLinked: string;        // "{n}"
            replaceLinkedOne: string;
            replaceGo: string;
            replaceRetired: string;
            replaceRetiredMany: string;
            replaceKept: string;          // "{why}"
            replacePartial: string;       // "{files}"
            statusBarWaitingMany: string; // "Waiting: {count} episodes unheard · {pending}"
            noStored: string;             // "No newsletters stored for {dates}."
            noBrief: string;              // digest exists, no daily brief: "{dates}"
            includeAgainHint: string;
            unresolved: string;           // "Updates on {dates} could not be checked. Open the digest or fetch again."
            unresolvedOnly: string;
            gap: string;                  // "Older material is unavailable. ..."
            caughtUp: string;             // "You are caught up through {date}."
            expiring: string;             // "{dates} will be removed ..."
            unheardTitle: string;
            unheardBodyDone: string;
            waitingEpisodeLine: string;
            waitingGenerateHint: string;
            includeAgainNote: string;
            unheardBody: string;          // "{range}. Listen to it first, or generate another anyway."
            openEpisode: string;
            markListened: string;
            markedListened: string;
            lengthLine: string;           // "Length: about {mins} min"
            lengthLineBig: string;        // "Length: about {mins} min (4 or more days pending)"
            ceilingLabel: string;
            costTts: string;              // "Voice cost: about ${usd}"
            costAzure: string;
            costNote: string;
            generate: string;
            cancel: string;
            close: string;
            resume: string;
            finishSaving: string;
            startOver: string;
            discard: string;
            resumeTitle: string;
            resumeScripted: string;
            resumeAudioReady: string;
            resumeRange: string;          // "Covers {from} to {to}."
            includeAgain: string;
            replayLatest: string;
            running: string;
            overrunTitle: string;
            overrunBody: string;          // "It is about {estimated} min, and your limit is {cap} min."
            continueAnyway: string;
            shortenAgain: string;
            done: string;                 // "Episode ready — about {minutes} min covering {days}."
            doneShort: string;            // a sub-minute episode: "... covering {days}."
            openNote: string;
            cancelledNoRecord: string;
            cancelledWithRecord: string;
            changedNotice: string;
            discarded: string;
            discardConfirm: string;
            discardKeep: string;
            wrongModeTitle: string;
            wrongModeBody: string;
            audioOffBody: string;
            switchMode: string;
            loading: string;
        };
        clearAllTagsConfirm: string;
        generateFolderConfirm: string;
        generateVaultConfirm: string;
        generateSelectedConfirm: string;
        saveTagsConfirm: string;
        excludedFilesTitle: string;
        excludedFilesSubtitle: string;
        addButton: string;
        clearAllButton: string;
        clearAllConfirm: string;
        cancelButton: string;
        saveButton: string;
        noMatchingPaths: string;
        useAsPattern: string;
        moreResults: string;
        errorLoadingPaths: string;
        noExclusionsDefined: string;
        filterLabel: string;
        pathPlaceholder: string;
        urlInput: {
            title: string;
            urlLabel: string;
            urlDesc: string;
            urlPlaceholder: string;
            submitButton: string;
            personaLabel: string;
            personaDesc: string;
            contextLabel: string;
            contextDesc: string;
            contextPlaceholder: string;
        };
        pdfSelect: {
            title: string;
            description: string;
            selectButton: string;
            modifiedLabel: string;
            personaLabel: string;
            personaDesc: string;
            contextLabel: string;
            contextDesc: string;
            contextPlaceholder: string;
            browseLabel: string;
            browseDesc: string;
            browseButton: string;
        };
        contentSize: {
            title: string;
            description: string;
            truncateOption: string;
            truncateDesc: string;
            truncateButton: string;
            chunkOption: string;
            chunkDesc: string;
            chunkButton: string;
            cancelButton: string;
        };
        privacy: {
            title: string;
            description: string;
            bullet1: string;
            bullet2: string;
            bullet3: string;
            proceedButton: string;
            cancelButton: string;
        };
        localOnnxConsent: {
            title: string;
            description: string;
            bullet1: string;
            bullet2: string;
            bullet3: string;
            declineButton: string;
            acceptButton: string;
        };
        translate: {
            title: string;
            description: string;
            languageLabel: string;
            languageDesc: string;
            translateButton: string;
            insertAtCursor: string;
            insertAtCursorDesc: string;
        };
        summarizeSource: {
            title: string;
            thisNote: string;
            thisNoteDesc: string;
            pasteUrl: string;
            pasteUrlDesc: string;
            selectPdf: string;
            selectPdfDesc: string;
            youtubeVideo: string;
            youtubeDesc: string;
            audioFile: string;
            audioDesc: string;
            continueButton: string;
        };
        multiSource: {
            title: string;
            description: string;
            currentNote: string;
            includeNoteContent: string;
            noteContentDesc: string;
            webPages: string;
            youtubeVideos: string;
            pdfDocuments: string;
            officeDocuments: string;
            audioFiles: string;
            images: string;
            addUrlPlaceholder: string;
            addYoutubePlaceholder: string;
            addPdfPlaceholder: string;
            addDocumentPlaceholder: string;
            addAudioPlaceholder: string;
            addImagePlaceholder: string;
            addOtherSources: string;
            hideOtherSources: string;
            documentDetected: string;
            persona: string;
            personaDesc: string;
            focusContext: string;
            focusContextDesc: string;
            focusPlaceholder: string;
            summarizeButton: string;
            summarizeOne: string;
            summarizeMultiple: string;
            translateButton: string;
            translateOne: string;
            translateMultiple: string;
            translateTitle: string;
            translateDescription: string;
            translateNoteLabel: string;
            translateNoteDesc: string;
            languageLabel: string;
            languageDesc: string;
        };
        enhance: {
            title: string;
            improve: string;
            improveDesc: string;
            diagram: string;
            diagramDesc: string;
            resources: string;
            resourcesDesc: string;
            flashcards: string;
            flashcardsDesc: string;
        };
        tagScope: {
            title: string;
            thisNote: string;
            currentFolder: string;
            entireVault: string;
            tagButton: string;
            vaultRoot: string;
            folderRequiresOpenNote: string;
            folderAllExcluded: string;
            folderTaggableCount: string;
        };
        folderScopePicker: {
            title: string;
            description: string;
            searchPlaceholder: string;
            useEntireVault: string;
            selectButton: string;
            noFoldersFound: string;
            createFolder: string;
            exportDestination: string;
        };
        clearTagsScope: {
            title: string;
            thisNote: string;
            currentFolder: string;
            entireVault: string;
            clearButton: string;
        };
        manageIndex: {
            title: string;
            description: string;
            buildLabel: string;
            buildDesc: string;
            buildButton: string;
            updateLabel: string;
            updateDesc: string;
            updateButton: string;
            clearLabel: string;
            clearDesc: string;
            clearButton: string;
            clearConfirm: string;
            indexOutdated: string;
            closeButton: string;
        };
        youtubeInput: {
            title: string;
            captionNotice: string;
            urlLabel: string;
            urlDesc: string;
            urlPlaceholder: string;
            submitButton: string;
            personaLabel: string;
            personaDesc: string;
            contextLabel: string;
            contextDesc: string;
            contextPlaceholder: string;
        };
        suggestion: {
            title: string;
            description: string;
            titleLabel: string;
            folderLabel: string;
            currentLabel: string;
            applyButton: string;
            skipButton: string;
            noSuggestions: string;
        };
        personaSelect: {
            title: string;
            description: string;
        };
        improveNote: {
            title: string;
            description: string;
            writingStyle: string;
            examplesTitle: string;
            example1: string;
            example2: string;
            example3: string;
            example4: string;
            queryLabel: string;
            queryDesc: string;
            queryPlaceholder: string;
            submitButton: string;
            placementLabel: string;
            placementDesc: string;
            placementReplace: string;
            placementCursor: string;
            placementNewNote: string;
            previewTitle: string;
            previewReplace: string;
            previewInsert: string;
            previewCreate: string;
            previewCopy: string;
            previewDiscard: string;
        };
        findResources: {
            title: string;
            description: string;
            examplesTitle: string;
            example1: string;
            example2: string;
            example3: string;
            example4: string;
            queryLabel: string;
            queryDesc: string;
            queryPlaceholder: string;
            submitButton: string;
        };
        resourceResults: {
            title: string;
            description: string;
            youtubeSection: string;
            webSection: string;
            instructions: string;
            closeButton: string;
        };
        audioSelect: {
            title: string;
            description: string;
            searchPlaceholder: string;
            filesFound: string;
            noFiles: string;
            fileTooLarge: string;
            noMatchingFiles: string;
            selectButton: string;
            personaLabel: string;
            languageLabel: string;
            languageDesc: string;
            contextLabel: string;
            contextDesc: string;
            contextPlaceholder: string;
            personaDesc: string;
            compressionBadge: string;
            compressionTooltip: string;
            largeFileTooltip: string;
            compressAndTranscribe: string;
            browseLabel: string;
            browseDesc: string;
            browseButton: string;
        };
        mermaidDiagram: {
            title: string;
            description: string;
            typeLabel: string;
            typeDesc: string;
            instructionLabel: string;
            instructionDesc: string;
            instructionPlaceholder: string;
            examplesTitle: string;
            example1: string;
            example2: string;
            example3: string;
            example4: string;
            generateButton: string;
        };
        highlight: {
            title: string;
            description: string;
            clearHighlight: string;
            colors: {
                yellow: string;
                green: string;
                blue: string;
                pink: string;
                orange: string;
                purple: string;
            };
        };
        flashcardExport: {
            title: string;
            description: string;
            sourceLabel: string;
            sourceDesc: string;
            sourceCurrent: string;
            sourceMultiNote: string;
            sourceScreenshot: string;
            styleLabel: string;
            styleDesc: string;
            formatLabel: string;
            formatDesc: string;
            destinationLabel: string;
            destinationDesc: string;
            destinationFile: string;
            destinationClipboard: string;
            contextLabel: string;
            contextDesc: string;
            contextPlaceholder: string;
            exportButton: string;
            mathNoticeAnki: string;
            mathNoticeBrainscape: string;
            selectedNotes: string;
            addNote: string;
            removeNote: string;
            noNotesSelected: string;
            selectImage: string;
            selectedImage: string;
            noImageSelected: string;
            visionNotSupported: string;
            screenshotStyleLocked: string;
            contentTruncated: string;
        };
        relatedNotes: {
            title: string;
            description: string;
            searchPlaceholder: string;
            noResults: string;
            clickToOpen: string;
            scopeAllNotes: string;
            scopeFolder: string;
            searchingIn: string;
            fewResultsInFolder: string;
            noResultsInFolder: string;
            tryAllNotes: string;
            searchCurrentFolder: string;
            searchEntireVault: string;
            pinScope: string;
            unpinScope: string;
            searching: string;
            noNoteOpen: string;
            openNoteHint: string;
            noteEmpty: string;
            configureHint: string;
            error: string;
            retry: string;
            refresh: string;
        };
        semanticSearch: {
            title: string;
            description: string;
            searchPlaceholder: string;
            searchButton: string;
            searching: string;
            noResults: string;
            clickToOpen: string;
            expandWithAI: string;
            expandTooltip: string;
            enterQueryHint: string;
            resultsFound: string;
            aiExpanded: string;
            selectAll: string;
            deselectAll: string;
            exportSelected: string;
            selected: string;
            noneSelected: string;
        };
        exportSearchResults: {
            title: string;
            description: string;
            targetLabel: string;
            newNote: string;
            existingNote: string;
            folderLabel: string;
            chooseFolder: string;
            noteLabel: string;
            chooseNote: string;
            formatLabel: string;
            linksOnly: string;
            linksWithExcerpts: string;
            exportButton: string;
            exporting: string;
            success: string;
            noNotesSelected: string;
        };
        localSetupWizard: {
            title: string;
            step1Title: string;
            step1Description: string;
            step2Title: string;
            step2Description: string;
            step3Title: string;
            step3Description: string;
            installOllama: string;
            downloadModel: string;
            verifySetup: string;
            verifying: string;
            setupComplete: string;
            setupFailed: string;
            closeButton: string;
            ramWarning: string;
            ramRecommendation: string;
            commandCopied: string;
            applySettings: string;
            settingsApplied: string;
        };
        migration: {
            title: string;
            analyzing: string;
            analysisTitle: string;
            totalNotes: string;
            needsMigration: string;
            alreadyMigrated: string;
            noMigrationNeeded: string;
            analysisFailed: string;
            optionsTitle: string;
            overwriteExisting: string;
            extractSummary: string;
            optionsInfo: string;
            startMigration: string;
            progressTitle: string;
            starting: string;
            processing: string;
            failed: string;
            resultsTitle: string;
            processed: string;
            updated: string;
            skipped: string;
            errors: string;
            errorList: string;
            moreErrors: string;
            completed: string;
        };
        dashboardCreation: {
            title: string;
            description: string;
            folderTitle: string;
            folderLabel: string;
            changeFolder: string;
            folderPrompt: string;
            folderError: string;
            folderPlaceholder: string;
            folderSelected: string;
            folderCreated: string;
            folderIsFile: string;
            templateTitle: string;
            defaultTemplates: string;
            personaTemplates: string;
            selectAll: string;
            selectNone: string;
            createButton: string;
            noTemplatesSelected: string;
            allCreated: string;
            someCreated: string;
            willCreate: string;
            created: string;
        };
        notebookLMExport: {
            title: string;
            description: string;
            statsTitle: string;
            noteCount: string;
            wordCount: string;
            moduleCount: string;
            scope: string;
            warningsTitle: string;
            configTitle: string;
            exportModeLabel: string;
            exportModeDesc: string;
            modeAuto: string;
            modeModular: string;
            modeSingle: string;
            wordBudgetLabel: string;
            wordBudgetDesc: string;
            postExportLabel: string;
            postExportDesc: string;
            actionKeep: string;
            actionClear: string;
            actionArchive: string;
            notesTitle: string;
            showNotes: string;
            hideNotes: string;
            exportButton: string;
            newPackButton: string;
            updatePackButton: string;
            openFolderButton: string;
        };
        addContent: {
            title: string;
            sourceType: string;
            sourceTitle: string;
            sourceTitleDesc: string;
            sourceTitlePlaceholder: string;
            sourceLink: string;
            sourceLinkDesc: string;
            sourceLinkPlaceholder: string;
            content: string;
            contentDesc: string;
            contentPlaceholder: string;
            defaultTitle: string;
            types: {
                manual: string;
                web: string;
                youtube: string;
                audio: string;
                pdf: string;
                image: string;
                note: string;
                video: string;
                transcript: string;
            };
            add: string;
        };
        integrationConfirm: {
            title: string;
            description: string;
            personaLabel: string;
            confirmButton: string;
            placementLabel: string;
            placementDesc: string;
            placementCursor: string;
            placementAppend: string;
            placementCallout: string;
            placementMerge: string;
            placementMergeWarn: string;
            formatLabel: string;
            formatDesc: string;
            formatProse: string;
            formatBullets: string;
            formatTasks: string;
            formatTable: string;
            detailLabel: string;
            detailDesc: string;
            detailFull: string;
            detailConcise: string;
            detailSummary: string;
            autoTagLabel: string;
            autoTagDesc: string;
        };
        quickAddText: {
            title: string;
            description: string;
            placeholder: string;
        };
        quickAddUrl: {
            title: string;
            description: string;
            urlLabel: string;
            urlPlaceholder: string;
        };
        summaryResult: {
            title: string;
            insertAtCursor: string;
            copyToClipboard: string;
            discard: string;
        };
        reviewEdits: {
            title: string;
            accept: string;
            reject: string;
            copy: string;
            statsAdded: string;
            statsRemoved: string;
            statsUnchanged: string;
            noChanges: string;
            settingName: string;
            settingDesc: string;
        };
        unifiedChat: {
            title: string;
            modeNote: string;
            modeVault: string;
            modeHighlight: string;
            noteUnavailable: string;
            vaultUnavailable: string;
            highlightUnavailable: string;
            vaultFallbackNotice: string;
            highlightFallbackNotice: string;
            discussingNote: string;
            indexStatus: string;
            indexOutdated: string;
            passagesSummary: string;
            placeholder: string;
            placeholderNote: string;
            placeholderVault: string;
            placeholderHighlight: string;
            introNote: string;
            introVault: string;
            introHighlight: string;
            send: string;
            thinking: string;
            clear: string;
            export: string;
            insertLastAnswer: string;
            insertSummary: string;
            insertSummaryDesc: string;
            exportTitle: string;
            exportTitleVault: string;
            exportTitleNote: string;
            exportTitleHighlight: string;
            exportSuccess: string;
            exportEmpty: string;
            exportFailed: string;
            searchingContext: string;
            foundChunks: string;
            noContextFallback: string;
            embeddingMissing: string;
            errorOccurred: string;
            responseFailed: string;
            chatCleared: string;
            noEditor: string;
            noAnswerYet: string;
            summaryInserted: string;
            answerInserted: string;
            sourcesLabel: string;
            selectPassages: string;
            showAll: string;
            showHighlightsOnly: string;
            showingCount: string;
            selected: string;
            noPassagesSelected: string;
            startChat: string;
            back: string;
            noHighlightsFound: string;
            requestCancelled: string;
            emptyState: string;
            scopeEntireVault: string;
            scopeFolder: string;
            changeScopeButton: string;
            scopeToFolderButton: string;
            modeResearch: string;
            introResearch: string;
            placeholderResearch: string;
            researchUnavailable: string;
            searchingWeb: string;
            foundResults: string;
            noResults: string;
            readingSelected: string;
            readingSource: string;
            synthesizing: string;
            insertedResearch: string;
            savedToPending: string;
            addedAsSection: string;
            readSelected: string;
            readSelectedTooltip: string;
            synthesizeFindings: string;
            synthesizeFindingsTooltip: string;
            insertResearch: string;
            insertResearchTooltip: string;
            addResearchSection: string;
            addResearchSectionTooltip: string;
            saveSourcesToPending: string;
            saveSourcesToPendingTooltip: string;
            searchAgain: string;
            searchAgainTooltip: string;
            providerLabel: string;
            scopeLabel: string;
            scopeAll: string;
            scopePreferred: string;
            scopeAcademic: string;
            phaseSearch: string;
            phaseReview: string;
            phaseExtract: string;
            phaseSynthesize: string;
            resumeSession: string;
            resumeYes: string;
            resumeNo: string;
            fetchFailed: string;
            escalateWebUnlocker: string;
            escalateScrapingBrowser: string;
            escalateAction: string;
            escalateSkip: string;
            escalateBatch: string;
            escalateBatchAll: string;
            escalateBatchChoose: string;
            escalateBatchSkip: string;
            researchBudgetWarn: string;
            researchBudgetBlocked: string;
            researchBudgetOverride: string;
            researchBudgetSkip: string;
            researchBudgetAdjust: string;
            researchUsageSummary: string;
            researchQualityHigh: string;
            researchQualityMedium: string;
            researchQualityLow: string;
            researchQualityTooltip: string;
            researchAcademicMode: string;
            researchDeepThinking: string;
            researchDeepThinkingTooltip: string;
            researchVaultPrecheckFound: string;
            researchVaultPrecheckUse: string;
            researchVaultPrecheckContinue: string;
            researchVaultPrecheckAlways: string;
            researchPerspectiveSummary: string;
            researchProviderFallback: string;
            recencyLabel: string;
            recencyAny: string;
            recencyRecent: string;
            recencyYear: string;
            researchStreamingUnsupported: string;
            claudeSearchCount: string;
            claudeSearching: string;
            claudeContinuing: string;
            researchStreamingFailed: string;
            researchSendToZotero: string;
            researchCopyCslJson: string;
            researchZoteroSuccess: string;
            researchZoteroFallback: string;
            researchZoteroDisabledTooltip: string;
            researchSaveFindings: string;
            researchSaveFindingsTooltip: string;
            researchSaveFindingsSuccess: string;
            researchChooseFolder: string;
            researchResultsSummary: string;
            // === Plan 1: Chat Persistence ===
            // Resume Picker
            resumeTitle: string;
            resumeProjects: string;
            resumePresentations: string;
            resumeRecent: string;
            resumeNewConversation: string;
            resumeNewPresentation: string;
            resumeSlides: string;
            resumeNewProject: string;
            resumeProjectChats: string;
            resumeMessages: string;
            resumeTimeAgo: string;
            resumeNewInProject: string;
            resumeProjectName: string;
            resumeProjectInstructions: string;
            resumeProjectCreate: string;
            resumeProjectCancel: string;
            resumeRename: string;
            resumeRenamePlaceholder: string;
            resumeRenameSave: string;
            resumeRenameCancel: string;
            resumeDeleteConfirm: string;
            resumeEmpty: string;
            // Projects
            projectIndicator: string;
            projectSettings: string;
            projectFreeOnly: string;
            projectInstructions: string;
            projectInstructionsDesc: string;
            projectMemory: string;
            projectMemoryDesc: string;
            projectMemoryAdd: string;
            projectMemoryRemove: string;
            projectMemoryEmpty: string;
            projectPinnedFiles: string;
            projectPinnedFilesDesc: string;
            projectPinnedAdd: string;
            projectPinnedRemove: string;
            projectPinnedEmpty: string;
            projectPinnedTruncated: string;
            projectDelete: string;
            projectDeleteConfirm: string;
            // Auto-Memory
            memoryAdded: string;
            projectMemoryConfirm: string;
            projectMemoryConfirmFact: string;
            projectMemoryDismissed: string;
            projectMemoryNoted: string;
            // Free Chat mode
            modeFree: string;
            introFree: string;
            placeholderFree: string;
            freeUnavailable: string;
            modePresentation: string;
            introPresentation: string;
            placeholderPresentation: string;
            placeholderPresentationRefine: string;
            presentationUnavailable: string;
            // Targeted slide editing (slide-authoring-editing plan).
            // Templates with `{n}` / `{end}` / `{kind}` placeholders.
            slideSelectionLabelSlide: string;       // "Slide {n}"
            slideSelectionLabelRange: string;       // "Slides {n}–{end}"
            slideSelectionLabelElement: string;     // "Slide {n} → {kind}"
            slideSelectionClearAria: string;        // "Clear selection: {label}"
            slideSelectionClearTitle: string;       // "Clear selection"
            slideEditModeLabel: string;             // "Edit mode:"
            slideEditModeContent: string;           // "Content"
            slideEditModeDesign: string;            // "Design"
            slideEditFlagWebSearch: string;         // "Web search"
            slideDiffTitle: string;                 // "Review slide edit"
            slideDiffReject: string;                // "Reject"
            slideDiffAccept: string;                // "Accept"
            slideDiffEmpty: string;                 // "Nothing to apply…"
            slideDiffDriftSummary: string;          // "Model also changed {n} slide{s} outside your selection — show changes"
            slideDiffIntegrityAdded: string;        // "The model added one or more slides…"
            slideDiffIntegrityRemoved: string;      // "The model removed one or more slides…"
            slideDiffIntegrityClassChanged: string; // "The model changed slide layout classes…"
            slideDiffIntegrityElementPathsChanged: string;
            slideDiffDesignTextChanged: string;
            slideDiffSiblingAdvisory: string;
            slideDiffSiblingSummary: string;
            slideSelectorCommand: string;
            slideSelectorPlaceholder: string;
            slideSelectorEntry: string;
            slideBgHoverTooltipTemplate: string;
            slideCreateAudienceLabel: string;
            slideCreateAudienceAnalyst: string;
            slideCreateAudienceExecutive: string;
            slideCreateAudienceGeneral: string;
            slideCreateLengthLabel: string;
            slideCreateLengthCustom: string;
            slideCreateLengthProviderCap: string;
            slideCreateSpeedLabel: string;
            slideCreateSpeedFast: string;
            slideCreateSpeedQuality: string;
            slideCreateSpeedFastTooltip: string;
            slideCreateSpeedQualityTooltip: string;
            slideCreatePlanLabel: string;
            slideCreatePlanStoryline: string;
            slideCreatePlanDirect: string;
            slideCreateSourcesLabel: string;
            slideCreateSourcesAddNote: string;
            slideCreateSourcesAddWeb: string;
            slideCreateSourcesAddFolder: string;
            slideCreateSourcesAutoDetected: string;
            slideCreateSourcesEmpty: string;
            slideCreateSourceRemove: string;
            slideCreateSourceViewResults: string;
            slideCreateSourceHideResults: string;
            slideCreateSourceResultsEmpty: string;
            slideCreateRedetectActive: string;
            slideCreateValidationZeroSources: string;
            slideCreateValidationZeroLength: string;
            slideCreateValidationLengthOutOfRange: string;
            slideCreateBlockNoUsableSources: string;
            slideCreateBlockWebSearchNotConfigured: string;
            slideCreatePartialFailureNotice: string;
            slideCreateSourceFailureNoteNotFound: string;
            slideCreateSourceFailureNoteEmpty: string;
            slideCreateSourceFailureNoteReadFailed: string;
            slideCreateSourceFailureFolderNotFound: string;
            slideCreateSourceFailureFolderEmpty: string;
            slideCreateSourceFailureWebSearchFailed: string;
            slideCreateSourceFailureWebSearchRateLimited: string;
            slideCreateSourceFailureWebSearchNoResults: string;
            slideCreateSourceFailureWebSearchNotConfigured: string;
            // Assistant-message + advisory strings — moved out of hardcoded
            // English literals after persona walkthrough flagged i18n gap.
            slideEditFailed: string;                // "Failed to apply scoped edit: {error}"
            slideEditApplied: string;               // "Scoped edit applied. {n} slides{drift}."
            slideEditDriftSuffix: string;           // " (note: {n} slide{s} drifted outside scope — accepted)"
            slideEditRejected: string;              // "Edit rejected — original deck preserved."
            slideEditNoDeck: string;                // "No presentation to edit."
            slideRefineFailed: string;              // "Failed to refine: {error}"
            slideRefineApplied: string;             // "Updated. {n} slides. Continue refining or export."
            slideRefineNoDeck: string;              // "No presentation to refine."
            slideSearching: string;                 // mid-conversation /search progress
            slideSearchUnavailable: string;
            slideSearchNoResults: string;
            slideSearchFound: string;
            slideSearchHintStoryline: string;
            slideSearchHintDeck: string;
            slideGenerateFailed: string;            // "Failed to generate: {error}"
            storylineReady: string;                 // consultant mode: storyline note written for review
            storylineRevised: string;               // consultant mode: storyline revised, still in review
            storylineReadyInChat: string;           // consultant mode: storyline drafted in-memory (Save / Create-deck choice)
            storylineRevisedInChat: string;         // consultant mode: in-memory storyline revised, still in review
            storylineSaved: string;                 // consultant mode: storyline materialized to a .md ({name})
            storylineWriteFailed: string;           // consultant mode: storyline note write failed
            storylineBuildFailed: string;           // consultant mode: build-from-storyline failed
            storylineReviseFailed: string;          // consultant mode: storyline revision failed
            slidePreviewEmpty: string;              // "No deck yet — generate slides to see a preview here."
            slideDiffDriftAdvisory: string;         // "Accepting will also apply changes to {n} unselected slide{s}…"
            // Phase labels (previously hardcoded in PresentationModeHandler) —
            // both the side-panel status text and the thinking-indicator bubble
            // use these keys (F4 follow-up).
            phaseStoryboarding: string;
            phaseStorylineReview: string;
            phaseGenerating: string;
            phaseRefining: string;
            phaseAuditing: string;
            phaseExporting: string;
            presentationBusy: string;
            brandRerenderFailed: string;
            storylineNoteRequired: string;
            storylineNoteEmpty: string;
            storylineParseFailed: string;
            storylineRebuiltFromSavedNote: string;
            buildFromStorylineFailed: string;
            // Research extend-card copy (Phase 3 port of soft/hard budget UX) —
            // reuses the generic extend-card DOM but with research-specific
            // framing.
            researchExtendBudgetTitle: string;
            researchExtendBudgetBody: string;
            researchCancelled: string;
            researchHardCapped: string;
            // === Presentation progress UX (Plan: presentation-progress-ux) ===
            // Split into two fragments — plan §3 ARIA. Slide-count fragment is
            // announced by SR (aria-live="polite"), elapsed fragment is
            // aria-hidden and ticks silently.
            presentationProgress: string;        // "Slide {current} of {expected}"
            presentationProgressNoTotal: string; // "Slide {current}"
            presentationStarting: string;        // "Starting generation…"
            presentationStreamStarted: string;   // "Streaming response…" (latency-feedback fix #1)
            presentationBuildingSlide: string;   // "Building slide {n}…" (latency-feedback fix #2)
            presentationElapsedSeconds: string;  // "· {elapsed}s"
            extendBudgetTitle: string;           // "Still generating"
            extendBudgetBody: string;            // see en.ts
            extendBudgetConfirm: string;         // "Extend +{extendMinutes} min"
            extendBudgetCancel: string;          // "Cancel"
            generationCancelled: string;         // "Generation cancelled."
            generationHardCapped: string;        // see en.ts
            cancelGeneration: string;            // Cancel button aria-label
            // Attachments
            freeAttachPickerPlaceholder: string;
            freeAttachExternalFailed: string;
            freeAttachExtractFailed: string;
            // === Plan 2: Chat UX Improvements ===
            // Project Dropdown
            projectDropdownLabel: string;
            projectDropdownNew: string;
            projectDropdownLeave: string;
            // Global Memory (modal)
            globalMemoryTitle: string;
            globalMemoryDescription: string;
            globalMemoryEmpty: string;
            globalMemoryAdd: string;
            globalMemoryAddPlaceholder: string;
            globalMemoryRemove: string;
            globalMemorySave: string;
            globalMemoryCancel: string;
            globalMemoryFull: string;
            // === Plan 3: Smart Document Indexing ===
            // Indexing choice modal
            indexingTitle: string;
            indexingStats: string;
            indexingDescription: string;
            indexingCreateProject: string;
            indexingIntoProject: string;
            indexingTemporary: string;
            indexingTruncate: string;
            indexingNoEmbeddings: string;
            indexingOpenSettings: string;
            // Indexing pill labels
            indexingPillProgress: string;
            indexingPillIndexed: string;
            indexingPillPartial: string;
            indexingPillFailed: string;
            indexingPillMobileCapped: string;
        };
        polishSelector: {
            title: string;
            privacyNotice: string;
            deckWideFindingsHeading: string;
            allSlides: string;
            allSlidesDescription: string;
            rowInstructionLabel: string;
            rowInstructionPlaceholder: string;
            actionButton: string;
            actionButtonAll: string;
            actionButtonSubmitting: string;
            cancel: string;
            progressLabel: string;
            analysingLabel: string;
            versionLabelAll: string;
            versionLabel: string;
            errorByCode: Record<RefineErrorCode, string>;
        };
        exportNote: {
            title: string;
            format: string;
            formatPdf: string;
            formatDocx: string;
            formatPptx: string;
            outputFolder: string;
            selectNotes: string;
            currentNote: string;
            multipleNotes: string;
            includeToc: string;
            includeTocDesc: string;
            slideLayout: string;
            slideLayoutTitleContent: string;
            slideLayoutBlank: string;
            exportButton: string;
            exporting: string;
            success: string;
            error: string;
            noNotesSelected: string;
        };
        commandPicker: {
            placeholder: string;
            navigateHint: string;
            selectHint: string;
            closeHint: string;
            emptyState: string;
            // Output-anchored category labels (locked 2026-05-01)
            // Pinned favourites cross-cut; the 5 stage categories use `t.workflowStages.*`.
            categoryPinned: string;
            // Verb-anchored sub-group labels (within a stage; presentation detail)
            groupCreateWrite: string;
            groupCreateVisualise: string;
            groupRefinePending: string;
            groupMaintainBases: string;
            groupCaptureNewsletter: string;
            // Requirement chip + reason strings (4 chips + 5 reasons; semantic-search has 2)
            requiresChipNote: string;
            requiresChipSelection: string;
            requiresChipVault: string;
            requiresChipSemanticSearch: string;
            requiresReasonNote: string;
            requiresReasonSelection: string;
            requiresReasonVault: string;
            requiresReasonSemanticSearchDisabled: string;
            requiresReasonSemanticSearchUnindexed: string;
            descriptions: {
                mapsGroup: string;
                buildInvestigationCanvas: string;
                buildContextCanvas: string;
                findRelated: string;
                insertRelatedNotes: string;
                refineGroup: string;
                smartTag: string;
                enhanceNote: string;
                smartTranslate: string;
                clearTags: string;
                digitiseImage: string;
                editMermaidDiagram: string;
                presentationChat: string;
                buildFromStoryline: string;
                quickPeek: string;
                pendingGroup: string;
                ensureNoteStructure: string;
                addToPending: string;
                integratePending: string;
                resolveEmbeds: string;
                exportGroup: string;
                exportNote: string;
                exportFlashcards: string;
                exportMinutesDocx: string;
                narrateNote: string;
                playNarration: string;
                smartSummarize: string;
                createMeetingMinutes: string;
                /** Plan F3 — new top-level "Transcribe audio" command */
                transcribeAudio: string;
                recordAudio: string;
                webReader: string;
                researchWeb: string;
                kindleSync: string;
                newsletter: string;
                newsletterFetch: string;
                newsletterRegenerateAudio: string;
                newsletterMarkCaughtUp: string;
                newsletterAudio: string;
                newsletterMarkCatchUpListened: string;
                newsletterMarkBriefRead: string;
                newSketch: string;
                askSearchGroup: string;
                chatWithAI: string;
                semanticSearch: string;
                visualizeGroup: string;
                buildClusterCanvas: string;
                showTagNetwork: string;
                createDashboard: string;
                collectAllTags: string;
                findEmbeds: string;
                buildAgentIndex: string;
                checkAgentIndex: string;
                copyAgentInstructions: string;
                setupAgentIndex: string;
                refreshCloudInventories: string;
                checkCloudInventories: string;
                setupCloudInventory: string;
                resumeOffload: string;
                copyClaudePermissions: string;
                writeAgentInstructions: string;
                runVaultUpkeep: string;
                openAgentConnectors: string;
                exportVaultMap: string;
                setupVaultUpkeep: string;
                openUpkeepReview: string;
                sweepInbox: string;
                setupInboxSweep: string;
                processCaptureInbox: string;
                reviewCaptures: string;
                setupCaptureInbox: string;
                sendTasksToGoogle: string;
                setupGoogleTasks: string;
                insertOneDriveLink: string;
                refreshOneDriveEmbed: string;
                notebookLMGroup: string;
                notebookLMExport: string;
                notebookLMToggle: string;
                notebookLMClear: string;
                notebookLMOpenFolder: string;
                upgradeMetadata: string;
                upgradeFolderMetadata: string;
                groupCreateWrite: string;
                groupCreateVisualise: string;
                groupRefinePending: string;
                groupMaintainBases: string;
                groupCaptureNewsletter: string;
            };
            badgeComingSoonExplanation: string;
            badgeDevelopingExplanation: string;
        };
        tagPicker: {
            title: string;
            placeholder: string;
            noTags: string;
        };
        costConfirm: {
            title: string;
            statSpokenChars: string;
            statEstDuration: string;
            statChunks: string;
            statVoice: string;
            statEstCost: string;
            statOutputPath: string;
            cancel: string;
            settings: string;
            generate: string;
            durationFmt: string;
            costFmt: string;
        };
        audioPlayer: {
            title: string;
            speedLabel: string;
            skipBack: string;
            skipForward: string;
            openExternal: string;
        };
        webReader: {
            title: string;
            loadingDescription: string;
            cancelButton: string;
            noUrlsFound: string;
            noSummaryAvailable: string;
            fetchingArticle: string;
            summarizingArticle: string;
            selectAll: string;
            deselectAll: string;
            selected: string;
            selectToKeep: string;
            noteTitleLabel: string;
            noteTitlePlaceholder: string;
            createNote: string;
            discardSelected: string;
            discardAllClose: string;
            createdNote: string;
            completionTitle: string;
            completionMessage: string;
            closeButton: string;
            excerpt: string;
            fetchFailed: string;
            largeSetConfirm: string;
        };
        kindle: {
            title: string;
            description: string;
            syncFromAmazon: string;
            importFile: string;
            lastSynced: string;
            noBooks: string;
            noTxtFiles: string;
            selectAll: string;
            deselectAll: string;
            newOnly: string;
            selected: string;
            selectBooksPrompt: string;
            highlights: string;
            newHighlights: string;
            upToDate: string;
            autoTagToggle: string;
            importButton: string;
            importing: string;
            progress: string;
            tagging: string;
            enhancing: string;
            complete: string;
            booksImported: string;
            openNote: string;
            done: string;
            // Amazon cloud sync (cookie-based)
            loginTitle: string;
            step1Title: string;
            step1Desc: string;
            openAmazon: string;
            step2Title: string;
            step2Desc: string;
            copiedToClipboard: string;
            step3Title: string;
            pasteCookies: string;
            invalidCookiesWarning: string;
            validatingCookies: string;
            cookiesExpiredOrInvalid: string;
            amazonLoginExpired: string;
            fetchingLibrary: string;
            neverSynced: string;
            synced: string;
            previouslySynced: string;
            cancel: string;
            libraryRefreshTitle: string;
            libraryRefreshDesc: string;
            refreshLibrary: string;
        };
        mermaidChat: {
            title: string;
            description: string;
            placeholder: string;
            placeholderNew: string;
            sendButton: string;
            applyButton: string;
            copyButton: string;
            discardButton: string;
            noBlockFound: string;
            generating: string;
            generated: string;
            applied: string;
            copied: string;
            syntaxErrors: string;
            rawCodeToggle: string;
            blockNotFound: string;
            insertAtCursor: string;
            privacyRequired: string;
            previewTab: string;
            chatTab: string;
            selectDiagram: string;
            cancelButton: string;
            convertTo: string;
            cancelled: string;
            selectDiagramType: string;
            historyPrev: string;
            historyNext: string;
            historyLabel: string;
            diffChanges: string;
            diffAdded: string;
            diffRemoved: string;
            // Phase 4: context
            contextToggle: string;
            contextIncludeNote: string;
            contextIncludeBacklinks: string;
            contextIncludeRAG: string;
            contextGathering: string;
            // Phase 4: templates
            templateButton: string;
            templateSelectTitle: string;
            templateNoTemplates: string;
            templateApplied: string;
            // Phase 4: export
            exportButton: string;
            exportSVG: string;
            exportPNG: string;
            exportFile: string;
            exportCanvas: string;
            exportAppendCanvas: string;
            exportSaving: string;
            exportSavedSVG: string;
            exportSavedPNG: string;
            exportSavedMermaid: string;
            exportSavedCanvas: string;
            exportFailed: string;
            saveAsTemplate: string;
            saveAsTemplatePrompt: string;
            saveAsTemplateSuccess: string;
            // Phase 4: alt text & staleness
            altTextGenerated: string;
            stalenessNotice: string;
            stalenessSnooze: string;
            stalenessUpdate: string;
            // Phase 4: settings
            settingsTitle: string;
            settingsDescription: string;
            settingsContextTitle: string;
            includeNoteContext: string;
            includeNoteContextDesc: string;
            includeBacklinks: string;
            includeBacklinksDesc: string;
            includeRAG: string;
            includeRAGDesc: string;
            ragChunks: string;
            ragChunksDesc: string;
            settingsExportTitle: string;
            exportTheme: string;
            exportThemeDesc: string;
            exportThemeDefault: string;
            exportThemeDark: string;
            exportThemeForest: string;
            exportThemeNeutral: string;
            exportScale: string;
            exportScaleDesc: string;
            settingsExperimentalTitle: string;
            stalenessNoticeSetting: string;
            stalenessNoticeDesc: string;
            stalenessGutter: string;
            stalenessGutterDesc: string;
            generateAltText: string;
            generateAltTextDesc: string;
        };
    };

    // Kindle auth method strings (Phase 1+2)
    kindleSync: {
        // Phase 1 — Bookmarklet & validation
        bookmarkletDrag: string;
        bookmarkletCopy: string;
        bookmarkletCopied: string;
        advancedConsole: string;
        validationReady: string;
        validationMissingSession: string;
        validationMissingUbid: string;
        validationEmpty: string;
        saveConnect: string;
        sessionExpired: string;
        // Phase 2 — Embedded login
        signInBrowser: string;
        signInBrowserDesc: string;
        desktopOnly: string;
        waitingForLogin: string;
        loginSuccess: string;
        loginTimeout: string;
        extractingBooks: string;
        loginFailed: string;
        loginClosed: string;
        otherSignInOptions: string;
        fallbackNotice: string;
    };

    // File menu items
    fileMenu: {
        tagNetwork: string;
    };

    // Dropdown options
    dropdowns: {
        localLLM: string;
        cloudService: string;
        openai: string;
        gemini: string;
        deepseek: string;
        aliyun: string;
        claude: string;
        groq: string;
        vertex: string;
        openrouter: string;
        bedrock: string;
        requesty: string;
        cohere: string;
        grok: string;
        mistral: string;
        openaiCompatible: string;
        azureClaude: string;
        azureOpenAI: string;
        ollama: string;
        localai: string;
        lmStudio: string;
        jan: string;
        koboldcpp: string;
    };

    // Tips
    tips: {
        ollama: string;
        localai: string;
        lmStudio: string;
        jan: string;
        koboldcpp: string;
    };

    // Minutes generation
    minutes: {
        modalTitle: string;
        recordBannerLabel: string;
        fieldTitle: string;
        fieldDate: string;
        fieldStartTime: string;
        fieldEndTime: string;
        fieldLocation: string;
        fieldChair: string;
        // Phase 2 TRA: Style + meeting context
        fieldStyle: string;
        fieldStyleDesc: string;
        fieldMeetingContext: string;
        fieldMeetingContextDesc: string;
        contextInternal: string;
        contextBoard: string;
        contextExternal: string;
        fieldAgenda: string;
        fieldAgendaDesc: string;
        fieldAgendaLoad: string;
        agendaExtracting: string;
        agendaExtracted: string;
        agendaLoadedRaw: string;
        fieldTranscript: string;
        fieldTranscriptDesc: string;
        fieldTranscriptLoad: string;
        fieldTranscriptLoadText: string;
        fieldDualOutput: string;
        fieldDualOutputDesc: string;
        fieldObsidianTasks: string;
        fieldObsidianTasksDesc: string;
        fieldGTDOverlay: string;
        fieldGTDOverlayDesc: string;
        privacyWarning: string;
        participantsSection: string;
        fieldParticipants: string;
        fieldParticipantsDesc: string;
        advancedSection: string;
        fieldModel: string;
        fieldModelDesc: string;
        fieldLanguageOverride: string;
        fieldLanguageOverrideDesc: string;
        fieldCustomInstructions: string;
        fieldCustomInstructionsDesc: string;
        fieldStyleReference: string;
        fieldStyleReferenceDesc: string;
        fieldStyleReferenceLoad: string;
        fieldStyleReferenceLoaded: string;
        fieldStyleReferencePlaceholder: string;
        submitButton: string;
        generating: string;
        generatingChunk: string;
        // Phase 4 — progress/cancel/budget copy for chunked minutes
        progressChunkOf: string;       // "Chunk {current} of {total} · {elapsed}"
        progressElapsed: string;       // "{elapsed}"  (pre-first-chunk)
        cancelButton: string;          // "Cancel"
        cancelled: string;             // "Minutes generation cancelled."
        softBudgetNotice: string;      // "Still going — {elapsed} elapsed (hard cap at {hardMinutes}m)"
        hardCapped: string;            // "Minutes generation exceeded the {budgetMinutes}-minute budget and was cancelled. Try shorter transcripts or split into parts."
        intermediateConsolidation: string;
        consolidating: string;
        extractingStyle: string;
        extractingContext: string;
        saved: string;
        errorParsing: string;
        errorMissingFields: string;
        errorNoPersonas: string;
        // Auto-detected inputs banner (above the fold, shown when any input is auto-detected)
        detectedInputsLabel: string;
        detectedDocumentsChip: string;
        detectedAudioChip: string;
        // Audio transcription
        audioTranscriptionSection: string;
        audioDetected: string;
        transcriptionLanguage: string;
        transcribeButton: string;
        transcribing: string;
        transcriptionComplete: string;
        transcriptionFailed: string;
        noTranscriptionProvider: string;
        errorAudioNotFound: string;
        // Audio attach helper (plan F1 — unconditional attach UI)
        audioSectionHeading: string;
        audioSectionDescription: string;
        audioAttachFile: string;
        audioPickVault: string;
        audioRecordNow: string;
        audioPickerOpening: string;
        audioReplace: string;
        audioRetranscribe: string;
        audioRetry: string;
        audioAbort: string;
        audioDetectedPromptOne: string;
        audioDetectedPromptMany: string;
        audioDetectedUseIt: string;
        audioDetectedIgnore: string;
        audioItemTranscribed: string;
        audioItemTranscribing: string;
        audioItemPending: string;
        audioItemError: string;
        // Speaker review panel (plan F2 — confirm/rename speakers before minutes)
        speakerReviewHeading: string;
        speakerReviewDescription: string;
        speakerReviewSinglePersonHint: string;
        speakerNameDropdownLabel: string;
        speakerNameUnconfirmed: string;
        speakerNameTypeFallback: string;
        speakerSameAsLabel: string;
        speakerPlayPreview: string;
        speakerPreviewUnavailable: string;
        speakerOccurrenceCountLabel: string;
        speakerConfirmButton: string;
        speakerSkipButton: string;
        speakerEditAfterConfirm: string;
        speakerDetectionFailedBanner: string;
        speakerDetectionUnavailableBanner: string;
        speakerLabellingThrewBanner: string;
        confirmSpeakersFirst: string;
        // Document auto-inject opt-in (plan F4)
        docDetectedPromptOne: string;
        docDetectedPromptMany: string;
        docAttachAll: string;
        docPickWhich: string;
        docIgnore: string;
        docMultiPickerTitle: string;
        docMultiPickerDescription: string;
        docMultiPickerSearchPlaceholder: string;
        docMultiPickerConfirmButton: string;
        docMultiPickerEmpty: string;
        // TranscribeOnlyModal (plan F3)
        transcribeOnlyTitle: string;
        transcribeOnlyDescription: string;
        transcribeOnlyOutputFolderLabel: string;
        transcribeOnlySaveButton: string;
        transcribeOnlyCancelButton: string;
        transcribeOnlySavedNotice: string;
        transcribeOnlyFollowUpHint: string;
        transcribeOnlyAttachFirst: string;
        transcribeOnlyTranscribeFirst: string;
        // Context documents
        contextDocumentsSection: string;
        contextDocumentsDesc: string;
        addDocument: string;
        extractAll: string;
        extracting: string;
        removeDocument: string;
        documentExtracted: string;
        documentFailed: string;
        noDocumentsAttached: string;
        noDocumentsFound: string;
        // Dictionary
        dictionarySection: string;
        dictionaryDesc: string;
        dictionarySelect: string;
        dictionaryNone: string;
        dictionaryCreateNew: string;
        dictionaryEdit: string;
        dictionaryNamePrompt: string;
        dictionaryNamePlaceholder: string;
        dictionaryCreated: string;
        dictionaryCreateFailed: string;
        dictionaryExtractFromDocs: string;
        dictionaryExtracting: string;
        dictionaryExtracted: string;
        dictionaryExtractionFailed: string;
        dictionaryNoDocsExtracted: string;
        dictionaryCreatePrompt: string;
        dictionaryNotFound: string;
        truncateOption: string;
        useFullOption: string;
        skipOption: string;
        truncateTooltip: string;
        useFullTooltip: string;
        skipTooltip: string;
        oversizedDocuments: string;
        applyToAll: string;
        downloadingDocument: string;
        extractingText: string;
        documentDownloadFailed: string;
        complexRtfNotSupported: string;
        fullDocumentWarning: string;
        excludedFromContext: string;
        agendaAutoFilled: string;
        participantsAutoExtracted: string;
        dictionaryAutoExtracting: string;
        allDocumentsExtracted: string;
        extractingDocuments: string;
        extractionErrors: string;
        extractionComplete: string;
        transcriptAutoLoaded: string;
        transcriptCached: string;
        audioTranscriptCached: string;
        participantsSuggestedFromDictionary: string;
        // Participant lists
        participantListSelect: string;
        participantListNone: string;
        participantListCreateNew: string;
        participantListSaveCurrent: string;
        participantListNamePrompt: string;
        participantListSaved: string;
        participantListLoaded: string;
        participantListCreated: string;
        participantListNoEntries: string;
        outputFolderLabel: string;
        // Word export
        exportDocx: string;
        exportDocxDesc: string;
        exportDocxSuccess: string;
        exportDocxNoMinutes: string;
        exportDocxFailed: string;
        exportDocxCancelled: string;
        // Phase 2 TRA: Transcript quality warnings
        transcriptCorrupt: string;
        transcriptIncomplete: string;
        transcriptIncompleteBlock: string;
        transcriptIncompleteConfirm: string;
        transcriptIncompleteAgenda: string;
        cancelLabel: string;
        proceedAnyway: string;
        // Multi-segment minutes (plan: docs/plans/multi-segment-minutes.md)
        sections?: {
            general: string;
            addTopicButton: string;
            topicNamePlaceholder: string;
            topicCreated: string;
            topicNameTooLong: string;
            topicDuplicateRenamed: string;
            sectionAssignmentLabel: string;
            topicsSoFar: string;
            sectionChipLabel: string;
            scopeFilesInNote: string;
            scopeAllVault: string;
            segmentExtractionFailed: string;
            segmentCancelled: string;
            consolidationTruncated: string;
        };
    };
    // Phase 5 — Smart Tag batch progress copy. Lives top-level so commands
    // + status-bar component + notices can all reach it.
    smartTag: {
        progressStarting: string;       // "Tagging…" (pre-first-item)
        progressLabel: string;          // "Tagging {current}/{total} · {elapsed}"
        cancelLabel: string;            // aria-label on the × button
        cancelMobileHint: string;       // "Tap here to cancel tagging"
        cancelled: string;              // "Tagging cancelled — {done} of {total} done"
        softBudgetNotice: string;       // "Still running — {elapsed} elapsed (hard cap {hardMinutes}m)"
        hardCapped: string;             // "Tagging exceeded {budgetMinutes}-min budget; stopped after {done} of {total}"
        complete: string;               // "Tagging complete — {successful} of {total} tagged"
    };
    integration: {
        resolveEmbeds: string;
        resolveEmbedsDesc: string;
        embedsFound: string;
        resolveConfirm: string;
        resolveSuccess: string;
        noEmbedsToResolve: string;
    };
    notebooklm: {
        linkedDocumentsDetected: string;
        documentExportNotice: string;
        latinOnlyWarning: string;
        exportProgress: string;
        generatingPdf: string;
        copyingDocument: string;
        writingManifest: string;
        exportComplete: string;
        exportAborted: string;
        cancelButton: string;
        sidecarTitle: string;
        sidecarNotice: string;
        sidecarShowMore: string;
        configChangedNotice: string;
    };
    recording: {
        title: string;
        record: string;
        stop: string;
        play: string;
        save: string;
        discard: string;
        recording: string;
        saving: string;
        transcribing: string;
        saved: string;
        savedAndTranscribed: string;
        insertAtCursor: string;
        createNewNote: string;
        embedAudio: string;
        autoTranscribe: string;
        notSupported: string;
        noSupportedFormat: string;
        micPermissionDenied: string;
        tooLargeForAutoTranscribe: string;
        noEditorAvailable: string;
        maxRecordingTime: string;
        confirmDiscard: string;
        confirmDiscardStopped: string;
        settingsAutoTranscribe: string;
        settingsAutoTranscribeDesc: string;
        settingsEmbed: string;
        settingsEmbedDesc: string;
        settingsInfo: string;
        filenamePlaceholder: string;
        settingsQuality: string;
        settingsQualityDesc: string;
        qualitySpeech: string;
        qualityHigh: string;
        postRecordingTitle: string;
        keepOriginal: string;
        keepCompressed: string;
        deleteAudio: string;
        keepOriginalDesc: string;
        keepCompressedDesc: string;
        deleteAudioDesc: string;
        compressing: string;
        audioDeleted: string;
        audioCompressed: string;
        compressionFailed: string;
        settingsPostRecording: string;
        settingsPostRecordingDesc: string;
        postRecordingAsk: string;
        postRecordingKeepOriginal: string;
        postRecordingKeepCompressed: string;
        postRecordingDelete: string;
    };
    azureRateLimit: {
        tpmExceeded: string;
        queueFull: string;
    };
    oneDriveLink: {
        title: string;
        pickLocalFileButton: string;
        localLinkDeviceOnlyNotice: string;
        linkTextLabel: string;
        linkTextPlaceholder: string;
        shareUrlLabel: string;
        shareUrlPlaceholder: string;
        insertShareLinkButton: string;
        invalidLinkError: string;
        desktopOnlyNotice: string;
        noActiveNoteNotice: string;
        pickerUnavailableNotice: string;
        pickerFailedNotice: string;
        unbuildablePathNotice: string;
        unexpectedErrorNotice: string;
        embedTooLargeNotice: string;
        embedFailedNotice: string;
        refreshNoEmbedsNotice: string;
        refreshUpToDateNotice: string;
        refreshConfirmTitle: string;
        refreshConfirmBody: string;
        refreshConfirmConfirm: string;
        refreshConfirmCancel: string;
        refreshFailedNotice: string;
        refreshPartialNotice: string;
        refreshDoneNotice: string;
    };
    embedScan: {
        // Scope modal
        scopeTitle: string;
        scopeDescription: string;
        scopeNote: string;
        scopeFolder: string;
        scopeVault: string;
        noFileOpen: string;
        notesLabel: string;
        // Scanning progress
        scanning: string;
        scanProgress: string;
        cancelButton: string;
        scanCancelled: string;
        scanError: string;
        noNotesToScan: string;
        noEmbedsFound: string;
        // Results modal
        resultsTitle: string;
        searchPlaceholder: string;
        sortLabel: string;
        sortSizeDesc: string;
        sortSizeAsc: string;
        sortRefsDesc: string;
        sortRefsAsc: string;
        sortNameAsc: string;
        minSizeLabel: string;
        allSizes: string;
        scannedNotes: string;
        totalFiles: string;
        summaryUnused: string;
        summaryInUse: string;
        totalSize: string;
        showingResults: string;
        noResults: string;
        reference: string;
        references: string;
        referencedBy: string;
        openFile: string;
        copyPath: string;
        pathCopied: string;
        lineNumber: string;
        embedded: string;
        linked: string;
        // Type labels
        typeImage: string;
        typePdf: string;
        typeAudio: string;
        typeVideo: string;
        typeDocument: string;
        typeOther: string;
        typeAll: string;
        // Orphan section
        possiblyOrphanedTitle: string;
        orphanDisclaimer: string;
        orphanCount: string;
        // Delete
        deleteSelected: string;
        deleteConfirmTitle: string;
        deleteConfirmMessage: string;
        deleteConfirmWarning: string;
        deleteSuccess: string;
        deleteError: string;
        selectAll: string;
        deselectAll: string;
        selectedCount: string;
        selectFile: string;
        // Attachment helper
        explainerTitle: string;
        explainerBody: string;
        explainerDismiss: string;
        largeChip: string;
        largeBadge: string;
        duplicateBadge: string;
        duplicateBadgeTitle: string;
        findDuplicates: string;
        findDuplicatesHelp: string;
        duplicatesRunning: string;
        duplicatesCancel: string;
        duplicatesStopped: string;
        duplicatesNone: string;
        duplicatesFound: string;
        duplicatesSkipped: string;
        suggestHome: string;
        suggestHomeLoading: string;
        suggestHomeNone: string;
        suggestHomeBasic: string;
        suggestHomeSemantic: string;
        suggestHomeDeclined: string;
        suggestHomeError: string;
        linkButton: string;
        linkAriaLabel: string;
        linkedNotice: string;
        alreadyLinkedNotice: string;
        protectedNotLinkable: string;
        egressTitle: string;
        egressBody: string;
        egressSend: string;
        egressBasic: string;
        reasonReferenced: string;
        reasonAmbiguous: string;
        reasonCanvas: string;
        reasonIncomplete: string;
        reasonChanged: string;
        reasonMissing: string;
        reasonProtected: string;
        couldNotReadTitle: string;
        couldNotReadHelp: string;
        outOfDate: string;
        scanAgain: string;
        coverageNote: string;
        coverageAcknowledge: string;
        keptNotice: string;
        keptReasonsTitle: string;
        keptPanelLabel: string;
        keptIntro: string;
        keptLinksNotRemovable: string;
        keptUsedIn: string;
        keptUsedInCanvas: string;
        keptUsedInUnknown: string;
        keptReferrerProtected: string;
        keptCanvasHint: string;
        keptOpenNote: string;
        keptOpenCanvas: string;
        keptOpenFile: string;
        keptAmbiguous: string;
        keptAmbiguousUnknown: string;
        keptUnreadableNote: string;
        keptUnreadableCanvas: string;
        keptUnreadableHint: string;
        keptUnreadableUnknown: string;
        keptChanged: string;
        removeLinkAndDelete: string;
        removeLinkOff: string;
        removeLinkEnable: string;
        notReadyText: string;
        notReadyHint: string;
        notReadyRetry: string;
        unlinkPreviewTitle: string;
        unlinkPreviewIntro: string;
        unlinkLineRemoved: string;
        unlinkBefore: string;
        unlinkAfter: string;
        unlinkApply: string;
        unlinkDone: string;
        unlinkNotesCount: string;
        unlinkPartial: string;
        inUseSummary: string;
        missingTargetsSummary: string;
        duplicatesChip: string;
        settingsTitle: string;
        allowLinkRemovalName: string;
        allowLinkRemovalDesc: string;
        revalidating: string;
        // Close
        closeButton: string;
    };
    progress: ProgressStrings;
    diarization: {
        checkboxLabel: string;
        costPreview: string;          // template: "Deepgram - {cost} for this file"
        costUnknown: string;
        disabledTooltip: string;
        multiFileDisabledTooltip: string;
        fileTooLarge: string;         // template: "{sizeMB} / {limitMB}"
        largeFileSyncWarning: string; // template: "{sizeMB}"
        privacyTitle: string;
        privacyDescription: string;
        privacyAccept: string;
        privacyReject: string;
        failedNotice: string;         // template: "{error}"
        apiKeyLabel: string;
        apiKeyDescription: string;
        // Provider-aware copy (azure-audio Cluster D — rC H3)
        providerLabel: string;
        providerDesc: string;
        providerOff: string;
        providerAzureSpeech: string;
        providerDeepgram: string;
        azureSpeechCostNote: string;
        voicesLoaded: string;         // template: "{count}"
        statusAzureSpeech: string;
        statusDeepgram: string;
        statusNotConfigured: string;
    };
    // Slides side-rail workspace layout controls (accessible names / tooltips).
    presentationLayout: {
        collapseChatPanel: string;
        expandChatPanel: string;
        resizeChatPanel: string;
        openChatPanel: string;   // narrow-width bottom-sheet FAB
        slideThumbnails: string; // filmstrip group aria-label
        slideThumbnailItem: string; // per-thumbnail aria-label, `{n}` = 1-based slide number
    };
    // LLM gateway-lite: provider trust badge, fail-closed notice, run status line.
    llmGateway: {
        azureNotConfiguredNotice: string;   // one-time notice on misconfigured Azure
        badgeAzure: string;                 // template: "Azure {provider}"
        badgePersonal: string;              // template: "Personal {provider}"
        badgeLocal: string;                 // "Local"
        badgeInvalid: string;               // "Azure not configured"
        badgeNotConfigured: string;         // template: "{provider} not configured" (personal/local)
        badgeTooltip: string;               // template: "Endpoint: {host}"
        badgeTooltipInvalid: string;        // "Configure Azure in settings"
        statusRateLimited: string;          // template: "Rate limited — retrying in {seconds}s…"
        statusCancelled: string;            // "Cancelled"
        cancelButton: string;               // "Cancel"
        cancelTooltip: string;              // "Cancel the current build"
    };
    setup: {
        statusNotSetUp: string;
        statusReady: string;
        statusNeedsAttention: string;
        setUpButton: string;
        reviewSetupButton: string;
        /** "Step {current} of {total}" */
        stepLabel: string;
        back: string;
        next: string;
        finish: string;
        cancel: string;
        previewButton: string;
        addFolder: string;
        chooseFolder: string;
        removeFolder: string;
        noFoldersYet: string;
        /** "{count} notes" */
        folderCount: string;
        folderMissing: string;
        folderMissingWarning: string;
        reasons: Record<SetupReason, string>;
    };
    guidance: { unknown: GuidanceEntry } & Record<GuidanceCode, GuidanceEntry>;
    protectedFolders: {
        sectionTitle: string;
        statusName: string;
        description: string;
        empty: string;
        protectAction: string;
        unprotectAction: string;
        /** "{folder} is now protected ({count} notes)." */
        nowProtected: string;
        /** "{folder} is no longer protected." */
        noLongerProtected: string;
        alreadyProtected: string;
        /** "Not saved: {label} would be inside a protected folder. Choose a different folder first." */
        outputRefused: string;
        /** "{label} is inside a protected folder, so it is turned off until you change it." */
        outputOverlap: string;
        /** "{count} protected notes were skipped." */
        skipped: string;
        wizardTitle: string;
        wizardChooseTitle: string;
        wizardChooseHelp: string;
        wizardConfirmTitle: string;
        /** "{count} notes in {folders} folders will be protected." */
        wizardConfirmSummary: string;
        followedRename: string;
        wizardNothingChosen: string;
        /** Tooltip and accessible name of the shield in the file explorer. */
        badgeTooltip: string;
        showBadgeName: string;
        showBadgeDesc: string;
    };
    agentIndex: {
        sectionTitle: string;
        statusName: string;
        description: string;
        includeHeading: string;
        includeHelp: string;
        excludeHeading: string;
        excludeHelp: string;
        autoRebuildName: string;
        autoRebuildOff: string;
        autoRebuildOnChange: string;
        advancedTitle: string;
        outputPathName: string;
        outputPathDesc: string;
        aliasesName: string;
        aliasesDesc: string;
        headingsName: string;
        headingsDesc: string;
        frontmatterKeysName: string;
        frontmatterKeysDesc: string;
        unresolvedName: string;
        unresolvedDesc: string;
        buildNow: string;
        checkNow: string;
        copyInstructions: string;
        building: string;
        buildDone: string;
        buildDoneStale: string;
        checkFresh: string;
        checkStale: string;
        checkIncomplete: string;
        checkScopeChanged: string;
        checkMissing: string;
        instructionsCopied: string;
        copyFailed: string;
        instructionsWriteName: string;
        instructionsWriteDesc: string;
        instructionsPathName: string;
        instructionsPathDesc: string;
        writeButton: string;
        copyPermissions: string;
        permissionsCopied: string;
        noPermissions: string;
        previewTitle: string;
        previewCreate: string;
        previewUpdate: string;
        previewAppend: string;
        previewNoChange: string;
        previewBefore: string;
        previewAfter: string;
        previewApply: string;
        writeOff: string;
        writeCreated: string;
        writeUpdated: string;
        writeUnchanged: string;
        wizardTitle: string;
        stepFolders: string;
        stepSharing: string;
        stepPreview: string;
        sharingHelp: string;
        previewSummary: string;
        previewSample: string;
        buildAfter: string;
    };
    cloudInventory: {
        sectionTitle: string;
        statusName: string;
        description: string;
        pairsHeading: string;
        noPairs: string;
        addPair: string;
        removePair: string;
        pairSummary: string;
        scriptUrlName: string;
        scriptUrlDesc: string;
        testConnection: string;
        testing: string;
        connected: string;
        connectedNoFolder: string;
        notTested: string;
        copyScript: string;
        scriptCopied: string;
        secretCreated: string;
        wizardTitle: string;
        stepPair: string;
        stepScript: string;
        stepConnect: string;
        stepPreview: string;
        vaultFolderLabel: string;
        vaultFolderHelp: string;
        driveLinkLabel: string;
        driveLinkPlaceholder: string;
        placementLabel: string;
        placementBeside: string;
        placementInside: string;
        scriptIntro: string;
        scriptStep1: string;
        scriptStep2: string;
        scriptStep3: string;
        scriptStep4: string;
        scriptStep5: string;
        previewButton: string;
        previewTitle: string;
        previewWhere: string;
        previewLoading: string;
        createHub: string;
        refreshAll: string;
        checkAll: string;
        refreshDone: string;
        refreshFailedFor: string;
        checkDone: string;
        checkNoChange: string;
        checkIncomplete: string;
        noPairsNotice: string;
        declinedNotice: string;
        appendConfirmTitle: string;
        appendConfirmBody: string;
        appendConfirmYes: string;
        conflictNotice: string;
        advancedTitle: string;
        maxFoldersName: string;
        maxFilesName: string;
        deadlineName: string;
        blockNotice: string;
        blockTruncated: string;
        blockEmpty: string;
        columnName: string;
        columnType: string;
        columnSize: string;
        columnModified: string;
    };
    agentConnectors: {
        sectionTitle: string;
        description: string;
        openButton: string;
        exportButton: string;
        folderName: string;
        folderDesc: string;
        folderPlaceholder: string;
        modalTitle: string;
        intro: string;
        needsDesktop: string;
        routeClaude: string;
        routeCodex: string;
        routeCli: string;
        routeChat: string;
        canHeading: string;
        enforcedLabel: string;
        advisedLabel: string;
        notControlledLabel: string;
        claudeEnforced: string;
        claudeAdvised: string;
        claudeNotControlled: string;
        codexEnforced: string;
        codexAdvised: string;
        codexNotControlled: string;
        cliEnforced: string;
        cliAdvised: string;
        cliNotControlled: string;
        chatEnforced: string;
        chatAdvised: string;
        chatNotControlled: string;
        claudeStepNode: string;
        checkNode: string;
        nodeChecking: string;
        nodeFound: string;
        nodeTooOld: string;
        claudeStepOpen: string;
        claudeStepOpenOther: string;
        claudeStepAdd: string;
        copyConfig: string;
        copied: string;
        claudeStepRestart: string;
        claudeStepConfirm: string;
        testPrompt: string;
        copyPrompt: string;
        claudeCannotSee: string;
        codexStepOpen: string;
        codexStepDocs: string;
        codexStepCopy: string;
        copyInstructions: string;
        sizeOk: string;
        sizeWarn: string;
        sizeOver: string;
        cliClaude: string;
        cliCodex: string;
        cliGemini: string;
        copyLine: string;
        copySnippet: string;
        openTerminal: string;
        terminalOpened: string;
        docsHeading: string;
        docClaudeServers: string;
        docClaudeExtensions: string;
        docClaudeCode: string;
        docCodexMcp: string;
        docCodexAgents: string;
        docGemini: string;
        docNode: string;
        chatIntro: string;
        chatConfirmTitle: string;
        chatConfirmBody: string;
        chatWorking: string;
        chatDone: string;
        chatRetired: string;
        chatChanged: string;
        fileSingular: string;
        filePlural: string;
        routeReadOnly: string;
        readOnlyEnforced: string;
        readOnlyAdvised: string;
        readOnlyNotControlled: string;
        roStepFolder: string;
        saveFolder: string;
        roStepCreate: string;
        createFiles: string;
        creatingFiles: string;
        filesDone: string;
        roStepClaude: string;
        roVaultFolder: string;
        roClaudeNode: string;
        roClaudeConfirm: string;
        roClaudeAdmin: string;
        roStepCodex: string;
        copyToml: string;
        roStepTest: string;
        testConnector: string;
        testing: string;
        testPassed: string;
        roStop: string;
        preferReadOnly: string;
    };
    vaultUpkeep: {
        sectionTitle: string;
        statusName: string;
        description: string;
        setupButton: string;
        runNow: string;
        openReview: string;
        intervalName: string;
        intervalOff: string;
        intervalHourly: string;
        intervalDaily: string;
        intervalWeekly: string;
        intervalCustom: string;
        customMinutesName: string;
        tasksHeading: string;
        taskAgentIndex: string;
        taskInventories: string;
        taskAttachments: string;
        taskUnavailable: string;
        taskNeedsSetup: string;
        taskInventoriesNote: string;
        autoRefreshName: string;
        autoRefreshDesc: string;
        duplicatesName: string;
        duplicatesDesc: string;
        reportFolderName: string;
        reportFolderDesc: string;
        mobileName: string;
        mobileDesc: string;
        capName: string;
        advancedTitle: string;
        lastRunLine: string;
        neverRun: string;
        nextRunLine: string;
        nextRunOff: string;
        wizardTitle: string;
        stepWhen: string;
        whenHelp: string;
        stepPreview: string;
        previewHelp: string;
        previewSchedule: string;
        previewWorking: string;
        previewResult: string;
        previewPartial: string;
        previewNetwork: string;
        reviewTitle: string;
        reviewIntro: string;
        reviewEmpty: string;
        neverRunReview: string;
        statusOk: string;
        statusPartial: string;
        statusFailed: string;
        taskLine: string;
        statusTaskOk: string;
        statusTaskSkipped: string;
        statusTaskFailed: string;
        statusTaskCancelled: string;
        kindIndexStale: string;
        kindIndexRefreshed: string;
        kindInventory: string;
        kindUnreferenced: string;
        kindLarge: string;
        kindDuplicate: string;
        kindLink: string;
        actionRebuildIndex: string;
        actionRefreshInventory: string;
        actionFindEmbeds: string;
        moreItems: string;
        saveReport: string;
        reportSaved: string;
        newerResult: string;
        showNewer: string;
        foundNotice: string;
        failedNotice: string;
        nothingNotice: string;
        partialNotice: string;
        runningNotice: string;
        indexStaleLine: string;
        indexRefreshedLine: string;
        suggestionLine: string;
    };
    projects: {
        sectionTitle: string;
        description: string;
        adoptCommand: string;
        openCommand: string;
        adoptedNotice: string;
        noActiveNote: string;
        pickerTitle: string;
        pickerPlaceholder: string;
        pickerEmpty: string;
        pickerNoMatch: string;
        pickerReason: string;
        adoptedCount: string;
        duplicateNote: string;
        unadoptedNote: string;
        statusNone: string;
        rootKinds: Record<'inbox' | 'projects' | 'areas' | 'reference' | 'archive', string>;
        pairing: Record<'none' | 'drive-pending' | 'paired', string>;
        rootsName: string;
        rootsDesc: string;
        rootsEmpty: string;
        rootAdd: string;
        rootRemove: string;
        rootPathLabel: string;
        rootKindLabel: string;
        rootProblems: Record<'root-missing' | 'root-protected' | 'root-output-folder' | 'inbox-mismatch' | 'root-overlap', string>;
    };
    integrationStatus: {
        title: string;
        intro: string;
        moduleName: Record<'tasks' | 'inventory', string>;
        notConfigured: string;
        notChecked: string;
        line: string;
        legacy: string;
        lacks: string;
        checkNow: string;
        checking: string;
        failed: string;
        waitingRedeploy: string;
        access: string;
    };
    inboxSweep: {
        sectionTitle: string;
        statusName: string;
        description: string;
        setupButton: string;
        runNow: string;
        keepOutSummary: string;
        advancedTitle: string;
        maxNotesName: string;
        maxCharsName: string;
        contextsName: string;
        destinationLabel: string;
        destinationReportOnly: string;
        dateLabel: string;
        dateFromText: string;
        dateNeededHint: string;
        refreshing: string;
        refreshedNotice: string;
        contextsDesc: string;
        contextsReset: string;
        contextsDropped: string;
        wizardTitle: string;
        stepFolders: string;
        foldersHelp: string;
        reportName: string;
        reportDesc: string;
        stepKeepOut: string;
        keepOutHelp: string;
        keepOutFolders: string;
        keepOutTags: string;
        keepOutTagsDesc: string;
        keepOutProps: string;
        keepOutPropsDesc: string;
        keepOutTerms: string;
        keepOutTermsDesc: string;
        nothingToKeepOut: string;
        nothingToKeepOutDesc: string;
        stepPreview: string;
        previewHelp: string;
        previewWorking: string;
        previewResult: string;
        previewHeld: string;
        confirmTitle: string;
        confirmBody: string;
        privacyNotice: string;
        working: string;
        cancelledNotice: string;
        alreadyRunning: string;
        nothingToSweep: string;
        nothingToSweepHeld: string;
        summaryHeld: string;
        summaryNotice: string;
        reportConflictNotice: string;
        commitStopped: string;
        addedNotice: string;
        markedNotice: string;
        sending: string;
        sentNotice: string;
        reviewTitle: string;
        reviewIntro: string;
        reviewEmpty: string;
        truncatedNote: string;
        droppedNote: string;
        noProposals: string;
        alreadyAdded: string;
        looksAdded: string;
        allAlreadyAdded: string;
        duplicatesSkipped: string;
        includeItem: string;
        itemText: string;
        itemContext: string;
        noContext: string;
        markSwept: string;
        addButton: string;
        markReviewedButton: string;
        kindLabels: Record<'next_action' | 'waiting_for' | 'project' | 'someday_maybe', string>;
    };
    captureInbox: {
        sectionTitle: string;
        statusName: string;
        description: string;
        setupButton: string;
        runNow: string;
        reviewButton: string;
        advancedTitle: string;
        onOpenName: string;
        onOpenDesc: string;
        onOpenMaxName: string;
        maxPerRunName: string;
        maxAttachmentName: string;
        maxAttachmentDesc: string;
        minWordsName: string;
        minWordsDesc: string;
        digitiseImagesName: string;
        digitiseImagesDesc: string;
        stabilityName: string;
        stabilityDesc: string;
        requireMarkerName: string;
        requireMarkerDesc: string;
        destinationName: string;
        destinationDesc: string;
        activityTitle: string;
        activityLine: string;
        copySummary: string;
        copiedNotice: string;
        wizardTitle: string;
        stepFolders: string;
        foldersHelp: string;
        stepKeepOut: string;
        stepLimits: string;
        limitsHelp: string;
        privacyStatement: string;
        stepPreview: string;
        previewHelp: string;
        previewWorking: string;
        previewResult: string;
        confirmTitle: string;
        confirmBody: string;
        confirmOlder: string;
        confirmOlderToggle: string;
        confirmPrivacy: string;
        working: string;
        cancelledNotice: string;
        alreadyRunning: string;
        notVisible: string;
        nothingToProcess: string;
        summaryNotice: string;
        backpressureNote: string;
        waitingNote: string;
        statusReview: string;
        statusWaiting: string;
        statusFailed: string;
        scanFailed: string;
        nothingReadySettling: string;
        settleLine: string;
        readyNote: string;
        waitingMore: string;
        statusReady: string;
        statusSettling: string;
        statusWorking: string;
        waitingAttachment: string;
        waitingEmpty: string;
        emptyNoteLabel: string;
        confirmBodyText: string;
        transcribeAnywayConfirm: string;
        sweepNotSetUp: string;
        protectedInside: string;
        runLeftover: string;
        runMatured: string;
        runSettling: string;
        runSkipped: string;
        confirmNone: string;
        confirmLater: string;
        confirmSettling: string;
        retryNotice: string;
        failedHelp: Record<'stability' | 'read' | 'transcribe' | 'digitise' | 'classify' | 'write' | 'organise', string>;
        skippedTitle: string;
        skippedExcluded: string;
        skipHelp: Record<'excluded' | 'too-large' | 'unsupported' | 'invalid-media' | 'already-swept' | 'already-captured' | 'older-than-setup' | 'nothing-to-process' | 'digitisation-off' | 'attachment-missing', string>;
        skipRetry: string;
        skipRetryNotice: string;
        skipMore: string;
        acceptExplain: string;
        createExplain: string;
        createdLine: string;
        openNewNote: string;
        noFolderToCreate: string;
        sweepSetupButton: string;
        statusTooltip: string;
        queueTitle: string;
        queueEmpty: string;
        queueChecking: string;
        rowReview: string;
        rowOpen: string;
        rowRetry: string;
        rowSkip: string;
        processNow: string;
        close: string;
        stateLabels: {
            new: string;
            waiting_for_stable: string;
            ready: string;
            processing: string;
            awaiting_review: string;
            accept_pending_write: string;
            accepted: string;
            organised: string;
            failed: string;
            skipped: string;
            skipped_by_user: string;
        };
        sourceLabels: {
            "note-text": string;
            transcript: string;
            digitised: string;
            mixed: string;
        };
        skipReasons: {
            excluded: string;
            "too-large": string;
            unsupported: string;
            "invalid-media": string;
            "already-swept": string;
            "already-captured": string;
            "older-than-setup": string;
            "nothing-to-process": string;
            "digitisation-off": string;
        };
        reviewTitle: string;
        reviewSource: string;
        reviewHeadingText: string;
        reviewHeadingOrganise: string;
        reviewHeadingTasks: string;
        reviewHeadingInbox: string;
        inboxExplain: string;
        markProcessed: string;
        markProcessedPreview: string;
        markedProcessedNotice: string;
        processedLine: string;
        undoProcessed: string;
        rowProcessed: string;
        showProcessed: string;
        hideProcessed: string;
        unmarkedNotice: string;
        noteTextLabel: string;
        machineTextLabel: string;
        acceptText: string;
        acceptedNotice: string;
        needsAcceptFirst: string;
        titleLabel: string;
        tagsLabel: string;
        folderLabel: string;
        noFolder: string;
        createNote: string;
        organisedNotice: string;
        sweepExplain: string;
        runSweep: string;
        sweepOff: string;
        sweepLongWarning: string;
        audioNotTranscribed: string;
        transcribeAnyway: string;
        changedBanner: string;
        processAgain: string;
        processAgainConfirm: string;
        skip: string;
        skippedNotice: string;
        failedLine: string;
        setupDone: string;
        resetJournal: string;
        resetJournalConfirm: string;
        resetJournalDone: string;
    };
    googleTasks: {
        listsTitle: string;
        listsHelp: string;
        listsNeedMain: string;
        mainBadge: string;
        needsDateName: string;
        removeList: string;
        addList: string;
        loadMyLists: string;
        newScriptName: string;
        newScriptDesc: string;
        copyNewScript: string;
        rulesTitle: string;
        rulesHelp: string;
        ruleKind: string;
        ruleContextInvalid: string;
        ruleContext: string;
        ruleDestination: string;
        addRule: string;
        removeRule: string;
        readBackName: string;
        readBackDesc: string;
        noteLinkName: string;
        noteLinkDesc: string;
        sectionTitle: string;
        statusName: string;
        description: string;
        setupButton: string;
        sendNow: string;
        pendingLine: string;
        wizardTitle: string;
        stepScript: string;
        scriptIntro: string;
        step1: string;
        step2: string;
        step3: string;
        step4: string;
        copySetupScript: string;
        scriptUrlName: string;
        scriptUrlDesc: string;
        testConnection: string;
        testing: string;
        connected: string;
        notTested: string;
        stepList: string;
        listHelp: string;
        listName: string;
        loadLists: string;
        noLists: string;
        stepFinish: string;
        finishIntro: string;
        copyFinalScript: string;
        testAgain: string;
        operationalLine: string;
        notReady: string;
        stillSetup: string;
        wrongList: string;
        scriptCopied: string;
        secretCreated: string;
    };
    offload: {
        localFolderName: string;
        localFolderDesc: string;
        localFolderPlaceholder: string;
        checkFolder: string;
        checkingFolder: string;
        folderOk: string;
        offloadAction: string;
        modalTitle: string;
        planHeading: string;
        planFile: string;
        planCopyTo: string;
        planDriveFolder: string;
        planLinks: string;
        planNoLinks: string;
        planStep1: string;
        planStep2: string;
        planStep3: string;
        planStep4: string;
        planLinkNote: string;
        pairLabel: string;
        startButton: string;
        cancelButton: string;
        working: string;
        waitingSync: string;
        checkAgain: string;
        resumeLater: string;
        reviewHeading: string;
        reviewIntro: string;
        reviewBefore: string;
        reviewAfter: string;
        skippedNote: string;
        rewriteButton: string;
        stopButton: string;
        stopped: string;
        doneNotice: string;
        blockedNotice: string;
        unavailable: string;
        noPairChosen: string;
        promptUnfinished: string;
        promptOpen: string;
        promptLater: string;
        nothingToResume: string;
        resumeTitle: string;
        stepLabel: string;
        fileMissing: string;
    };
}

/**
 * ProgressReporter user-facing strings. All American English, sentence-case
 * per Obsidian review-bot rules. Templates use {token} placeholders resolved
 * at call time via ProgressReporter's resolvePhase callback.
 *
 * Phases are named per flow (multiSourceSummarize, research, …) so migrating
 * flows get compile-time safety by narrowing to one sub-object's keys.
 */
export interface ProgressStrings {
    // Generic surface copy
    cancelButton: string;
    cancelled: string;
    cancelPrompt: string;
    failedPrefix: string;
    timedOut: string;            // "Timed out after {duration}"
    stillWorking: string;        // "Still working… ({duration} elapsed)"
    unknownError: string;

    // Per-flow phase strings — migrated flows reference these via TKey unions.
    // Each nested object's KEYS form the typed phase vocabulary for that flow.
    multiSourceSummarize: {
        preparing: string;
        fetching: string;             // "Fetching {name}… ({current}/{total})"
        summarizing: string;          // "Summarizing {name}… ({current}/{total})"
        transcribing: string;         // "Transcribing {name}… ({current}/{total})"
        finalizing: string;
    };
    multiSourceTranslate: {
        preparing: string;
        fetching: string;
        translating: string;
        finalizing: string;
    };
    integration: {
        resolving: string;
        merging: string;
        validating: string;
        applying: string;
    };
    smartNote: {
        diagramming: string;
        improving: string;
        validating: string;
    };
    newsletter: {
        fetching: string;             // "Fetching newsletters…"
        triaging: string;             // "Triaging {current}/{total}"
        synthesizing: string;
        regeneratingAudio: string;
        catchUpFreezing: string;
        catchUpWritingScript: string;
        catchUpShortening: string;
        catchUpSynthesising: string;   // "Narrating part {done} of {total}…"
        catchUpSynthesisingStart: string; // before the first part is done
        catchUpSaving: string;
    };
    audioNarration: {
        preparing: string;            // status-bar — "Preparing narration…"
        enhancing: string;            // "Enhancing with AI…" (during LLM pre-pass)
        narrating: string;            // "Narrating chunk {current}/{total}…"
        encoding: string;             // "Encoding MP3…"
        writing: string;              // "Saving narration…"
    };
    presentation: {
        generating: string;
        auditing: string;
        refining: string;
        exporting: string;
        slideRenderFailed: string;
    };
    kindle: {
        authenticating: string;
        scrapingBooks: string;        // "Scraping book list…"
        scrapingHighlights: string;   // "Scraping highlights ({current}/{total})"
        writingNotes: string;
    };
    research: {
        searching: string;
        triaging: string;
        extracting: string;
        synthesizing: string;
        continuing: string;
    };
    minutes: {
        extracting: string;           // "Extracting from {name} ({current}/{total})"
        merging: string;
        consolidating: string;
    };
    flashcards: {
        generating: string;
        validating: string;
        saving: string;                // "Saving {count} cards…"
    };
    generateTags: {
        analyzing: string;
        applying: string;
    };
    canvas: {
        gathering: string;
        labeling: string;
        building: string;
    };
    digitisation: {
        processing: string;            // "Processing {name} ({current}/{total})"
        extracting: string;
    };
    embedScan: {
        scanning: string;              // "Scanning {current}/{total} — {file}"
    };
    webReader: {
        triaging: string;              // "Triaging {current}/{total}"
    };
    translateNote: {
        translating: string;
    };
    summarizeNote: {
        summarizing: string;
    };
    youtube: {
        summarizing: string;
        transcribing: string;
    };
    audioTranscribe: {
        compressing: string;
        transcribing: string;          // "Transcribing chunk {current}/{total}"
        summarizing: string;
    };
    pdf: {
        summarizing: string;
    };
    url: {
        fetching: string;
        summarizing: string;
    };
}
