/**
 * Command Picker Modal
 * A unified modal for accessing all AI Organiser commands organized by category.
 * Uses a custom Modal with inline tree expansion and Obsidian's fuzzy search.
 */

import { App, Modal, Notice, prepareFuzzySearch, setIcon, setTooltip } from 'obsidian';
import { logger } from '../../utils/logger';
import { Translations } from '../../i18n/types';
import { listen } from '../utils/domUtils';
import {
	type VisibleItem,
	buildVisibleItems,
	flattenSingleChildGroups,
} from './commandPickerViewModel';

export interface CommandCategory {
	id: string;
	name: string;
	icon: string;
	commands: PickerCommand[];
}

export interface PickerCommand {
	id: string;
	name: string;
	icon: string;
	description?: string;
	aliases?: string[];
	callback: () => void | Promise<void>;
	/** If present, clicking opens sub-commands inline instead of executing callback */
	subCommands?: PickerCommand[];
	/** Optional status badge: 'coming-soon' (needs IT setup) or 'developing' (needs separate API) */
	badge?: 'coming-soon' | 'developing';
}

export class CommandPickerModal extends Modal {
	private readonly categories: CommandCategory[];
	private readonly t: Translations;
	private readonly cleanups: (() => void)[] = [];

	// State
	private readonly expandedGroups = new Set<string>();
	private activeIndex = 0;
	private query = '';
	private visibleItems: VisibleItem[] = [];
	private isExecuting = false;

	// DOM refs
	private inputEl!: HTMLInputElement;
	private listEl!: HTMLElement;

	constructor(app: App, t: Translations, categories: CommandCategory[]) {
		super(app);
		this.t = t;
		this.categories = flattenSingleChildGroups(categories);
		this.modalEl.addClass('ai-organiser-command-picker-modal');
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		// Obsidian's .modal renders its own background/shadow at a fixed height,
		// clipping content with overflow:hidden. Instead of fighting it, we make
		// the .modal invisible and let the .prompt div be the visual container.
		this.modalEl.setCssProps({ '--bg': 'none' }); this.modalEl.addClass('ai-organiser-bg-custom');
		this.modalEl.setCssProps({ '--shadow': 'none' }); this.modalEl.addClass('ai-organiser-shadow-custom');
		this.modalEl.setCssProps({ '--border': 'none' }); this.modalEl.addClass('ai-organiser-border-custom');
		this.modalEl.setCssProps({ '--overflow': 'visible' }); this.modalEl.addClass('ai-organiser-overflow-custom');
		this.modalEl.setCssProps({ '--pad': '0' }); this.modalEl.addClass('ai-organiser-pad-custom');

		// Pin modal near top of viewport (Obsidian uses flex centering on container)
		const container = this.containerEl;
		if (container) {
			container.addClass('ai-organiser-items-start');
			container.setCssProps({ '--pad': '10vh 0 0 0' }); container.addClass('ai-organiser-pad-custom');
		}

		// Hide title and close button (we rely on Esc to close)
		const titleEl = this.modalEl.querySelector('.modal-title') as HTMLElement;
		if (titleEl) titleEl.addClass('ai-organiser-hidden');
		const closeBtn = this.modalEl.querySelector('.modal-close-button') as HTMLElement;
		if (closeBtn) closeBtn.addClass('ai-organiser-hidden');

		contentEl.setCssProps({ '--overflow': 'visible' }); contentEl.addClass('ai-organiser-overflow-custom');
		contentEl.setCssProps({ '--pad': '0' }); contentEl.addClass('ai-organiser-pad-custom');
		contentEl.setCssProps({ '--margin': '0' }); contentEl.addClass('ai-organiser-margin-custom');

		// Build the prompt container (matches FuzzySuggestModal styling)
		const promptEl = contentEl.createDiv({ cls: 'prompt' });

		// Input
		const inputContainer = promptEl.createDiv({ cls: 'prompt-input-container' });
		this.inputEl = inputContainer.createEl('input', {
			cls: 'prompt-input',
			type: 'text',
			placeholder: this.t.modals.commandPicker.placeholder,
			attr: {
				'role': 'searchbox',
				'aria-autocomplete': 'list',
				'aria-controls': 'picker-listbox',
			}
		});

		// Instructions
		const instructions = promptEl.createDiv({ cls: 'prompt-instructions' });
		const hints = [
			{ command: '↑↓', purpose: this.t.modals.commandPicker.navigateHint },
			{ command: '↵', purpose: this.t.modals.commandPicker.selectHint },
			{ command: 'esc', purpose: this.t.modals.commandPicker.closeHint },
		];
		for (const hint of hints) {
			const inst = instructions.createEl('span', { cls: 'prompt-instruction' });
			inst.createEl('span', { cls: 'prompt-instruction-command', text: hint.command });
			inst.createEl('span', { text: hint.purpose });
		}

		// Suggestion list (inside prompt container — matches Obsidian's suggest modal DOM structure)
		this.listEl = promptEl.createDiv({
			cls: 'prompt-results',
			attr: {
				'role': 'listbox',
				'id': 'picker-listbox',
			}
		});
		// setCssProps — CSS max-height gets overridden by Obsidian framework
		this.listEl.setCssProps({ '--max-h': 'calc(70vh - 80px)' }); this.listEl.addClass('ai-organiser-max-h-custom');
		this.listEl.addClass('ai-organiser-overflow-y-auto');

		// Wire events
		this.cleanups.push(listen(this.inputEl, 'input', () => {
			this.query = this.inputEl.value;
			this.activeIndex = 0;
			this.rebuild();
		}));

		this.cleanups.push(listen(this.inputEl, 'keydown', (e) => this.handleKeyboard(e)));

		// Initial render
		this.rebuild();
		this.inputEl.focus();
	}

