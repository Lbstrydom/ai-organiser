import {
    DEFAULT_SETTINGS,
    getConfigFolderFullPath,
    getNotebookLMExportFullPath,
    getDictionariesFolderFullPath,
    getChatExportFullPath,
    getEffectiveOutputRoot,
    resolveOutputPath,
    getOutputSubfolderPath,
    getSketchOutputFullPath,
    getResearchOutputFullPath,
    getPluginManagedFolders,
    getKindleOutputFullPath,
    getTranscriptFullPath,
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

describe('getEffectiveOutputRoot', () => {
    it('returns pluginFolder when outputRootFolder is empty', () => {
        const settings = cloneSettings({ outputRootFolder: '' });
        expect(getEffectiveOutputRoot(settings)).toBe('AI-Organiser');
    });

    it('returns outputRootFolder when set', () => {
        const settings = cloneSettings({ outputRootFolder: 'My Output' });
        expect(getEffectiveOutputRoot(settings)).toBe('My Output');
    });

    it('trims and normalizes outputRootFolder', () => {
        const settings = cloneSettings({ outputRootFolder: '  /My Output/ ' });
        expect(getEffectiveOutputRoot(settings)).toBe('My Output');
    });

    it('converts backslashes to forward slashes', () => {
        const settings = cloneSettings({ outputRootFolder: String.raw`My\Output\Folder` });
        expect(getEffectiveOutputRoot(settings)).toBe('My/Output/Folder');
    });

    it('falls back to pluginFolder when outputRootFolder is whitespace only', () => {
        const settings = cloneSettings({ outputRootFolder: '   ' });
        expect(getEffectiveOutputRoot(settings)).toBe('AI-Organiser');
    });
});

describe('resolveOutputPath', () => {
    it('resolves under pluginFolder when outputRootFolder is empty (backward compat)', () => {
        const settings = cloneSettings({ outputRootFolder: '', notebooklmExportFolder: 'NotebookLM' });
        expect(resolveOutputPath(settings, settings.notebooklmExportFolder, 'NotebookLM')).toBe('AI-Organiser/NotebookLM');
    });

    it('resolves under outputRootFolder when set', () => {
        const settings = cloneSettings({ outputRootFolder: 'My Output', kindleOutputFolder: 'Kindle' });
        expect(resolveOutputPath(settings, settings.kindleOutputFolder, 'Kindle')).toBe('My Output/Kindle');
    });

    it('strips legacy pluginFolder prefix when outputRoot differs', () => {
        const settings = cloneSettings({
            pluginFolder: 'AI-Organiser',
            outputRootFolder: 'My Output',
            notebooklmExportFolder: 'AI-Organiser/NotebookLM'
        });
        expect(resolveOutputPath(settings, settings.notebooklmExportFolder, 'NotebookLM')).toBe('My Output/NotebookLM');
    });

    it('handles legacy outputRoot prefix without doubling', () => {
        const settings = cloneSettings({
            outputRootFolder: 'My Output',
            transcriptFolder: 'My Output/Transcripts'
        });
        expect(resolveOutputPath(settings, settings.transcriptFolder, 'Transcripts')).toBe('My Output/Transcripts');
    });

    it('falls back to default subfolder when value is empty', () => {
        const settings = cloneSettings({ outputRootFolder: 'Output' });
        expect(resolveOutputPath(settings, '', 'Meetings')).toBe('Output/Meetings');
    });

    it('does not strip pluginFolder prefix when roots are the same', () => {
        const settings = cloneSettings({ pluginFolder: 'AI-Organiser', outputRootFolder: '' });
        expect(resolveOutputPath(settings, 'AI-Organiser/Kindle', 'Kindle')).toBe('AI-Organiser/Kindle');
    });
});

describe('getOutputSubfolderPath', () => {
    it('composes under output root', () => {
        const settings = cloneSettings({ outputRootFolder: 'My Output' });
        expect(getOutputSubfolderPath(settings, 'Recordings')).toBe('My Output/Recordings');
    });

    it('uses pluginFolder when outputRootFolder is empty', () => {
        const settings = cloneSettings({ outputRootFolder: '' });
        expect(getOutputSubfolderPath(settings, 'Recordings')).toBe('AI-Organiser/Recordings');
    });
});

describe('output helpers use resolveOutputPath', () => {
    it('getSketchOutputFullPath resolves under output root', () => {
        const settings = cloneSettings({ outputRootFolder: 'Output', sketchOutputFolder: 'Sketches' });
        expect(getSketchOutputFullPath(settings)).toBe('Output/Sketches');
    });

    it('getResearchOutputFullPath resolves under output root', () => {
        const settings = cloneSettings({ outputRootFolder: 'Output', researchOutputFolder: 'Research' });
        expect(getResearchOutputFullPath(settings)).toBe('Output/Research');
    });

    it('getKindleOutputFullPath resolves under output root', () => {
        const settings = cloneSettings({ outputRootFolder: 'Output', kindleOutputFolder: 'Kindle' });
        expect(getKindleOutputFullPath(settings)).toBe('Output/Kindle');
    });

    it('getTranscriptFullPath resolves under output root', () => {
        const settings = cloneSettings({ outputRootFolder: 'Output', transcriptFolder: 'Transcripts' });
        expect(getTranscriptFullPath(settings)).toBe('Output/Transcripts');
    });

    it('config paths still resolve under pluginFolder, not outputRoot', () => {
        const settings = cloneSettings({ pluginFolder: 'AI-Organiser', outputRootFolder: 'Output', configFolderPath: 'Config' });
        expect(getConfigFolderFullPath(settings)).toBe('AI-Organiser/Config');
        expect(getDictionariesFolderFullPath(settings)).toBe('AI-Organiser/Config/dictionaries');
    });
});

describe('getPluginManagedFolders', () => {
    it('returns only pluginFolder when output root matches', () => {
        const settings = cloneSettings({ outputRootFolder: '' });
        const managed = getPluginManagedFolders(settings);
        expect(managed).toEqual(['AI-Organiser']);
    });

    it('returns pluginFolder + all output subfolders when roots differ', () => {
        const settings = cloneSettings({ outputRootFolder: 'My Output' });
        const managed = getPluginManagedFolders(settings);
        expect(managed[0]).toBe('AI-Organiser');
        expect(managed.length).toBeGreaterThan(1);
        expect(managed).toContain('My Output/Transcripts');
        expect(managed).toContain('My Output/Kindle');
        expect(managed).toContain('My Output/NotebookLM');
        expect(managed).toContain('My Output/Sketches');
        expect(managed).toContain('My Output/Research');
        expect(managed).toContain('My Output/Recordings');
    });

    it('does not include the output root folder itself', () => {
        const settings = cloneSettings({ outputRootFolder: 'My Notes' });
        const managed = getPluginManagedFolders(settings);
        expect(managed).not.toContain('My Notes');
    });
});
