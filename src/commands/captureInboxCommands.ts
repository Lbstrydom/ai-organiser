/**
 * Capture inbox: the three commands, the runtime that backs them, and everything that must stay quiet when
 * the feature is off. This registrar runs only when the feature is on at load (`REGISTER_BY_FEATURE`), so a
 * disabled feature adds no command, listener, timer, status-bar item or data key.
 *
 *  - "Process capture inbox": estimate and confirm, then process one capture at a time into proposals.
 *  - "Review captures": the compact queue (the status bar opens it too).
 *  - "Set up capture inbox": the guided setup shared with the inbox sweep.
 *
 * File events and "opened Obsidian" are only hints to look; they never start paid work on their own.
 */
import { Notice, TAbstractFile, TFile, type Plugin } from 'obsidian';
import type AIOrganiserPlugin from '../main';
import { describeError, formatGuidance } from '../core/friendlyErrors';
import { isInsideOrEqual, normalisePath } from '../core/protectedPaths';
import { isFeatureEnabled } from '../services/featureService';
import { evaluateSetup, toFolderSet } from '../core/setupState';
import { isAzureMode } from '../services/azure/endpointResolver';
import { logger } from '../utils/logger';
import { getEntry, heldPaths, rekeyTree, upsertEntry } from '../services/captureInbox/captureJournal';
import { buildCaptureFolderContext } from '../services/captureInbox/captureClassify';
import { captureBlocker, remapSharedScope } from '../services/captureInbox/captureConfig';
import type { CaptureController } from '../services/captureInbox/captureController';
import { buildRuntimeDeps } from '../services/captureInbox/captureDepsFactory';
import { CaptureJournalStore } from '../services/captureInbox/captureJournalStore';
import { processAgain, retryCapture } from '../services/captureInbox/captureProcessor';
import { CaptureRuntime } from '../services/captureInbox/captureRuntime';
import { acceptCapture, createOrganisedNote, skipCapture, type AcceptEdits, type OrganiseEdits } from '../services/captureInbox/captureWriter';
import { clearHeldMirror, setHeldMirror } from '../services/captureInbox/heldMirror';
import { estimateCost, formatEstimate } from '../services/captureInbox/costEstimate';
import { CaptureInboxStatusBar } from '../ui/components/CaptureInboxStatusBar';
import { CaptureInboxQueueModal } from '../ui/modals/CaptureInboxQueueModal';
import { CaptureReviewModal } from '../ui/modals/CaptureReviewModal';
import { CaptureRunConfirmModal, type RunConfirmResult } from '../ui/modals/CaptureRunConfirmModal';
import { openCaptureInboxSetup } from '../ui/modals/CaptureInboxSetupModal';
import { runInboxSweep, sweepBlocker } from './inboxSweepCommands';

const controllers = new WeakMap<Plugin, CaptureController>();

/** The live controller, or null when the feature is off or has not finished loading. */
export function getCaptureController(plugin: AIOrganiserPlugin): CaptureController | null {
    return controllers.get(plugin) ?? null;
}

const guidance = (plugin: AIOrganiserPlugin, code: string, ms = 9000): void => {
    new Notice(formatGuidance(describeError(plugin.t, code)), ms);
};

function inboxFolders(plugin: AIOrganiserPlugin): string[] {
    return plugin.settings.sweepInboxFolders.map(normalisePath).filter(Boolean);
}

const inInbox = (plugin: AIOrganiserPlugin, path: string): boolean => inboxFolders(plugin).some((f) => isInsideOrEqual(normalisePath(path), f));

function confirmRun(plugin: AIOrganiserPlugin, info: ConstructorParameters<typeof CaptureRunConfirmModal>[2]): Promise<RunConfirmResult> {
    return new Promise((resolve) => new CaptureRunConfirmModal(plugin.app, plugin, info, resolve).open());
}

