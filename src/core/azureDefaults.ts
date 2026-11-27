/**
 * The ONE place for the concrete Azure default models. Azure deployments lag the
 * public catalogs, so these are pinned ids rather than `latest-*` sentinels
 * (AGENTS.md, Cross-Cutting Invariants). Moving a default is an edit here.
 *
 * Historical settings migrations keep their own literals on purpose: a migration
 * must keep meaning what it meant when it shipped.
 */
export const AZURE_DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5-5';
/** Heavier Claude work (audit, research). */
export const AZURE_DEFAULT_CLAUDE_HEAVY_MODEL = 'claude-opus-5-5';
export const AZURE_DEFAULT_GPT_MODEL = 'gpt-5.5';
