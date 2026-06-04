/**
 * Workflow-stage vocabulary — the shared taxonomy SSOT (unified-feature-taxonomy plan).
 *
 * Both surfaces that organise features — the Features settings menu and the Command
 * Picker — draw their TOP-LEVEL grouping vocabulary from here, so they can never disagree
 * on the stage set or its identity. This module is PURE vocabulary + ordering: no i18n
 * (labels live in `t.workflowStages[stage]`), no Lucide icons (presentation lives in
 * `ui/settings/featureStagePresentation.ts`), no Obsidian/DOM import — trivially testable
 * and importable from `core`, `services`, `ui`, and tests alike.
 *
 * The 5-stage cut (capture / create / refine / find / maintain) is decided in the plan:
 * `capture` pulls NEW content in; `find` operates over what's ALREADY in the vault.
 */

/** The shared top-level taxonomy. A feature declares its primary stage; a picker leaf
 *  declares the stage of the category it sits in (asserted by the cross-surface test). */
export type WorkflowStage = 'capture' | 'create' | 'refine' | 'find' | 'maintain';

/** Display/declaration order of the stages (settings groups + picker categories follow it). */
export const WORKFLOW_STAGES: readonly WorkflowStage[] = ['capture', 'create', 'refine', 'find', 'maintain'];

/** O(1) membership guard — fail-closed callers use it to reject an unknown stage string. */
const STAGE_SET: ReadonlySet<string> = new Set(WORKFLOW_STAGES);

/** Type-guard: is `s` a declared workflow stage? */
export function isWorkflowStage(s: string): s is WorkflowStage {
    return STAGE_SET.has(s);
}

/**
 * Declared per-feature trust/setup attributes. v1 has exactly ONE member —
 * `'external-account'`, the sole trigger for the settings "Integrations" float and a
 * privacy signal (a feature that genuinely authenticates/transmits to a remote account:
 * Kindle→Amazon, Newsletter→Gmail). Local tools that merely *relate* to an external
 * product (Bases, NotebookLM source-pack export) carry NO boundary. The union grows by one
 * member only when a new consumer needs it (YAGNI — no speculative dead fields).
 */
export type FeatureBoundary = 'external-account';
