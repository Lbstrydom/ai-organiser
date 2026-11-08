/**
 * Command Picker Modal
 * A unified modal for accessing all AI Organiser commands organized by category.
 * Uses a custom Modal with inline tree expansion and Obsidian's fuzzy search.
 */

import { App, Modal, Notice, Platform, prepareFuzzySearch, setIcon, setTooltip } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { logger } from '../../utils/logger';
import { Translations } from '../../i18n/types';
import { listen } from '../utils/domUtils';
import {
	type VisibleItem,
	buildVisibleItems,
	flattenSingleChildGroups,
	filterSectionByStage,
	stageChipFor,
} from './commandPickerViewModel';
import { checkLeaf, buildContext, legacyHomeAliases, type RequirementContext } from './pickerRequirements';
import type { FeatureId } from '../../core/features';
import { ACTIONS, ACTION_BY_ID, DEFAULT_PINNED, type ActionDef, type RequirementKind } from '../../core/actionRegistry';
import { actionFeatureOn } from '../../core/actionAvailability';
import { WORKFLOW_STAGES, type WorkflowStage } from '../../core/workflowStages';
import { isFeatureEnabled } from '../../services/featureService';

export interface CommandCategory {
	id: string;
	name: string;
	icon: string;
	commands: PickerCommand[];
}

export type { RequirementKind } from '../../core/actionRegistry';

