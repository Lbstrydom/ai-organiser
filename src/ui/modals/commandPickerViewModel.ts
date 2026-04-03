/**
 * Command Picker View Model
 * Pure functions for command picker logic — no DOM or Obsidian dependencies.
 * Fully testable in isolation.
 */

import type { CommandCategory, PickerCommand } from './CommandPickerModal';

export interface VisibleItem {
	kind: 'group' | 'leaf' | 'sub-leaf';
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
}

/**
 * Flatten single-child groups: promote the lone child to a standalone command.
 * Returns a new array — does not mutate the input.
 */
export function flattenSingleChildGroups(categories: CommandCategory[]): CommandCategory[] {
	return categories.map(cat => ({
		...cat,
		commands: cat.commands.flatMap(cmd => {
			if (cmd.subCommands && cmd.subCommands.length === 1) {
				// Promote the single child to standalone
				return [cmd.subCommands[0]];
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
	fuzzyMatcher: ((text: string) => { score: number } | null) | null
): VisibleItem[] {
	if (fuzzyMatcher) {
		return buildSearchResults(categories, fuzzyMatcher);
	}
	return buildBrowseTree(categories, expandedGroups);
}

/**
 * Browse mode: build tree with expandable groups.
 */
function buildBrowseTree(
	categories: CommandCategory[],
	expandedGroups: Set<string>
): VisibleItem[] {
	const items: VisibleItem[] = [];

	for (const cat of categories) {
		for (const cmd of cat.commands) {
			const isGroup = !!(cmd.subCommands && cmd.subCommands.length > 0);
			const searchText = buildSearchText(cmd, cat.name);

			if (isGroup) {
				items.push({
					kind: 'group',
					command: cmd,
					category: cat.name,
					categoryIcon: cat.icon,
					categoryId: cat.id,
					depth: 0,
					searchText,
				});

				// If expanded, add sub-commands
				if (expandedGroups.has(cmd.id)) {
					for (const sub of cmd.subCommands!) {
						items.push({
							kind: 'sub-leaf',
							command: sub,
							category: cat.name,
							categoryIcon: cat.icon,
							categoryId: cat.id,
							parentGroupId: cmd.id,
							parentGroupName: cmd.name,
							depth: 1,
							searchText: buildSearchText(sub, cat.name, cmd.name),
						});
					}
				}
			} else {
				items.push({
					kind: 'leaf',
					command: cmd,
					category: cat.name,
					categoryIcon: cat.icon,
					categoryId: cat.id,
					depth: 0,
					searchText,
				});
			}
		}
	}

	return items;
}

/**
 * Search mode: flat list of matching leaf commands.
 * Groups are NOT searchable — their names are injected into children's search text.
 */
function buildSearchResults(
	categories: CommandCategory[],
	fuzzyMatcher: (text: string) => { score: number } | null
): VisibleItem[] {
	const results: VisibleItem[] = [];

	for (const cat of categories) {
		for (const cmd of cat.commands) {
			if (cmd.subCommands && cmd.subCommands.length > 0) {
				// Group: search children, inject parent name into searchable text
				for (const sub of cmd.subCommands) {
					if (sub.badge) continue; // Skip unavailable commands
					const searchText = buildSearchText(sub, cat.name, cmd.name);
					const match = fuzzyMatcher(searchText);
					if (match) {
						results.push({
							kind: 'sub-leaf',
							command: sub,
							category: cat.name,
							categoryIcon: cat.icon,
							categoryId: cat.id,
							parentGroupId: cmd.id,
							parentGroupName: cmd.name,
							depth: 0, // Flat in search mode
							searchText,
							score: match.score,
						});
					}
				}
			} else {
				// Standalone command
				if (cmd.badge) continue; // Skip unavailable commands
				const searchText = buildSearchText(cmd, cat.name);
				const match = fuzzyMatcher(searchText);
				if (match) {
					results.push({
						kind: 'leaf',
						command: cmd,
						category: cat.name,
						categoryIcon: cat.icon,
						categoryId: cat.id,
						depth: 0,
						searchText,
						score: match.score,
					});
				}
			}
		}
	}

	// Sort by score descending (best matches first), then by original order (stable)
	results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
	return results;
}
