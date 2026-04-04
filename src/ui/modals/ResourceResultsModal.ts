/**
 * Resource Results Modal
 * Displays search results for resources (YouTube videos, articles)
 */

import { App, Modal, setIcon } from 'obsidian';
import { Translations } from '../../i18n/types';
import { ResourceSearchResult } from '../../services/resourceSearchService';

export class ResourceResultsModal extends Modal {
    private t: Translations;
    private results: ResourceSearchResult[];

    constructor(
        app: App,
        t: Translations,
        results: ResourceSearchResult[]
    ) {
        super(app);
        this.t = t;
        this.results = results;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('ai-organiser-resource-results-modal');

        // Title
        contentEl.createEl('h2', {
            text: this.t.modals.resourceResults?.title || 'Related Resources'
        });

        // Description
        contentEl.createEl('p', {
            text: this.t.modals.resourceResults?.description || 'Click a link to open it, or copy the URL to add to your note.',
            cls: 'ai-organiser-resource-results-description'
        });

        // Group results by source
        const youtubeResults = this.results.filter(r => r.source === 'youtube');
        const webResults = this.results.filter(r => r.source === 'web');

        // YouTube section
        if (youtubeResults.length > 0) {
            this.renderSection(
                contentEl,
                this.t.modals.resourceResults?.youtubeSection || 'YouTube Videos',
                'youtube',
                youtubeResults
            );
        }

        // Web section
        if (webResults.length > 0) {
            this.renderSection(
                contentEl,
                this.t.modals.resourceResults?.webSection || 'Articles & Websites',
                'globe',
                webResults
            );
        }

        // Instructions
        const instructions = contentEl.createEl('div', { cls: 'ai-organiser-resource-results-instructions' });
        instructions.createEl('p', {
            text: this.t.modals.resourceResults?.instructions || 'Tip: Copy URLs you like and paste them into your note, then use "Generate from embedded content" to extract and summarize them.'
        });

        // Close button
        const buttonContainer = contentEl.createEl('div', { cls: 'ai-organiser-resource-results-buttons' });
        const closeButton = buttonContainer.createEl('button', {
            text: this.t.modals.resourceResults?.closeButton || 'Close',
            cls: 'mod-cta'
        });
        closeButton.addEventListener('click', () => this.close());
    }

    private renderSection(
        container: HTMLElement,
        title: string,
        icon: string,
        results: ResourceSearchResult[]
    ) {
        const section = container.createEl('div', { cls: 'ai-organiser-resource-results-section' });

        const header = section.createEl('div', { cls: 'ai-organiser-resource-results-section-header' });
        const iconEl = header.createEl('span', { cls: 'ai-organiser-resource-results-section-icon' });
        setIcon(iconEl, icon);
        header.createEl('span', { text: title });

        const list = section.createEl('div', { cls: 'ai-organiser-resource-results-list' });

        for (const result of results) {
            const item = list.createEl('div', { cls: 'ai-organiser-resource-results-item' });

            // Thumbnail for YouTube
            if (result.source === 'youtube' && result.thumbnail) {
                const thumbContainer = item.createEl('div', { cls: 'ai-organiser-resource-results-thumb' });
                const thumb = thumbContainer.createEl('img', {
                    attr: {
                        src: result.thumbnail,
                        alt: result.title
                    }
                });
                thumb.onerror = () => {
                    thumbContainer.remove();
                };
            }

            const info = item.createEl('div', { cls: 'ai-organiser-resource-results-info' });

            // Title as link
            info.createEl('a', {
                text: result.title,
                cls: 'ai-organiser-resource-results-title',
                attr: {
                    href: result.url,
                    target: '_blank',
                    rel: 'noopener noreferrer'
                }
            });

            // Description
            if (result.description) {
                info.createEl('p', {
                    text: result.description,
                    cls: 'ai-organiser-resource-results-desc'
                });
            }

            // URL and copy button
            const urlRow = info.createEl('div', { cls: 'ai-organiser-resource-results-url-row' });
            urlRow.createEl('span', {
                text: this.truncateUrl(result.url),
                cls: 'ai-organiser-resource-results-url'
            });

            const copyButton = urlRow.createEl('button', {
                cls: 'ai-organiser-resource-results-copy',
                attr: { 'aria-label': 'Copy URL' }
            });
            setIcon(copyButton, 'copy');
            copyButton.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                void navigator.clipboard.writeText(result.url).then(() => {
                    setIcon(copyButton, 'check');
                    setTimeout(() => setIcon(copyButton, 'copy'), 2000);
                });
            });
        }
    }

    private truncateUrl(url: string): string {
        try {
            const urlObj = new URL(url);
            let display = urlObj.hostname + urlObj.pathname;
            if (display.length > 50) {
                display = display.substring(0, 47) + '...';
            }
            return display;
        } catch {
            return url.substring(0, 50);
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
