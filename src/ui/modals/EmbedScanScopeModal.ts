/**
 * Embed Scan Scope Modal
 * Scope picker with keyboard navigation and ARIA support.
 * Follows TagScopeModal pattern with accessibility improvements.
 */

import { App, Modal, setIcon } from 'obsidian';
import type AIOrganiserPlugin from '../../main';

export type EmbedScanScope = 'note' | 'folder' | 'vault';

interface ScopeOption {
    value: EmbedScanScope;
    label: string;
    description: string;
    icon: string;
}

export class EmbedScanScopeModal extends Modal {
    private plugin: AIOrganiserPlugin;
    onConfirm: (scope: EmbedScanScope) => void;

    constructor(
        app: App,
        plugin: AIOrganiserPlugin,
        onConfirm: (scope: EmbedScanScope) => void
    ) {
        super(app);
        this.plugin = plugin;
        this.onConfirm = onConfirm;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('ai-organiser-scope-modal');

        const t = this.plugin.t;
        const es = t.embedScan;

        // Title
        contentEl.createEl('h2', {
            text: es.scopeTitle,
            cls: 'ai-organiser-scope-title'
        });

        // Description
        contentEl.createEl('p', {
            text: es.scopeDescription,
            cls: 'ai-organiser-scope-description'
        });

        // Context
        const activeFile = this.app.workspace.getActiveFile();
        const noteName = activeFile?.basename || es.noFileOpen;
        const folderName = activeFile?.parent?.path || 'Root';
        const folderFiles = activeFile?.parent
            ? this.plugin.getNonExcludedMarkdownFilesFromFolder(activeFile.parent).length
            : 0;
        const vaultFiles = this.plugin.getNonExcludedMarkdownFiles().length;

        const options: ScopeOption[] = [
            {
                value: 'note',
                label: es.scopeNote,
                description: noteName,
                icon: 'file-text'
            },
            {
                value: 'folder',
                label: es.scopeFolder,
                description: `${folderName} (${folderFiles} ${es.notesLabel})`,
                icon: 'folder'
            },
            {
                value: 'vault',
                label: es.scopeVault,
                description: `${vaultFiles} ${es.notesLabel}`,
                icon: 'vault'
            }
        ];

        const optionsContainer = contentEl.createDiv({
            cls: 'ai-organiser-scope-options',
            attr: { role: 'group', 'aria-label': es.scopeTitle }
        });

        const cards: HTMLElement[] = [];
        for (const option of options) {
            const card = this.renderOptionCard(optionsContainer, option);
            cards.push(card);
        }

        // Arrow key navigation between cards
        optionsContainer.addEventListener('keydown', (e: KeyboardEvent) => {
            const focusedIdx = cards.indexOf(document.activeElement as HTMLElement);
            if (focusedIdx === -1) return;

            let nextIdx = -1;
            if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
                nextIdx = (focusedIdx + 1) % cards.length;
            } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
                nextIdx = (focusedIdx - 1 + cards.length) % cards.length;
            }

            if (nextIdx !== -1) {
                e.preventDefault();
                cards[nextIdx].focus();
            }
        });

        // Auto-focus first card
        setTimeout(() => cards[0]?.focus(), 50);
    }

    private renderOptionCard(container: HTMLElement, option: ScopeOption): HTMLElement {
        const card = container.createDiv({
            cls: 'ai-organiser-scope-card',
            attr: {
                tabindex: '0',
                role: 'button',
                'aria-label': `${option.label}: ${option.description}`,
            }
        });
        card.dataset.value = option.value;

        // Icon
        const iconEl = card.createDiv({ cls: 'ai-organiser-scope-card-icon' });
        setIcon(iconEl, option.icon);

        // Content
        const contentEl = card.createDiv({ cls: 'ai-organiser-scope-card-content' });
        contentEl.createDiv({ cls: 'ai-organiser-scope-card-label', text: option.label });
        contentEl.createDiv({ cls: 'ai-organiser-scope-card-desc', text: option.description });

        // Click handler
        card.addEventListener('click', () => {
            this.onConfirm(option.value);
            this.close();
        });

        // Keyboard handler (Enter/Space)
        card.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                this.onConfirm(option.value);
                this.close();
            }
        });

        return card;
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
