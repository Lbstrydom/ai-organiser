/**
 * @fileoverview Canonical Zod schemas and derived JSON Schemas for the audit loop.
 * Single source of truth for finding shapes used by all reviewers (GPT + Gemini).
 * Zod schemas are the primary definition; JSON Schemas are derived explicitly.
 * @module scripts/lib/schemas
 */

import { z } from 'zod';

// ── Classification Schema (SonarQube-style, Phase B) ─────────────────────────

/**
 * Optional nested envelope — all fields within are required WHEN the envelope is present.
 * This keeps schema evolution safe: absent = old format, present = new format fully specified.
 */
export const ClassificationSchema = z.object({
  sonarType: z.enum(['BUG', 'VULNERABILITY', 'CODE_SMELL', 'SECURITY_HOTSPOT']).describe(
    'SonarQube classification: BUG=broken behavior, VULNERABILITY=exploitable flaw, ' +
    'CODE_SMELL=maintainability debt, SECURITY_HOTSPOT=needs manual security review'
  ),
  effort: z.enum(['TRIVIAL', 'EASY', 'MEDIUM', 'MAJOR', 'CRITICAL']).describe(
    'Fix effort estimate: TRIVIAL=<5min, EASY=<30min, MEDIUM=<2h, MAJOR=<1day, CRITICAL=architectural rewrite'
  ),
  sourceKind: z.enum(['MODEL', 'REVIEWER', 'LINTER', 'TYPE_CHECKER']).describe(
    'Stable source category. MODEL=primary auditor (GPT/Claude), REVIEWER=final-gate (Gemini/Opus), ' +
    'LINTER/TYPE_CHECKER=tool output (Phase C).'
  ),
  sourceName: z.string().max(64).describe(
    'Specific tool/model name: "gpt-5.4", "claude-opus-4-1", "gemini-3.1-pro-preview", "eslint", etc.'
  ),
});

// ── Finding Schema ───────────────────────────────────────────────────────────

const FindingBase = {
  id: z.string().max(10).describe('Finding ID, e.g. H1, M3, L2, G1'),
  severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  category: z.string().max(80).describe('Category: e.g. "DRY Violation", "Missing Error Handling"'),
  section: z.string().max(120).describe('Which plan/code section or file this relates to'),
  detail: z.string().max(600).describe('What is wrong and why it matters'),
  risk: z.string().max(300).describe('What could go wrong if not fixed'),
  recommendation: z.string().max(600).describe('Specific, actionable fix — NOT a quick fix, must be sustainable'),
  is_quick_fix: z.boolean().describe('TRUE if the recommendation is a band-aid rather than a proper fix.'),
  is_mechanical: z.boolean().describe('TRUE if fix is deterministic with exactly one correct answer.'),
  principle: z.string().max(80).describe('Which engineering/UX principle this violates')
};

/**
 * ProducerFindingSchema — what LLMs emit. Classification is REQUIRED.
 * Used as response schema for GPT / Gemini / Claude audit calls.
 */
export const ProducerFindingSchema = z.object({
  ...FindingBase,
  classification: ClassificationSchema,
});

/**
 * PersistedFindingSchema — what we read from storage. Classification is OPTIONAL/nullable.
 * Old findings written before Phase B have no classification; must still validate.
 */
export const PersistedFindingSchema = z.object({
  ...FindingBase,
  classification: ClassificationSchema.nullable().optional(),
});

/**
 * Backward-compatible alias — existing imports of `FindingSchema` use the permissive
 * persisted schema. Enforcement happens at producer boundaries via ProducerFindingSchema.
 */
export const FindingSchema = PersistedFindingSchema;

// ── Zod-to-Gemini Schema Conversion ─────────────────────────────────────────

/**
 * Keys unsupported by Gemini's responseSchema structured output API.
 * Gemini returns 400 INVALID_ARGUMENT if any of these appear.
 */
const GEMINI_UNSUPPORTED_KEYS = new Set([
  '$schema', 'additionalProperties', 'maxLength', 'minLength',
  'default', '$ref', 'minItems', 'maxItems', 'pattern',
  'exclusiveMinimum', 'exclusiveMaximum',
]);

/**
 * Strip Gemini-unsupported JSON Schema keys recursively.
 * @param {*} obj - JSON Schema node
 * @returns {*} Cleaned node
 */
function stripJsonSchemaExtras(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(stripJsonSchemaExtras);
  const cleaned = {};
  for (const [k, v] of Object.entries(obj)) {
    if (GEMINI_UNSUPPORTED_KEYS.has(k)) continue;
    cleaned[k] = stripJsonSchemaExtras(v);
  }
  return cleaned;
}

/**
 * Convert a Zod schema to Gemini-compatible JSON Schema.
 * Strips all Gemini-unsupported keys (maxLength, default, pattern, etc.).
 * Single source of truth: Zod schema → derived JSON Schema.
 * @param {import('zod').ZodType} zodSchema - Any Zod schema
 * @returns {object} Gemini-compatible JSON Schema
 */
