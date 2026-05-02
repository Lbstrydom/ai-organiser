/**
 * Command Picker Modal
 * A unified modal for accessing all AI Organiser commands organized by category.
 * Uses a custom Modal with inline tree expansion and Obsidian's fuzzy search.
 */

import { App, Modal, Notice, prepareFuzzySearch, setIcon, setTooltip } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { logger } from '../../utils/logger';
import { Translations } from '../../i18n/types';
import { listen } from '../utils/domUtils';
import {
	type VisibleItem,
	buildVisibleItems,
	flattenSingleChildGroups,
} from './commandPickerViewModel';
import { checkRequirement, buildContext, legacyHomeAliases, type RequirementContext } from './pickerRequirements';

export interface CommandCategory {
	id: string;
	name: string;
	icon: string;
	commands: PickerCommand[];
}

/** Render-time precondition for a command — drives the requirement chip. */
export type RequirementKind =
	| 'none'             // always available
	| 'active-note'      // requires an open .md file
	| 'selection'        // requires a non-empty editor selection
	| 'vault'            // requires ≥1 .md file in the vault
	| 'semantic-search'; // requires enableSemanticSearch + vectorStore

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
	/** Render-time precondition — see `pickerRequirements.ts`. Defaults to 'none'. */
	requires?: RequirementKind;
	/** Cross-listing canonical home for search dedup chip (Gemini-G2). */
	canonicalCategoryId?: string;
	/** Legacy taxonomy homes — drives backward-compat alias derivation. */
	legacyHomes?: string[];
}

export class CommandPickerModal extends Modal {
	private readonly categories: CommandCategory[];
	private readonly t: Translations;
	/** Modal-lifetime listeners (input box, keydown). Cleared in onClose(). */
	private readonly cleanups: (() => void)[] = [];
	/** Per-render row listeners. Cleared in `rebuild()` BEFORE the list is
	 *  emptied, so stale closures don't accumulate (audit M8). */
	private rowCleanups: (() => void)[] = [];

	// State
	private readonly expandedGroups = new Set<string>();
	/** Categories the user has expanded. Hydrated from
	 *  `settings.pickerExpandedCategoryIds`; written back on every
	 *  toggle so the preference persists across modal opens. */
	private readonly expandedCategories: Set<string>;
	private activeIndex = 0;
	private query = '';
	private visibleItems: VisibleItem[] = [];
	private isExecuting = false;
	/** Cached requirement context for the modal's lifetime. Built lazily on
	 *  first render; reused across keystrokes so getFiles() doesn't scan the
	 *  vault on every input event (audit M12). selectItem() rebuilds fresh
	 *  to catch any state change between render and click (R2 H2). */
	private cachedRequirementCtx: RequirementContext | null = null;

	// DOM refs
	private inputEl!: HTMLInputElement;
	private listEl!: HTMLElement;

	constructor(
		app: App,
		private readonly plugin: AIOrganiserPlugin,
		t: Translations,
		categories: CommandCategory[],
	) {
		super(app);
		this.t = t;
		this.categories = flattenSingleChildGroups(categories);
		this.modalEl.addClass('ai-organiser-command-picker-modal');
		// Hydrate expanded-categories from persisted settings. Falls back
		// to ['essentials'] only when settings haven't been written yet.
		const persisted = this.plugin.settings.pickerExpandedCategoryIds;
		this.expandedCategories = new Set<string>(
			persisted && persisted.length > 0 ? persisted : ['essentials'],
		);
	}

