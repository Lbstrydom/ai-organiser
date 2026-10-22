import { App, Modal, Notice, Platform } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { describeError, formatGuidance } from '../../core/friendlyErrors';
import { Result, ok } from '../../core/result';
import { buildAgentInstructions } from '../../services/agentIndex/agentInstructions';
import {
    buildClaudeDesktopFilesystemConfig,
    buildGeminiSettingsSnippet,
    CLAUDE_CODE_IMPORT_LINE,
    CONNECTOR_DOCS,
    checkInstructionSize,
    claudeDesktopConfigPath,
    type ConnectorPlatform,
    type ConnectorRoute,
} from '../../services/agentConnectors/connectorGuides';
import { checkNodeInstalled, nodeMeetsMinimum, openTerminalInVault, type Spawner } from '../../services/agentConnectors/localTools';
import { OperationController } from '../../services/agentConnectors/operationController';
import { connectorFolderPath, vaultBasePath } from '../../services/agentConnectors/connectorRuntime';
import { absoluteGeneratedPath, buildCodexConfig, CONNECTOR_SERVER_FILE } from '../../services/agentConnectors/connectorBundle';
import { saveConnectorFiles, type ConnectorFilePaths } from '../../services/agentConnectors/connectorFiles';
import { runConnectorSelfTest, SELF_TEST_LIMIT_MS, type SelfTestResult } from '../../services/agentConnectors/connectorSelfTest';
import { desktopRequire } from '../../utils/desktopRequire';
import { logger } from '../../utils/logger';

type RouteTab = 'readonly' | 'claude' | 'codex' | 'cli' | 'chat';

const ROUTE_FOR_TAB: Record<RouteTab, ConnectorRoute> = {
    readonly: 'read-only-connector',
    claude: 'claude-desktop-filesystem',
    codex: 'codex-agents-md',
    cli: 'command-line-agent',
    chat: 'chat-project',
};

function currentPlatform(): ConnectorPlatform {
    if (Platform.isMacOS) return 'darwin';
    if (Platform.isWin) return 'win32';
    if (Platform.isLinux) return 'linux';
    return 'other';
}

function nodeSpawner(): Spawner | null {
    const cp = desktopRequire<typeof import('child_process')>('child_process');
    return cp ? (cp.spawn as unknown as Spawner) : null;
}

/**
 * "Connect an AI app": one modal, one tab per route. Every tab opens with what the route can and
 * cannot do; text the person has to copy comes with a Copy button; nothing is written outside the
 * plugin's own files. All action buttons go through one controller so they behave the same way.
 */
export class AgentConnectorsModal extends Modal {
    private tab: RouteTab = 'readonly';
    private readonly ops = new OperationController({ set: (fn, ms) => window.setTimeout(fn, ms), clear: (id) => window.clearTimeout(id) });
    private stopListening: (() => void) | null = null;

    constructor(app: App, private readonly plugin: AIOrganiserPlugin, private readonly onExport: () => Promise<Result<string | null>>) {
        super(app);
    }

    onOpen(): void {
        this.contentEl.addClass('ai-organiser-connectors');
        this.setTitle(this.plugin.t.agentConnectors.modalTitle);
        if (Platform.isMobile) this.tab = 'chat';
        this.stopListening = this.ops.onChange(() => this.render());
        this.render();
    }

    onClose(): void {
        this.stopListening?.();
        this.stopListening = null;
        this.contentEl.empty();
    }

