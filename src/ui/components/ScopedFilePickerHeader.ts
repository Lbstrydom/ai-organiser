/**
 * Scoped file picker header (D9).
 *
 * Renders the "◉ Files in this note (N) · ○ All vault files (M)" radio at
 * the top of any vault file picker that supports scoping. Uses `listen()`
 * for cleanup (M4 — modal event-listener discipline).
 */

import { listen } from '../utils/domUtils';
import type { VaultFileScope } from '../utils/vaultFileScope';

export interface ScopedFilePickerHeaderOptions {
    container: HTMLElement;
    initialScope: VaultFileScope;
    activeNoteCount: number;
    vaultCount: number;
    inNoteLabel: string;     // i18n: "Files in this note"
    allVaultLabel: string;   // i18n: "All vault files"
    onScopeChange: (scope: VaultFileScope) => void;
    /** Caller-owned cleanup registrar. */
    cleanups: Array<() => void>;
}

export function renderScopedFilePickerHeader(opts: ScopedFilePickerHeaderOptions): void {
    const { container, initialScope, activeNoteCount, vaultCount, inNoteLabel, allVaultLabel, onScopeChange, cleanups } =
        opts;

    container.empty();
    container.addClass('ai-organiser-scoped-file-picker-header');

    const groupId = `scoped-picker-${Math.random().toString(36).slice(2, 8)}`;

    const inNoteWrap = container.createDiv({ cls: 'ai-organiser-scoped-picker-radio-row' });
    const inNoteInput = inNoteWrap.createEl('input', {
        attr: {
            type: 'radio',
            name: groupId,
            id: `${groupId}-active`,
            value: 'active-note',
            'data-testid': 'scoped-picker-active-radio',
        },
    });
    inNoteInput.checked = initialScope === 'active-note';
    inNoteWrap.createEl('label', {
        text: `${inNoteLabel} (${activeNoteCount})`,
        attr: { for: `${groupId}-active` },
    });

    const allWrap = container.createDiv({ cls: 'ai-organiser-scoped-picker-radio-row' });
    const allInput = allWrap.createEl('input', {
        attr: {
            type: 'radio',
            name: groupId,
            id: `${groupId}-all`,
            value: 'all-vault',
            'data-testid': 'scoped-picker-all-radio',
        },
    });
    allInput.checked = initialScope === 'all-vault';
    allWrap.createEl('label', {
        text: `${allVaultLabel} (${vaultCount})`,
        attr: { for: `${groupId}-all` },
    });

    cleanups.push(
        listen(inNoteInput, 'change', () => {
            if (inNoteInput.checked) onScopeChange('active-note');
        }),
    );
    cleanups.push(
        listen(allInput, 'change', () => {
            if (allInput.checked) onScopeChange('all-vault');
        }),
    );
}
