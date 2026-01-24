/**
 * Truncation Controls
 * Reusable UI components for document truncation controls
 * 
 * Used by:
 * - MinutesCreationModal
 * - MultiSourceModal (when document support added)
 * 
 * Design Principles:
 * - No modal dependencies (pure UI functions)
 * - Consistent visual treatment across modals
 * - Callback-based interaction (inversion of control)
 */

import { setTooltip } from 'obsidian';
import { TruncationChoice } from '../../core/constants';
import { TruncationOption } from '../utils/truncation';

/** Shape of translation object for truncation controls */
export interface TruncationTranslations {
    truncateOption?: string;
    truncateTooltip?: string;
    useFullOption?: string;
    useFullTooltip?: string;
    skipOption?: string;
    skipTooltip?: string;
    oversizedDocuments?: string;
    applyToAll?: string;
}

/**
 * Create a truncation dropdown for a single document
 * 
 * @param containerEl - Parent element to attach dropdown to
 * @param currentChoice - Currently selected truncation choice
 * @param options - Truncation options with labels and tooltips
 * @param onChange - Callback when selection changes
 * @returns The created select element
 * 
 * Usage:
 * ```typescript
 * const select = createTruncationDropdown(
 *     container,
 *     doc.truncationChoice,
 *     getTruncationOptions(t),
 *     (choice) => {
 *         docController.setTruncationChoice(docId, choice);
 *         refreshUI();
 *     }
 * );
 * ```
 */
export function createTruncationDropdown(
    containerEl: HTMLElement,
    currentChoice: TruncationChoice,
    options: Record<TruncationChoice, TruncationOption>,
    onChange: (choice: TruncationChoice) => void
): HTMLSelectElement {
    const select = containerEl.createEl('select', { cls: 'ai-organiser-truncation-select' });
    select.setAttribute('aria-label', 'Document size handling');

    const choices: TruncationChoice[] = ['truncate', 'full', 'skip'];
    for (const choice of choices) {
        const opt = select.createEl('option', { value: choice });
        opt.textContent = options[choice].label;
        if (choice === currentChoice) {
            opt.selected = true;
        }
    }

    // Set initial tooltip
    const tooltipText = options[currentChoice].tooltip;
    if (tooltipText) {
        setTooltip(select, tooltipText);
    }

    // Handle changes
    select.addEventListener('change', () => {
        const newChoice = select.value as TruncationChoice;
        
        // Update tooltip
        const nextTooltip = options[newChoice].tooltip;
        if (nextTooltip) {
            setTooltip(select, nextTooltip);
        }
        
        // Notify parent
        onChange(newChoice);
    });

    return select;
}

/**
 * Create a warning element for oversized documents
 * Shows character count and truncation dropdown
 * 
 * @param containerEl - Parent element to attach warning to
 * @param charCount - Document character count
 * @param maxChars - Maximum allowed characters
 * @param currentChoice - Currently selected truncation choice
 * @param options - Truncation options with labels and tooltips
 * @param onChange - Callback when truncation choice changes
 * @param formatChars - Optional function to format character count (e.g., "50.0K")
 * @returns Object containing warning element, select element, and full warning element
 * 
 * Usage:
 * ```typescript
 * const { warningEl, select, fullWarningEl } = createTruncationWarning(
 *     statusEl,
 *     doc.charCount,
 *     maxChars,
 *     doc.truncationChoice,
 *     getTruncationOptions(t),
 *     (choice) => updateChoice(choice),
 *     (count) => `${(count / 1000).toFixed(1)}K`
 * );
 * ```
 */