    private render(): void {
        const t = this.plugin.t.agentConnectors;
        const el = this.contentEl;
        el.empty();
        el.createEl('p', { text: Platform.isMobile ? t.needsDesktop : t.intro });

        const tabs = el.createDiv({ cls: 'ai-organiser-connectors-tabs', attr: { role: 'tablist' } });
        const all: Array<[RouteTab, string]> = [['readonly', t.routeReadOnly], ['claude', t.routeClaude], ['codex', t.routeCodex], ['cli', t.routeCli], ['chat', t.routeChat]];
        for (const [id, label] of all) {
            if (Platform.isMobile && id !== 'chat') continue;
            const b = tabs.createEl('button', { text: label, attr: { role: 'tab', 'aria-selected': String(this.tab === id) } });
            if (this.tab === id) b.addClass('mod-cta');
            b.addEventListener('click', () => { this.tab = id; this.render(); });
        }

        this.renderClaims(el, this.tab);
        if (this.tab === 'readonly') this.renderReadOnly(el);
        else if (this.tab === 'claude') this.renderClaude(el);
        else if (this.tab === 'codex') this.renderCodex(el);
        else if (this.tab === 'cli') this.renderCli(el);
        else this.renderChat(el);
    }

    // ─── Shared pieces ──────────────────────────────────────────────────────

    private renderClaims(el: HTMLElement, tab: RouteTab): void {
        const t = this.plugin.t.agentConnectors;
        const text: Record<RouteTab, [string, string, string]> = {
            readonly: [t.readOnlyEnforced, t.readOnlyAdvised, t.readOnlyNotControlled],
            claude: [t.claudeEnforced, t.claudeAdvised, t.claudeNotControlled],
            codex: [t.codexEnforced, t.codexAdvised, t.codexNotControlled],
            cli: [t.cliEnforced, t.cliAdvised, t.cliNotControlled],
            chat: [t.chatEnforced, t.chatAdvised, t.chatNotControlled],
        };
        const [enforced, advised, notControlled] = text[tab];
        const box = el.createDiv({ cls: 'ai-organiser-connectors-claims', attr: { 'data-route': ROUTE_FOR_TAB[tab] } });
        box.createEl('h4', { text: t.canHeading });
        const dl = box.createEl('dl');
        for (const [label, body] of [[t.enforcedLabel, enforced], [t.advisedLabel, advised], [t.notControlledLabel, notControlled]] as const) {
            dl.createEl('dt', { text: label });
            dl.createEl('dd', { text: body });
        }
    }

    private copy(text: string, label: string, parent: HTMLElement): void {
        const t = this.plugin.t.agentConnectors;
        const b = parent.createEl('button', { text: label });
        b.addEventListener('click', () => {
            void navigator.clipboard.writeText(text).then(
                () => new Notice(t.copied, 2500),
                () => new Notice(this.plugin.t.agentIndex.copyFailed, 8000),
            );
        });
    }

    private codeBlock(el: HTMLElement, text: string): void {
        el.createEl('pre').createEl('code', { text });
    }

    private link(el: HTMLElement, label: string, href: string): void {
        const p = el.createEl('p');
        p.createEl('a', { text: label, href, attr: { target: '_blank', rel: 'noopener noreferrer' } });
    }

    private failure(el: HTMLElement, code: string): void {
        const text = code === 'baseline-changed' ? this.plugin.t.agentConnectors.chatChanged : formatGuidance(describeError(this.plugin.t, code));
        el.createEl('p', { text, cls: 'mod-warning' });
    }

    private docs(el: HTMLElement, links: Array<[string, string]>): void {
        const t = this.plugin.t.agentConnectors;
        el.createEl('h4', { text: t.docsHeading });
        for (const [label, href] of links) this.link(el, label, href);
    }

    // ─── Read-only connector ────────────────────────────────────────────────

