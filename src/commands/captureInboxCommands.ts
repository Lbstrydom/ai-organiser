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
import { forgetSkip, getEntry, heldPaths, rekeyTree, upsertEntry } from '../services/captureInbox/captureJournal';
import { queueCounts, settleSeconds } from '../services/captureInbox/captureQueueModel';
import type { ScanOutcome } from '../services/captureInbox/captureScanner';
import { plural } from '../utils/plural';
import { buildCaptureFolderContext } from '../services/captureInbox/captureClassify';
import { captureBlocker, captureSetupConfirmed, remapSharedScope } from '../services/captureInbox/captureConfig';
import type { CaptureController } from '../services/captureInbox/captureController';
import { buildRuntimeDeps } from '../services/captureInbox/captureDepsFactory';
import { CaptureJournalStore } from '../services/captureInbox/captureJournalStore';
import { processAgain, retryCapture } from '../services/captureInbox/captureProcessor';
import { CaptureRuntime } from '../services/captureInbox/captureRuntime';
import { acceptCapture, createOrganisedNote, processedTarget, setCaptureProcessed, skipCapture, type AcceptEdits, type OrganiseEdits } from '../services/captureInbox/captureWriter';
import { runNoticeLines } from '../services/captureInbox/runNotice';
import { outlayOf, selectForRun } from '../services/captureInbox/runSelection';
import { clearHeldMirror, setCaptureActive, setCaptureCorrupt, setHeldMirror } from '../services/captureInbox/heldMirror';
import { estimateCost, formatEstimate } from '../services/captureInbox/costEstimate';
import { CaptureInboxStatusBar } from '../ui/components/CaptureInboxStatusBar';
import { CaptureInboxQueueModal } from '../ui/modals/CaptureInboxQueueModal';
import { CaptureReviewModal } from '../ui/modals/CaptureReviewModal';
import { CaptureRunConfirmModal, type RunConfirmResult, type RunEstimate } from '../ui/modals/CaptureRunConfirmModal';
import { openCaptureInboxSetup } from '../ui/modals/CaptureInboxSetupModal';
import { ConfirmationModal } from '../ui/modals/ConfirmationModal';
import { openInboxSweepSetup, runInboxSweep, sweepBlocker } from './inboxSweepCommands';

const controllers = new WeakMap<Plugin, CaptureController>();
const corruptStores = new WeakMap<Plugin, CaptureJournalStore>();

/** The journal store when its saved data could not be read (the settings offer a reset), else null. */
export function getCorruptJournalStore(plugin: AIOrganiserPlugin): CaptureJournalStore | null {
    return corruptStores.get(plugin) ?? null;
}

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

function confirmText(plugin: AIOrganiserPlugin, title: string, body: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        let answered = false;
        const modal = new ConfirmationModal(plugin.app, title, body, () => { answered = true; resolve(true); }, plugin);
        const close = modal.onClose.bind(modal);
        modal.onClose = () => { close(); if (!answered) resolve(false); };
        modal.open();
    });
}