export function zodToGeminiSchema(zodSchema) {
  const raw = z.toJSONSchema(zodSchema);
  return stripJsonSchemaExtras(raw);
}

// ── Derived JSON Schema ──────────────────────────────────────────────────────
// Generated from FindingSchema — single source of truth

export const FindingJsonSchema = zodToGeminiSchema(FindingSchema);

// ── Wiring Issue Schema ──────────────────────────────────────────────────────

export const WiringIssueSchema = z.object({
  frontend_call: z.string().max(120),
  backend_route: z.string().max(120),
  status: z.enum(['wired', 'broken', 'missing']),
  detail: z.string().max(300)
});

// ── Ledger Core Fields (shared by session + debt ledgers — Phase D) ─────────

/**
 * Fields shared by both the session ledger (R2+ deliberation) and the debt ledger
 * (Phase D persistent memory). Extracted for DRY; each ledger composes its own
 * schema from this base plus its own specific fields.
 */
const LedgerCoreFields = {
  topicId: z.string(),
  semanticHash: z.string(),
  severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  category: z.string(),
  section: z.string(),
  detailSnapshot: z.string(),
  affectedFiles: z.array(z.string()),
  affectedPrinciples: z.array(z.string()),
  pass: z.string(),
  classification: ClassificationSchema.nullable().optional(),
};

// ── Adjudication Ledger Schemas (session — R2+ deliberation) ────────────────

/**
 * Zod 4 schema for a single session-ledger entry.
 * Phase D adds a `source` discriminator with default 'session' for backward-compat:
 * old ledger files without the field continue to validate as session entries.
 */
export const LedgerEntrySchema = z.object({
  ...LedgerCoreFields,
  source: z.literal('session').default('session'),
  adjudicationOutcome: z.enum(['dismissed', 'accepted', 'severity_adjusted']),
  remediationState: z.enum(['pending', 'planned', 'fixed', 'verified', 'regressed']),
  originalSeverity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  ruling: z.enum(['sustain', 'overrule', 'compromise']),
  rulingRationale: z.string(),
  resolvedRound: z.number(),
});

/** Zod 4 schema for the full adjudication ledger. */
export const AdjudicationLedgerSchema = z.object({
  version: z.literal(1),
  entries: z.array(LedgerEntrySchema)
});

// ── Debt Ledger Schemas (Phase D) ───────────────────────────────────────────

/**
 * Valid deferral reasons. Each reason has its own required-field contract
 * enforced via refinement (per §2.4 of Phase D plan).
 */
export const DeferredReasonEnum = z.enum([
  'out-of-scope',         // valid, out-of-scope, no extra required fields
  'blocked-by',           // valid, any scope, requires blockedBy
  'deferred-followup',    // valid, any scope, requires followupPr
  'accepted-permanent',   // valid, any scope, requires approver + approvedAt
  'policy-exception',     // valid, any scope, requires policyRef + approver
]);

/**
 * Fields persisted at defer-time. The schema uses a refinement to enforce
 * per-reason required fields without a discriminated union (which would
 * explode into 5 separate object shapes and complicate read sites).
 */
const DebtEntryPersistedFields = {
  ...LedgerCoreFields,
  source: z.literal('debt'),
  deferredReason: DeferredReasonEnum,
  deferredAt: z.string().datetime(),
  deferredRun: z.string().max(40),
  deferredRationale: z.string().min(20).max(400),
  // Per-reason required fields (enforced via superRefine below):
  blockedBy: z.string().max(200).optional(),
  followupPr: z.string().max(120).optional(),
  approver: z.string().max(120).optional(),
  approvedAt: z.string().datetime().optional(),
  policyRef: z.string().max(200).optional(),
  // Owner (populated from CODEOWNERS or --owner flag):
  owner: z.string().max(120).optional(),
  // Identity mitigation (fix H4):
  contentAliases: z.array(z.string().max(12)).max(20).default([]),
  // Sensitivity flag (fix H6):
  sensitive: z.boolean().default(false),
};

function enforceDeferredReasonRequiredFields(entry, ctx) {
  const required = {
    'blocked-by': ['blockedBy'],
    'deferred-followup': ['followupPr'],
    'accepted-permanent': ['approver', 'approvedAt'],
    'policy-exception': ['policyRef', 'approver'],
  }[entry.deferredReason] || [];
  for (const field of required) {
    if (!entry[field]) {
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message: `deferredReason "${entry.deferredReason}" requires ${field}`,
      });
    }
  }
}

/**
 * PersistedDebtEntrySchema — what's actually stored on disk in .audit/tech-debt.json.
 * NO runtime-derived fields like occurrences, lastSurfacedAt, escalated — those
 * come from event-log replay (fix H1b). Writers use this schema.
 */
