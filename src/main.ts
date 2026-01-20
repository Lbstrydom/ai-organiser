import { App, MarkdownView, Notice, Plugin, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import {
    ConnectionTestError,
    ConnectionTestResult,
    LLMService,
    LocalLLMService,
    CloudLLMService,
    LLMResponse
} from './services';
import { setSettings, buildTaxonomyTagPrompt } from './services/prompts/tagPrompts';
import { ConfirmationModal } from './ui/modals/ConfirmationModal';
import { SuggestionModal, SuggestionResult } from './ui/modals/SuggestionModal';
import { TagUtils, TagOperationResult, setGlobalDebugMode } from './utils/tagUtils';
import { registerCommands } from './commands/index';
import { AIOrganiserSettings, DEFAULT_SETTINGS } from './core/settings';
import { AIOrganiserSettingTab } from './ui/settings/AIOrganiserSettingTab';
import { EventHandlers } from './utils/eventHandlers';
import { TagNetworkManager } from './utils/tagNetworkUtils';
import { TagNetworkView, TAG_NETWORK_VIEW_TYPE } from './ui/views/TagNetworkView';
import { TagOperations } from './utils/tagOperations';
import { BatchProcessResult } from './utils/batchProcessor';
import { getTranslations } from './i18n';
import { ConfigurationService } from './services/configurationService';

export default class AIOrganiserPlugin extends Plugin {
    public settings = {...DEFAULT_SETTINGS};
    public llmService: LLMService;
    public configService: ConfigurationService;
    private eventHandlers: EventHandlers;
    private tagNetworkManager: TagNetworkManager;
    private tagOperations: TagOperations;
    public t = getTranslations(this.settings.interfaceLanguage);

    constructor(app: App, manifest: any) {
        super(app, manifest);
        this.llmService = new LocalLLMService({
            endpoint: DEFAULT_SETTINGS.localEndpoint,
            modelName: DEFAULT_SETTINGS.localModel,
            language: DEFAULT_SETTINGS.language
        }, app);
        this.configService = new ConfigurationService(app, DEFAULT_SETTINGS.configFolderPath);
        this.eventHandlers = new EventHandlers(app);
        this.tagNetworkManager = new TagNetworkManager(app);
        this.tagOperations = new TagOperations(app);
    }

    public async loadSettings(): Promise<void> {
        const oldSettings = await this.loadData();

        // Migrate old settings
        if (oldSettings?.serviceType === 'ollama') {
            oldSettings.serviceType = 'local';
            oldSettings.localEndpoint = oldSettings.ollamaEndpoint;
            oldSettings.localModel = oldSettings.ollamaModel;
            delete oldSettings.ollamaEndpoint;
            delete oldSettings.ollamaModel;
        }

        // Migrate old tag range settings to maxTags
        if (oldSettings && !oldSettings.maxTags) {
            oldSettings.maxTags = oldSettings.tagRangeGenerateMax ||
                                  oldSettings.tagRangePredefinedMax ||
                                  DEFAULT_SETTINGS.maxTags;
        }

        this.settings = Object.assign({}, DEFAULT_SETTINGS, oldSettings);
        this.t = getTranslations(this.settings.interfaceLanguage);
    }

    public async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
        await this.initializeLLMService();
        this.t = getTranslations(this.settings.interfaceLanguage);
    }

    private async initializeLLMService(): Promise<void> {
        await this.llmService?.dispose();

        this.llmService = this.settings.serviceType === 'local'
            ? new LocalLLMService({
                endpoint: this.settings.localEndpoint,
                modelName: this.settings.localModel,
                language: this.settings.language
            }, this.app)
            : new CloudLLMService({
                endpoint: this.settings.cloudEndpoint,
                apiKey: this.settings.cloudApiKey,
                modelName: this.settings.cloudModel,
                type: this.settings.cloudServiceType,
                language: this.settings.language
            }, this.app);

        this.llmService.setDebugMode(this.settings.debugMode);
        setGlobalDebugMode(this.settings.debugMode);
    }

    public async onload(): Promise<void> {
        await this.loadSettings();
        await this.initializeLLMService();

        // Initialize configuration service
        this.configService.setConfigFolder(this.settings.configFolderPath);

        // Create default config files if they don't exist
        const configExists = await this.configService.configFilesExist();
        if (!configExists) {
            await this.configService.createDefaultConfigFiles();
        }

        setSettings(this.settings);

        this.eventHandlers.registerEventHandlers();
        this.addSettingTab(new AIOrganiserSettingTab(this.app, this));
        registerCommands(this);

        // Register tag network view
        this.registerView(
            TAG_NETWORK_VIEW_TYPE,
            (leaf) => new TagNetworkView(leaf, this.tagNetworkManager.getNetworkData())
        );

        // Add ribbon icons
        this.addRibbonIcon(
            'tags',
            this.t.messages.analyzeTagCurrentNote,
            () => this.analyzeAndTagCurrentNote()
        );

        this.addRibbonIcon(
            'git-graph',
            this.t.messages.viewTagNetwork,
            () => this.showTagNetwork()
        );
    }

    public async onunload(): Promise<void> {
        await this.llmService?.dispose();
        this.eventHandlers.cleanup();
        this.app.workspace.detachLeavesOfType(TAG_NETWORK_VIEW_TYPE);
        this.app.workspace.trigger('layout-change');
    }

    public async showTagNetwork(): Promise<void> {
        try {
            const statusNotice = new Notice(this.t.messages.buildingTagNetwork, 0);

            const files = this.getNonExcludedMarkdownFiles();
            await this.tagNetworkManager.buildTagNetwork(files);
            const networkData = this.tagNetworkManager.getNetworkData();

            statusNotice.hide();

            if (!networkData.nodes.length) {
                new Notice(this.t.messages.noTagsInVault, 3000);
                return;
            }

            if (!networkData.edges.length) {
                new Notice(this.t.messages.noTagConnections, 4000);
            }

            let leaf = this.app.workspace.getLeavesOfType(TAG_NETWORK_VIEW_TYPE)[0];

            if (!leaf) {
                const newLeaf = await this.app.workspace.getRightLeaf(false);
                if (!newLeaf) {
                    throw new Error('Failed to create new workspace leaf');
                }

                await newLeaf.setViewState({
                    type: TAG_NETWORK_VIEW_TYPE,
                    active: true
                });

                leaf = this.app.workspace.getLeavesOfType(TAG_NETWORK_VIEW_TYPE)[0];
                if (!leaf) {
                    throw new Error('Failed to initialize tag network view');
                }
            }

            this.app.workspace.revealLeaf(leaf);
        } catch (error) {
            new Notice(this.t.messages.failedToBuildNetwork, 4000);
        }
    }

    public async testConnection(): Promise<{ result: ConnectionTestResult; error?: ConnectionTestError }> {
        return await this.llmService.testConnection();
    }

    public async showConfirmationDialog(message: string): Promise<boolean> {
        return new Promise((resolve) => {
            const modal = new ConfirmationModal(
                this.app,
                this.t.modals.warning,
                message,
                () => resolve(true),
                this
            );
            modal.onClose = () => resolve(false);
            modal.open();
        });
    }

    public getNonExcludedMarkdownFiles(): TFile[] {
        return TagUtils.getNonExcludedMarkdownFiles(this.app, this.settings.excludedFolders);
    }

    public getNonExcludedMarkdownFilesFromFolder(folder: TFolder): TFile[] {
        return TagUtils.getNonExcludedMarkdownFiles(this.app, this.settings.excludedFolders, folder);
    }

    public async clearAllNotesTags(): Promise<void> {
        const files = this.getNonExcludedMarkdownFiles();
        if (await this.showConfirmationDialog(
            `Remove all tags from ${files.length} notes? This action cannot be undone.`
        )) {
            try {
                await this.tagOperations.clearDirectoryTags(files);
                new Notice(this.t.messages.successfullyClearedAllVault, 3000);
            } catch (error) {
                new Notice(this.t.messages.failedToClearVaultTags, 4000);
            }
        }
    }

    public async clearNoteTags(): Promise<void> {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
            new Notice('Please open a note before clearing tags', 3000);
            return;
        }

        const result = await this.tagOperations.clearNoteTags(activeFile);
        this.handleTagUpdateResult(result);
    }

    public async clearDirectoryTags(directory: TFile[]): Promise<BatchProcessResult> {
        return this.tagOperations.clearDirectoryTags(directory);
    }

    public handleTagUpdateResult(result: TagOperationResult | null | undefined, silent = false): void {
        if (!result) {
            !silent && new Notice('Failed to update tags: No result returned', 3000);
            return;
        }

        const view = this.app.workspace.getActiveViewOfType(MarkdownView);

        if (result.success) {
            if (view?.getMode() === 'source') {
                view.editor.refresh();
            }
            this.app.workspace.trigger('layout-change');
            !silent && new Notice(result.message, 3000);
        } else {
            !silent && new Notice(`Failed to update tags: ${result.message || 'Unknown error'}`, 4000);
        }
    }

    public async analyzeAndTagFiles(files: TFile[]): Promise<void> {
        if (!files?.length) return;

        const statusNotice = new Notice(`Analyzing ${files.length} files...`, 0);

        try {
            let processed = 0, successful = 0;
            let lastNotice = Date.now();

            for (const file of files) {
                try {
                    const content = await this.app.vault.read(file);
                    if (!content.trim()) continue;

                    const result = await this.analyzeAndTagNote(file, content);

                    result.success && successful++;
                    this.handleTagUpdateResult(result, true);
                    processed++;

                    if (Date.now() - lastNotice >= 15000) {
                        new Notice(`Progress: ${processed}/${files.length} files processed`, 3000);
                        lastNotice = Date.now();
                    }
                } catch (error) {
                    new Notice(`Error processing ${file.path}`, 4000);
                }
            }

            new Notice(`Successfully tagged ${successful} out of ${files.length} files`, 4000);
        } catch (error) {
            new Notice('Failed to complete batch processing', 4000);
        } finally {
            statusNotice.hide();
        }
    }

    public async analyzeAndTagCurrentNote(): Promise<void> {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
            new Notice('Please open a note before analyzing', 3000);
            return;
        }

        const content = await this.app.vault.read(activeFile);
        if (!content.trim()) {
            new Notice('Cannot analyze empty note', 3000);
            return;
        }

        try {
            const result = await this.analyzeAndTagNote(activeFile, content);
            this.handleTagUpdateResult(result);

            // Show suggestion modal if there are title or folder suggestions
            if (result.success && (result.suggestedTitle || result.suggestedFolder)) {
                await this.showSuggestionModal(activeFile, result.suggestedTitle, result.suggestedFolder);
            }
        } catch (error) {
            new Notice('Failed to analyze note. Please check console for details.', 4000);
        }
    }

    /**
     * Analyzes note content and applies tags using taxonomy-based approach
     */
    public async analyzeAndTagNote(file: TFile, contentOrAnalysis: string | LLMResponse): Promise<TagOperationResult> {
        try {
            let tags: string[];
            let suggestedTitle: string | undefined;
            let suggestedFolder: string | undefined;

            if (typeof contentOrAnalysis === 'string') {
                const content = contentOrAnalysis.trim();
                if (!content) {
                    return { success: false, message: 'Cannot analyze empty note' };
                }

                // Get taxonomy from config service
                const taxonomyPrompt = await this.configService.getTaxonomyForPrompt();
                const excludedTags = await this.configService.getExcludedTags();

                // Build the prompt
                const prompt = buildTaxonomyTagPrompt(
                    content,
                    taxonomyPrompt,
                    this.settings.maxTags,
                    this.settings.language
                );

                // Get tags from LLM
                const response = await this.llmService.generateTags(prompt);

                if (!response.success || !response.tags) {
                    return { success: false, message: response.error || 'Failed to generate tags' };
                }

                // Filter out excluded tags and format
                tags = TagUtils.formatTags(response.tags)
                    .filter(tag => !excludedTags.includes(tag.toLowerCase()));

                // Capture title and folder suggestions
                suggestedTitle = response.suggestedTitle;
                suggestedFolder = response.suggestedFolder;

                if (this.settings.debugMode) {
                    console.log('[AI Organiser Debug] Generated tags:', tags);
                    console.log('[AI Organiser Debug] Suggested title:', suggestedTitle);
                    console.log('[AI Organiser Debug] Suggested folder:', suggestedFolder);
                }
            } else {
                // Use provided analysis (backward compatibility)
                const analysis = contentOrAnalysis;
                tags = [...(analysis.suggestedTags || []), ...(analysis.matchedExistingTags || [])];
                tags = TagUtils.formatTags(tags);
            }

            if (tags.length === 0) {
                return { success: false, message: 'No valid tags were generated' };
            }

            // Update the note with tags
            const result = await TagUtils.updateNoteTags(
                this.app,
                file,
                tags,
                [],
                false,
                this.settings.replaceTags
            );

            // Add suggestions to result
            result.suggestedTitle = suggestedTitle;
            result.suggestedFolder = suggestedFolder;

            if (this.settings.debugMode) {
                console.log('[AI Organiser Debug] Update result:', result);
            }

            return result;
        } catch (error) {
            return {
                success: false,
                message: error instanceof Error ? error.message : 'Unknown error occurred'
            };
        }
    }

    /**
     * Shows the suggestion modal and applies user-selected changes
     */
    public async showSuggestionModal(file: TFile, suggestedTitle?: string, suggestedFolder?: string): Promise<void> {
        if (!suggestedTitle && !suggestedFolder) {
            return;
        }

        return new Promise((resolve) => {
            const modal = new SuggestionModal(
                this.app,
                this.t,
                file,
                suggestedTitle || '',
                suggestedFolder || '',
                async (result: SuggestionResult | null) => {
                    if (result) {
                        await this.applySuggestions(file, result);
                    }
                    resolve();
                }
            );
            modal.open();
        });
    }

    /**
     * Applies the user-selected title and folder suggestions
     */
    private async applySuggestions(file: TFile, suggestions: SuggestionResult): Promise<void> {
        try {
            let currentFile = file;

            // Apply folder change first (if selected)
            if (suggestions.applyFolder && suggestions.folder) {
                const newFolder = suggestions.folder;

                // Create folder if it doesn't exist
                const folderExists = this.app.vault.getAbstractFileByPath(newFolder);
                if (!folderExists) {
                    await this.app.vault.createFolder(newFolder);
                }

                // Move file to new folder
                const newPath = `${newFolder}/${file.name}`;
                await this.app.fileManager.renameFile(file, newPath);

                // Update reference to the moved file
                const movedFile = this.app.vault.getAbstractFileByPath(newPath);
                if (movedFile instanceof TFile) {
                    currentFile = movedFile;
                }

                if (this.settings.debugMode) {
                    console.log(`[AI Organiser Debug] Moved file to: ${newPath}`);
                }
            }

            // Apply title change (if selected)
            if (suggestions.applyTitle && suggestions.title) {
                const newTitle = suggestions.title;
                const sanitizedTitle = newTitle.replace(/[\\/:*?"<>|]/g, '-');
                const folder = currentFile.parent?.path || '';
                const newPath = folder ? `${folder}/${sanitizedTitle}.md` : `${sanitizedTitle}.md`;

                // Check if a file with this name already exists
                const existingFile = this.app.vault.getAbstractFileByPath(newPath);
                if (existingFile && existingFile !== currentFile) {
                    new Notice(this.t.messages.fileAlreadyExists || `A file named "${sanitizedTitle}.md" already exists`, 4000);
                    return;
                }

                await this.app.fileManager.renameFile(currentFile, newPath);

                if (this.settings.debugMode) {
                    console.log(`[AI Organiser Debug] Renamed file to: ${newPath}`);
                }
            }

            new Notice(this.t.messages.suggestionsApplied || 'Suggestions applied successfully', 3000);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            new Notice(`${this.t.messages.failedToApplySuggestions || 'Failed to apply suggestions'}: ${errorMessage}`, 4000);
        }
    }
}
