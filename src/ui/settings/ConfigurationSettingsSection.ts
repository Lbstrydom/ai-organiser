import { Setting, Notice, Modal, App } from 'obsidian';
import { BaseSettingSection } from './BaseSettingSection';
import { TaxonomySuggestionService, SuggestedDiscipline, SuggestedTheme, TaxonomyChange } from '../../services/taxonomySuggestionService';

/**
 * Existing item with potential suggested change
 */
interface ReviewItem {
    current: SuggestedDiscipline | SuggestedTheme | null;  // null for new items
    suggested: SuggestedDiscipline | SuggestedTheme | null;  // null for "keep as-is"
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
        currentItems: (SuggestedDiscipline | SuggestedTheme)[],
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
        currentItems: (SuggestedDiscipline | SuggestedTheme)[],
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
        contentEl.style.width = '700px';
        contentEl.style.maxWidth = '90vw';

        const typeLabel = this.itemType === 'theme' ? 'Themes' : 'Disciplines';
        contentEl.createEl('h2', { text: `Review ${typeLabel}` });

        const desc = contentEl.createEl('p', { cls: 'setting-item-description' });
        desc.innerHTML = `AI analyzed your vault and suggests these changes. <strong>Select</strong> the changes you want to apply.`;

        // Summary badges
        const summaryEl = contentEl.createDiv({ cls: 'review-summary' });
        summaryEl.style.display = 'flex';
        summaryEl.style.gap = '12px';
        summaryEl.style.marginBottom = '16px';
        summaryEl.style.flexWrap = 'wrap';

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
        const tableContainer = contentEl.createDiv();
        tableContainer.style.maxHeight = '300px';
        tableContainer.style.overflowY = 'auto';
        tableContainer.style.border = '1px solid var(--background-modifier-border)';
        tableContainer.style.borderRadius = 'var(--radius-s)';
        tableContainer.style.marginBottom = '16px';

        const table = tableContainer.createEl('table');
        table.style.width = '100%';
        table.style.borderCollapse = 'collapse';
        table.style.fontSize = 'var(--font-ui-small)';

        // Header
        const thead = table.createEl('thead');
        const headerRow = thead.createEl('tr');
        headerRow.style.backgroundColor = 'var(--background-secondary)';
        headerRow.style.position = 'sticky';
        headerRow.style.top = '0';

        const headers = ['', 'Current', 'Suggested Change', 'Action'];
        headers.forEach(h => {
            const th = headerRow.createEl('th', { text: h });
            th.style.padding = '8px';
            th.style.textAlign = 'left';
            th.style.borderBottom = '2px solid var(--background-modifier-border)';
        });

        // Body
        const tbody = table.createEl('tbody');

        for (const item of this.reviewItems) {
            const row = tbody.createEl('tr');
            row.style.borderBottom = '1px solid var(--background-modifier-border)';

            // Checkbox cell
            const checkCell = row.createEl('td');
            checkCell.style.padding = '8px';
            checkCell.style.width = '30px';

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
            currentCell.style.padding = '8px';
            if (item.current) {
                currentCell.createEl('strong', { text: item.current.name });
                currentCell.createEl('br');
                const descSpan = currentCell.createEl('span', { text: item.current.description });
                descSpan.style.color = 'var(--text-muted)';
                descSpan.style.fontSize = 'var(--font-ui-smaller)';
            } else {
                currentCell.createEl('em', { text: '(new)' });
                currentCell.style.color = 'var(--text-muted)';
            }

            // Suggested cell
            const suggestedCell = row.createEl('td');
            suggestedCell.style.padding = '8px';
            if (item.suggested) {
                if (item.action === 'modify' && item.current) {
                    // Show what changed
                    if (item.current.name !== item.suggested.name) {
                        const nameChange = suggestedCell.createEl('strong');
                        nameChange.innerHTML = `<s style="color: var(--text-muted)">${item.current.name}</s> → ${item.suggested.name}`;
                    } else {
                        suggestedCell.createEl('strong', { text: item.suggested.name });
                    }
                } else {
                    suggestedCell.createEl('strong', { text: item.suggested.name });
                }
                suggestedCell.createEl('br');
                const descSpan = suggestedCell.createEl('span', { text: item.suggested.description });
                descSpan.style.color = 'var(--text-muted)';
                descSpan.style.fontSize = 'var(--font-ui-smaller)';
            } else if (item.action === 'remove') {
                suggestedCell.createEl('em', { text: '(remove)' });
                suggestedCell.style.color = 'var(--text-error)';
            } else {
                suggestedCell.createEl('em', { text: '—' });
                suggestedCell.style.color = 'var(--text-muted)';
            }

            // Action cell
            const actionCell = row.createEl('td');
            actionCell.style.padding = '8px';
            actionCell.style.width = '80px';

            const actionBadge = actionCell.createEl('span');
            actionBadge.style.padding = '2px 8px';
            actionBadge.style.borderRadius = '12px';
            actionBadge.style.fontSize = 'var(--font-ui-smaller)';

            switch (item.action) {
                case 'keep':
                    actionBadge.textContent = 'Keep';
                    actionBadge.style.backgroundColor = 'var(--background-modifier-border)';
                    break;
                case 'modify':
                    actionBadge.textContent = 'Modify';
                    actionBadge.style.backgroundColor = 'var(--background-modifier-warning)';
                    break;
                case 'add':
                    actionBadge.textContent = 'Add';
                    actionBadge.style.backgroundColor = 'var(--background-modifier-success)';
                    break;
                case 'remove':
                    actionBadge.textContent = 'Remove';
                    actionBadge.style.backgroundColor = 'var(--background-modifier-error)';
                    break;
            }

            this.updateRowStyle(row, item);
        }

