/**
 * "Connect this device" in the Google Tasks setup window. Paste only, so it works on a phone. The pasted code stays in the input and
 * is never logged or stored until the script has accepted it; the service does the testing and saving.
 */
import { Notice, Setting } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { copyCombinedScript } from '../../commands/googleScriptCommands';
import { describeError, formatGuidance } from '../../core/friendlyErrors';
import { connectDevice, createConnectionCode, replaceTasksSecret, type ConnectOutcome } from '../../services/inboxSweep/tasksConnection';
import { ConfirmationModal } from '../modals/ConfirmationModal';

export interface ConnectDeviceOptions {
    /** The link field of the window: used when only the secret is pasted */
    link: () => string;
    /** The list chosen so far: the script copied after a replace approves it */
    listId: () => string;
    onConnected: (outcome: ConnectOutcome) => void;
    run: (task: () => Promise<void>, line?: HTMLElement) => void;
}

/** Returns the collapsible section, so the window can open it when this device has a link but no secret. */
export function renderConnectDevice(el: HTMLElement, plugin: AIOrganiserPlugin, options: ConnectDeviceOptions): HTMLDetailsElement {
    const t = plugin.t;
    const c = t.googleTasks;
    const say = (line: HTMLElement, code: string): void => { line.setText(formatGuidance(describeError(t, code))); };
    const box = el.createEl('details');
    box.createEl('summary', { text: c.connectTitle });
    box.createEl('p', { text: c.connectIntro, cls: 'setting-item-description' });

    let pasted = '';
    let input: { setValue: (v: string) => unknown } | null = null;
    const status = box.createDiv({ cls: 'setting-item-description', attr: { role: 'status' } });
    new Setting(box).setName(c.connectPasteName).setDesc(c.connectPasteDesc)
        .addText((tx) => {
            input = tx;
            tx.onChange((v) => { pasted = v; });
            // Masked and not remembered: this is a secret, even though it is pasted.
            tx.inputEl.setAttribute('type', 'password');
            tx.inputEl.setAttribute('autocomplete', 'off');
            tx.inputEl.setAttribute('aria-label', c.connectPasteName);
        })
        .addButton((b) => b.setButtonText(c.connectButton).setCta().onClick(() => options.run(async () => {
            status.setText(c.testing);
            const res = await connectDevice(plugin, pasted, options.link());
            if (!res.ok) { say(status, res.error); return; }
            pasted = '';
            input?.setValue('');
            status.setText(c.connectDone);
            options.onConnected(res.value);
        }, status)));

    new Setting(box).setName(c.connectCopyName).setDesc(c.connectCopyWarning)
        .addButton((b) => b.setButtonText(c.connectCopyButton).onClick(() => options.run(async () => {
            const code = await createConnectionCode(plugin);
            if (!code.ok) { say(status, code.error); return; }
            await navigator.clipboard.writeText(code.value);
            new Notice(c.connectCopied, 12000);
        }, status)));

    new Setting(box).setName(c.connectReplaceName).setDesc(c.connectReplaceDesc)
        .addButton((b) => b.setButtonText(c.connectReplaceButton).setWarning().onClick(() => {
            new ConfirmationModal(plugin.app, c.connectReplaceName, c.connectReplaceConfirm, () => {
                options.run(async () => {
                    await replaceTasksSecret(plugin);
                    await copyCombinedScript(plugin, options.listId() || undefined, true);
                }, status);
            }, plugin).open();
        }));
    return box;
}
