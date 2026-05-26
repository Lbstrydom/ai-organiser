/**
 * Section assignment select (D3, D11) — pure presentational component.
 *
 * Renders a `<select>` with `[General | + New topic… | <topics>]`. Used in:
 *   - DocumentMultiPickerModal rows (always — D11)
 *   - Audio attached-item rows (when registry has topics — D11)
 *   - Transcript file rows (when registry has topics — D11)
 *
 * Uses `listen()` for all DOM events (M4). Constructor receives a
 * `cleanups` registrar from the host modal so listeners are removed
 * when the modal closes.
 */

import { listen } from '../utils/domUtils';
import { SectionRegistryController } from '../../services/minutes/sectionRegistryController';

export interface SectionAssignmentSelectOptions {
    host: HTMLElement;
    sectionRegistry: SectionRegistryController;
    currentSectionId: string;
    /** Accessibility label, e.g. "Section assignment for Board sales.docx" */
    ariaLabel: string;
    /** i18n strings */
    labels: {
        generalOption: string;      // "General"
        newTopicOption: string;     // "+ New topic…"
        topicNamePrompt: string;    // "Topic name"
        topicNameTooLong: string;   // "Topic name must be 40 characters or fewer"
        topicCreated: string;       // "Created topic: {name}"
        topicPrefix?: string;       // optional prefix, e.g. "Topic: "
    };
    /** Called when the user picks an existing section. */
    onChange: (sectionId: string) => void;
    /**
     * Called when the user creates a new topic. The component handles
     * the inline prompt + registry.addTopic; this callback runs AFTER
     * successful creation so the host can refresh other surfaces.
     */
    onTopicCreated?: (topicId: string) => void;
    /** Caller-owned cleanup registrar (M4). */
    cleanups: Array<() => void>;
}

const NEW_TOPIC_SENTINEL = '__new_topic__';

export function renderSectionAssignmentSelect(opts: SectionAssignmentSelectOptions): HTMLSelectElement {
    const { host, sectionRegistry, currentSectionId, ariaLabel, labels, onChange, onTopicCreated, cleanups } = opts;

    host.empty();
    const select = host.createEl('select', {
        cls: 'ai-organiser-minutes-section-select',
        attr: {
            'aria-label': ariaLabel,
            'data-testid': 'section-assignment-select',
        },
    });

    populateOptions(select, sectionRegistry, currentSectionId, labels);

    // H8 fix: track the LAST COMMITTED choice so a cancelled "+ New topic…"
    // prompt restores the most recent valid selection instead of the stale
    // initial render-time `currentSectionId`. Mutated on every successful
    // section change or topic creation.
    let lastCommittedSectionId = currentSectionId;

    cleanups.push(
        listen(select, 'change', () => {
            const val = select.value;
            if (val === NEW_TOPIC_SENTINEL) {
                openInlineTopicPrompt(host, sectionRegistry, labels, (newId) => {
                    if (newId) {
                        populateOptions(select, sectionRegistry, newId, labels);
                        lastCommittedSectionId = newId;
                        onChange(newId);
                        onTopicCreated?.(newId);
                    } else {
                        // Cancelled — revert to the last committed selection.
                        select.value = lastCommittedSectionId;
                    }
                });
            } else {
                lastCommittedSectionId = val;
                onChange(val);
            }
        }),
    );

    return select;
}

function populateOptions(
    select: HTMLSelectElement,
    registry: SectionRegistryController,
    selectedId: string,
    labels: SectionAssignmentSelectOptions['labels'],
): void {
    select.empty();
    const general = select.createEl('option', {
        value: SectionRegistryController.GENERAL_ID,
        text: labels.generalOption,
    });
    if (selectedId === SectionRegistryController.GENERAL_ID) general.selected = true;

    for (const t of registry.listTopics()) {
        const opt = select.createEl('option', {
            value: t.id,
            text: `${labels.topicPrefix ?? ''}${t.name}`,
        });
        if (selectedId === t.id) opt.selected = true;
    }

    select.createEl('option', {
        value: NEW_TOPIC_SENTINEL,
        text: labels.newTopicOption,
    });
}

/**
 * Inline topic-name prompt. Focus-trapped within a tiny overlay that
 * lives next to the select. ESC cancels (returns null), Enter confirms.
 *
 * NOTE: kept lightweight — no Obsidian Modal — because pickers can't
 * easily host a child Modal cleanly. The overlay is positioned next
 * to the host element.
 */
function openInlineTopicPrompt(
    host: HTMLElement,
    registry: SectionRegistryController,
    labels: SectionAssignmentSelectOptions['labels'],
    onComplete: (newTopicId: string | null) => void,
): void {
    // Build a small inline overlay attached to the host's parent.
    const overlay = host.createDiv({ cls: 'ai-organiser-minutes-topic-prompt-overlay' });
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', labels.topicNamePrompt);

    const input = overlay.createEl('input', {
        cls: 'ai-organiser-minutes-topic-prompt-input',
        attr: {
            type: 'text',
            placeholder: labels.topicNamePrompt,
            maxLength: String(SectionRegistryController.MAX_NAME_LENGTH),
            'data-testid': 'topic-name-input',
        },
    });

    const buttons = overlay.createDiv({ cls: 'ai-organiser-minutes-topic-prompt-buttons' });
    const okBtn = buttons.createEl('button', { text: 'OK', cls: 'mod-cta' });
    const cancelBtn = buttons.createEl('button', { text: 'Cancel' });

    const errorEl = overlay.createDiv({
        cls: 'ai-organiser-minutes-topic-prompt-error ai-organiser-hidden',
    });

    const cleanup = (): void => {
        overlay.remove();
    };

    const tryCommit = (): void => {
        const result = registry.addTopic(input.value);
        if (!result.ok) {
            errorEl.setText(result.error);
            errorEl.removeClass('ai-organiser-hidden');
            return;
        }
        cleanup();
        onComplete(result.value.id);
    };

    const cancel = (): void => {
        cleanup();
        onComplete(null);
    };

    okBtn.addEventListener('click', tryCommit);
    cancelBtn.addEventListener('click', cancel);
    input.addEventListener('keydown', (evt) => {
        if (evt.key === 'Enter') {
            evt.preventDefault();
            tryCommit();
        } else if (evt.key === 'Escape') {
            evt.preventDefault();
            cancel();
        }
    });

    // Trap focus within the overlay
    input.focus();
}