export interface PickerCommand {
	id: string;
	name: string;
	icon: string;
	description?: string;
	aliases?: string[];
	callback: () => void | Promise<void>;
	/**
	 * Owning feature (FT-4). REQUIRED on every executable LEAF — an untagged leaf
	 * would default-show and leak a disabled feature. Group containers (rows with
	 * `subCommands`) are structural, not executable, and omit it; the completeness
	 * test (`LEAF_FEATURE`) asserts every leaf carries one. Cross-listed leaves keep
	 * their single canonical `feature` — the cross-listing is a placement, not a 2nd owner.
	 */
	feature?: FeatureId;
	/**
	 * Workflow stage this leaf belongs to (unified-feature-taxonomy). Declared
	 * assertion metadata: it MUST equal the id of the (non-`pinned`) category the leaf is
	 * hand-placed in — the cross-surface consistency test enforces this. Optional on the
	 * type because group-container rows (with `subCommands`/no `feature`) carry no stage;
	 * the test requires it on every executable leaf (parallel to `feature`).
	 */
	stage?: WorkflowStage;
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
	/** 'desktop' when the command registers only in the desktop app: on mobile the row is
	 *  shown disabled with a "Desktop only" chip and never runs. Absent = every platform. */
	platform?: 'desktop';
	/** The leaf shows when ANY of these features is on (its `feature` stays the canonical
	 *  owner for the taxonomy). Mirrors a command whose registration gate is an OR. */
	anyOfFeatures?: FeatureId[];
	/** Features that must ALSO be on, beyond `feature` (a command gated on an AND). */
	alsoRequiresFeatures?: FeatureId[];
	/** Its feature is off: the row is listed under "Available to turn on" and choosing it
	 *  opens activation instead of running the command. */
	featureOff?: true;
	/** A "For this context" row: the caller already checked it is ready for its target. */
	contextItem?: true;
	/** A guided job: it opens the job window, which checks its own prerequisites. */
	jobItem?: true;
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
	/** All actions stage filter (null = every stage). Session-only. */
	private stageFilter: WorkflowStage | null = null;
	private chipsEl: HTMLElement | null = null;
	/** Listeners of the current stage chips; released on every chip re-render and on close. */
	private readonly chipCleanups: (() => void)[] = [];
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
		/** Sections to open for this opening only (the welcome's buttons). */
		openSections: readonly string[] = [],
	) {
		super(app);
		this.t = t;
		this.categories = flattenSingleChildGroups(categories);
		this.modalEl.addClass('ai-organiser-command-picker-modal');
		// Hydrate expanded-categories from persisted settings. Falls back
		// to ['pinned'] only when settings haven't been written yet.
		const persisted = this.plugin.settings.pickerExpandedCategoryIds;
		this.expandedCategories = new Set<string>(
			persisted && persisted.length > 0 ? persisted : ['pinned'],
		);
		// "Available to turn on" starts open and stays as the user last left it.
		if (this.plugin.settings.pickerAvailableExpanded !== false) this.expandedGroups.add(AVAILABLE_GROUP_ID);
		// "For this context" is always open: it is the reason a scoped picker was opened.
		if (categories.some((c) => c.id === 'context')) this.expandedCategories.add('context');
		for (const id of openSections) this.expandedCategories.add(id);
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
			// FT-11 call-site sweep: the `enableSemanticSearch` legacy master is
			// absorbed by the `semantic-search` feature flag, which is now the sole
			// gating switch. Read the feature predicate, not the legacy field.
			enableSemanticSearch: isFeatureEnabled(this.plugin.settings, 'semantic-search'),
			hasVectorStore: !!this.plugin.vectorStore,
			isMobile: Platform.isMobile,
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

		// All actions stage filter. Buttons outside the listbox, so the list keeps its option roles.
		this.chipsEl = promptEl.createDiv({
			cls: 'ai-organiser-picker-stage-chips',
			attr: { role: 'group', 'aria-label': this.t.modals.commandPicker.stageFilterLabel },
		});
		this.renderStageChips();

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
		for (const cleanup of this.chipCleanups.splice(0)) cleanup();
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

		const categories = this.stageFilter && !this.query
			? filterSectionByStage(this.categories, 'all', this.stageFilter)
			: this.categories;
		this.visibleItems = buildVisibleItems(
			categories, this.expandedGroups, fuzzyMatcher, this.expandedCategories,
			(feature) => isFeatureEnabled(this.plugin.settings, feature),
		);

		// Clamp active index
		if (this.activeIndex >= this.visibleItems.length) {
			this.activeIndex = Math.max(0, this.visibleItems.length - 1);
		}

		this.chipsEl?.toggleClass('ai-organiser-hidden', !!this.query || !this.expandedCategories.has('all'));
		this.renderList();
	}

	private renderStageChips(): void {
		const el = this.chipsEl;
		if (!el) return;
		for (const cleanup of this.chipCleanups.splice(0)) cleanup();
		el.empty();
		const cp = this.t.modals.commandPicker;
		const choices: Array<{ stage: WorkflowStage | null; label: string }> = [
			{ stage: null, label: cp.stageFilterAll },
			...WORKFLOW_STAGES.map((stage) => ({ stage, label: this.t.workflowStages[stage] })),
		];
		for (const choice of choices) {
			const pressed = this.stageFilter === choice.stage;
			const btn = el.createEl('button', {
				cls: 'ai-organiser-picker-stage-chip' + (pressed ? ' is-active' : ''),
				text: choice.label,
				attr: { type: 'button', 'aria-pressed': pressed ? 'true' : 'false' },
			});
			this.chipCleanups.push(listen(btn, 'click', () => {
				this.stageFilter = choice.stage;
				this.activeIndex = 0;
				this.renderStageChips();
				this.rebuild();
				this.inputEl.focus();
			}));
		}
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
		if (item.command.featureOff) {
			// Operable: choosing it opens activation, so it is NOT aria-disabled.
			el.addClass('ai-organiser-picker-feature-off');
			el.setAttribute('aria-label', this.t.modals.commandPicker.featureOffAria.replace('{name}', item.command.name));
		}
		const reqState = item.command.contextItem || item.command.jobItem ? { met: true } as const : checkLeaf(item.command, ctx, this.t);
		if (!item.command.featureOff && !reqState.met) {
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
		const stage = stageChipFor(item);
		if (stage) {
			const chip = el.createEl('span', { cls: 'ai-organiser-command-picker-category' });
			chip.appendText(this.t.workflowStages[stage]);
			return;
		}
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
		if (item.command.featureOff) {
			const chip = metaEl.createEl('span', { cls: 'ai-organiser-command-picker-requires ai-organiser-picker-chip-off' });
			setIcon(chip.createEl('span', { cls: 'ai-organiser-command-picker-requires-icon' }), 'power');
			chip.createEl('span', { cls: 'ai-organiser-command-picker-requires-text', text: this.t.modals.commandPicker.chipFeatureOff });
			return;
		}
		const reqState = checkLeaf(item.command, ctx, this.t);
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
		if (item.command.featureOff) {
			setTooltip(el, this.t.modals.commandPicker.availableDesc);
			return;
		}
		const reqState = checkLeaf(item.command, ctx, this.t);
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

		// An off feature's action never runs: its callback opens activation instead.
		if (item.command.featureOff) {
			this.close();
			void item.command.callback();
			return;
		}

		// Requirement gate — rebuild context FRESH (not the render-time
		// snapshot). User could have changed active note / opened editor /
		// updated settings between render and click (audit R2 H2).
		const ctx = this.buildRequirementContext();
		const reqState = checkLeaf(item.command, ctx, this.t);
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
		this.plugin.settings.pickerExpandedCategoryIds = [...this.expandedCategories].filter((id) => id !== 'context');
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

		if (groupId === AVAILABLE_GROUP_ID) {
			this.plugin.settings.pickerAvailableExpanded = !wasExpanded;
			void this.plugin.saveSettings();
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
 * Build command categories — unified workflow-stage taxonomy.
 *
 * 6 top-level categories: Pinned + the 5 workflow stages (capture / create /
 * refine / find / maintain), labelled from the shared `t.workflowStages.*` SSOT.
 * Every top-level category id === its workflow stage (except `pinned`); each leaf
 * declares a matching `stage`, asserted by crossSurfaceTaxonomy.test. Create has
 * verb-anchored sub-groups (Write, Visualise) plus direct leaves; Refine has a
 * Process-pending sub-group; Maintain has a Bases sub-group. Cross-listing: AI Chat
 * + Vault search + Quick peek live in Pinned AND in Find (their real stage). Same
 * callback, two browse rows; search-mode dedupes by command.id.
 *
 * Pinned is user-configurable: if `pinnedCommandIds` is provided (max 5 entries),
 * the Pinned category is built from those command objects looked up across every
 * other category. Empty / undefined ⇒ static default (chat / search / quick-peek).
 *
 * Plan: docs/plans/unified-feature-taxonomy.md (audit-converged — GPT ×3 + Gemini APPROVE).
 */

/** Leaves whose command exists or works only in the desktop app (from the action registry). */
export const DESKTOP_ONLY_LEAVES: ReadonlySet<string> = new Set(
	ACTIONS.filter((a) => a.platform === 'desktop').map((a) => a.id),
);

/** Build one picker leaf from its registry entry. */
function leafFromAction(
	def: ActionDef,
	t: Translations,
	executeCommand: (commandId: string) => void,
): PickerCommand {
	const desc = t.modals.commandPicker.descriptions;
	const legacyHomes = [...(def.legacyHomes ?? [])];
	return {
		id: def.id,
		name: t.commands[def.labelKey],
		icon: def.icon,
		feature: def.feature,
		stage: def.stage,
		callback: () => executeCommand(`ai-organiser:${def.id}`),
		requires: def.requires,
		description: desc[def.descKey] || def.descFallback,
		aliases: [
			...(def.synonymKeys ?? []).map((k) => t.commands[k]),
			...(def.synonyms ?? []),
			...legacyHomes.flatMap(legacyHomeAliases),
		],
		legacyHomes,
		...(def.platform ? { platform: def.platform } : {}),
		...(def.anyOfFeatures ? { anyOfFeatures: [...def.anyOfFeatures] } : {}),
		...(def.alsoRequiresFeatures ? { alsoRequiresFeatures: [...def.alsoRequiresFeatures] } : {}),
		...(def.canonicalCategoryId ? { canonicalCategoryId: def.canonicalCategoryId } : {}),
	};
}

/** Top-level picker sections, in order (docs/plans/navigation-discoverability.md, decision 4). */
export const PICKER_SECTION_IDS = ['context', 'pinned', 'jobs', 'all', 'setup'] as const;
export type PickerSectionId = typeof PICKER_SECTION_IDS[number];
/** The group inside All actions that lists actions whose feature is off. */
export const AVAILABLE_GROUP_ID = 'available-to-turn-on';

export interface PickerBuildOptions {
	/** Feature predicate. Omitted = every feature on (no "Available to turn on" block). */
	isEnabled?: (feature: FeatureId) => boolean;
	/** Called instead of running the command when an off action is chosen. */
	onActivate?: (actionId: string) => void;
	/** The guided jobs; choosing one calls `onJob`. Omitted = no Jobs section. */
	jobs?: readonly { readonly id: string; readonly title: string; readonly desc: string; readonly icon: string }[];
	onJob?: (jobId: string) => void;
	/** "For this context": the target's name and its items (ready, already ranked and capped). */
	context?: { readonly label: string; readonly items: readonly PickerContextItem[] };
}

/** One "For this context" row: already checked ready by the caller, run as given. */
export interface PickerContextItem {
	readonly id: string;
	readonly title: string;
	readonly icon: string;
	readonly run: () => void;
}

/**
 * The picker, built from the action registry, in five sections: For this context (Phase 4),
 * Pinned, Jobs (Phase 5), All actions and Setup & tools. Every action sits directly in its
 * section, so any leaf is at most two clicks away. Actions whose feature is off are listed,
 * never run, in the "Available to turn on" group at the end of All actions; choosing one
 * calls `onActivate`. Each leaf object is created once, so the Pinned cross-listings are the
 * SAME objects as their section placements (search-mode dedup relies on identity).
 */
export function buildCommandCategories(
	t: Translations,
	executeCommand: (commandId: string) => void,
	pinnedCommandIds: readonly string[] = [],
	options: PickerBuildOptions = {},
): CommandCategory[] {
	const cp = t.modals.commandPicker;
	const isEnabled = options.isEnabled ?? (() => true);
	const stageOrder = new Map(WORKFLOW_STAGES.map((stage, i) => [stage, i]));
	const ordered = [...ACTIONS].sort((x, y) => (stageOrder.get(x.stage) ?? 0) - (stageOrder.get(y.stage) ?? 0));
	const leaves = new Map(ordered.map((def) => {
		const leaf = leafFromAction(def, t, executeCommand);
		leaf.aliases = [...(leaf.aliases ?? []), t.workflowStages[def.stage]];
		if (!actionFeatureOn(def, isEnabled)) {
			leaf.featureOff = true;
			leaf.callback = () => options.onActivate?.(def.id);
		}
		return [def.id, leaf] as const;
	}));

	const ready = (def: ActionDef): boolean => !leaves.get(def.id)!.featureOff;
	const all: PickerCommand[] = ordered.filter((d) => d.kind === 'daily' && ready(d)).map((d) => leaves.get(d.id)!);
	const off = ordered.filter((d) => !ready(d)).map((d) => leaves.get(d.id)!);
	if (off.length > 0) {
		all.push({
			id: AVAILABLE_GROUP_ID,
			name: `${cp.availableTitle} (${off.length})`,
			icon: 'power',
			description: cp.availableDesc,
			callback: () => {},
			subCommands: off,
		});
	}
	const setup = ordered.filter((d) => d.kind !== 'daily' && ready(d)).map((d) => leaves.get(d.id)!);

	// The user's Pinned selection (max 5), else the default. IDs not found are skipped.
	const customPinned = pinnedCommandIds.slice(0, 5)
		.map((id) => leaves.get(id))
		.filter((leaf): leaf is PickerCommand => !!leaf);
	const pinnedCommands = customPinned.length > 0
		? customPinned
		: DEFAULT_PINNED.map((id) => leaves.get(id)).filter((leaf): leaf is PickerCommand => !!leaf);

	const sections: CommandCategory[] = [];
	if (options.context && options.context.items.length > 0) {
		sections.push({
			id: 'context',
			name: cp.contextFor.replace('{name}', options.context.label),
			icon: 'crosshair',
			commands: options.context.items.map((item) => {
				const def = ACTION_BY_ID.get(item.id);
				return {
					id: `context:${item.id}`,
					name: item.title,
					icon: item.icon,
					callback: item.run,
					contextItem: true as const,
					...(def ? { feature: def.feature, stage: def.stage, description: leaves.get(def.id)?.description } : {}),
				};
			}),
		});
	}
	const jobs: CommandCategory[] = options.jobs && options.jobs.length > 0 ? [{
		id: 'jobs', name: cp.categoryJobs, icon: 'route',
		commands: options.jobs.map((j) => ({
			id: `job:${j.id}`, name: j.title, icon: j.icon, description: j.desc,
			callback: () => options.onJob?.(j.id), jobItem: true as const,
		})),
	}] : [];
	return [
		...sections,
		{ id: 'pinned', name: cp.categoryPinned, icon: 'star', commands: pinnedCommands },
		...jobs,
		{ id: 'all', name: cp.categoryAll, icon: 'layout-list', commands: all },
		{ id: 'setup', name: cp.categorySetup, icon: 'settings', commands: setup },
	];
}