function makeController(plugin: AIOrganiserPlugin, store: CaptureJournalStore, runtime: CaptureRuntime, deps: ReturnType<typeof buildRuntimeDeps>): CaptureController {
    const t = plugin.t.captureInbox;
    const failed = (code: string): false => { guidance(plugin, code); return false; };

    const controller: CaptureController = {
        store,

        async processNow() {
            const blocker = captureBlocker(plugin.settings, !!plugin.llmService);
            if (blocker) { guidance(plugin, blocker); return; }
            if (runtime.isRunning()) { new Notice(t.alreadyRunning, 5000); return; }
            if (!deps.isVisible()) { new Notice(t.notVisible, 6000); return; }
            const scan = await runtime.refresh();
            if (!scan) { new Notice(t.alreadyRunning, 5000); return; }
            const journal = store.get();
            const open = scan.captures.filter((c) => {
                const e = getEntry(journal, c.id);
                return !e || e.state === 'waiting_for_stable' || e.state === 'ready' || (e.state === 'failed' && !!e.retriable);
            });
            if (open.length === 0 && scan.olderIgnored === 0) { new Notice(t.nothingToProcess, 6000); return; }
            const audioBytes = open.reduce((n, c) => n + c.attachments.filter((a) => a.kind === 'audio').reduce((m, a) => m + a.size, 0), 0);
            const images = open.reduce((n, c) => n + c.attachments.filter((a) => a.kind === 'image').length, 0);
            const provider = plugin.settings.serviceType === 'local' ? 'local' : isAzureMode(plugin.settings) ? 'azure' : 'cloud';
            const audioMB = audioBytes / (1024 * 1024);
            const answer = await confirmRun(plugin, {
                captures: open.length,
                audioMB,
                images,
                older: scan.olderIgnored,
                cost: formatEstimate(estimateCost({ captures: open.length, audioMB, images }), provider),
            });
            if (!answer.confirmed) return;
            if (plugin.settings.captureConfirmedAt === '') {
                plugin.settings.captureConfirmedAt = new Date().toISOString();
                void plugin.saveSettings();
            }
            const working = new Notice(t.working, 0);
            try {
                const result = await runtime.runOnce({ trigger: 'manual', includeExisting: answer.includeExisting });
                if (!result) { new Notice(t.alreadyRunning, 5000); return; }
                const s = result.summary;
                new Notice(t.summaryNotice.replace('{processed}', String(s.processed)).replace('{review}', String(s.awaitingReview)).replace('{failed}', String(s.failed)).replace('{skipped}', String(s.skipped)), 7000);
                if (s.backpressure) new Notice(t.backpressureNote, 7000);
            } finally {
                working.hide();
            }
        },

        openQueue() { new CaptureInboxQueueModal(plugin.app, plugin, controller).open(); },
        openReview(id) { new CaptureReviewModal(plugin.app, plugin, controller, id).open(); },

        async accept(id, edits: AcceptEdits) {
            const res = await acceptCapture(deps.writer, id, edits);
            return res.ok ? true : failed(res.error);
        },

        async organise(id, edits: OrganiseEdits) {
            const res = await createOrganisedNote(deps.writer, id, edits);
            if (res.ok) return res.value;
            guidance(plugin, res.error);
            return null;
        },

        async skip(id) {
            const res = await skipCapture(deps.writer, id);
            if (!res.ok) guidance(plugin, res.error);
        },

        async retry(id) { await retryCapture(deps, id); },
        async processAgain(id) { await processAgain(deps, id); },

        async transcribeAnyway(id) {
            // The held results are dropped and the capture goes back to the start; nothing is sent until you run it.
            await store.mutate((j) => {
                const e = getEntry(j, id);
                if (!e || e.state !== 'awaiting_review') return j;
                return upsertEntry(j, { ...e, state: 'waiting_for_stable', forceTranscribe: true, text: undefined, noteText: undefined, proposal: undefined, updatedAt: Date.now() });
            });
            await controller.processNow();
        },

        folderOptions() {
            const root = plugin.settings.captureDestinationRoot;
            const folders = plugin.app.vault.getAllLoadedFiles().filter((f) => !(f instanceof TFile) && f.path !== '/').map((f) => f.path);
            const ctx = buildCaptureFolderContext(root, folders, (p) => deps.folderAllowed(p));
            return ctx ? [ctx.rootPath, ...ctx.subfolders] : [];
        },

        sweepAvailable() {
            return isFeatureEnabled(plugin.settings, 'inbox-sweep')
                && evaluateSetup('inbox-sweep', plugin.settings, { existingFolders: toFolderSet(plugin.app.vault.getAllLoadedFiles().filter((f) => !(f instanceof TFile)).map((f) => f.path)) }).state === 'ready'
                && sweepBlocker(plugin) === null;
        },

        runSweep() { return runInboxSweep(plugin); },

        openNote(path) {
            const entry = getEntry(store.get(), path);
            const target = entry?.companionPath ?? path;
            const file = plugin.app.vault.getAbstractFileByPath(target);
            if (file instanceof TFile) void plugin.app.workspace.getLeaf(false).openFile(file);
        },
    };
    return controller;
}