    private renderReadOnly(el: HTMLElement): void {
        const t = this.plugin.t.agentConnectors;
        const s = this.plugin.settings;
        const platform = currentPlatform();
        if (s.agentConnectorScopeStale) this.failure(el, 'connector-scope-write-failed');

        el.createEl('h4', { text: '1' });
        el.createEl('p', { text: t.roStepFolder });
        const folderRow = el.createDiv();
        const input = folderRow.createEl('input', { type: 'text', value: s.agentConnectorFolder, attr: { placeholder: t.folderPlaceholder, 'aria-label': t.folderName } });
        const save = folderRow.createEl('button', { text: t.saveFolder });
        save.addEventListener('click', () => {
            s.agentConnectorFolder = input.value.trim();
            void this.plugin.saveSettings().then(() => this.render());
        });
        const folder = connectorFolderPath(s.agentConnectorFolder, s.protectedFolders);
        if (!folder.ok && s.agentConnectorFolder.trim() !== '') this.failure(folderRow, folder.error);

        el.createEl('h4', { text: '2' });
        el.createEl('p', { text: t.roStepCreate });
        const created = this.ops.state<ConnectorFilePaths>('files');
        const createRow = el.createDiv();
        const create = createRow.createEl('button', { text: created.status === 'running' ? t.creatingFiles : t.createFiles, cls: 'mod-cta' });
        create.disabled = !folder.ok || this.ops.isBusy('files', 'writes');
        create.addEventListener('click', () => {
            void this.ops.run('files', () => saveConnectorFiles(this.plugin, this.plugin.manifest.version), { group: 'writes', limitMs: 30_000, timeoutError: 'write-failed' })
                .catch((e: unknown) => logger.error('Connector', 'Saving files failed', e));
        });
        if (created.status === 'failed') this.failure(createRow, created.error);

        const base = vaultBasePath(this.plugin);
        if (created.status === 'done' && base.ok) {
            createRow.createEl('p', { text: t.filesDone.replace('{bundle}', created.value.bundle).replace('{server}', created.value.server), cls: 'setting-item-description' });
            this.renderReadOnlyInstall(el, created.value, base.value, platform);
        } else if (created.status !== 'done') {
            el.createEl('p', { text: t.roStop, cls: 'setting-item-description' });
        }
        this.docs(el, [[t.docClaudeServers, CONNECTOR_DOCS.claudeDesktopExtensions], [t.docCodexMcp, CONNECTOR_DOCS.codexMcp], [t.docNode, CONNECTOR_DOCS.nodejs]]);
    }

    private renderReadOnlyInstall(el: HTMLElement, files: ConnectorFilePaths, vaultPath: string, platform: ConnectorPlatform): void {
        const t = this.plugin.t.agentConnectors;
        const separator = platform === 'win32' ? '\\' : '/';
        const folder = files.server.slice(0, files.server.lastIndexOf('/'));

        el.createEl('h4', { text: '3' });
        el.createEl('p', { text: t.roStepClaude });
        el.createEl('p', { text: t.roVaultFolder });
        this.codeBlock(el, vaultPath);
        this.copy(vaultPath, t.copyLine, el);
        el.createEl('p', { text: t.roClaudeNode, cls: 'setting-item-description' });
        el.createEl('p', { text: t.roClaudeConfirm });
        this.codeBlock(el, t.testPrompt);
        this.copy(t.testPrompt, t.copyPrompt, el);
        el.createEl('p', { text: t.roClaudeAdmin, cls: 'setting-item-description' });

        el.createEl('h4', { text: '4' });
        el.createEl('p', { text: t.roStepCodex });
        const serverAbs = absoluteGeneratedPath(vaultPath, folder, CONNECTOR_SERVER_FILE, separator);
        const toml = buildCodexConfig(serverAbs, vaultPath);
        if (toml.ok) {
            this.codeBlock(el, toml.value);
            this.copy(toml.value, t.copyToml, el);
        } else {
            this.failure(el, toml.error);
        }
        this.renderNodeCheck(el);

        el.createEl('h4', { text: '5' });
        el.createEl('p', { text: t.roStepTest });
        this.renderConnectorTest(el, serverAbs, vaultPath);
        el.createEl('p', { text: t.roStop, cls: 'setting-item-description' });
    }