/** A Notice with a Cancel button; hide it when the work ends. */
function cancellableNotice(text: string, label: string, onCancel: () => void): Notice {
    const notice = new Notice('', 0);
    notice.messageEl.empty();
    notice.messageEl.createSpan({ text });
    notice.messageEl.createEl('button', { text: label }).addEventListener('click', onCancel);
    return notice;
}

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
            if (runtime.activity() === 'run' || runtime.activity() === 'recover') { new Notice(t.alreadyRunning, 5000); return; }
            if (!deps.isVisible()) { new Notice(t.notVisible, 6000); return; }
            // A look at the inbox that a file event started is not a run: wait for it instead of refusing.
            if (runtime.isRunning()) await runtime.whenIdle();
            // The user asked for this look, so a file that has sat untouched for the whole window counts as settled.
            const scan = await runtime.refresh({ trustMtime: true });
            if (!scan) { new Notice(runtime.isRunning() ? t.alreadyRunning : t.scanFailed, 6000); return; }
            const config = deps.config();
            const journal = store.get();
            const settling = queueCounts(journal).settling;
            // What a run would really send: captures that are settled (or, for the existing notes the box adds, old enough to need no settling), at most one run's worth.
            const estimateOf = (s: ScanOutcome): RunEstimate => {
                const { sent, later } = selectForRun(s.captures, (id) => getEntry(journal, id)?.state, config.maxPerRun);
                // By the run's own text-first rules: audio a note's text makes unnecessary, an image that is skipped (image reading off) or a capture with nothing to read sends nothing.
                const params = { minWords: config.minWords, digitiseImagesWithText: config.digitiseImages, digitisationEnabled: deps.digitisationEnabled(), maxImages: config.maxImagesPerCapture };
                const outlays = sent.map((c) => outlayOf(c, params, getEntry(journal, c.id)?.forceTranscribe));
                const sending = outlays.filter((o) => o.sends).length;
                const audioBytes = outlays.reduce((n, o) => n + o.audioBytes, 0);
                const images = outlays.reduce((n, o) => n + o.images, 0);
                const audioMB = audioBytes / (1024 * 1024);
                // Audio and images go to the transcription and vision providers, which are not the local text model.
                const sendsMedia = audioBytes > 0 || images > 0;
                const provider = isAzureMode(plugin.settings) ? 'azure' : plugin.settings.serviceType === 'local' && !sendsMedia ? 'local' : 'cloud';
                return { ids: sent.map((c) => c.id), captures: sending, later, audioMB, images, cost: formatEstimate(estimateCost({ captures: sending, audioMB, images }), provider) };
            };
            const base = estimateOf(scan);
            if (base.captures === 0 && scan.olderIgnored === 0) {
                if (settling > 0) {
                    const seconds = Math.min(...Object.values(journal.entries).filter((e) => e.state === 'waiting_for_stable' && !e.needsConfirm && e.waitReason !== 'empty' && e.waitReason !== 'attachment').map((e) => settleSeconds(e, Date.now(), config.stabilityMs)));
                    new Notice(plural(t.nothingReadySettling, settling).replace('{count}', String(settling)).replace('{seconds}', String(Math.max(1, Number.isFinite(seconds) ? seconds : 1))), 8000);
                } else new Notice(t.nothingToProcess, 6000);
                return;
            }
            // The box on the confirmation changes the answer, so the answer is worked out for both choices before it is shown.
            let withExisting = base;
            if (scan.olderIgnored > 0) {
                const previewed = await runtime.preview(true);
                // Without it the box would promise a number nobody worked out: stop rather than guess.
                if (!previewed.ok) { new Notice(t.scanFailed, 6000); return; }
                withExisting = estimateOf(previewed.value);
            }
            const answer = await confirmRun(plugin, { base, withExisting, cap: config.maxPerRun, older: scan.olderIgnored, settling });
            if (!answer.confirmed) return;
            if (plugin.settings.captureConfirmedAt === '') {
                plugin.settings.captureConfirmedAt = new Date().toISOString();
                void plugin.saveSettings();
            }
            const working = cancellableNotice(t.working, plugin.t.modals.cancel, () => { runtime.cancel(); new Notice(t.cancelledNotice, 6000); });
            try {
                // The run is limited to the captures the confirmation listed: what it said will be sent is all that is sent.
                const allowIds = new Set((answer.includeExisting ? withExisting : base).ids);
                const knownSkips = new Set(Object.keys(store.get().tombstones));
                const result = await runtime.runOnce({ trigger: 'manual', includeExisting: answer.includeExisting, allowIds });
                if (!result) { new Notice(t.alreadyRunning, 5000); return; }
                const s = result.summary;
                // Captures set aside by the scan itself (too large, unsupported...) are part of "skipped" too.
                // Only skips this run recorded: kept-out notes are listed again by every scan and are counted in the queue, not here.
                const skipped = s.skipped + result.scan.skipped.filter((k) => k.reason !== 'excluded' && !knownSkips.has(k.id)).length;
                const after = queueCounts(store.get());
                // What is left, so a capped run never looks like the end; "beyond the limit" only when the confirmation really held some back.
                const lines = runNoticeLines(t, s, skipped, after, (answer.includeExisting ? withExisting : base).later > 0);
                new Notice(lines.join(' '), 9000);
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

        async markProcessed(id) {
            const entry = getEntry(store.get(), id);
            if (!entry) return failed('capture-changed');
            // Previewed: the user sees the one change before it is made.
            if (!(await confirmText(plugin, t.markProcessed.replace('…', ''), t.markProcessedPreview.replace('{path}', processedTarget(entry))))) return false;
            const res = await setCaptureProcessed(deps.writer, id, true);
            return res.ok ? true : failed(res.error);
        },

        async unmarkProcessed(id) {
            const res = await setCaptureProcessed(deps.writer, id, false);
            return res.ok ? true : failed(res.error);
        },

        async skip(id) {
            const res = await skipCapture(deps.writer, id);
            if (!res.ok) guidance(plugin, res.error);
        },

        async retry(id) {
            if (await retryCapture(deps, id)) new Notice(t.retryNotice, 6000);
        },

        async retrySkipped(id) {
            await store.mutate((j) => forgetSkip(j, id));
            await runtime.refresh();
            new Notice(t.skipRetryNotice, 7000);
        },

        stabilityMs() { return deps.config().stabilityMs; },
        sweepFeatureOn() { return isFeatureEnabled(plugin.settings, 'inbox-sweep'); },
        openSweepSetup() { openInboxSweepSetup(plugin); },
        async processAgain(id) {
            if (!(await confirmText(plugin, t.processAgain, t.processAgainConfirm))) return;
            await processAgain(deps, id);
        },

        async transcribeAnyway(id) {
            // Ask first: this drops the reviewed text and uses the provider. Cancelling leaves everything as it was.
            if (!(await confirmText(plugin, t.transcribeAnyway, t.transcribeAnywayConfirm))) return;
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
        if (store.isLoaded()) {
            const from = normalisePath(oldPath);
            const to = normalisePath(file.path);
            // Most renames touch nothing the journal knows: no write then.
            if (rekeyTree(store.get(), from, to) !== store.get()) void store.mutate((j) => rekeyTree(j, from, to));
        }
    }));
}