        // Refine section
        const refineSection = contentEl.createDiv();
        refineSection.style.padding = '12px';
        refineSection.style.backgroundColor = 'var(--background-secondary)';
        refineSection.style.borderRadius = 'var(--radius-s)';
        refineSection.style.marginBottom = '16px';

        refineSection.createEl('strong', { text: 'Need different suggestions?' });
        const refineDesc = refineSection.createEl('p', { cls: 'setting-item-description' });
        refineDesc.style.margin = '4px 0 8px 0';
        refineDesc.textContent = 'Describe what you want to change:';

        const refineInput = refineSection.createEl('textarea', {
            placeholder: 'e.g., "Add more focus on technology" or "Remove business-related themes"'
        });
        refineInput.style.width = '100%';
        refineInput.style.minHeight = '60px';
        refineInput.style.padding = '8px';
        refineInput.style.resize = 'vertical';

        const refineBtnContainer = refineSection.createDiv();
        refineBtnContainer.style.marginTop = '8px';
        const refineBtn = refineBtnContainer.createEl('button', { text: 'Regenerate Suggestions' });
        refineBtn.addEventListener('click', () => {
            const context = refineInput.value.trim();
            if (context) {
                this.onRefine(context);
                this.close();
            }
        });

        // Main buttons
        const buttonContainer = contentEl.createDiv();
        buttonContainer.style.display = 'flex';
        buttonContainer.style.justifyContent = 'flex-end';
        buttonContainer.style.gap = '8px';

        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());

        const applyBtn = buttonContainer.createEl('button', { text: 'Apply Selected Changes', cls: 'mod-cta' });
        applyBtn.addEventListener('click', () => {
            this.onConfirm(this.reviewItems);
            this.close();
        });
    }

    private createBadge(container: HTMLElement, text: string, color: string): void {
        const badge = container.createEl('span', { text });
        badge.style.padding = '4px 10px';
        badge.style.borderRadius = '12px';
        badge.style.fontSize = 'var(--font-ui-smaller)';
        badge.style.backgroundColor = 'var(--background-secondary)';
        badge.style.border = `1px solid ${color}`;
        badge.style.color = color;
    }

    private updateRowStyle(row: HTMLElement, item: ReviewItem): void {
        if (item.action === 'keep') {
            row.style.opacity = '0.7';
        } else if (!item.selected) {
            row.style.opacity = '0.5';
            row.style.textDecoration = 'line-through';
        } else {
            row.style.opacity = '1';
            row.style.textDecoration = 'none';
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
        contentEl.style.maxWidth = '480px';

        const typeLabel = this.itemType === 'theme' ? 'Themes' : 'Disciplines';
        contentEl.createEl('h2', { text: `${typeLabel} Already Configured` });

        const desc = contentEl.createEl('p', { cls: 'setting-item-description' });
        desc.textContent = `You have ${this.existingCount} ${this.itemType}${this.existingCount > 1 ? 's' : ''} configured. What would you like to do?`;

        const optionsEl = contentEl.createDiv();
        optionsEl.style.display = 'flex';
        optionsEl.style.flexDirection = 'column';
        optionsEl.style.gap = '10px';
        optionsEl.style.marginTop = '16px';
        optionsEl.style.marginBottom = '16px';

        // Option 1: Review & Improve (recommended)
        const reviewBtn = optionsEl.createEl('button', { cls: 'mod-cta' });
        reviewBtn.style.padding = '12px 16px';
        reviewBtn.style.textAlign = 'left';
        reviewBtn.style.whiteSpace = 'normal';
        reviewBtn.style.height = 'auto';
        reviewBtn.style.lineHeight = '1.4';

        const reviewTitle = reviewBtn.createEl('div', { text: 'Review & Improve (Recommended)' });
        reviewTitle.style.fontWeight = '600';
        reviewTitle.style.marginBottom = '4px';

        const reviewDesc = reviewBtn.createEl('div', {
            text: 'AI will suggest additions and refinements to your existing list'
        });
        reviewDesc.style.fontSize = '12px';
        reviewDesc.style.opacity = '0.85';
        reviewDesc.style.fontWeight = 'normal';

        reviewBtn.addEventListener('click', () => {
            this.onChoice('review');
            this.close();
        });

        // Option 2: Start Fresh
        const freshBtn = optionsEl.createEl('button');
        freshBtn.style.padding = '12px 16px';
        freshBtn.style.textAlign = 'left';
        freshBtn.style.whiteSpace = 'normal';
        freshBtn.style.height = 'auto';
        freshBtn.style.lineHeight = '1.4';
        freshBtn.style.display = 'block';
        freshBtn.style.width = '100%';

        const freshTitle = freshBtn.createEl('div', { text: 'Start Fresh' });
        freshTitle.style.fontWeight = '600';
        freshTitle.style.marginBottom = '4px';
        freshTitle.style.display = 'block';

        const freshDesc = freshBtn.createEl('div', {
            text: 'Replace all existing with new AI-generated suggestions'
        });
        freshDesc.style.fontSize = '12px';
        freshDesc.style.opacity = '0.7';
        freshDesc.style.fontWeight = 'normal';
        freshDesc.style.display = 'block';

        freshBtn.addEventListener('click', () => {
            this.onChoice('fresh');
            this.close();
        });

        // Cancel
        const cancelContainer = contentEl.createDiv();
        cancelContainer.style.textAlign = 'right';
        cancelContainer.style.marginTop = '12px';
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
        contentEl.style.maxWidth = '480px';

        const typeLabel = this.itemType === 'theme' ? 'themes' : 'disciplines';
        contentEl.createEl('h2', { text: 'How should AI suggest improvements?' });

        const optionsEl = contentEl.createDiv();
        optionsEl.style.display = 'flex';
        optionsEl.style.flexDirection = 'column';
        optionsEl.style.gap = '10px';
        optionsEl.style.marginTop = '16px';

        // Option 1: Analyze vault
        const vaultBtn = optionsEl.createEl('button', { cls: 'mod-cta' });
        vaultBtn.style.padding = '12px 16px';
        vaultBtn.style.textAlign = 'left';
        vaultBtn.style.whiteSpace = 'normal';
        vaultBtn.style.height = 'auto';
        vaultBtn.style.lineHeight = '1.4';

        const vaultTitle = vaultBtn.createEl('div', { text: 'Analyze my vault (Recommended)' });
        vaultTitle.style.fontWeight = '600';
        vaultTitle.style.marginBottom = '4px';

        const vaultDesc = vaultBtn.createEl('div', {
            text: 'AI scans your folder structure and note titles to suggest improvements'
        });
        vaultDesc.style.fontSize = '12px';
        vaultDesc.style.opacity = '0.85';
        vaultDesc.style.fontWeight = 'normal';

        vaultBtn.addEventListener('click', () => {
            this.onChoice('vault');
            this.close();
        });

        // Option 2: Provide context
        const contextBtn = optionsEl.createEl('button');
        contextBtn.style.padding = '12px 16px';
        contextBtn.style.textAlign = 'left';
        contextBtn.style.whiteSpace = 'normal';
        contextBtn.style.height = 'auto';
        contextBtn.style.lineHeight = '1.4';
        contextBtn.style.display = 'block';
        contextBtn.style.width = '100%';

        const contextTitle = contextBtn.createEl('div', { text: 'I\'ll describe what I need' });
        contextTitle.style.fontWeight = '600';
        contextTitle.style.marginBottom = '4px';
        contextTitle.style.display = 'block';

        const contextDesc = contextBtn.createEl('div', {
            text: `Tell the AI what ${typeLabel} you want to add or change`
        });
        contextDesc.style.fontSize = '12px';
        contextDesc.style.opacity = '0.7';
        contextDesc.style.fontWeight = 'normal';
        contextDesc.style.display = 'block';

        contextBtn.addEventListener('click', () => {
            this.close();
            this.showContextInput();
        });

        // Cancel
        const cancelContainer = contentEl.createDiv();
        cancelContainer.style.textAlign = 'right';
        cancelContainer.style.marginTop = '16px';
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
        contentEl.style.maxWidth = '450px';

        contentEl.createEl('h2', { text: 'How would you like to start?' });
        contentEl.createEl('p', {
            text: 'Choose how you want to generate suggestions:',
            cls: 'setting-item-description'
        });

        // Options container
        const optionsEl = contentEl.createDiv({ cls: 'analysis-choice-options' });
        optionsEl.style.display = 'flex';
        optionsEl.style.flexDirection = 'column';
        optionsEl.style.gap = '10px';
        optionsEl.style.marginTop = '16px';
        optionsEl.style.marginBottom = '16px';

        // Option 1: AI analyzes first
        const aiFirstBtn = optionsEl.createEl('button', { cls: 'mod-cta' });
        aiFirstBtn.style.padding = '12px 16px';
        aiFirstBtn.style.textAlign = 'left';
        aiFirstBtn.style.whiteSpace = 'normal';
        aiFirstBtn.style.height = 'auto';
        aiFirstBtn.style.lineHeight = '1.4';

        const aiFirstTitle = aiFirstBtn.createEl('div', { text: 'Let AI analyze first' });
        aiFirstTitle.style.fontWeight = '600';
        aiFirstTitle.style.marginBottom = '4px';

        const aiFirstDesc = aiFirstBtn.createEl('div', {
            text: 'AI analyzes your vault structure and note titles, then you can refine'
        });
        aiFirstDesc.style.fontSize = '12px';
        aiFirstDesc.style.opacity = '0.85';
        aiFirstDesc.style.fontWeight = 'normal';

        aiFirstBtn.addEventListener('click', () => {
            this.onChoice('ai-first');
            this.close();
        });

        // Option 2: Provide context first
        const contextFirstBtn = optionsEl.createEl('button');
        contextFirstBtn.style.padding = '12px 16px';
        contextFirstBtn.style.textAlign = 'left';
        contextFirstBtn.style.whiteSpace = 'normal';
        contextFirstBtn.style.height = 'auto';
        contextFirstBtn.style.lineHeight = '1.4';

        const contextFirstTitle = contextFirstBtn.createEl('div', { text: 'Describe my focus areas first' });
        contextFirstTitle.style.fontWeight = '600';
        contextFirstTitle.style.marginBottom = '4px';

        const contextFirstDesc = contextFirstBtn.createEl('div', {
            text: 'Tell the AI about your profession and interests before analysis'
        });
        contextFirstDesc.style.fontSize = '12px';
        contextFirstDesc.style.opacity = '0.7';
        contextFirstDesc.style.fontWeight = 'normal';

        contextFirstBtn.addEventListener('click', () => {
            this.onChoice('context-first');
            this.close();
        });

        // Cancel button
        const cancelContainer = contentEl.createDiv();
        cancelContainer.style.textAlign = 'right';
        cancelContainer.style.marginTop = '12px';
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
        textArea.style.width = '100%';
        textArea.style.minHeight = '120px';
        textArea.style.marginTop = '12px';
        textArea.style.marginBottom = '16px';
        textArea.style.padding = '8px';
        textArea.style.resize = 'vertical';
        textArea.addEventListener('input', (e) => {
            this.userContext = (e.target as HTMLTextAreaElement).value;
        });

        // Info text
        const infoEl = contentEl.createEl('p', {
            cls: 'setting-item-description'
        });
        infoEl.style.fontSize = 'var(--font-ui-smaller)';
        infoEl.style.color = 'var(--text-muted)';
        infoEl.innerHTML = '<strong>Note:</strong> The AI will also analyze your folder structure and sample note titles.';

        // Buttons
        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
        buttonContainer.style.display = 'flex';
        buttonContainer.style.justifyContent = 'flex-end';
        buttonContainer.style.gap = '8px';

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
        contentEl.style.width = '600px';

        contentEl.createEl('h2', { text: 'Suggested Disciplines' });
        contentEl.createEl('p', {
            text: 'Review and edit the suggested disciplines. Click on a name to edit it, or add comments for context.',
            cls: 'setting-item-description'
        });

        // Create discipline list
        this.listEl = contentEl.createDiv({ cls: 'discipline-suggestion-list' });
        this.listEl.style.maxHeight = '350px';
        this.listEl.style.overflowY = 'auto';
        this.listEl.style.marginBottom = '16px';
        this.listEl.style.border = '1px solid var(--background-modifier-border)';
        this.listEl.style.borderRadius = 'var(--radius-s)';

        this.renderDisciplineList();

        // Refine section
        const refineSection = contentEl.createDiv({ cls: 'refine-section' });
        refineSection.style.marginBottom = '16px';
        refineSection.style.padding = '12px';
        refineSection.style.backgroundColor = 'var(--background-secondary)';
        refineSection.style.borderRadius = 'var(--radius-s)';

        refineSection.createEl('strong', { text: 'Refine suggestions' });
        const refineDesc = refineSection.createEl('p', {
            cls: 'setting-item-description'
        });
        refineDesc.style.margin = '4px 0 8px 0';
        refineDesc.textContent = 'Describe what you want to change, add, or focus on:';

        const refineTextArea = refineSection.createEl('textarea', {
            placeholder: 'Examples:\n• "Add disciplines for personal finance and family organization"\n• "I need more focus on machine learning and data engineering"\n• "Remove business-related disciplines, focus on creative writing"'
        });
        refineTextArea.style.width = '100%';
        refineTextArea.style.minHeight = '80px';
        refineTextArea.style.padding = '8px';
        refineTextArea.style.resize = 'vertical';
        refineTextArea.style.fontFamily = 'var(--font-interface)';

        // Refine mode selection
        const modeContainer = refineSection.createDiv();
        modeContainer.style.marginTop = '12px';
        modeContainer.style.display = 'flex';
        modeContainer.style.gap = '16px';
        modeContainer.style.alignItems = 'center';

        const modeLabel = modeContainer.createEl('span', { text: 'When regenerating:' });
        modeLabel.style.fontWeight = '500';

        let selectedMode: 'add' | 'replace' = 'add';

        const addModeLabel = modeContainer.createEl('label');
        addModeLabel.style.display = 'flex';
        addModeLabel.style.alignItems = 'center';
        addModeLabel.style.gap = '4px';
        addModeLabel.style.cursor = 'pointer';
        const addModeRadio = addModeLabel.createEl('input', { type: 'radio' });
        addModeRadio.name = 'refine-mode';
        addModeRadio.checked = true;
        addModeRadio.addEventListener('change', () => { selectedMode = 'add'; });
        addModeLabel.createEl('span', { text: 'Add to current list' });

        const replaceModeLabel = modeContainer.createEl('label');
        replaceModeLabel.style.display = 'flex';
        replaceModeLabel.style.alignItems = 'center';
        replaceModeLabel.style.gap = '4px';
        replaceModeLabel.style.cursor = 'pointer';
        const replaceModeRadio = replaceModeLabel.createEl('input', { type: 'radio' });
        replaceModeRadio.name = 'refine-mode';
        replaceModeRadio.addEventListener('change', () => { selectedMode = 'replace'; });
        replaceModeLabel.createEl('span', { text: 'Replace all' });

        // Refine button
        const refineBtnContainer = refineSection.createDiv();
        refineBtnContainer.style.marginTop = '12px';
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
        buttonContainer.style.display = 'flex';
        buttonContainer.style.justifyContent = 'space-between';
        buttonContainer.style.alignItems = 'center';
        buttonContainer.style.marginTop = '8px';

        // Left side - selected count
        const selectedCount = buttonContainer.createEl('span', { cls: 'setting-item-description' });
        const updateCount = () => {
            const count = this.editableDisciplines.filter(d => d.selected).length;
            selectedCount.textContent = `${count} of ${this.editableDisciplines.length} selected`;
        };
        updateCount();

        // Right side - buttons
        const btnGroup = buttonContainer.createDiv();
        btnGroup.style.display = 'flex';
        btnGroup.style.gap = '8px';

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
        (this as any).updateCount = updateCount;
    }

    private renderDisciplineList(): void {
        if (!this.listEl) return;
        this.listEl.empty();

        this.editableDisciplines.forEach((discipline, index) => {
            const itemEl = this.listEl!.createDiv({ cls: 'discipline-item' });
            itemEl.style.padding = '10px 12px';
            itemEl.style.borderBottom = '1px solid var(--background-modifier-border)';
            if (!discipline.selected) {
                itemEl.style.opacity = '0.5';
            }

            // Top row: checkbox + name (editable)
            const topRow = itemEl.createDiv();
            topRow.style.display = 'flex';
            topRow.style.alignItems = 'center';
            topRow.style.gap = '8px';
            topRow.style.marginBottom = '4px';

            const checkbox = topRow.createEl('input', { type: 'checkbox' });
            checkbox.checked = discipline.selected;
            checkbox.style.flexShrink = '0';
            checkbox.addEventListener('change', () => {
                discipline.selected = checkbox.checked;
                itemEl.style.opacity = discipline.selected ? '1' : '0.5';
                if ((this as any).updateCount) (this as any).updateCount();
            });

            // Editable name input
            const nameInput = topRow.createEl('input', { type: 'text', value: discipline.name });
            nameInput.style.flex = '1';
            nameInput.style.fontWeight = 'bold';
            nameInput.style.border = '1px solid transparent';
            nameInput.style.borderRadius = 'var(--radius-s)';
            nameInput.style.padding = '2px 6px';
            nameInput.style.backgroundColor = 'transparent';
            nameInput.addEventListener('focus', () => {
                nameInput.style.border = '1px solid var(--interactive-accent)';
                nameInput.style.backgroundColor = 'var(--background-primary)';
            });
            nameInput.addEventListener('blur', () => {
                nameInput.style.border = '1px solid transparent';
                nameInput.style.backgroundColor = 'transparent';
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
            descEl.style.margin = '2px 0 2px 24px';
            descEl.style.fontSize = 'var(--font-ui-smaller)';

            // Use when
            const useWhenEl = itemEl.createEl('p', {
                text: `Use when: ${discipline.useWhen}`,
                cls: 'setting-item-description'
            });
            useWhenEl.style.margin = '0 0 0 24px';
            useWhenEl.style.fontSize = 'var(--font-ui-smaller)';
            useWhenEl.style.color = 'var(--text-muted)';

            // Expandable comment section
            const commentContainer = itemEl.createDiv();
            commentContainer.style.marginLeft = '24px';
            commentContainer.style.marginTop = '6px';

            const commentToggle = commentContainer.createEl('button', {
                text: discipline.userComment ? '✏️ Edit note' : '+ Add note for AI'
            });
            commentToggle.style.fontSize = 'var(--font-ui-smaller)';
            commentToggle.style.padding = '2px 8px';
            commentToggle.style.backgroundColor = 'transparent';
            commentToggle.style.border = '1px solid var(--background-modifier-border)';
            commentToggle.style.borderRadius = 'var(--radius-s)';
            commentToggle.style.cursor = 'pointer';

            const commentInput = commentContainer.createEl('textarea', {
                placeholder: 'Add context for AI refinement (e.g., "needs to be more specific" or "combine with data-science")'
            });
            commentInput.value = discipline.userComment || '';
            commentInput.style.display = discipline.userComment ? 'block' : 'none';
            commentInput.style.width = '100%';
            commentInput.style.minHeight = '40px';
            commentInput.style.marginTop = '4px';
            commentInput.style.padding = '6px';
            commentInput.style.fontSize = 'var(--font-ui-smaller)';
            commentInput.style.resize = 'vertical';
            commentInput.addEventListener('input', () => {
                discipline.userComment = commentInput.value;
                commentToggle.textContent = commentInput.value ? '✏️ Edit note' : '+ Add note for AI';
            });

            commentToggle.addEventListener('click', () => {
                const isVisible = commentInput.style.display !== 'none';
                commentInput.style.display = isVisible ? 'none' : 'block';
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

        // Config folder path
        new Setting(containerEl)
            .setName(t.settings.configuration.configFolder)
            .setDesc(t.settings.configuration.configFolderDesc)
            .addText(text => text
                .setPlaceholder('AI-Organiser-Config')
                .setValue(this.plugin.settings.configFolderPath)
                .onChange(async (value) => {
                    this.plugin.settings.configFolderPath = value || 'AI-Organiser-Config';
                    this.plugin.configService.setConfigFolder(this.plugin.settings.configFolderPath);
                    await this.plugin.saveSettings();
                })
            );

        // Buttons row
        const buttonsContainer = containerEl.createDiv({ cls: 'config-buttons-container' });
        buttonsContainer.style.display = 'flex';
        buttonsContainer.style.flexWrap = 'wrap';
        buttonsContainer.style.gap = '8px';
        buttonsContainer.style.marginTop = '8px';
        buttonsContainer.style.marginBottom = '16px';

        // Open config folder button
        const openBtn = buttonsContainer.createEl('button', {
            text: t.settings.configuration.openConfigFolder
        });
        openBtn.addEventListener('click', async () => {
            const folderPath = this.plugin.settings.configFolderPath;
            const folder = this.plugin.app.vault.getAbstractFileByPath(folderPath);

            if (folder) {
                // Open the folder in file explorer
                const leaf = this.plugin.app.workspace.getLeaf(false);
                if (leaf) {
                    // Navigate to folder by opening taxonomy.md if it exists
                    const taxonomyFile = this.plugin.app.vault.getAbstractFileByPath(`${folderPath}/taxonomy.md`);
                    if (taxonomyFile) {
                        await leaf.openFile(taxonomyFile as any);
                    }
                }
            } else {
                new Notice(`Folder not found: ${folderPath}`);
            }
        });

        // Create config files button
        const createBtn = buttonsContainer.createEl('button', {
            text: t.settings.configuration.createConfigFiles
        });
        createBtn.addEventListener('click', async () => {
            await this.plugin.configService.createDefaultConfigFiles();
            new Notice(`${t.settings.configuration.configFilesCreated} ${this.plugin.settings.configFolderPath}`);
        });

        // Suggest themes from vault button
        const suggestThemesBtn = buttonsContainer.createEl('button', {
            text: t.settings.configuration.suggestThemes || 'Suggest Themes'
        });
        suggestThemesBtn.style.backgroundColor = 'var(--interactive-accent)';
        suggestThemesBtn.style.color = 'var(--text-on-accent)';
        suggestThemesBtn.addEventListener('click', async () => {
            await this.suggestThemesFromVault(suggestThemesBtn);
        });

        // Suggest disciplines from vault button
        const suggestBtn = buttonsContainer.createEl('button', {
            text: t.settings.configuration.suggestDisciplines || 'Suggest Disciplines'
        });
        suggestBtn.style.backgroundColor = 'var(--interactive-accent)';
        suggestBtn.style.color = 'var(--text-on-accent)';
        suggestBtn.addEventListener('click', async () => {
            await this.suggestDisciplinesFromVault(suggestBtn);
        });

        // Reset to defaults button
        const resetBtn = buttonsContainer.createEl('button', {
            text: t.settings.configuration.resetToDefaults
        });
        resetBtn.style.color = 'var(--text-error)';
        resetBtn.addEventListener('click', async () => {
            if (confirm(t.settings.configuration.resetConfirm)) {
                // Delete existing files and recreate
                const paths = this.plugin.configService.getConfigPaths();
                for (const path of Object.values(paths)) {
                    const file = this.plugin.app.vault.getAbstractFileByPath(path);
                    if (file) {
                        await this.plugin.app.vault.delete(file);
                    }
                }
                await this.plugin.configService.createDefaultConfigFiles();
                this.plugin.configService.invalidateCache();
                new Notice(`${t.settings.configuration.configFilesCreated} ${this.plugin.settings.configFolderPath}`);
            }
        });

        // Info about config files
        const infoEl = containerEl.createDiv({ cls: 'config-info' });
        infoEl.style.marginTop = '12px';
        infoEl.style.padding = '12px';
        infoEl.style.backgroundColor = 'var(--background-secondary)';
        infoEl.style.borderRadius = 'var(--radius-s)';
        infoEl.style.fontSize = 'var(--font-ui-small)';
        infoEl.style.color = 'var(--text-muted)';

        infoEl.innerHTML = `
            <strong>Configuration Files:</strong>
            <ul style="margin: 8px 0 0 0; padding-left: 20px;">
                <li><code>taxonomy.md</code> - Themes and disciplines with descriptions</li>
                <li><code>summary-prompt.md</code> - Custom summary instructions</li>
                <li><code>excluded-tags.md</code> - Tags to never suggest</li>
            </ul>
            <p style="margin-top: 8px;">Edit these files to customize how AI tags your notes.</p>
            <p style="margin-top: 4px;"><strong>Tip:</strong> Click "Suggest Disciplines from Vault" to let AI analyze your folder structure and suggest meaningful disciplines based on your content.</p>
        `;
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
                async (choice: 'review' | 'fresh') => {
                    if (choice === 'review') {
                        // Show context choice for review
                        const contextModal = new ReviewContextModal(
                            this.plugin.app,
                            'theme',
                            async (contextChoice, userContext) => {
                                if (contextChoice === 'vault') {
                                    await this.runThemeReview(button, existingThemes);
                                } else {
                                    this.accumulatedThemeContext = userContext || '';
                                    await this.runThemeReview(button, existingThemes, userContext);
                                }
                            }
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
            async (choice: 'ai-first' | 'context-first') => {
                if (choice === 'ai-first') {
                    await this.runThemeAnalysis(button, '');
                } else {
                    const contextModal = new UserContextModal(
                        this.plugin.app,
                        async (userContext: string) => {
                            this.accumulatedThemeContext = userContext;
                            await this.runThemeAnalysis(button, userContext);
                        }
                    );
                    contextModal.open();
                }
            }
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

            const changes = await suggestionService.reviewThemes(existingThemes, userContext);

            if (changes.length === 0) {
                new Notice('AI found no improvements to suggest. Your themes look good!');
                return;
            }

            // Show comparison modal
            this.showThemeReviewModal(button, existingThemes, changes, userContext);

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            new Notice(`Failed to review themes: ${errorMsg}`);
            console.error('[AI Organiser] Theme review error:', error);
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
            async (reviewItems) => {
                await this.applyThemeChanges(reviewItems, existingThemes);
            },
            async (refineContext) => {
                const combinedContext = userContext
                    ? `${userContext}\n\nAdditional feedback: ${refineContext}`
                    : refineContext;
                this.accumulatedThemeContext = combinedContext;
                await this.runThemeReview(button, existingThemes, combinedContext);
            }
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

            const suggestions = await suggestionService.suggestThemes(userContext);

            if (suggestions.length === 0) {
                new Notice('Could not generate theme suggestions. Please try again.');
                return;
            }

            this.showThemeModal(button, suggestions);

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            new Notice(`Failed to suggest themes: ${errorMsg}`);
            console.error('[AI Organiser] Theme suggestion error:', error);
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
            async (selectedThemes) => {
                await this.updateTaxonomyWithThemes(selectedThemes);
            },
            async (options: RefineOptions) => {
                const combinedContext = this.accumulatedThemeContext
                    ? `${this.accumulatedThemeContext}\n\nAdditional feedback: ${options.context}`
                    : options.context;
                this.accumulatedThemeContext = combinedContext;

                if (options.mode === 'add') {
                    await this.addMoreThemes(button, options.currentDisciplines, combinedContext);
                } else {
                    await this.runThemeAnalysis(button, combinedContext);
                }
            }
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

            const newThemes = await suggestionService.suggestAdditionalThemes(currentThemes, userContext);

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
            console.error('[AI Organiser] Add themes error:', error);
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

            let content = await this.plugin.app.vault.read(file as any);

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

            await this.plugin.app.vault.modify(file as any, content);
            this.plugin.configService.invalidateCache();

            new Notice(`Updated taxonomy with ${themes.length} themes`);

            const leaf = this.plugin.app.workspace.getLeaf(false);
            if (leaf) {
                await leaf.openFile(file as any);
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
                async (choice: 'review' | 'fresh') => {
                    if (choice === 'review') {
                        // Show context choice for review
                        const contextModal = new ReviewContextModal(
                            this.plugin.app,
                            'discipline',
                            async (contextChoice, userContext) => {
                                if (contextChoice === 'vault') {
                                    await this.runDisciplineReview(button, existingDisciplines);
                                } else {
                                    this.accumulatedContext = userContext || '';
                                    await this.runDisciplineReview(button, existingDisciplines, userContext);
                                }
                            }
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
            async (choice: 'ai-first' | 'context-first') => {
                if (choice === 'ai-first') {
                    await this.runDisciplineAnalysis(button, '');
                } else {
                    const contextModal = new UserContextModal(
                        this.plugin.app,
                        async (userContext: string) => {
                            this.accumulatedContext = userContext;
                            await this.runDisciplineAnalysis(button, userContext);
                        }
                    );
                    contextModal.open();
                }
            }
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

            const changes = await suggestionService.reviewDisciplines(
                existingDisciplines,
                existingThemes.length > 0 ? existingThemes : undefined,
                userContext
            );

            if (changes.length === 0) {
                new Notice('AI found no improvements to suggest. Your disciplines look good!');
                return;
            }

            // Show comparison modal
            this.showDisciplineReviewModal(button, existingDisciplines, changes, userContext);

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            new Notice(`Failed to review disciplines: ${errorMsg}`);
            console.error('[AI Organiser] Discipline review error:', error);
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
            async (reviewItems) => {
                await this.applyDisciplineChanges(reviewItems);
            },
            async (refineContext) => {
                const combinedContext = userContext
                    ? `${userContext}\n\nAdditional feedback: ${refineContext}`
                    : refineContext;
                this.accumulatedContext = combinedContext;
                await this.runDisciplineReview(button, existingDisciplines, combinedContext);
            }
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
            const suggestions = await suggestionService.suggestDisciplines(userContext, existingThemes);

            if (suggestions.length === 0) {
                new Notice('Could not generate discipline suggestions. Please try again.');
                return;
            }

            // Show modal with suggestions and refine option
            this.showDisciplineModal(button, suggestions);

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            new Notice(`Failed to suggest disciplines: ${errorMsg}`);
            console.error('[AI Organiser] Discipline suggestion error:', error);
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
            async (selectedDisciplines) => {
                await this.updateTaxonomyWithDisciplines(selectedDisciplines);
            },
            async (options: RefineOptions) => {
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
            }
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
            const newDisciplines = await suggestionService.suggestAdditionalDisciplines(
                currentDisciplines,
                userContext
            );

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
            console.error('[AI Organiser] Add disciplines error:', error);
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

            let content = await this.plugin.app.vault.read(file as any);

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

            await this.plugin.app.vault.modify(file as any, content);

            // Invalidate cache so new disciplines are loaded
            this.plugin.configService.invalidateCache();

            new Notice(`Updated taxonomy with ${disciplines.length} disciplines`);

            // Open the taxonomy file
            const leaf = this.plugin.app.workspace.getLeaf(false);
            if (leaf) {
                await leaf.openFile(file as any);
            }

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            new Notice(`Failed to update taxonomy: ${errorMsg}`);
        }
    }
}
