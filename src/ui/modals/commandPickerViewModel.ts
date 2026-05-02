/**
 * Command Picker View Model
 * Pure functions for command picker logic — no DOM or Obsidian dependencies.
 * Fully testable in isolation.
 */

import type { CommandCategory, PickerCommand } from './CommandPickerModal';

export interface VisibleItem {
	kind: 'group' | 'leaf' | 'sub-leaf' | 'category-header';
	command: PickerCommand;
	category: string;
	categoryIcon: string;
	categoryId: string;
	/** Set for sub-leaf items — the parent group's stable ID */
	parentGroupId?: string;
	/** Parent group name for breadcrumb display in search results */
	parentGroupName?: string;
	/** 0 = top-level, 1 = sub-command */
	depth: number;
	/** Pre-built searchable text (name + aliases + description + category + parent group) */
	searchText: string;
	/** Fuzzy match score — only set during search mode */
	score?: number;
	/** True for `category-header` rows when the category is expanded. */
	categoryExpanded?: boolean;
	/** Number of leaf descendants — shown next to the category-header label. */
	categoryLeafCount?: number;
}

/**
 * Flatten single-child groups: promote the lone child to a standalone command.
 * Returns a new array — does not mutate the input.
 *
 * Audit M11 fix: preserve parent metadata so the parent's name and aliases
 * stay searchable. Without this merge, a user searching for the parent
 * group's name would no longer find the promoted child — silent
 * discoverability regression for any future single-child group. The child's
 * own name/aliases take precedence; the parent's contribute as additional
 * search vocabulary.
 */
export function flattenSingleChildGroups(categories: CommandCategory[]): CommandCategory[] {
	return categories.map(cat => ({
		...cat,
		commands: cat.commands.flatMap(cmd => {
			if (cmd.subCommands && cmd.subCommands.length === 1) {
				const child = cmd.subCommands[0];
				return [{
					...child,
					aliases: [
						...(child.aliases ?? []),
						cmd.name,
						...(cmd.aliases ?? []),
					],
				}];
			}
			return [cmd];
		})
	}));
}

/**
 * Build the searchable text for a command.
 * Includes: name, aliases, description, category, and parent group name.
 */
function buildSearchText(
	cmd: PickerCommand,
	categoryName: string,
	parentGroupName?: string
): string {
	const parts = [cmd.name];
	if (cmd.aliases) parts.push(...cmd.aliases);
	if (cmd.description) parts.push(cmd.description);
	parts.push(categoryName);
	if (parentGroupName) parts.push(parentGroupName);
	return parts.join(' ');
}

/**
 * Derive the visible item list from commands, expansion state, and search query.
 *
 * Browse mode (query empty): tree with expandable groups.
 * Search mode (query non-empty): flat list of matching leaf commands only.
 *
 * @param fuzzyMatcher - A prepared fuzzy search function from Obsidian's `prepareFuzzySearch(query)`.
 *   Pass `null` for browse mode (empty query).
 */
export function buildVisibleItems(
	categories: CommandCategory[],
	expandedGroups: Set<string>,
	fuzzyMatcher: ((text: string) => { score: number } | null) | null,
	expandedCategories?: Set<string>,
): VisibleItem[] {
	if (fuzzyMatcher) {
		return buildSearchResults(categories, fuzzyMatcher);
	}
	return buildBrowseTree(categories, expandedGroups, expandedCategories);
}

/**
 * Browse mode: build tree with expandable category headers + groups.
 *
 * Each category renders as a `category-header` row. When the category is
 * expanded (per `expandedCategories`), its commands render below — with
 * groups collapsed by default unless their id is in `expandedGroups`.
 *
 * `expandedCategories === undefined` means "show all" (legacy behaviour
 * for callers that haven't migrated).
 */
function buildBrowseTree(
	categories: CommandCategory[],
	expandedGroups: Set<string>,
	expandedCategories: Set<string> | undefined,
): VisibleItem[] {
	const items: VisibleItem[] = [];
	// `expandedCategories === undefined` is the legacy contract: no
	// category-header rows, all categories' contents inlined. Callers
	// that opt into collapsibility (the modal) pass a Set explicitly.
	for (const cat of categories) {
		const isCategoryExpanded = !expandedCategories || expandedCategories.has(cat.id);
		if (expandedCategories) {
			items.push(buildCategoryHeader(cat, isCategoryExpanded));
		}
		if (!isCategoryExpanded) continue;
		for (const cmd of cat.commands) {
			pushCategoryEntry(items, cat, cmd, expandedGroups);
		}
	}
	return items;
}

function buildCategoryHeader(cat: CommandCategory, isExpanded: boolean): VisibleItem {
	return {
		kind: 'category-header',
		// Synthesize a placeholder PickerCommand so callers that read
		// `command.id` etc. don't break. The toggle handler keys off
		// `categoryId`.
		command: { id: `__category__${cat.id}`, name: cat.name, icon: cat.icon, callback: () => {} },
		category: cat.name,
		categoryIcon: cat.icon,
		categoryId: cat.id,
		depth: 0,
		searchText: cat.name,
		categoryExpanded: isExpanded,
		categoryLeafCount: countCategoryLeaves(cat),
	};
}

