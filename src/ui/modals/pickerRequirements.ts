/**
 * Picker requirements — pure precondition resolver for CommandPickerModal.
 *
 * A picker leaf declares `requires?: RequirementKind`; the modal builds a
 * `RequirementContext` from current app state and asks `checkRequirement`
 * whether the leaf is currently usable. When unmet, the modal shows a chip,
 * disables the row, and intercepts clicks with a Notice.
 *
 * Pure functions on plain objects — no Obsidian `App` or `Modal` import,
 * fully testable without the harness (audit response: R1 M5 + R2 H2).
 *
 * Plan: docs/plans/command-picker-output-anchored-frontend.md (Phase 4 +
 *       File 2). Locked after 3 GPT audit rounds + 3 Gemini final reviews.
 */

import type { Translations } from '../../i18n/types';
import type { RequirementKind } from './CommandPickerModal';

/**
 * Minimal context the resolver needs. Built per render AND per click — no
 * caching across the boundary (audit R2 H2). Tests instantiate plain
 * object literals.
 */
export interface RequirementContext {
    /** True when the active file is a `.md` Markdown note. */
    hasActiveMdNote: boolean;
    /** True when the active editor has a non-empty selection. */
    hasEditorSelection: boolean;
    /** True when ≥1 `.md` file exists in the vault. Boolean, not a count
     *  (Gemini-G3 perf — `.some()` short-circuits, `.length` allocates). */
    hasMarkdownFiles: boolean;
    /** Setting: `enableSemanticSearch` toggle (R2 M3 — kept separate from
     *  vectorStore so the reason text can pinpoint which prerequisite is
     *  failing). */
    semanticSearchEnabled: boolean;
    /** Plugin state: `vectorStore` reference exists. */
    semanticSearchIndexed: boolean;
}

export interface RequirementState {
    met: boolean;
    /** Lucide icon name for the chip. Set only when `met === false`. */
    chipIcon?: string;
    /** Short chip label from i18n, ≤12 chars. Set only when `met === false`. */
    chipText?: string;
    /** Full reason for the tooltip + Notice. Set only when `met === false`. */
    reason?: string;
}

/**
 * Evaluate a requirement against context, with translated copy.
 * `t` is REQUIRED — no English fallbacks (i18n SSOT, audit R1 M2).
 */
export function checkRequirement(
    requires: RequirementKind | undefined,
    ctx: RequirementContext,
    t: Translations,
): RequirementState {
    if (!requires || requires === 'none') return { met: true };
    const cp = t.modals.commandPicker;

    if (requires === 'active-note') {
        if (ctx.hasActiveMdNote) return { met: true };
        return {
            met: false,
            chipIcon: 'file-edit',
            chipText: cp.requiresChipNote,
            reason: cp.requiresReasonNote,
        };
    }
    if (requires === 'selection') {
        if (ctx.hasEditorSelection) return { met: true };
        return {
            met: false,
            chipIcon: 'type',
            chipText: cp.requiresChipSelection,
            reason: cp.requiresReasonSelection,
        };
    }
    if (requires === 'vault') {
        if (ctx.hasMarkdownFiles) return { met: true };
        return {
            met: false,
            chipIcon: 'library',
            chipText: cp.requiresChipVault,
            reason: cp.requiresReasonVault,
        };
    }
    if (requires === 'semantic-search') {
        if (ctx.semanticSearchEnabled && ctx.semanticSearchIndexed) return { met: true };
        // Distinct reasons depending on which prerequisite failed (R2 M3).
        const reason = !ctx.semanticSearchEnabled
            ? cp.requiresReasonSemanticSearchDisabled
            : cp.requiresReasonSemanticSearchUnindexed;
        return {
            met: false,
            chipIcon: 'search-x',
            chipText: cp.requiresChipSemanticSearch,
            reason,
        };
    }
    // Exhaustive narrowing — TS rejects this assignment if a new
    // RequirementKind value is added and not handled in the branches above.
    return assertNever(requires);
}

function assertNever(_value: never): RequirementState {
    return { met: true };
}

/**
 * Build a `RequirementContext` from raw plugin/app state. Lives here so
 * tests can verify the mapping logic without touching Obsidian internals.
 *
 * Caller (the modal) reads from `app.workspace`, `app.vault`, plugin
 * settings — this helper just maps to the typed shape.
 */
export function buildContext(args: {
    activeFile: { extension: string } | null;
    editor: { somethingSelected: () => boolean } | null;
    /** Pre-computed boolean — caller uses `.some()` for O(1) short-circuit
     *  rather than `.length` on `getMarkdownFiles()` (Gemini-G3). */
    hasMarkdownFiles: boolean;
    enableSemanticSearch: boolean;
    hasVectorStore: boolean;
}): RequirementContext {
    return {
        hasActiveMdNote: !!args.activeFile && args.activeFile.extension === 'md',
        hasEditorSelection: !!args.editor && args.editor.somethingSelected(),
        hasMarkdownFiles: args.hasMarkdownFiles,
        semanticSearchEnabled: args.enableSemanticSearch,
        semanticSearchIndexed: args.hasVectorStore,
    };
}

/**
 * Map a legacy taxonomy home to its searchable terms. Used by the picker
 * tree's `cmd()` helper to derive backward-compat aliases automatically
 * (audit R3 M3 + Gemini-G4 — no manual sprinkling).
 */
const LEGACY_HOME_ALIASES: Record<string, string[]> = {
    'active-note-export':  ['active note', 'export'],
    'active-note-refine':  ['active note', 'refine'],
    'active-note-pending': ['active note', 'pending'],
    'active-note-maps':    ['active note', 'maps'],
    'capture':             ['capture'],
    'vault':               ['vault'],
    'vault-visualize':     ['vault', 'visualize', 'visualise'],
    'tools':               ['tools'],
};

export function legacyHomeAliases(home: string): string[] {
    return LEGACY_HOME_ALIASES[home] ?? [];
}
