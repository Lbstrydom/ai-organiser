/**
 * The guided setup for the capture inbox, built from the shared stepper.
 *
 * The inbox folders and what is kept out are the inbox sweep's settings (one inbox, one privacy policy), so
 * those two steps are the same code the sweep's wizard uses. Capture adds the destination for organised notes
 * and its limits. Nothing is saved until Finish, and a failed save puts everything back.
 */
import { Notice, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { Result, ok, err } from '../../core/result';
import { sweepPolicy } from '../../services/inboxSweep/sweepCommit';
import { captureOutputRoots } from '../../services/captureInbox/captureConfig';
import { validateCaptureSetup } from '../../services/captureInbox/capturePolicy';
import { GuidedSetupModal } from './GuidedSetupModal';
import { FolderSuggest } from '../settings/components/FolderSuggest';
import {
    applySettingsWithRollback, draftFromSettings, previewScope, renderInboxFolders, renderKeepOut, scopeValues, validateKeepOut,
} from '../setup/inboxScopeSteps';

/** The guidance code for the first setup problem. */
function problemCode(problems: ReturnType<typeof validateCaptureSetup>): string | null {
    const first = problems[0];
    if (!first) return null;
    if (first.code === 'no-inbox') return 'capture-no-folders';
    return first.code.startsWith('inbox-') ? 'capture-inbox-invalid' : 'capture-destination-refused';
}

export function openCaptureInboxSetup(plugin: AIOrganiserPlugin, onDone?: () => void): void {
    const t = plugin.t;
    const c = t.captureInbox;
    const sweepStrings = t.inboxSweep;
    const s = plugin.settings;
    const draft = {
        ...draftFromSettings(s),
        destination: s.captureDestinationRoot,
        maxMB: String(s.captureMaxAttachmentMB),
        perRun: String(s.captureMaxPerRun),
        digitise: s.captureDigitiseImages,
        onOpen: s.captureOnOpen,
    };
    const problems = () => validateCaptureSetup(draft.inbox, draft.destination, s.protectedFolders, captureOutputRoots(s), draft.excludedFolders);
    const intIn = (text: string, fallback: number, min: number, max: number): number => {
        const n = Math.floor(Number(text));
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    };

    new GuidedSetupModal(plugin.app, t, {
        title: c.wizardTitle,
        steps: [
            {
                id: 'folders',
                title: c.stepFolders,
                validate: () => {
                    const code = problemCode(problems());
                    return code ? err(code) : ok(undefined);
                },
                render: (el) => {
                    el.createEl('p', { text: c.foldersHelp });
                    renderInboxFolders(plugin, el, draft);
                    new Setting(el).setName(c.destinationName).setDesc(c.destinationDesc).addText((tx) => {
                        tx.setValue(draft.destination).onChange((v) => { draft.destination = v.trim(); });
                        tx.inputEl.setAttribute('aria-label', c.destinationName);
                        new FolderSuggest(plugin.app, tx.inputEl, (value) => { draft.destination = value; tx.setValue(value); });
                    });
                },
            },
            {
                id: 'keepout',
                title: c.stepKeepOut,
                validate: () => validateKeepOut(draft, 'capture-keepout-required'),
                render: (el) => renderKeepOut(plugin, el, draft, sweepStrings),
            },
            {
                id: 'limits',
                title: c.stepLimits,
                render: async (el) => {
                    el.createEl('p', { text: c.limitsHelp });
                    el.createEl('p', { text: c.privacyStatement, cls: 'ai-organiser-capture-warning' });
                    new Setting(el).setName(c.maxAttachmentName).setDesc(c.maxAttachmentDesc).addText((tx) => tx.setValue(draft.maxMB).onChange((v) => { draft.maxMB = v; }));
                    new Setting(el).setName(c.maxPerRunName).addText((tx) => tx.setValue(draft.perRun).onChange((v) => { draft.perRun = v; }));
                    new Setting(el).setName(c.digitiseImagesName).setDesc(c.digitiseImagesDesc).addToggle((tg) => tg.setValue(draft.digitise).onChange((v) => { draft.digitise = v; }));
                    new Setting(el).setName(c.onOpenName).setDesc(c.onOpenDesc).addToggle((tg) => tg.setValue(draft.onOpen).onChange((v) => { draft.onOpen = v; }));
                    el.createEl('h4', { text: c.stepPreview });
                    el.createEl('p', { text: c.previewHelp });
                    const box = el.createDiv({ attr: { role: 'status' } });
                    box.setText(c.previewWorking);
                    const { allowed, kept } = await previewScope(plugin, draft, sweepPolicy(plugin));
                    const since = s.captureSince > 0 ? s.captureSince : Date.now();
                    const folders = draft.inbox;
                    const older = plugin.app.vault.getMarkdownFiles().filter((f) => f.stat.ctime < since && folders.some((folder) => f.path.startsWith(folder.replace(/\/+$/, '') + '/'))).length;
                    box.setText(c.previewResult.replace('{captures}', String(allowed)).replace('{kept}', String(kept)).replace('{older}', String(older)));
                },
            },
        ],
        onFinish: async (): Promise<Result<void>> => {
            const code = problemCode(problems());
            if (code) return err(code);
            const keepOut = validateKeepOut(draft, 'capture-keepout-required');
            if (!keepOut.ok) return err(keepOut.error);
            return applySettingsWithRollback(
                plugin,
                {
                    ...scopeValues(draft),
                    captureDestinationRoot: draft.destination,
                    captureMaxAttachmentMB: intIn(draft.maxMB, s.captureMaxAttachmentMB, 1, 25),
                    captureMaxPerRun: intIn(draft.perRun, s.captureMaxPerRun, 1, 50),
                    captureDigitiseImages: draft.digitise,
                    captureOnOpen: draft.onOpen,
                    // Set once, on the first finished setup, and never moved: enabling the feature never
                    // sweeps up an old inbox.
                    captureSince: s.captureSince > 0 ? s.captureSince : Date.now(),
                },
                { id: 'capture-inbox', value: new Date().toISOString() },
            ).then((r) => { if (r.ok) { new Notice(c.setupDone, 10000); onDone?.(); } return r; });
        },
    }).open();
}