	/** Build a fresh `RequirementContext` from current app state. Called
	 *  once per modal-session render (cached after first call — audit M12)
	 *  AND once per click in selectItem (R2 H2 — never cached across
	 *  render/click boundary). Uses `getMarkdownFiles()` which reads from
	 *  Obsidian's pre-built markdown cache (cheaper than `getFiles()` +
	 *  filter). Both methods allocate an array eagerly; perf hotness is
	 *  bounded by the `cachedRequirementCtx` once-per-modal-session caching. */
	private buildRequirementContext(): RequirementContext {
		return buildContext({
			activeFile: this.app.workspace.getActiveFile(),
			editor: this.app.workspace.activeEditor?.editor ?? null,
			hasMarkdownFiles: this.app.vault.getMarkdownFiles().length > 0,
			enableSemanticSearch: !!this.plugin.settings.enableSemanticSearch,
			hasVectorStore: !!this.plugin.vectorStore,
		});
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
		// Audit M8: flush both row + modal-lifetime listeners.
		for (const cleanup of this.rowCleanups) cleanup();
		this.rowCleanups.length = 0;
		for (const cleanup of this.cleanups) cleanup();
		this.cleanups.length = 0;
		this.cachedRequirementCtx = null;
		this.contentEl.empty();
	}

	private rebuild(): void {
		// Audit M8: drop stale per-row listeners BEFORE the DOM is wiped.
		// Modal-lifetime cleanups (input box, keydown) live in `this.cleanups`
		// and are NOT touched here.
		for (const cleanup of this.rowCleanups) cleanup();
		this.rowCleanups.length = 0;

		const fuzzyMatcher = this.query
			? prepareFuzzySearch(this.query)
			: null;

		this.visibleItems = buildVisibleItems(
			this.categories, this.expandedGroups, fuzzyMatcher, this.expandedCategories,
		);

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
				text: this.t.modals.commandPicker.emptyState,
			});
			return;
		}

		// Audit M12: build requirement context ONCE per modal session and
		// reuse across keystrokes. Vault scan + settings reads are not
		// per-keystroke work. selectItem() rebuilds fresh on click (R2 H2)
		// to catch any state change between render and execution.
		this.cachedRequirementCtx ??= this.buildRequirementContext();
		const ctx = this.cachedRequirementCtx;
		for (let i = 0; i < this.visibleItems.length; i++) {
			this.renderItem(i, ctx);
		}
	}

	private renderItem(index: number, ctx: RequirementContext): void {
		const item = this.visibleItems[index];
		// Audit M9: cross-listed commands (chat/search/peek) render twice in
		// browse mode — option IDs must be unique per RENDERED row, not per
		// command, so ARIA references resolve to the correct DOM node. The
		// row index is stable across the lifetime of one render pass.
		const el = this.listEl.createDiv({
			cls: 'suggestion-item ai-organiser-command-picker-item',
			attr: { 'role': 'option', 'id': `picker-opt-${item.command.id}-${index}` },
		});
		el.dataset.category = item.categoryId;

		this.applyItemClasses(el, item, index, ctx);
		this.renderItemIcon(el, item.command.icon);
		const textEl = el.createEl('div', { cls: 'ai-organiser-command-picker-text' });
		this.renderItemName(textEl, item);
		this.renderItemBadge(textEl, item);
		this.renderItemDescription(el, textEl, item, index);
		// Metadata sibling — chip, category, chevron live here as siblings
		// of textEl. Stops chips from wrapping into the description on
		// narrow widths (audit R1 M3).
		const metaEl = el.createEl('div', { cls: 'ai-organiser-command-picker-meta' });
		this.renderItemRequires(metaEl, item, ctx, index);
		this.renderItemCategory(metaEl, item);
		this.renderItemChevron(metaEl, item);
		this.applyItemTooltip(el, item, ctx);

		// Per-row listeners — go into rowCleanups so they're released on
		// every rebuild (audit M8). Modal-lifetime listeners live in
		// `this.cleanups` and are released only in onClose().
		this.rowCleanups.push(
			listen(el, 'click', () => this.selectItem(index)),
			listen(el, 'mouseenter', () => { this.activeIndex = index; this.updateActiveHighlight(); }),
		);
	}

	private applyItemClasses(el: HTMLElement, item: VisibleItem, index: number, ctx: RequirementContext): void {
		// Requirement gate first — render-time disable + a11y describedby.
		const reqState = checkRequirement(item.command.requires, ctx, this.t);
		if (!reqState.met) {
			el.addClass('is-gated');
			el.setAttribute('aria-disabled', 'true');
			el.setAttribute('aria-describedby', `picker-req-${item.command.id}-${index}`);
		}
		if (item.kind === 'group') {
			el.addClass('is-group');
			if (this.expandedGroups.has(item.command.id)) el.addClass('is-expanded');
		}
		if (item.kind === 'category-header') {
			el.addClass('is-category-header');
			if (item.categoryExpanded) el.addClass('is-expanded');
			el.setAttribute('aria-expanded', item.categoryExpanded ? 'true' : 'false');
			el.setAttribute('role', 'button');
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
			return;
		}
		textEl.createEl('span', {
			text: item.command.name,
			cls: 'ai-organiser-command-picker-name',
		});
		// Append leaf count hint to category headers — gives the user a
		// scent of what's inside before they click to expand.
		if (item.kind === 'category-header' && typeof item.categoryLeafCount === 'number') {
			textEl.createEl('span', {
				cls: 'ai-organiser-command-picker-category-count',
				text: ` (${item.categoryLeafCount})`,
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
		if (item.kind === 'group') {
			const chevronEl = el.createEl('span', { cls: 'ai-organiser-command-picker-chevron' });
			setIcon(chevronEl.createEl('span'), 'chevron-right');
			el.setAttribute('aria-expanded', this.expandedGroups.has(item.command.id) ? 'true' : 'false');
			return;
		}
		if (item.kind === 'category-header') {
			const chevronEl = el.createEl('span', { cls: 'ai-organiser-command-picker-chevron' });
			setIcon(chevronEl.createEl('span'), 'chevron-right');
			// aria-expanded is set in applyItemClasses for header rows.
		}
	}

	private renderItemCategory(el: HTMLElement, item: VisibleItem): void {
		if (item.kind === 'sub-leaf' && !this.query) return;
		const catEl = el.createEl('span', { cls: 'ai-organiser-command-picker-category' });
		const catIconEl = catEl.createEl('span', { cls: 'ai-organiser-command-picker-category-icon' });
		setIcon(catIconEl, item.categoryIcon);
		catEl.appendText(item.category);
	}

	/** Render the requires-chip into the metadata sibling — only when the
	 *  requirement is unmet (Hick's law: don't show a chip for satisfied
	 *  preconditions). The chip carries an icon + short label + sr-only
	 *  full reason for screen readers (matches the row's aria-describedby). */
	private renderItemRequires(metaEl: HTMLElement, item: VisibleItem, ctx: RequirementContext, index: number): void {
		const reqState = checkRequirement(item.command.requires, ctx, this.t);
		if (reqState.met) return;
		const chip = metaEl.createEl('span', {
			cls: 'ai-organiser-command-picker-requires',
		});
		const iconEl = chip.createEl('span', { cls: 'ai-organiser-command-picker-requires-icon' });
		setIcon(iconEl, reqState.chipIcon!);
		chip.createEl('span', {
			cls: 'ai-organiser-command-picker-requires-text',
			text: reqState.chipText!,
		});
		// Hidden reason for assistive tech — id matches the row's
		// aria-describedby in applyItemClasses. Includes row index so
		// cross-listed commands emit unique IDs (audit Gemini-r1 M1).
		const reqId = `picker-req-${item.command.id}-${index}`;
		chip.createEl('span', {
			cls: 'sr-only',
			attr: { id: reqId },
			text: reqState.reason!,
		});
	}

	private applyItemTooltip(el: HTMLElement, item: VisibleItem, ctx: RequirementContext): void {
		// Gated row → tooltip is the requirement reason (full text). This
		// runs before the badge tooltip so a gated badge-row prefers the
		// gate explanation.
		const reqState = checkRequirement(item.command.requires, ctx, this.t);
		if (!reqState.met) {
			setTooltip(el, reqState.reason!);
			return;
		}
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

		// Category-header toggle — show/hide the category's contents.
		if (item.kind === 'category-header') {
			this.toggleCategory(item.categoryId, index);
			return;
		}

		// Group toggle — fires before requirement gate. A group's children
		// have their own per-leaf requirements; the group itself is just
		// expand/collapse, not an executable.
		if (item.kind === 'group') {
			this.toggleGroup(item, index);
			return;
		}

		// Requirement gate — rebuild context FRESH (not the render-time
		// snapshot). User could have changed active note / opened editor /
		// updated settings between render and click (audit R2 H2).
		const ctx = this.buildRequirementContext();
		const reqState = checkRequirement(item.command.requires, ctx, this.t);
		if (!reqState.met) {
			new Notice(reqState.reason!);
			return;
		}

		// Badge guard — non-executable
		if (item.command.badge) {
			const msg = item.command.badge === 'coming-soon'
				? this.t.modals.commandPicker.badgeComingSoonExplanation || 'This feature requires additional setup'
				: this.t.modals.commandPicker.badgeDevelopingExplanation || 'This feature requires a separate API key';
			new Notice(msg);
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

	/** Toggle a category's expansion. Preserves scroll position relative to
	 *  the clicked header so expand/collapse doesn't jolt the viewport. */
	private toggleCategory(categoryId: string, index: number): void {
		const wasExpanded = this.expandedCategories.has(categoryId);
		const container = this.listEl;
		const anchorEl = container.children[index] as HTMLElement;
		const offsetFromTop = anchorEl
			? anchorEl.getBoundingClientRect().top - container.getBoundingClientRect().top
			: 0;

		if (wasExpanded) this.expandedCategories.delete(categoryId);
		else this.expandedCategories.add(categoryId);

		// Persist preference so the next picker open respects it.
		this.plugin.settings.pickerExpandedCategoryIds = [...this.expandedCategories];
		void this.plugin.saveSettings();

		this.rebuild();

		const newAnchorEl = container.querySelector(
			`[id^="picker-opt-__category__${CSS.escape(categoryId)}-"]`,
		) as HTMLElement;
		if (newAnchorEl) {
			container.scrollTop = newAnchorEl.offsetTop - offsetFromTop;
		}

		// Move active index to the header (or the first child after expand)
		const newHeaderIndex = this.visibleItems.findIndex(
			v => v.kind === 'category-header' && v.categoryId === categoryId,
		);
		if (newHeaderIndex >= 0) {
			this.activeIndex = wasExpanded ? newHeaderIndex : newHeaderIndex + 1;
			if (this.activeIndex >= this.visibleItems.length) this.activeIndex = newHeaderIndex;
		}
		this.updateActiveHighlight();
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

		// Restore scroll position — group IDs are unique (groups never
		// cross-list) so a prefix-match on `#picker-opt-${groupId}-` finds
		// the single rendered group row regardless of its row index.
		const newAnchorEl = container.querySelector(
			`[id^="picker-opt-${CSS.escape(groupId)}-"]`,
		) as HTMLElement;
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
 * Build command categories — output-anchored taxonomy.
 *
 * 5 categories: essentials / create / refine / find / manage. Create has
 * verb-anchored sub-groups (Write, Visualise) plus 3 direct leaves (audit
 * 2026-05-02 user feedback — flat 14 was too long). Find has Discover +
 * Audit-vault sub-groups. Cross-listing: AI Chat + Vault search live in
 * Essentials AND Find; Quick peek lives in Essentials AND Refine. Same
 * callback, two browse rows; search-mode dedupes by command.id.
 *
 * Essentials is user-configurable: if `essentialsCommandIds` is provided
 * (max 5 entries), the Essentials category is built from those command
 * objects looked up across every other category. Empty / undefined ⇒
 * use the static default (chat / search / quick-peek).
 *
 * Plan: docs/completed/command-picker-output-anchored*.md (5 docs, locked
 * after 3 GPT audit rounds + 3 Gemini final reviews — APPROVE).
 */
/** Find a leaf command by id across an arbitrary category tree. Searches
 *  top-level commands first, then descends into `subCommands`. Returns
 *  the SAME object reference (preserves cross-listing identity for the
 *  search-mode dedup logic). Used by `buildCommandCategories` to resolve
 *  user-configurable Essentials. */
function findLeafByIdInCategories(
	id: string,
	categories: readonly CommandCategory[],
): PickerCommand | null {
	for (const cat of categories) {
		for (const c of cat.commands) {
			if (c.id === id) return c;
			if (c.subCommands) {
				const sub = c.subCommands.find(s => s.id === id);
				if (sub) return sub;
			}
		}
	}
	return null;
}

export function buildCommandCategories(
	t: Translations,
	executeCommand: (commandId: string) => void,
	essentialsCommandIds: readonly string[] = [],
): CommandCategory[] {
	const summarizeAliases = [
		t.commands.summarizeSmart,
		t.commands.summarizeFromUrl,
		t.commands.summarizeFromPdf,
		t.commands.summarizeFromYouTube,
		t.commands.summarizeFromAudio,
		'youtube', 'pdf', 'url', 'audio', 'video', 'web',
	];
	const relatedAliases = ['related', 'similar', 'connections', 'linked'];
	const desc = t.modals.commandPicker.descriptions ?? {} as Record<string, string>;

	// Helper — terse leaf builder. legacyHomes drives backward-compat
	// alias derivation (audit R3 M3 + Gemini-G4) — moved commands keep
	// their old taxonomy terms searchable without manual sprinkling.
	const cmd = (
		id: string, name: string, icon: string, requires: RequirementKind,
		description: string, aliases: string[] = [], legacyHomes: string[] = [],
	): PickerCommand => ({
		id, name, icon,
		callback: () => executeCommand(`ai-organiser:${id}`),
		requires, description,
		aliases: [...aliases, ...legacyHomes.flatMap(legacyHomeAliases)],
		legacyHomes,
	});

	// Cross-listings — defined ONCE, referenced TWICE (browse).
	// canonicalCategoryId tells search-mode dedup which placement's chip
	// to show (audit Gemini-G2 — explicit field, not array order).
	const chatLeaf: PickerCommand = {
		...cmd('chat-with-ai', t.commands.chatWithAI, 'message-circle', 'none',
			desc.chatWithAI || 'Free-form AI chat with file attachments and projects',
			['ask', 'question', 'chat', 'rag', 'passages']),
		canonicalCategoryId: 'essentials',
	};
	const searchLeaf: PickerCommand = {
		...cmd('semantic-search', t.commands.searchSemanticVault, 'search', 'semantic-search',
			desc.semanticSearch || 'Find notes by meaning, not just keywords',
			['semantic', 'search', 'find', 'query', 'lookup']),
		canonicalCategoryId: 'essentials',
	};
	const peekLeaf: PickerCommand = {
		...cmd('quick-peek', t.commands.quickPeek, 'zap', 'active-note',
			desc.quickPeek || 'Fast 1-paragraph triage of embedded sources',
			['peek', 'quick', 'triage', 'skim', 'preview', 'sources']),
		canonicalCategoryId: 'essentials',
	};

	const nonEssentialCategories: CommandCategory[] = [
		{
			id: 'create',
			name: t.modals.commandPicker.categoryCreate,
			icon: 'sparkles',
			commands: [
				// Verb-anchored sub-groups (depth 1 — collapsed by default).
				// User feedback 2026-05-02: 14 leaves was too long to scan;
				// each sub-group is a discoverable verb-anchored bucket.
				{
					id: 'create-write',
					name: t.modals.commandPicker.groupCreateWrite,
					icon: 'pen-line',
					description: t.modals.commandPicker.descriptions.groupCreateWrite,
					callback: () => {},
					subCommands: [
						cmd('smart-summarize', t.commands.summarizeSmart, 'file-text', 'none',
							desc.smartSummarize || 'Summarize content from URL, PDF, YouTube, or audio',
							[...summarizeAliases, 'create', 'summary'], ['capture']),
						cmd('create-meeting-minutes', t.commands.createMeetingMinutes, 'clipboard-list', 'none',
							desc.createMeetingMinutes || 'Generate structured minutes from a transcript',
							['minutes', 'meeting', 'transcript'], ['capture']),
						cmd('smart-translate', t.commands.translate, 'languages', 'active-note',
							desc.smartTranslate || 'Translate the active note into another language',
							['translate', 'language', 'locale', t.commands.translateNote, t.commands.translateSelection],
							['active-note-refine']),
						cmd('export-note', t.commands.exportNote, 'file-output', 'active-note',
							desc.exportNote || 'Export as PDF, Word, or PowerPoint document',
							['pdf', 'docx', 'pptx', 'word', 'powerpoint'], ['active-note-export']),
						cmd('export-minutes-docx', t.commands.exportMinutesDocx, 'file-text', 'active-note',
							desc.exportMinutesDocx || 'Export meeting minutes as Word document',
							['minutes', 'meeting', 'word', 'docx'], ['active-note-export']),
					],
				},
				{
					id: 'create-visualise',
					name: t.modals.commandPicker.groupCreateVisualise,
					icon: 'palette',
					description: t.modals.commandPicker.descriptions.groupCreateVisualise,
					callback: () => {},
					subCommands: [
						cmd('presentation-chat', t.commands.presentationChat, 'presentation', 'active-note',
							desc.presentationChat || 'Generate a structured slide deck from this note',
							['slides', 'presentation', 'deck', 'pitch'], ['active-note-refine']),
						cmd('edit-mermaid-diagram', t.commands.editMermaidDiagram, 'workflow', 'active-note',
							desc.editMermaidDiagram || 'Conversational Mermaid diagram editing',
							['mermaid', 'diagram', 'flowchart'], ['active-note-refine']),
						cmd('new-sketch', t.commands.newSketch, 'pencil', 'none',
							desc.newSketch || 'Open the sketch pad to draw a quick sketch',
							['sketch', 'draw', 'whiteboard'], ['capture']),
						cmd('build-investigation-canvas', t.commands.buildInvestigationCanvas, 'compass', 'active-note',
							desc.buildInvestigationCanvas || 'Build an investigation canvas from related notes',
							['canvas', 'investigate', 'board'], ['active-note-maps']),
						cmd('build-context-canvas', t.commands.buildContextCanvas, 'layout-grid', 'active-note',
							desc.buildContextCanvas || 'Build a context canvas from embedded sources',
							['canvas', 'context', 'board'], ['active-note-maps']),
						cmd('build-cluster-canvas', t.commands.buildClusterCanvas, 'network', 'vault',
							desc.buildClusterCanvas || 'Build a cluster canvas grouping vault notes by tag',
							['canvas', 'cluster', 'board'], ['vault-visualize']),
					],
				},
				// Direct leaves — single-action verbs.
				cmd('narrate-note', t.commands.narrateNote, 'audio-lines', 'active-note',
					desc.narrateNote || 'Convert this note to a spoken-audio MP3',
					['narrate', 'audio', 'tts', 'listen', 'voice', 'speak', 'podcast', 'mp3'],
					['active-note-export']),
				cmd('export-flashcards', t.commands.exportFlashcards, 'layers', 'active-note',
					desc.exportFlashcards || 'Generate Anki or Brainscape flashcards from note',
					['flashcards', 'anki', 'brainscape', 'cards', 'study', 'quiz'],
					['active-note-export']),
				cmd('smart-tag', t.commands.generateTagsForCurrentNote, 'tag', 'active-note',
					desc.smartTag || 'Generate tags for the active note',
					['tag', 'tagging', 'categorise', t.commands.tag], ['active-note-refine']),
			],
		},
		{
			id: 'refine',
			name: t.modals.commandPicker.categoryRefine,
			icon: 'wand-2',
			commands: [
				cmd('enhance-note', t.commands.improveNote, 'sparkles', 'active-note',
					desc.enhanceNote || 'Improve the active note with AI suggestions',
					['improve', 'polish', 'enhance', 'rewrite', t.commands.enhance],
					['active-note-refine']),
				{
					id: 'refine-pending',
					name: t.modals.commandPicker.groupRefinePending,
					icon: 'merge',
					description: t.modals.commandPicker.descriptions.groupRefinePending,
					callback: () => {},
					subCommands: [
						cmd('integrate-pending-content', t.commands.integratePendingContent, 'merge', 'active-note',
							desc.integratePending || 'Integrate pending content into the active note',
							['integrate', 'merge'], ['active-note-pending']),
						cmd('add-to-pending-integration', t.commands.addToPendingIntegration, 'plus-square', 'active-note',
							desc.addToPending || 'Add the active note to the pending-integration queue',
							['add'], ['active-note-pending']),
						cmd('resolve-pending-embeds', t.commands.resolvePendingEmbeds, 'link', 'active-note',
							desc.resolveEmbeds || 'Resolve embedded content references in the active note',
							['embeds', 'resolve', 'expand'], ['active-note-pending']),
					],
				},
				cmd('digitise-image', t.commands.digitiseImage, 'scan', 'active-note',
					desc.digitiseImage || 'Digitise a handwritten or whiteboard image',
					['digitise', 'digitize', 'ocr', 'image', 'scan'], ['active-note-refine']),
				cmd('clear-tags', t.commands.clearTags, 'eraser', 'active-note',
					desc.clearTags || 'Clear tags from the active note',
					['clear', 'tags', 'reset'], ['active-note-refine']),
				peekLeaf,
			],
		},
		{
			id: 'find',
			name: t.modals.commandPicker.categoryFind,
			icon: 'search',
			commands: [
				// Cross-listed from Essentials — keep at top so users who jumped
				// straight to "Find" still see the search verbs.
				chatLeaf,
				searchLeaf,
				{
					id: 'find-discover',
					name: t.modals.commandPicker.groupFindDiscover,
					icon: 'compass',
					description: t.modals.commandPicker.descriptions.groupFindDiscover,
					callback: () => {},
					subCommands: [
						cmd('web-reader', t.commands.webReader, 'newspaper', 'active-note',
							desc.webReader || 'Triage web URLs in the active note',
							['web', 'reader', 'triage', 'article'], ['capture']),
						cmd('research-web', t.commands.researchWeb, 'globe', 'none',
							desc.researchWeb || 'Web research with citations',
							['research', 'web', 'citations'], ['capture']),
						cmd('find-related', t.commands.findResources, 'compass', 'active-note',
							desc.findRelated || 'Find related resources for the active note',
							[...relatedAliases, 'find', 'resources'], ['active-note-maps']),
						cmd('insert-related-notes', t.commands.insertRelatedNotes, 'list-tree', 'active-note',
							desc.insertRelatedNotes || 'Insert related notes into the active note',
							[...relatedAliases, 'insert'], ['active-note-maps']),
					],
				},
				{
					id: 'find-audit',
					name: t.modals.commandPicker.groupFindAudit,
					icon: 'shield-check',
					description: t.modals.commandPicker.descriptions.groupFindAudit,
					callback: () => {},
					subCommands: [
						cmd('find-embeds', t.commands.findEmbeds, 'puzzle', 'vault',
							desc.findEmbeds || 'Find every embedded asset in the vault',
							['embeds', 'find', 'hygiene'], ['vault']),
						cmd('show-tag-network', t.commands.showTagNetwork, 'network', 'vault',
							desc.showTagNetwork || 'Visualise the tag network for the vault',
							['tags', 'network', 'graph'], ['vault-visualize']),
						cmd('collect-all-tags', t.commands.collectAllTags, 'tags', 'vault',
							desc.collectAllTags || 'Collect every tag in the vault into a list',
							['tags', 'collect', 'list'], ['vault-visualize']),
					],
				},
			],
		},
		{
			id: 'manage',
			name: t.modals.commandPicker.categoryManage,
			icon: 'wrench',
			commands: [
				{
					id: 'manage-sync',
					name: t.modals.commandPicker.groupManageSync,
					icon: 'rss',
					description: t.modals.commandPicker.descriptions.groupManageSync,
					callback: () => {},
					subCommands: [
						cmd('kindle-sync', t.commands.kindleSync, 'book-open', 'none',
							desc.kindleSync || 'Sync Kindle highlights into the vault',
							['kindle', 'sync', 'highlights'], ['capture']),
						cmd('newsletter-fetch', t.commands.newsletterFetch, 'mail', 'none',
							desc.newsletter || 'Fetch newsletters from Gmail and triage them',
							['newsletter', 'digest', 'fetch', 'recurring'], ['capture']),
					],
				},
				{
					id: 'manage-audio',
					name: t.modals.commandPicker.groupManageAudio,
					icon: 'mic',
					description: t.modals.commandPicker.descriptions.groupManageAudio,
					callback: () => {},
					subCommands: [
						cmd('record-audio', t.commands.recordAudio, 'mic', 'none',
							desc.recordAudio || 'Record audio directly in Obsidian',
							['record', 'voice', 'dictate', 'audio', 'microphone'], ['capture']),
						cmd('play-narration', t.commands.playNarration, 'play-circle', 'active-note',
							desc.playNarration || 'Open mp3 in a player with speed and skip controls',
							['play', 'audio', 'speed', 'skip', 'mp3'], ['active-note-export']),
					],
				},
				{
					id: 'manage-bases',
					name: t.modals.commandPicker.groupManageBases,
					icon: 'database',
					description: t.modals.commandPicker.descriptions.groupManageBases,
					callback: () => {},
					subCommands: [
						cmd('upgrade-metadata', t.commands.upgradeToBases, 'database', 'vault',
							desc.upgradeMetadata || 'Upgrade vault notes to Bases metadata format',
							['migrate', 'upgrade', 'bases', 'metadata']),
						cmd('upgrade-folder-metadata', t.commands.upgradeFolderToBases, 'folder-sync', 'active-note',
							desc.upgradeFolderMetadata || 'Upgrade current folder notes to Bases metadata',
							['migrate', 'folder', 'upgrade', 'bases']),
						cmd('create-bases-dashboard', t.commands.createBasesDashboard, 'gauge', 'vault',
							desc.createDashboard || 'Create a Bases dashboard for the vault',
							['dashboard', 'bases', 'create'], ['vault-visualize']),
					],
				},
				cmd('notebooklm-export', t.commands.notebookLMExport, 'book-open', 'vault',
					desc.notebookLMExport || 'Export selected notes as NotebookLM source pack',
					['notebooklm', 'export', 'pdf', 'pack'], ['tools']),
			],
		},
	];

	// Resolve the user's Essentials selection (max 5). Empty / undefined →
	// fall back to the static default (chat / search / quick-peek). Look up
	// each ID across nonEssentialCategories so the SAME object reference is
	// pushed into Essentials too — preserves cross-listing semantics for
	// search dedup. IDs not found are silently skipped.
	const customEssentials = essentialsCommandIds
		.slice(0, 5)
		.map(id => findLeafByIdInCategories(id, nonEssentialCategories))
		.filter((leaf): leaf is PickerCommand => leaf !== null);
	const essentialCommands = customEssentials.length > 0
		? customEssentials
		: [chatLeaf, searchLeaf, peekLeaf];

	return [
		{
			id: 'essentials',
			name: t.modals.commandPicker.categoryEssentials,
			icon: 'star',
			commands: essentialCommands,
		},
		...nonEssentialCategories,
	];
}