export function createTruncationWarning(
    containerEl: HTMLElement,
    charCount: number,
    maxChars: number,
    currentChoice: TruncationChoice,
    options: Record<TruncationChoice, TruncationOption>,
    onChange: (choice: TruncationChoice) => void,
    fullWarningText?: string,
    formatChars?: (count: number) => string
): {
    warningEl: HTMLElement;
    select: HTMLSelectElement;
    fullWarningEl: HTMLElement;
} {
    const warningEl = containerEl.createDiv({ cls: 'ai-organiser-truncation-warning' });
    
    // Character count warning
    const formattedCount = formatChars ? formatChars(charCount) : String(charCount);
    warningEl.createSpan({
        text: `! ${formattedCount} chars`,
        cls: 'ai-organiser-truncation-size-warning'
    });
    
    // Truncation dropdown
    const select = createTruncationDropdown(warningEl, currentChoice, options, (choice) => {
        // Update full warning visibility
        fullWarningEl.style.display = choice === 'full' ? 'block' : 'none';
        onChange(choice);
    });
    
    // Full document warning (shown only when "Use Full" selected)
    const fullWarningEl = warningEl.createDiv({ cls: 'ai-organiser-truncation-full-warning' });
    fullWarningEl.setText(fullWarningText || 'Warning: may exceed token limits');
    fullWarningEl.style.display = currentChoice === 'full' ? 'block' : 'none';
    
    return { warningEl, select, fullWarningEl };
}

/**
 * Create bulk truncation controls for multiple oversized documents
 * Shows count and buttons to apply choice to all oversized documents
 * 
 * @param containerEl - Parent element to attach controls to
 * @param oversizedCount - Number of oversized documents
 * @param maxChars - Maximum allowed characters
 * @param options - Truncation options with labels and tooltips
 * @param onApplyAll - Callback when a bulk action is clicked
 * @param countMessage - Message template with {count} and {limit} placeholders
 * @param applyMessage - "Apply to all:" message
 * @returns The created bulk control element
 * 
 * Usage:
 * ```typescript
 * const bulkEl = createBulkTruncationControls(
 *     container,
 *     oversizedDocs.length,
 *     maxChars,
 *     getTruncationOptions(t),
 *     (choice) => {
 *         docController.applyTruncationToAll(choice);
 *         refreshUI();
 *     },
 *     t.oversizedDocuments,
 *     t.applyToAll
 * );
 * ```
 */
export function createBulkTruncationControls(
    containerEl: HTMLElement,
    oversizedCount: number,
    maxChars: number,
    options: Record<TruncationChoice, TruncationOption>,
    onApplyAll: (choice: TruncationChoice) => void,
    countMessage?: string,
    applyMessage?: string
): HTMLElement {
    containerEl.empty();
    
    if (oversizedCount === 0) {
        return containerEl;
    }
    
    // Default messages
    const defaultCountMsg = '{count} document(s) exceed {limit} chars';
    const defaultApplyMsg = 'Apply to all:';
    const countText = (countMessage || defaultCountMsg)
        .replace('{count}', String(oversizedCount))
        .replace('{limit}', String(maxChars));
    const applyText = applyMessage || defaultApplyMsg;
    
    // Render message
    if (oversizedCount > 1) {
        containerEl.createSpan({
            text: countText,
            cls: 'ai-organiser-truncation-bulk-warning'
        });
        containerEl.createSpan({ text: applyText });
    } else {
        containerEl.createSpan({
            text: `${countText} ${applyText}`
        });
    }
    
    // Render buttons
    const choices: TruncationChoice[] = ['truncate', 'full', 'skip'];
    for (const choice of choices) {
        const btn = containerEl.createEl('button', {
            text: options[choice].label,
            cls: choice === 'truncate' ? 'mod-cta' : ''
        });
        
        // Accessibility: aria-label from option label
        btn.setAttribute('aria-label', `Apply ${options[choice].label} to all documents`);
        
        // Optional tooltip
        if (options[choice].tooltip) {
            setTooltip(btn, options[choice].tooltip);
        }
        
        btn.addEventListener('click', () => {
            onApplyAll(choice);
        });
    }
    
    return containerEl;
}
