/**
 * Serialise the picker tree to plain data for the navigation migration oracles
 * (docs/plans/navigation-discoverability.md §2 decision 1). One row per executable leaf:
 * where it sits, what it is called, what owns it and what it needs. Callbacks are dropped.
 */
import type { CommandCategory, PickerCommand } from '../../src/ui/modals/CommandPickerModal';

export interface LeafRow {
    category: string;
    group: string | null;
    id: string;
    name: string;
    feature: string | null;
    stage: string | null;
    requires: string;
    platform: string;
    anyOfFeatures: string[] | null;
    alsoRequiresFeatures: string[] | null;
}

export function snapshotPickerTree(categories: readonly CommandCategory[]): LeafRow[] {
    const rows: LeafRow[] = [];
    const push = (leaf: PickerCommand, category: string, group: string | null): void => {
        rows.push({
            category,
            group,
            id: leaf.id,
            name: leaf.name,
            feature: leaf.feature ?? null,
            stage: leaf.stage ?? null,
            requires: leaf.requires ?? 'none',
            platform: (leaf as { platform?: string }).platform ?? 'all',
            anyOfFeatures: leaf.anyOfFeatures ? [...leaf.anyOfFeatures] : null,
            alsoRequiresFeatures: leaf.alsoRequiresFeatures ? [...leaf.alsoRequiresFeatures] : null,
        });
    };
    for (const cat of categories) {
        for (const cmd of cat.commands) {
            if (cmd.subCommands && cmd.subCommands.length > 0) {
                for (const sub of cmd.subCommands) push(sub, cat.id, cmd.id);
            } else {
                push(cmd, cat.id, null);
            }
        }
    }
    return rows;
}