async function start(plugin: AIOrganiserPlugin): Promise<void> {
    const store = new CaptureJournalStore(plugin);
    const loaded = await store.load();
    if (!loaded.ok) {
        // Fail closed: no runtime, no commands that process, and the sweep refuses to run until the user resets.
        corruptStores.set(plugin, store);
        setCaptureCorrupt(true);
        plugin.register(() => { setCaptureCorrupt(false); corruptStores.delete(plugin); });
        guidance(plugin, 'capture-journal-corrupt', 15000);
        return;
    }
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
    // Until the user has set the feature up (or confirmed a run) nothing looks at the inbox in the background.
    const hint = (file: TAbstractFile): void => { if (ready && captureSetupConfirmed(plugin.settings) && inInbox(plugin, file.path)) runtime.hint(); };
    plugin.registerEvent(plugin.app.vault.on('create', hint));
    plugin.registerEvent(plugin.app.vault.on('modify', hint));
    plugin.registerEvent(plugin.app.vault.on('delete', hint));
    trackRenames(plugin, store);
    plugin.registerDomEvent(activeDocument, 'visibilitychange', () => {
        if (activeDocument.visibilityState !== 'visible' || !ready || !captureSetupConfirmed(plugin.settings)) return;
        void runtime.refresh().then(() => runtime.runOnce({ trigger: 'auto' }));
    });

    plugin.app.workspace.onLayoutReady(() => {
        ready = true;
        bar.mount();
        void (async () => {
            await runtime.recoverOnStart();
            if (!captureSetupConfirmed(plugin.settings)) return;
            await runtime.refresh();
            await runtime.runOnce({ trigger: 'auto' });
        })().catch((e: unknown) => logger.warn('CaptureInbox', 'Startup pass failed', e));
    });
}

export function registerCaptureInboxCommands(plugin: AIOrganiserPlugin): void {
    const t = plugin.t;
    // While this registrar is installed the sweep waits for the capture journal; if start-up fails it must not wait forever.
    setCaptureActive(true);
    plugin.register(() => setCaptureActive(false));
    const withController = (run: (c: CaptureController) => void): void => {
        const c = getCaptureController(plugin);
        if (c) run(c);
        else if (getCorruptJournalStore(plugin)) guidance(plugin, 'capture-journal-corrupt', 12000);
        else new Notice(t.captureInbox.queueChecking, 3000);
    };
    plugin.addCommand({ id: 'process-capture-inbox', name: t.commands.processCaptureInbox, icon: 'inbox', callback: () => withController((c) => { c.processNow().catch((e: unknown) => logger.error('CaptureInbox', 'Process failed', e)); }) });
    plugin.addCommand({ id: 'review-captures', name: t.commands.reviewCaptures, icon: 'list-checks', callback: () => withController((c) => c.openQueue()) });
    plugin.addCommand({ id: 'setup-capture-inbox', name: t.commands.setupCaptureInbox, icon: 'sparkles', callback: () => openCaptureInboxSetup(plugin) });
    start(plugin).catch((e: unknown) => {
        // Stay active: the capture journal never loaded, so the sweep must keep waiting rather than read held captures.
        logger.error('CaptureInbox', 'Could not start the capture inbox', e);
        guidance(plugin, 'unknown');
    });
}