    private renderConnectorTest(el: HTMLElement, serverAbs: string, vaultPath: string): void {
        const t = this.plugin.t.agentConnectors;
        const state = this.ops.state<SelfTestResult>('selftest');
        const row = el.createDiv();
        const b = row.createEl('button', { text: state.status === 'running' ? t.testing : t.testConnector });
        b.disabled = this.ops.isBusy('selftest');
        b.addEventListener('click', () => {
            const spawn = nodeSpawner();
            void this.ops.run('selftest', () => {
                if (!spawn) return Promise.resolve({ ok: false as const, error: 'connector-needs-desktop' });
                return runConnectorSelfTest(spawn, serverAbs, vaultPath, { set: (fn, ms) => window.setTimeout(fn, ms), clear: (id) => window.clearTimeout(id) });
            }, { limitMs: SELF_TEST_LIMIT_MS + 2000, timeoutError: 'connector-test-failed' }).catch((e: unknown) => logger.error('Connector', 'Test failed', e));
        });
        if (state.status === 'done') row.createEl('p', { text: t.testPassed.replace('{count}', String(state.value.topLevelItems)) });
        else if (state.status === 'failed') this.failure(row, state.error);
    }

    // ─── Claude Desktop ─────────────────────────────────────────────────────

    private renderClaude(el: HTMLElement): void {
        const t = this.plugin.t.agentConnectors;
        const platform = currentPlatform();

        el.createEl('p', { text: t.preferReadOnly, cls: 'setting-item-description' });
        el.createEl('h4', { text: '1' });
        el.createEl('p', { text: t.claudeStepNode });
        this.renderNodeCheck(el);

        el.createEl('h4', { text: '2' });
        const path = claudeDesktopConfigPath(platform);
        if (path) {
            el.createEl('p', { text: t.claudeStepOpen });
            this.codeBlock(el, path);
        } else {
            el.createEl('p', { text: t.claudeStepOpenOther });
        }

        el.createEl('h4', { text: '3' });
        el.createEl('p', { text: t.claudeStepAdd });
        const base = vaultBasePath(this.plugin);
        const config = base.ok ? buildClaudeDesktopFilesystemConfig(base.value) : base;
        if (config.ok) {
            this.codeBlock(el, config.value);
            this.copy(config.value, t.copyConfig, el);
        } else {
            this.failure(el, config.error);
        }

        el.createEl('h4', { text: '4' });
        el.createEl('p', { text: t.claudeStepRestart });

        el.createEl('h4', { text: '5' });
        el.createEl('p', { text: t.claudeStepConfirm });
        this.codeBlock(el, t.testPrompt);
        this.copy(t.testPrompt, t.copyPrompt, el);
        el.createEl('p', { text: t.claudeCannotSee, cls: 'setting-item-description' });

        this.docs(el, [[t.docClaudeServers, CONNECTOR_DOCS.claudeDesktopLocalServers], [t.docNode, CONNECTOR_DOCS.nodejs]]);
    }

    private renderNodeCheck(el: HTMLElement): void {
        const t = this.plugin.t.agentConnectors;
        const state = this.ops.state<{ version: string }>('node');
        const row = el.createDiv();
        const b = row.createEl('button', { text: state.status === 'running' ? t.nodeChecking : t.checkNode });
        b.disabled = this.ops.isBusy('node');
        b.addEventListener('click', () => {
            const spawn = nodeSpawner();
            void this.ops.run('node', async () => {
                if (!spawn) return { ok: false as const, error: 'connector-needs-desktop' };
                return checkNodeInstalled(spawn, (fn, ms) => window.setTimeout(fn, ms), (id) => window.clearTimeout(id));
            }, { limitMs: 6000, timeoutError: 'connector-node-missing' }).catch((e: unknown) => logger.error('Connector', 'Node check failed', e));
        });
        if (state.status === 'done') {
            row.createEl('p', { text: (nodeMeetsMinimum(state.value.version) ? t.nodeFound : t.nodeTooOld).replace('{version}', state.value.version) });
        } else if (state.status === 'failed') {
            this.failure(row, state.error);
        }
    }

    // ─── Codex ──────────────────────────────────────────────────────────────

