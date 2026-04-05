/* eslint-disable obsidianmd/ui/sentence-case -- Taxonomy setup UI contains action phrases and technical terms */
import { Setting, Notice, Modal, App, TFolder } from 'obsidian';
import { logger } from '../../utils/logger';
import { BaseSettingSection } from './BaseSettingSection';
import { getConfigFolderFullPath, getEffectiveOutputRoot } from '../../core/settings';
import { TaxonomySuggestionService, SuggestedDiscipline, SuggestedTheme, TaxonomyChange } from '../../services/taxonomySuggestionService';
import { withBusyIndicator } from '../../utils/busyIndicator';

/**
 * Existing item with potential suggested change
 */
interface ReviewItem {
    current: SuggestedDiscipline | null;  // null for new items
    suggested: SuggestedDiscipline | null;  // null for "keep as-is"
    action: 'keep' | 'modify' | 'add' | 'remove';
    selected: boolean;
}

/**
 * Modal for reviewing and improving existing themes/disciplines
 * Shows comparison table: current | suggested change | action
 */
class ReviewComparisonModal extends Modal {
    private readonly itemType: 'theme' | 'discipline';
    private readonly reviewItems: ReviewItem[];
    private readonly onConfirm: (items: ReviewItem[]) => void;
    private readonly onRefine: (context: string) => void;

    constructor(
        app: App,
        itemType: 'theme' | 'discipline',
        currentItems: (SuggestedDiscipline)[],
        suggestedChanges: TaxonomyChange[],
        onConfirm: (items: ReviewItem[]) => void,
        onRefine: (context: string) => void
    ) {
        super(app);
        this.itemType = itemType;
        this.onConfirm = onConfirm;
        this.onRefine = onRefine;

        // Build review items from current + changes
        this.reviewItems = this.buildReviewItems(currentItems, suggestedChanges);
    }

    private buildReviewItems(
        currentItems: (SuggestedDiscipline)[],
        changes: TaxonomyChange[]
    ): ReviewItem[] {
        const items: ReviewItem[] = [];
        const processedNames = new Set<string>();

        // Process changes first
        for (const change of changes) {
            if (change.action === 'add') {
                items.push({
                    current: null,
                    suggested: change.item,
                    action: 'add',
                    selected: true
                });
            } else if (change.action === 'modify' && change.originalName) {
                const current = currentItems.find(c =>
                    c.name.toLowerCase() === change.originalName!.toLowerCase()
                );
                if (current) {
                    processedNames.add(current.name.toLowerCase());
                    items.push({
                        current,
                        suggested: change.item,
                        action: 'modify',
                        selected: true
                    });
                }
            } else if (change.action === 'remove' && change.originalName) {
                const current = currentItems.find(c =>
                    c.name.toLowerCase() === change.originalName!.toLowerCase()
                );
                if (current) {
                    processedNames.add(current.name.toLowerCase());
                    items.push({
                        current,
                        suggested: null,
                        action: 'remove',
                        selected: false  // Don't auto-select removals
                    });
                }
            }
        }

        // Add remaining current items as "keep"
        for (const current of currentItems) {
            if (!processedNames.has(current.name.toLowerCase())) {
                items.push({
                    current,
                    suggested: null,
                    action: 'keep',
                    selected: true
                });
            }
        }

        // Sort: modifications first, then adds, then keeps, then removals
        const actionOrder = { modify: 0, add: 1, keep: 2, remove: 3 };
        items.sort((a, b) => actionOrder[a.action] - actionOrder[b.action]);

        return items;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('ai-organiser-review-modal');

        const typeLabel = this.itemType === 'theme' ? 'Themes' : 'Disciplines';
        contentEl.createEl('h2', { text: `Review ${typeLabel}` });

        const desc = contentEl.createEl('p', { cls: 'setting-item-description' });
        desc.appendText('AI analyzed your vault and suggests these changes. ');
        desc.createEl('strong', { text: 'Select' });
        desc.appendText(' the changes you want to apply.');

        // Summary badges
        const summaryEl = contentEl.createDiv({ cls: 'ai-organiser-review-summary' });

        const counts = {
            keep: this.reviewItems.filter(i => i.action === 'keep').length,
            modify: this.reviewItems.filter(i => i.action === 'modify').length,
            add: this.reviewItems.filter(i => i.action === 'add').length,
            remove: this.reviewItems.filter(i => i.action === 'remove').length
        };

        if (counts.keep > 0) this.createBadge(summaryEl, `${counts.keep} unchanged`, 'var(--text-muted)');
        if (counts.modify > 0) this.createBadge(summaryEl, `${counts.modify} modified`, 'var(--text-warning)');
        if (counts.add > 0) this.createBadge(summaryEl, `${counts.add} new`, 'var(--text-success)');
        if (counts.remove > 0) this.createBadge(summaryEl, `${counts.remove} suggested removal`, 'var(--text-error)');

        // Table container
        const tableContainer = contentEl.createDiv({ cls: 'ai-organiser-review-table-container' });

        const table = tableContainer.createEl('table', { cls: 'ai-organiser-review-table' });

        // Header
        const thead = table.createEl('thead');
        const headerRow = thead.createEl('tr');

        const headers = ['', 'Current', 'Suggested Change', 'Action'];
        headers.forEach(h => {
            headerRow.createEl('th', { text: h });
        });

        // Body
        const tbody = table.createEl('tbody');

        for (const item of this.reviewItems) {
            const row = tbody.createEl('tr');

            // Checkbox cell
            const checkCell = row.createEl('td', { cls: 'cell-narrow' });

            if (item.action !== 'keep') {
                const checkbox = checkCell.createEl('input', { type: 'checkbox' });
                checkbox.checked = item.selected;
                checkbox.addEventListener('change', () => {
                    item.selected = checkbox.checked;
                    this.updateRowStyle(row, item);
                });
            }

            // Current cell
            const currentCell = row.createEl('td');
            if (item.current) {
                currentCell.createEl('strong', { text: item.current.name });
                currentCell.createEl('br');
                currentCell.createEl('span', { text: item.current.description, cls: 'ai-organiser-text-muted ai-organiser-text-ui-smaller' });
            } else {
                currentCell.createEl('em', { text: '(new)' });
                currentCell.addClass('ai-organiser-text-muted');
            }

            // Suggested cell
            const suggestedCell = row.createEl('td');
            if (item.suggested) {
                if (item.action === 'modify' && item.current) {
                    // Show what changed
                    if (item.current.name !== item.suggested.name) {
                        const nameChange = suggestedCell.createEl('strong');
                        nameChange.createEl('s', { text: item.current.name, cls: 'ai-organiser-text-muted' });
                        nameChange.appendText(` → ${item.suggested.name}`);
                    } else {
                        suggestedCell.createEl('strong', { text: item.suggested.name });
                    }
                } else {
                    suggestedCell.createEl('strong', { text: item.suggested.name });
                }
                suggestedCell.createEl('br');
                suggestedCell.createEl('span', { text: item.suggested.description, cls: 'ai-organiser-text-muted ai-organiser-text-ui-smaller' });
            } else if (item.action === 'remove') {
                suggestedCell.createEl('em', { text: '(remove)' });
                suggestedCell.addClass('ai-organiser-text-error');
            } else {
                suggestedCell.createEl('em', { text: '—' });
                suggestedCell.addClass('ai-organiser-text-muted');
            }

            // Action cell
            const actionCell = row.createEl('td', { cls: 'cell-action' });

            const actionBadge = actionCell.createEl('span', { cls: 'ai-organiser-action-badge' });

            switch (item.action) {
                case 'keep':
                    actionBadge.textContent = 'Keep';
                    actionBadge.addClass('badge-keep');
                    break;
                case 'modify':
                    actionBadge.textContent = 'Modify';
                    actionBadge.addClass('badge-modify');
                    break;
                case 'add':
                    actionBadge.textContent = 'Add';
                    actionBadge.addClass('badge-add');
                    break;
                case 'remove':
                    actionBadge.textContent = 'Remove';
                    actionBadge.addClass('badge-remove');
                    break;
            }

            this.updateRowStyle(row, item);
        }

        // Refine section
        const refineSection = contentEl.createDiv({ cls: 'ai-organiser-refine-section' });

        refineSection.createEl('strong', { text: 'Need different suggestions?' });
        const refineDesc = refineSection.createEl('p', { cls: 'setting-item-description' });
        refineDesc.addClass('ai-organiser-refine-desc');
        refineDesc.textContent = 'Describe what you want to change:';

        const refineInput = refineSection.createEl('textarea', {
            placeholder: 'e.g., "Add more focus on technology" or "Remove business-related themes"',
            cls: 'ai-organiser-refine-textarea'
        });

        const refineBtnContainer = refineSection.createDiv({ cls: 'ai-organiser-mt-8' });
        const refineBtn = refineBtnContainer.createEl('button', { text: 'Regenerate Suggestions' });
        refineBtn.addEventListener('click', () => {
            const context = refineInput.value.trim();
            if (context) {
                this.onRefine(context);
                this.close();
            }
        });

        // Main buttons
        const buttonContainer = contentEl.createDiv({ cls: 'ai-organiser-button-row' });

        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());