	onClose(): void {
		for (const cleanup of this.cleanups) cleanup();
		this.cleanups.length = 0;
		this.contentEl.empty();
	}

	private rebuild(): void {
		const fuzzyMatcher = this.query
			? prepareFuzzySearch(this.query)
			: null;

		this.visibleItems = buildVisibleItems(this.categories, this.expandedGroups, fuzzyMatcher);

		// Clamp active index
		if (this.activeIndex >= this.visibleItems.length) {
			this.activeIndex = Math.max(0, this.visibleItems.length - 1);
		}

		this.renderList();
	}

	private renderList(): void {
		this.listEl.empty();

		if (this.visibleItems.length === 0) {
			this.listEl.createDiv({
				cls: 'suggestion-empty',
				text: 'No matching commands',
			});
			return;
		}

		for (let i = 0; i < this.visibleItems.length; i++) {
			this.renderItem(i);
		}
	}

	private renderItem(index: number): void {
		const item = this.visibleItems[index];
		const el = this.listEl.createDiv({
			cls: 'suggestion-item ai-organiser-command-picker-item',
			attr: { 'role': 'option', 'id': `picker-opt-${item.command.id}` }
		});
		el.dataset.category = item.categoryId;

		this.applyItemClasses(el, item, index);
		this.renderItemIcon(el, item.command.icon);
		const textEl = el.createEl('div', { cls: 'ai-organiser-command-picker-text' });
		this.renderItemName(textEl, item);
		this.renderItemBadge(textEl, item);
		this.renderItemDescription(el, textEl, item, index);
		this.renderItemChevron(el, item);
		this.renderItemCategory(el, item);
		this.applyItemTooltip(el, item);

		this.cleanups.push(
			listen(el, 'click', () => this.selectItem(index)),
			listen(el, 'mouseenter', () => { this.activeIndex = index; this.updateActiveHighlight(); })
		);
	}

	private applyItemClasses(el: HTMLElement, item: VisibleItem, index: number): void {
		if (item.kind === 'group') {
			el.addClass('is-group');
			if (this.expandedGroups.has(item.command.id)) el.addClass('is-expanded');
		}
		if (item.kind === 'sub-leaf' && !this.query) el.addClass('is-sub-command');
		if (item.command.badge) el.addClass('is-unavailable');
		if (index === this.activeIndex) {
			el.addClass('is-selected');
			this.inputEl.setAttribute('aria-activedescendant', el.id);
		}
	}