    private renderCodex(el: HTMLElement): void {
        const t = this.plugin.t.agentConnectors;
        el.createEl('p', { text: t.codexStepOpen });
        el.createEl('p', { text: t.codexStepDocs, cls: 'setting-item-description' });
        el.createEl('p', { text: t.codexStepCopy });
        const instructions = buildAgentInstructions(this.plugin.settings);
        this.copy(instructions, t.copyInstructions, el);
        const size = checkInstructionSize(instructions);
        const line = size.level === 'ok' ? t.sizeOk : size.level === 'warn' ? t.sizeWarn : t.sizeOver;
        el.createEl('p', { text: line.replace('{bytes}', String(size.bytes)), cls: size.level === 'over' ? 'mod-warning' : 'setting-item-description' });
        this.docs(el, [[t.docCodexAgents, CONNECTOR_DOCS.codexAgentsMd], [t.docCodexMcp, CONNECTOR_DOCS.codexMcp]]);
    }

    // ─── Command-line agents ────────────────────────────────────────────────

    private renderCli(el: HTMLElement): void {
        const t = this.plugin.t.agentConnectors;
        el.createEl('p', { text: t.cliClaude });
        this.codeBlock(el, CLAUDE_CODE_IMPORT_LINE);
        this.copy(CLAUDE_CODE_IMPORT_LINE, t.copyLine, el);

        el.createEl('p', { text: t.cliCodex });

        el.createEl('p', { text: t.cliGemini });
        const gemini = buildGeminiSettingsSnippet();
        this.codeBlock(el, gemini);
        this.copy(gemini, t.copySnippet, el);

        const platform = currentPlatform();
        if (!Platform.isMobile && (platform === 'win32' || platform === 'darwin')) this.renderTerminalButton(el, platform);
        this.docs(el, [[t.docClaudeCode, CONNECTOR_DOCS.claudeCodeMemory], [t.docCodexAgents, CONNECTOR_DOCS.codexAgentsMd], [t.docGemini, CONNECTOR_DOCS.geminiContextFiles]]);
    }

    private renderTerminalButton(el: HTMLElement, platform: ConnectorPlatform): void {
        const t = this.plugin.t.agentConnectors;
        const state = this.ops.state<null>('terminal');
        const row = el.createDiv();
        const b = row.createEl('button', { text: t.openTerminal });
        b.disabled = this.ops.isBusy('terminal');
        b.addEventListener('click', () => {
            const spawn = nodeSpawner();
            void this.ops.run('terminal', () => {
                const base = vaultBasePath(this.plugin);
                if (!base.ok) return Promise.resolve(base);
                if (!spawn) return Promise.resolve({ ok: false as const, error: 'connector-needs-desktop' });
                const res = openTerminalInVault(spawn, platform, base.value);
                return Promise.resolve(res.ok ? { ok: true as const, value: null } : res);
            }, { limitMs: 4000, timeoutError: 'connector-needs-desktop' }).catch((e: unknown) => logger.error('Connector', 'Terminal failed', e));
        });
        if (state.status === 'done') row.createEl('p', { text: t.terminalOpened, cls: 'setting-item-description' });
        else if (state.status === 'failed') this.failure(row, state.error);
    }

    // ─── Chat project file ──────────────────────────────────────────────────

    private renderChat(el: HTMLElement): void {
        const t = this.plugin.t.agentConnectors;
        el.createEl('p', { text: t.chatIntro });
        const state = this.ops.state<string>('export');
        const row = el.createDiv();
        const b = row.createEl('button', { text: state.status === 'running' ? t.chatWorking : t.exportButton, cls: 'mod-cta' });
        b.disabled = this.ops.isBusy('export', 'writes');
        b.addEventListener('click', () => {
            void this.ops.run('export', async () => {
                const done = await this.onExport();
                // A null value means the person cancelled the confirmation: not a failure, nothing to show.
                return done.ok ? ok(done.value ?? '') : done;
            }, { group: 'writes', limitMs: 180_000, timeoutError: 'write-failed' }).catch((e: unknown) => logger.error('Connector', 'Export failed', e));
        });
        if (state.status === 'done' && state.value !== '') row.createEl('p', { text: state.value });
        else if (state.status === 'failed') this.failure(row, state.error);
    }
}