        const applyBtn = buttonContainer.createEl('button', { text: 'Apply Selected Changes', cls: 'mod-cta' });
        applyBtn.addEventListener('click', () => {
            this.onConfirm(this.reviewItems);
            this.close();
        });
    }

    private createBadge(container: HTMLElement, text: string, color: string): void {
        const badge = container.createEl('span', { text, cls: 'ai-organiser-review-badge' });
        badge.setCssProps({ '--badge-color': color });
    }

    private updateRowStyle(row: HTMLElement, item: ReviewItem): void {
        row.removeClass('ai-organiser-row-keep', 'ai-organiser-row-deselected', 'ai-organiser-row-selected');
        if (item.action === 'keep') {
            row.addClass('ai-organiser-row-keep');
        } else if (!item.selected) {
            row.addClass('ai-organiser-row-deselected');
        } else {
            row.addClass('ai-organiser-row-selected');
        }
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

/**
 * Modal to choose between fresh analysis vs review existing
 * Shows when items already exist
 */
class ReviewOrFreshModal extends Modal {
    private readonly itemType: 'theme' | 'discipline';
    private readonly existingCount: number;
    private readonly onChoice: (choice: 'review' | 'fresh') => void;

    constructor(
        app: App,
        itemType: 'theme' | 'discipline',
        existingCount: number,
        onChoice: (choice: 'review' | 'fresh') => void
    ) {
        super(app);
        this.itemType = itemType;
        this.existingCount = existingCount;
        this.onChoice = onChoice;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('ai-organiser-modal-narrow-480');

        const typeLabel = this.itemType === 'theme' ? 'Themes' : 'Disciplines';
        contentEl.createEl('h2', { text: `${typeLabel} Already Configured` });

        const desc = contentEl.createEl('p', { cls: 'setting-item-description' });
        desc.textContent = `You have ${this.existingCount} ${this.itemType}${this.existingCount > 1 ? 's' : ''} configured. What would you like to do?`;

        const optionsEl = contentEl.createDiv({ cls: 'ai-organiser-choice-options' });

        // Option 1: Review & Improve (recommended)
        const reviewBtn = optionsEl.createEl('button', { cls: 'mod-cta' });
        reviewBtn.addClass('ai-organiser-choice-btn');

        const reviewTitle = reviewBtn.createEl('div', { text: 'Review & Improve (Recommended)' });
        reviewTitle.addClass('ai-organiser-choice-title');

        const reviewDesc = reviewBtn.createEl('div', {
            text: 'AI will suggest additions and refinements to your existing list'
        });
        reviewDesc.addClass('ai-organiser-choice-desc');

        reviewBtn.addEventListener('click', () => {
            this.onChoice('review');
            this.close();
        });

        // Option 2: Start Fresh
        const freshBtn = optionsEl.createEl('button');
        freshBtn.addClass('ai-organiser-choice-btn-full');

        const freshTitle = freshBtn.createEl('div', { text: 'Start Fresh' });
        freshTitle.addClass('ai-organiser-choice-title-block');

        const freshDesc = freshBtn.createEl('div', {
            text: 'Replace all existing with new AI-generated suggestions'
        });
        freshDesc.addClass('ai-organiser-choice-desc-block');

        freshBtn.addEventListener('click', () => {
            this.onChoice('fresh');
            this.close();
        });

        // Cancel
        const cancelContainer = contentEl.createDiv({ cls: 'ai-organiser-cancel-right' });
        const cancelBtn = cancelContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

/**
 * Modal to choose how AI should analyze - user context or vault search
 */
class ReviewContextModal extends Modal {
    private readonly itemType: 'theme' | 'discipline';
    private readonly onChoice: (choice: 'context' | 'vault', userContext?: string) => void;

    constructor(
        app: App,
        itemType: 'theme' | 'discipline',
        onChoice: (choice: 'context' | 'vault', userContext?: string) => void
    ) {
        super(app);
        this.itemType = itemType;
        this.onChoice = onChoice;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('ai-organiser-modal-narrow-480');

        const typeLabel = this.itemType === 'theme' ? 'themes' : 'disciplines';
        contentEl.createEl('h2', { text: 'How should AI suggest improvements?' });

        const optionsEl = contentEl.createDiv({ cls: 'ai-organiser-choice-options' });

        // Option 1: Analyze vault
        const vaultBtn = optionsEl.createEl('button', { cls: 'mod-cta' });
        vaultBtn.addClass('ai-organiser-choice-btn');

        const vaultTitle = vaultBtn.createEl('div', { text: 'Analyze my vault (Recommended)' });
        vaultTitle.addClass('ai-organiser-choice-title');

        const vaultDesc = vaultBtn.createEl('div', {
            text: 'AI scans your folder structure and note titles to suggest improvements'
        });
        vaultDesc.addClass('ai-organiser-choice-desc');

        vaultBtn.addEventListener('click', () => {
            this.onChoice('vault');
            this.close();
        });

        // Option 2: Provide context
        const contextBtn = optionsEl.createEl('button');
        contextBtn.addClass('ai-organiser-choice-btn-full');

        const contextTitle = contextBtn.createEl('div', { text: 'I\'ll describe what I need' });
        contextTitle.addClass('ai-organiser-choice-title-block');

        const contextDesc = contextBtn.createEl('div', {
            text: `Tell the AI what ${typeLabel} you want to add or change`
        });
        contextDesc.addClass('ai-organiser-choice-desc-block');

        contextBtn.addEventListener('click', () => {
            this.close();
            this.showContextInput();
        });

        // Cancel
        const cancelContainer = contentEl.createDiv({ cls: 'ai-organiser-cancel-right-16' });
        const cancelBtn = cancelContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());
    }

    private showContextInput(): void {
        const modal = new UserContextModal(this.app, (context) => {
            this.onChoice('context', context);
        });
        modal.open();
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

/**
 * Modal to choose analysis approach - AI first or user context first
 */
class AnalysisChoiceModal extends Modal {
    private readonly onChoice: (choice: 'ai-first' | 'context-first') => void;

    constructor(app: App, onChoice: (choice: 'ai-first' | 'context-first') => void) {
        super(app);
        this.onChoice = onChoice;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('ai-organiser-modal-narrow-450');

        contentEl.createEl('h2', { text: 'How would you like to start?' });
        contentEl.createEl('p', {
            text: 'Choose how you want to generate suggestions:',
            cls: 'setting-item-description'
        });

        // Options container
        const optionsEl = contentEl.createDiv({ cls: 'ai-organiser-choice-options' });

        // Option 1: AI analyzes first
        const aiFirstBtn = optionsEl.createEl('button', { cls: 'mod-cta' });
        aiFirstBtn.addClass('ai-organiser-choice-btn');

        const aiFirstTitle = aiFirstBtn.createEl('div', { text: 'Let AI analyze first' });
        aiFirstTitle.addClass('ai-organiser-choice-title');

        const aiFirstDesc = aiFirstBtn.createEl('div', {
            text: 'AI analyzes your vault structure and note titles, then you can refine'
        });
        aiFirstDesc.addClass('ai-organiser-choice-desc');

        aiFirstBtn.addEventListener('click', () => {
            this.onChoice('ai-first');
            this.close();
        });

        // Option 2: Provide context first
        const contextFirstBtn = optionsEl.createEl('button');
        contextFirstBtn.addClass('ai-organiser-choice-btn');

        const contextFirstTitle = contextFirstBtn.createEl('div', { text: 'Describe my focus areas first' });
        contextFirstTitle.addClass('ai-organiser-choice-title');

        const contextFirstDesc = contextFirstBtn.createEl('div', {
            text: 'Tell the AI about your profession and interests before analysis'
        });
        contextFirstDesc.addClass('ai-organiser-choice-desc-dim');

        contextFirstBtn.addEventListener('click', () => {
            this.onChoice('context-first');
            this.close();
        });

        // Cancel button
        const cancelContainer = contentEl.createDiv({ cls: 'ai-organiser-cancel-right' });
        const cancelBtn = cancelContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

/**
 * Modal to collect user context before analyzing vault
 */
class UserContextModal extends Modal {
    private readonly onSubmit: (context: string) => void;
    private userContext: string = '';

    constructor(app: App, onSubmit: (context: string) => void) {
        super(app);
        this.onSubmit = onSubmit;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Describe Your Focus Areas' });
        contentEl.createEl('p', {
            text: 'Help the AI understand your needs by describing your profession, interests, or focus areas.',
            cls: 'setting-item-description'
        });

        // Text area for user context
        const textArea = contentEl.createEl('textarea', {
            placeholder: 'e.g., "I\'m a product manager focused on AI tools and SaaS products. I\'m interested in machine learning, user research, and business strategy."'
        });
        textArea.addClass('ai-organiser-user-context-textarea');
        textArea.addEventListener('input', (e) => {
            this.userContext = (e.target as HTMLTextAreaElement).value;
        });

        // Info text
        const infoEl = contentEl.createEl('p', {
            cls: 'setting-item-description'
        });
        infoEl.addClass('ai-organiser-info-text-subtle');
        infoEl.createEl('strong', { text: 'Note:' });
        infoEl.appendText(' The AI will also analyze your folder structure and sample note titles.');

        // Buttons
        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
        buttonContainer.addClass('ai-organiser-flex-end', 'ai-organiser-gap-8');

        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());

        const analyzeBtn = buttonContainer.createEl('button', { text: 'Analyze Vault', cls: 'mod-cta' });
        analyzeBtn.addEventListener('click', () => {
            this.onSubmit(this.userContext);
            this.close();
        });

        // Focus the text area
        textArea.focus();
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

/**
 * Editable discipline with user modifications
 */
interface EditableDiscipline extends SuggestedDiscipline {
    selected: boolean;
    userComment?: string;  // Additional context for refinement
}

/**
 * Refine options for regeneration
 */
interface RefineOptions {
    mode: 'replace' | 'add';  // Replace all or add to current
    context: string;
    currentDisciplines: EditableDiscipline[];  // Pass current state for "add" mode
}

/**
 * Modal to display and confirm suggested disciplines
 */
class DisciplineSuggestionModal extends Modal {
    private readonly editableDisciplines: EditableDiscipline[];
    private readonly onConfirm: (disciplines: SuggestedDiscipline[]) => void;
    private readonly onRefine: (options: RefineOptions) => void;
    private listEl: HTMLElement | null = null;

    constructor(
        app: App,
        disciplines: SuggestedDiscipline[],
        onConfirm: (disciplines: SuggestedDiscipline[]) => void,
        onRefine: (options: RefineOptions) => void
    ) {
        super(app);
        // Convert to editable disciplines
        this.editableDisciplines = disciplines.map(d => ({
            ...d,
            selected: true,
            userComment: ''
        }));
        this.onConfirm = onConfirm;
        this.onRefine = onRefine;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.setCssProps({ '--modal-width': '600px' });
        contentEl.addClass('ai-organiser-modal-medium');

        contentEl.createEl('h2', { text: 'Suggested Disciplines' });
        contentEl.createEl('p', {
            text: 'Review and edit the suggested disciplines. Click on a name to edit it, or add comments for context.',
            cls: 'setting-item-description'
        });

        // Create discipline list
        this.listEl = contentEl.createDiv({ cls: 'discipline-suggestion-list' });
        this.listEl.addClass('ai-organiser-suggestion-list');

        this.renderDisciplineList();

        // Refine section
        const refineSection = contentEl.createDiv({ cls: 'ai-organiser-refine-section' });

        refineSection.createEl('strong', { text: 'Refine suggestions' });
        const refineDesc = refineSection.createEl('p', {
            cls: 'setting-item-description'
        });
        refineDesc.addClass('ai-organiser-refine-desc');
        refineDesc.textContent = 'Describe what you want to change, add, or focus on:';

        const refineTextArea = refineSection.createEl('textarea', {
            placeholder: 'Examples:\n• "Add disciplines for personal finance and family organization"\n• "I need more focus on machine learning and data engineering"\n• "Remove business-related disciplines, focus on creative writing"'
        });
        refineTextArea.addClass('ai-organiser-refine-textarea-tall');

        // Refine mode selection
        const modeContainer = refineSection.createDiv({ cls: 'ai-organiser-refine-mode' });

        const modeLabel = modeContainer.createEl('span', { text: 'When regenerating:' });
        modeLabel.addClass('ai-organiser-font-semibold');

        let selectedMode: 'add' | 'replace' = 'add';

        const addModeLabel = modeContainer.createEl('label');
        addModeLabel.addClass('ai-organiser-flex-center', 'ai-organiser-gap-4');
        addModeLabel.addClass('ai-organiser-cursor-pointer');
        const addModeRadio = addModeLabel.createEl('input', { type: 'radio' });
        addModeRadio.name = 'refine-mode';
        addModeRadio.checked = true;
        addModeRadio.addEventListener('change', () => { selectedMode = 'add'; });
        addModeLabel.createEl('span', { text: 'Add to current list' });

        const replaceModeLabel = modeContainer.createEl('label');
        replaceModeLabel.addClass('ai-organiser-flex-center', 'ai-organiser-gap-4');
        replaceModeLabel.addClass('ai-organiser-cursor-pointer');
        const replaceModeRadio = replaceModeLabel.createEl('input', { type: 'radio' });
        replaceModeRadio.name = 'refine-mode';
        replaceModeRadio.addEventListener('change', () => { selectedMode = 'replace'; });
        replaceModeLabel.createEl('span', { text: 'Replace all' });

        // Refine button
        const refineBtnContainer = refineSection.createDiv();
        refineBtnContainer.addClass('ai-organiser-mt-12');
        const refineBtn = refineBtnContainer.createEl('button', { text: 'Regenerate with AI' });
        refineBtn.addEventListener('click', () => {
            const additionalContext = refineTextArea.value.trim();
            if (!additionalContext) {
                refineTextArea.focus();
                return;
            }

            // Include any user comments on disciplines as context
            const disciplineComments = this.editableDisciplines
                .filter(d => d.userComment?.trim())
                .map(d => `${d.name}: ${d.userComment}`)
                .join('\n');

            let fullContext = additionalContext;
            if (disciplineComments) {
                fullContext += `\n\nUser notes on current disciplines:\n${disciplineComments}`;
            }

            this.onRefine({
                mode: selectedMode,
                context: fullContext,
                currentDisciplines: this.editableDisciplines.filter(d => d.selected)
            });
            this.close();
        });

        // Main buttons
        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
        buttonContainer.addClass('ai-organiser-flex-between');
        buttonContainer.addClass('ai-organiser-mt-8');

        // Left side - selected count
        const selectedCount = buttonContainer.createEl('span', { cls: 'setting-item-description' });
        const updateCount = () => {
            const count = this.editableDisciplines.filter(d => d.selected).length;
            selectedCount.textContent = `${count} of ${this.editableDisciplines.length} selected`;
        };
        updateCount();

        // Right side - buttons
        const btnGroup = buttonContainer.createDiv();
        btnGroup.addClass('ai-organiser-flex-row', 'ai-organiser-gap-8');

        const cancelBtn = btnGroup.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());

        const confirmBtn = btnGroup.createEl('button', { text: 'Update Taxonomy', cls: 'mod-cta' });
        confirmBtn.addEventListener('click', () => {
            const selected = this.editableDisciplines
                .filter(d => d.selected)
                .map(({ selected: _, userComment: __, ...d }) => d);
            this.onConfirm(selected);
            this.close();
        });

        // Store updateCount for use in renderDisciplineList
        (this as unknown as { updateCount?: () => void }).updateCount = updateCount;
    }

    private renderDisciplineList(): void {
        if (!this.listEl) return;
        this.listEl.empty();

        this.editableDisciplines.forEach((discipline, _index) => {
            const itemEl = this.listEl!.createDiv({ cls: 'discipline-item' });
            itemEl.setCssProps({ '--pad': '10px 12px' }); itemEl.addClass('ai-organiser-pad-custom');
            itemEl.addClass('ai-organiser-border-b');
            if (!discipline.selected) {
                itemEl.addClass('ai-organiser-opacity-50');
            }

            // Top row: checkbox + name (editable)
            const topRow = itemEl.createDiv();
            topRow.addClass('ai-organiser-flex-center', 'ai-organiser-gap-8');
            topRow.addClass('ai-organiser-mb-4');

            const checkbox = topRow.createEl('input', { type: 'checkbox' });
            checkbox.checked = discipline.selected;
            checkbox.addClass('ai-organiser-flex-shrink-0');
            checkbox.addEventListener('change', () => {
                discipline.selected = checkbox.checked;
                itemEl.toggleClass('ai-organiser-opacity-50', !discipline.selected);
                const self = this as unknown as { updateCount?: () => void };
                if (self.updateCount) self.updateCount();
            });

            // Editable name input
            const nameInput = topRow.createEl('input', { type: 'text', value: discipline.name });
            nameInput.addClass('ai-organiser-flex-1');
            nameInput.addClass('ai-organiser-font-bold');
            /* border:transparent handled by focus/blur classes */
            nameInput.addClass('ai-organiser-rounded');
            nameInput.setCssProps({ '--pad': '2px 6px' }); nameInput.addClass('ai-organiser-pad-custom');
            nameInput.addClass('ai-organiser-bg-transparent');
            nameInput.addEventListener('focus', () => {
                nameInput.setCssProps({ '--border': '1px solid var(--interactive-accent)' }); nameInput.addClass('ai-organiser-border-custom');
                nameInput.addClass('ai-organiser-bg-primary');
            });
            nameInput.addEventListener('blur', () => {
                /* border:transparent handled by focus/blur classes */
                nameInput.addClass('ai-organiser-bg-transparent');
                // Sanitize name to kebab-case
                discipline.name = nameInput.value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
                nameInput.value = discipline.name;
            });
            nameInput.addEventListener('change', () => {
                discipline.name = nameInput.value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
                nameInput.value = discipline.name;
            });

            // Description
            const descEl = itemEl.createEl('p', {
                text: discipline.description,
                cls: 'setting-item-description'
            });
            descEl.setCssProps({ '--margin': '2px 0 2px 24px' }); descEl.addClass('ai-organiser-margin-custom');
            descEl.addClass('ai-organiser-text-ui-smaller');

            // Use when
            const useWhenEl = itemEl.createEl('p', {
                text: `Use when: ${discipline.useWhen}`,
                cls: 'setting-item-description'
            });
            useWhenEl.setCssProps({ '--margin': '0 0 0 24px' }); useWhenEl.addClass('ai-organiser-margin-custom');
            useWhenEl.addClass('ai-organiser-text-ui-smaller');
            useWhenEl.addClass('ai-organiser-text-muted');

            // Expandable comment section
            const commentContainer = itemEl.createDiv();
            commentContainer.setCssProps({ '--ml': '24px' }); commentContainer.addClass('ai-organiser-ml-custom');
            commentContainer.addClass('ai-organiser-mt-8');

            const commentToggle = commentContainer.createEl('button', {
                text: discipline.userComment ? '✏️ Edit note' : '+ Add note for AI'
            });
            commentToggle.addClass('ai-organiser-text-ui-smaller');
            commentToggle.setCssProps({ '--pad': '2px 8px' }); commentToggle.addClass('ai-organiser-pad-custom');
            commentToggle.addClass('ai-organiser-bg-transparent');
            commentToggle.addClass('ai-organiser-border');
            commentToggle.addClass('ai-organiser-rounded');
            commentToggle.addClass('ai-organiser-cursor-pointer');

            const commentInput = commentContainer.createEl('textarea', {
                placeholder: 'Add context for AI refinement (e.g., "needs to be more specific" or "combine with data-science")'
            });
            commentInput.value = discipline.userComment || '';
            commentInput.toggleClass('ai-organiser-hidden', !discipline.userComment);
            commentInput.addClass('ai-organiser-w-full');
            commentInput.addClass('ai-organiser-min-h-60');
            commentInput.addClass('ai-organiser-mt-4');
            commentInput.setCssProps({ '--pad': '6px' }); commentInput.addClass('ai-organiser-pad-custom');
            commentInput.addClass('ai-organiser-text-ui-smaller');
            commentInput.addClass('ai-organiser-resize-vertical');
            commentInput.addEventListener('input', () => {
                discipline.userComment = commentInput.value;
                commentToggle.textContent = commentInput.value ? '✏️ Edit note' : '+ Add note for AI';
            });

            commentToggle.addEventListener('click', () => {
                const isVisible = !commentInput.hasClass('ai-organiser-hidden');
                commentInput.toggleClass('ai-organiser-hidden', isVisible);
                if (!isVisible) {
                    commentInput.focus();
                }
            });
        });
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

export class ConfigurationSettingsSection extends BaseSettingSection {
    display(): void {
        const { containerEl } = this;
        const t = this.plugin.t;

        this.createSectionHeader(t.settings.configuration.title, 'settings');

        // Output root folder — dropdown with existing vault folders + custom path
        const outputFolderSetting = new Setting(containerEl)
            .setName(t.settings.configuration.outputRootFolder)
            .setDesc(t.settings.configuration.outputRootFolderDesc);

        const currentOutputRoot = getEffectiveOutputRoot(this.plugin.settings);
        const outputFolders = this.getVaultFolders();
        const pluginFolder = this.plugin.settings.pluginFolder || 'AI-Organiser';
        const hasCustomOutputRoot = this.plugin.settings.outputRootFolder &&
            !outputFolders.includes(currentOutputRoot);

        outputFolderSetting.addDropdown(dropdown => {
            // Default option (same as plugin folder)
            dropdown.addOption('', `${pluginFolder} (default)`);

            for (const folder of outputFolders) {
                if (folder !== pluginFolder) {
                    dropdown.addOption(folder, folder);
                }
            }
            dropdown.addOption('__custom__', '— Custom path —');

            dropdown.setValue(hasCustomOutputRoot ? '__custom__' : (this.plugin.settings.outputRootFolder || ''));

            dropdown.onChange(value => {
                if (value === '__custom__') {
                    this.settingTab.display();
                } else {
                    this.plugin.settings.outputRootFolder = value;
                    void this.plugin.saveSettings();
                }
            });
        });

        if (hasCustomOutputRoot) {
            outputFolderSetting.addText(text => text
                .setPlaceholder(pluginFolder)
                .setValue(this.plugin.settings.outputRootFolder)
                .onChange(value => {
                    let sanitized = (value || '').trim().replaceAll('\\', '/');
                    while (sanitized.startsWith('/')) sanitized = sanitized.slice(1);
                    while (sanitized.endsWith('/')) sanitized = sanitized.slice(0, -1);
                    this.plugin.settings.outputRootFolder = sanitized;
                    void this.plugin.saveSettings();
                }));
        }

        // Config folder path
        new Setting(containerEl)
            .setName(t.settings.configuration.configFolder)
            .setDesc(t.settings.configuration.configFolderDesc)
            .addText(text => text
                .setPlaceholder('Config')
                .setValue(this.plugin.settings.configFolderPath)
                .onChange((value) => {
                    const pluginPrefix = `${this.plugin.settings.pluginFolder}/`;
                    const sanitized = (value || 'Config').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
                    const normalizedSubfolder = sanitized.startsWith(pluginPrefix)
                        ? sanitized.slice(pluginPrefix.length)
                        : sanitized || 'Config';

                    this.plugin.settings.configFolderPath = normalizedSubfolder || 'Config';
                    this.plugin.configService.setConfigFolder(getConfigFolderFullPath(this.plugin.settings));
                    void this.plugin.saveSettings();
                })
            );

        // Buttons row
        const buttonsContainer = containerEl.createDiv({ cls: 'config-buttons-container' });
        buttonsContainer.addClass('ai-organiser-flex');
        buttonsContainer.addClass('ai-organiser-flex-wrap');
        buttonsContainer.addClass('ai-organiser-gap-8');
        buttonsContainer.addClass('ai-organiser-mt-8');
        buttonsContainer.addClass('ai-organiser-mb-16');

        // Open config folder button
            const openBtn = buttonsContainer.createEl('button', {
                text: t.settings.configuration.openConfigFolder
            });
        openBtn.addEventListener('click', () => { void (async () => {
                const folderPath = getConfigFolderFullPath(this.plugin.settings);
                const folder = this.plugin.app.vault.getAbstractFileByPath(folderPath);

            if (folder) {
                // Open the folder in file explorer
                const leaf = this.plugin.app.workspace.getLeaf(false);
                if (leaf) {
                    // Navigate to folder by opening taxonomy.md if it exists
                        const taxonomyFile = this.plugin.app.vault.getAbstractFileByPath(`${folderPath}/taxonomy.md`);
                    if (taxonomyFile) {
                        await leaf.openFile(taxonomyFile as import('obsidian').TFile);
                    }
                }
            } else {
                    new Notice(`Folder not found: ${folderPath}`);
            }
        })(); });

        // Create config files button
            const createBtn = buttonsContainer.createEl('button', {
                text: t.settings.configuration.createConfigFiles
            });
        createBtn.addEventListener('click', () => { void (async () => {
            await this.plugin.configService.createDefaultConfigFiles();
                const configFolder = getConfigFolderFullPath(this.plugin.settings);
                new Notice(`${t.settings.configuration.configFilesCreated} ${configFolder}`);
        })(); });

        // Suggest themes from vault button
        const suggestThemesBtn = buttonsContainer.createEl('button', {
            text: t.settings.configuration.suggestThemes || 'Suggest Themes'
        });
        suggestThemesBtn.addClass('ai-organiser-bg-accent');
        suggestThemesBtn.addClass('ai-organiser-text-on-accent');
        suggestThemesBtn.addEventListener('click', () => { void this.suggestThemesFromVault(suggestThemesBtn); });

        // Suggest disciplines from vault button
        const suggestBtn = buttonsContainer.createEl('button', {
            text: t.settings.configuration.suggestDisciplines || 'Suggest Disciplines'
        });
        suggestBtn.addClass('ai-organiser-bg-accent');
        suggestBtn.addClass('ai-organiser-text-on-accent');
        suggestBtn.addEventListener('click', () => { void this.suggestDisciplinesFromVault(suggestBtn); });

        // Reset to defaults button
        const resetBtn = buttonsContainer.createEl('button', {
            text: t.settings.configuration.resetToDefaults
        });
        resetBtn.addClass('ai-organiser-text-error');
        resetBtn.addEventListener('click', () => { void (async () => {
            if (await this.plugin.showConfirmationDialog(t.settings.configuration.resetConfirm)) {
                // Delete existing files and recreate
                const paths = this.plugin.configService.getConfigPaths();
                for (const path of Object.values(paths)) {
                    const file = this.plugin.app.vault.getAbstractFileByPath(path);
                    if (file) {
                        await this.plugin.app.fileManager.trashFile(file);
                    }
                }
                await this.plugin.configService.createDefaultConfigFiles();
                this.plugin.configService.invalidateCache();
                new Notice(`${t.settings.configuration.configFilesCreated} ${this.plugin.settings.configFolderPath}`);
            }
        })(); });

        // Info about config files
        const infoEl = containerEl.createDiv({ cls: 'config-info' });
        infoEl.addClass('ai-organiser-mt-12');
        infoEl.addClass('ai-organiser-p-12');
        infoEl.addClass('ai-organiser-bg-secondary');
        infoEl.addClass('ai-organiser-rounded');
        infoEl.addClass('ai-organiser-text-ui-small');
        infoEl.addClass('ai-organiser-text-muted');

        infoEl.createEl('strong', { text: 'Configuration Files:' });
        const ul = infoEl.createEl('ul', { cls: 'ai-organiser-config-files-list' });
        const items = [
            ['taxonomy.md', 'Themes and disciplines with descriptions'],
            ['summary-prompt.md', 'Custom summary instructions'],
            ['excluded-tags.md', 'Tags to never suggest'],
        ];
        for (const [code, desc] of items) {
            const li = ul.createEl('li');
            li.createEl('code', { text: code });
            li.appendText(` - ${desc}`);
        }
        const editP = infoEl.createEl('p');
        editP.appendText('Edit these files to customize how AI tags your notes.');
        const tipP = infoEl.createEl('p');
        tipP.createEl('strong', { text: 'Tip:' });
        tipP.appendText(' Click "Suggest Disciplines from Vault" to let AI analyze your folder structure and suggest meaningful disciplines based on your content.');
    }

    // Store accumulated user context for refinement
    private accumulatedContext: string = '';
    private accumulatedThemeContext: string = '';

    /**
     * Use AI to suggest themes based on vault folder structure
     * Adaptive: checks if themes already exist and offers review mode
     */
    private async suggestThemesFromVault(button: HTMLButtonElement): Promise<void> {
        this.accumulatedThemeContext = '';

        // Check for existing themes
        const config = await this.plugin.configService.loadConfig();
        const existingThemes: SuggestedTheme[] = config.taxonomy.themes.map(t => ({
            name: t.name,
            description: t.description,
            useWhen: t.useWhen
        }));

        if (existingThemes.length > 0) {
            // Show review vs fresh choice
            const reviewModal = new ReviewOrFreshModal(
                this.plugin.app,
                'theme',
                existingThemes.length,
                (choice: 'review' | 'fresh') => {
                    if (choice === 'review') {
                        // Show context choice for review
                        const contextModal = new ReviewContextModal(
                            this.plugin.app,
                            'theme',
                            (contextChoice, userContext) => { void (async () => {
                                if (contextChoice === 'vault') {
                                    await this.runThemeReview(button, existingThemes);
                                } else {
                                    this.accumulatedThemeContext = userContext || '';
                                    await this.runThemeReview(button, existingThemes, userContext);
                                }
                            })(); }
                        );
                        contextModal.open();
                    } else {
                        // Fresh analysis - show original choice modal
                        this.showFreshThemeAnalysisChoice(button);
                    }
                }
            );
            reviewModal.open();
        } else {
            // No existing themes - show original flow
            this.showFreshThemeAnalysisChoice(button);
        }
    }

    /**
     * Show the original fresh theme analysis choice modal
     */
    private showFreshThemeAnalysisChoice(button: HTMLButtonElement): void {
        const choiceModal = new AnalysisChoiceModal(
            this.plugin.app,
            (choice: 'ai-first' | 'context-first') => { void (async () => {
                if (choice === 'ai-first') {
                    await this.runThemeAnalysis(button, '');
                } else {
                    const contextModal = new UserContextModal(
                        this.plugin.app,
                        (userContext: string) => { void (async () => {
                            this.accumulatedThemeContext = userContext;
                            await this.runThemeAnalysis(button, userContext);
                        })(); }
                    );
                    contextModal.open();
                }
            })(); }
        );
        choiceModal.open();
    }

    /**
     * Run theme review with comparison table
     */
    private async runThemeReview(
        button: HTMLButtonElement,
        existingThemes: SuggestedTheme[],
        userContext?: string
    ): Promise<void> {
        const originalText = button.textContent || '';

        try {
            button.textContent = 'Reviewing themes...';
            button.disabled = true;

            const suggestionService = new TaxonomySuggestionService(
                this.plugin.app,
                this.plugin.llmService
            );

            new Notice('Analyzing vault and reviewing themes...');

            const changes = await withBusyIndicator(this.plugin, () => suggestionService.reviewThemes(existingThemes, userContext));

            if (changes.length === 0) {
                new Notice('AI found no improvements to suggest. Your themes look good!');
                return;
            }

            // Show comparison modal
            this.showThemeReviewModal(button, existingThemes, changes, userContext);

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            new Notice(`Failed to review themes: ${errorMsg}`);
            logger.error('Settings', 'Theme review error:', error);
        } finally {
            button.textContent = originalText;
            button.disabled = false;
        }
    }

    /**
     * Show the theme review comparison modal
     */
    private showThemeReviewModal(
        button: HTMLButtonElement,
        existingThemes: SuggestedTheme[],
        changes: TaxonomyChange[],
        userContext?: string
    ): void {
        const modal = new ReviewComparisonModal(
            this.plugin.app,
            'theme',
            existingThemes,
            changes,
            (reviewItems) => { void this.applyThemeChanges(reviewItems, existingThemes); },
            (refineContext) => { void (async () => {
                const combinedContext = userContext
                    ? `${userContext}\n\nAdditional feedback: ${refineContext}`
                    : refineContext;
                this.accumulatedThemeContext = combinedContext;
                await this.runThemeReview(button, existingThemes, combinedContext);
            })(); }
        );
        modal.open();
    }

    /**
     * Apply selected theme changes from review
     */
    private async applyThemeChanges(
        reviewItems: ReviewItem[],
        _existingThemes: SuggestedTheme[]
    ): Promise<void> {
        // Build final theme list based on selections
        const finalThemes: SuggestedTheme[] = [];

        for (const item of reviewItems) {
            if (item.action === 'keep' && item.current) {
                finalThemes.push(item.current);
            } else if (item.action === 'add' && item.selected && item.suggested) {
                finalThemes.push(item.suggested);
            } else if (item.action === 'modify' && item.selected && item.suggested) {
                finalThemes.push(item.suggested);
            } else if (item.action === 'modify' && !item.selected && item.current) {
                // User deselected modification - keep original
                finalThemes.push(item.current);
            } else if (item.action === 'remove' && !item.selected && item.current) {
                // User deselected removal - keep it
                finalThemes.push(item.current);
            }
            // If action === 'remove' && item.selected, we don't add it (it's removed)
        }

        await this.updateTaxonomyWithThemes(finalThemes);
    }

    /**
     * Run the actual theme analysis
     */
    private async runThemeAnalysis(button: HTMLButtonElement, userContext: string): Promise<void> {
        const originalText = button.textContent || '';
        const t = this.plugin.t;

        try {
            button.textContent = t.settings.configuration.analyzing || 'Analyzing vault...';
            button.disabled = true;

            const suggestionService = new TaxonomySuggestionService(
                this.plugin.app,
                this.plugin.llmService
            );

            const analysis = suggestionService.analyzeVaultStructure();

            if (analysis.subfolders.length === 0) {
                new Notice('No meaningful folders found to analyze.');
                return;
            }

            new Notice(`Analyzing ${analysis.subfolders.length} folders for themes...`);

            const suggestions = await withBusyIndicator(this.plugin, () => suggestionService.suggestThemes(userContext));

            if (suggestions.length === 0) {
                new Notice('Could not generate theme suggestions. Please try again.');
                return;
            }

            this.showThemeModal(button, suggestions);

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            new Notice(`Failed to suggest themes: ${errorMsg}`);
            logger.error('Settings', 'Theme suggestion error:', error);
        } finally {
            button.textContent = originalText;
            button.disabled = false;
        }
    }

    /**
     * Show the theme suggestion modal
     */
    private showThemeModal(button: HTMLButtonElement, themes: SuggestedTheme[]): void {
        // Reuse the same modal - themes have the same structure as disciplines
        const modal = new DisciplineSuggestionModal(
            this.plugin.app,
            themes,
            (selectedThemes) => { void this.updateTaxonomyWithThemes(selectedThemes); },
            (options: RefineOptions) => { void (async () => {
                const combinedContext = this.accumulatedThemeContext
                    ? `${this.accumulatedThemeContext}\n\nAdditional feedback: ${options.context}`
                    : options.context;
                this.accumulatedThemeContext = combinedContext;

                if (options.mode === 'add') {
                    await this.addMoreThemes(button, options.currentDisciplines, combinedContext);
                } else {
                    await this.runThemeAnalysis(button, combinedContext);
                }
            })(); }
        );
        modal.open();
    }

    /**
     * Add more themes to the existing list
     */
    private async addMoreThemes(
        button: HTMLButtonElement,
        currentThemes: SuggestedTheme[],
        userContext: string
    ): Promise<void> {
        const originalText = button.textContent || '';

        try {
            button.textContent = 'Adding themes...';
            button.disabled = true;

            const suggestionService = new TaxonomySuggestionService(
                this.plugin.app,
                this.plugin.llmService
            );

            const newThemes = await withBusyIndicator(this.plugin, () => suggestionService.suggestAdditionalThemes(currentThemes, userContext));

            if (newThemes.length === 0) {
                new Notice('AI could not suggest additional themes. Try being more specific.');
                this.showThemeModal(button, currentThemes);
                return;
            }

            const mergedThemes = [...currentThemes, ...newThemes];
            new Notice(`Added ${newThemes.length} new theme(s)`);
            this.showThemeModal(button, mergedThemes);

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            new Notice(`Failed to add themes: ${errorMsg}`);
            logger.error('Settings', 'Add themes error:', error);
            this.showThemeModal(button, currentThemes);
        } finally {
            button.textContent = originalText;
            button.disabled = false;
        }
    }

    /**
     * Update the taxonomy.md file with new themes
     */
    private async updateTaxonomyWithThemes(themes: SuggestedTheme[]): Promise<void> {
        try {
            const taxonomyPath = this.plugin.configService.getConfigPaths().taxonomyFile;
            const taxonomyFile = this.plugin.app.vault.getAbstractFileByPath(taxonomyPath);

            if (!taxonomyFile) {
                await this.plugin.configService.createDefaultConfigFiles();
            }

            const file = this.plugin.app.vault.getAbstractFileByPath(taxonomyPath);
            if (!file) {
                new Notice('Could not find or create taxonomy file');
                return;
            }

            let content = await this.plugin.app.vault.read(file as import('obsidian').TFile);

            // Find and replace the themes section
            const themesTableRegex = /(## Themes[\s\S]*?\| Name \| Description \| Use When \|\n\|[-|]+\|\n)([\s\S]*?)(\n---|\n## |$)/;

            const newThemesTable = themes.map(t =>
                `| ${t.name} | ${t.description} | ${t.useWhen} |`
            ).join('\n');

            if (themesTableRegex.test(content)) {
                content = content.replace(themesTableRegex, `$1${newThemesTable}\n$3`);
            } else {
                // Themes section should come before disciplines
                const disciplinesIdx = content.indexOf('## Disciplines');
                if (disciplinesIdx > -1) {
                    const themesSection = `## Themes\n\nTop-level categories for organizing all your notes.\n\n| Name | Description | Use When |\n|------|-------------|----------|\n${newThemesTable}\n\n`;
                    content = content.slice(0, disciplinesIdx) + themesSection + content.slice(disciplinesIdx);
                } else {
                    content += `\n\n## Themes\n\nTop-level categories for organizing all your notes.\n\n| Name | Description | Use When |\n|------|-------------|----------|\n${newThemesTable}\n`;
                }
            }

            await this.plugin.app.vault.modify(file as import('obsidian').TFile, content);
            this.plugin.configService.invalidateCache();

            new Notice(`Updated taxonomy with ${themes.length} themes`);

            const leaf = this.plugin.app.workspace.getLeaf(false);
            if (leaf) {
                await leaf.openFile(file as import('obsidian').TFile);
            }

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            new Notice(`Failed to update taxonomy: ${errorMsg}`);
        }
    }

    /**
     * Use AI to suggest disciplines based on vault folder structure
     * Adaptive: checks if disciplines already exist and offers review mode
     */
    private async suggestDisciplinesFromVault(button: HTMLButtonElement): Promise<void> {
        // Reset accumulated context for new session
        this.accumulatedContext = '';

        // Check for existing disciplines
        const config = await this.plugin.configService.loadConfig();
        const existingDisciplines: SuggestedDiscipline[] = config.taxonomy.disciplines.map(d => ({
            name: d.name,
            description: d.description,
            useWhen: d.useWhen
        }));

        if (existingDisciplines.length > 0) {
            // Show review vs fresh choice
            const reviewModal = new ReviewOrFreshModal(
                this.plugin.app,
                'discipline',
                existingDisciplines.length,
                (choice: 'review' | 'fresh') => {
                    if (choice === 'review') {
                        // Show context choice for review
                        const contextModal = new ReviewContextModal(
                            this.plugin.app,
                            'discipline',
                            (contextChoice, userContext) => { void (async () => {
                                if (contextChoice === 'vault') {
                                    await this.runDisciplineReview(button, existingDisciplines);
                                } else {
                                    this.accumulatedContext = userContext || '';
                                    await this.runDisciplineReview(button, existingDisciplines, userContext);
                                }
                            })(); }
                        );
                        contextModal.open();
                    } else {
                        // Fresh analysis - show original choice modal
                        this.showFreshDisciplineAnalysisChoice(button);
                    }
                }
            );
            reviewModal.open();
        } else {
            // No existing disciplines - show original flow
            this.showFreshDisciplineAnalysisChoice(button);
        }
    }

    /**
     * Show the original fresh discipline analysis choice modal
     */
    private showFreshDisciplineAnalysisChoice(button: HTMLButtonElement): void {
        const choiceModal = new AnalysisChoiceModal(
            this.plugin.app,
            (choice: 'ai-first' | 'context-first') => { void (async () => {
                if (choice === 'ai-first') {
                    await this.runDisciplineAnalysis(button, '');
                } else {
                    const contextModal = new UserContextModal(
                        this.plugin.app,
                        (userContext: string) => { void (async () => {
                            this.accumulatedContext = userContext;
                            await this.runDisciplineAnalysis(button, userContext);
                        })(); }
                    );
                    contextModal.open();
                }
            })(); }
        );
        choiceModal.open();
    }

    /**
     * Run discipline review with comparison table
     */
    private async runDisciplineReview(
        button: HTMLButtonElement,
        existingDisciplines: SuggestedDiscipline[],
        userContext?: string
    ): Promise<void> {
        const originalText = button.textContent || '';

        try {
            button.textContent = 'Reviewing disciplines...';
            button.disabled = true;

            const suggestionService = new TaxonomySuggestionService(
                this.plugin.app,
                this.plugin.llmService
            );

            // Load existing themes for alignment
            const config = await this.plugin.configService.loadConfig();
            const existingThemes: SuggestedTheme[] = config.taxonomy.themes.map(t => ({
                name: t.name,
                description: t.description,
                useWhen: t.useWhen
            }));

            new Notice('Analyzing vault and reviewing disciplines...');

            const changes = await withBusyIndicator(this.plugin, () => suggestionService.reviewDisciplines(
                existingDisciplines,
                existingThemes.length > 0 ? existingThemes : undefined,
                userContext
            ));

            if (changes.length === 0) {
                new Notice('AI found no improvements to suggest. Your disciplines look good!');
                return;
            }

            // Show comparison modal
            this.showDisciplineReviewModal(button, existingDisciplines, changes, userContext);

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            new Notice(`Failed to review disciplines: ${errorMsg}`);
            logger.error('Settings', 'Discipline review error:', error);
        } finally {
            button.textContent = originalText;
            button.disabled = false;
        }
    }

    /**
     * Show the discipline review comparison modal
     */
    private showDisciplineReviewModal(
        button: HTMLButtonElement,
        existingDisciplines: SuggestedDiscipline[],
        changes: TaxonomyChange[],
        userContext?: string
    ): void {
        const modal = new ReviewComparisonModal(
            this.plugin.app,
            'discipline',
            existingDisciplines,
            changes,
            (reviewItems) => { void this.applyDisciplineChanges(reviewItems); },
            (refineContext) => { void (async () => {
                const combinedContext = userContext
                    ? `${userContext}\n\nAdditional feedback: ${refineContext}`
                    : refineContext;
                this.accumulatedContext = combinedContext;
                await this.runDisciplineReview(button, existingDisciplines, combinedContext);
            })(); }
        );
        modal.open();
    }

    /**
     * Apply selected discipline changes from review
     */
    private async applyDisciplineChanges(reviewItems: ReviewItem[]): Promise<void> {
        // Build final discipline list based on selections
        const finalDisciplines: SuggestedDiscipline[] = [];

        for (const item of reviewItems) {
            if (item.action === 'keep' && item.current) {
                finalDisciplines.push(item.current);
            } else if (item.action === 'add' && item.selected && item.suggested) {
                finalDisciplines.push(item.suggested);
            } else if (item.action === 'modify' && item.selected && item.suggested) {
                finalDisciplines.push(item.suggested);
            } else if (item.action === 'modify' && !item.selected && item.current) {
                // User deselected modification - keep original
                finalDisciplines.push(item.current);
            } else if (item.action === 'remove' && !item.selected && item.current) {
                // User deselected removal - keep it
                finalDisciplines.push(item.current);
            }
            // If action === 'remove' && item.selected, we don't add it (it's removed)
        }

        await this.updateTaxonomyWithDisciplines(finalDisciplines);
    }

    /**
     * Run the actual discipline analysis with optional user context
     */
    private async runDisciplineAnalysis(button: HTMLButtonElement, userContext: string): Promise<void> {
        const originalText = button.textContent || '';
        const t = this.plugin.t;

        try {
            button.textContent = t.settings.configuration.analyzing || 'Analyzing vault...';
            button.disabled = true;

            const suggestionService = new TaxonomySuggestionService(
                this.plugin.app,
                this.plugin.llmService
            );

            // First, get vault analysis info
            const analysis = suggestionService.analyzeVaultStructure();

            if (analysis.subfolders.length === 0) {
                new Notice('No meaningful folders found to analyze. Create some folders in your vault first.');
                return;
            }

            const noteTitleCount = analysis.noteTitles.length;
            new Notice(`Analyzing ${analysis.subfolders.length} folders and ${noteTitleCount} note titles...`);

            // Load existing themes to align disciplines with them
            const config = await this.plugin.configService.loadConfig();
            const existingThemes: SuggestedTheme[] = config.taxonomy.themes.map(t => ({
                name: t.name,
                description: t.description,
                useWhen: t.useWhen
            }));

            // Get AI suggestions with user context and existing themes for alignment
            const suggestions = await withBusyIndicator(this.plugin, () => suggestionService.suggestDisciplines(userContext, existingThemes));

            if (suggestions.length === 0) {
                new Notice('Could not generate discipline suggestions. Please try again.');
                return;
            }

            // Show modal with suggestions and refine option
            this.showDisciplineModal(button, suggestions);

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            new Notice(`Failed to suggest disciplines: ${errorMsg}`);
            logger.error('Settings', 'Discipline suggestion error:', error);
        } finally {
            button.textContent = originalText;
            button.disabled = false;
        }
    }

    /**
     * Show the discipline suggestion modal with refine handling
     */
    private showDisciplineModal(button: HTMLButtonElement, disciplines: SuggestedDiscipline[]): void {
        const modal = new DisciplineSuggestionModal(
            this.plugin.app,
            disciplines,
            (selectedDisciplines) => { void this.updateTaxonomyWithDisciplines(selectedDisciplines); },
            (options: RefineOptions) => { void (async () => {
                // Combine with previous context for refinement
                const combinedContext = this.accumulatedContext
                    ? `${this.accumulatedContext}\n\nAdditional feedback: ${options.context}`
                    : options.context;
                this.accumulatedContext = combinedContext;

                if (options.mode === 'add') {
                    // Add mode: keep current disciplines and add new ones
                    await this.addMoreDisciplines(button, options.currentDisciplines, combinedContext);
                } else {
                    // Replace mode: regenerate all disciplines
                    await this.runDisciplineAnalysis(button, combinedContext);
                }
            })(); }
        );
        modal.open();
    }

    /**
     * Add more disciplines to the existing list
     */
    private async addMoreDisciplines(
        button: HTMLButtonElement,
        currentDisciplines: SuggestedDiscipline[],
        userContext: string
    ): Promise<void> {
        const originalText = button.textContent || '';

        try {
            button.textContent = 'Adding disciplines...';
            button.disabled = true;

            const suggestionService = new TaxonomySuggestionService(
                this.plugin.app,
                this.plugin.llmService
            );

            // Get additional discipline suggestions
            const newDisciplines = await withBusyIndicator(this.plugin, () => suggestionService.suggestAdditionalDisciplines(
                currentDisciplines,
                userContext
            ));

            if (newDisciplines.length === 0) {
                new Notice('AI could not suggest additional disciplines. Try being more specific.');
                // Re-show the modal with current disciplines
                this.showDisciplineModal(button, currentDisciplines);
                return;
            }

            // Merge new disciplines with existing ones
            const mergedDisciplines = [...currentDisciplines, ...newDisciplines];

            new Notice(`Added ${newDisciplines.length} new discipline(s)`);

            // Show updated modal with merged list
            this.showDisciplineModal(button, mergedDisciplines);

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            new Notice(`Failed to add disciplines: ${errorMsg}`);
            logger.error('Settings', 'Add disciplines error:', error);
            // Re-show the modal with current disciplines on error
            this.showDisciplineModal(button, currentDisciplines);
        } finally {
            button.textContent = originalText;
            button.disabled = false;
        }
    }

    /**
     * Update the taxonomy.md file with new disciplines
     */
    private async updateTaxonomyWithDisciplines(disciplines: SuggestedDiscipline[]): Promise<void> {
        try {
            const taxonomyPath = this.plugin.configService.getConfigPaths().taxonomyFile;
            const taxonomyFile = this.plugin.app.vault.getAbstractFileByPath(taxonomyPath);

            if (!taxonomyFile) {
                // Create config files first
                await this.plugin.configService.createDefaultConfigFiles();
            }

            // Read current taxonomy
            const file = this.plugin.app.vault.getAbstractFileByPath(taxonomyPath);
            if (!file) {
                new Notice('Could not find or create taxonomy file');
                return;
            }

            let content = await this.plugin.app.vault.read(file as import('obsidian').TFile);

            // Find and replace the disciplines section
            const disciplinesTableRegex = /(## Disciplines[\s\S]*?\| Name \| Description \| Use When \|\n\|[-|]+\|\n)([\s\S]*?)(\n---|\n## |$)/;

            const newDisciplinesTable = disciplines.map(d =>
                `| ${d.name} | ${d.description} | ${d.useWhen} |`
            ).join('\n');

            if (disciplinesTableRegex.test(content)) {
                // Replace existing disciplines table
                content = content.replace(disciplinesTableRegex, `$1${newDisciplinesTable}\n$3`);
            } else {
                // Append disciplines section if not found
                content += `\n\n## Disciplines\n\nSecond-level tags representing academic or professional fields.\n\n| Name | Description | Use When |\n|------|-------------|----------|\n${newDisciplinesTable}\n`;
            }

            await this.plugin.app.vault.modify(file as import('obsidian').TFile, content);

            // Invalidate cache so new disciplines are loaded
            this.plugin.configService.invalidateCache();

            new Notice(`Updated taxonomy with ${disciplines.length} disciplines`);

            // Open the taxonomy file
            const leaf = this.plugin.app.workspace.getLeaf(false);
            if (leaf) {
                await leaf.openFile(file as import('obsidian').TFile);
            }

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            new Notice(`Failed to update taxonomy: ${errorMsg}`);
        }
    }

    private getVaultFolders(): string[] {
        const folders: string[] = [];
        for (const file of this.plugin.app.vault.getAllLoadedFiles()) {
            if (file instanceof TFolder && file.path !== '/') {
                folders.push(file.path);
            }
        }
        folders.sort((a, b) => a.localeCompare(b));
        return folders;
    }
}