function pushCategoryEntry(
	items: VisibleItem[],
	cat: CommandCategory,
	cmd: PickerCommand,
	expandedGroups: Set<string>,
): void {
	const isGroup = !!(cmd.subCommands && cmd.subCommands.length > 0);
	const searchText = buildSearchText(cmd, cat.name);
	if (!isGroup) {
		items.push({
			kind: 'leaf', command: cmd, category: cat.name,
			categoryIcon: cat.icon, categoryId: cat.id, depth: 0, searchText,
		});
		return;
	}
	items.push({
		kind: 'group', command: cmd, category: cat.name,
		categoryIcon: cat.icon, categoryId: cat.id, depth: 0, searchText,
	});
	if (!expandedGroups.has(cmd.id)) return;
	for (const sub of cmd.subCommands!) {
		items.push({
			kind: 'sub-leaf', command: sub, category: cat.name,
			categoryIcon: cat.icon, categoryId: cat.id,
			parentGroupId: cmd.id, parentGroupName: cmd.name,
			depth: 1, searchText: buildSearchText(sub, cat.name, cmd.name),
		});
	}
}

function countCategoryLeaves(cat: CommandCategory): number {
	let count = 0;
	for (const cmd of cat.commands) {
		if (cmd.subCommands && cmd.subCommands.length > 0) count += cmd.subCommands.length;
		else count++;
	}
	return count;
}

/**
 * Search mode: flat list of matching leaf commands, deduplicated by command ID.
 *
 * Cross-listed commands (chat-with-ai, semantic-search, quick-peek live in
 * Essentials AND Find/Refine) are intentionally rendered TWICE in browse
 * mode but ONCE in search. Dedup keeps the highest-scoring placement for
 * ranking, but uses the command's `canonicalCategoryId` (an explicit
 * field) for the chip text/icon — never traversal order, never reference
 * identity (audit Gemini-G2 — both would fail because cross-listings push
 * the same `PickerCommand` reference into multiple categories).
 */
function buildSearchResults(
	categories: CommandCategory[],
	fuzzyMatcher: (text: string) => { score: number } | null
): VisibleItem[] {
	// Pre-compute a category lookup so reducePlacements can resolve the
	// canonical category metadata even when the user's search string ONLY
	// matched non-canonical placements (audit Gemini-G1). Without this,
	// searching "Find" for a chat-with-ai cross-listing would surface only
	// the Find placement and the chip would incorrectly read "Find" instead
	// of the canonical "Essentials".
	const categoryById = new Map<string, CommandCategory>();
	for (const cat of categories) categoryById.set(cat.id, cat);

	const matchesById = new Map<string, VisibleItem[]>();
	for (const cat of categories) {
		for (const cmd of cat.commands) {
			collectMatches(cat, cmd, fuzzyMatcher, matchesById);
		}
	}
	const results: VisibleItem[] = [];
	for (const placements of matchesById.values()) {
		results.push(reducePlacements(placements, categoryById));
	}
	results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
	return results;
}

/** Walk a category entry (group or standalone), record all matches. */
function collectMatches(
	cat: CommandCategory,
	cmd: PickerCommand,
	fuzzyMatcher: (text: string) => { score: number } | null,
	matchesById: Map<string, VisibleItem[]>,
): void {
	if (cmd.subCommands && cmd.subCommands.length > 0) {
		for (const sub of cmd.subCommands) {
			tryMatchLeaf(sub, cat, fuzzyMatcher, matchesById, cmd);
		}
	} else {
		tryMatchLeaf(cmd, cat, fuzzyMatcher, matchesById);
	}
}

function tryMatchLeaf(
	leaf: PickerCommand,
	cat: CommandCategory,
	fuzzyMatcher: (text: string) => { score: number } | null,
	matchesById: Map<string, VisibleItem[]>,
	parent?: PickerCommand,
): void {
	// Audit M10 fix: badged commands stay visible in search just like in
	// browse mode — the renderer applies `.is-unavailable` styling and
	// click-time Notice. Hiding them in search creates inconsistent
	// discoverability ("the command is in the picker but I can't find it
	// when I search for its name"). The execution gate is in selectItem.
	const searchText = buildSearchText(leaf, cat.name, parent?.name);
	const match = fuzzyMatcher(searchText);
	if (!match) return;
	const list = matchesById.get(leaf.id) ?? [];
	list.push({
		kind: parent ? 'sub-leaf' : 'leaf',
		command: leaf,
		category: cat.name,
		categoryIcon: cat.icon,
		categoryId: cat.id,
		parentGroupId: parent?.id,
		parentGroupName: parent?.name,
		depth: 0,
		searchText,
		score: match.score,
	});
	matchesById.set(leaf.id, list);
}

/** Pick the best-scoring placement; rewrite its chip to the canonical home.
 *  Looks up canonical category from the pre-built categoryById map so the
 *  chip is correct even when the user's query ONLY matched non-canonical
 *  placements (audit Gemini-G1). */
function reducePlacements(
	placements: VisibleItem[],
	categoryById: Map<string, CommandCategory>,
): VisibleItem {
	placements.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
	const best = placements[0];
	const canonicalCatId = best.command.canonicalCategoryId ?? best.categoryId;
	const canonicalCat = categoryById.get(canonicalCatId);
	if (!canonicalCat) return best;  // unknown id → fall back to best
	return {
		...best,
		category: canonicalCat.name,
		categoryIcon: canonicalCat.icon,
		categoryId: canonicalCat.id,
	};
}
