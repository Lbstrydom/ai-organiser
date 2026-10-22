/**
 * Agent index (F3): commands, the guided setup and the optional auto-rebuild.
 *
 *  - "Build agent index" / "Check agent index" / "Copy agent instructions" / "Set up agent index"
 *  - Auto-rebuild (`on-change`): a debounced rebuild a few seconds after a scoped note changes.
 *
 * The index is deterministic and holds structure only; see `services/agentIndex`.
 */
import { Notice, Setting, TFolder } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { Result, ok } from '../core/result';
import { describeError, formatGuidance } from '../core/friendlyErrors';
import { isFeatureEnabled } from '../services/featureService';
import {
    buildAgentIndex,
    checkAgentIndex,
    collectRecords,
    isInIndexScope,
    scopeConfigFromSettings,
    type IndexScopeConfig,
} from '../services/agentIndex/agentIndexService';
import { buildAgentInstructions, buildClaudePermissions } from '../services/agentIndex/agentInstructions';
import { applyInstructions, previewInstructions } from '../services/agentIndex/agentInstructionsWriter';
import { AgentInstructionsPreviewModal } from '../ui/modals/AgentInstructionsPreviewModal';
import { GuidedSetupModal } from '../ui/modals/GuidedSetupModal';
import { FolderListEditor } from '../ui/setup/FolderListEditor';

const REBUILD_DEBOUNCE_MS = 10_000;

/** Build with a "building" notice while it runs and a notice that says what happened. */
export async function runBuild(plugin: AIOrganiserPlugin): Promise<void> {
    const t = plugin.t.agentIndex;
    const working = new Notice(t.building, 0);
    let res: Awaited<ReturnType<typeof buildAgentIndex>>;
    try {
        res = await buildAgentIndex(plugin);
    } finally {
        working.hide();
    }
    if (!res.ok) {
        new Notice(formatGuidance(describeError(plugin.t, res.error)), 8000);
        return;
    }
    new Notice(
        res.value.stale
            ? t.buildDoneStale
            : t.buildDone.replace('{notes}', String(res.value.notes)).replace('{excluded}', String(res.value.excluded)),
        6000,
    );
}

export async function runCheck(plugin: AIOrganiserPlugin): Promise<void> {
    const t = plugin.t.agentIndex;
    const res = await checkAgentIndex(plugin);
    if (!res.ok) {
        new Notice(formatGuidance(describeError(plugin.t, res.error)), 8000);
        return;
    }
    const r = res.value;
    if (r.missing) { new Notice(t.checkMissing, 6000); return; }
    if (r.fresh) { new Notice(t.checkFresh, 5000); return; }
    if (!r.added.length && !r.removed.length && !r.changed.length && !r.scopeChanged) {
        // Nothing differs, yet the check cannot vouch for the index: say so rather than "up to date".
        new Notice(t.checkIncomplete, 8000);
        return;
    }
    const parts = [t.checkStale.replace('{added}', String(r.added.length)).replace('{removed}', String(r.removed.length)).replace('{changed}', String(r.changed.length))];
    if (r.scopeChanged) parts.push(t.checkScopeChanged);
    new Notice(parts.join(' '), 8000);
}

