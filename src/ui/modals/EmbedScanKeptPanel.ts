/**
 * The "Kept" panel of the Find embeds results window: one card per file the delete-time re-check kept,
 * saying exactly which note, canvas or file is in the way and what to do about it. Rendering only;
 * what each card says and offers is decided by `describeKept` (services/attachmentKeptModel).
 */
import { setIcon } from 'obsidian';
import type { Translations } from '../../i18n/types';
import type { KeptAction, KeptCard, KeptEntry } from '../../services/attachmentKeptModel';
import { formatFileSize } from '../../services/embedScanService';
import { plural } from '../../utils/plural';
import { listen } from '../utils/domUtils';

export interface KeptPanelHandlers {
    open(path: string): void;
    removeAndDelete(filePath: string): void;
    enableRemoval(filePath: string): void;
    scanAgain(): void;
}

const baseName = (path: string): string => (path.split('/').pop() ?? path).replace(/\.(md|canvas)$/i, '');

function entryLines(t: Translations, entry: KeptEntry): string[] {
    const es = t.embedScan;
    const item = entry.item;
    switch (item.type) {
        case 'referenced': {
            const lines = [item.ref.extension === 'canvas'
                ? es.keptUsedInCanvas.replace('{note}', baseName(item.ref.path))
                : es.keptUsedIn.replace('{note}', baseName(item.ref.path)).replace('{line}', String(item.ref.lineNumber))];
            if (item.protectedReferrer) lines.push(es.keptReferrerProtected);
            if (item.ref.extension === 'canvas') lines.push(es.keptCanvasHint);
            return lines;
        }
        case 'referenced-unknown': return [plural(es.keptUsedInUnknown, item.count)];
        case 'ambiguous': return [item.others.length > 0 ? es.keptAmbiguous.replace('{other}', item.others.join(', ')) : es.keptAmbiguousUnknown];
        case 'unreadable': return [
            (item.failure.kind === 'canvas-unreadable' ? es.keptUnreadableCanvas : es.keptUnreadableNote).replace('{note}', baseName(item.failure.path)),
            es.keptUnreadableHint,
        ];
        case 'unreadable-unknown': return [es.keptUnreadableUnknown];
        case 'changed': return [es.keptChanged];
        case 'missing': return [es.reasonMissing];
        case 'protected': return [es.reasonProtected];
    }
}

function actionLabel(t: Translations, action: KeptAction): string {
    const es = t.embedScan;
    switch (action.kind) {
        case 'open-note': return es.keptOpenNote;
        case 'open-canvas': return es.keptOpenCanvas;
        case 'open-file': return es.keptOpenFile;
        case 'remove-link-and-delete': return es.removeLinkAndDelete;
        case 'enable-link-removal': return es.removeLinkEnable;
        case 'scan-again': return es.scanAgain;
    }
}

/** Render the cards into `container` (already emptied). Returns the listener disposers. */
export function renderKeptPanel(
    container: HTMLElement,
    cards: readonly KeptCard[],
    t: Translations,
    handlers: KeptPanelHandlers,
    busy: boolean,
): Array<() => void> {
    const disposers: Array<() => void> = [];
    if (cards.length === 0) return disposers;
    const es = t.embedScan;

    const region = container.createDiv({
        cls: 'ai-organiser-embed-scan-kept',
        attr: { role: 'region', 'aria-label': es.keptPanelLabel },
    });
    const heading = region.createDiv({ cls: 'ai-organiser-embed-scan-kept-title' });
    setIcon(heading.createSpan({ cls: 'ai-organiser-embed-scan-orphan-icon' }), 'alert-triangle');
    heading.createSpan({ text: es.keptReasonsTitle });
    region.createDiv({ cls: 'ai-organiser-embed-scan-orphan-disclaimer', text: es.keptIntro });

    const button = (parent: HTMLElement, action: KeptAction, fileName: string, onClick: () => void, warn = false): void => {
        const label = actionLabel(t, action);
        const btn = parent.createEl('button', {
            text: label,
            cls: `ai-organiser-embed-scan-action-btn${warn ? ' mod-warning' : ''}`,
            attr: { type: 'button', 'aria-label': `${label}: ${fileName}` },
        });
        btn.disabled = busy;
        disposers.push(listen(btn, 'click', onClick));
    };

    for (const card of cards) {
        const el = region.createDiv({ cls: 'ai-organiser-embed-scan-kept-card' });
        const head = el.createDiv({ cls: 'ai-organiser-embed-scan-kept-head' });
        head.createSpan({ cls: 'ai-organiser-embed-scan-filename', text: card.name });
        head.createSpan({ cls: 'ai-organiser-embed-scan-badge size', text: formatFileSize(card.sizeBytes) });
        el.createDiv({ cls: 'ai-organiser-embed-scan-path', text: card.path });

        for (const entry of card.entries) {
            const row = el.createDiv({ cls: 'ai-organiser-embed-scan-kept-entry' });
            const text = row.createDiv({ cls: 'ai-organiser-embed-scan-kept-text' });
            for (const line of entryLines(t, entry)) text.createDiv({ text: line });
            if (entry.actions.length > 0) {
                const actions = row.createDiv({ cls: 'ai-organiser-embed-scan-kept-actions' });
                for (const action of entry.actions) {
                    if (action.kind === 'open-note' || action.kind === 'open-canvas' || action.kind === 'open-file') {
                        button(actions, action, card.name, () => handlers.open(action.path));
                    }
                }
            }
        }

        if (card.fileActions.length > 0) {
            const actions = el.createDiv({ cls: 'ai-organiser-embed-scan-kept-actions' });
            for (const action of card.fileActions) {
                if (action.kind === 'remove-link-and-delete') {
                    button(actions, action, card.name, () => handlers.removeAndDelete(card.path), true);
                } else if (action.kind === 'enable-link-removal') {
                    actions.createSpan({ cls: 'setting-item-description', text: es.removeLinkOff });
                    button(actions, action, card.name, () => handlers.enableRemoval(card.path));
                } else if (action.kind === 'scan-again') {
                    button(actions, action, card.name, () => handlers.scanAgain());
                }
            }
        }
    }
    return disposers;
}