	private renderItemIcon(el: HTMLElement, iconName: string): void {
		const iconEl = el.createEl('span', { cls: 'ai-organiser-command-picker-icon' });
		const iconSvg = iconEl.createEl('span', { cls: 'ai-organiser-command-picker-icon-svg' });
		setIcon(iconSvg, iconName);
	}

	private renderItemName(textEl: HTMLElement, item: VisibleItem): void {
		if (this.query && item.kind === 'sub-leaf' && item.parentGroupName) {
			const breadcrumb = textEl.createEl('span', {
				cls: 'ai-organiser-command-picker-breadcrumb',
				text: `${item.parentGroupName} > `,
			});
			breadcrumb.createEl('span', {
				text: item.command.name,
				cls: 'ai-organiser-command-picker-name',
			});
		} else {
			textEl.createEl('span', {
				text: item.command.name,
				cls: 'ai-organiser-command-picker-name',
			});
		}
	}

	private renderItemBadge(textEl: HTMLElement, item: VisibleItem): void {
		if (!item.command.badge) return;
		const badgeText = item.command.badge === 'coming-soon' ? '⏱ Coming soon' : '⏳ Developing';
		textEl.createEl('span', {
			text: badgeText,
			cls: `ai-organiser-command-picker-badge ai-organiser-command-picker-badge-${item.command.badge}`,
		});
	}

	private renderItemDescription(el: HTMLElement, textEl: HTMLElement, item: VisibleItem, index: number): void {
		if (!item.command.description || item.kind === 'group') return;
		const descId = `picker-desc-${item.command.id}`;
		textEl.createEl('span', {
			text: item.command.description,
			cls: 'ai-organiser-command-picker-description',
			attr: { id: descId },
		});
		if (index === this.activeIndex) {
			el.setAttribute('aria-describedby', descId);
		}
	}

	private renderItemChevron(el: HTMLElement, item: VisibleItem): void {
		if (item.kind !== 'group') return;
		const chevronEl = el.createEl('span', { cls: 'ai-organiser-command-picker-chevron' });
		setIcon(chevronEl.createEl('span'), 'chevron-right');
		el.setAttribute('aria-expanded', this.expandedGroups.has(item.command.id) ? 'true' : 'false');
	}

	private renderItemCategory(el: HTMLElement, item: VisibleItem): void {
		if (item.kind === 'sub-leaf' && !this.query) return;
		const catEl = el.createEl('span', { cls: 'ai-organiser-command-picker-category' });
		const catIconEl = catEl.createEl('span', { cls: 'ai-organiser-command-picker-category-icon' });
		setIcon(catIconEl, item.categoryIcon);
		catEl.appendText(item.category);
	}

	private applyItemTooltip(el: HTMLElement, item: VisibleItem): void {
		if (!item.command.badge) return;
		const key = item.command.badge === 'coming-soon' ? 'badgeComingSoonExplanation' : 'badgeDevelopingExplanation';
		const fallback = item.command.badge === 'coming-soon'
			? 'This feature requires additional setup — check settings'
			: 'This feature requires a separate API key — configure in settings';
		setTooltip(el, this.t.modals.commandPicker[key] || fallback);
	}