/** The guided setup: folders, what to share, a preview, and optionally build straight away. */
export function openAgentIndexSetup(plugin: AIOrganiserPlugin, onDone?: () => void): void {
    const t = plugin.t;
    const s = plugin.settings;
    const draft = {
        include: [...s.agentIndexIncludeFolders],
        exclude: [...s.agentIndexExcludeFolders],
        aliases: s.agentIndexIncludeAliases,
        headings: s.agentIndexIncludeHeadings,
        buildAfter: true,
    };
    const draftScope = (): IndexScopeConfig => ({
        ...scopeConfigFromSettings(s),
        includeFolders: draft.include,
        excludeFolders: draft.exclude,
        includeAliases: draft.aliases,
        includeHeadings: draft.headings,
    });

    new GuidedSetupModal(plugin.app, t, {
        title: t.agentIndex.wizardTitle,
        steps: [
            {
                id: 'folders',
                title: t.agentIndex.stepFolders,
                render: (el) => {
                    el.createEl('h4', { text: t.agentIndex.includeHeading });
                    el.createEl('p', { text: t.agentIndex.includeHelp, cls: 'setting-item-description' });
                    new FolderListEditor({ app: plugin.app, container: el, t, getFolders: () => draft.include, onChange: (n) => { draft.include = [...n]; } }).render();
                    el.createEl('h4', { text: t.agentIndex.excludeHeading });
                    el.createEl('p', { text: t.agentIndex.excludeHelp, cls: 'setting-item-description' });
                    new FolderListEditor({ app: plugin.app, container: el, t, getFolders: () => draft.exclude, onChange: (n) => { draft.exclude = [...n]; } }).render();
                },
            },
            {
                id: 'sharing',
                title: t.agentIndex.stepSharing,
                render: (el) => {
                    el.createEl('p', { text: t.agentIndex.sharingHelp });
                    new Setting(el).setName(t.agentIndex.aliasesName).setDesc(t.agentIndex.aliasesDesc)
                        .addToggle((tg) => tg.setValue(draft.aliases).onChange((v) => { draft.aliases = v; }));
                    new Setting(el).setName(t.agentIndex.headingsName).setDesc(t.agentIndex.headingsDesc)
                        .addToggle((tg) => tg.setValue(draft.headings).onChange((v) => { draft.headings = v; }));
                },
            },
            {
                id: 'preview',
                title: t.agentIndex.stepPreview,
                render: async (el) => {
                    const scope = draftScope();
                    const all = plugin.app.vault.getMarkdownFiles();
                    const inScope = all.filter((f) => isInIndexScope(f.path, scope));
                    el.createEl('p', {
                        text: t.agentIndex.previewSummary
                            .replace('{included}', String(inScope.length))
                            .replace('{excluded}', String(all.length - inScope.length)),
                    });
                    const sample = inScope.slice(0, 10);
                    if (sample.length > 0) {
                        el.createEl('p', { text: t.agentIndex.previewSample.replace('{count}', String(sample.length)), cls: 'setting-item-description' });
                        const { records } = await collectRecords(plugin.app, sample, scope);
                        const list = el.createEl('ul');
                        for (const r of records) {
                            list.createEl('li', { text: `${r.path}${r.tags.length ? `  ·  ${r.tags.slice(0, 5).join(', ')}` : ''}` });
                        }
                    }
                    new Setting(el).setName(t.agentIndex.buildAfter)
                        .addToggle((tg) => tg.setValue(draft.buildAfter).onChange((v) => { draft.buildAfter = v; }));
                },
            },
        ],
        onFinish: async (): Promise<Result<void>> => {
            s.agentIndexIncludeFolders = draft.include;
            s.agentIndexExcludeFolders = draft.exclude;
            s.agentIndexIncludeAliases = draft.aliases;
            s.agentIndexIncludeHeadings = draft.headings;
            s.featureSetupCompletedAt['agent-index'] = new Date().toISOString();
            await plugin.saveSettings();
            onDone?.();
            if (draft.buildAfter) void runBuild(plugin);
            return ok(undefined);
        },
    }).open();
}

