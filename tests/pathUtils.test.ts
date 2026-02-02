import {
    DEFAULT_SETTINGS,
    getConfigFolderFullPath,
    getNotebookLMExportFullPath,
    getDictionariesFolderFullPath,
    getChatExportFullPath
} from '../src/core/settings';

function cloneSettings(overrides: Partial<typeof DEFAULT_SETTINGS> = {}) {
    return { ...DEFAULT_SETTINGS, ...overrides };
}

describe('path helpers', () => {
    it('composes plugin and subfolder for config paths', () => {
        const settings = cloneSettings({ pluginFolder: 'AI-Organiser', configFolderPath: 'Config' });
        expect(getConfigFolderFullPath(settings)).toBe('AI-Organiser/Config');
    });

    it('preserves legacy full config paths without double prefix', () => {
        const settings = cloneSettings({ pluginFolder: 'AI-Organiser', configFolderPath: 'AI-Organiser/Config' });
        expect(getConfigFolderFullPath(settings)).toBe('AI-Organiser/Config');
    });

    it('normalizes double-prefixed legacy config paths', () => {
        const settings = cloneSettings({ pluginFolder: 'AI-Organiser', configFolderPath: 'AI-Organiser/AI-Organiser/Config' });
        expect(getConfigFolderFullPath(settings)).toBe('AI-Organiser/Config');
    });

    it('tolerates trailing slashes and empty values', () => {
        const trailing = cloneSettings({ configFolderPath: 'Config/' });
        expect(getConfigFolderFullPath(trailing)).toBe('AI-Organiser/Config');

        const empty = cloneSettings({ configFolderPath: '' });
        expect(getConfigFolderFullPath(empty)).toBe('AI-Organiser/Config');
    });

    it('resolves NotebookLM and dictionary folders relative to plugin folder', () => {
        const settings = cloneSettings({ pluginFolder: 'MyPlugin', notebooklmExportFolder: 'NotebookLM', configFolderPath: 'Settings' });
        expect(getNotebookLMExportFullPath(settings)).toBe('MyPlugin/NotebookLM');
        expect(getDictionariesFolderFullPath(settings)).toBe('MyPlugin/Settings/dictionaries');
    });

    it('resolves chat export folder relative to plugin folder', () => {
        const settings = cloneSettings({ pluginFolder: 'AI-Organiser', chatExportFolder: 'Chats' });
        expect(getChatExportFullPath(settings)).toBe('AI-Organiser/Chats');
    });

    it('resolves chat export folder with custom plugin folder', () => {
        const settings = cloneSettings({ pluginFolder: 'MyPlugin', chatExportFolder: 'ChatLogs' });
        expect(getChatExportFullPath(settings)).toBe('MyPlugin/ChatLogs');
    });

    it('falls back to default chat export folder when empty', () => {
        const settings = cloneSettings({ chatExportFolder: '' });
        expect(getChatExportFullPath(settings)).toBe('AI-Organiser/Chats');
    });
});