	private handleKeyboard(e: KeyboardEvent): void {
		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				this.moveActive(1);
				break;
			case 'ArrowUp':
				e.preventDefault();
				this.moveActive(-1);
				break;
			case 'Enter':
				e.preventDefault();
				if (this.visibleItems.length > 0) {
					this.selectItem(this.activeIndex);
				}
				break;
			case 'Escape':
				e.preventDefault();
				this.close();
				break;
		}
	}

	private moveActive(delta: number): void {
		const len = this.visibleItems.length;
		if (len === 0) return;
		this.activeIndex = ((this.activeIndex + delta) % len + len) % len;
		this.updateActiveHighlight();
		this.scrollActiveIntoView();
	}

	private updateActiveHighlight(): void {
		const children = this.listEl.children;
		for (let i = 0; i < children.length; i++) {
			const child = children[i] as HTMLElement;
			if (i === this.activeIndex) {
				child.addClass('is-selected');
				this.inputEl.setAttribute('aria-activedescendant', child.id);
			} else {
				child.removeClass('is-selected');
			}
		}
	}

	private scrollActiveIntoView(): void {
		const activeEl = this.listEl.children[this.activeIndex] as HTMLElement;
		if (activeEl) {
			activeEl.scrollIntoView({ block: 'nearest' });
		}
	}

	private selectItem(index: number): void {
		const item = this.visibleItems[index];
		if (!item) return;

		// Badge guard — non-executable
		if (item.command.badge) {
			const msg = item.command.badge === 'coming-soon'
				? this.t.modals.commandPicker.badgeComingSoonExplanation || 'This feature requires additional setup'
				: this.t.modals.commandPicker.badgeDevelopingExplanation || 'This feature requires a separate API key';
			new Notice(msg);
			return;
		}

		// Group toggle
		if (item.kind === 'group') {
			this.toggleGroup(item, index);
			return;
		}

		// Double-invocation guard
		if (this.isExecuting) return;
		this.isExecuting = true;

		// Execute leaf command
		this.close();
		try {
			const result = item.command.callback();
			if (result instanceof Promise) {
				result.catch((error) => {
					logger.error('UI', 'Command error:', error);
					new Notice(`Command failed: ${error.message || 'Unknown error'}`);
				}).finally(() => { this.isExecuting = false; });
			} else {
				this.isExecuting = false;
			}
		} catch (error) {
			this.isExecuting = false;
			logger.error('UI', 'Command error:', error);
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			new Notice(`Command failed: ${errorMessage}`);
		}
	}

	private toggleGroup(item: VisibleItem, index: number): void {
		const groupId = item.command.id;
		const wasExpanded = this.expandedGroups.has(groupId);

		// Anchor-based scroll preservation
		const container = this.listEl;
		const anchorEl = container.children[index] as HTMLElement;
		const offsetFromTop = anchorEl
			? anchorEl.getBoundingClientRect().top - container.getBoundingClientRect().top
			: 0;

		// Toggle
		if (wasExpanded) {
			this.expandedGroups.delete(groupId);
		} else {
			this.expandedGroups.add(groupId);
		}

		// Rebuild
		this.rebuild();

		// Restore scroll position
		const newAnchorEl = container.querySelector(`#picker-opt-${groupId}`) as HTMLElement;
		if (newAnchorEl) {
			container.scrollTop = newAnchorEl.offsetTop - offsetFromTop;
		}

		// Update active index: expand → first child; collapse → the group
		const newGroupIndex = this.visibleItems.findIndex(v => v.command.id === groupId);
		if (newGroupIndex >= 0) {
			this.activeIndex = wasExpanded ? newGroupIndex : newGroupIndex + 1;
			// Clamp
			if (this.activeIndex >= this.visibleItems.length) {
				this.activeIndex = newGroupIndex;
			}
		}
		this.updateActiveHighlight();
	}
}

/**
 * Build command categories from the plugin's registered commands.
 */