/** Debounced rebuild when notes in scope change. Registered once; reads the setting on every event. */
function registerAutoRebuild(plugin: AIOrganiserPlugin): void {
    let timer: number | null = null;
    const schedule = (path: string, folder = false): void => {
        if (plugin.settings.agentIndexAutoRebuild !== 'on-change') return;
        // A folder event can move or remove many notes at once, so it always counts.
        if (!folder && (!path.endsWith('.md') || !isInIndexScope(path, scopeConfigFromSettings(plugin.settings)))) return;
        if (timer !== null) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
            timer = null;
            // Turned off (or the feature disabled) while the build was waiting: do nothing.
            if (plugin.settings.agentIndexAutoRebuild !== 'on-change' || !isFeatureEnabled(plugin.settings, 'agent-index')) return;
            void buildAgentIndex(plugin);
        }, REBUILD_DEBOUNCE_MS);
    };
    const vault = plugin.app.vault;
    plugin.registerEvent(vault.on('modify', (f) => schedule(f.path)));
    plugin.registerEvent(vault.on('create', (f) => schedule(f.path)));
    plugin.registerEvent(vault.on('delete', (f) => schedule(f.path, f instanceof TFolder)));
    plugin.registerEvent(vault.on('rename', (f, old) => { schedule(f.path, f instanceof TFolder); schedule(old); }));
    plugin.register(() => { if (timer !== null) window.clearTimeout(timer); });
}

/** Copy text to the clipboard and say so; a clipboard that refuses is reported, never ignored. */
function copyText(plugin: AIOrganiserPlugin, text: string, done: string): void {
    navigator.clipboard.writeText(text).then(
        () => new Notice(done, 5000),
        // A clipboard that refuses is a failure, never "copied".
        () => new Notice(plugin.t.agentIndex.copyFailed, 8000),
    );
}

/** Preview, then write, the instructions block into the user's AGENTS.md. */
export async function runWriteInstructions(plugin: AIOrganiserPlugin): Promise<void> {
    const t = plugin.t.agentIndex;
    if (!plugin.settings.agentInstructionsWrite) { new Notice(t.writeOff, 6000); return; }
    const preview = await previewInstructions(plugin);
    if (!preview.ok) { new Notice(formatGuidance(describeError(plugin.t, preview.error)), 8000); return; }
    const approved = await new Promise<boolean>((resolve) => {
        new AgentInstructionsPreviewModal(plugin.app, plugin, preview.value, resolve).open();
    });
    if (!approved) return;
    const res = await applyInstructions(plugin, preview.value);
    if (!res.ok) { new Notice(formatGuidance(describeError(plugin.t, res.error)), 8000); return; }
    new Notice(res.value === 'created' ? t.writeCreated : res.value === 'updated' ? t.writeUpdated : t.writeUnchanged, 5000);
}

export function registerAgentIndexCommands(plugin: AIOrganiserPlugin): void {
    const t = plugin.t;
    plugin.addCommand({
        id: 'build-agent-index',
        name: t.commands.buildAgentIndex,
        icon: 'list-tree',
        callback: () => { void runBuild(plugin); },
    });
    plugin.addCommand({
        id: 'check-agent-index',
        name: t.commands.checkAgentIndex,
        icon: 'list-checks',
        callback: () => { void runCheck(plugin); },
    });
    plugin.addCommand({
        id: 'copy-agent-instructions',
        name: t.commands.copyAgentInstructions,
        icon: 'clipboard-copy',
        callback: () => copyText(plugin, buildAgentInstructions(plugin.settings), t.agentIndex.instructionsCopied),
    });
    plugin.addCommand({
        id: 'copy-claude-permissions',
        name: t.commands.copyClaudePermissions,
        icon: 'shield',
        callback: () => {
            const text = buildClaudePermissions(plugin.settings);
            if (text === null) new Notice(t.agentIndex.noPermissions, 6000);
            else copyText(plugin, text, t.agentIndex.permissionsCopied);
        },
    });
    plugin.addCommand({
        id: 'write-agent-instructions',
        name: t.commands.writeAgentInstructions,
        icon: 'file-pen-line',
        // Hidden from the palette until the user turns the write on.
        checkCallback: (checking) => {
            if (!plugin.settings.agentInstructionsWrite) return false;
            if (!checking) void runWriteInstructions(plugin);
            return true;
        },
    });
    plugin.addCommand({
        id: 'setup-agent-index',
        name: t.commands.setupAgentIndex,
        icon: 'sparkles',
        callback: () => openAgentIndexSetup(plugin),
    });
    registerAutoRebuild(plugin);
}