export const PersistedDebtEntrySchema = z.object(DebtEntryPersistedFields)
  .superRefine(enforceDeferredReasonRequiredFields);

/**
 * HydratedDebtEntrySchema — persisted fields PLUS derived runtime fields.
 * What readDebtLedger() returns after replaying the event log. Used by
 * suppression + debt-review + status card.
 */
export const HydratedDebtEntrySchema = z.object({
  ...DebtEntryPersistedFields,
  // Derived from event log:
  occurrences: z.number().int().min(0).default(0),     // alias for distinctRunCount
  distinctRunCount: z.number().int().min(0).default(0),
  matchCount: z.number().int().min(0).default(0),
  lastSurfacedRun: z.string().max(40).optional(),
  lastSurfacedAt: z.string().datetime().optional(),
  escalated: z.boolean().default(false),
  escalatedAt: z.string().datetime().optional(),
}).superRefine(enforceDeferredReasonRequiredFields);

/** Convenience alias at read sites. */
export const DebtEntrySchema = HydratedDebtEntrySchema;

/**
 * DebtEventSchema — individual event-log line.
 * Event types:
 *   deferred   — entry added to ledger
 *   surfaced   — entry matched by suppression (one per topicId per run)
 *   reopened   — entry's files in --changed (not a suppression)
 *   escalated  — --escalate-recurring gate flipped escalated=true
 *   resolved   — entry removed (underlying issue fixed)
 *   reconciled — offline→cloud sync marker (fix R3-H3)
 */
export const DebtEventSchema = z.object({
  ts: z.string().datetime(),
  runId: z.string().max(40),
  topicId: z.string().optional(),                    // absent on 'reconciled' marker
  event: z.enum(['deferred', 'surfaced', 'reopened', 'escalated', 'resolved', 'reconciled']),
  matchCount: z.number().int().min(1).optional(),    // only on 'surfaced' events
  rationale: z.string().max(400).optional(),         // on 'deferred' and 'resolved'
  resolutionRationale: z.string().max(400).optional(), // on 'resolved'
  resolvedBy: z.string().max(40).optional(),         // runId that resolved, on 'resolved'
});

/**
 * DebtLedgerSchema — the top-level .audit/tech-debt.json shape.
 * Entries use PersistedDebtEntrySchema (no derived fields).
 */
export const DebtLedgerSchema = z.object({
  version: z.literal(1),
  entries: z.array(PersistedDebtEntrySchema),
  budgets: z.record(z.string(), z.number().int().min(0)).optional(),
  lastUpdated: z.string().datetime().optional(),
});

// ── Debt Review Schemas (Phase D.3) ─────────────────────────────────────────

/**
 * ClusterSchema — a group of debt entries identified by the LLM as related.
 * Kinds:
 *   file        — entries citing the same module
 *   principle   — entries violating the same engineering principle
 *   recurrence  — entries with high distinctRunCount (systemic signal)
 */
export const ClusterSchema = z.object({
  id: z.string().max(40).describe('Stable cluster id, e.g. cluster-god-module-openai'),
  title: z.string().max(120),
  kind: z.enum(['file', 'principle', 'recurrence']),
  entries: z.array(z.string()).max(50).describe('topicIds of member entries'),
  rationale: z.string().max(500),
});

/**
 * RefactorCandidateSchema — a proposed refactor pass that would resolve
 * one or more clusters. LLM proposes clusterId + effort + risks; server
 * computes leverageScore from resolved entries' sonarType weights.
 */
export const RefactorCandidateSchema = z.object({
  clusterId: z.string().max(40),
  targetModules: z.array(z.string().max(120)).max(10),
  resolvedTopicIds: z.array(z.string()).max(50),
  effortEstimate: z.enum(['TRIVIAL', 'EASY', 'MEDIUM', 'MAJOR', 'CRITICAL']),
  effortRationale: z.string().max(400),
  risks: z.array(z.string().max(200)).max(5),
  rollbackStrategy: z.string().max(400),
});

/**
 * DebtReviewResultSchema — the full LLM output contract for debt-review.
 * leverageScore is computed server-side (see lib/debt-review-helpers.mjs)
 * and added to RefactorCandidates post-validation. budgetViolations are
 * also server-computed from the debt ledger + budgets map.
 */
export const DebtReviewResultSchema = z.object({
  summary: z.object({
    totalEntries: z.number().int().min(0),
    clustersIdentified: z.number().int().min(0),
    oldestEntryDays: z.number().int().min(0),
    staleEntries: z.array(z.string()).max(100).describe('topicIds older than --ttl-days'),
  }),
  clusters: z.array(ClusterSchema).max(20),
  refactorPlan: z.array(RefactorCandidateSchema).max(10),
  reasoning: z.string().max(1500),
});
