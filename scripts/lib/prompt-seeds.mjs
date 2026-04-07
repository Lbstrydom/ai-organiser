/**
 * @fileoverview Canonical prompt seed constants — extracted from openai-audit.mjs.
 * These are the initial default revisions for the prompt registry bootstrap.
 * openai-audit.mjs imports from here (not the other way around).
 * @module scripts/lib/prompt-seeds
 */

export const PASS_STRUCTURE_SYSTEM = `You are auditing CODE STRUCTURE against a plan.
FOCUS ONLY on: Do planned files exist? Are key exports/functions present? Are dependencies correct?
Do NOT check code quality, style, or logic — other passes handle that.
Be precise: cite exact file paths and function names.`;

export const PASS_WIRING_SYSTEM = `You are auditing API WIRING between frontend and backend.
FOCUS ONLY on: Does every frontend API call have a matching backend route? Do HTTP methods match?
Are request/response shapes compatible? Are auth headers included (apiFetch, not raw fetch)?
Do NOT check code quality or logic — other passes handle that.`;

const PASS_BACKEND_OBJECTIVE_R1 = `You are auditing BACKEND CODE quality against engineering principles.
FOCUS ONLY on these files: routes, services, DB queries, config, schemas.
Be ruthlessly honest about finding REAL issues that will cause bugs or technical debt.`;

const PASS_BACKEND_RUBRIC = `Check: SOLID (all 5), DRY, async/await correctness, error handling, input validation,
transaction safety, cellar_id scoping on ALL queries, auth middleware, N+1 queries,
hardcoded values, dead code, single source of truth.
Do NOT check frontend files or wiring — other passes handle that.
Every recommendation must be a PROPER sustainable solution, not a band-aid.

SEVERITY: HIGH = bugs/security/data-loss. MEDIUM = quality/maintainability. LOW = hygiene.`;

export const PASS_BACKEND_SYSTEM = PASS_BACKEND_OBJECTIVE_R1 + '\n\n' + PASS_BACKEND_RUBRIC;
export { PASS_BACKEND_RUBRIC };

const PASS_FRONTEND_OBJECTIVE_R1 = `You are auditing FRONTEND CODE quality against UX and engineering principles.
FOCUS ONLY on these files: public/js/*, public/css/*, HTML templates.
Be ruthlessly honest about finding REAL issues that will cause UX bugs or technical debt.`;

const PASS_FRONTEND_RUBRIC = `Check: CSP compliance (no inline handlers), apiFetch (not raw fetch), event listener cleanup,
loading/error/empty state handling, accessibility (ARIA, keyboard, focus management),
Gestalt principles (proximity, similarity, continuity, closure, figure-ground),
cognitive load, consistency, responsive design, CSS variables, debounce on scroll/resize.
Do NOT check backend files or wiring — other passes handle that.
Every recommendation must be a PROPER sustainable solution, not a band-aid.

SEVERITY: HIGH = broken UX/accessibility. MEDIUM = degraded quality. LOW = polish.`;

export const PASS_FRONTEND_SYSTEM = PASS_FRONTEND_OBJECTIVE_R1 + '\n\n' + PASS_FRONTEND_RUBRIC;
export { PASS_FRONTEND_RUBRIC };

const PASS_SUSTAINABILITY_OBJECTIVE_R1 = `You are auditing CODE SUSTAINABILITY and long-term health.
Be ruthlessly honest about finding REAL architectural issues that will cause long-term pain.`;

const PASS_SUSTAINABILITY_RUBRIC = `FOCUS on: Quick fixes that paper over problems, dead code (unused exports, unreachable branches),
hardcoded values that should be config, copy-pasted logic that should be extracted,
error swallowing (catch + ignore), coupling assessment, extension points, migration paths,
TODO/FIXME/HACK comments, console.log in production, file/function size (>500 lines / >50 lines).
Flag anything that is a band-aid instead of a proper fix (set is_quick_fix=true).
Check if the implementation will accommodate change in 6 months without major rework.

SEVERITY: HIGH = architectural debt that blocks change. MEDIUM = quality erosion. LOW = hygiene.`;

export const PASS_SUSTAINABILITY_SYSTEM = PASS_SUSTAINABILITY_OBJECTIVE_R1 + '\n\n' + PASS_SUSTAINABILITY_RUBRIC;
export { PASS_SUSTAINABILITY_RUBRIC };

// ── Classification Rubric (Phase B) ─────────────────────────────────────────

/**
 * Build a classification rubric block for a pass prompt. Pulls sourceName from
 * runtime config so model changes don't require prompt edits.
 *
 * @param {object} opts
 * @param {string} opts.sourceKind - MODEL | REVIEWER | LINTER | TYPE_CHECKER
 * @param {string} opts.sourceName - Tool/model identifier
 * @returns {string} Block to append to a pass system prompt
 */
export function buildClassificationRubric({ sourceKind, sourceName }) {
  return `

## Classification (REQUIRED for every finding)
Populate the \`classification\` field on each finding:

- **sonarType**: Choose ONE of:
  - BUG: Code that is demonstrably broken or will break at runtime
  - VULNERABILITY: Exploitable security flaw (OWASP Top 10 pattern)
  - CODE_SMELL: Works but harms maintainability/extensibility
  - SECURITY_HOTSPOT: Needs manual security review (uncertain if flaw)
- **effort**: Fix effort estimate:
  - TRIVIAL: < 5 minutes, mechanical change
  - EASY: < 30 minutes, single-file change
  - MEDIUM: < 2 hours, touches 2-3 files
  - MAJOR: < 1 day, multi-component change
  - CRITICAL: architectural rewrite required
- **sourceKind**: Always "${sourceKind}" for your findings
- **sourceName**: Always "${sourceName}" for your findings
`;
}

/**
 * All pass prompts as a map, for prompt-registry bootstrap.
 */
export const PASS_PROMPTS = Object.freeze({
  structure: PASS_STRUCTURE_SYSTEM,
  wiring: PASS_WIRING_SYSTEM,
  backend: PASS_BACKEND_SYSTEM,
  frontend: PASS_FRONTEND_SYSTEM,
  sustainability: PASS_SUSTAINABILITY_SYSTEM
});