/** A rename keeps the shared folder settings and the journal pointing at the right place. Idempotent. */
function trackRenames(plugin: AIOrganiserPlugin, store: CaptureJournalStore): void {
    plugin.registerEvent(plugin.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
        const s = plugin.settings;
        // The inbox and keep-out folders are shared with the sweep, whose own rename tracking only exists
        // while the sweep is on: remap them here too (applying the same rename twice changes nothing).
        const patch = remapSharedScope(s, oldPath, file.path);
        if (patch.changed) {
            s.sweepInboxFolders = patch.sweepInboxFolders;
            s.sweepExcludedFolders = patch.sweepExcludedFolders;
            s.captureDestinationRoot = patch.captureDestinationRoot;
            void plugin.saveSettings().catch((e: unknown) => logger.error('CaptureInbox', 'Could not save a renamed folder setting', e));
        }
        if (store.isLoaded()) void store.mutate((j) => rekeyTree(j, normalisePath(oldPath), normalisePath(file.path)));
    }));
}

async function start(plugin: AIOrganiserPlugin): Promise<void> {
    const store = new CaptureJournalStore(plugin);
    await store.load();
    const mirror = () => setHeldMirror(heldPaths(store.get()));
    mirror();
    const unsubscribe = store.subscribe(mirror);

    const deps = buildRuntimeDeps(plugin, store);
    const runtime = new CaptureRuntime(deps);
    const controller = makeController(plugin, store, runtime, deps);
    controllers.set(plugin, controller);
    const bar = new CaptureInboxStatusBar(plugin, controller);

    plugin.register(() => {
        runtime.dispose();
        bar.dispose();
        unsubscribe();
        void store.dispose();
        clearHeldMirror();
        controllers.delete(plugin);
    });

    let ready = false;
    const hint = (file: TAbstractFile): void => { if (ready && inInbox(plugin, file.path)) runtime.hint(); };
    plugin.registerEvent(plugin.app.vault.on('create', hint));
    plugin.registerEvent(plugin.app.vault.on('modify', hint));
    plugin.registerEvent(plugin.app.vault.on('delete', hint));
    trackRenames(plugin, store);
    plugin.registerDomEvent(activeDocument, 'visibilitychange', () => {
        if (activeDocument.visibilityState !== 'visible' || !ready) return;
        void runtime.refresh().then(() => runtime.runOnce({ trigger: 'auto' }));
    });

    plugin.app.workspace.onLayoutReady(() => {
        ready = true;
        bar.mount();
        void (async () => {
            await runtime.recoverOnStart();
            await runtime.refresh();
            await runtime.runOnce({ trigger: 'auto' });
        })().catch((e: unknown) => logger.warn('CaptureInbox', 'Startup pass failed', e));
    });
}

export function registerCaptureInboxCommands(plugin: AIOrganiserPlugin): void {
    const t = plugin.t;
    plugin.addCommand({ id: 'process-capture-inbox', name: t.commands.processCaptureInbox, icon: 'inbox', callback: () => { void getCaptureController(plugin)?.processNow(); } });
    plugin.addCommand({ id: 'review-captures', name: t.commands.reviewCaptures, icon: 'list-checks', callback: () => getCaptureController(plugin)?.openQueue() });
    plugin.addCommand({ id: 'setup-capture-inbox', name: t.commands.setupCaptureInbox, icon: 'sparkles', callback: () => openCaptureInboxSetup(plugin) });
    start(plugin).catch((e: unknown) => logger.error('CaptureInbox', 'Could not start the capture inbox', e));
}