export function buildCommandCategories(
	t: Translations,
	executeCommand: (commandId: string) => void
): CommandCategory[] {
	const summarizeAliases = [
		t.commands.summarizeSmart,
		t.commands.summarizeFromUrl,
		t.commands.summarizeFromPdf,
		t.commands.summarizeFromYouTube,
		t.commands.summarizeFromAudio,
		'youtube',
		'pdf',
		'url',
		'audio',
		'video',
		'web'
	];
	const relatedAliases = ['related', 'similar', 'connections', 'linked'];

	// Access descriptions from i18n (with fallbacks)
	const desc = t.modals.commandPicker.descriptions ?? {} as Record<string, string>;

	return [
		{
			id: 'active-note',
			name: t.modals.commandPicker.categoryActiveNote,
			icon: 'file-edit',
			commands: [
				{
					id: 'refine-group',
					name: t.modals.commandPicker.groupRefine,
					icon: 'sparkles',
					description: desc.refineGroup || 'AI-powered note editing and enhancement',
					aliases: ['refine', 'improve', 'translate', 'tag'],
					callback: () => {},
					subCommands: [
						{
							id: 'smart-tag',
							name: t.commands.generateTagsForCurrentNote,
							icon: 'tag',
							description: desc.smartTag || 'AI-powered tag generation using your vault taxonomy',
							aliases: [t.commands.tag, 'categorize', 'label'],
							callback: () => executeCommand('ai-organiser:smart-tag')
						},
						{
							id: 'enhance-note',
							name: t.commands.improveNote,
							icon: 'wand-2',
							description: desc.enhanceNote || 'Rewrite or improve the current note with AI',
							aliases: [t.commands.enhance, t.commands.findResources, t.commands.generateMermaidDiagram, 'rewrite'],
							callback: () => executeCommand('ai-organiser:enhance-note')
						},
						{
							id: 'smart-translate',
							name: t.commands.translate,
							icon: 'languages',
							description: desc.smartTranslate || 'Translate note, selection, or external sources',
							aliases: [t.commands.translateNote, t.commands.translateSelection, 'language', 'convert'],
							callback: () => executeCommand('ai-organiser:smart-translate')
						},
						{
							id: 'clear-tags',
							name: t.commands.clearTags,
							icon: 'eraser',
							description: desc.clearTags || 'Remove AI-generated tags from notes',
							aliases: [t.commands.clearTagsForCurrentNote, t.commands.clearTagsForCurrentFolder, t.commands.clearTagsForVault, 'remove'],
							callback: () => executeCommand('ai-organiser:clear-tags')
						},
						{
							id: 'digitise-image',
							name: t.commands.digitiseImage,
							icon: 'sparkles',
							description: desc.digitiseImage || 'Extract text from handwriting, whiteboards, or diagrams',
							aliases: ['digitise', 'digitize', 'ocr', 'handwriting', 'whiteboard', 'sketch', 'vision'],
							callback: () => executeCommand('ai-organiser:digitise-image')
						},
						{
							id: 'edit-mermaid-diagram',
							name: t.commands.editMermaidDiagram,
							icon: 'git-branch',
							description: desc.editMermaidDiagram || 'Chat-based Mermaid diagram editing with live preview',
							aliases: ['mermaid', 'diagram', 'flowchart', 'chart', 'edit diagram'],
							callback: () => executeCommand('ai-organiser:edit-mermaid-diagram')
						},
						{
							id: 'presentation-chat',
							name: t.commands.presentationChat,
							icon: 'presentation',
							description: desc.presentationChat || 'Build themed presentations from your notes',
							aliases: ['presentation', 'slides', 'pptx', 'powerpoint', 'deck', 'slideshow'],
							callback: () => executeCommand('ai-organiser:presentation-chat')
						}
					]
				},
				{
					id: 'quick-peek',
					name: t.commands.quickPeek,
					icon: 'zap',
					description: desc.quickPeek || 'Fast 1-paragraph triage of embedded sources',
					aliases: ['peek', 'quick', 'triage', 'skim', 'preview', 'sources'],
					callback: () => executeCommand('ai-organiser:quick-peek')
				},
				{
					id: 'export-group',
					name: t.modals.commandPicker.groupExport,
					icon: 'file-output',
					description: desc.exportGroup || 'Export notes as PDF, Word, PowerPoint, or flashcards',
					aliases: ['export', 'pdf', 'docx', 'pptx', 'word', 'powerpoint', 'flashcards', 'anki', 'brainscape', 'cards', 'study'],
					callback: () => {},
					subCommands: [
						{
							id: 'export-note',
							name: t.commands.exportNote,
							icon: 'file-output',
							description: desc.exportNote || 'Export as PDF, Word, or PowerPoint document',
							aliases: ['export', 'pdf', 'docx', 'pptx', 'word', 'powerpoint'],
							callback: () => executeCommand('ai-organiser:export-note')
						},
						{
							id: 'export-flashcards',
							name: t.commands.exportFlashcards,
							icon: 'layers',
							description: desc.exportFlashcards || 'Generate Anki or Brainscape flashcards from note',
							aliases: ['flashcards', 'anki', 'brainscape', 'cards', 'study', 'quiz'],
							callback: () => executeCommand('ai-organiser:export-flashcards')
						},
						{
							id: 'export-minutes-docx',
							name: t.commands.exportMinutesDocx,
							icon: 'file-text',
							description: desc.exportMinutesDocx || 'Export meeting minutes as Word document',
							aliases: ['minutes', 'meeting', 'word', 'docx'],
							callback: () => executeCommand('ai-organiser:export-minutes-docx')
						}
					]
				},
				{
					id: 'maps-group',
					name: t.modals.commandPicker.groupNoteMaps,
					icon: 'network',
					description: desc.mapsGroup || 'Visualize connections and attachments as canvases',
					aliases: ['maps', 'connections', 'investigation', 'context', 'related', 'canvas'],
					callback: () => {},
					subCommands: [
						{
							id: 'build-investigation-canvas',
							name: t.commands.mapRelatedConcepts,
							icon: 'network',
							description: desc.buildInvestigationCanvas || 'Build a canvas of semantically related notes',
							aliases: ['investigation', 'concepts', ...relatedAliases],
							callback: () => executeCommand('ai-organiser:build-investigation-canvas')
						},
						{
							id: 'build-context-canvas',
							name: t.commands.mapAttachments,
							icon: 'git-branch',
							description: desc.buildContextCanvas || 'Map all embedded sources and attachments',
							aliases: ['context', 'attachments', 'sources', 'links', 'references'],
							callback: () => executeCommand('ai-organiser:build-context-canvas')
						},
						{
							id: 'find-related',
							name: t.commands.showRelatedNotes,
							icon: 'link-2',
							description: desc.findRelated || 'Show semantically similar notes in sidebar',
							aliases: relatedAliases,
							callback: () => executeCommand('ai-organiser:find-related')
						},
						{
							id: 'insert-related-notes',
							name: t.commands.insertRelatedNotes,
							icon: 'copy-plus',
							description: desc.insertRelatedNotes || 'Insert links to related notes at cursor',
							aliases: ['insert', 'embed', ...relatedAliases],
							callback: () => executeCommand('ai-organiser:insert-related-notes')
						}
					]
				},
				{
					id: 'pending-group',
					name: t.modals.commandPicker.groupPending,
					icon: 'inbox',
					description: desc.pendingGroup || 'Manage pending content integration',
					aliases: ['pending', 'add', 'integrate', 'merge', 'embeds', 'resolve', 'extract', 'structure', 'references'],
					callback: () => {},
					subCommands: [
						{
							id: 'ensure-note-structure',
							name: t.commands.ensureNoteStructure,
							icon: 'layout-template',
							description: desc.ensureNoteStructure || 'Add references and pending integration sections to this note',
							aliases: ['structure', 'sections', 'references', 'pending', 'setup'],
							callback: () => executeCommand('ai-organiser:ensure-note-structure')
						},
						{
							id: 'add-to-pending',
							name: t.commands.addToPendingIntegration,
							icon: 'plus-circle',
							description: desc.addToPending || 'Add selected content to pending integration queue',
							aliases: ['pending', 'add', 'integration'],
							callback: () => executeCommand('ai-organiser:add-to-pending-integration')
						},
						{
							id: 'integrate-pending',
							name: t.commands.integratePendingContent,
							icon: 'git-merge',
							description: desc.integratePending || 'AI merges pending content into your note structure',
							aliases: ['integrate', 'merge', 'pending'],
							callback: () => executeCommand('ai-organiser:integrate-pending-content')
						},
						{
							id: 'resolve-embeds',
							name: t.commands.resolvePendingEmbeds,
							icon: 'scan-text',
							description: desc.resolveEmbeds || 'Extract text from embedded documents for review',
							aliases: ['embeds', 'resolve', 'extract'],
							callback: () => executeCommand('ai-organiser:resolve-pending-embeds')
						}
					]
				}
			]
		},
		{
			id: 'capture',
			name: t.modals.commandPicker.categoryCapture,
			icon: 'plus-circle',
			commands: [
				{
					id: 'smart-summarize',
					name: t.commands.summarizeSmart,
					icon: 'link',
					description: desc.smartSummarize || 'Summarize URLs, PDFs, YouTube, audio, or note content',
					aliases: summarizeAliases,
					callback: () => executeCommand('ai-organiser:smart-summarize')
				},
				{
					id: 'create-meeting-minutes',
					name: t.commands.createMeetingMinutes,
					icon: 'clipboard-list',
					description: desc.createMeetingMinutes || 'Generate structured minutes from transcripts or audio',
					aliases: ['meeting', 'minutes', 'transcript', 'notes'],
					callback: () => executeCommand('ai-organiser:create-meeting-minutes')
				},
				{
					id: 'record-audio',
					name: t.commands.recordAudio,
					icon: 'mic',
					description: desc.recordAudio || 'Record audio directly in Obsidian with optional transcription',
					aliases: ['record', 'voice', 'dictate', 'audio', 'microphone', 'memo'],
					callback: () => executeCommand('ai-organiser:record-audio')
				},
				{
					id: 'web-reader',
					name: t.commands.webReader,
					icon: 'newspaper',
					description: desc.webReader || 'Triage web links from this note — preview before reading',
					aliases: ['web', 'reader', 'triage', 'articles', 'links', 'news', 'browse'],
					callback: () => executeCommand('ai-organiser:web-reader')
				},
				{
					id: 'research-web',
					name: (t.commands as Record<string, string>).researchWeb || 'Research',
					icon: 'telescope',
					description: desc.researchWeb || 'Web research with AI search, scoring, and citations',
					aliases: ['research', 'search', 'web search', 'find sources', 'look up'],
					callback: () => executeCommand('ai-organiser:research-web')
				},
				{
					id: 'kindle-sync',
					name: t.commands.kindleSync,
					icon: 'book-open',
					description: desc.kindleSync || 'Import Kindle highlights and notes into your vault',
					aliases: ['kindle', 'highlights', 'book', 'reading', 'amazon', 'ebook'],
					callback: () => executeCommand('ai-organiser:kindle-sync')
				},
				{
					id: 'newsletter-fetch',
					name: t.commands.newsletterFetch,
					icon: 'mail',
					description: desc.newsletterFetch || 'Fetch unread newsletters from Gmail',
					aliases: ['fetch', 'newsletter', 'email', 'gmail', 'inbox', 'digest', 'news'],
					callback: () => executeCommand('ai-organiser:newsletter-fetch')
				},
				{
					id: 'new-sketch',
					name: t.commands.newSketch,
					icon: 'pencil',
					description: desc.newSketch || 'Open a sketch pad for freehand drawing',
					aliases: ['sketch', 'draw', 'whiteboard', 'handwrite', 'pen'],
					callback: () => executeCommand('ai-organiser:new-sketch')
				}
			]
		},
		{
			id: 'vault',
			name: t.modals.commandPicker.categoryVault,
			icon: 'brain',
			commands: [
				{
					id: 'ask-search-group',
					name: t.modals.commandPicker.groupAskSearch,
					icon: 'message-circle',
					description: desc.askSearchGroup || 'Chat with AI or search your vault semantically',
					aliases: ['ask', 'question', 'chat', 'rag', 'vault', 'passages', 'semantic', 'search', 'find', 'query', 'lookup'],
					callback: () => {},
					subCommands: [
						{
							id: 'chat-with-ai',
							name: t.commands.chatWithAI,
							icon: 'message-circle',
							description: desc.chatWithAI || 'Free-form AI chat with file attachments and projects',
							aliases: ['ask', 'question', 'chat', 'rag', 'vault', 'passages'],
							callback: () => executeCommand('ai-organiser:chat-with-ai')
						},
						{
							id: 'semantic-search',
							name: t.commands.searchSemanticVault,
							icon: 'search',
							description: desc.semanticSearch || 'Find notes by meaning, not just keywords',
							aliases: ['semantic', 'search', 'find', 'query', 'lookup'],
							callback: () => executeCommand('ai-organiser:semantic-search')
						}
					]
				},
				{
					id: 'visualize-group',
					name: t.modals.commandPicker.groupVaultVisualizations,
					icon: 'eye',
					description: desc.visualizeGroup || 'Visual overviews of vault structure and tags',
					aliases: ['cluster', 'group', 'tag', 'graph', 'visualization', 'map', 'bases', 'dashboard', 'view', 'organize'],
					callback: () => {},
					subCommands: [
						{
							id: 'build-cluster-canvas',
							name: t.commands.groupNotesByTag,
							icon: 'boxes',
							description: desc.buildClusterCanvas || 'Group notes by tag into a clustered canvas',
							aliases: ['cluster', 'group', 'tag', 'organize'],
							callback: () => executeCommand('ai-organiser:build-cluster-canvas')
						},
						{
							id: 'show-tag-network',
							name: t.commands.visualizeTagGraph,
							icon: 'network',
							description: desc.showTagNetwork || 'Interactive D3 graph of tag relationships',
							aliases: ['graph', 'visualization', 'map', 'tags'],
							callback: () => executeCommand('ai-organiser:show-tag-network')
						},
						{
							id: 'create-dashboard',
							name: t.commands.createBasesDashboard,
							icon: 'layout-dashboard',
							description: desc.createDashboard || 'Create an Obsidian Bases dashboard for a folder',
							aliases: ['bases', 'dashboard', 'view'],
							callback: () => executeCommand('ai-organiser:create-bases-dashboard')
						},
						{
							id: 'collect-all-tags',
							name: t.commands.collectAllTags,
							icon: 'tags',
							description: desc.collectAllTags || 'Export every tag in the vault to a note',
							aliases: ['tags', 'export', 'collect', 'all', 'list'],
							callback: () => executeCommand('ai-organiser:collect-all-tags')
						}
					]
				},
				// Vault Hygiene flattened — single-child group promoted to standalone
				{
					id: 'find-embeds',
					name: t.commands.findEmbeds,
					icon: 'hard-drive',
					description: desc.findEmbeds || 'Scan vault for embedded files, orphans, and references',
					aliases: ['hygiene', 'embeds', 'find', 'attachments', 'orphan', 'files'],
					callback: () => executeCommand('ai-organiser:find-embeds')
				}
			]
		},
		{
			id: 'tools',
			name: t.modals.commandPicker.categoryTools,
			icon: 'settings',
			commands: [
				{
					id: 'notebooklm-group',
					name: t.modals.commandPicker.groupNotebookLM,
					icon: 'book-open',
					description: desc.notebookLMGroup || 'Export notes for Google NotebookLM',
					aliases: ['notebooklm', 'export', 'pack', 'toggle', 'select', 'clear', 'folder'],
					callback: () => {},
					subCommands: [
						{
							id: 'notebooklm-export',
							name: t.commands.notebookLMExport,
							icon: 'file-output',
							description: desc.notebookLMExport || 'Export selected notes as NotebookLM source pack',
							aliases: ['notebooklm', 'export', 'pdf', 'pack'],
							callback: () => executeCommand('ai-organiser:notebooklm-export')
						},
						{
							id: 'notebooklm-toggle',
							name: t.commands.notebookLMToggle,
							icon: 'bookmark-plus',
							description: desc.notebookLMToggle || 'Toggle current note in NotebookLM selection',
							aliases: ['notebooklm', 'toggle', 'select'],
							callback: () => executeCommand('ai-organiser:notebooklm-toggle-selection')
						},
						{
							id: 'notebooklm-clear',
							name: t.commands.notebookLMClear,
							icon: 'x-circle',
							description: desc.notebookLMClear || 'Clear all NotebookLM selections',
							aliases: ['notebooklm', 'clear', 'selection'],
							callback: () => executeCommand('ai-organiser:notebooklm-clear-selection')
						},
						{
							id: 'notebooklm-open-folder',
							name: t.commands.notebookLMOpenFolder,
							icon: 'folder-open',
							description: desc.notebookLMOpenFolder || 'Open the NotebookLM export folder',
							aliases: ['notebooklm', 'export', 'folder'],
							callback: () => executeCommand('ai-organiser:notebooklm-open-export-folder')
						}
					]
				}
			]
		}
	];
}
