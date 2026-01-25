import { vi } from 'vitest';
import { registerUtilityCommands } from '../src/commands/utilityCommands';
import { registerNotebookLMCommands } from '../src/commands/notebookLMCommands';
import { MinutesCreationModal } from '../src/ui/modals/MinutesCreationModal';
import { TagUtils } from '../src/utils/tagUtils';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { App, TFile, Platform } from './mocks/obsidian';
import type AIOrganiserPlugin from '../src/main';

describe('path integration', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('collect-all-tags writes to the resolved config folder', async () => {
        const commands: any[] = [];
        const plugin: Partial<AIOrganiserPlugin> = {
            app: { vault: {} } as any,
            t: { commands: { collectAllTags: 'Collect All Tags', showTagNetwork: 'Show Tag Network' }, messages: {} } as any,
            settings: { pluginFolder: 'Custom', configFolderPath: 'Config' } as any,
            addCommand: vi.fn((cmd) => { commands.push(cmd); }) as any,
            showTagNetwork: vi.fn()
        };

        const saveSpy = vi.spyOn(TagUtils, 'saveAllTags').mockResolvedValue();

        registerUtilityCommands(plugin as AIOrganiserPlugin);
        const collectCommand = commands.find(c => c.id === 'collect-all-tags');
        expect(collectCommand).toBeDefined();

        await collectCommand.callback();
        expect(saveSpy).toHaveBeenCalledWith(plugin.app, 'Custom/Config');
    });

    it('NotebookLM open folder resolves legacy full paths without double prefix', async () => {
        const commands: any[] = [];
        const getAbstractFileByPath = vi.fn(() => ({}));

        const plugin: Partial<AIOrganiserPlugin> = {
            app: {
                vault: {
                    getAbstractFileByPath: getAbstractFileByPath,
                    adapter: { getBasePath: () => '' }
                }
            } as any,
            t: {
                commands: {
                    notebookLMOpenFolder: 'Open Folder',
                    notebookLMToggle: 'Toggle',
                    notebookLMExport: 'Export'
                },
                messages: {
                    notebookLMFolderNotFound: 'not found',
                    desktopOnly: 'desktop only'
                }
            } as any,
            settings: {
                pluginFolder: 'MyPlugin',
                notebooklmExportFolder: 'MyPlugin/NotebookLM'
            } as any,
            addCommand: vi.fn((cmd) => { commands.push(cmd); }) as any
        };

        Platform.isDesktopApp = false;

        registerNotebookLMCommands(plugin as AIOrganiserPlugin);
        const openCommand = commands.find(c => c.id === 'notebooklm-open-export-folder');
        expect(openCommand).toBeDefined();

        await openCommand.callback();
        expect(getAbstractFileByPath).toHaveBeenCalledWith('MyPlugin/NotebookLM');
    });

    it('Minutes modal uses the dictionaries folder under the resolved config path', async () => {
        const app = new App();
        const file = new TFile('MyPlugin/Config/dictionaries/team-glossary.md');
        const getFileByPath = vi.fn(() => file as any);

        (app.vault as any).getAbstractFileByPath = getFileByPath;
        (app.workspace as any).getLeaf = vi.fn(() => ({ openFile: vi.fn() }));

        const plugin: Partial<AIOrganiserPlugin> = {
            settings: {
                ...DEFAULT_SETTINGS,
                pluginFolder: 'MyPlugin',
                configFolderPath: 'Config'
            },
            t: { minutes: { dictionaryNotFound: 'not found' } }
        } as any;

        const dictionaryService = {
            getDictionariesFolder: vi.fn(() => 'MyPlugin/Config/dictionaries')
        } as any;

        const modal = new MinutesCreationModal(app as any, plugin as AIOrganiserPlugin, {
            dictionaryService,
            minutesService: {} as any,
            documentService: {} as any
        });

        await (modal as any).openDictionaryFile('team-glossary');
        expect(getFileByPath).toHaveBeenCalledWith('MyPlugin/Config/dictionaries/team-glossary.md');
    });
});
