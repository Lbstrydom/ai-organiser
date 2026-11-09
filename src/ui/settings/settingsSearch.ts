/**
 * Settings search (docs/plans/navigation-discoverability.md, Phase 5).
 *
 * Pure planning: which sections show and which open for a query. No cached index: the tab reads
 * the texts from the DOM on every query, so a section that re-renders is always searched as it
 * is now. The open/closed overlay (snapshot on the first keystroke, restore on clear) lives in
 * the tab, against its own expanded-section set.
 */

import type { WorkflowStage } from '../../core/workflowStages';

export interface SearchableSection {
    readonly id: string;
    /** Title, description, and every setting name and description inside it. */
    readonly texts: readonly string[];
    readonly children: readonly { readonly id: string; readonly texts: readonly string[] }[];
}

const words = (query: string): string[] => query.toLowerCase().split(/\s+/).filter(Boolean);

/** Every word of the query appears somewhere in the texts (case-insensitive). */
export function matchesQuery(texts: readonly string[], query: string): boolean {
    const w = words(query);
    if (w.length === 0) return true;
    const hay = texts.join(' \n ').toLowerCase();
    return w.every((x) => hay.includes(x));
}

export interface SearchPlan {
    /** Top-level sections that stay visible. */
    readonly visible: ReadonlySet<string>;
    /** Sections and sub-sections opened to show a match. */
    readonly open: ReadonlySet<string>;
}

export function planSearch(sections: readonly SearchableSection[], query: string): SearchPlan {
    const visible = new Set<string>();
    const open = new Set<string>();
    for (const s of sections) {
        const all = [...s.texts, ...s.children.flatMap((c) => c.texts)];
        if (!matchesQuery(all, query)) continue;
        visible.add(s.id);
        open.add(s.id);
        for (const c of s.children) if (matchesQuery(c.texts, query)) open.add(c.id);
    }
    return { visible, open };
}

/** One settings section for the stage chips: its own workflow stage (null = none) and its sub-sections'. */
export interface StagedSection {
    readonly id: string;
    readonly stage: WorkflowStage | null;
    /** A sub-section with stage null takes its parent's stage. */
    readonly children: readonly { readonly id: string; readonly stage: WorkflowStage | null }[];
}

export interface StagePlan {
    /** Sections and sub-sections that stay visible. */
    readonly visible: ReadonlySet<string>;
    /** Umbrella sections opened so their matching sub-sections show. */
    readonly open: ReadonlySet<string>;
}

/**
 * The settings stage chips: keep only the sections and sub-sections of one workflow stage. A section
 * with no stage of its own (an umbrella such as Integrations) stays when any sub-section matches, and
 * opens so they show. Sections with no stage anywhere (Features, Preferences, Advanced) leave. Pure.
 */
export function planStageFilter(sections: readonly StagedSection[], stage: WorkflowStage): StagePlan {
    const visible = new Set<string>();
    const open = new Set<string>();
    for (const s of sections) {
        const matching = s.children.filter((c) => (c.stage ?? s.stage) === stage);
        if (s.stage !== stage && matching.length === 0) continue;
        visible.add(s.id);
        for (const c of matching) visible.add(c.id);
        if (s.stage === null) open.add(s.id);
    }
    return { visible, open };
}
